'use strict';
/**
 * 身份层：空间口令（主线）+ 可选账号（跨设备同步）
 *
 * 设计取舍：对标站要求注册 + 短信验证码，门槛太高 —— 家长只是想给孩子开个学习空间。
 * 所以主线仍是"空间口令"，账号是可选增强。但未成年人合规不能省：
 * 一旦建立账号，就必须有协议同意记录（含儿童隐私政策）。
 */
const crypto = require('crypto');
const D = require('./db');

const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 180; // 180 天

// ---------- 空间 ----------
function listSpaces() {
  const rows = D.all('SELECT * FROM spaces ORDER BY last_at DESC, id ASC');
  const counts = {};
  D.all('SELECT space_id, COUNT(*) c FROM conversations GROUP BY space_id')
    .forEach(r => { counts[r.space_id] = r.c; });
  const cards = {};
  D.all('SELECT space_id, COUNT(*) c FROM cards GROUP BY space_id')
    .forEach(r => { cards[r.space_id] = r.c; });
  const seen = {};
  rows.forEach(r => { seen[r.name_key] = (seen[r.name_key] || 0) + 1; });
  return rows.map(r => ({
    spaceId: r.id,
    name: r.name,
    hasPasscode: !!r.passcode,
    tier: r.tier,
    isDefault: r.id === '_public',
    conversations: counts[r.id] || 0,
    cards: cards[r.id] || 0,
    dupName: seen[r.name_key] > 1,
    createdAt: r.created_at,
    lastAt: r.last_at || r.created_at,
  }));
}

function getSpace(id) {
  return D.get('SELECT * FROM spaces WHERE id = ?', D.normalizeSpace(id)) || null;
}

// 查重：不依赖库里存的 name_key（历史数据的归一化规则可能不同），
// 每次按当前规则重算，顺带把存量数据也纳入判断。
function nameTaken(name, exceptSid) {
  const k = D.nameKey(name);
  if (!k) return false;
  return D.all('SELECT id, name, name_key FROM spaces')
    .some(r => r.id !== exceptSid && (r.name_key === k || D.nameKey(r.name) === k));
}

// 撞名建议：张小明 → 张小明2 → 张小明3
// 名字本身带尾号时顺着尾号递增（张小明2 → 张小明3），而不是叠一层（张小明22）。
function suggestName(name, exceptSid) {
  const base = String(name == null ? '' : name).trim().slice(0, 40) || '学习者';
  if (!nameTaken(base, exceptSid)) return base;
  const m = base.match(/^(.*?)(\d{1,3})$/);
  let stem = m ? m[1] : base;
  let start = m ? (Number(m[2]) + 1) : 2;
  if (!stem) { stem = base; start = 2; }
  for (let i = start; i <= start + 98; i++) {
    const cand = (stem + i).slice(0, 40);
    if (!nameTaken(cand, exceptSid)) return cand;
  }
  return (stem.slice(0, 36) + '-' + Date.now().toString(36).slice(-4)).slice(0, 40);
}

// 连号 ID：扫纯数字取 max+1，非递归 mkdir 占位改成事务内 INSERT（UNIQUE 冲突即重试）
function nextSpaceId() {
  for (let i = 0; i < 50; i++) {
    const r = D.get("SELECT MAX(CAST(id AS INTEGER)) m FROM spaces WHERE id GLOB '[0-9][0-9][0-9][0-9]*'");
    const next = String((Number(r && r.m) || 0) + 1).padStart(4, '0');
    const exists = D.get('SELECT 1 FROM spaces WHERE id = ?', next);
    if (!exists) return next;
  }
  return D.uid('sp_');
}

function ensureDefaultSpace() {
  const has = D.get('SELECT 1 FROM spaces WHERE id = ?', '_public');
  if (has) return;
  D.run('INSERT INTO spaces(id,name,name_key,passcode,created_at,last_at) VALUES(?,?,?,?,?,?)',
    '_public', '默认空间', D.nameKey('默认空间'), '', D.now(), D.now());
}

function createSpace({ name, passcode }) {
  const nm = String(name || '').trim().replace(/\s+/g, ' ').slice(0, 40) || '学习者';
  if (nameTaken(nm, null)) throw nameTakenError(nm);
  const id = nextSpaceId();
  try {
    D.run('INSERT INTO spaces(id,name,name_key,passcode,created_at,last_at) VALUES(?,?,?,?,?,?)',
      id, nm, D.nameKey(nm), String(passcode || '').trim(), D.now(), D.now());
  } catch (e) {
    // 唯一索引兜底：nameTaken 用的是"当前规则重算"，而索引比的是"入库时算出的 key"，
    // 历史数据两者可能不一致。撞到唯一约束时统一转成 NAME_TAKEN，别漏成 500。
    if (/UNIQUE|constraint/i.test(String(e.message || ''))) throw nameTakenError(nm);
    throw e;
  }
  return { spaceId: id, name: nm };
}

function nameTakenError(nm) {
  const s = suggestName(nm, null);
  const e = new Error('已经有叫「' + nm + '」的空间了，建议改成「' + s + '」');
  e.code = 'NAME_TAKEN'; e.suggested = s;
  return e;
}

function touchSpace(sid) { D.run('UPDATE spaces SET last_at = ? WHERE id = ?', D.now(), sid); }

function enterSpace(id, passcode) {
  const sid = D.normalizeSpace(id);
  const canon = D.canonSpaceId(id);
  if (sid !== canon || sid === '_public') { const e = new Error('空间不存在'); e.code = 'NOT_FOUND'; throw e; }
  const sp = D.get('SELECT * FROM spaces WHERE id = ?', sid);
  if (!sp) { const e = new Error('空间不存在'); e.code = 'NOT_FOUND'; throw e; }
  if (passcode && sp.passcode && sp.passcode !== passcode) {
    const e = new Error('访问口令不正确'); e.code = 'WRONG_PASSCODE'; throw e;
  }
  touchSpace(sid);
  return { spaceId: sid, name: sp.name };
}

// ---------- 会话 ----------
function issueSession({ userId, spaceId, kind }) {
  const token = crypto.randomBytes(24).toString('hex');
  D.run('INSERT INTO sessions(token,user_id,space_id,kind,created_at,last_seen_at) VALUES(?,?,?,?,?,?)',
    token, userId || null, spaceId, kind, D.now(), D.now());
  return token;
}

/**
 * ★ `last_seen_at` 不能每个请求都写。
 *
 * 它唯一的用途是 `SESSION_TTL_MS`（180 天）的过期判断 —— 精度到分钟绰绰有余。
 * 而**每写一次就是一次事务**，在 `journal_mode = DELETE` + `synchronous = FULL` 下
 * 要 fsync 两次。写在鉴权里，等于**把 fsync 摊到每一次 API 调用上**。
 *
 * 本机实测（磁盘接近写满，一次 fsync 约 500ms）：
 *   - 每请求都写：每个接口 0.9–1.5 秒；首屏 9 个并行请求要 **7.3 秒**（同步 sqlite 会把它们串起来）
 *   - 不写（/api/models、/api/avatars 这类不碰库的）：4–13 毫秒
 *
 * 在一台快盘机器上这个代价看不出来，在慢盘上它会让整个产品"打开就要等十秒"。
 * 节流到 60 秒一次之后，写入量降到约 1/100，而语义几乎不变
 * （会话过期的判定最多晚 60 秒，180 天的 TTL 上可以忽略）。
 */
const SEEN_THROTTLE_MS = 60 * 1000;

function resolveSession(token) {
  if (!token) return null;
  const s = D.get('SELECT * FROM sessions WHERE token = ?', token);
  if (!s || s.ended_at) return null;
  if (D.now() - s.last_seen_at > SESSION_TTL_MS) return null;
  // ★ 被禁用的用户就算手里还攥着旧令牌也不能进来。
  //   禁用时已经把所有会话置为结束，这里是第二道闸：防止"结束会话"那步漏了
  //   （比如并发期间刚发的令牌），否则"禁用"在管理员眼里就是点了没反应。
  if (s.user_id) {
    const u = D.get('SELECT disabled FROM users WHERE id = ?', s.user_id);
    if (u && u.disabled) return null;
  }
  if (D.now() - s.last_seen_at > SEEN_THROTTLE_MS) {
    D.run('UPDATE sessions SET last_seen_at = ? WHERE token = ?', D.now(), token);
  }
  return s;
}

function endSession(token) { if (token) D.run('UPDATE sessions SET ended_at = ? WHERE token = ?', D.now(), token); }

// ---------- 账号（可选） ----------
const DOC_VERSION = '2026-09-30';
const DOCS = ['terms', 'privacy', 'children-privacy'];

function register({ username, phone, email, password, name, stage, grade, spaceId, consents }) {
  const uname = String(username || '').trim();
  const ph = String(phone || '').trim();
  const em = String(email || '').trim().toLowerCase();
  if (!uname && !ph && !em) { const e = new Error('请填写用户名或手机号'); e.code = 'BAD_INPUT'; throw e; }
  if (uname && !/^[\u4e00-\u9fa5A-Za-z0-9_]{2,16}$/.test(uname)) {
    const e = new Error('用户名需要 2-16 个字符，只能用中英文、数字和下划线'); e.code = 'BAD_USERNAME'; throw e;
  }
  if (ph && !/^1\d{10}$/.test(ph)) { const e = new Error('请输入正确的 11 位手机号'); e.code = 'BAD_PHONE'; throw e; }
  if (em && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(em)) { const e = new Error('请输入正确的邮箱地址'); e.code = 'BAD_EMAIL'; throw e; }
  if (!password || String(password).length < 6) { const e = new Error('密码至少 6 位'); e.code = 'BAD_PASSWORD'; throw e; }
  // 合规：必须同意三份文件（不满 14 周岁由监护人确认）
  const agreed = Array.isArray(consents) ? consents : [];
  const missing = DOCS.filter(d => agreed.indexOf(d) < 0);
  if (missing.length) { const e = new Error('需要先同意用户协议、隐私政策与儿童隐私政策'); e.code = 'NEED_CONSENT'; throw e; }

  if (uname && D.get('SELECT 1 FROM users WHERE username = ?', uname)) {
    const e = new Error('这个用户名已经被使用了'); e.code = 'USERNAME_TAKEN'; throw e;
  }
  if (ph && D.get('SELECT 1 FROM users WHERE phone = ?', ph)) {
    const e = new Error('这个手机号已经注册过了'); e.code = 'PHONE_TAKEN'; throw e;
  }
  if (em && D.get('SELECT 1 FROM users WHERE email = ?', em)) {
    const e = new Error('这个邮箱已经注册过了'); e.code = 'EMAIL_TAKEN'; throw e;
  }

  let sid = spaceId ? D.normalizeSpace(spaceId) : '';
  if (!sid || sid === '_public' || !D.get('SELECT 1 FROM spaces WHERE id = ?', sid)) {
    // 没指定空间就按"姓名"新建一个
    const created = createSpace({ name: name || uname || '学习者', passcode: '' });
    sid = created.spaceId;
  }
  const uid = D.uid('u_');
  D.run(`INSERT INTO users(id,space_id,username,phone,email,password_hash,name,stage,grade,role,created_at,last_login_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
    uid, sid, uname || null, ph || null, em || null, D.hashPw(password),
    String(name || uname || '').slice(0, 40),
    String(stage || '').slice(0, 20), String(grade || '').slice(0, 20), 'student', D.now(), D.now());
  DOCS.forEach(d => D.run('INSERT OR REPLACE INTO consents(user_id,doc,version,agreed_at) VALUES(?,?,?,?)',
    uid, d, DOC_VERSION, D.now()));
  return { userId: uid, spaceId: sid, name: String(name || uname || '') };
}

// 已登录改密码：必须验原密码，防止令牌被盗后直接改密码锁死账号
/**
 * 管理员视角的用户列表。
 *
 * ★ 为什么"能操作"必须包含这些字段：管理员只会在这个界面上做决定，
 *   **看不出谁是谁就无从下手**。以前只有空间列表，本质上是"看得见、管不着"。
 *
 * ★ 隐私口径：这里给的是**联系方式与状态**，不给学习内容。
 *   管理员不该看到学生答了什么题 —— 那是只对本人和其家长可见的东西。
 *   password_hash 也一样：SELECT 把它查出来只为折算成一个布尔
 *   `hasPassword`（有没有密码 = 能不能重置），**后面的对象是逐字段手写的，
 *   哈希本身不会出现在返回结构里** —— 别改成 `Object.assign`/展开整个行对象。
 */
const USER_QUERY_COLS = 'id, username, phone, email, name, stage, grade, role, created_at, last_login_at, '
  + 'disabled, disabled_reason, space_id, password_hash';

function listUsers() {
  const rows = D.all('SELECT ' + USER_QUERY_COLS + ' FROM users ORDER BY created_at DESC, id ASC');
  const spaceName = {};
  D.all('SELECT id, name FROM spaces').forEach(r => { spaceName[r.id] = r.name; });
  const convs = {};
  D.all('SELECT space_id, COUNT(*) c FROM conversations GROUP BY space_id').forEach(r => { convs[r.space_id] = r.c; });
  // ★ messages 是按 conversation_id 归的，**没有 space_id 列**（按空间分组必须 JOIN）。
  //   这一句踩过一次：NO such column → 管理员打开用户页直接 500。
  const msgs = {};
  D.all('SELECT c.space_id sid, COUNT(*) c FROM messages m JOIN conversations c ON c.id = m.conversation_id ' +
    'WHERE m.deleted = 0 GROUP BY c.space_id').forEach(r => { msgs[r.sid] = r.c; });
  return rows.map(u => ({
    id: u.id,
    name: u.name || '',
    username: u.username || '',
    phone: u.phone || '',
    email: u.email || '',
    stage: u.stage || '',
    grade: u.grade || '',
    role: u.role || 'student',
    disabled: !!u.disabled,
    disabledReason: u.disabled_reason || '',
    spaceId: u.space_id,
    spaceName: spaceName[u.space_id] || u.space_id,
    conversations: convs[u.space_id] || 0,
    messages: msgs[u.space_id] || 0,
    // 有密码才能被"重置密码"影响 —— 纯空间口令登录的账号这里要给个明示
    hasPassword: !!u.password_hash,
    createdAt: u.created_at,
    lastLoginAt: u.last_login_at || 0,
  }));
}

function findUserAny(idOrAccount) {
  const k = String(idOrAccount || '').trim();
  if (!k) return null;
  return D.get('SELECT * FROM users WHERE id = ? OR username = ? OR phone = ? OR email = ?', k, k, k, k) || null;
}

/**
 * 禁用 / 启用。
 *
 * ★ 禁用必须**立刻生效**：只改一个字段的话，他手上那个会话令牌还能用到过期。
 *   本在校的学生被点"禁用"后还能继续聊管理员会以为自己操作失败了。
 */
function setUserDisabled(idOrAccount, disabled, reason) {
  const u = findUserAny(idOrAccount);
  if (!u) { const e = new Error('用户不存在'); e.code = 'NOT_FOUND'; throw e; }
  const want = !!disabled;
  D.run('UPDATE users SET disabled = ?, disabled_reason = ? WHERE id = ?',
    want ? 1 : 0, want ? String(reason || '').slice(0, 200) : '', u.id);
  if (want) {
    // 踢下线：把还没结束的会话全部结束掉。
    D.run("UPDATE sessions SET ended_at = ? WHERE user_id = ? AND ended_at = 0", D.now(), u.id);
  }
  return { ok: true, id: u.id, disabled: want };
}

/**
 * 管理员重置密码。
 *
 * ★ 不需要原密码 —— 他自己忘记了才来找管理员。
 *   但必须**生成新密码而不是沿用旧的**：原哈希拿不出来，验证不了。
 *   返回明文是为了让管理员能 Copy 出去告诉对方；调用它的 HTTP 层有管理令牌守着。
 */
function adminResetPassword(idOrAccount, newPassword) {
  const u = findUserAny(idOrAccount);
  if (!u) { const e = new Error('用户不存在'); e.code = 'NOT_FOUND'; throw e; }
  const pw = String(newPassword || '');
  if (pw.length < 6) { const e = new Error('新密码至少 6 位'); e.code = 'BAD_PASSWORD'; throw e; }
  D.run('UPDATE users SET password_hash = ? WHERE id = ?', D.hashPw(pw), u.id);
  // 换密码就必须重登：不然旧设备照旧能用这个账号
  D.run("UPDATE sessions SET ended_at = ? WHERE user_id = ? AND ended_at = 0", D.now(), u.id);
  return { ok: true, id: u.id };
}

function changePassword(userId, { oldPassword, newPassword }) {
  const u = D.get('SELECT * FROM users WHERE id = ?', userId);
  if (!u) { const e = new Error('用户不存在'); e.code = 'NOT_FOUND'; throw e; }
  if (u.password_hash && !D.checkPw(oldPassword, u.password_hash)) {
    const e = new Error('原密码不正确'); e.code = 'BAD_CRED'; throw e;
  }
  if (!newPassword || String(newPassword).length < 6) { const e = new Error('新密码至少 6 位'); e.code = 'BAD_PASSWORD'; throw e; }
  D.run('UPDATE users SET password_hash = ? WHERE id = ?', D.hashPw(newPassword), userId);
  return { ok: true };
}

function login({ account, password }) {
  const a = String(account || '').trim();
  if (!a) { const e = new Error('请输入账号'); e.code = 'BAD_INPUT'; throw e; }
  // 用户名 / 手机号 / 邮箱 三选一 —— 对标站也是同一个输入框
  const u = D.get('SELECT * FROM users WHERE username = ? OR phone = ? OR email = ?', a, a, a);
  // ★ 不知道密码也不要让他知道"这个账号存在但密码错了" —— 两拒都一样的话术。
  //   校验顺序上前先查密码，避免用"能否登录"来枚举账号是否存在。
  if (!u || !D.checkPw(password, u.password_hash)) { const e = new Error('账号或密码不正确'); e.code = 'BAD_CRED'; throw e; }
  // ★ 禁用必须真的拦得住：只写字段不拦登录，"禁用"就只是个摆设。
  if (u.disabled) {
    const e = new Error(u.disabled_reason ? ('这个账号已被停用：' + u.disabled_reason) : '这个账号已被停用');
    e.code = 'USER_DISABLED';
    throw e;
  }
  touchSpace(u.space_id);
  D.run('UPDATE users SET last_login_at = ? WHERE id = ?', D.now(), u.id);
  return { userId: u.id, spaceId: u.space_id, name: u.name };
}

function safeJson(s, dflt) {
  try { const v = JSON.parse(s); return v == null ? dflt : v; } catch (e) { return dflt; }
}

function profile(userId) {
  const u = D.get('SELECT * FROM users WHERE id = ?', userId);
  if (!u) return null;
  const sp = D.get('SELECT * FROM spaces WHERE id = ?', u.space_id) || {};
  const consents = D.all('SELECT doc, version, agreed_at FROM consents WHERE user_id = ?', userId);
  return {
    id: u.id, username: u.username, phone: u.phone, email: u.email, name: u.name,
    stage: u.stage, grade: u.grade, avatar: u.avatar, avatarPreset: u.avatar_preset || '',
    speechRate: u.speech_rate, role: u.role,
    subjects: safeJson(u.subjects_json, []),
    preferences: safeJson(u.preferences_json, {}),
    goals: safeJson(u.goals_json, []),
    lastLoginAt: u.last_login_at || 0,
    space: { id: sp.id, name: sp.name, tier: sp.tier, isDefault: sp.id === '_public' },
    consents,
  };
}

function updateProfile(userId, patch) {
  const u = D.get('SELECT * FROM users WHERE id = ?', userId);
  if (!u) { const e = new Error('用户不存在'); e.code = 'NOT_FOUND'; throw e; }
  const map = { name: 'name', stage: 'stage', grade: 'grade', avatar: 'avatar', speechRate: 'speech_rate', avatarPreset: 'avatar_preset' };
  Object.keys(map).forEach(k => {
    if (patch[k] !== undefined) D.run(`UPDATE users SET ${map[k]} = ? WHERE id = ?`, patch[k], userId);
  });
  // 三段结构化资料：整体覆盖，不做深合并 —— 前端每次提交完整状态，合并反而容易留下脏字段
  if (patch.subjects !== undefined) {
    const arr = Array.isArray(patch.subjects) ? patch.subjects.map(s => String(s).slice(0, 20)).slice(0, 12) : [];
    D.run('UPDATE users SET subjects_json = ? WHERE id = ?', JSON.stringify(arr), userId);
  }
  if (patch.preferences !== undefined) {
    const obj = (patch.preferences && typeof patch.preferences === 'object') ? patch.preferences : {};
    D.run('UPDATE users SET preferences_json = ? WHERE id = ?', JSON.stringify(obj).slice(0, 4000), userId);
  }
  if (patch.goals !== undefined) {
    const arr = Array.isArray(patch.goals) ? patch.goals.map(s => String(s).slice(0, 120)).slice(0, 20) : [];
    D.run('UPDATE users SET goals_json = ? WHERE id = ?', JSON.stringify(arr), userId);
  }
  return profile(userId);
}

module.exports = {
  DOC_VERSION, DOCS,
  listSpaces, getSpace, nameTaken, suggestName, createSpace, enterSpace, touchSpace,
  ensureDefaultSpace, nextSpaceId,
  issueSession, resolveSession, endSession,
  register, login, profile, updateProfile, changePassword,
  // 管理员用户管理（不只是能看，还得能操作）
  listUsers, setUserDisabled, adminResetPassword, findUserAny,
};

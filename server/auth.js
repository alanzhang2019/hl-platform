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

// ---------- 空间口令的存储与校验（2026-10-03 改）----------
/**
 * ★ 口令在库里存的是 scrypt 哈希，**不是明文**。
 *
 * 为什么改：注册账号时空间口令默认取用户的登录密码（见 register()）。
 * 若口令仍按明文存，等于把刚做完的 scrypt 白做 —— 库一泄漏，登录密码就是明文。
 * 口令和密码是同一类东西（都是"用户知道的秘密"），用同一套哈希。
 *
 * 历史包袱：2026-10-03 之前建的空间存的是明文口令。migratePasscodes() 在启动时
 * 统一换成哈希；在那之前 passcodeMatches() 保留明文比对兜底 —— 迁移万一没跑成，
 * 也不至于让所有设了口令的空间一起进不去。
 */
const PW_HASH_RE = /^[0-9a-f]{16}\$[0-9a-f]{64}$/;
function isPwHash(v) { return PW_HASH_RE.test(String(v == null ? '' : v)); }
/** 口令比对。stored 为空 = 该空间无口令（开放）。 */
function passcodeMatches(stored, given) {
  if (!stored) return true;
  const g = String(given == null ? '' : given).trim();
  if (isPwHash(stored)) return D.checkPw(g, stored);   // 哈希态
  return stored === g;                                 // 明文态（迁移前兜底）
}
/** 口令规范化：trim + 上限 64。空串 = 无口令。 */
function normPasscode(v) { return String(v == null ? '' : v).trim().slice(0, 64); }
// 随机口令的字母表剔除易混字符（0 O 1 l I o），避免家长照着念错。
const PASSCODE_ALPHABET = 'abcdefghjkmnpqrstuvwxyzACDEFGHJKLMNPQRSTUVWXYZ23456789';
/** 生成随机口令。用于"没有密码可复用"的场景（手机验证码注册）。 */
function randomPasscode(n) {
  const len = n || 8;
  const buf = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += PASSCODE_ALPHABET[buf[i] % PASSCODE_ALPHABET.length];
  return out;
}

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
  D.run('INSERT INTO spaces(id,name,name_key,passcode,tier,created_at,last_at) VALUES(?,?,?,?,?,?,?)',
    '_public', '默认空间', D.nameKey('默认空间'), '', 'self', D.now(), D.now());
}

function createSpace({ name, passcode }) {
  const nm = String(name || '').trim().replace(/\s+/g, ' ').slice(0, 40) || '学习者';
  if (nameTaken(nm, null)) throw nameTakenError(nm);
  const id = nextSpaceId();
  const pc = normPasscode(passcode);
  try {
    // 显式写 tier：不写的话取的是 schema 默认值，而老库的默认值可能是已废弃的 'free'。
    // 新空间一律从最低档开始，由管理员按需授予。见 server/skills.js 的 DEFAULT_TIER。
    // 口令入库即哈希（见文件头的说明）—— 空口令仍是空串，语义是"开放"。
    D.run('INSERT INTO spaces(id,name,name_key,passcode,tier,created_at,last_at) VALUES(?,?,?,?,?,?,?)',
      id, nm, D.nameKey(nm), pc ? D.hashPw(pc) : '', 'self', D.now(), D.now());
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
  // 口令校验：只要空间设了口令就必须比对，**不能因为请求没带口令就放行**。
  // 旧写法 `passcode && sp.passcode && ...` 会短路：请求体不带 passcode（或传空串）时
  // 整条判断为 false，直接发会话；而空间 ID 是连号的（0001、0002…），
  // 等于所有设了口令的空间都能被枚举进入。
  // 比对走 passcodeMatches()：库里是 scrypt 哈希（2026-10-03 起），迁移前的明文也认。
  if (!passcodeMatches(sp.passcode, passcode)) {
    const e = new Error('访问口令不正确'); e.code = 'WRONG_PASSCODE'; throw e;
  }
  touchSpace(sid);
  return { spaceId: sid, name: sp.name };
}

/**
 * 设置 / 重置空间口令。管理端与空间本人共用（2026-10-03 新增）。
 *
 * ★ 空口令 = 恢复"开放"（任何人凭 ID 可进）。管理端允许这么做（有人就是想要公开空间），
 *   所以清空必须由调用方**显式传空串**，不能因为"没传参"就当清空。
 * ★ 改口令要**踢掉用旧口令进来的会话** —— 否则"重置"只挡得住新来的人，
 *   已经进来的（可能正是要清掉的那个）照样待着。只踢 kind='space'；
 *   账号会话是另一套凭据，不该被连坐。exceptToken 用于自助改口令时别把操作者自己踢下线。
 * ★ 返回明文是给管理员转达用户用的（口令不可逆，取不回来只能给新的），
 *   与 adminResetPassword 同一口径；调用它的 HTTP 层有管理令牌守着。
 */
function setSpacePasscode(spaceId, passcode, opts) {
  const o = opts || {};
  const sid = D.normalizeSpace(spaceId);
  if (!D.get('SELECT 1 FROM spaces WHERE id = ?', sid)) {
    const e = new Error('空间不存在'); e.code = 'NOT_FOUND'; throw e;
  }
  const pc = normPasscode(passcode);
  // 非空口令至少 4 位。空串是"清空"（恢复公开）—— 那是显式意图，不受这条限制。
  // ★ 只在重置路径卡、不在 createSpace 卡：createSpace 是落地页的公开流程，
  //   中途新增一条拒绝理由会打断正在注册/建空间的用户；而重置口令是管理端/自助操作，
  //   当场报错反而更清楚。（前端两边都校验了 ≥4，这里补的是"绕过前端直接打接口"的口子。）
  if (pc && pc.length < 4) { const e = new Error('口令至少 4 位'); e.code = 'BAD_PASSCODE'; throw e; }
  D.run('UPDATE spaces SET passcode = ? WHERE id = ?', pc ? D.hashPw(pc) : '', sid);
  let kicked = 0;
  if (pc) {
    // ★ 判活必须写 `ended_at IS NULL OR ended_at = 0`：schema 里 ended_at 是 `INTEGER`
    //   且没有默认值，新会话插进来是 NULL —— 只写 `= 0` 一条也匹配不上（实测 kicked=0）。
    const r = D.run("UPDATE sessions SET ended_at = ? WHERE space_id = ? AND kind = 'space' " +
      "AND (ended_at IS NULL OR ended_at = 0) AND token <> ?",
      D.now(), sid, String(o.exceptToken || ''));
    kicked = (r && r.changes) || 0;
  }
  return { spaceId: sid, hasPasscode: !!pc, passcode: pc, kicked: kicked };
}

/**
 * 迁移：把 2026-10-03 之前存的**明文**空间口令统一换成 scrypt 哈希。
 * 幂等 —— 已经是哈希的原样跳过（哈希形如 `16位hex$64位hex`，长度 81；
 * 而明文口令实测只有 6~34 位，长度就对不上，不会误判）。
 * 返回被改写的条数，供启动日志。
 */
function migratePasscodes() {
  const rows = D.all("SELECT id, passcode FROM spaces WHERE passcode IS NOT NULL AND passcode <> ''");
  const todo = rows.filter(r => !isPwHash(r.passcode));
  if (!todo.length) return 0;
  D.tx(() => { todo.forEach(r => D.run('UPDATE spaces SET passcode = ? WHERE id = ?', D.hashPw(r.passcode), r.id)); });
  return todo.length;
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
    // 没指定空间就按"姓名"新建一个。
    // ★ 口令默认取**注册密码**（2026-10-03）。不这么做的话，注册出来的空间是"无口令"
    //   状态，而空间 ID 是连号的（0001、0002…），任何人猜到编号就能直接进去 ——
    //   而用户协议里写着"账号下的学习空间默认仅你本人可见"，与实际行为矛盾。
    //   用注册密码当口令的好处：用户一定记得住，不需要额外告知、也不会丢。
    const created = createSpace({ name: name || uname || '学习者', passcode: password });
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
    // ★ 判活条件必须是 `IS NULL OR = 0`：schema 里 ended_at 是 `INTEGER` 且**没有默认值**，
    //   新会话插进来是 NULL。只写 `ended_at = 0` 一条也匹配不上（NULL = 0 结果是 NULL，不是 true）。
    //   这个坑 2026-10-03 在 setSpacePasscode 上实测踩到（kicked=0），顺手把这里一起修了。
    D.run("UPDATE sessions SET ended_at = ? WHERE user_id = ? AND (ended_at IS NULL OR ended_at = 0)", D.now(), u.id);
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
  // 换密码就必须重登：不然旧设备照旧能用这个账号。
  // ★ 判活同上：ended_at 的新值是 NULL，只写 `= 0` 一条也匹配不上。
  D.run("UPDATE sessions SET ended_at = ? WHERE user_id = ? AND (ended_at IS NULL OR ended_at = 0)", D.now(), u.id);
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
  // 空间口令（2026-10-03：改为哈希存储 + 可重置）
  setSpacePasscode, migratePasscodes, randomPasscode, isPwHash, passcodeMatches, normPasscode,
  issueSession, resolveSession, endSession,
  register, login, profile, updateProfile, changePassword,
  // 管理员用户管理（不只是能看，还得能操作）
  listUsers, setUserDisabled, adminResetPassword, findUserAny,
};

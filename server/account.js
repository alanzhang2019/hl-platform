'use strict';
/**
 * 账号增强层
 *
 * 覆盖对标站的这几块：短信验证码（登录/注册/重置）、密码重置、
 * 学习会话心跳（真实学习时长）、头像预设、公告、协议文本。
 *
 * 三条设计原则：
 *  1. **短信是可插拔的**。零依赖不能靠 npm 短信 SDK，但可以靠 HTTP。
 *     配了 SMS_PROVIDER_URL 就走真实通道；没配就是"开发模式" —— 接口照常返回成功，
 *     验证码写进服务端日志，并在响应里带 `devCode`，方便本地联调。
 *     ★ 生产必须配 SMS_PROVIDER_URL，否则任何人填任意手机号都能拿码登录。
 *  2. **验证码一次性 + 限次 + 限频**。用完置 used，错 5 次作废，60 秒内不能重发。
 *  3. **学习时长只从心跳算**。登录次数不是学习时长；两次心跳间隔超过 2 分钟就断开计。
 */
const crypto = require('crypto');
const D = require('./db');
const auth = require('./auth');   // 只为复用 DOCS / DOC_VERSION；auth 不反向依赖本模块，无循环

const CODE_TTL_MS = 5 * 60 * 1000;
const CODE_RESEND_MS = 60 * 1000;
const CODE_MAX_TRIES = 5;
const HEARTBEAT_GAP_MS = 2 * 60 * 1000;   // 心跳间隔超过它就断开计
const SCENES = ['login', 'register', 'reset'];

function normPhone(p) { return String(p == null ? '' : p).replace(/\D/g, '').slice(0, 11); }
function isPhone(p) { return /^1\d{10}$/.test(normPhone(p)); }

// ---------- 短信通道 ----------
async function deliver(phone, code, scene) {
  const url = process.env.SMS_PROVIDER_URL;
  if (!url) {
    // 开发模式：写日志，不真发。调用方会把 devCode 回给前端，方便本地跑通。
    console.log('[sms:dev] ' + scene + ' → ' + phone + ' 验证码 ' + code);
    return { sent: false, dev: true };
  }
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (process.env.SMS_PROVIDER_KEY) headers.Authorization = 'Bearer ' + process.env.SMS_PROVIDER_KEY;
    const r = await fetch(url, {
      method: 'POST', headers,
      body: JSON.stringify({ phone, code, scene, ttl: Math.round(CODE_TTL_MS / 1000) }),
    });
    if (!r.ok) return { sent: false, status: r.status };
    return { sent: true };
  } catch (e) {
    return { sent: false, error: String((e && e.message) || e) };
  }
}

async function sendCode(rawPhone, scene) {
  const phone = normPhone(rawPhone);
  const sc = SCENES.indexOf(String(scene)) >= 0 ? String(scene) : 'login';
  if (!isPhone(phone)) { const e = new Error('请输入正确的 11 位手机号'); e.code = 'BAD_PHONE'; throw e; }

  // 限频：同一手机号 + 同一场景 60 秒一次
  const last = D.get('SELECT created_at FROM sms_codes WHERE phone = ? AND scene = ? ORDER BY created_at DESC LIMIT 1', phone, sc);
  if (last && D.now() - last.created_at < CODE_RESEND_MS) {
    const wait = Math.ceil((CODE_RESEND_MS - (D.now() - last.created_at)) / 1000);
    const e = new Error('发送太频繁了，' + wait + ' 秒后再试'); e.code = 'TOO_OFTEN'; e.wait = wait; throw e;
  }

  const code = String(crypto.randomInt(100000, 1000000));
  D.run('INSERT INTO sms_codes(id,phone,code,scene,tries,used,expires_at,created_at) VALUES(?,?,?,?,0,0,?,?)',
    D.uid('sc_'), phone, code, sc, D.now() + CODE_TTL_MS, D.now());

  const r = await deliver(phone, code, sc);
  return {
    phone,
    scene: sc,
    ttl: Math.round(CODE_TTL_MS / 1000),
    sent: !!r.sent,
    // 只在没配通道时回传，纯粹为了本地能跑通；线上配了 SMS_PROVIDER_URL 就一定是 undefined
    devCode: r.dev ? code : undefined,
  };
}

function verifyCode(rawPhone, scene, rawCode) {
  const phone = normPhone(rawPhone);
  const sc = SCENES.indexOf(String(scene)) >= 0 ? String(scene) : 'login';
  const code = String(rawCode == null ? '' : rawCode).trim();
  if (!isPhone(phone)) { const e = new Error('请输入正确的 11 位手机号'); e.code = 'BAD_PHONE'; throw e; }
  if (!/^\d{6}$/.test(code)) { const e = new Error('请输入 6 位验证码'); e.code = 'BAD_CODE'; throw e; }

  const row = D.get('SELECT * FROM sms_codes WHERE phone = ? AND scene = ? AND used = 0 ORDER BY created_at DESC LIMIT 1', phone, sc);
  if (!row) { const e = new Error('请先获取验证码'); e.code = 'NO_CODE'; throw e; }
  if (row.expires_at < D.now()) { const e = new Error('验证码已过期，请重新获取'); e.code = 'CODE_EXPIRED'; throw e; }
  if (row.tries >= CODE_MAX_TRIES) { const e = new Error('错误次数过多，请重新获取验证码'); e.code = 'CODE_LOCKED'; throw e; }
  if (row.code !== code) {
    D.run('UPDATE sms_codes SET tries = tries + 1 WHERE id = ?', row.id);
    const left = CODE_MAX_TRIES - (row.tries + 1);
    const e = new Error(left > 0 ? ('验证码不正确，还可以试 ' + left + ' 次') : '错误次数过多，请重新获取验证码');
    e.code = 'BAD_CODE'; e.left = Math.max(0, left); throw e;
  }
  D.run('UPDATE sms_codes SET used = 1 WHERE id = ?', row.id);
  return phone;
}

// ---------- 密码重置 ----------
function resetPassword({ phone, code, password }) {
  const ph = verifyCode(phone, 'reset', code);
  const pw = String(password || '');
  if (pw.length < 6) { const e = new Error('密码至少 6 位'); e.code = 'BAD_PASSWORD'; throw e; }
  const u = D.get('SELECT id FROM users WHERE phone = ?', ph);
  if (!u) { const e = new Error('这个手机号还没有注册'); e.code = 'NOT_FOUND'; throw e; }
  D.run('UPDATE users SET password_hash = ? WHERE id = ?', D.hashPw(pw), u.id);
  return { userId: u.id };
}

// 只看有没有待核销的码，不消费。用于"先判前置条件、再核销"的场景。
function peekCode(rawPhone, scene) {
  const phone = normPhone(rawPhone);
  const sc = SCENES.indexOf(String(scene)) >= 0 ? String(scene) : 'login';
  return D.get('SELECT * FROM sms_codes WHERE phone = ? AND scene = ? AND used = 0 ORDER BY created_at DESC LIMIT 1', phone, sc) || null;
}

// 手机号 + 验证码登录（没注册过就直接注册，省一步 —— 对标站也是这个流程）
function loginBySms({ phone, code, consents, name, stage, grade }) {
  const ph = normPhone(phone);
  if (!isPhone(ph)) { const e = new Error('请输入正确的 11 位手机号'); e.code = 'BAD_PHONE'; throw e; }

  // ★ 校验顺序：① 有没有码 ② 协议同不同意 ③ 才真正核销。
  //   为什么不是"直接 verifyCode"：那样用户点了「暂不同意」，验证码已经被消费掉，
  //   改主意时要再等 60 秒才能重发 —— 白白烧掉一次短信。
  //   为什么不是"协议优先"：没取码的人会收到「需要同意协议」，答非所问。
  const pending = peekCode(ph, 'login');
  if (!pending) { const e = new Error('请先获取验证码'); e.code = 'NO_CODE'; throw e; }
  if (pending.expires_at < D.now()) { const e = new Error('验证码已过期，请重新获取'); e.code = 'CODE_EXPIRED'; throw e; }

  if (!D.get('SELECT 1 FROM users WHERE phone = ?', ph)) {
    const agreed = Array.isArray(consents) ? consents : [];
    const missing = auth.DOCS.filter(d => agreed.indexOf(d) < 0);
    if (missing.length) { const e = new Error('首次登录需要先同意用户协议、隐私政策与儿童隐私政策'); e.code = 'NEED_CONSENT'; throw e; }
  }

  const vph = verifyCode(phone, 'login', code);
  let u = D.get('SELECT * FROM users WHERE phone = ?', vph);
  let created = false;
  if (!u) { u = registerByPhone({ phone: vph, name, stage, grade }); created = true; }
  D.run('UPDATE users SET last_login_at = ? WHERE id = ?', D.now(), u.id);
  return { userId: u.id, spaceId: u.space_id, name: u.name, created };
}

function registerByPhone({ phone, name, stage, grade }) {
  const ph = normPhone(phone);
  // ★ 手机验证码注册**没有密码可复用**，所以生成一个随机口令（2026-10-03）。
  //   不生成的话，这个空间就是"无口令"状态，而空间 ID 是连号的（0001、0002…）——
  //   等于用户刚注册完，空间就挂在公网上任人枚举进入。
  //   口令不回传给前端（他继续用手机号登录即可），需要时可在「个人中心」重设，
  //   或由管理员在后台重置。
  const sid = auth.createSpace({ name: name || ('学习者' + ph.slice(-4)), passcode: auth.randomPasscode() }).spaceId;
  const uid = D.uid('u_');
  D.run(`INSERT INTO users(id,space_id,username,phone,password_hash,name,stage,grade,role,created_at,last_login_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
    uid, sid, null, ph, null, String(name || ('学习者' + ph.slice(-4))).slice(0, 40),
    String(stage || '').slice(0, 20), String(grade || '').slice(0, 20), 'student', D.now(), D.now());
  auth.DOCS.forEach(d => D.run('INSERT OR REPLACE INTO consents(user_id,doc,version,agreed_at) VALUES(?,?,?,?)',
    uid, d, auth.DOC_VERSION, D.now()));
  return D.get('SELECT * FROM users WHERE id = ?', uid);
}

// ---------- 学习会话心跳 ----------
// ★ 三个函数都**先取一次 now()、再用同一个值**去插入和返回。
//   原来写的是"插入时取一次、返回时再取一次"，于是接口返回的 `at`
//   **并不是真正落库的那个时间**（本机一次写要几百毫秒，两者能差出 ±1 秒）。
//   对前端无所谓，但对"上报秒数 = 事件真实间隔"这类校验就是致命的：
//   拿返回的 at 算出来的期望值和库里的事实对不上，红得莫名其妙。
function sessionStart(spaceId, userId, token) {
  const at = D.now();
  D.run('INSERT INTO session_events(id,space_id,user_id,token,kind,at) VALUES(?,?,?,?,?,?)',
    D.uid('se_'), spaceId, userId || null, token || null, 'start', at);
  return { at };
}
function sessionHeartbeat(spaceId, userId, token) {
  // 防刷：同一 token 60 秒内只记一次，否则一个 1 秒轮询就能把"学习时长"刷上天
  const last = D.get("SELECT at FROM session_events WHERE space_id = ? AND kind = 'heartbeat' AND token = ? ORDER BY at DESC LIMIT 1", spaceId, token || null);
  if (last && D.now() - last.at < 60 * 1000) return { at: last.at, skipped: true };
  const at = D.now();
  D.run('INSERT INTO session_events(id,space_id,user_id,token,kind,at) VALUES(?,?,?,?,?,?)',
    D.uid('se_'), spaceId, userId || null, token || null, 'heartbeat', at);
  return { at, skipped: false };
}
function sessionEnd(spaceId, userId, token) {
  const at = D.now();
  D.run('INSERT INTO session_events(id,space_id,user_id,token,kind,at) VALUES(?,?,?,?,?,?)',
    D.uid('se_'), spaceId, userId || null, token || null, 'end', at);
  return { at };
}

// 学习时长（秒）：相邻两个事件间隔 ≤ 2 分钟才算"在学"
function studySeconds(spaceId, fromMs) {
  const rows = D.all('SELECT at FROM session_events WHERE space_id = ? AND at >= ? ORDER BY at ASC', spaceId, fromMs);
  let ms = 0;
  for (let i = 1; i < rows.length; i++) {
    const d = rows[i].at - rows[i - 1].at;
    if (d > 0 && d <= HEARTBEAT_GAP_MS) ms += d;
  }
  return Math.round(ms / 1000);
}
// 分块：今天 / 最近 N 天
function studyMinutes(spaceId, fromMs) { return Math.round(studySeconds(spaceId, fromMs) / 60); }

// ---------- 头像预设 ----------
// 自己设计的 9 款：形状 + 颜色。前端用原生 SVG 画（不引图片资源，也不搬对方那套）。
const AVATAR_PRESETS = [
  { id: 'tide', name: '潮汐', shape: 'wave', color: '#1D9E75' },
  { id: 'beacon', name: '灯塔', shape: 'beam', color: '#BA7517' },
  { id: 'spark', name: '星火', shape: 'star', color: '#D4537E' },
  { id: 'field', name: '原野', shape: 'leaf', color: '#639922' },
  { id: 'brook', name: '溪流', shape: 'drop', color: '#378ADD' },
  { id: 'ridge', name: '山脊', shape: 'peak', color: '#5F5E5A' },
  { id: 'polar', name: '极昼', shape: 'sun', color: '#EF9F27' },
  { id: 'abyss', name: '深蓝', shape: 'moon', color: '#534AB7' },
  { id: 'tundra', name: '苔原', shape: 'grid', color: '#0F6E56' },
];
function avatarPreset(id) { return AVATAR_PRESETS.filter(a => a.id === id)[0] || null; }

// ---------- 公告 ----------
function listAnnouncements(spaceId, userId, opts) {
  const onlyUnreadImportant = !!(opts && opts.unreadImportant);
  // rowid 兜底排序：同一毫秒内发的两条公告，只按 created_at 排是不稳定的
  let rows = D.all('SELECT * FROM announcements WHERE published = 1 ORDER BY created_at DESC, rowid DESC LIMIT 50');
  const reads = {};
  if (userId) D.all('SELECT ann_id FROM announcement_reads WHERE user_id = ?', userId).forEach(r => { reads[r.ann_id] = 1; });
  rows = rows.map(r => ({
    id: r.id, title: r.title, body: r.body, level: r.level, createdAt: r.created_at, read: !!reads[r.id],
  }));
  if (onlyUnreadImportant) rows = rows.filter(r => r.level === 'important' && !r.read);
  return rows;
}
function unreadImportantCount(userId) {
  if (!userId) return D.get("SELECT COUNT(*) c FROM announcements WHERE published = 1 AND level = 'important'") .c;
  return D.get("SELECT COUNT(*) c FROM announcements a WHERE a.published = 1 AND a.level = 'important' AND NOT EXISTS (SELECT 1 FROM announcement_reads r WHERE r.user_id = ? AND r.ann_id = a.id)", userId).c;
}
function markAnnouncementRead(userId, annId) {
  if (!userId) return 0;
  D.run('INSERT OR REPLACE INTO announcement_reads(user_id,ann_id,read_at) VALUES(?,?,?)', userId, annId, D.now());
  return 1;
}
function publishAnnouncement({ title, body, level }) {
  const t = String(title || '').trim().slice(0, 80);
  if (!t) { const e = new Error('公告标题不能为空'); e.code = 'BAD_INPUT'; throw e; }
  const id = D.uid('an_');
  D.run('INSERT INTO announcements(id,title,body,level,published,created_at) VALUES(?,?,?,?,1,?)',
    id, t, String(body || '').slice(0, 4000), level === 'important' ? 'important' : 'normal', D.now());
  return D.get('SELECT * FROM announcements WHERE id = ?', id);
}

// ---------- 协议文本 ----------
// 自己写的，结构对齐合规要求（儿童个人信息必须单独成篇且可单独同意）。
const DOC_META = {
  terms: { title: '用户协议', summary: '使用本平台的基本约定' },
  privacy: { title: '隐私政策', summary: '我们收集什么、怎么用、存多久' },
  'children-privacy': { title: '儿童个人信息保护规则', summary: '不满 14 周岁用户的专门规则' },
};

const DOC_TEXT = {
  terms: [
    ['一、服务内容', '本平台提供以对话为主要形式的学习辅助工具。AI 生成的内容仅供学习参考，可能存在错误，请自行判断，不作为任何考试、升学或诊断依据。'],
    ['二、账号与空间', '你可以用空间口令直接开始使用，也可以注册账号以便跨设备同步。账号下的学习空间默认仅你本人可见。请妥善保管口令与密码，因保管不当造成的损失由使用者承担。'],
    ['三、使用规范', '不得利用本平台上传、生成或传播违法违规内容，不得上传你无权使用的他人作品，不得对平台进行攻击、爬取或反向工程。'],
    ['四、内容归属', '你在平台内创建的内容（对话、知识卡、笔记等）归你所有。平台不会将其用于你未同意的用途。'],
    ['五、服务变更', '平台可能调整或停止部分功能。重大变更会在平台内公告。'],
  ].map(p => ({ heading: p[0], body: p[1] })),
  privacy: [
    ['一、我们收集什么', '账号信息（用户名、手机号）、你主动填写的学段与年级、你在平台内产生的学习内容（对话、知识卡、资料、练习记录）、必要的设备与日志信息。'],
    ['二、我们怎么用', '用于提供学习服务本身：生成回答、组织复习、生成学习报告。我们不会将你的学习内容用于广告投放。'],
    ['三、我们不做的事', '不向第三方出售你的个人信息；不在未经同意的情况下公开你的学习内容；不使用你的对话内容训练对外提供的模型。'],
    ['四、存储与期限', '数据存储于平台服务器，保留至你主动删除或注销账号。删除后不再保留可识别到个人的副本。'],
    ['五、你的权利', '你可以随时查看、更正、导出或删除自己的数据。删除空间或注销账号后，相关数据将不可恢复。'],
  ].map(p => ({ heading: p[0], body: p[1] })),
  'children-privacy': [
    ['一、适用范围', '本规则适用于不满 14 周岁的用户。使用前应由监护人阅读并确认同意本规则。'],
    ['二、最小必要', '我们只收集提供学习服务所必需的信息，不收集与学习无关的儿童个人信息，不收集精确位置、通讯录、相册等敏感权限数据。'],
    ['三、监护人的权利', '监护人可随时查看、更正、删除该儿童的信息，或要求停止提供服务。可在个人中心操作，也可通过公告中的联系方式提出。'],
    ['四、我们不做的事', '不向儿童推送广告；不做与学习无关的诱导性设计；不使用连续打卡、排行榜等方式制造焦虑或过度使用。'],
    ['五、安全措施', '对儿童信息采取加密存储与访问控制。发生安全事件时将及时告知监护人。'],
  ].map(p => ({ heading: p[0], body: p[1] })),
};

// ★ DOC_VERSION 定义在 auth.js，不在 db.js。
//   这里原本写的是 D.DOC_VERSION（undefined）—— JSON.stringify 会把 undefined 的键整个丢掉，
//   于是 /api/docs/:id 返回的 doc 里没有 version，前端 `openDoc` 渲染出的是「版本 」（后面空着）。
//   没有任何报错，协议弹窗一直少一行。`_parity9check.cjs` 现在钉死它。
function docs() {
  return Object.keys(DOC_META).map(k => ({ id: k, title: DOC_META[k].title, summary: DOC_META[k].summary, version: auth.DOC_VERSION }));
}
function doc(id) {
  const key = String(id || '');
  if (!DOC_META[key]) return null;
  return { id: key, title: DOC_META[key].title, version: auth.DOC_VERSION, sections: DOC_TEXT[key] || [] };
}

module.exports = {
  CODE_TTL_MS, CODE_RESEND_MS, CODE_MAX_TRIES,
  normPhone, isPhone,
  sendCode, verifyCode, peekCode,
  resetPassword, loginBySms, registerByPhone,
  sessionStart, sessionHeartbeat, sessionEnd, studySeconds, studyMinutes,
  AVATAR_PRESETS, avatarPreset,
  listAnnouncements, unreadImportantCount, markAnnouncementRead, publishAnnouncement,
  docs, doc, DOC_META,
};

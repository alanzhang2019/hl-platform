'use strict';
/**
 * 批次1 · HTTP 端到端自检：账号增强（短信/重置/改密/资料）、会话心跳、公告、协议文本。
 *
 * 规矩同 _platformtest.cjs：自带服务进程 + 临时端口 + 临时 DATA_DIR，绝不动开发库；
 * 除了"正向通"，还要做反证（未登录拿不到、限频真的限、错码真的拒、被 NEED_CONSENT
 * 挡下后验证码还能用）。
 *
 * 跑法：node _parityhttp.cjs
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const NODE = process.execPath;
const PORT = 3500 + Math.floor(Math.random() * 300);
const BASE = 'http://127.0.0.1:' + PORT;
const DATA_DIR = path.join(os.tmpdir(), 'hl-p1http-' + crypto.randomBytes(4).toString('hex'));
const ADMIN_PW = 'test-admin-pw';

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, extra) {
  // ★ `extra` 经常被传成对象（`{ 实测: …, 期望: … }`），直接拼进字符串会变成
  //   `[object Object]` —— **一条红了却说不清为什么的红，等于没红。**
  //   （本套件真出现过：`✗ ★ 刚起步时长 … → [object Object]`，看输出完全无从下手。）
  //   统一处理：非字符串一律 JSON.stringify；数字也能正常显示。
  const d = extra === undefined || extra === null ? ''
    : (typeof extra === 'string' ? extra : JSON.stringify(extra));
  if (cond) { pass++; console.log('  \u2713 ' + name); }
  else { fail++; failures.push(name + (d ? ' → ' + d : '')); console.log('  \u2717 ' + name + (d ? ' → ' + d : '')); }
}
function group(t) { console.log('\n' + t); }

async function req(method, p, body, token, extraHeaders) {
  const h = { 'Content-Type': 'application/json' };
  if (token) h.Authorization = 'Bearer ' + token;
  Object.assign(h, extraHeaders || {});
  const r = await fetch(BASE + p, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  let j = null;
  try { j = await r.json(); } catch (e) { j = null; }
  return { status: r.status, body: j };
}
const GET = (p, t) => req('GET', p, undefined, t);
const POST = (p, b, t) => req('POST', p, b, t);
const PATCH = (p, b, t) => req('PATCH', p, b, t);

function startServer() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const child = spawn(NODE, ['server.js'], {
    cwd: __dirname,
    env: Object.assign({}, process.env, {
      PORT: String(PORT), DATA_DIR, ADMIN_PASSWORD: ADMIN_PW,
      LLM_API_KEY: '', NO_DOTENV: '1',
      // 显式清空：本机若配了短信通道，接口就不会回 devCode，测试拿不到验证码
      SMS_PROVIDER_URL: '',
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', d => process.env.VERBOSE && process.stdout.write('[srv] ' + d));
  child.stderr.on('data', d => process.stderr.write('[srv:err] ' + d));
  return child;
}
async function waitReady(ms) {
  // 60 秒而不是 15 秒：本机（C 盘 100% 满 / 内存只剩几百 MB）新建一个 SQLite 库 +
  // 首次落盘就可能十几秒，15 秒会把"机器慢"报成"服务坏了" ——
  // 子进程只吐一句「服务在超时前没有就绪」，看不出到底是谁的问题。
  // 实测就是这么假红过一次。
  const until = Date.now() + (ms || 60000);
  while (Date.now() < until) {
    try { const r = await fetch(BASE + '/api/health'); if (r.ok) return await r.json(); } catch (e) {}
    await new Promise(r => setTimeout(r, 150));
  }
  throw new Error('服务在超时前没有就绪');
}
function stopServer(child) {
  return new Promise(res => {
    if (!child || child.killed) return res();
    child.on('exit', () => res());
    try { child.kill(); } catch (e) { res(); }
    setTimeout(() => { try { child.kill('SIGKILL'); } catch (e) {} res(); }, 3000);
  });
}

const DOCS = ['terms', 'privacy', 'children-privacy'];

(async () => {
  const child = startServer();
  try {
    const health = await waitReady();

    group('A. 健康检查与版本');
    ok('health 报告新接口', Array.isArray(health.apis) && health.apis.indexOf('sms') >= 0 && health.apis.indexOf('session') >= 0 && health.apis.indexOf('announcements') >= 0, JSON.stringify(health.apis));
    ok('版本已 bump（不是 cloud57b）', health.version && health.version !== '2026-09-30-cloud57b', health.version);

    group('B. 协议文本（公开）');
    const d1 = await GET('/api/docs');
    ok('三份协议', d1.status === 200 && d1.body.docs.length === 3, JSON.stringify(d1.body));
    ok('协议 id 正确', d1.body.docs.map(d => d.id).join(',') === DOCS.join(','));
    ok('带版本号', !!d1.body.version);
    const d2 = await GET('/api/docs/terms');
    ok('单篇协议有正文', d2.status === 200 && d2.body.doc.sections.length >= 4, d2.body.doc && d2.body.doc.sections.length);
    ok('儿童隐私是独立一篇', (await GET('/api/docs/children-privacy')).status === 200);
    ok('未知协议 404', (await GET('/api/docs/nope')).status === 404);

    group('C. 头像预设（公开）');
    const av = await GET('/api/avatars');
    ok('9 款预设', av.status === 200 && av.body.avatars.length === 9, av.body.avatars && av.body.avatars.length);
    const THEIR = ['星蓝', '朝阳', '远山', '星云', '探索者', '青羽', '焰光', '晨曦', '轨道'];
    ok('预设名与对标站不重合', av.body.avatars.every(a => THEIR.indexOf(a.name) < 0));

    group('D. 短信验证码');
    const bad = await POST('/api/auth/sms/send', { phone: '123', scene: 'login' });
    ok('坏手机号 400', bad.status === 400 && bad.body.error === 'BAD_PHONE', JSON.stringify(bad.body));

    const PHONE = '13800009999';
    const s1 = await POST('/api/auth/sms/send', { phone: PHONE, scene: 'login' });
    ok('取码成功', s1.status === 200 && !!s1.body.devCode, JSON.stringify(s1.body));
    ok('开发模式标记 sent=false', s1.body.sent === false);

    const s1b = await POST('/api/auth/sms/send', { phone: PHONE, scene: 'login' });
    ok('60 秒内重发 429', s1b.status === 429 && s1b.body.error === 'TOO_OFTEN', JSON.stringify(s1b.body));

    group('E. 手机号登录（未注册自动注册）');
    const noConsent = await POST('/api/auth/login/sms', { phone: PHONE, code: s1.body.devCode });
    ok('未同意协议 400 NEED_CONSENT', noConsent.status === 400 && noConsent.body.error === 'NEED_CONSENT', JSON.stringify(noConsent.body));

    // ★ 反证 1：被 NEED_CONSENT 挡下后，这个码必须还能用（不能被白烧）
    // ★ 反证 2：错码只该拒绝、不该作废 —— 所以先试错码，再试对码
    const wrongCode = await POST('/api/auth/login/sms', { phone: PHONE, code: '000000', consents: DOCS });
    ok('错码 401 BAD_CODE', wrongCode.status === 401 && wrongCode.body.error === 'BAD_CODE', JSON.stringify(wrongCode.body));

    const login1 = await POST('/api/auth/login/sms', { phone: PHONE, code: s1.body.devCode, consents: DOCS, name: '测试孩子' });
    ok('错一次后同一个码仍可登录（错码不作废）', login1.status === 200 && !!login1.body.token, JSON.stringify(login1.body));
    ok('首登标记 created', login1.body.created === true);
    const TK = login1.body.token;

    // 码是一次性的：再用必须拿不到
    const reuse = await POST('/api/auth/login/sms', { phone: PHONE, code: s1.body.devCode });
    ok('验证码一次性（已注册账号复用同一码被拒）', reuse.status !== 200, JSON.stringify(reuse.body));

    group('F. 个人资料');
    const me1 = await GET('/api/me', TK);
    ok('me 返回账号', me1.status === 200 && !!me1.body.profile, JSON.stringify(me1.body).slice(0, 120));
    ok('me 带 subjects/goals/preferences 字段', me1.body.profile && Array.isArray(me1.body.profile.subjects) && Array.isArray(me1.body.profile.goals) && typeof me1.body.profile.preferences === 'object');
    ok('me 带三份协议记录', me1.body.profile.consents.length === 3, me1.body.profile.consents.length);
    ok('me 带 space', me1.body.space.name === '测试孩子', me1.body.space.name);

    const patch1 = await PATCH('/api/me', {
      subjects: ['math', 'english'], goals: ['把分数提上来'],
      preferences: { theme: 'light', fontSize: 'large' }, avatarPreset: 'beacon', stage: '小学', grade: '5年级',
    }, TK);
    ok('PATCH 资料成功', patch1.status === 200);
    ok('subjects 写入', JSON.stringify(patch1.body.profile.subjects) === JSON.stringify(['math', 'english']), JSON.stringify(patch1.body.profile.subjects));
    ok('goals 写入', patch1.body.profile.goals.length === 1);
    ok('avatarPreset 写入', patch1.body.profile.avatarPreset === 'beacon');
    ok('学段年级写入', patch1.body.profile.stage === '小学' && patch1.body.profile.grade === '5年级');

    group('G. 改密码');
    // 手机号注册的账号本来没有密码 —— 首次设置不需要原密码（会话本身就是身份凭证）
    const cp0 = await POST('/api/auth/change-password', { oldPassword: '', newPassword: 'newpass123' }, TK);
    ok('SMS-only 账号首次设密码（无需原密码）', cp0.status === 200, JSON.stringify(cp0.body));

    // 有密码之后，必须验原密码
    const cp1 = await POST('/api/auth/change-password', { oldPassword: 'wrong-one', newPassword: 'zzz12345' }, TK);
    ok('原密码错 401', cp1.status === 401 && cp1.body.error === 'BAD_CRED', JSON.stringify(cp1.body));
    const cp2 = await POST('/api/auth/change-password', { oldPassword: 'newpass123', newPassword: '123' }, TK);
    ok('弱新密码 400', cp2.status === 400 && cp2.body.error === 'BAD_PASSWORD', JSON.stringify(cp2.body));
    // 原密码错时不能改成功 —— 反证：改完还能用旧密码登录
    const stillOld = await POST('/api/auth/login', { account: PHONE, password: 'newpass123' });
    ok('原密码错时密码未被改动', stillOld.status === 200);

    const lg = await POST('/api/auth/login', { account: PHONE, password: 'newpass123' });
    ok('新密码可登录', lg.status === 200 && !!lg.body.token, JSON.stringify(lg.body));

    group('H. 忘记密码（手机号 + 验证码）');
    const rs0 = await POST('/api/auth/reset-password', { phone: PHONE, code: '111111', password: 'reset12345' });
    ok('未取码重置被拒', rs0.status === 400 && rs0.body.error === 'NO_CODE', JSON.stringify(rs0.body));

    const rc = await POST('/api/auth/sms/send', { phone: PHONE, scene: 'reset' });
    ok('reset 场景可单独取码（不受 login 限频影响）', rc.status === 200 && !!rc.body.devCode, JSON.stringify(rc.body));
    const rs1 = await POST('/api/auth/reset-password', { phone: PHONE, code: rc.body.devCode, password: 'reset12345' });
    ok('重置成功', rs1.status === 200, JSON.stringify(rs1.body));
    const lg2 = await POST('/api/auth/login', { account: PHONE, password: 'reset12345' });
    ok('重置后的密码可登录', lg2.status === 200);
    const lg3 = await POST('/api/auth/login', { account: PHONE, password: 'newpass123' });
    ok('旧密码失效', lg3.status === 401);

    const RS_PHONE = '13900008888';
    const rc2 = await POST('/api/auth/sms/send', { phone: RS_PHONE, scene: 'reset' });
    const rs2 = await POST('/api/auth/reset-password', { phone: RS_PHONE, code: rc2.body.devCode, password: 'whatever123' });
    ok('未注册手机号重置 404', rs2.status === 404 && rs2.body.error === 'NOT_FOUND', JSON.stringify(rs2.body));

    group('I. 学习会话心跳');
    const st = await POST('/api/users/session/start', {}, TK);
    ok('start 200', st.status === 200 && st.body.at > 0);
    const hb1 = await POST('/api/users/session/heartbeat', {}, TK);
    ok('首个 heartbeat 记录', hb1.status === 200 && hb1.body.skipped === false, JSON.stringify(hb1.body));
    const hb2 = await POST('/api/users/session/heartbeat', {}, TK);
    ok('60 秒内重复 heartbeat 被跳过（防刷）', hb2.body.skipped === true, JSON.stringify(hb2.body));
    const en = await POST('/api/users/session/end', {}, TK);
    ok('end 200', en.status === 200);
    const ss = await GET('/api/users/session/stats?days=7', TK);
    ok('stats 200 且字段齐全', ss.status === 200 && typeof ss.body.seconds === 'number' && typeof ss.body.minutes === 'number' && typeof ss.body.todayMinutes === 'number', JSON.stringify(ss.body));
    // ★ 这里**不能**断言 `seconds === 0`。
    //   `studySeconds` 的定义是「相邻两个 session_event 的间隔之和」，而本组恰好
    //   插了三条事件：start → heartbeat → end（中间那次重复 heartbeat 被跳过）。
    //   所以 `seconds` 就是 start 到 end 之间**真实经过的秒数** ——
    //   断言它等于 0，等于在断言"这三次 HTTP 调用之间不到 1 秒"。
    //   那是对机器速度的断言，不是对逻辑的断言：本机一次写要几百毫秒，
    //   start→hb1→end 天然跨 4 秒，于是秒数就是 4（这条在本机长期红）。
    //
    //   真正要守的是：**被跳过的那次 heartbeat 不产生任何时长**，
    //   且上报的秒数 = 已记录事件之间的真实间隔。用服务端自己返回的 `at`
    //   算期望值，既精确又与机器速度无关。
    //
    // ★ 但期望值必须**照抄服务端的口径**，不能只用首尾时间差。
    //   `server/account.js` 的 studySeconds 是这么算的：
    //       for (i=1..n-1) { const d = rows[i].at - rows[i-1].at;
    //                        if (d > 0 && d <= HEARTBEAT_GAP_MS) ms += d; }
    //   —— 即**只累加 (0, 2 分钟] 的相邻间隔**，超时的间隔整段丢弃（"断开计"）。
    //   首尾差 = 所有间隔之和，只有在每个间隔都不超 2 分钟时才等于它。
    //   本机慢的时候 start→heartbeat 真能跨过 2 分钟，于是
    //   `seconds < 首尾差`，这条断言就长期红 —— 而它红的是机器，不是逻辑。
    const GAP_MS = 2 * 60 * 1000;   // 与 account.js 的 HEARTBEAT_GAP_MS 一致
    const evs = [
      { k: 'start', at: st.body.at },
      { k: 'hb1', at: hb1.body.at },
      { k: 'end', at: en.body.at },
    ].sort((a, b) => a.at - b.at);
    const gaps = [];
    let ms = 0;
    for (let i = 1; i < evs.length; i++) {
      const d = evs[i].at - evs[i - 1].at;
      gaps.push(d);
      if (d > 0 && d <= GAP_MS) ms += d;
    }
    const expected = Math.round(ms / 1000);
    // 间隔超窗是"机器慢"的信号，不是逻辑错 —— 如实打出来，但**不拿它当断言**
    // （拿机器速度当断言正是这条断言最初长期红的原因）。
    if (gaps.some(g => g <= 0 || g > GAP_MS)) {
      console.log('  [提示] 有相邻间隔落在 (0, 2 分钟] 之外，按规则该段不计时长：' + JSON.stringify(gaps));
    }
    ok('★ 刚起步时长 = 已记录事件之间的真实间隔（被跳过的 heartbeat 不产生时长）',
      ss.body.seconds === expected,
      { 实测: ss.body.seconds, 期望: expected, 间隔ms: gaps, 事件: evs, 重复心跳被跳过: hb2.body.skipped });

    const noAuthSess = await POST('/api/users/session/start', {});
    ok('未登录 start 401', noAuthSess.status === 401, JSON.stringify(noAuthSess.body));

    group('J. 公告');
    const anNoAuth = await GET('/api/announcements');
    ok('未登录读公告 401', anNoAuth.status === 401, JSON.stringify(anNoAuth.body));

    const al = await POST('/api/admin/login', { password: ADMIN_PW });
    ok('管理员登录', al.status === 200 && !!al.body.token);
    const ATK = al.body.token;

    const anBad = await req('POST', '/api/admin/announcements', { title: '   ' }, null, { 'x-token': ATK });
    ok('空标题 400', anBad.status === 400 && anBad.body.error === 'BAD_INPUT', JSON.stringify(anBad.body));

    const anNoTok = await POST('/api/admin/announcements', { title: 'x' });
    ok('无管理员令牌 401', anNoTok.status === 401, JSON.stringify(anNoTok.body));

    const a1 = await req('POST', '/api/admin/announcements', { title: '平台上线', body: '欢迎', level: 'normal' }, null, { 'x-token': ATK });
    const a2 = await req('POST', '/api/admin/announcements', { title: '服务调整', body: '今晚维护', level: 'important' }, null, { 'x-token': ATK });
    ok('发两条公告', a1.status === 200 && a2.status === 200);

    const anList = await GET('/api/announcements', TK);
    ok('公告列表 2 条', anList.status === 200 && anList.body.announcements.length === 2, JSON.stringify(anList.body.announcements && anList.body.announcements.length));
    ok('未读重要 = 1', anList.body.unreadImportant === 1, anList.body.unreadImportant);
    ok('倒序（最新在前）', anList.body.announcements[0].id === a2.body.announcement.id, anList.body.announcements[0].title);

    const ui = await GET('/api/announcements/unread-important', TK);
    ok('未读重要筛选 = 1 条', ui.status === 200 && ui.body.announcements.length === 1 && ui.body.count === 1, JSON.stringify(ui.body.count));

    const rd = await POST('/api/announcements/' + a2.body.announcement.id + '/read', {}, TK);
    ok('标记已读', rd.status === 200 && rd.body.unreadImportant === 0, JSON.stringify(rd.body));
    const anList2 = await GET('/api/announcements', TK);
    ok('已读后未读归零', anList2.body.unreadImportant === 0);

    group('K. 边界与反证');
    const noAuthDocs = await GET('/api/docs');
    ok('协议公开可读（登录页需要）', noAuthDocs.status === 200);
    const anonMe = await GET('/api/me');
    ok('未登录 me 401', anonMe.status === 401);
    const anonChange = await POST('/api/auth/change-password', { oldPassword: 'a', newPassword: 'bbbbbb' });
    ok('未登录改密 401', anonChange.status === 401);
    const anonStats = await GET('/api/users/session/stats');
    ok('未登录读时长 401', anonStats.status === 401);

    // 空间口令登录（无账号）改密应被明确拒绝，而不是 500
    const sp = await POST('/api/space', { name: '口令空间' + crypto.randomBytes(3).toString('hex') });
    ok('空间口令登录成功', sp.status === 200 && !!sp.body.token);
    const spChange = await POST('/api/auth/change-password', { oldPassword: 'a', newPassword: 'bbbbbb' }, sp.body.token);
    ok('空间登录改密 400 NO_ACCOUNT（不是 500）', spChange.status === 400 && spChange.body.error === 'NO_ACCOUNT', JSON.stringify(spChange.body));
    const spPatch = await PATCH('/api/me', { goals: ['x'] }, sp.body.token);
    ok('空间登录改资料 400 NO_ACCOUNT', spPatch.status === 400 && spPatch.body.error === 'NO_ACCOUNT');

  } finally {
    await stopServer(child);
    try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch (e) {}
  }

  console.log('\n' + (fail === 0 ? 'PASS' : 'FAIL') + '  通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  if (failures.length) { console.log('\n失败项：'); failures.forEach(f => console.log('  - ' + f)); }
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => {
  console.error('未捕获错误：', e);
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch (_) {}
  process.exit(1);
});

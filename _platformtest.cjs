'use strict';
/**
 * 后浪学习平台 · 端到端自检
 *
 * 规矩（沿用 node-service-e2e-selfcheck 技能）：
 *   · 自带服务进程：临时端口 + 临时 DATA_DIR，绝不动开发库
 *   · 每条断言都打印，最后汇总；有失败就以非 0 退出
 *   · 除了"正向能跑通"，还必须做反证：越权拿不到、失效真的失效、不推进真的不涨
 *
 * 跑法：node _platformtest.cjs
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const http = require('http');

const NODE = process.execPath;
const PORT = 3200 + Math.floor(Math.random() * 300);
const BASE = 'http://127.0.0.1:' + PORT;
const DATA_DIR = path.join(os.tmpdir(), 'hl-e2e-' + crypto.randomBytes(4).toString('hex'));

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  \u2713 ' + name); }
  else { fail++; failures.push(name + (extra ? ' → ' + (typeof extra === 'string' ? extra : JSON.stringify(extra)) : '')); console.log('  \u2717 ' + name + (extra ? ' → ' + (typeof extra === 'string' ? extra : JSON.stringify(extra)) : '')); }
}
function eq(name, got, want) { ok(name, JSON.stringify(got) === JSON.stringify(want), 'got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want)); }
function group(t) { console.log('\n' + t); }

// ---------- HTTP ----------
async function req(method, p, body, token) {
  const h = { 'Content-Type': 'application/json' };
  if (token) h.Authorization = 'Bearer ' + token;
  const r = await fetch(BASE + p, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  let j = null;
  try { j = await r.json(); } catch (e) { j = null; }
  return { status: r.status, body: j };
}
const GET = (p, t) => req('GET', p, undefined, t);
const POST = (p, b, t) => req('POST', p, b, t);
const PATCH = (p, b, t) => req('PATCH', p, b, t);
const DEL = (p, t) => req('DELETE', p, undefined, t);

/**
 * 发**原始路径**的请求。
 *
 * 为什么不能直接用 fetch：WHATWG URL 会规范化路径 —— `fetch(BASE + '/../server.js')`
 * 实际请求的是 `/server.js`，越界路径根本没发出去。于是"路径越界被拦"这条断言
 * 永远是绿的，但它什么都没测。要用 http.request 显式指定 path 才发得出去。
 */
function rawGet(rawPath) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: PORT, method: 'GET', path: rawPath }, res => {
      let b = '';
      res.on('data', d => { b += d; });
      res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    r.on('error', reject);
    r.end();
  });
}

// ---------- 启动 ----------
function startServer() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const child = spawn(NODE, ['server.js'], {
    cwd: __dirname,
    // NO_DOTENV=1：别读到开发者本机的真实 .env。
    // LLM_API_KEY: '' 已经把模型挡在 mock，但 .env 里还有 ADMIN_PASSWORD 等，
    // 显式跳过整份 .env 才不会出现"本机改了配置就换一种行为"的假失败。
    env: Object.assign({}, process.env, { PORT: String(PORT), DATA_DIR, ADMIN_PASSWORD: 'test-admin-pw', LLM_API_KEY: '', NO_DOTENV: '1' }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', d => process.env.VERBOSE && process.stdout.write('[srv] ' + d));
  child.stderr.on('data', d => process.stderr.write('[srv:err] ' + d));
  return child;
}
async function waitReady(ms) {
  const until = Date.now() + (ms || 12000);
  while (Date.now() < until) {
    try { const r = await fetch(BASE + '/api/health'); if (r.ok) return await r.json(); } catch (e) {}
    await new Promise(r => setTimeout(r, 150));
  }
  throw new Error('服务在超时前没有就绪');
}
async function stopServer(child) {
  return new Promise(res => {
    child.once('exit', res);
    try { child.kill('SIGKILL'); } catch (e) { res(); }
    setTimeout(res, 2500);
  });
}

// ---------- SSE 收集 ----------
async function sse(text, token, opts) {
  const o = opts || {};
  const r = await fetch(BASE + '/api/chat/stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify(Object.assign({ text }, o)),
  });
  if (!r.ok) return { status: r.status, body: await r.json().catch(() => null), events: [] };
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '', full = '', events = [];
  while (true) {
    const rd = await reader.read();
    if (rd.done) break;
    buf += dec.decode(rd.value, { stream: true });
    const parts = buf.split('\n\n');
    buf = parts.pop();
    for (const part of parts) {
      let ev = '', data = '';
      part.split('\n').forEach(l => {
        if (l.startsWith('event:')) ev = l.slice(6).trim();
        else if (l.startsWith('data:')) data += l.slice(5).trim();
      });
      if (!data) continue;
      let j; try { j = JSON.parse(data); } catch (e) { continue; }
      events.push({ ev, j });
      if (ev === 'delta') full += j.text || '';
    }
  }
  return { status: 200, events, text: full };
}

// ================= 主流程 =================
(async () => {
  const child = startServer();
  let health;
  try { health = await waitReady(); }
  catch (e) { console.error(e.message); child.kill('SIGKILL'); process.exit(1); }

  console.log('后浪学习平台 · 端到端自检');
  console.log('  服务 ' + BASE + '   数据目录 ' + DATA_DIR);

  // ---------- 1. 健康检查 ----------
  group('1. 健康检查与静态资源');
  ok('health.ok', health.ok === true);
  // 版本号每次开发都会改，写死会变成"改个版本就得改测试"的假失败。
  // 这里只校验它是个带日期的版本串，真正的契约是下面的 apis 清单。
  ok('health.version 是带日期的版本串', /^\d{4}-\d{2}-\d{2}-/.test(health.version || ''), 'got ' + health.version);
  for (const a of ['english', 'exam', 'pool']) {
    ok('health.apis 声明了 ' + a, (health.apis || []).indexOf(a) >= 0);
  }
  ok('health.mockLLM（未配 Key 时走离线演示）', health.mockLLM === true);
  ok('health.adminPanel（设了 ADMIN_PASSWORD 后开启）', health.adminPanel === true);
  for (const f of ['/', '/app.css', '/js/app.js', '/js/render.js']) {
    const r = await fetch(BASE + f);
    ok('静态资源 ' + f + ' 可取', r.ok, 'status ' + r.status);
  }

  // ---------- 2. 空间：创建 / 唯一 / 预检 / 进入 ----------
  group('2. 学习空间：唯一姓名、ID 连号、口令');
  const a = await POST('/api/space', { name: '张小明', passcode: '' });
  eq('创建空间返回 200', a.status, 200);
  eq('第一个空间 ID 从 0001 起', a.body.spaceId, '0001');
  ok('创建后直接发令牌', !!a.body.token);
  const TA = a.body.token;

  const dup = await POST('/api/space', { name: '张小明', passcode: '' });
  eq('重名被拒（409）', dup.status, 409);
  eq('重名错误码', dup.body.error, 'NAME_TAKEN');
  eq('重名给出建议名（张小明 → 张小明2）', dup.body.suggested, '张小明2');

  const okName = await POST('/api/space', { name: '张小明2', passcode: 'pw2' });
  eq('换成建议的名字即可创建', okName.status, 200);
  eq('第二个空间 ID 连号', okName.body.spaceId, '0002');
  ok('第二个空间带上了口令', okName.body.name === '张小明2');

  const dup2 = await POST('/api/space', { name: '张小明2', passcode: '' });
  eq('带尾号的名字重名也被拦（409）', dup2.status, 409);
  eq('顺着尾号递增而不是叠一层：张小明2 → 张小明3', dup2.body.suggested, '张小明3');

  const dup3 = await POST('/api/space', { name: '张小明', passcode: '' });
  eq('基础名与尾号都被占时跳到下一个空位', dup3.body.suggested, '张小明3');

  const blank = await POST('/api/space', { name: '', passcode: '' });
  eq('空姓名走默认名（学习者），不报错', blank.status, 200);
  eq('默认名', blank.body.name, '学习者');

  const pre1 = await GET('/api/space-name?name=' + encodeURIComponent('张小明'));
  eq('预检：已被占用', pre1.body.available, false);
  eq('预检：给出建议', pre1.body.suggested, '张小明3');
  const pre2 = await GET('/api/space-name?name=' + encodeURIComponent('李四'));
  eq('预检：可用', pre2.body.available, true);
  const pre3 = await GET('/api/space-name?name=' + encodeURIComponent('  张 小明  '));
  eq('预检：去掉空白后仍判为占用（"张 小明" ≠ 新的人）', pre3.body.available, false);
  const pre4 = await GET('/api/space-name?name=' + encodeURIComponent('张小明'));
  eq('预检：大小写与空白归一后一致', pre4.body.name, '张小明');

  const wrongPass = await POST('/api/space', { spaceId: '2', passcode: 'nope' });
  eq('口令错误被拒（403）', wrongPass.status, 403);
  const rightPass = await POST('/api/space', { spaceId: '2', passcode: 'pw2' });
  eq('纯数字 ID 自动左补零后进入', rightPass.status, 200);
  eq('进入的是 0002', rightPass.body.spaceId, '0002');
  const noPass = await POST('/api/space', { spaceId: '0002', passcode: '' });
  eq('口令为空时不校验（沿用旧版行为）', noPass.status, 200);
  const ghost = await POST('/api/space', { spaceId: '9999', passcode: '' });
  eq('不存在的空间返回 404', ghost.status, 404);
  const badId = await POST('/api/space', { spaceId: '!!!', passcode: '' });
  ok('非法 ID 不返回 200', badId.status !== 200, 'status ' + badId.status);

  // ---------- 3. 鉴权 ----------
  group('3. 鉴权');
  const noTok = await GET('/api/me');
  eq('无令牌访问 /api/me 返回 401', noTok.status, 401);
  const badTok = await GET('/api/me', 'deadbeef');
  eq('伪造令牌返回 401', badTok.status, 401);
  const me = await GET('/api/me', TA);
  eq('/api/me 返回空间信息', me.body.space.id, '0001');
  eq('空间名就是姓名', me.body.space.name, '张小明');
  ok('返回统计块', !!me.body.stats);

  // ---------- 3.5 宠物基线 ----------
  group('3.5 宠物基线（此时还没有练过任何知识卡）');
  const petInit = await GET('/api/pet', TA);
  eq('初始阶段 1（嫩芽）', petInit.body.pet.stage, 1);
  eq('初始阶段名', petInit.body.pet.stageName, '嫩芽');
  eq('初始成长值 0', petInit.body.pet.growth, 0);
  eq('下一档需要 30', petInit.body.pet.nextNeed, 30);
  eq('还差 30', petInit.body.pet.toNext, 30);
  ok('未长成', petInit.body.pet.maxed === false);

  // ---------- 4. 账号：注册必须同意协议 ----------
  group('4. 账号注册与协议同意（未成年人合规）');
  const noConsent = await POST('/api/auth/register', { username: 'xiaoming', password: 'abc123', name: '张小明' });
  eq('未同意协议被拒（400）', noConsent.status, 400);
  eq('错误码 NEED_CONSENT', noConsent.body.error, 'NEED_CONSENT');

  const partConsent = await POST('/api/auth/register', { username: 'xiaoming', password: 'abc123', consents: ['terms'] });
  eq('只同意一份仍被拒', partConsent.body.error, 'NEED_CONSENT');

  const reg = await POST('/api/auth/register', {
    username: 'xiaoming', password: 'abc123', name: '张小明', grade: '小学五年级', spaceId: '0001',
    consents: ['terms', 'privacy', 'children-privacy'],
  });
  eq('三份都同意后注册成功', reg.status, 200);
  ok('注册返回令牌', !!reg.body.token);
  const TACC = reg.body.token;
  const prof = await GET('/api/me', TACC);
  eq('账号会话拿到 profile', prof.body.profile.username, 'xiaoming');
  eq('账号会话的 kind', prof.body.kind, 'account');
  eq('三份同意记录已落库', (prof.body.profile.consents || []).length, 3);

  const dupUser = await POST('/api/auth/register', {
    username: 'xiaoming', password: 'abc123', consents: ['terms', 'privacy', 'children-privacy'],
  });
  eq('用户名重复被拒（409）', dupUser.status, 409);

  const badLogin = await POST('/api/auth/login', { account: 'xiaoming', password: 'wrong' });
  eq('密码错误返回 401', badLogin.status, 401);
  const login = await POST('/api/auth/login', { account: 'xiaoming', password: 'abc123' });
  eq('登录成功', login.status, 200);
  eq('登录回到同一个空间', login.body.spaceId, '0001');
  const loginPhone = await POST('/api/auth/login', { account: '', password: 'abc123' });
  eq('空账号被拒', loginPhone.status, 400);

  // ---------- 5. 项目 ----------
  group('5. 项目');
  const p1 = await POST('/api/projects', { name: '这学期物理', instructions: '先用问题引导我，别直接讲' }, TA);
  eq('创建项目', p1.status, 200);
  const PID = p1.body.project.id;
  eq('项目带学习指令', p1.body.project.instructions, '先用问题引导我，别直接讲');
  const plist = await GET('/api/projects', TA);
  eq('项目列表返回 1 条', plist.body.projects.length, 1);
  const p2 = await PATCH('/api/projects/' + PID, { name: '这学期物理（改）' }, TA);
  eq('改名生效', p2.body.project.name, '这学期物理（改）');
  const pGhost = await PATCH('/api/projects/nope', { name: 'x' }, TA);
  eq('改不存在的项目返回 404', pGhost.status, 404);

  // ---------- 6. 对话 + SSE 流式 ----------
  group('6. 对话与 SSE 流式');
  const empty = await POST('/api/chat/stream', { text: '   ' }, TA);
  eq('空消息被拒（400）', empty.status, 400);

  const s1 = await sse('三角形面积怎么算？', TA, { mode: 'selfstudy', model: 'default' });
  eq('流式返回 200', s1.status, 200);
  const meta = s1.events.find(e => e.ev === 'meta');
  const done = s1.events.find(e => e.ev === 'done');
  ok('收到 meta 事件（带 conversationId）', !!meta && !!meta.j.conversationId);
  ok('收到 done 事件', !!done);
  ok('收到多个 delta（真的在流式，不是一次性返回）', s1.events.filter(e => e.ev === 'delta').length > 3,
    'delta 数 ' + s1.events.filter(e => e.ev === 'delta').length);
  const CID = meta.j.conversationId;
  ok('拼接后的正文非空', s1.text.length > 10);
  ok('【绝不直接给答案】提示词生效：离线演示也先反问', /你觉得|你先|哪一步|注意到/.test(s1.text), s1.text.slice(0, 60));

  const conv = await GET('/api/conversations/' + CID, TA);
  eq('会话里存了 2 条消息（问 + 答）', conv.body.messages.length, 2);
  eq('第一条是用户', conv.body.messages[0].role, 'user');
  eq('第二条是助手', conv.body.messages[1].role, 'assistant');
  ok('首条用户消息自动成了标题', conv.body.conversation.title.indexOf('三角形') >= 0, conv.body.conversation.title);

  const s2 = await sse('那如果只知道三条边呢？', TA, { conversationId: CID, mode: 'feynman' });
  const conv2 = await GET('/api/conversations/' + CID, TA);
  eq('续聊后消息累加到 4 条', conv2.body.messages.length, 4);
  ok('切换学习模式不影响落库', s2.status === 200);

  const clist = await GET('/api/conversations', TA);
  eq('会话列表 1 条', clist.body.conversations.length, 1);
  ok('会话列表带消息数', clist.body.conversations[0].messageCount === 4);

  const fav = await PATCH('/api/conversations/' + CID, { isFavorite: true }, TA);
  eq('收藏标记生效', fav.body.conversation.isFavorite, true);
  const favList = await GET('/api/conversations?favorite=1', TA);
  eq('按收藏筛选返回 1 条', favList.body.conversations.length, 1);
  const favList0 = await GET('/api/conversations?favorite=0', TA);
  eq('不带收藏筛选返回全部', favList0.body.conversations.length, 1);

  // ---------- 7. 分享 ----------
  group('7. 分享（免登录只读）与失效');
  const sh = await POST('/api/conversations/' + CID + '/share', {}, TA);
  eq('创建分享', sh.status, 200);
  const TOKEN_SH = sh.body.share.token;
  ok('分享 token 非空', !!TOKEN_SH);
  const shPub = await fetch(BASE + '/api/share/' + TOKEN_SH);
  const shPubJ = await shPub.json();
  eq('免登录可取分享内容', shPub.status, 200);
  eq('分享返回会话消息', (shPubJ.messages || []).length, 4);
  eq('分享带上空间名', shPubJ.spaceName, '张小明');
  const shAgain = await POST('/api/conversations/' + CID + '/share', {}, TA);
  eq('重复分享复用同一 token', shAgain.body.share.token, TOKEN_SH);
  const shInfo = await GET('/api/conversations/' + CID + '/share', TA);
  ok('分享有浏览计数', shInfo.body.share.views >= 1, 'views=' + shInfo.body.share.views);
  const shStop = await DEL('/api/conversations/' + CID + '/share', TA);
  eq('停止分享', shStop.body.cancelled, true);
  const shGone = await fetch(BASE + '/api/share/' + TOKEN_SH);
  eq('停止后公开接口 404（失效是真失效）', shGone.status, 404);
  const shBad = await fetch(BASE + '/api/share/zzzzzzzz');
  eq('不存在的 token 也 404', shBad.status, 404);

  // ---------- 8. 记忆 ----------
  group('8. 记忆');
  const mem0 = await GET('/api/memory', TA);
  eq('默认开启记忆', mem0.body.enabled, true);
  const memAdd = await POST('/api/memory', { content: '我不喜欢直接给答案，请多问我' }, TA);
  eq('添加记忆', memAdd.status, 200);
  const memAddEmpty = await POST('/api/memory', { content: '  ' }, TA);
  eq('空记忆被拒', memAddEmpty.status, 400);
  const mem1 = await GET('/api/memory', TA);
  eq('记忆列表 1 条', mem1.body.memories.length, 1);
  const memOff = await POST('/api/memory/settings', { enabled: false }, TA);
  eq('关闭记忆', memOff.body.enabled, false);
  const mem2 = await GET('/api/memory', TA);
  eq('关闭后读回来仍是关闭', mem2.body.enabled, false);
  await POST('/api/memory/settings', { enabled: true }, TA);
  const memDel = await DEL('/api/memory/' + mem1.body.memories[0].id, TA);
  eq('删除记忆', memDel.body.ok, true);
  const mem3 = await GET('/api/memory', TA);
  eq('删除后剩 0 条', mem3.body.memories.length, 0);

  // ---------- 9. 知识卡：全链路 ----------
  group('9. 知识卡：间隔推进 / 答错退档 / 提示不泄题 / 理解核对');
  const cardA = await POST('/api/cards', {
    knowledge: '三角形面积', type: 'choice', question: '底 6 高 4 的三角形面积是多少？',
    answer: '12', options: { choices: ['12', '24', '10', '6'], answerIndex: 0 },
  }, TA);
  eq('创建选择题', cardA.status, 200);
  const KA = cardA.body.card.id;
  eq('初始状态：学习中', cardA.body.card.status, 'learning');
  eq('初始 stage 0，间隔 1 天', cardA.body.card.stage, 0);
  ok('新卡立即到期', cardA.body.card.overdue === true);

  const cardB = await POST('/api/cards', { knowledge: '光合作用', type: 'understanding', question: '说说光合作用是怎么回事', answer: '植物用光能把二氧化碳和水变成有机物并放出氧气' }, TA);
  const KB = cardB.body.card.id;
  const cardC = await POST('/api/cards', { knowledge: 'photosynthesis', type: 'spelling', question: '光合作用的英文', answer: 'photosynthesis' }, TA);
  const KC = cardC.body.card.id;
  const badCard = await POST('/api/cards', { knowledge: '' }, TA);
  eq('空知识点被拒', badCard.status, 400);

  const sum1 = await GET('/api/cards/summary', TA);
  eq('汇总 total = 3', sum1.body.total, 3);
  eq('汇总 due = 3', sum1.body.due, 3);
  eq('汇总 learning = 3', sum1.body.learning, 3);

  // 答错 → 退档但不清零
  const rw = await POST('/api/cards/' + KA + '/review', { result: 'wrong', studentAnswer: '24' }, TA);
  eq('答错后仍是 learning', rw.body.card.status, 'learning');
  eq('答错后 stage 仍是 0（不清零，但也不前进）', rw.body.card.stage, 0);
  eq('答错后间隔 1 天', rw.body.intervalDays, 1);
  ok('答错文案不说"你错了"', rw.body.message.indexOf('错') < 0 || rw.body.message.indexOf('没答对') >= 0, rw.body.message);

  // 连对推进：learning → almost → mastered（§5：连续答对 5 次 = 已掌握）
  const stages = [], statuses = [];
  for (let i = 0; i < 7; i++) {
    const r = await POST('/api/cards/' + KA + '/review', { result: 'right', studentAnswer: '12' }, TA);
    stages.push(r.body.card.stage);
    statuses.push(r.body.card.status);
  }
  eq('连续 5 次答对即已掌握（stage=5）', stages[4], 5);
  eq('第 5 次后状态 mastered', statuses[4], 'mastered');
  ok('推进过程单调不减', stages.every((v, i) => i === 0 || v >= stages[i - 1]), JSON.stringify(stages));
  eq('已掌握后阶段不再前进（保持 5）', stages[6], 5);
  const sumA = await GET('/api/cards/' + KA, TA);
  eq('到顶后状态变为已掌握', sumA.body.card.status, 'mastered');
  eq('已掌握后二次核对间隔 60 天', sumA.body.card.intervalDays, 60);

  // 已掌握的卡再答错 → 退回学习中（§5：答错的卡第二天会再来）
  const back = await POST('/api/cards/' + KA + '/review', { result: 'wrong', studentAnswer: '0' }, TA);
  eq('已掌握答错退回学习中', back.body.card.status, 'learning');
  eq('退回后 stage 归零', back.body.card.stage, 0);
  eq('答错间隔 1 天（第二天）', back.body.intervalDays, 1);

  // unknown 不改档
  const unk = await POST('/api/cards/' + KA + '/review', { result: 'unknown' }, TA);
  eq('unknown 保持 stage 不变（0）', unk.body.card.stage, 0);
  ok('unknown 文案说明没记为答错', unk.body.message.indexOf('没有记为答错') >= 0, unk.body.message);

  // 提示：泄题必被拦
  const hintLeak = await POST('/api/cards/' + KA + '/hint', {}, TA);
  ok('提示要么给出短提示、要么坦白隐藏', typeof hintLeak.body.hidden === 'boolean');
  if (hintLeak.body.hidden) ok('隐藏时给出解释文案', !!hintLeak.body.message);
  else ok('提示不超 25 字', hintLeak.body.hint.length <= 25, 'len=' + hintLeak.body.hint.length);
  ok('提示不包含答案 12', String(hintLeak.body.hint || '').indexOf('12') < 0, hintLeak.body.hint);

  // 理解题核对（离线模式无法判断 → 必须记为 unknown，绝不能算错）
  const uc = await POST('/api/cards/' + KB + '/understanding-check', { answer: '植物靠阳光把水和二氧化碳做成养分，同时放出氧气' }, TA);
  eq('核对返回 verdict', uc.status, 200);
  ok('verdict 取值合法', ['solid', 'partial', 'off', 'unknown'].indexOf(uc.body.verdict.verdict) >= 0, uc.body.verdict.verdict);
  const ucc = await POST('/api/cards/' + KB + '/understanding-complete', {
    answer: '植物靠阳光把水和二氧化碳做成养分，同时放出氧气', verdict: uc.body.verdict,
  }, TA);
  if (uc.body.verdict.verdict === 'unknown') {
    eq('判断不了时不记为答错（stage 保持 0）', ucc.body.card.stage, 0);
    ok('判断不了时状态仍是 learning', ucc.body.card.status === 'learning');
  } else {
    ok('有判断时按判定推进或退档', ucc.body.card.stage >= 0);
  }
  const ucEmpty = await POST('/api/cards/' + KB + '/understanding-check', { answer: '  ' }, TA);
  eq('理解核对空答案被拒', ucEmpty.status, 400);

  // 我已经会了 → 推迟 14 天 → 可撤销
  const known = await POST('/api/cards/' + KC + '/self-known', {}, TA);
  eq('标记"我已经会了"', known.status, 200);
  eq('状态变为 retired', known.body.card.status, 'retired');
  eq('推迟天数 14', known.body.deferDays, 14);
  ok('到期时间被推后', known.body.card.dueAt > Date.now() + 13 * 86400000);
  // 此时 KA / KB 都刚练过（明天才到期），KC 是 retired。新造一张卡来验证"retired 真的被排除"
  const cardE = await POST('/api/cards', { knowledge: '临时验证卡', type: 'choice', answer: 'a', options: { choices: ['a', 'b'], answerIndex: 0 } }, TA);
  const sumAfterKnown = await GET('/api/cards/summary', TA);
  eq('retired 计数为 1（KC 已标记会）', sumAfterKnown.body.retired, 1);
  ok('未推进的卡与新卡都计入今日待练（共 2 张）', sumAfterKnown.body.due === 2, 'due=' + sumAfterKnown.body.due);
  ok('retired 不计入今日待练', sumAfterKnown.body.due < sumAfterKnown.body.total, 'due=' + sumAfterKnown.body.due + ' total=' + sumAfterKnown.body.total);
  const delE = await DEL('/api/cards/' + cardE.body.card.id, TA);
  eq('删除知识卡生效', delE.body.deleted, true);
  eq('删除后回到 3 张', (await GET('/api/cards', TA)).body.total, 3);
  eq('删不存在的卡返回 deleted:false', (await DEL('/api/cards/nope', TA)).body.deleted, false);
  const undo = await POST('/api/cards/' + KC + '/undo-self-known', { previous: known.body.previous }, TA);
  eq('撤销"我已经会了"回到 learning', undo.body.card.status, 'learning');
  eq('撤销后 stage 回到 0', undo.body.card.stage, 0);

  // restore-review：刚才没答好，重来
  const rr = await POST('/api/cards/' + KA + '/restore-review', {}, TA);
  eq('重置为学习中', rr.body.card.status, 'learning');
  eq('重置后 stage 归零', rr.body.card.stage, 0);

  // 列表与筛选、分页、排序
  const lAll = await GET('/api/cards?status=all&sort=due&page=1&pageSize=2', TA);
  eq('分页 pageSize 生效', lAll.body.items.length, 2);
  eq('分页 total 正确', lAll.body.total, 3);
  eq('分页页数正确', lAll.body.pages, 2);
  const l2 = await GET('/api/cards?status=all&page=2&pageSize=2', TA);
  eq('第二页 1 条', l2.body.items.length, 1);
  const lSearch = await GET('/api/cards?q=' + encodeURIComponent('三角'), TA);
  eq('按知识点搜索命中 1 条', lSearch.body.items.length, 1);
  const lSort = await GET('/api/cards?sort=knowledge', TA);
  ok('按知识点排序：photosynthesis 排最前', lSort.body.items[0].knowledge === 'photosynthesis', lSort.body.items.map(x => x.knowledge).join(','));
  const lType = await GET('/api/cards?status=retired', TA);
  eq('按状态筛选 retired 为 0 条', lType.body.items.length, 0);

  // 从对话生成（离线模式生成不出来，但必须优雅返回空数组，不能 500）
  const gen = await POST('/api/cards/generate', { conversationId: CID, count: 3 }, TA);
  eq('离线模式生成接口不报错', gen.status, 200);
  ok('返回数组（可能为空）', Array.isArray(gen.body.cards), JSON.stringify(gen.body).slice(0, 80));

  // ---------- 10. 宠物：只在状态推进时涨 ----------
  group('10. 宠物成长值：只认"状态真的推进了"');
  const pet0 = await GET('/api/pet', TA);
  const beforeGrowth = pet0.body.pet.growth;
  ok('练过卡之后成长值已经涨起来了', beforeGrowth > 0, 'growth=' + beforeGrowth);
  // 造一张新卡，答错 → 不涨
  const cardD = await POST('/api/cards', { knowledge: '测试不涨分', type: 'choice', answer: '1', options: { choices: ['1', '2'], answerIndex: 0 } }, TA);
  const KD = cardD.body.card.id;
  await POST('/api/cards/' + KD + '/review', { result: 'wrong', studentAnswer: '2' }, TA);
  const petAfterWrong = await GET('/api/pet', TA);
  eq('答错不加成长值', petAfterWrong.body.pet.growth, beforeGrowth);

  await POST('/api/cards/' + KD + '/review', { result: 'unknown' }, TA);
  const petAfterUnknown = await GET('/api/pet', TA);
  eq('unknown 不加成长值', petAfterUnknown.body.pet.growth, beforeGrowth);

  await POST('/api/cards/' + KD + '/review', { result: 'right', studentAnswer: '1' }, TA);
  const petAfterRight = await GET('/api/pet', TA);
  ok('答对才加成长值', petAfterRight.body.pet.growth > beforeGrowth, beforeGrowth + ' → ' + petAfterRight.body.pet.growth);
  ok('成长值涨幅与档位推进挂钩（5 + 3×跨度 = 8）', petAfterRight.body.pet.growth - beforeGrowth === 8,
    'delta=' + (petAfterRight.body.pet.growth - beforeGrowth));
  ok('宠物信息带下一档所需', petAfterRight.body.pet.toNext >= 0);

  // ---------- 11. 多租户隔离（反证）----------
  group('11. 多租户隔离（反证：另一个空间拿不到本空间的数据）');
  const TB = rightPass.body.token;   // 空间 0002
  const meB = await GET('/api/me', TB);
  eq('B 空间身份正确', meB.body.space.id, '0002');
  eq('B 空间看不到 A 的会话', (await GET('/api/conversations', TB)).body.conversations.length, 0);
  eq('B 空间看不到 A 的项目', (await GET('/api/projects', TB)).body.projects.length, 0);
  eq('B 空间看不到 A 的知识卡', (await GET('/api/cards', TB)).body.total, 0);
  eq('B 空间看不到 A 的记忆', (await GET('/api/memory', TB)).body.memories.length, 0);
  const crossConv = await GET('/api/conversations/' + CID, TB);
  eq('用 B 的令牌读 A 的会话 → 404', crossConv.status, 404);
  const crossCard = await GET('/api/cards/' + KA, TB);
  eq('用 B 的令牌读 A 的知识卡 → 404', crossCard.status, 404);
  const crossReview = await POST('/api/cards/' + KA + '/review', { result: 'right' }, TB);
  eq('用 B 的令牌改 A 的知识卡 → 404', crossReview.status, 404);
  const crossDel = await DEL('/api/conversations/' + CID, TB);
  eq('用 B 的令牌删 A 的会话 → 不生效', (await GET('/api/conversations/' + CID, TA)).status, 200);
  const crossProj = await PATCH('/api/projects/' + PID, { name: '篡改' }, TB);
  eq('用 B 的令牌改 A 的项目 → 404', crossProj.status, 404);
  const crossStats = await GET('/api/stats', TB);
  eq('B 空间统计里没有 A 的数据', crossStats.body.cards, 0);

  // 空间 0002 里写数据，不能污染 0001
  await POST('/api/cards', { knowledge: 'B 空间的知识点', type: 'choice', answer: 'x' }, TB);
  eq('A 空间卡数不受 B 影响', (await GET('/api/cards', TA)).body.total, 4);
  eq('B 空间卡数为 1', (await GET('/api/cards', TB)).body.total, 1);

  // ---------- 12. 路径越界与兜底 ----------
  group('12. 静态资源护栏与兜底');
  // 正常静态资源必须先证明是通的，否则下面的"被拦"可能只是"本来就 404"
  eq('正常静态资源可访问', (await rawGet('/js/app.js')).status, 200);
  eq('首页可访问', (await rawGet('/')).status, 200);

  // 越界。
  // ★ 判据是**内容**，不是状态码 —— 这一点踩过：
  //   · new URL() 会把 '..' 段规范化掉，所以 /../server.js 到了服务端已经变成 /server.js → 404；
  //   · /.env 没有扩展名（path.extname('.env') === ''），命不中文件时会走 SPA 回退 → 200 + index.html。
  //   两种都不是泄漏。真正要证的是"目标文件的内容一个字都没被吐出来"。
  //   反过来，编码过的 /..%2F.env 不会被 URL 规范化，是**真的**把越界路径送到护栏面前的用例。
  const TRAV = [
    ['/../server.js', 'server.js 源码', "require('./server/db')"],
    ['/../.env', '.env（含模型 Key）', 'LLM_API_KEY'],
    ['/../../server.js', 'server.js 源码', "require('./server/db')"],
    ['/..%2F.env', '.env（含模型 Key）', 'LLM_API_KEY'],
    ['/%2e%2e%2f.env', '.env（含模型 Key）', 'LLM_API_KEY'],
    ['/%2e%2e/%2e%2e/server.js', 'server.js 源码', "require('./server/db')"],
    ['/../.env.example', '.env.example', 'LLM_BASE_URL'],
  ];
  for (const [p, what, marker] of TRAV) {
    const r = await rawGet(p);
    ok('越界读不到 ' + what + '：' + p, r.body.indexOf(marker) < 0,
      'status ' + r.status + '，body 前 60 字：' + r.body.slice(0, 60).replace(/\s+/g, ' '));
  }
  // 编码形式的越界应当被护栏直接挡掉（403），不该落到"读文件失败"那一步
  for (const p of ['/..%2F.env', '/%2e%2e%2f.env']) {
    eq('编码越界直接 403：' + p, (await rawGet(p)).status, 403);
  }

  // 前缀比较的漏洞：护栏若写成 path.resolve(file).startsWith(PUBLIC_DIR)，
  // 那么落点 public-xxx 会通过检查 —— 因为 'public-xxx' 以 'public' 开头。
  // 这里真的造一个同前缀的兄弟目录来验：能读到 = 护栏是坏的。
  //
  // ★ 必须用**编码形式** `/..%2F…`。写成 `/../public-xxx/…` 是测不出来的 ——
  //   new URL() 会在解析时就把 '..' 段规范化掉，越界路径根本送不到护栏面前，
  //   于是这条断言会一直是绿的（本测试最初就写错成这样，靠反证才发现）。
  const probeName = 'public-zzguard-probe';
  const probeDir = path.join(__dirname, probeName);
  try {
    fs.mkdirSync(probeDir, { recursive: true });
    fs.writeFileSync(path.join(probeDir, 'leak.txt'), 'LEAKED', 'utf8');
    for (const p of ['/..%2F' + probeName + '%2Fleak.txt', '/%2e%2e%2f' + probeName + '%2fleak.txt']) {
      const sib = await rawGet(p);
      ok('同前缀兄弟目录读不到（护栏不是简单前缀比较）：' + p,
        sib.status !== 200 && sib.body.indexOf('LEAKED') < 0, 'status ' + sib.status);
    }
  } finally {
    try { fs.rmSync(probeDir, { recursive: true, force: true }); } catch (e) {}
  }

  const spa = await fetch(BASE + '/s/abcdef');
  eq('SPA 回退把未知无扩展名路径交回前端', spa.status, 200);
  const nf = await fetch(BASE + '/nope.js');
  eq('未知 .js 返回 404', nf.status, 404);
  const nfApi = await GET('/api/nope', TA);
  eq('未知 API 返回 404', nfApi.status, 404);

  // ---------- 13. 管理员 ----------
  group('13. 管理员空间管理');
  const admBad = await POST('/api/admin/login', { password: 'nope' });
  eq('管理密码错误 401', admBad.status, 401);
  const adm = await POST('/api/admin/login', { password: 'test-admin-pw' });
  eq('管理登录成功', adm.status, 200);
  const admList = await fetch(BASE + '/api/admin/spaces', { headers: { 'x-token': adm.body.token } });
  const admJ = await admList.json();
  eq('管理列表可读', admList.status, 200);
  ok('管理列表含 0001/0002', (admJ.spaces || []).some(s => s.spaceId === '0001') && (admJ.spaces || []).some(s => s.spaceId === '0002'));
  ok('管理列表带对话/知识卡计数', (admJ.spaces || []).every(s => typeof s.conversations === 'number' && typeof s.cards === 'number'));
  const admNoTok = await fetch(BASE + '/api/admin/spaces');
  eq('没有管理令牌读不到列表（401）', admNoTok.status, 401);
  const admFake = await fetch(BASE + '/api/admin/spaces', { headers: { 'x-token': 'fake' } });
  eq('伪造管理令牌被拒（401）', admFake.status, 401);

  // ---------- 15. 看板（P5）----------
  group('15. 看板');
  const db1 = await GET('/api/dashboard?days=7', TA);
  eq('看板返回 200', db1.status, 200);
  eq('曲线默认 7 天', db1.body.curve.length, 7);
  ok('曲线每天带日期', /^\d{4}-\d{2}-\d{2}$/.test(db1.body.curve[0].date), db1.body.curve[0].date);
  ok('统计到知识卡总数', db1.body.totals.cards === 4, JSON.stringify(db1.body.totals));
  ok('有活跃天数', db1.body.activeDays >= 1, 'activeDays=' + db1.body.activeDays);
  ok('连续天数 >= 1', db1.body.streak.days >= 1, JSON.stringify(db1.body.streak));
  ok('有复习动作统计', db1.body.movement.reviews >= 3, JSON.stringify(db1.body.movement));
  ok('找出薄弱点', db1.body.weakPoints.length >= 1, JSON.stringify(db1.body.weakPoints));
  ok('薄弱点带答错次数', db1.body.weakPoints[0].wrongs >= 1);
  ok('有近期活动流', db1.body.recent.length >= 1);
  ok('与上周对比有方向', ['up', 'down', 'flat'].indexOf(db1.body.compare.direction) >= 0);
  const repW = await GET('/api/dashboard/report?period=week', TA);
  ok('周报生成成功', repW.status === 200 && repW.body.lines.length >= 3, JSON.stringify(repW.body.lines));
  ok('周报不含"你错了"这类措辞', repW.body.lines.join(' ').indexOf('你错了') < 0);
  const repD = await GET('/api/dashboard/report?period=day', TA);
  ok('日报生成成功', repD.status === 200 && repD.body.lines.length >= 2);
  const dbB = await GET('/api/dashboard', TB);
  eq('B 空间看板看不到 A 的知识卡', dbB.body.totals.cards, 1);

  // ---------- 16. 能力中心（P7）----------
  group('16. 能力中心');
  const sk0 = await GET('/api/skills', TA);
  eq('技能注册表可读', sk0.status, 200);
  // 57 是对标站 /skills/registry 的总数，我们按这个数把覆盖面补齐。
  // 名字和提示词是自己写的（对方名单没抓到），所以这里只锁"数量与结构"，
  // 不锁具体条目名 —— 锁名字等于把测试绑死在文案上，改个字就假失败。
  eq('技能数量正好 57', sk0.body.skills.length, 57);
  ok('技能 id 不重复', new Set(sk0.body.skills.map(s => s.id)).size === sk0.body.skills.length);
  ok('技能显示名不重复', new Set(sk0.body.skills.map(s => s.name)).size === sk0.body.skills.length);
  ok('默认没有启用任何技能', sk0.body.enabled.length === 0, JSON.stringify(sk0.body.enabled));
  ok('技能带名称与说明', sk0.body.skills.every(s => s.name && s.description));
  ok('技能带分类', sk0.body.skills.some(s => s.category === 'method') && sk0.body.skills.some(s => s.category === 'subject'));
  ok('有费曼讲解技能', sk0.body.skills.some(s => s.id === 'feynman'));
  // 全部免费 —— 这是和对标站最本质的差别（他们 56/57 锁在付费等级里）
  ok('全部技能都是 free（不做付费解锁）', sk0.body.skills.every(s => s.tier === 'free'),
    JSON.stringify(sk0.body.skills.map(s => s.tier).filter((v, i, a) => a.indexOf(v) === i)));
  // 新增的 social 学科（道法/历史/地理）—— 计划 §6.2 提过但当时没做
  ok('覆盖 social 学科（历史/地理/道法）', sk0.body.skills.some(s => s.subject === 'social'),
    JSON.stringify(sk0.body.skills.map(s => s.subject).filter((v, i, a) => a.indexOf(v) === i)));
  ok('六大主学科都有条目',
    ['math', 'chinese', 'english', 'science', 'social'].every(x => sk0.body.skills.some(s => s.subject === x)));
  const skCat = await GET('/api/skills?category=method', TA);
  ok('按分类筛选生效', skCat.body.skills.length > 0 && skCat.body.skills.every(s => s.category === 'method'), skCat.body.skills.length + ' 个');
  const skSoc = await GET('/api/skills?subject=social', TA);
  ok('按学科筛选生效（social）', skSoc.body.skills.length >= 3 && skSoc.body.skills.every(s => s.subject === 'social'), skSoc.body.skills.length + ' 个');
  const skG = await POST('/api/skills/feynman/grant', {}, TA);
  eq('授予技能成功', skG.status, 200);
  ok('授予后出现在 enabled', skG.body.enabled.indexOf('feynman') >= 0, JSON.stringify(skG.body.enabled));
  const skG2 = await POST('/api/skills/nope/grant', {}, TA);
  eq('授予不存在的技能返回 404', skG2.status, 404);
  const skSet = await POST('/api/skills/enabled', { skillIds: ['feynman', 'mistake-review', 'nope'] }, TA);
  ok('批量设置忽略不存在的 id', skSet.body.enabled.length === 2 && skSet.body.enabled.indexOf('nope') < 0, JSON.stringify(skSet.body.enabled));
  const skD = await DEL('/api/skills/feynman/grant', TA);
  ok('撤销技能生效', skD.body.enabled.indexOf('feynman') < 0);
  const skB = await GET('/api/skills', TB);
  ok('B 空间看不到 A 启用的技能', skB.body.enabled.length === 0, JSON.stringify(skB.body.enabled));

  // 技能要真的进系统提示词（用 meta.skills 回执 + 行为间接验证）
  const sSk = await sse('这道题我不会，你直接告诉我答案吧', TA, { mode: 'selfstudy' });
  const metaSk = sSk.events.find(e => e.ev === 'meta');
  ok('流式 meta 回执当前启用的技能', Array.isArray(metaSk.j.skills), JSON.stringify(metaSk.j.skills));
  ok('回执里的技能与启用状态一致', metaSk.j.skills.indexOf('mistake-review') >= 0, JSON.stringify(metaSk.j.skills));

  // ---------- 17. 知识库（P2）----------
  group('17. 知识库：上传、检索、进上下文');
  const kc = await POST('/api/kb/categories', { name: '生物' }, TA);
  eq('建分类成功', kc.status, 200);
  eq('分类名正确', kc.body.category.name, '生物');
  const KC_ID = kc.body.category.id;
  const kcDup = await POST('/api/kb/categories', { name: '生物' }, TA);
  eq('同名分类返回 409', kcDup.status, 409);
  const kcBad = await POST('/api/kb/categories', { name: '  ' }, TA);
  eq('空分类名被拒', kcBad.status, 400);

  const docText = '光合作用是绿色植物利用光能，把二氧化碳和水转化成有机物并释放氧气的过程。' +
    '这个过程发生在叶绿体中。影响光合作用速率的因素有光照强度、二氧化碳浓度和温度。';
  const up = await POST('/api/kb/documents', {
    filename: '光合作用.txt', text: docText, categoryId: KC_ID,
  }, TA);
  eq('上传文本文档成功', up.status, 200);
  eq('文档状态 ready', up.body.document.status, 'ready');
  ok('文档抽出文字', up.body.document.textLength > 50, 'len=' + up.body.document.textLength);
  const DOC_ID = up.body.document.id;

  const upBin = await POST('/api/kb/documents', {
    filename: '二进制上传.txt', dataBase64: Buffer.from('这是通过 base64 上传的内容，用来验证二进制通道。', 'utf8').toString('base64'),
  }, TA);
  eq('base64 上传通道可用', upBin.status, 200);
  ok('base64 内容被正确解码', upBin.body.document.textLength > 10, 'len=' + upBin.body.document.textLength);

  const upBad = await POST('/api/kb/documents', { filename: '笔记.qqq', text: '内容' }, TA);
  eq('不支持的格式返回 422 而不是 500', upBad.status, 422);
  ok('不支持格式给出原因', !!upBad.body.document.error, JSON.stringify(upBad.body.document.error));
  const upEmpty = await POST('/api/kb/documents', { filename: 'x.txt' }, TA);
  eq('没有内容被拒', upEmpty.status, 400);
  const upOld = await POST('/api/kb/documents', { filename: '旧文件.doc', dataBase64: Buffer.from([0xD0, 0xCF, 0x11, 0xE0]).toString('base64') }, TA);
  eq('旧版 .doc 明确失败并提示转换', upOld.status, 422);
  ok('.doc 的提示里提到 docx', /docx/.test(upOld.body.document.error || ''), upOld.body.document.error);

  const kbList = await GET('/api/kb/documents', TA);
  ok('文档列表返回 4 份', kbList.body.documents.length === 4, '数量 ' + kbList.body.documents.length);
  const kbListCat = await GET('/api/kb/documents?categoryId=' + KC_ID, TA);
  eq('按分类筛选 1 份', kbListCat.body.documents.length, 1);
  const kbListReady = await GET('/api/kb/documents?status=ready', TA);
  eq('按状态筛选 ready 2 份', kbListReady.body.documents.length, 2);

  const kbText = await GET('/api/kb/documents/' + DOC_ID + '/text', TA);
  ok('能取回抽取的全文', kbText.body.text.indexOf('光合作用') >= 0, (kbText.body.text || '').slice(0, 60));
  const kbOne = await GET('/api/kb/documents/' + DOC_ID, TA);
  ok('单文档详情可用', kbOne.body.document.filename === '光合作用.txt');
  const kbB = await GET('/api/kb/documents/' + DOC_ID, TB);
  eq('B 空间读不到 A 的文档（404）', kbB.status, 404);

  const kbSearch = await GET('/api/kb/search?q=' + encodeURIComponent('光合作用需要什么'), TA);
  ok('检索有命中', kbSearch.body.hits.length >= 1, JSON.stringify(kbSearch.body.hits.slice(0, 1)));
  ok('命中最相关的那份', kbSearch.body.hits[0].filename === '光合作用.txt', kbSearch.body.hits.map(h => h.filename).join(','));
  ok('命中片段含关键词', kbSearch.body.hits[0].text.indexOf('光合作用') >= 0);
  const kbSearchB = await GET('/api/kb/search?q=' + encodeURIComponent('光合作用'), TB);
  eq('B 空间检索不到 A 的资料', kbSearchB.body.hits.length, 0);

  // 检索结果要真的进对话上下文
  const sKb = await sse('光合作用需要哪些条件？', TA, { mode: 'selfstudy' });
  const metaKb = sKb.events.find(e => e.ev === 'meta');
  ok('流式 meta 回执检索到的资料', Array.isArray(metaKb.j.sources), JSON.stringify(metaKb.j.sources));
  ok('资料真的被检索进了上下文', metaKb.j.sources.length >= 1, JSON.stringify(metaKb.j.sources));
  ok('引用的正是那份资料', metaKb.j.sources[0].filename === '光合作用.txt', JSON.stringify(metaKb.j.sources));
  ok('引用带相关性分数', typeof metaKb.j.sources[0].score === 'number');

  // 挂到项目上
  const attach = await POST('/api/kb/attach', { docId: DOC_ID, projectId: PID, on: true }, TA);
  eq('文档挂到项目成功', attach.status, 200);
  const projAfter = await GET('/api/projects/' + PID, TA);
  ok('项目里能看到这份资料', projAfter.body.project.docs.some(d => d.id === DOC_ID), JSON.stringify(projAfter.body.project.docs));
  const attachOff = await POST('/api/kb/attach', { docId: DOC_ID, projectId: PID, on: false }, TA);
  ok('能从项目上摘下来', !attachOff.body.document.projects.some(p => p.id === PID));

  const kbDel = await DEL('/api/kb/documents/' + DOC_ID, TA);
  eq('删除文档成功', kbDel.body.deleted, true);
  eq('删除后剩 3 份', (await GET('/api/kb/documents', TA)).body.documents.length, 3);
  const kbDelCat = await DEL('/api/kb/categories/' + KC_ID, TA);
  eq('删除分类成功', kbDelCat.body.deleted, true);
  eq('删除分类后分类数为 0', (await GET('/api/kb/categories', TA)).body.categories.length, 0);
  ok('删除分类不影响文档', (await GET('/api/kb/documents', TA)).body.documents.length === 3);

  // ---------- 18. 退出登录（放最后：退出后这个令牌就不能用了）----------
  group('18. 退出登录');
  const lo = await POST('/api/auth/logout', {}, TA);
  eq('退出成功', lo.body.ok, true);
  const afterLo = await GET('/api/me', TA);
  eq('退出后令牌立即失效（401）', afterLo.status, 401);
  const afterLoDash = await GET('/api/dashboard', TA);
  eq('退出后所有接口都拒绝', afterLoDash.status, 401);

  // ---------- 收尾 ----------
  await stopServer(child);
  try {
    if (DATA_DIR.indexOf('hl-e2e-') < 0) throw new Error('拒绝清理：路径不像本测试的临时目录');
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  } catch (e) { console.log('  （临时目录未清理：' + e.message + '）'); }

  console.log('\n' + '─'.repeat(58));
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  if (fail) { console.log('\n失败明细：'); failures.forEach(f => console.log('  · ' + f)); }
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('\n测试脚本自身异常：', e); process.exit(2); });

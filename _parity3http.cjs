'use strict';
/**
 * 批次3 · HTTP 端到端自检：知识卡深度。
 * 自带服务进程 + 随机端口 + 临时 DATA_DIR，绝不动开发库。
 * 跑法：node _parity3http.cjs
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const NODE = process.execPath;
const PORT = 3900 + Math.floor(Math.random() * 300);
const BASE = 'http://127.0.0.1:' + PORT;
const DATA_DIR = path.join(os.tmpdir(), 'hl-p3http-' + crypto.randomBytes(4).toString('hex'));

let pass = 0, fail = 0;
const fails = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; fails.push(name + (extra ? ' → ' + JSON.stringify(extra) : '')); console.log('  ✗ ' + name + (extra ? ' → ' + JSON.stringify(extra) : '')); }
}
function group(t) { console.log('\n' + t); }

async function req(method, p, body, token, extraHeaders) {
  const h = { 'Content-Type': 'application/json' };
  if (token) h.Authorization = 'Bearer ' + token;
  Object.assign(h, extraHeaders || {});
  const r = await fetch(BASE + p, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  let j = null; try { j = await r.json(); } catch (e) { j = null; }
  return { status: r.status, body: j };
}
const GET = (p, t) => req('GET', p, undefined, t);
const POST = (p, b, t) => req('POST', p, b, t);
const DEL = (p, t) => req('DELETE', p, undefined, t);
const DAY = 24 * 60 * 60 * 1000;
const sleep = ms => new Promise(r => setTimeout(r, ms));

function startServer() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const child = spawn(NODE, ['server.js'], {
    cwd: __dirname,
    env: Object.assign({}, process.env, {
      PORT: String(PORT), DATA_DIR,
      LLM_API_KEY: '', NO_DOTENV: '1',
      TTS_PROVIDER_URL: '', WEB_SEARCH_URL: '', IMAGE_PROVIDER_URL: '', SMS_PROVIDER_URL: '',
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', d => process.stderr.write('[srv:err] ' + d));
  return child;
}
async function waitReady(ms) {
  const until = Date.now() + (ms || 60000);
  while (Date.now() < until) {
    try { const r = await fetch(BASE + '/api/health'); if (r.ok) return await r.json(); } catch (e) {}
    await sleep(150);
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

(async () => {
  const child = startServer();
  try {
    const health = await waitReady();
    group('A. 健康与版本');
    // ★ 日期不写死：跨天 bump 一次就让 5 个套件同时红，纯属噪声。
    ok('版本是 parity 构建（形如 YYYY-MM-DD-parityN）', /^\d{4}-\d{2}-\d{2}-parity\d+/.test(String(health.version)), health.version);
    ['cards', 'flashcards'].forEach(k => ok('health 报告接口：' + k, Array.isArray(health.apis) && health.apis.indexOf(k) >= 0));

    group('B. 未登录拒绝');
    const guards = [['GET', '/api/cards'], ['POST', '/api/cards'], ['GET', '/api/cards/rules'], ['GET', '/api/cards/eligibility'], ['POST', '/api/cards/suggest'], ['GET', '/api/cards/k_x'], ['DELETE', '/api/cards/k_x'], ['POST', '/api/cards/k_x/review'], ['POST', '/api/cards/k_x/free-practice'], ['POST', '/api/cards/k_x/plan'], ['POST', '/api/cards/k_x/self-known']];
    let gb = [];
    for (const [m, p] of guards) { const r = await req(m, p, m === 'GET' || m === 'DELETE' ? undefined : {}, null); if (r.status !== 401) gb.push(m + ' ' + p + '→' + r.status); }
    ok('全部 ' + guards.length + ' 个卡接口未登录返回 401', gb.length === 0, gb.join(' | '));

    group('C. 建空间');
    const sp = await POST('/api/space', { name: '批次3孩子', password: '' });
    ok('建空间成功', sp.status === 200 && !!sp.body.token);
    const T = sp.body.token;

    group('D. 建卡与状态机对齐');
    const cMake = await POST('/api/cards', { knowledge: '牛顿第二定律', type: 'choice', question: '公式?', answer: 'F=ma', options: { choices: ['F=ma', 'F=mv', 'E=mc²', 'a=F/m'], answerIndex: 0 } }, T);
    ok('建卡成功', cMake.status === 200 && !!cMake.body.card.id);
    const KID = cMake.body.card.id;
    ok('新卡状态 learning / plan scheduled', cMake.body.card.status === 'learning' && cMake.body.card.plan === 'scheduled', cMake.body.card);
    ok('新卡连续计数 0', cMake.body.card.consecutiveRight === 0);

    // 连续答对 5 次 → 已掌握（§5）
    let last;
    for (let i = 0; i < 5; i++) { const r = await POST('/api/cards/' + KID + '/review', { result: 'right', studentAnswer: 'F=ma' }, T); last = r.body; }
    ok('5 次答对后 status=mastered', last.card.status === 'mastered', last.card);
    ok('连续计数 = 5', last.card.consecutiveRight === 5, last.card);
    ok('刚掌握间隔 14 天', last.intervalDays === 14, last.intervalDays);
    // 再核对（对）→ 60 天
    const r6 = await POST('/api/cards/' + KID + '/review', { result: 'right', studentAnswer: '对' }, T);
    ok('已掌握再核对 → 60 天', r6.body.intervalDays === 60, r6.body.intervalDays);
    // 答错 → 退回学习中（§5：第二天）
    const w = await POST('/api/cards/' + KID + '/review', { result: 'wrong', studentAnswer: '错' }, T);
    ok('已掌握答错退回 learning / 计数归零', w.body.card.status === 'learning' && w.body.card.consecutiveRight === 0, w.body.card);
    ok('答错间隔 1 天', w.body.intervalDays === 1, w.body.intervalDays);
    // unknown 不改档
    const u = await POST('/api/cards/' + KID + '/review', { result: 'unknown' }, T);
    ok('unknown 不改档', u.body.card.status === 'learning' && u.body.card.consecutiveRight === 0, u.body.card);
    ok('unknown 文案说明没记为答错', /没有记为答错/.test(u.body.message), u.body.message);

    group('E. 自由练习（不计入复习计划）');
    const fp = await POST('/api/cards/' + KID + '/free-practice', { result: 'right', studentAnswer: '自由练' }, T);
    ok('自由练习标记 free', fp.body.free === true, fp.body);
    ok('自由练习不改状态', fp.body.card.status === 'learning' && fp.body.card.consecutiveRight === 0, fp.body.card);
    ok('自由练习计入 freeCount', fp.body.card.freeCount >= 1, fp.body.card.freeCount);

    group('F. 复习计划管理');
    const tp = await POST('/api/cards/' + KID + '/plan', { when: 'today' }, T);
    ok('今天再练 → 立即到期', tp.body.card.dueAt <= Date.now() + 2000 && tp.body.card.plan === 'scheduled', tp.body.card);
    const tm = await POST('/api/cards/' + KID + '/plan', { when: 'tomorrow' }, T);
    ok('明天再练 → 推后约 1 天', tm.body.card.dueAt >= Date.now() + DAY - 3000 && tm.body.card.dueAt <= Date.now() + DAY + 3000, { due: tm.body.card.dueAt, now: Date.now() });
    const pd = await POST('/api/cards/' + KID + '/plan', { when: 'pending' }, T);
    ok('复习时间待更新 → plan=pending', pd.body.card.plan === 'pending', pd.body.card);
    const pdCard = await GET('/api/cards/' + KID, T);
    ok('pending 卡不算逾期', pdCard.body.card.overdue === false, pdCard.body.card);
    const dueList = await GET('/api/cards?status=due', T);
    ok('到期列表排除 pending 卡', !dueList.body.items.some(it => it.id === KID), dueList.body.total);
    const reset = await POST('/api/cards/' + KID + '/plan', { when: 'reset' }, T);
    ok('reset → scheduled', reset.body.card.plan === 'scheduled');
    const badPlan = await POST('/api/cards/' + KID + '/plan', { when: 'nope' }, T);
    ok('未知 plan 操作 400', badPlan.status === 400, badPlan.status);

    group('G. 规则与额度');
    const rl = await GET('/api/cards/rules', T);
    ok('规则返回标题+要点', rl.status === 200 && rl.body.title && Array.isArray(rl.body.points) && rl.body.points.length >= 4, rl.body);
    ok('规则含 5 次 / 14 天 / 60 天', /5 次/.test(rl.body.points.join('')) && /14 天/.test(rl.body.points.join('')) && /60 天/.test(rl.body.points.join('')), rl.body.points);
    const el = await GET('/api/cards/eligibility', T);
    ok('额度初始可用', el.status === 200 && el.body.eligible === true && el.body.limit > 0 && el.body.used === 0, el.body);
    ok('额度 resetAt 在未来', el.body.resetAt > Date.now(), el.body.resetAt);

    group('H. AI 主动提醒收卡（草稿，不落库）');
    const before = (await GET('/api/cards', T)).body.total;
    const sug = await POST('/api/cards/suggest', { text: '我们学了质数和光合作用', count: 3 }, T);
    ok('suggest 返回 ok 与 drafts 数组（离线模式可能为空）', sug.status === 200 && Array.isArray(sug.body.drafts), sug.body);
    ok('suggest 不自动建卡', (await GET('/api/cards', T)).body.total === before, { before, after: (await GET('/api/cards', T)).body.total });
    // 真正生成（离线模式 LLM 返回空，卡片数为 0，但接口应成功且扣额度）
    const gen = await POST('/api/cards/generate', { text: '我们学了质数', count: 3 }, T);
    ok('generate 接口成功', gen.status === 200 && Array.isArray(gen.body.cards), gen.body);
    ok('离线模式生成 0 张且不报错', gen.body.cards.length === 0, gen.body.cards.length);

    group('I. 提示系统（在线时隐藏泄题；此处验离线降级）');
    const c2 = await POST('/api/cards', { knowledge: '计算 6×7', type: 'choice', question: '6×7=?', answer: '42', options: { choices: ['42', '48', '36', '49'], answerIndex: 0 } }, T);
    const h = await POST('/api/cards/' + c2.body.card.id + '/hint', {}, T);
    ok('提示接口返回 hidden 布尔与 hint 字符串', h.status === 200 && typeof h.body.hidden === 'boolean' && typeof h.body.hint === 'string', h.body);

    group('J. 理解核对（离线判 unknown，不算错）');
    const c3 = await POST('/api/cards', { knowledge: '水的沸点', type: 'understanding', question: '说说沸点', answer: '标准大气压下 100℃' }, T);
    const chk = await POST('/api/cards/' + c3.body.card.id + '/understanding-check', { answer: '水会烧开' }, T);
    ok('理解核对返回 verdict', chk.status === 200 && chk.body.verdict && !!chk.body.verdict.verdict, chk.body);
    const cmp = await POST('/api/cards/' + c3.body.card.id + '/understanding-complete', { answer: '水会烧开', verdict: chk.body.verdict }, T);
    ok('unknown 不算错（状态不变）', cmp.body.card.status === 'learning' && cmp.body.card.consecutiveRight === 0, cmp.body.card);

    group('K. 我已经会了 → 推迟 14 天，可撤销');
    const c4 = await POST('/api/cards', { knowledge: '九九乘法表', type: 'spelling', question: '背一遍', answer: '一一得一' }, T);
    const sk = await POST('/api/cards/' + c4.body.card.id + '/self-known', {}, T);
    ok('self-known → retired', sk.body.card.status === 'retired', sk.body.card);
    ok('self-known 推迟约 14 天', sk.body.card.dueAt > Date.now() + 13 * DAY, { due: sk.body.card.dueAt, now: Date.now() });
    const un = await POST('/api/cards/' + c4.body.card.id + '/undo-self-known', { previous: sk.body.previous }, T);
    ok('撤销 self-known → learning', un.body.card.status === 'learning' && un.body.card.stage === 0, un.body.card);

    group('L. 边界与隔离');
    ok('复习不存在的卡 404', (await POST('/api/cards/k_无/review', { result: 'right' }, T)).status === 404);
    ok('删卡返回 deleted:true', (await DEL('/api/cards/' + KID, T)).body.deleted === true);
    ok('删不存在的卡 deleted:false', (await DEL('/api/cards/k_无', T)).body.deleted === false);
    const sp2 = await POST('/api/space', { name: '另一个孩子', password: '' });
    const T2 = sp2.body.token;
    ok('另一个空间看不到本空间的卡', (await GET('/api/cards', T2)).body.total === 0, (await GET('/api/cards', T2)).body.total);
    ok('另一个空间改不了本空间的卡', (await POST('/api/cards/' + c2.body.card.id + '/review', { result: 'right' }, T2)).status === 404);

    console.log('\nPASS  通过 ' + pass + ' 项，失败 ' + fail + ' 项');
    if (fails.length) { console.log('失败项：'); fails.forEach(f => console.log('  ✗ ' + f)); }
    process.exit(fail ? 1 : 0);
  } catch (e) {
    console.error('测试异常：', e);
    process.exit(2);
  } finally {
    await stopServer(child);
  }
})();

'use strict';
/**
 * 批次10 · HTTP 端到端自检：学习日报。
 *
 * 规矩同 _parity2http.cjs：自带服务进程 + 随机端口 + 临时 DATA_DIR，绝不动开发库。
 * 除了正向通，重点做三件反证：
 *   ① 未登录拿不到日报（日报里全是学习痕迹，不能裸奔）；
 *   ② 跨空间读不到别人的日报与溯源；
 *   ③ 定稿之后不能被草稿改写。
 *
 * 跑法：node _parity10http.cjs
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const NODE = process.execPath;
const PORT = 4100 + Math.floor(Math.random() * 300);
const BASE = 'http://127.0.0.1:' + PORT;
const DATA_DIR = path.join(os.tmpdir(), 'hl-p10http-' + crypto.randomBytes(4).toString('hex'));

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  \u2713 ' + name); }
  else { fail++; failures.push(name + (extra ? ' → ' + (typeof extra === 'string' ? extra : JSON.stringify(extra)) : '')); console.log('  \u2717 ' + name + (extra ? ' → ' + (typeof extra === 'string' ? extra : JSON.stringify(extra)) : '')); }
}
function group(t) { console.log('\n' + t); }

async function req(method, p, body, token) {
  const h = { 'Content-Type': 'application/json' };
  if (token) h.Authorization = 'Bearer ' + token;
  const r = await fetch(BASE + p, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  let j = null;
  try { j = await r.json(); } catch (e) {}
  return { status: r.status, body: j };
}
const GET = (p, t) => req('GET', p, undefined, t);
const POST = (p, b, t) => req('POST', p, b, t);

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
  child.stdout.on('data', d => process.env.VERBOSE && process.stdout.write('[srv] ' + d));
  child.stderr.on('data', d => process.stderr.write('[srv:err] ' + d));
  return child;
}
async function waitReady(ms) {
  const until = Date.now() + (ms || 15000);
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
function todayKey() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

(async () => {
  const srv = startServer();
  let T = '', T2 = '';
  try {
    const health = await waitReady();
    const TODAY = todayKey();

    group('A. 上线可见性');
    ok('健康检查里有 daily 能力', (health.apis || []).indexOf('daily') >= 0, JSON.stringify(health.apis));

    group('B. 未登录拿不到（日报里全是学习痕迹）');
    ok('GET /api/daily 未登录 401', (await GET('/api/daily')).status === 401);
    ok('GET /api/daily/history 未登录 401', (await GET('/api/daily/history')).status === 401);
    ok('POST 草稿未登录 401', (await POST('/api/daily/' + TODAY + '/draft', { answers: {} })).status === 401);
    ok('溯源未登录 401', (await GET('/api/daily/' + TODAY + '/evidence/accuracy')).status === 401);

    group('C. 空空间：不许补零');
    const sp = await POST('/api/space', { name: '日报孩子' + Math.floor(Math.random() * 9000 + 1000), password: '' });
    ok('建空间成功', sp.status === 200 && !!sp.body.token, JSON.stringify(sp.body).slice(0, 120));
    T = sp.body.token;

    let d = await GET('/api/daily', T);
    ok('GET /api/daily 200', d.status === 200, d.status);
    let rep = d.body.report;
    ok('★ hasRecord=false', rep.hasRecord === false);
    ok('★ 空数据下正确率是 null 而不是 0',
      rep.metrics.filter(m => m.key === 'accuracy')[0].value === null,
      rep.metrics.filter(m => m.key === 'accuracy')[0].value);
    ok('★ 空数据下给了"为什么算不出来"的说明',
      (rep.metrics.filter(m => m.key === 'accuracy')[0].unknown || '').length > 5,
      rep.metrics.filter(m => m.key === 'accuracy')[0].unknown);
    ok('四问齐全', rep.questions.length === 4);
    ok('不评分原因齐全', rep.notScored.length >= 4);
    ok('limits 齐全', rep.limits.length >= 3);

    group('D. 造真实数据（走正式接口，不塞库）');
    const c1 = await POST('/api/cards', { knowledge: '勾股定理', question: '直角边 3、4，斜边？', answer: '5', type: 'choice', subject: 'math' }, T);
    ok('建卡成功', c1.status === 200 && !!c1.body.card, JSON.stringify(c1.body).slice(0, 120));
    const cardId = c1.body.card.id;
    const c2 = await POST('/api/cards', { knowledge: '光合作用', question: '产物？', answer: '氧气和有机物', type: 'choice', subject: 'science' }, T);
    const cardId2 = c2.body.card.id;

    ok('第一次复习（错）', (await POST('/api/cards/' + cardId + '/review', { result: 'wrong', studentAnswer: '我以为是 6' }, T)).status === 200);
    ok('第二次复习（错）', (await POST('/api/cards/' + cardId + '/review', { result: 'wrong', studentAnswer: '我这次写 7' }, T)).status === 200);
    ok('第三次复习（说不清）', (await POST('/api/cards/' + cardId2 + '/review', { result: 'unknown', studentAnswer: '我自己也拿不准' }, T)).status === 200);

    d = await GET('/api/daily', T);
    rep = d.body.report;
    ok('★ hasRecord=true', rep.hasRecord === true);
    const m = {};
    rep.metrics.forEach(x => { m[x.key] = x; });
    ok('练卡次数 = 3', m.reviews.value === 3, m.reviews.value);
    ok('★ 正确率 = 0%（分母只算判得出对错的 2 次）', m.accuracy.value === 0, m.accuracy.value);
    ok('没法判断的 = 1', m.unknown.value === 1, m.unknown.value);
    ok('★ 有数字的指标都带 evidence', Object.keys(m).every(k => m[k].value === null || (m[k].evidence && Array.isArray(m[k].evidence.ids))), JSON.stringify(Object.keys(m).map(k => k + ':' + (m[k].evidence ? m[k].evidence.ids.length : 'null'))));
    ok('今天碰过的卡 = 2', m.cards.value === 2, m.cards.value);
    ok('留下的记录 ≥ 5（2 建卡 + 3 复习）', m.records.value >= 5, m.records.value);

    const stateQ = rep.questions.filter(q => q.key === 'state')[0];
    const stateTxt = stateQ.findings.map(f => f.text).join(' ');
    ok('★ state 点名了反复没答对的「勾股定理」', stateTxt.indexOf('勾股定理') >= 0, stateTxt);
    ok('★ state 把"判不了对错"单独说明，不混进对错', stateTxt.indexOf('判不了对错') >= 0, stateTxt);

    group('E. 溯源（点得开，看到原始记录）');
    const ev = await GET('/api/daily/' + TODAY + '/evidence/accuracy', T);
    ok('溯源 200', ev.status === 200, ev.status);
    ok('★ 溯源 2 条（只含判得出对错的）', ev.body.items.length === 2, ev.body.items.length);
    ok('★ 溯源里带学生当时写的原话',
      ev.body.items.some(i => i.detail.indexOf('我以为是 6') >= 0 || i.detail.indexOf('我这次写 7') >= 0),
      ev.body.items.map(i => i.detail));
    ok('★ 溯源里带判定结果', ev.body.items.every(i => i.verdict === '没答对'), ev.body.items.map(i => i.verdict));
    const evAct = await GET('/api/daily/' + TODAY + '/evidence/records', T);
    ok('活动类溯源可用', evAct.body.items.length >= 5, evAct.body.items.length);
    // 用"格式合法但不存在"的名字（指标名都是纯小写字母；`__nope__` 里的下划线
    // 连路由都匹配不上，会走到 404 —— 那测的就不是这个分支了）
    const evBad = await GET('/api/daily/' + TODAY + '/evidence/nosuchmetric', T);
    ok('★ 未知指标返回空列表而不是 500', evBad.status === 200 && evBad.body.items.length === 0, evBad.status + '/' + JSON.stringify(evBad.body).slice(0, 80));
    const evBadFmt = await GET('/api/daily/' + TODAY + '/evidence/__nope__', T);
    ok('格式非法的指标名不会 500（落到 404 即可）', evBadFmt.status === 404, evBadFmt.status);

    group('F. 草稿自动保存');
    const s1 = await POST('/api/daily/' + TODAY + '/draft', { answers: { goal: '想弄明白勾股定理' } }, T);
    ok('存草稿 200', s1.status === 200 && s1.body.report.status === 'draft', JSON.stringify(s1.body).slice(0, 120));
    await POST('/api/daily/' + TODAY + '/draft', { answers: { goal: '想弄明白勾股定理', state: '第三题卡住了' } }, T);
    d = await GET('/api/daily', T);
    ok('★ 刷新后草稿还在（GET 带出已保存的自述）',
      d.body.report.answers.state === '第三题卡住了', JSON.stringify(d.body.report.answers));
    ok('★ 反复存是覆盖不是新增', d.body.report.status === 'draft');

    group('G. 定稿是"当时写的"');
    const fin = await POST('/api/daily/' + TODAY + '/finalize', { answers: { goal: '想弄明白勾股定理', state: '第三题卡住了', process: '先看了例题', adjust: '明天再练 5 张' } }, T);
    ok('定稿 200', fin.status === 200 && fin.body.report.status === 'final', JSON.stringify(fin.body).slice(0, 120));
    await POST('/api/daily/' + TODAY + '/draft', { answers: { goal: '事后改的' } }, T);
    d = await GET('/api/daily', T);
    ok('★ 定稿后再存草稿无效（不能被后来改写）',
      d.body.report.answers.goal === '想弄明白勾股定理' && d.body.report.status === 'final',
      JSON.stringify(d.body.report.answers));

    group('H. 历史');
    const h = await GET('/api/daily/history', T);
    ok('历史 200', h.status === 200, h.status);
    ok('历史里有今天', h.body.days.some(x => x.date === TODAY), JSON.stringify(h.body.days));
    ok('★ 历史带状态与"填了几问"',
      h.body.days[0].status === 'final' && h.body.days[0].filled === 4,
      JSON.stringify(h.body.days[0]));

    group('I. 日期容错');
    const bad = await GET('/api/daily?date=不是日期', T);
    ok('★ 非法日期回退到今天，而不是报错', bad.status === 200 && bad.body.report.date === TODAY, bad.status + '/' + (bad.body.report || {}).date);
    const fut = await GET('/api/daily?date=2020-01-01', T);
    ok('历史日期可查（无记录时如实说没有）', fut.status === 200 && fut.body.report.hasRecord === false, fut.status);

    group('J. 跨空间隔离（反证）');
    const sp2 = await POST('/api/space', { name: '另一个孩子' + Math.floor(Math.random() * 9000 + 1000), password: '' });
    T2 = sp2.body.token;
    const d2 = await GET('/api/daily', T2);
    ok('★ 别的空间看不到我的记录', d2.body.report.hasRecord === false);
    ok('★ 别的空间看不到我的自述', JSON.stringify(d2.body.report.answers) === '{}', JSON.stringify(d2.body.report.answers));
    const ev2 = await GET('/api/daily/' + TODAY + '/evidence/accuracy', T2);
    ok('★ 别的空间溯源取不到我的原话', ev2.body.items.length === 0, ev2.body.items.length);
    const h2 = await GET('/api/daily/history', T2);
    ok('★ 别的空间历史为空', h2.body.days.length === 0, h2.body.days.length);
    // 别人的草稿不该被我覆盖
    await POST('/api/daily/' + TODAY + '/draft', { answers: { goal: '我是另一个孩子' } }, T2);
    d = await GET('/api/daily', T);
    ok('★ 别人写自己的日报，不会覆盖我的', d.body.report.answers.goal === '想弄明白勾股定理', JSON.stringify(d.body.report.answers));

    group('K. 权限与边界');
    const weird = await POST('/api/daily/' + TODAY + '/draft', { answers: { goal: 'x', evil: 'y' } }, T);
    ok('非四问的键被忽略', weird.status === 200 && !('evil' in weird.body.report.answers), JSON.stringify(weird.body.report.answers));

  } catch (e) {
    fail++;
    failures.push('未捕获异常：' + e.message);
    console.error(e.stack);
  } finally {
    await stopServer(srv);
    try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch (e) {}
  }

  console.log('\n' + '─'.repeat(60));
  if (fail) {
    console.log('✗ 通过 ' + pass + ' 项，失败 ' + fail + ' 项');
    failures.forEach(f => console.log('  ✗ ' + f));
  } else {
    console.log('✓ 通过 ' + pass + ' 项，失败 0 项');
  }
  process.exit(fail ? 1 : 0);
})();

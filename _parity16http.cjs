'use strict';
/**
 * 批次16 · HTTP 端到端自检：学习周报。
 *
 * 自带服务进程 + 随机端口 + 临时 DATA_DIR。
 * 重点：范围边界、未登录拦截、跨空间隔离。
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const NODE = process.execPath;
const PORT = 4100 + Math.floor(Math.random() * 300);
const BASE = 'http://127.0.0.1:' + PORT;
const DATA_DIR = path.join(os.tmpdir(), 'hl-p16http-' + crypto.randomBytes(4).toString('hex'));

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  \u2713 ' + name); }
  else { fail++; failures.push(name + (extra ? ' \u2192 ' + (typeof extra === 'string' ? extra : JSON.stringify(extra)) : '')); console.log('  \u2717 ' + name + (extra ? ' \u2192 ' + (typeof extra === 'string' ? extra : JSON.stringify(extra)) : '')); }
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
    ok('健康检查里有 weekly 能力', (health.apis || []).indexOf('weekly') >= 0, JSON.stringify(health.apis));
    ok('版本号带 parity', String(health.version).startsWith('2026-10-02-parity'), health.version);

    group('B. 未登录拿不到');
    ok('GET /api/weekly 未登录 401', (await GET('/api/weekly?from=' + TODAY + '&to=' + TODAY)).status === 401);

    group('C. 空空间结构正确');
    const sp = await POST('/api/space', { name: '周报孩子' + Math.floor(Math.random() * 9000 + 1000), password: '' });
    ok('建空间成功', sp.status === 200 && !!sp.body.token, JSON.stringify(sp.body).slice(0, 120));
    T = sp.body.token;

    let w = await GET('/api/weekly?from=' + TODAY + '&to=' + TODAY, T);
    ok('GET /api/weekly 200', w.status === 200, w.status);
    const rep = w.body.report;
    ok('返回 from/to', rep.from === TODAY && rep.to === TODAY);
    ok('daysCount = 1', rep.daysCount === 1);
    ok('summary.records = 0', rep.summary.records === 0);
    ok('summary.accuracy = null（不是 0）', rep.summary.accuracy === null, rep.summary.accuracy);
    ok('summary.cardsTouched = 0', rep.summary.cardsTouched === 0);
    ok('days 有 1 项', rep.days.length === 1);
    ok('day[0].hasRecord = false', rep.days[0].hasRecord === false);
    ok('notScored 非空', rep.notScored.length >= 3);
    ok('limits 非空', rep.limits.length >= 3);
    ok('coverage.totalCards = 0', rep.coverage.totalCards === 0);

    group('D. 范围边界');
    ok('8 天范围 400', (await GET('/api/weekly?from=2026-01-01&to=2026-01-08', T)).status === 400);
    ok('无效日期 400', (await GET('/api/weekly?from=bad&to=' + TODAY, T)).status === 400);
    ok('to < from 400', (await GET('/api/weekly?from=' + TODAY + '&to=2026-01-01', T)).status === 400);

    group('E. 跨空间隔离');
    const sp2 = await POST('/api/space', { name: '另一个' + Math.floor(Math.random() * 9000 + 1000), password: '' });
    ok('建第二个空间成功', sp2.status === 200 && !!sp2.body.token);
    T2 = sp2.body.token;
    // 在第一个空间建卡并复习
    const c1 = await POST('/api/cards', { knowledge: '测试卡', question: 'q', answer: 'a', type: 'choice', subject: 'math' }, T);
    ok('建卡成功', c1.status === 200 && !!c1.body.card);
    await POST('/api/cards/' + c1.body.card.id + '/review', { result: 'right', studentAnswer: 'a' }, T);
    // 第一个空间能看到 review
    w = await GET('/api/weekly?from=' + TODAY + '&to=' + TODAY, T);
    ok('空间A能看到自己的记录', w.body.report.summary.reviews === 1);
    // 第二个空间看不到
    w = await GET('/api/weekly?from=' + TODAY + '&to=' + TODAY, T2);
    ok('空间B看不到空间A的记录', w.body.report.summary.reviews === 0);

    group('F. 多天范围');
    const yesterday = new Date(); yesterday.setDate(yesterday.getDate() - 1);
    const YESTERDAY = yesterday.getFullYear() + '-' + String(yesterday.getMonth() + 1).padStart(2, '0') + '-' + String(yesterday.getDate()).padStart(2, '0');
    w = await GET('/api/weekly?from=' + YESTERDAY + '&to=' + TODAY, T);
    ok('2 天范围 200', w.status === 200);
    ok('daysCount = 2', w.body.report.daysCount === 2);
    ok('summary.reviews >= 1', w.body.report.summary.reviews >= 1);

  } finally {
    await stopServer(srv);
    try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch (e) {}
  }

  console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  if (fail) {
    failures.forEach(s => console.log('  \u2717 ' + s));
    process.exit(1);
  }
})();

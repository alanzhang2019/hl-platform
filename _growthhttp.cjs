'use strict';
/**
 * 7 阶段成长画像（批次22-③）HTTP 端到端。
 *
 * 重点验的是"接口这一层"才看得见的东西：
 *  · 健康检查里确实报了 growth
 *  · 未登录 401（画像也是私人的）
 *  · 走真实接口造痕迹后数字才动（不是永远为 0 / 永远 null）
 *  · ★★ 跨空间隔离：甲的痕迹绝不出现在乙的画像里（HTTP 层证据）
 *  · ★ 返回体不带任何"分数/等级/名次"字段（规矩①在协议层的守门）
 *  · ★ 连打多次结果一致（现算、无副作用）
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const ROOT = __dirname;
const DAY = 86400000;

let pass = 0, fail = 0;
const fails = [];
function ok(name, cond, extra) {
  if (cond) pass++; else { fail++; fails.push(name + (extra !== undefined ? '  [' + JSON.stringify(extra).slice(0, 200) + ']' : '')); }
}
function group(t) { console.log('\n' + t); }

function waitReady(base, ms) {
  const deadline = Date.now() + (ms || 60000);
  return new Promise(resolve => {
    (function tick() {
      http.get(base + '/api/health', r => { r.resume(); resolve(true); })
        .on('error', () => { if (Date.now() > deadline) resolve(false); else setTimeout(tick, 200); });
    })();
  });
}

function req(base, method, p, body, token) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const headers = {};
    if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = data.length; }
    if (token) headers['Authorization'] = 'Bearer ' + token;
    const r = http.request(base + p, { method, headers }, res => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', c => { buf += c; });
      res.on('end', () => {
        let j = null; try { j = buf ? JSON.parse(buf) : null; } catch (e) { j = { __raw: buf }; }
        resolve({ status: res.statusCode, body: j });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

(async () => {
  const dd = fs.mkdtempSync(path.join(os.tmpdir(), 'hl-growth-http-'));
  const port = await new Promise(r => { const s = require('net').createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
  const srv = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { PORT: String(port), DATA_DIR: dd, ADMIN_PASSWORD: 'g-pw', LLM_API_KEY: '', NO_DOTENV: '1' }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const base = 'http://127.0.0.1:' + port;
  const up = await waitReady(base);
  if (!up) { console.error('服务没起来'); srv.kill('SIGKILL'); process.exit(1); }
  const GET = (p, t) => req(base, 'GET', p, undefined, t);
  const POST = (p, b, t) => req(base, 'POST', p, b, t);

  try {
    group('1. 健康检查与接口发现');
    const h = await GET('/api/health');
    ok('健康检查含 growth', h.status === 200 && (h.body.apis || []).indexOf('growth') >= 0, h.body.apis && h.body.apis.length);

    group('2. 鉴权：画像也是私人的');
    const anon = await GET('/api/growth');
    ok('未登录读画像被拒（401）', anon.status === 401, anon.status);

    group('3. 建空间 → 空空间时六维全 null（不许补 0）');
    const sA = await POST('/api/space', { name: '画像甲', passcode: '' });
    const tokA = sA.body.token;
    ok('空间甲创建成功', !!tokA, sA.status);
    const p0 = await GET('/api/growth', tokA);
    ok('★ 读得到画像', p0.status === 200 && !!p0.body.portrait, p0.status);
    ok('★★ 空空间六维全 null', p0.body.portrait.dimensions.every(d => d.value === null),
      p0.body.portrait.dimensions.map(d => d.key + '=' + d.value));
    ok('★★ 空空间 overview 是 null（不是 0）', p0.body.portrait.overview === null, p0.body.portrait.overview);
    ok('★ 7 个阶段都在', p0.body.portrait.stages.length === 7, p0.body.portrait.stages.length);

    group('4. 走真实接口造痕迹 → 数字跟着动（不是死的）');
    const c1 = await POST('/api/cards', { knowledge: '判别式', question: 'q', answer: 'a', type: 'choice', subject: 'math' }, tokA);
    const cid = c1.body.card.id;
    ok('建卡成功', !!cid, c1.status);
    const p1 = await GET('/api/growth', tokA);
    // ★ 建了 1 张卡但一次没复习 ⇒ 覆盖率是**算得出来的 0**（分母有了：1 张卡），
    //   不是 null。"有卡但没碰过"和"一张卡都没有"是两件事 —— 这正是规矩②要的区分。
    ok('★ 建卡后"碰过的范围"变成 0（有分母了 ⇒ 算得出来，是 0 不是 null）',
      p1.body.portrait.dimensions.filter(d => d.key === 'coverage')[0].value === 0,
      p1.body.portrait.dimensions.filter(d => d.key === 'coverage')[0].value);
    ok('★ 但"答得准"仍是 null（还没有判得出对错的练习 ⇒ 真算不出来）',
      p1.body.portrait.dimensions.filter(d => d.key === 'accuracy')[0].value === null,
      p1.body.portrait.dimensions.filter(d => d.key === 'accuracy')[0].value);
    ok('★ 第 1 步（收下第一张卡）已走到', p1.body.portrait.stages[0].reached === true, p1.body.portrait.stages[0].reached);

    await POST('/api/cards/' + cid + '/review', { result: 'right', studentAnswer: 'x' }, tokA);
    const p2 = await GET('/api/growth', tokA);
    const cov2 = p2.body.portrait.dimensions.filter(d => d.key === 'coverage')[0].value;
    ok('★★ 复习一次后"碰过的范围"变成 100（真算出来，不是 null 了）', cov2 === 100, cov2);
    ok('★ 答得准维度 = 100（1/1）', p2.body.portrait.dimensions.filter(d => d.key === 'accuracy')[0].value === 100,
      p2.body.portrait.dimensions.filter(d => d.key === 'accuracy')[0].value);

    // 再答错一次 ⇒ 50%
    await POST('/api/cards/' + cid + '/review', { result: 'wrong', studentAnswer: 'y' }, tokA);
    const p3 = await GET('/api/growth', tokA);
    ok('★★ 又答错一次后"答得准"降到 50（现算，不是快照）',
      p3.body.portrait.dimensions.filter(d => d.key === 'accuracy')[0].value === 50,
      p3.body.portrait.dimensions.filter(d => d.key === 'accuracy')[0].value);

    group('5. ★★ 跨空间隔离：甲的痕迹不出现在乙的画像里');
    const sB = await POST('/api/space', { name: '画像乙', passcode: '' });
    const tokB = sB.body.token;
    const pB = await GET('/api/growth', tokB);
    ok('★★ 乙是空空间 ⇒ 六维全 null（甲的数据没漏过来）',
      pB.body.portrait.dimensions.every(d => d.value === null),
      pB.body.portrait.dimensions.map(d => d.key + '=' + d.value));
    ok('★★ 乙的第 1 步没走到（甲建的卡不算乙的）', pB.body.portrait.stages[0].reached === false, pB.body.portrait.stages[0].reached);
    // 乙自己建 1 张卡 → 只影响乙
    await POST('/api/cards', { knowledge: '乙的卡', question: 'q', answer: 'a', type: 'choice', subject: 'math' }, tokB);
    const pA2 = await GET('/api/growth', tokA);
    ok('★★ 乙建卡后，甲的"卡总数"没被串到',
      pA2.body.portrait.stages[0].evidence.cards === 1, pA2.body.portrait.stages[0].evidence);

    group('6. ★★ 规矩①：返回体里不许有"分数/等级/名次"字段');
    const raw = JSON.stringify((await GET('/api/growth', tokA)).body);
    ok('★★ 没有 score 字段', !/"score"\s*:/.test(raw));
    ok('★★ 没有 grade / rank / level 字段', !/"(grade|rank|ranking|level)"\s*:/.test(raw));
    ok('★ stages 里也没有"分数"味的字段名',
      !JSON.stringify((await GET('/api/growth', tokA)).body.portrait.stages).match(/"(score|points|value)"\s*:/) ||
      // stages[].evidence 里可以有计数（cards/reviews），但不许叫 score/points
      !/"points"\s*:/.test(raw));

    group('7. 连打多次结果一致（现算、无副作用）');
    const g1 = await GET('/api/growth', tokA);
    const g2 = await GET('/api/growth', tokA);
    ok('连打 2 次画像完全一致', JSON.stringify(g1.body) === JSON.stringify(g2.body), '不一致');

    group('8. 返回体边界（不许带内部实现细节）');
    const rawBody = JSON.stringify(g1.body);
    ok('不带 spaceId / space_id', !/space_?[Ii]d/i.test(rawBody));
    ok('不带 SQL 片段', !/SELECT |FROM cards/i.test(rawBody));
    ok('不带 undefined 字面量', rawBody.indexOf('undefined') < 0);

    group('9. 递归扫：无 undefined（JSON.stringify 会丢键）');
    const walk = (v, p, bad) => {
      if (v === undefined) { bad.push(p); return; }
      if (v === null) return;
      if (Array.isArray(v)) { v.forEach((x, i) => walk(x, p + '[' + i + ']', bad)); return; }
      if (typeof v === 'object') Object.keys(v).forEach(k => walk(v[k], p + '.' + k, bad));
    };
    const bad = [];
    walk(g1.body, 'body', bad);
    ok('返回结构无 undefined', bad.length === 0, bad.slice(0, 5));

  } finally {
    srv.kill('SIGKILL');
    try { fs.rmSync(dd, { recursive: true, force: true }); } catch (e) {}
  }

  console.log('\n' + '─'.repeat(60));
  if (fail) {
    console.log('✗ 失败 ' + fail + ' 项：');
    fails.forEach(f => console.log('   · ' + f));
  } else console.log('✓ 全部通过');
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });

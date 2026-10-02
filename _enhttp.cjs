'use strict';
/**
 * 英语深度：单元四关 + 艾宾浩斯（批次24）HTTP 端到端。
 *
 * 模块级套件已证「函数对不对」，这里只验**接口这一层才看得见**的东西：
 *  · 健康检查里确实报了 english 的新接口
 *  · 未登录 401
 *  · ★★ 空单词本时：四关 pct 全是 null（不是 0）、复习正确率 null（不是 0%）
 *  · ★★ 走真实接口造痕迹后数字才动 —— 且「造句」这一关交卷后数字**不该动**
 *  · ★★ unknown 在 HTTP 层也不写回对错计数（不清零、不推进）
 *  · ★★ 跨空间隔离：拿乙的 wordId 在甲记账必须被挡
 *  · ★ 错误码在 HTTP 层可见（bad gate / 不存在的词 不能被吃成 500）
 *  · 连打多次结果一致（现算、无副作用）
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const ROOT = __dirname;

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
  const dd = fs.mkdtempSync(path.join(os.tmpdir(), 'hl-en-http-'));
  const port = await new Promise(r => { const s = require('net').createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
  const srv = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { PORT: String(port), DATA_DIR: dd, ADMIN_PASSWORD: 'e-pw', LLM_API_KEY: '', NO_DOTENV: '1' }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const base = 'http://127.0.0.1:' + port;
  const up = await waitReady(base);
  if (!up) { console.error('服务没起来'); srv.kill('SIGKILL'); process.exit(1); }
  const GET = (p, t) => req(base, 'GET', p, undefined, t);
  const POST = (p, b, t) => req(base, 'POST', p, b, t);

  try {
    group('1. 健康检查');
    const h = await GET('/api/health');
    ok('健康检查含 english', h.status === 200 && (h.body.apis || []).indexOf('english') >= 0);

    group('2. 鉴权');
    ok('未登录读四关看板被拒（401）', (await GET('/api/english/board')).status === 401);
    ok('未登录读复习队列被拒（401）', (await GET('/api/english/review')).status === 401);
    ok('未登录提交复习被拒（401）', (await POST('/api/english/review', { wordId: 'x', result: 'right' })).status === 401);

    group('3. ★★ 空单词本：算不出来就说算不出来');
    const sA = await POST('/api/space', { name: '英语甲', passcode: '' });
    const tokA = sA.body.token;
    ok('空间甲创建成功', !!tokA, sA.status);

    const b0 = await GET('/api/english/board', tokA);
    ok('空空间读看板 200', b0.status === 200);
    ok('空空间单词数 0', b0.body.totalWords === 0, b0.body.totalWords);
    ok('空空间散词数 0', b0.body.looseCount === 0, b0.body.looseCount);
    ok('空空间没有单元', (b0.body.units || []).length === 0);

    const rv0 = await GET('/api/english/review', tokA);
    ok('空空间复习统计 accuracy 是 null（不是 0%）', rv0.body.stats.accuracy === null, rv0.body.stats.accuracy);
    ok('空空间该复习数是 0（这个 0 是真的 0）', rv0.body.queue.dueCount === 0, rv0.body.queue.dueCount);
    ok('空空间没碰过的词也是 0', rv0.body.stats.neverReviewed === 0, rv0.body.stats.neverReviewed);

    group('4. 建单元 + 导入词 → 四关"有分母但是没有过关的"');
    const u1 = await POST('/api/english/units', { name: 'Unit A' }, tokA);
    ok('建单元成功', !!u1.body.unit && !!u1.body.unit.id, u1.status);
    const uid = u1.body.unit.id;

    const imp = await POST('/api/english/words/import', {
      unitId: uid,
      text: 'apple /ˈæpl/ 苹果\nbanana 香蕉\ncherry 樱桃\nzebra 斑马',
    }, tokA);
    ok('导入 4 个词', imp.body.added === 4, imp.body.added);

    const pr = await GET('/api/english/units/' + encodeURIComponent(uid) + '/progress', tokA);
    ok('读到单元进度', pr.status === 200 && !!pr.body.progress, pr.status);
    const pg = pr.body.progress;
    ok('单元里 4 个词', pg.total === 4, pg.total);
    ok('★★ 有词但没碰过 ⇒ 认这一关 pct 是 0（算得出来的 0，不是 null）', pg.gates[0].pct === 0, pg.gates[0].pct);
    ok('★ 四关都在', pg.gates.length === 4, pg.gates.length);
    ok('★ 下一步指向第一关（认）', pg.nextGate === 'recognize', pg.nextGate);

    // ★★ 关键分界：空单元的 pct 才是 null
    const uEmpty = await POST('/api/english/units', { name: '空单元' }, tokA);
    const prE = await GET('/api/english/units/' + encodeURIComponent(uEmpty.body.unit.id) + '/progress', tokA);
    ok('★★ 空单元四关 pct 全是 null（"没有词可算"和"一个都没过"是两件事）',
      prE.body.progress.gates.every(g => g.pct === null), prE.body.progress.gates.map(g => g.pct));
    ok('★★ 空单元 nextGate 是 null（没有词就没有"下一关"）', prE.body.progress.nextGate === null, prE.body.progress.nextGate);

    const bMiss = await GET('/api/english/units/no_such_unit/progress', tokA);
    ok('不存在的单元 404（不是 500，也不是空对象）', bMiss.status === 404, bMiss.status);

    group('5. ★★ 关卡出题：答案不下发 + 乱写的关卡名有明确错误码');
    const g1 = await GET('/api/english/gate?gate=recognize&unitId=' + encodeURIComponent(uid), tokA);
    ok('认这一关出题 200', g1.status === 200 && g1.body.items.length === 4, g1.status);
    ok('★★ 认这一关选项里没有 ok 标记（答案不下发）',
      g1.body.items.every(it => (it.choices || []).every(c => typeof c === 'string')));
    ok('★ 认这一关的标题也是词本身（可朗读）', g1.body.items.every(it => !!it.prompt));
    ok('★ 背这一关不下发答案（prompt 是中文）',
      (await GET('/api/english/gate?gate=recall&unitId=' + encodeURIComponent(uid), tokA)).body.items.every(it => !/^(apple|banana|cherry|zebra)$/.test(it.prompt)));
    const gBad = await GET('/api/english/gate?gate=nope', tokA);
    ok('★ 乱写的关卡名 → 400 且错误码可见', gBad.status === 400 && gBad.body.code === 'BAD_INPUT', [gBad.status, gBad.body && gBad.body.code]);
    ok('★ 乱写的关卡名不是 500', gBad.status !== 500);

    group('6. ★★★ 规矩：造句这一关交卷后数字不该动（它不判对错）');
    const bList = await GET('/api/english/words?unitId=' + encodeURIComponent(uid), tokA);
    const wid = bList.body.words[0].id;
    const before = await GET('/api/english/words?unitId=' + encodeURIComponent(uid), tokA);
    const beforeCounts = before.body.words.map(w => w.rightCount + '/' + w.wrongCount).join(',');

    const gu = await POST('/api/english/gate/grade', {
      gate: 'use', items: [{ id: wid, answer: 'I would like an apple please.' }],
    }, tokA);
    ok('造句交卷 200', gu.status === 200, gu.status);
    ok('★★ 造句的 accuracy 是 null（不是 0，也不是 100）', gu.body.accuracy === null, gu.body.accuracy);
    ok('★★ 造句的 right 是 null', gu.body.right === null, gu.body.right);
    ok('★★ 造句的 wrong 是 null', gu.body.wrong === null, gu.body.wrong);
    ok('★ 明确标出不判分', gu.body.scored === false, gu.body.scored);
    ok('★ 返回体里没有分数/等级字段', !('score' in gu.body) && !('grade' in gu.body) && !('points' in gu.body));
    ok('★ 用上了词 ⇒ used = true', gu.body.results[0].used === true, gu.body.results[0].used);

    const after = await GET('/api/english/words?unitId=' + encodeURIComponent(uid), tokA);
    ok('★★★ 造句交卷后对错计数一个都没变（不记账就不该有数）',
      after.body.words.map(w => w.rightCount + '/' + w.wrongCount).join(',') === beforeCounts,
      [beforeCounts, after.body.words.map(w => w.rightCount + '/' + w.wrongCount).join(',')]);

    group('7. ★★ 认这一关判对错，且错词不转拼写卡（还没认脸熟）');
    const allW = await GET('/api/english/words?unitId=' + encodeURIComponent(uid), tokA);
    const target = allW.body.words.filter(w => w.word === 'apple')[0];
    const gr = await POST('/api/english/gate/grade', {
      gate: 'recognize', items: [{ id: target.id, answer: '苹果' }], createCards: true,
    }, tokA);
    ok('认对了 ⇒ accuracy 100', gr.body.accuracy === 100, gr.body.accuracy);
    ok('★ 认对了 right 是数不是 null', typeof gr.body.right === 'number', gr.body.right);

    const grW = await POST('/api/english/gate/grade', {
      gate: 'recognize', items: [{ id: target.id, answer: '错的' }], createCards: true,
    }, tokA);
    ok('★ 认错了 cardsCreated = 0（不转拼写卡）', grW.body.cardsCreated === 0, grW.body.cardsCreated);

    group('8. ★★ 背这一关答错才转拼写卡');
    const grB = await POST('/api/english/gate/grade', {
      gate: 'recall', items: [{ id: target.id, answer: 'appl' }], createCards: true,
    }, tokA);
    ok('★ 背错了 cardsCreated ≥ 1', grB.body.cardsCreated >= 1, grB.body.cardsCreated);
    ok('★ 错词给出了"差在哪"的提示', !!(grB.body.results[0].diff && grB.body.results[0].diff.message), grB.body.results[0].diff);
    ok('★ 错词列表带中文意思（好复习）', !!grB.body.wrongWords[0].meaning, grB.body.wrongWords[0]);

    group('9. ★★★ 艾宾浩斯：记一次复习才推进；unknown 在 HTTP 层也不动计数');
    const c0 = (await GET('/api/english/words?unitId=' + encodeURIComponent(uid), tokA)).body.words.filter(w => w.id === target.id)[0];
    const snap0 = c0.rightCount + '/' + c0.wrongCount;

    const w1 = await POST('/api/english/review', { wordId: target.id, gate: 'recall', result: 'right' }, tokA);
    ok('记一次复习 200', w1.status === 200, w1.status);
    ok('★ 答对后下次 1 天后再看', w1.body.dueInDays === 1, w1.body.dueInDays);
    const c1 = (await GET('/api/english/words?unitId=' + encodeURIComponent(uid), tokA)).body.words.filter(w => w.id === target.id)[0];
    ok('★ 复习真的写回了计数（HTTP 层看得见）', c1.rightCount + '/' + c1.wrongCount !== snap0, [snap0, c1.rightCount + '/' + c1.wrongCount]);

    const snap1 = c1.rightCount + '/' + c1.wrongCount;
    const wu = await POST('/api/english/review', { wordId: target.id, gate: 'recall', result: 'unknown' }, tokA);
    ok('★★ unknown 之后连对数不变', wu.body.consecutive === w1.body.consecutive, [wu.body.consecutive, w1.body.consecutive]);
    ok('★ unknown 给了说明文案', /进度不动/.test(wu.body.note || ''), wu.body.note);
    const c2 = (await GET('/api/english/words?unitId=' + encodeURIComponent(uid), tokA)).body.words.filter(w => w.id === target.id)[0];
    ok('★★★ unknown 不写回对错计数（HTTP 层证据）', c2.rightCount + '/' + c2.wrongCount === snap1, [snap1, c2.rightCount + '/' + c2.wrongCount]);

    // 乱写的结果码退化成 unknown，不许当对
    const wBad = await POST('/api/english/review', { wordId: target.id, gate: 'recall', result: 'banana' }, tokA);
    ok('★ 乱写的结果码退化成 unknown（不默认算对）', wBad.body.result === 'unknown', wBad.body.result);

    const wMiss = await POST('/api/english/review', { wordId: 'nope', gate: 'recall', result: 'right' }, tokA);
    ok('★ 不存在的词 → 404 且错误码可见', wMiss.status === 404 && wMiss.body.code === 'NOT_FOUND', [wMiss.status, wMiss.body && wMiss.body.code]);

    group('10. ★★ 复习队列：新词不算"到期"');
    const rq = await GET('/api/english/review?unitId=' + encodeURIComponent(uid), tokA);
    ok('★★ 队列里能读到', rq.status === 200);
    ok('★★ 该复习数是 0（都还没到期）', rq.body.queue.dueCount === 0, rq.body.queue.dueCount);
    ok('★★ 新词单独报（还有 3 个从没碰过）', rq.body.queue.freshCount === 3, rq.body.queue.freshCount);
    ok('★★ 新词不计入"该复习"', rq.body.queue.items.length === 0, rq.body.queue.items.length);
    ok('★ 明说了新词与到期是两件事', /新词和到期复习是两件事/.test(rq.body.queue.note || ''), rq.body.queue.note);
    ok('★ 统计里 reviewed 是 1 个', rq.body.stats.reviewed === 1, rq.body.stats.reviewed);
    ok('★ 统计里 neverReviewed 是 3 个', rq.body.stats.neverReviewed === 3, rq.body.stats.neverReviewed);
    // ★ apple 被答错/答对过多次：判得出对错的次数 > 0 ⇒ accuracy 是数不是 null
    ok('★★ 有判过对错的词 ⇒ accuracy 是数（不是 null）', typeof rq.body.stats.accuracy === 'number', rq.body.stats.accuracy);
    ok('★ 报了平均间隔', typeof rq.body.stats.avgIntervalDays === 'number', rq.body.stats.avgIntervalDays);

    group('11. ★★ 跨空间隔离');
    const sB = await POST('/api/space', { name: '英语乙', passcode: '' });
    const tokB = sB.body.token;
    const bB = await GET('/api/english/board', tokB);
    ok('★★ 乙空间单词数是 0（甲的 4 个词没漏过来）', bB.body.totalWords === 0, bB.body.totalWords);
    ok('★★ 乙空间没有甲的单元', (bB.body.units || []).length === 0);
    const rqB = await GET('/api/english/review', tokB);
    ok('★★ 乙的复习队列是空的', rqB.body.queue.dueCount === 0 && rqB.body.queue.freshCount === 0, rqB.body.queue);
    ok('★★ 乙读甲的单元 → 404', (await GET('/api/english/units/' + encodeURIComponent(uid) + '/progress', tokB)).status === 404);
    // ★★ 拿甲的 wordId 在乙空间记账 ⇒ 必须被挡
    const cross = await POST('/api/english/review', { wordId: target.id, gate: 'recall', result: 'right' }, tokB);
    ok('★★★ 拿甲的 wordId 在乙空间记账 ⇒ 被挡（404 NOT_FOUND）', cross.status === 404 && cross.body.code === 'NOT_FOUND', [cross.status, cross.body && cross.body.code]);
    const afterCross = await GET('/api/english/review?unitId=' + encodeURIComponent(uid), tokA);
    ok('★★ 被挡之后甲的统计没被污染', afterCross.body.stats.reviewed === 1, afterCross.body.stats.reviewed);

    group('12. 连打一致性 + 返回体干净');
    const p1 = await GET('/api/english/board', tokA);
    const p2 = await GET('/api/english/board', tokA);
    ok('★ 连打两次看板结果一致（现算、无副作用）',
      JSON.stringify(p1.body) === JSON.stringify(p2.body));
    const r1 = await GET('/api/english/review?unitId=' + encodeURIComponent(uid), tokA);
    const r2 = await GET('/api/english/review?unitId=' + encodeURIComponent(uid), tokA);
    // ★ 剥掉 queue.now 再比：它是"服务端此刻"，两次调用必然差几毫秒 ——
    //   这不是副作用（时间在走），但它会让"整个 JSON 相同"这种断言永远为假。
    //   要比的是**业务数据**（队列内容与统计），不是时间戳。
    const stripNow = (b) => { const c = JSON.parse(JSON.stringify(b)); if (c.queue) delete c.queue.now; return JSON.stringify(c); };
    ok('★ 连打两次复习统计业务数据一致（时间戳除外）', stripNow(r1.body) === stripNow(r2.body), [stripNow(r1.body), stripNow(r2.body)]);
    ok('★ 两次的 dueCount/freshCount 一致',
      r1.body.queue.dueCount === r2.body.queue.dueCount && r1.body.queue.freshCount === r2.body.queue.freshCount);
    ok('★ 两次的 accuracy 一致', r1.body.stats.accuracy === r2.body.stats.accuracy);

    function walk(v, at, out) {
      if (v === undefined) { out.push(at); return; }
      if (v === null) return;
      if (Array.isArray(v)) { v.forEach((x, i) => walk(x, at + '[' + i + ']', out)); return; }
      if (typeof v === 'object') { Object.keys(v).forEach(k => walk(v[k], at + '.' + k, out)); }
    }
    const bad = [];
    walk({ board: p1.body, rv: r1.body, use: gu.body }, 'body', bad);
    ok('★ 返回结构无 undefined', bad.length === 0, bad.slice(0, 5));
    const raw = JSON.stringify({ board: p1.body, rv: r1.body });
    ok('★ 返回体不带 space_id / SQL 片段', !/space_id|SELECT |INSERT /.test(raw));

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

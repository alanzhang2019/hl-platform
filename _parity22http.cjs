'use strict';
/**
 * 批次22 端到端自检（HTTP）：历史周报
 *
 * 模块级套件（`_parity22check.cjs`）把**存取与算法的语义**测透了。
 * 这一套测的是**只有真起服务才暴露得出来的东西**：
 *
 *   1. **路由没接上 / 方法不对** —— 函数好好的，前端点进去 404 或 405。
 *   2. **鉴权没生效** —— 周报里写的是私人的话，绝不能匿名拿到。
 *   3. **错误码被吃成 500** —— 模块抛 `range_too_long`，路由统一回 500，
 *      前端就没法据此提示"把范围收窄一点"。
 *   4. **跨空间只在真实 token 下才测得出** —— 用两个真实空间互相读**对方写的话**。
 *   5. **写接口的可写性边界** —— 定稿后 POST 应当"成功但不改内容"（幂等拒绝），
 *      而不是报 500；这是前端敢不敢用它的前提。
 *
 * 跑法：node _parity22http.cjs
 */
const cp = require('child_process');
const { spawn } = cp;
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const NODE = process.execPath;
const PORT = 3900 + Math.floor(Math.random() * 300);
const BASE = 'http://127.0.0.1:' + PORT;
const DATA_DIR = path.join(os.tmpdir(), 'hl-weekly-http-' + crypto.randomBytes(4).toString('hex'));

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  \u2713 ' + name); }
  else { fail++; failures.push(name + (extra !== undefined ? ' → ' + JSON.stringify(extra) : '')); console.log('  \u2717 ' + name + (extra !== undefined ? ' → ' + JSON.stringify(extra) : '')); }
}
function eq(name, got, want) { ok(name, JSON.stringify(got) === JSON.stringify(want), 'got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want)); }
function group(t) { console.log('\n' + t); }

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

function startServer() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  return spawn(NODE, ['server.js'], {
    cwd: __dirname,
    env: Object.assign({}, process.env, {
      PORT: String(PORT), DATA_DIR, NO_DOTENV: '1',
      ADMIN_PASSWORD: 'test-admin-pw', LLM_API_KEY: '',
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}
async function waitReady(ms) {
  // ★ 60 秒：本机 C 盘紧张，光 SQLite 初始化就可能十几秒。
  const until = Date.now() + (ms || 60000);
  while (Date.now() < until) {
    try { const r = await fetch(BASE + '/api/health'); if (r.ok) return await r.json(); } catch (e) {}
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error('服务在超时前没有就绪');
}
function stopServer(child) {
  return new Promise(res => {
    child.once('exit', res);
    try { child.kill('SIGKILL'); } catch (e) { res(); }
    setTimeout(res, 2500);
  });
}

function dayOff(n) {
  const d = new Date(Date.now() + n * 86400000);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
// ★★ 区间必须**整体落在过去**，不能让 `to === 今天`。
//   因为 history() 有一条刻意的规矩：**「以前的周报」不许出现当前这一周**
//   （`week_to < 今天` 才算"以前"）。若这里用 dayOff(0) 当 to，
//   那么这条周记会被 history 正确地排除掉，测试就会误以为"功能坏了"。
//   取 上周 到 上周四 这段（-13 … -7），保证它一定已经是"过去"。
const FROM = dayOff(-13), TO = dayOff(-7);
const TODAY = dayOff(0);

/**
 * ★ 把"刚发生"的复习时间挪进目标区间（上周）。
 * 目的：history 里的数字是**按 reviewed_at 落在哪一天**现算的。
 * 刚建的复习时间戳是 now ⇒ 落在今天 ⇒ 不会被算进上周。
 * 要验"现算"，原始记录就必须真的落在那个区间里 —— 这里直接改库（服务在用这个库，
 * 所以起一个独立 node 进程去改，避免与本进程的连接打架）。
 */
function backdateReviews(from, to) {
  const mid = Math.floor((new Date(from + 'T12:00:00').getTime() + new Date(to + 'T12:00:00').getTime()) / 2);
  const code = `
    const p = require('path');
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(p.join(${JSON.stringify(DATA_DIR)}, 'app.db'));
    db.prepare('UPDATE card_reviews SET reviewed_at = ?').run(${mid});
    db.close();
  `;
  try { cp.execFileSync(process.execPath, ['-e', code], { stdio: 'ignore' }); } catch (e) {}
}

// ================= 主流程 =================
(async () => {
  const child = startServer();
  let health;
  try { health = await waitReady(); }
  catch (e) { console.error(e.message); child.kill('SIGKILL'); process.exit(1); }

  console.log('历史周报 · 端到端自检');
  console.log('  服务 ' + BASE + '   数据目录 ' + DATA_DIR);

  try {
    // ---------- 1. 健康检查 ----------
    group('1. 健康检查与接口发现');
    ok('health.ok', health.ok === true);
    ok('★ apis 清单里有 weekly（历史周报挂在它下面）',
      (health.apis || []).indexOf('weekly') >= 0, health.apis);
    ok('版本是带日期的串', /^\d{4}-\d{2}-\d{2}-/.test(String(health.version)), health.version);

    // ---------- 2. 建两个真实空间 ----------
    group('2. 建两个真实空间（用于隔离验证）');
    const a = await POST('/api/space', { name: '周报测试甲', passcode: '' });
    eq('甲空间创建成功', a.status, 200);
    const tokA = a.body.token;
    const b = await POST('/api/space', { name: '周报测试乙', passcode: '' });
    eq('乙空间创建成功', b.status, 200);
    const tokB = b.body.token;
    ok('两个 token 都有', !!tokA && !!tokB);

    // ---------- 3. 鉴权 ----------
    group('3. 鉴权（周报里是私人的话，不许匿名读）');
    const noTok = await GET('/api/weekly/note?from=' + FROM + '&to=' + TO);
    ok('不带 token 读 note 拿不到', noTok.status !== 200, noTok.status);
    const noTokHist = await GET('/api/weekly/history');
    ok('不带 token 读 history 拿不到', noTokHist.status !== 200, noTokHist.status);
    const noTokPost = await POST('/api/weekly/note/' + FROM + '/' + TO, { answers: { noticed: '偷偷写' } });
    ok('不带 token 写 note 拿不到', noTokPost.status !== 200, noTokPost.status);
    const badTok = await GET('/api/weekly/note?from=' + FROM + '&to=' + TO, 'garbage');
    ok('假 token 拿不到', badTok.status !== 200, badTok.status);

    // 确认"偷偷写"真的没落下去
    const afterNoTok = await GET('/api/weekly/history', tokA);
    eq('★ 匿名写的没落进任何人的历史', (afterNoTok.body.weeks || []).length, 0);

    // ---------- 4. 空空间 ----------
    group('4. 空空间：没写过就是 null，不是空对象');
    const nEmpty = await GET('/api/weekly/note?from=' + FROM + '&to=' + TO, tokA);
    eq('空空间读 note → 200', nEmpty.status, 200);
    eq('★ 没写过返回 note: null（不是 {}）', nEmpty.body.note, null);
    const hEmpty = await GET('/api/weekly/history', tokA);
    eq('空空间读 history → 200', hEmpty.status, 200);
    ok('空空间历史是空数组（不是 null）', Array.isArray(hEmpty.body.weeks) && hEmpty.body.weeks.length === 0, hEmpty.body.weeks);

    // ---------- 5. 写 → 读 ----------
    group('5. 写草稿 → 读回来（走真实 HTTP）');
    const w1 = await POST('/api/weekly/note/' + FROM + '/' + TO,
      { answers: { noticed: '周五我发现错题重做一遍就好了', next: '下周每天留十分钟重做' } }, tokA);
    eq('写草稿 → 200', w1.status, 200);
    ok('返回体带 note', !!w1.body.note, Object.keys(w1.body || {}));
    eq('草稿状态是 draft', w1.body.note.status, 'draft');
    ok('内容原样存下', w1.body.note.answers.noticed === '周五我发现错题重做一遍就好了', w1.body.note.answers);

    const w2 = await GET('/api/weekly/note?from=' + FROM + '&to=' + TO, tokA);
    ok('读回来内容一致', w2.body.note.answers.noticed === '周五我发现错题重做一遍就好了', w2.body.note.answers);
    eq('读回来状态仍是 draft', w2.body.note.status, 'draft');

    // 覆盖草稿
    const w3 = await POST('/api/weekly/note/' + FROM + '/' + TO, { answers: { noticed: '改过的说法', next: '' } }, tokA);
    ok('未定稿时草稿能覆盖', w3.body.note.answers.noticed === '改过的说法', w3.body.note.answers.noticed);

    // ---------- 6. 造学习痕迹，验历史里的数字是现算的 ----------
    group('6. 历史里的数字必须现算（改原始记录 → 数字跟着变）');
    const c1 = await POST('/api/cards', {
      knowledge: '周报现算用知识点', question: '1+1=?', answer: '2',
      type: 'choice', subject: 'math', options: ['2', '3'],
    }, tokA);
    ok('建卡接口可用', c1.status === 200, c1.body);
    const cardId = c1.body && (c1.body.card && c1.body.card.id || c1.body.id);
    if (cardId) {
      const rev = await POST('/api/cards/' + cardId + '/review', { result: 'right', studentAnswer: '2' }, tokA);
      ok('复习接口可用', rev.status === 200, rev.body);
      // ★★ 刚复习的那条 `reviewed_at` 是"现在" —— 落在今天，不属于我们要验的那个过去区间。
      //    要证明"历史里的数字是现算的"，得让原始记录真的落进那个区间里。
      //    这里直接改库把复习时间挪进上周（模拟"上周真的练过"）。
      backdateReviews(FROM, TO);
    }

    const h1 = await GET('/api/weekly/history', tokA);
    ok('历史里出现了写过的这一条', (h1.body.weeks || []).some(w => w.from === FROM && w.to === TO),
      (h1.body.weeks || []).map(w => w.from + '~' + w.to));
    const wk1 = (h1.body.weeks || []).find(w => w.from === FROM && w.to === TO) || {};
    // ★ 这一条的数据来自刚才那次真实复习 —— 说明它是现算的，不是从表里读的
    ok('★ 历史条目的 reviews ≥ 1（来自刚才的真实复习）', wk1.reviews >= 1, wk1.reviews);
    ok('历史条目带 from/to', wk1.from === FROM && wk1.to === TO, [wk1.from, wk1.to]);
    ok('历史条目带人写的那段', wk1.answers.noticed === '改过的说法', wk1.answers.noticed);

    // 再复习一次"错"，数字应当跟着变 —— 这是"现算"在 HTTP 层的证据
    if (cardId) {
      const rev2 = await POST('/api/cards/' + cardId + '/review', { result: 'wrong', studentAnswer: 'x' }, tokA);
      ok('第二次复习（故意答错）接口可用', rev2.status === 200, rev2.body);
      backdateReviews(FROM, TO);   // 同样挪进上周，否则今天这条不算在上周里
    }
    const h2 = await GET('/api/weekly/history', tokA);
    const wk2 = (h2.body.weeks || []).find(w => w.from === FROM && w.to === TO) || {};
    ok('★★ 再复习一次后 history 里的 reviews 跟着变了（证明现算）',
      wk2.reviews > wk1.reviews, { before: wk1.reviews, after: wk2.reviews });
    ok('★★ 且与当场 /api/weekly 的 summary.reviews 一致',
      (await GET('/api/weekly?from=' + FROM + '&to=' + TO, tokA)).body.report.summary.reviews === wk2.reviews,
      wk2.reviews);

    // ★★ history 的数字必须**每次现算**，不能是写稿那一刻的快照。
    //    证据：把那次复习改成"错"，history 里的 accuracy 必须跟着从 100% 掉下来。
    //    这条是模块级 E2 的 HTTP 版 —— 没有它，"history 改用快照"的 bug 能全绿蒙过去。
    const hBefore = (await GET('/api/weekly/history', tokA)).body.weeks.find(w => w.from === FROM && w.to === TO) || {};
    if (cardId) {
      await POST('/api/cards/' + cardId + '/review', { result: 'wrong', studentAnswer: '还是错' }, tokA);
      backdateReviews(FROM, TO);
    }
    const hAfter = (await GET('/api/weekly/history', tokA)).body.weeks.find(w => w.from === FROM && w.to === TO) || {};
    ok('★★ 又答错一次后 accuracy 跟着降（history 不是快照）',
      hAfter.accuracy !== null && hBefore.accuracy !== null && hAfter.accuracy < hBefore.accuracy,
      { before: hBefore.accuracy, after: hAfter.accuracy });

    // ---------- 7. 定稿 ----------
    group('7. 定稿 = 冻结（HTTP 层）');
    const fin = await POST('/api/weekly/note/' + FROM + '/' + TO,
      { answers: { noticed: '定稿时的说法', next: '下周的事' }, finalize: true }, tokA);
    eq('定稿 → 200', fin.status, 200);
    eq('★ 状态变 final', fin.body.note.status, 'final');
    ok('定稿带 finalizedAt', typeof fin.body.note.finalizedAt === 'number' && fin.body.note.finalizedAt > 0, fin.body.note.finalizedAt);

    const afterFin = await POST('/api/weekly/note/' + FROM + '/' + TO,
      { answers: { noticed: '我不该能改它', next: 'x' } }, tokA);
    // ★ 这里刻意要求 **200 而不是 4xx**：前端"先存着"按钮不该因为稿子已定稿而报错，
    //   它应当是"成功但没改"（幂等拒绝）。报 500 会让用户以为稿子丢了。
    eq('定稿后再存草稿仍是 200（幂等拒绝，不是报错）', afterFin.status, 200);
    ok('★★ 定稿后内容没有被改写', afterFin.body.note.answers.noticed === '定稿时的说法', afterFin.body.note.answers.noticed);
    eq('定稿后状态仍是 final', afterFin.body.note.status, 'final');

    // ---------- 8. 溯源 ----------
    group('8. 数字逐项溯源（HTTP 层）');
    const rpt = await GET('/api/weekly?from=' + FROM + '&to=' + TO, tokA);
    const sum = rpt.body.report.summary;

    const evR = await GET('/api/weekly/evidence?from=' + FROM + '&to=' + TO + '&metric=reviews', tokA);
    eq('溯源 reviews → 200', evR.status, 200);
    eq('★ 溯源条数 === summary.reviews', evR.body.count, sum.reviews);
    ok('每条溯源带 date', (evR.body.items || []).every(x => /^\d{4}-\d{2}-\d{2}$/.test(x.date)), (evR.body.items || []).slice(0, 1));
    ok('每条溯源带原始 id', (evR.body.items || []).every(x => !!x.id), (evR.body.items || []).slice(0, 1));

    const evA = await GET('/api/weekly/evidence?from=' + FROM + '&to=' + TO + '&metric=accuracy', tokA);
    eq('★ accuracy 溯源条数 === right + wrong（unknown 不计入分母）',
      evA.body.count, sum.right + sum.wrong);

    const evC = await GET('/api/weekly/evidence?from=' + FROM + '&to=' + TO + '&metric=cards', tokA);
    eq('★ cards 溯源条数 === summary.cardsTouched', evC.body.count, sum.cardsTouched);

    const evBad = await GET('/api/weekly/evidence?from=' + FROM + '&to=' + TO + '&metric=nonsense', tokA);
    eq('未知 metric → 400', evBad.status, 400);
    eq('★ 错误码是 unknown_metric（不是笼统 500）', evBad.body.error, 'unknown_metric');

    // ---------- 9. 跨空间隔离（真 token 互读） ----------
    group('9. 跨空间隔离（真 token 互读"对方写的话"）');
    const bWrite = await POST('/api/weekly/note/' + FROM + '/' + TO,
      { answers: { noticed: '我是乙写的感想', next: '乙的下周' }, finalize: true }, tokB);
    eq('乙也写一条（同区间）→ 200', bWrite.status, 200);

    const aNote = await GET('/api/weekly/note?from=' + FROM + '&to=' + TO, tokA);
    const bNote = await GET('/api/weekly/note?from=' + FROM + '&to=' + TO, tokB);
    ok('★★ 甲读到的是甲写的', aNote.body.note.answers.noticed === '定稿时的说法', aNote.body.note.answers.noticed);
    ok('★★ 乙读到的是乙写的', bNote.body.note.answers.noticed === '我是乙写的感想', bNote.body.note.answers.noticed);

    const aHist = await GET('/api/weekly/history', tokA);
    ok('★ 甲的历史里没有乙写的感想（乙那条不出现）',
      !aHist.body.weeks.some(w => (w.answers || {}).noticed === '我是乙写的感想'),
      aHist.body.weeks.map(w => (w.answers || {}).noticed));
    ok('★ 甲的历史条目全部是甲写的',
      aHist.body.weeks.every(w => (w.answers || {}).noticed !== '我是乙写的感想'),
      aHist.body.weeks.map(w => (w.answers || {}).noticed));

    const bHist = await GET('/api/weekly/history', tokB);
    ok('★ 乙的历史里只有它自己那条',
      bHist.body.weeks.length >= 1 && bHist.body.weeks.every(w => w.from === FROM && w.to === TO),
      bHist.body.weeks.map(w => w.from + '~' + w.to));
    ok('★ 乙的历史里就是乙写的感想',
      bHist.body.weeks.some(w => (w.answers || {}).noticed === '我是乙写的感想'),
      bHist.body.weeks.map(w => (w.answers || {}).noticed));

    // 乙的溯源不该看到甲的卡
    const bEv = await GET('/api/weekly/evidence?from=' + FROM + '&to=' + TO + '&metric=reviews', tokB);
    eq('★ 乙的溯源里没有甲的复习（count = 0）', bEv.body.count, 0);

    // ---------- 10. 错误码与边界 ----------
    group('10. 错误码在 HTTP 层可见（前端要靠它给提示）');
    const badDate = await GET('/api/weekly/note?from=notadate&to=' + TO, tokA);
    eq('非法日期 → 400', badDate.status, 400);
    eq('★ 错误码是 invalid_range', badDate.body.error, 'invalid_range');

    const reversed = await GET('/api/weekly/note?from=' + TO + '&to=' + FROM, tokA);
    eq('结束早于开始 → 400', reversed.status, 400);
    eq('错误码 invalid_range', reversed.body.error, 'invalid_range');

    const tooLong = await GET('/api/weekly/note?from=' + dayOff(-20) + '&to=' + dayOff(0), tokA);
    eq('超过 7 天 → 400', tooLong.status, 400);
    eq('★ 错误码是 range_too_long（不是笼统 500）', tooLong.body.error, 'range_too_long');

    // 写接口同样校验，且不能被吃成 500
    const tooLongWrite = await POST('/api/weekly/note/' + dayOff(-20) + '/' + TO, { answers: { noticed: 'x' } }, tokA);
    eq('超范围的写 → 400', tooLongWrite.status, 400);
    eq('★ 写接口的错码也是 range_too_long', tooLongWrite.body.error, 'range_too_long');

    // 恰好 7 天必须通过（边界不能少一天也不能多一天）
    const exact7 = await GET('/api/weekly/note?from=' + dayOff(-6) + '&to=' + dayOff(0), tokA);
    eq('恰好 7 天 → 200（边界不误伤）', exact7.status, 200);

    // ---------- 10b. ★ 当前这一周不许出现在「以前的周报」里 ----------
    group('10b. 当前这一周不是「以前」（history 必须排除 week_to >= 今天）');
    const curFrom = dayOff(-3), curTo = TODAY;   // 含今天 ⇒ 属于"当前"，不是"以前"
    const curW = await POST('/api/weekly/note/' + curFrom + '/' + curTo,
      { answers: { noticed: '这是本周写的，不该出现在历史里', next: '' } }, tokA);
    eq('本周的稿子能正常存（写不拦）', curW.status, 200);

    const hCur = await GET('/api/weekly/history', tokA);
    ok('★★ 历史里没有"当前这一周"',
      !(hCur.body.weeks || []).some(w => w.to === curTo),
      (hCur.body.weeks || []).map(w => w.from + '~' + w.to));
    ok('★ 但当前这一周仍读得到（history 排除 ≠ 数据丢了）',
      (await GET('/api/weekly/note?from=' + curFrom + '&to=' + curTo, tokA)).body.note.answers.noticed === '这是本周写的，不该出现在历史里',
      '读不到');

    // ---------- 11. 幂等 ----------
    group('11. 读接口连打多次结果一致（没有隐藏的写副作用）');
    const r1 = await GET('/api/weekly/history', tokA);
    const r2 = await GET('/api/weekly/history', tokA);
    const r3 = await GET('/api/weekly/history', tokA);
    ok('连打 3 次 history 结果完全一致',
      JSON.stringify(r1.body) === JSON.stringify(r2.body) && JSON.stringify(r2.body) === JSON.stringify(r3.body),
      '不一致');

    const n1 = await GET('/api/weekly/note?from=' + FROM + '&to=' + TO, tokA);
    const n2 = await GET('/api/weekly/note?from=' + FROM + '&to=' + TO, tokA);
    ok('连打 2 次 note 结果一致', JSON.stringify(n1.body) === JSON.stringify(n2.body), '不一致');

    // ---------- 12. 返回体不许泄露内部字段 ----------
    group('12. 返回体边界（不许带内部实现细节）');
    const histRaw = JSON.stringify(h1.body);
    ok('历史里不带 answers_json（解析过的对象，不是原始列）', histRaw.indexOf('answers_json') < 0, '出现了 answers_json');
    ok('历史里不带 space_id（空间归属不该透给前端）', histRaw.indexOf('space_id') < 0, '出现了 space_id');
    const evRaw = JSON.stringify(evR.body);
    ok('溯源里不带 student_answer（那是孩子写错的东西）', evRaw.indexOf('student_answer') < 0, '出现了 student_answer');
    ok('溯源里不带 ai_verdict', evRaw.indexOf('ai_verdict') < 0, '出现了 ai_verdict');

  } catch (e) {
    console.error('\n未捕获错误：', e && e.stack || e);
    fail++;
    failures.push('未捕获错误：' + (e && e.message));
  }

  await stopServer(child);

  console.log('\n' + '─'.repeat(60));
  if (fail) {
    console.log('✗ 失败 ' + fail + ' 项：');
    failures.forEach(f => console.log('   · ' + f));
  } else {
    console.log('✓ 全部通过');
  }
  // ★ 摘要行格式**必须**是「通过 N 项，失败 M 项」——
  //   `_run-tests.cjs` 用 `/通过 (\d+) 项，失败 (\d+) 项/` 抓这个数。
  //   写成「通过 N / 失败 M」会被判成"摘要行没打出来" ⇒ 汇总里显示 **0 项通过**。
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  console.log('数据目录：' + DATA_DIR);
  process.exit(fail ? 1 : 0);
})();

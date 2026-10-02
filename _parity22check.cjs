'use strict';
/**
 * 批次22 自检（模块级）：历史周报 server/weekly.js
 *
 * ============================ 这个套件到底在守什么 ============================
 *
 * 历史周报是日报/周报/家长端三条硬规矩第一次碰到**"要存点什么"**的地方。
 * 一旦开始写库，规矩①（系统侧事实不落库）就有了被绕过的口子：
 *
 *   A. **把汇总数字也存进 weekly_reports** —— 看起来是"缓存、加快回看"，
 *      实际是让溯源变成溯源自证：你点"这个数从哪来"，拿回来的是当初抄下的副本，
 *      而不是产生它的那张卡那次复习。**判据：删掉整张 weekly_reports 之后，
 *      build() 出来的数字必须一个都不变。**（见 E 组，含反证）
 *
 *   B. **回看历史时用的是当初存的数字** —— 和 A 同源。历史列表里的 records/reviews
 *      必须是**重新算的**：今天再看上周，上周的数字可能因为补录/清理而变化，
 *      那是事实变了，应当跟着变（我们只承诺"指向原始记录"，不承诺"冻结快照"）。
 *
 *   C. **定稿能被覆盖** —— 定稿是"当时的我"写的。允许覆盖 = 允许后来的我
 *      把当时想不明白的地方改得好看。**这条和日报同规矩，必须一致。**
 *
 *   D. **跨空间** —— 甲的周报里能看到乙写的感想。历史列表尤其危险：
 *      它是"列出来"，一个漏掉的 WHERE 就会把别人的心情摆在你的页面上。
 *
 *   E. **溯源口径和汇总口径不一致** —— 溯源说 15 条、汇总说 14 条，
 *      两边都不算错，但用户会认为"这个数不准"。**必须逐字对齐 computeSummary。**
 *
 * 不起服务，直接调 server/weekly.js。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hl-p22-'));
process.env.DATA_DIR = TMP;
process.env.NO_DOTENV = '1';

let pass = 0, fail = 0;
const fails = [];
function ok(name, cond, extra) {
  if (cond) { pass++; }
  else { fail++; fails.push(name + (extra !== undefined ? ' → ' + JSON.stringify(extra) : '')); }
}
function group(t) { console.log('\n' + t); }

const D = require('./server/db');
const weekly = require('./server/weekly');

const DAY = 86400000;
const SID = 'sp_p22';
const OTHER = 'sp_p22_other';
D.run('INSERT INTO spaces(id,name,name_key,created_at) VALUES(?,?,?,?)', SID, '批次二二空间', '批次二二空间', D.now());
D.run('INSERT INTO spaces(id,name,name_key,created_at) VALUES(?,?,?,?)', OTHER, '隔壁空间', '隔壁空间', D.now());

const now = D.now();
function dayOff(n) {
  const d = new Date(now + n * DAY);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function tsAt(dateStr, hour) {
  const p = dateStr.split('-');
  return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]), hour || 10, 0, 0).getTime();
}

// 造卡 + 复习（跨 7 天：第 1/3/5 天有练习，第 2/4/6 天只活动，第 7 天全空）
let cardSeq = 0;
const SUBJECTS = ['math', 'english'];
const madeCards = [];
function addCard(spaceId, dayIdx, subject) {
  cardSeq++;
  const cid = spaceId + '_c' + cardSeq;
  D.run('INSERT INTO cards(id,space_id,knowledge,subject,status,created_at) VALUES(?,?,?,?,?,?)',
    cid, spaceId, '知识点' + cardSeq, subject, 'learning', tsAt(dayOff(dayIdx), 9));
  madeCards.push({ id: cid, spaceId: spaceId });
  return cid;
}
function addReview(cardId, dayIdx, result, hour) {
  D.run('INSERT INTO card_reviews(id,card_id,result,reviewed_at) VALUES(?,?,?,?)',
    'r_' + Math.random().toString(36).slice(2, 10), cardId, result, tsAt(dayOff(dayIdx), hour || 10));
}
function addActivity(spaceId, dayIdx, hour) {
  D.run('INSERT INTO activity(space_id,kind,at) VALUES(?,?,?)', spaceId, 'review', tsAt(dayOff(dayIdx), hour || 10));
}

// 主空间：6 天有痕迹（含第 7 天为空）
[-6, -5, -4, -3, -2, -1].forEach((d, i) => {
  if (i % 2 === 0) {
    // 有练习的日子
    const c1 = addCard(SID, d, SUBJECTS[i % 2]);
    const c2 = addCard(SID, d, SUBJECTS[(i + 1) % 2]);
    addReview(c1, d, 'right', 10);
    addReview(c2, d, i === 2 ? 'wrong' : 'right', 11);
    if (i === 4) addReview(c2, d, 'wrong', 12);   // 同一天再错一次 → 卡住
  }
  addActivity(SID, d, 10);
  addActivity(SID, d, 11);
});
// 今天（第 7 天）刻意留空，验"没有记录的那天不许补 0"

// 隔壁空间造点东西，专门用来验隔离
{
  const c = addCard(OTHER, -3, 'math');
  addReview(c, -3, 'wrong', 10);
  addActivity(OTHER, -3, 10);
}

const FROM = dayOff(-6);
const TO = dayOff(0);

// ============================================================
group('A. 基本存取：没写过返回 null（不是空对象）');
{
  // ★ null 和 {} 是两件事：null = "你没写过"，{} = "你写了但都是空的"。
  //   界面要能区分"还没开始写"和"写了没内容"，这里必须分开。
  const n = weekly.getNote(SID, FROM, TO);
  ok('A1 没写过时 getNote 返回 null', n === null, n);

  const saved = weekly.saveDraft(SID, FROM, TO, { noticed: '周三我突然想通了比例', next: '' });
  ok('A2 存草稿后 status=draft', saved && saved.status === 'draft', saved && saved.status);
  ok('A3 草稿内容被完整保存', saved.answers.noticed === '周三我突然想通了比例', saved.answers);
  ok('A4 空字符串的字段也保留（不是缺键）', 'next' in saved.answers, Object.keys(saved.answers));
  ok('A5 返回里带 from/to，且与请求一致', saved.from === FROM && saved.to === TO, [saved.from, saved.to]);

  const again = weekly.saveDraft(SID, FROM, TO, { noticed: '改过的说法', next: '下周重做错题' });
  ok('A6 草稿可以反复覆盖（未定稿时）', again.answers.noticed === '改过的说法', again.answers.noticed);
  ok('A7 覆盖不会产生第二条记录', D.get('SELECT COUNT(*) AS n FROM weekly_reports WHERE space_id=?', SID).n === 1,
    D.get('SELECT COUNT(*) AS n FROM weekly_reports WHERE space_id=?', SID).n);
}

group('B. ★ 定稿 = 冻结：定稿后不能被草稿改写（与日报同规矩）');
{
  const f = weekly.finalize(SID, FROM, TO, { noticed: '定稿时的说法', next: '下周的事' });
  ok('B1 finalize 后 status=final', f.status === 'final', f.status);
  ok('B2 finalizedAt 是个时间戳', typeof f.finalizedAt === 'number' && f.finalizedAt > 0, f.finalizedAt);
  ok('B3 定稿会带上传入的内容', f.answers.noticed === '定稿时的说法', f.answers);

  const after = weekly.saveDraft(SID, FROM, TO, { noticed: '我不该能改它', next: 'x' });
  ok('B4 ★★ 定稿后存草稿被拒绝、内容不变', after.answers.noticed === '定稿时的说法', after.answers.noticed);
  ok('B5 被拒绝后 status 仍是 final', after.status === 'final', after.status);

  const f2 = weekly.finalize(SID, FROM, TO, { noticed: '再次定稿也不该改', next: 'y' });
  ok('B6 ★ 再次 finalize 也不覆盖已定稿的内容', f2.answers.noticed === '定稿时的说法', f2.answers.noticed);
}

group('C. 范围校验：非法就抛，不猜（错码必须在 HTTP 层可见）');
{
  function throws(fn) { try { fn(); return false; } catch (e) { return e.message || true; } }
  ok('C1 日期格式非法 → invalid_range', throws(() => weekly.getNote(SID, '不是日期', TO)) === 'invalid_range');
  ok('C2 to 早于 from → invalid_range', throws(() => weekly.getNote(SID, TO, FROM)) === 'invalid_range');
  ok('C3 恰好 7 天 → 通过', weekly.build(SID, dayOff(-6), dayOff(0)) && true);
  ok('C4 8 天 → range_too_long', throws(() => weekly.build(SID, dayOff(-7), dayOff(0))) === 'range_too_long');
  ok('C5 写接口同样校验（saveDraft 8 天被拦）',
    throws(() => weekly.saveDraft(SID, dayOff(-7), dayOff(0), { noticed: 'x' })) === 'range_too_long');
  ok('C6 写接口同样校验（finalize 非法日期被拦）',
    throws(() => weekly.finalize(SID, 'x', 'y', {})) === 'invalid_range');
}

group('D. ★★ 跨空间隔离：甲的周报里看不到乙写的任何字');
{
  // 隔壁也写一条，区间完全相同 —— 如果 WHERE 漏了 space_id，下面全红
  weekly.finalize(OTHER, FROM, TO, { noticed: '我是隔壁的感想', next: '隔壁的下周' });

  const mine = weekly.getNote(SID, FROM, TO);
  const theirs = weekly.getNote(OTHER, FROM, TO);
  ok('D1 两个空间各自读到自己写的那条', mine.answers.noticed === '定稿时的说法' && theirs.answers.noticed === '我是隔壁的感想',
    [mine.answers.noticed, theirs.answers.noticed]);
  ok('D2 ★ 同一个区间不会互相覆盖', mine.id !== theirs.id, [mine.id, theirs.id]);

  // 反证：偷偷把隔壁那条换成自己的话，确认 SID 读到的没变
  D.run('UPDATE weekly_reports SET answers_json = ? WHERE space_id = ?', JSON.stringify({ noticed: '污染' }), OTHER);
  const mine2 = weekly.getNote(SID, FROM, TO);
  ok('D3 ★★ 改隔壁那条，我这边的稿子一字节都不动', mine2.answers.noticed === '定稿时的说法', mine2.answers.noticed);

  // ★ 历史列表要验"只列自己的"，就得有一条**不会因当前周被排除**的记录 ⇒ 给两边各补一条过去的
  //   （history 排除当前周是有意为之，见 K 组）
  weekly.finalize(SID, dayOff(-13), dayOff(-7), { noticed: '甲在过去的周报', next: '' });
  weekly.finalize(OTHER, dayOff(-13), dayOff(-7), { noticed: '乙在过去的周报', next: '' });

  const hist = weekly.history(SID, 26);
  ok('D4 ★ 历史列表里只有自己的周（隔壁那条不出现）',
    hist.length === 1 && hist[0].answers.noticed === '甲在过去的周报',
    hist.map(h => h.from + '~' + h.to + ':' + h.answers.noticed));
  ok('D5 历史列表里每一条都属于自己', hist.every(h => h.answers.noticed !== '污染'), hist.map(h => h.answers.noticed));

  const histOther = weekly.history(OTHER, 26);
  ok('D6 隔壁的历史里也只有它自己那条',
    histOther.length === 1 && histOther[0].answers.noticed === '乙在过去的周报',
    histOther.map(h => h.answers.noticed));
}

group('E. ★★ 规矩①：数字不落库 —— 删掉整张 weekly_reports，数字一个都不许变');
{
  // ★ E 组用**当前周**（FROM~TO 含今天）来验 build()：build 不受"是否进历史"影响。
  //   但为了能同时验"history 里也有内容 → 删光 → 空"，再补一条**过去**的周报。
  //   （history 会排除当前周，这是有意为之，见 K 组 —— 不补这条的话 E3 会因为
  //    "本来就没东西"而永远绿，那是个假断言。）
  weekly.finalize(SID, dayOff(-13), dayOff(-7), { noticed: '过去那一周写的', next: '' });

  const before = weekly.build(SID, FROM, TO);
  const bSnap = JSON.stringify({
    summary: before.summary, coverage: before.coverage,
    days: before.days.map(d => ({ date: d.date, hasRecord: d.hasRecord })),
  });
  const histBefore = weekly.history(SID, 26).map(h => ({ from: h.from, to: h.to, records: h.records, reviews: h.reviews, accuracy: h.accuracy }));
  ok('E0-0 预处理：history 里确实有内容（否则 E3 是假断言）', histBefore.length === 1, histBefore);

  // 清掉所有"人写的那部分"
  D.run('DELETE FROM weekly_reports');
  ok('E0 预处理：weekly_reports 已清空', D.get('SELECT COUNT(*) AS n FROM weekly_reports').n === 0);

  const after = weekly.build(SID, FROM, TO);
  const aSnap = JSON.stringify({
    summary: after.summary, coverage: after.coverage,
    days: after.days.map(d => ({ date: d.date, hasRecord: d.hasRecord })),
  });
  ok('E1 ★★ 删掉全部周报之后，build() 的数字完全不变（含 days 与 coverage）', bSnap === aSnap,
    bSnap === aSnap ? '' : '前后不一致');

  // 反证：如果数字真的来自表，这里必然为空 —— 用它证明"清空真的发生了"
  ok('E2 反证：清空后 getNote 返回 null（说明 DELETET 确实生效了，不是没删掉）',
    weekly.getNote(SID, FROM, TO) === null, weekly.getNote(SID, FROM, TO));

  // history 也必须是现算的：原记录没了 → 历史自然为空（没有"存下来的快照"能兜底）
  ok('E3 ★ history 也是现算的：记录删光后历史列表为空（证明它没有快照可回退）',
    weekly.history(SID, 26).length === 0, weekly.history(SID, 26).length);
  ok('E4 反证：删除前 history 是有内容的', histBefore.length === 1, histBefore);
}

group('E2. ★★★ history 的数字必须现算，不能是当初存的快照（本条来自一次失败的反证）');
{
  // 为什么要有这一组：E 组只证明了**build()** 的数字不落库，但界面上"以前的周报"
  // 那一列用的是 **history()** 的数字。如果 history() 偷偷改用存下来的快照
  // （例如把 summary 也序列化进 answers_json），E 组仍会全绿 ——
  // 因为 E 组删的是 weekly_reports 行，而快照恰好也跟着被删了，看不出差别。
  //
  // ★ 判据必须是"改动**原始记录**后，history 里的数字跟着变"：
  //   快照方案在这里必然不动（它只认自己当初抄的那份），现算方案必然跟着动。
  const SID2 = 'sp_p22_hist';
  D.run('INSERT INTO spaces(id,name,name_key,created_at) VALUES(?,?,?,?)', SID2, '历史现算空间', '历史现算空间', D.now());
  const cardId = SID2 + '_c1';
  // ★ 用**过去**的一周（-13 ~ -7）：history 会排除"到今天就结束"的区间（见 K 组），
  //   所以验证"以前那周"的东西必须落在真正的过去。
  D.run('INSERT INTO cards(id,space_id,knowledge,subject,status,created_at) VALUES(?,?,?,?,?,?)',
    cardId, SID2, '历史现算知识点', 'math', 'learning', tsAt(dayOff(-13), 9));
  const revId = SID2 + '_r1';
  D.run('INSERT INTO card_reviews(id,card_id,result,reviewed_at) VALUES(?,?,?,?)',
    revId, cardId, 'right', tsAt(dayOff(-13), 10));
  weekly.finalize(SID2, dayOff(-13), dayOff(-7), { noticed: '我写的那句话', next: '' });

  const h1 = weekly.history(SID2, 26);
  ok('E2-1 历史里出现这一条', h1.length === 1, h1.length);
  const reviewsBefore = h1[0].reviews;
  ok('E2-2 基线：history 报出的练卡次数正确', reviewsBefore === 1, reviewsBefore);

  // 改动**原始记录**：把那次对改成错，并再来一次错（都在那一段过去里）
  D.run('UPDATE card_reviews SET result = ? WHERE id = ?', 'wrong', revId);
  D.run('INSERT INTO card_reviews(id,card_id,result,reviewed_at) VALUES(?,?,?,?)',
    SID2 + '_r2', cardId, 'wrong', tsAt(dayOff(-12), 10));

  const h2 = weekly.history(SID2, 26);
  ok('E2-3 ★★★ 改了原始记录之后，history 里的练卡次数跟着变（1 → 2）',
    h2[0].reviews === 2, [h1[0].reviews, h2[0].reviews]);
  ok('E2-4 ★★★ 正确率也跟着重算（不再是 100%）', h2[0].accuracy === 0, h2[0].accuracy);
  ok('E2-5 ★ 人写的那段不受影响（数字变了，感想不该变）',
    h2[0].answers.noticed === '我写的那句话', h2[0].answers.noticed);
  ok('E2-6 ★ history 的数字与当场 build() 出来的完全一致',
    h2[0].reviews === weekly.build(SID2, dayOff(-13), dayOff(-7)).summary.reviews &&
    h2[0].accuracy === weekly.build(SID2, dayOff(-13), dayOff(-7)).summary.accuracy,
    [h2[0].reviews, weekly.build(SID2, dayOff(-13), dayOff(-7)).summary.reviews]);
}

group('K. ★★ 历史里不许出现"当前这一周"（界面把它叫「以前的周报」）');
{
  // 为什么单列一组：历史那一块的标题是「以前的周报」。把用户正在写的那一周
  // 也列进去，会出现两个问题 ——
  //   ① 文案与内容不符（"以前"里装的是"现在"）；
  //   ② 点进去从"编辑态"跳到"编辑态"，看起来像没反应（本套件在浏览器上抓到过）。
  // 判据：`week_to === 今天` 的区间不算"以前"，必须被排除。
  const SID3 = 'sp_p22_cur';
  D.run('INSERT INTO spaces(id,name,name_key,created_at) VALUES(?,?,?,?)', SID3, '当前周空间', '当前周空间', D.now());

  // 当前周（to = 今天）
  weekly.finalize(SID3, dayOff(-6), dayOff(0), { noticed: '我正在写的这一周', next: '' });
  // 上一周（to = 7 天前）
  weekly.finalize(SID3, dayOff(-13), dayOff(-7), { noticed: '上一周', next: '' });
  // 上上周
  weekly.finalize(SID3, dayOff(-20), dayOff(-14), { noticed: '上上周', next: '' });

  const h = weekly.history(SID3, 26);
  ok('K1 ★★ 当前周不出现在历史里', !h.some(w => w.to === dayOff(0)),
    h.map(w => w.from + '~' + w.to));
  ok('K2 上一周出现在历史里', h.some(w => w.to === dayOff(-7)), h.map(w => w.to));
  ok('K3 上上周也在', h.some(w => w.to === dayOff(-14)), h.map(w => w.to));
  ok('K4 ★ 历史条数 = 2（三周里排除了当前那一周）', h.length === 2, h.length);
  ok('K5 ★ 但当前周的稿子仍然读得到（只是不进"历史"列表）',
    (weekly.getNote(SID3, dayOff(-6), dayOff(0)) || {}).answers &&
    weekly.getNote(SID3, dayOff(-6), dayOff(0)).answers.noticed === '我正在写的这一周',
    weekly.getNote(SID3, dayOff(-6), dayOff(0)));
  ok('K6 ★ 历史是按 to 倒序（最近的在前）', h[0].to > h[1].to, h.map(w => w.to));
}

group('L. 静态：前端也守「当前周不进历史」这条语义');
{
  const APPJS = fs.readFileSync(path.join(__dirname, 'public/js/app.js'), 'utf8');
  ok('L1 界面标题写的是「以前的周报」（与"排除当前周"这条语义配套）',
    APPJS.indexOf('以前的周报') >= 0);
  ok('L2 ★ 区块标题里说明了"只存了我写下的那段"',
    APPJS.indexOf('只存了我写下的那段') >= 0);
}

group('F. ★ 溯源口径必须与 computeSummary 逐字对齐');
{
  // 重新建一段干净的数据来验口径（E 组把周报清了，但卡和复习还在）
  const rpt = weekly.build(SID, FROM, TO);
  const s = rpt.summary;

  const evReviews = weekly.evidenceByMetric(SID, FROM, TO, 'reviews');
  ok('F1 reviews 溯源条数 === summary.reviews', evReviews.count === s.reviews, [evReviews.count, s.reviews]);

  const evRight = weekly.evidenceByMetric(SID, FROM, TO, 'right');
  ok('F2 right 溯源条数 === summary.right', evRight.count === s.right, [evRight.count, s.right]);

  const evWrong = weekly.evidenceByMetric(SID, FROM, TO, 'wrong');
  ok('F3 wrong 溯源条数 === summary.wrong', evWrong.count === s.wrong, [evWrong.count, s.wrong]);

  // ★ 正确率的分母是 right+wrong，unknown 不计入。所以 accuracy 的溯源应当是
  //   right + wrong 条 —— 而不是 reviews 条。这正是本项目最容易被写错的口径。
  const evAcc = weekly.evidenceByMetric(SID, FROM, TO, 'accuracy');
  ok('F4 ★★ accuracy 溯源条数 === right + wrong（unknown 不计入分母）',
    evAcc.count === s.right + s.wrong, [evAcc.count, s.right + s.wrong]);
  ok('F5 accuracy 口径与 summary 自洽（judged === right + wrong）',
    s.judged === s.right + s.wrong, [s.judged, s.right, s.wrong]);
  ok('F6 accuracy 的值就是 right/judged 四舍五入',
    s.accuracy === (s.judged ? Math.round(s.right / s.judged * 100) : null), s.accuracy);

  const evCards = weekly.evidenceByMetric(SID, FROM, TO, 'cards');
  ok('F7 cards 溯源按卡去重 === summary.cardsTouched', evCards.count === s.cardsTouched,
    [evCards.count, s.cardsTouched]);

  ok('F8 每条溯源都带 date（能指出"这个数哪几天凑的"）',
    evReviews.items.every(x => /^\d{4}-\d{2}-\d{2}$/.test(x.date)), evReviews.items.slice(0, 1));
  ok('F9 每条 review 溯源都带原始 id 与 result',
    evReviews.items.every(x => x.id && x.result), evReviews.items.slice(0, 1));
  ok('F10 未知 metric 抛 unknown_metric（不静默返回空）',
    (() => { try { weekly.evidenceByMetric(SID, FROM, TO, '瞎写的'); return false; } catch (e) { return e.message === 'unknown_metric'; } })());

  // records 走 activity，也必须有
  const evRec = weekly.evidenceByMetric(SID, FROM, TO, 'records');
  ok('F11 records 溯源条数 === summary.records', evRec.count === s.records, [evRec.count, s.records]);
}

group('G. 空空间：算不出来就说算不出来，不许补零（规矩②）');
{
  const EMPTY = 'sp_p22_empty';
  D.run('INSERT INTO spaces(id,name,name_key,created_at) VALUES(?,?,?,?)', EMPTY, '空空间', '空空间', D.now());
  const b = weekly.build(EMPTY, dayOff(-6), dayOff(0));
  ok('G1 空空间 accuracy === null（不是 0）', b.summary.accuracy === null, b.summary.accuracy);
  ok('G2 空空间 records === 0（这个是真的 0，该写 0）', b.summary.records === 0, b.summary.records);
  ok('G3 空空间 reviews === 0', b.summary.reviews === 0, b.summary.reviews);
  ok('G4 空空间 cardsTouched === 0', b.summary.cardsTouched === 0, b.summary.cardsTouched);
  ok('G5 ★ null 与 0 并存：accuracy 是 null 而 records 是 0（两者不能混为一谈）',
    b.summary.accuracy === null && b.summary.records === 0, [b.summary.accuracy, b.summary.records]);
  ok('G6 空空间不评分字段仍在（notScored 非空）', b.notScored.length >= 3, b.notScored.length);

  // 全错但不是"没数据"：这是 accuracy=0 该出现的地方（恒等于 0，不是 null）
  const ALLWRONG = 'sp_p22_allwrong';
  D.run('INSERT INTO spaces(id,name,name_key,created_at) VALUES(?,?,?,?)', ALLWRONG, '全错空间', '全错空间', D.now());
  D.run('INSERT INTO cards(id,space_id,knowledge,subject,status,created_at) VALUES(?,?,?,?,?,?)',
    ALLWRONG + '_c1', ALLWRONG, '全错知识点', 'math', 'learning', tsAt(dayOff(-6), 9));
  D.run('INSERT INTO card_reviews(id,card_id,result,reviewed_at) VALUES(?,?,?,?)',
    ALLWRONG + '_r1', ALLWRONG + '_c1', 'wrong', tsAt(dayOff(-6), 10));
  const b2 = weekly.build(ALLWRONG, dayOff(-6), dayOff(0));
  ok('G7 ★★ 全错是 0% 不是 null（0 和"没数据"必须分开）', b2.summary.accuracy === 0, b2.summary.accuracy);
}

group('H. 时间跨度：只有一条记录时"跨度"算不出来（不是 0 分钟）');
{
  const b = weekly.build(SID, FROM, TO);
  ok('H1 spanDays 与 totalSpanMinutes 自洽（有一个非 null 才算它）',
    (b.summary.totalSpanMinutes === null) === (b.summary.spanDays === 0),
    [b.summary.totalSpanMinutes, b.summary.spanDays]);
}

group('I. 静态：前端接线与"只存人写的"这条线必须写死');
{
  const APPJS = fs.readFileSync(path.join(__dirname, 'public/js/app.js'), 'utf8');
  const CSS = fs.readFileSync(path.join(__dirname, 'public/app.css'), 'utf8');
  const SRV = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');

  ok('I1 前端有 loadWeeklyNote()（不是只 loadWeekly）', APPJS.indexOf('function loadWeeklyNote(') >= 0);
  ok('I2 前端有 loadWeeklyHist()', APPJS.indexOf('function loadWeeklyHist(') >= 0);
  ok('I3 前端有 saveWeeklyNote()', APPJS.indexOf('function saveWeeklyNote(') >= 0);
  // ★ indexOf 会命中"定义"而不是"调用点" —— 所以带分号
  ok('I4 ★ loadWeekly 内部会去取 note（顺序约束：渲染完再取）',
    /await Promise\.all\(\[loadWeeklyNote/.test(APPJS));
  ok('I5 ★ 占位节点 #weeklyNoteSec 与 #weeklyHist 都在 renderWeekly 里建',
    APPJS.indexOf('id="weeklyNoteSec"') >= 0 && APPJS.indexOf('id="weeklyHist"') >= 0);
  // 建容器必须早于取数 —— 本项目踩过"函数取到 null 静默 return"的坑
  ok('I6 ★ 建 #weeklyNoteSec 的语句在 loadWeeklyNote 定义之前出现（顺序约束）',
    APPJS.indexOf('id="weeklyNoteSec"') < APPJS.indexOf('function loadWeeklyNote('),
    [APPJS.indexOf('id="weeklyNoteSec"'), APPJS.indexOf('function loadWeeklyNote(')]);
  ok('I7 定稿前有二次确认（防误触）', APPJS.indexOf('confirm(') >= 0 && APPJS.indexOf('定稿之后') >= 0);
  ok('I8 定稿态是只读（不渲染 input）', APPJS.indexOf('已定稿 · 只读') >= 0);

  ok('I9 CSS 有 .w-note-sec（写入区与纯事实区视觉上分开）', CSS.indexOf('.w-note-sec') >= 0);
  ok('I10 CSS 有 .w-hist（历史条目）', CSS.indexOf('.w-hist') >= 0);
  ok('I11 CSS 有定稿态标签样式', CSS.indexOf('.w-final-tag') >= 0);

  ok('I12 路由 /api/weekly/history 存在', SRV.indexOf("'/api/weekly/history'") >= 0);
  ok('I13 路由 /api/weekly/note 存在', SRV.indexOf("'/api/weekly/note'") >= 0);
  ok('I14 路由 /api/weekly/evidence 存在', SRV.indexOf("'/api/weekly/evidence'") >= 0);
  ok('I15 写接口用 POST + 正则匹配 from/to', /wDraft && method === 'POST'/.test(SRV));
  ok('I16 ★ 没有把 week 加进顶级导航（顶级导航只有 对话/知识库）',
    (APPJS.match(/nav-i\[data-view/g) || []).length <= 3, (APPJS.match(/nav-i\[data-view/g) || []).length);
}

group('J. 递归扫：返回结构里不许出现 undefined（JSON.stringify 会丢键的老坑）');
{
  weekly.finalize(SID, FROM, TO, { noticed: '再定一次', next: '' });
  const walk = (v, pathStr, bad) => {
    if (v === undefined) { bad.push(pathStr); return; }
    if (v === null) return;
    if (Array.isArray(v)) { v.forEach((x, i) => walk(x, pathStr + '[' + i + ']', bad)); return; }
    if (typeof v === 'object') { Object.keys(v).forEach(k => walk(v[k], pathStr + '.' + k, bad)); }
  };
  const check = (name, obj) => {
    const bad = [];
    walk(obj, name, bad);
    ok('J: ' + name + ' 无 undefined', bad.length === 0, bad.slice(0, 5));
  };
  check('build()', weekly.build(SID, FROM, TO));
  check('history()', weekly.history(SID, 26));
  check('getNote()', weekly.getNote(SID, FROM, TO));
  check('evidenceByMetric()', weekly.evidenceByMetric(SID, FROM, TO, 'reviews'));
}

// ============================================================
group('M. ★ 与上一段对比：null 不许当 0 比、不给红绿、不评价好坏');
{
  const b = weekly.build(SID, FROM, TO);
  const cmp = b.compare;
  ok('M1 build() 带上了 compare', !!cmp, !!cmp);

  // 上一段 = 与本周等长、紧挨着在它前面的那一段（不是"自然周"）
  const expectPrevTo = dayOff(-7);
  const expectPrevFrom = dayOff(-13);
  ok('M2 上一段是紧邻的等长窗口', cmp.prevFrom === expectPrevFrom && cmp.prevTo === expectPrevTo,
    cmp.prevFrom + '~' + cmp.prevTo);
  ok('M3 上一段天数与这一段相同', cmp.daysCount === b.daysCount, cmp.daysCount + ' vs ' + b.daysCount);

  // 本周有数据、上一段为空 ⇒ 每个指标都要能算出 delta（上一段是"0 有数据"不是"null"）
  const m = cmp.metrics;
  ok('M4 records.this 与本段 summary 一致', m.records['this'] === b.summary.records,
    m.records['this'] + ' vs ' + b.summary.records);
  ok('M5 records.last 是上一段的（本夹具里为 0）', m.records.last === 0, m.records.last);
  ok('M6 records.delta = this - last', m.records.delta === m.records['this'] - m.records.last, m.records);

  // ★★ 核心：accuracy 两侧都是"判不出对错"时，delta 必须是 null（不许当 0）
  //   造一个两段都没有判得出对错的场景
  const SID2 = 'sp_p22_cmp_null';
  addCard(SID2, -20, 'math');   // 只建卡、不复习 ⇒ reviews 0、judged 0
  addCard(SID2, -1, 'math');
  const b2 = weekly.build(SID2, dayOff(-6), dayOff(0));
  ok('M7 两段都算不出 accuracy 时 this/last 都是 null',
    b2.compare.metrics.accuracy['this'] === null && b2.compare.metrics.accuracy.last === null,
    b2.compare.metrics.accuracy);
  ok('M8 ★★ accuracy 两侧 null ⇒ delta 是 null 而不是 0',
    b2.compare.metrics.accuracy.delta === null, b2.compare.metrics.accuracy.delta);
  ok('M9 ★★ delta 为 null 时 direction 必须是 unknown（不能是 flat）',
    b2.compare.metrics.accuracy.direction === 'unknown', b2.compare.metrics.accuracy.direction);
  ok('M10 ★★ 给出"为什么没法比"的说明，不留下空白', !!b2.compare.metrics.accuracy.why,
    b2.compare.metrics.accuracy.why);
  ok('M11 有指标不可比时 comparable=false', b2.compare.comparable === false, b2.compare.comparable);

  // ★ 一侧 null 一侧有值 ⇒ 仍然不许比（这才是最容易出错的地方）
  const SID3 = 'sp_p22_cmp_mix';
  {
    const c = addCard(SID3, -10, 'math');
    addReview(c, -10, 'right', 10);      // 上一段有判得出对错的
    addCard(SID3, -1, 'math');           // 本段只有建卡、没复习 ⇒ accuracy null
  }
  const b3 = weekly.build(SID3, dayOff(-6), dayOff(0));
  ok('M12 ★★ 一侧 null 一侧有值 ⇒ delta 仍是 null（不比）',
    b3.compare.metrics.accuracy.delta === null, b3.compare.metrics.accuracy);
  ok('M13 此时 this 是 null、last 有值（两侧都如实给出）',
    b3.compare.metrics.accuracy['this'] === null && b3.compare.metrics.accuracy.last === 100,
    b3.compare.metrics.accuracy);

  // 正常可比的：records 两侧都有 ⇒ delta 是真数字
  ok('M14 两侧都有数时 delta 是数字', typeof m.records.delta === 'number', typeof m.records.delta);
  ok('M15 direction 只能是 up/down/flat/unknown',
    ['up', 'down', 'flat', 'unknown'].indexOf(m.records.direction) >= 0, m.records.direction);

  // ★ 不许评价好坏：note 里必须明说"不说明学得好坏"
  ok('M16 ★ 对比附带的说明明说"不代表学得好坏"',
    /不说明学得好坏|不代表/.test(cmp.note || ''), cmp.note);

  // ★★ 反证友好：compare 也必须现算（删掉 weekly_reports 不影响它）
  const before = JSON.stringify(weekly.build(SID, FROM, TO).compare);
  D.run('DELETE FROM weekly_reports WHERE space_id = ?', SID);
  const after = JSON.stringify(weekly.build(SID, FROM, TO).compare);
  ok('M17 ★★ compare 现算：删掉 weekly_reports 后一字节不变', before === after, { before: before.slice(0, 60), after: after.slice(0, 60) });
}

// ============================================================
group('N. 静态：对比的"不给红绿、不给好坏"必须写死在前端');
{
  const app = fs.readFileSync(path.join(__dirname, 'public/js/app.js'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, 'public/app.css'), 'utf8');
  const cmpStart = app.indexOf('function renderCompare');
  const cmpFn = cmpStart >= 0 ? app.slice(cmpStart, app.indexOf('function renderWeekly', cmpStart)) : '';
  ok('N1 前端有 renderCompare', cmpFn.length > 100, cmpFn.length);
  ok('N2 ★ 前端在 delta 为 null 时给的是"没法比"，不是 0 或空',
    /m\.delta === null[\s\S]{0,160}没法比/.test(cmpFn));
  ok('N3 ★ 前端不出现"进步/退步/优秀/退步了"这类评价词',
    !/进步|退步|优秀|变好|变差/.test(cmpFn), 'found eval word');
  ok('N4 ★★ CSS 里 up 与 down 用同一个颜色（不红不绿）',
    /\.w-cmp-up, \.w-cmp-down \{ color: var\(--pri\)/.test(css));
  ok('N5 ★ "没法比"(na) 与"一样"(flat) 是两档不同样式',
    /\.w-cmp-flat \{ color: var\(--dim2\)/.test(css) && /\.w-cmp-na \{ color: var\(--dim2\)/.test(css) &&
    css.indexOf('.w-cmp-na') !== css.indexOf('.w-cmp-flat'));
  // ★ 对比块也必须在第一个 @media 之前
  const cmpCss = css.indexOf('.w-cmp-row');
  const firstMedia = css.search(/(^|\n)\s*@media/);
  ok('N6 对比样式写在第一个 @media 之前', cmpCss > 0 && cmpCss < firstMedia, 'cmp@' + cmpCss + ' media@' + firstMedia);
  ok('N7 前端对比的四个指标与后端 metrics 键逐一对齐',
    ['records', 'reviews', 'accuracy', 'cardsTouched'].every(k => cmpFn.indexOf("'" + k + "'") >= 0));
}

// ============================================================
console.log('\n' + '─'.repeat(60));
if (fail) {
  console.log('✗ 失败 ' + fail + ' 项：');
  fails.forEach(f => console.log('   · ' + f));
} else {
  console.log('✓ 全部通过');
}
// ★ 摘要行格式**必须**是「通过 N 项，失败 M 项」——
//   `_run-tests.cjs` 用 `/通过 (\d+) 项，失败 (\d+) 项/` 抓这个数。
//   写成「通过 N / 失败 M」会被判成"摘要行没打出来"，
//   于是无论套件是不是全绿，汇总里都显示 **0 项通过**（症状：✓ 0 项通过）。
//   注意 `fail` 为 0 时也要打这一行 —— 别只在失败分支打。
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
process.exit(fail ? 1 : 0);

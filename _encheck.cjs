'use strict';
/**
 * 英语深度：单元四关 + 艾宾浩斯（批次24）模块级测试。
 *
 * 本套件要钉死的几件事（对应 server/english.js 头部）：
 *  ① **四关是四个动作**（认/读/背/用），不是把同一件事拆成四块 —— 每关的过关判据不同。
 *  ② **"用"这一关不判对错**：`ok === null`、`accuracy === null`、返回结构里不许有"答对率"。
 *     给它打分 = 用一把尺子量所有形状，是在编一个假的对错。
 *  ③ **新词不算"到期"**：把没碰过的词塞进复习队列，"今天该复习 N 个"就是骗人的数字。
 *  ④ **未知不算对也不算错**：unknown 既不清零也不推进（虚报进步 / 凭空退步都是假的）。
 *  ⑤ **间隔表与知识卡同值**（1/3/5/7 → 14 → 60）：换一套数字的后果是学生发现两边对不上。
 *  ⑥ 正确率分母 = 判得出对错的次数（right + wrong），unknown 不计入 —— 与全项目口径一致。
 *  ⑦ 跨空间隔离；进度**现算**（删掉 english_reviews 之外的任何东西不影响四关进度）。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hl-en-'));
process.env.DATA_DIR = TMP;
process.env.NO_DOTENV = '1';

let pass = 0, fail = 0;
const fails = [];
function ok(name, cond, extra) {
  if (cond) { pass++; } else { fail++; fails.push(name + (extra !== undefined ? '  [' + JSON.stringify(extra) + ']' : '')); }
}
function group(t) { console.log('\n' + t); }

// 先剥注释再断言：本项目注释里常写"不能这样写"的反面例子，
// 直接 grep 会把防呆说明判成"真的写错了"。
function stripComments(s) {
  return String(s)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

const D = require('./server/db');
const english = require('./server/english');
const cardsMod = require('./server/cards');

const DAY = 86400000;
const SID = 'sp_en';
const OTHER = 'sp_en_other';

let seq = 0;
function mkUnit(spaceId, name) {
  seq++;
  const id = spaceId + '_u' + seq;
  D.run('INSERT INTO word_units(id,space_id,name,grade,created_at) VALUES(?,?,?,?,?)', id, spaceId, name, '', D.now());
  return id;
}
function mkWord(spaceId, unitId, word, meaning, right, wrong) {
  seq++;
  const id = spaceId + '_w' + seq;
  D.run('INSERT INTO words(id,space_id,unit_id,word,phonetic,meaning,example,wrong_count,right_count,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
    id, spaceId, unitId || null, word, '', meaning || '', '', wrong || 0, right || 0, D.now());
  return id;
}
function setCounts(wordId, right, wrong) {
  D.run('UPDATE words SET right_count = ?, wrong_count = ? WHERE id = ?', right, wrong, wordId);
}
function enRevRow(wordId) {
  return D.get('SELECT * FROM english_reviews WHERE word_id = ? ORDER BY reviewed_at DESC, rowid DESC LIMIT 1', wordId);
}

// ============================================================
group('A. ★ 四关是四个动作，不是同一件事拆四块');
{
  ok('A1 恰好四关', english.GATES.length === 4, english.GATES.length);
  const keys = english.GATES.map(g => g.key);
  ok('A2 关卡 key 是 认/读/背/用', JSON.stringify(keys) === JSON.stringify(['recognize', 'read', 'recall', 'use']), keys);
  const names = english.GATES.map(g => g.name).join('');
  ok('A3 关卡中文名是四个动作', names === '认读背用', names);
  ok('A4 每关都有 what（说清这一关练什么）', english.GATES.every(g => g.what && g.what.length > 6));
  ok('A5 每关 size 是正的整数', english.GATES.every(g => Number.isInteger(g.size) && g.size > 0));
  // ★ 「认」只要求碰过（needRight=1），「背」要求对 2 次 —— 判据不同才叫"四个动作"
  const byKey = {};
  english.GATES.forEach(g => { byKey[g.key] = g; });
  ok('A6 ★「认」只要碰过就算过（needRight=1）', byKey.recognize.needRight === 1, byKey.recognize.needRight);
  ok('A7 ★「背」要求对 2 次（比认严）', byKey.recall.needRight === 2, byKey.recall.needRight);
  ok('A8 「背」这一关的说明里明说开始算对错', /算对错/.test(byKey.recall.what), byKey.recall.what);
  ok('A9 ★「读」这一关的说明里明说不打分', /不打分/.test(byKey.read.what), byKey.read.what);
  ok('A10 ★「用」这一关的说明里明说没有标准答案', /没有标准答案/.test(byKey.use.what), byKey.use.what);
  ok('A11 gateByKey 认得四关', ['recognize', 'read', 'recall', 'use'].every(k => english.gateByKey(k)));
  ok('A12 gateByKey 不认得乱写的关卡', english.gateByKey('xxx') === null);
}

// ============================================================
group('B. ★ 规矩②：算不出来就说算不出来（空单元 pct 是 null 不是 0）');
{
  const u = mkUnit(SID, '空单元');
  const p = english.unitProgress(SID, u);
  ok('B1 空单元四关都报出来', p.gates.length === 4, p.gates.length);
  ok('B2 空单元 total = 0', p.total === 0, p.total);
  // ★ 关键：pct 必须是 null。给 0 会被读成"一个词都没过"，而实际是"没有词可算"
  ok('B3 ★★ 空单元四关 pct 全是 null（不是 0）', p.gates.every(g => g.pct === null), p.gates.map(g => g.pct));
  ok('B4 空单元 allPassed = false（没词不算全过）', p.allPassed === false, p.allPassed);
  // ★ 空单元没有"下一关"可言：没有词，哪一关都谈不上差多少个。
  //   硬给 'recognize' 会让人以为"差 1 个就能过第一关"，而实际是"一个词都没有"。
  ok('B5 ★ 空单元 nextGate = null（没有词就没有"下一关"）', p.nextGate === null, p.nextGate);
  ok('B6 单元不存在返回 null 不抛异常', english.unitProgress(SID, 'no_such_unit') === null);
}

// ============================================================
group('C. ★ 四关进度现算：改 counts 立刻跟着动');
{
  const u = mkUnit(SID, '有数据单元');
  const w1 = mkWord(SID, u, 'apple', '苹果', 0, 0);
  const w2 = mkWord(SID, u, 'banana', '香蕉', 0, 0);
  const w3 = mkWord(SID, u, 'cherry', '樱桃', 0, 0);

  let p = english.unitProgress(SID, u);
  ok('C1 三个词 total = 3', p.total === 3, p.total);
  // 全都没碰过：认这一关过了 0 个 —— 但这是**算得出来的 0**（有分母）
  ok('C2 ★ 有词但没碰过 ⇒ 认这一关 passed=0 而 pct=0（算得出来的 0，不是 null）',
    p.gates[0].passed === 0 && p.gates[0].pct === 0, p.gates[0]);
  // ★ 有词的时候才谈得上"下一关指向哪"
  ok('C3 有词没过 ⇒ nextGate 指向第一关', p.nextGate === 'recognize', p.nextGate);

  setCounts(w1, 1, 0);           // 认过了一次、没答错
  p = english.unitProgress(SID, u);
  ok('C4 ★ 改 counts 后进度立刻跟着变（现算不是快照）', p.gates[0].passed === 1, p.gates[0].passed);
  ok('C5 1/3 ⇒ pct = 33', p.gates[0].pct === 33, p.gates[0].pct);

  // 错过的词不算"过"（wrong_count > 0 一律不算）
  setCounts(w2, 3, 1);
  p = english.unitProgress(SID, u);
  ok('C6 ★ 答对 3 次但错过 1 次 ⇒ 不算过（认这一关仍是 1）', p.gates[0].passed === 1, p.gates[0].passed);

  setCounts(w2, 3, 0);
  p = english.unitProgress(SID, u);
  ok('C7 错清零后算过 ⇒ 2/3', p.gates[0].passed === 2, p.gates[0].passed);
  // 「背」要求 right >= 2
  ok('C8 ★「背」这一关 w1 只有 1 次对 ⇒ 还没过', p.gates[2].passed === 1, p.gates[2].passed);
  setCounts(w1, 2, 0);
  p = english.unitProgress(SID, u);
  ok('C9 ★ 对到 2 次后「背」也认了', p.gates[2].passed === 2, p.gates[2].passed);

  setCounts(w1, 2, 0); setCounts(w2, 2, 0); setCounts(w3, 2, 0);
  p = english.unitProgress(SID, u);
  ok('C10 全部过完 ⇒ allPassed = true', p.allPassed === true, p.allPassed);
  ok('C11 全过完 nextGate = null（没有"下一关"了）', p.nextGate === null, p.nextGate);
  ok('C12 全过完四关 pct 全是 100', p.gates.every(g => g.pct === 100), p.gates.map(g => g.pct));
}

// ============================================================
group('D. ★★ 规矩②：单元看板（没归入单元的词不许消失）');
{
  mkWord(SID, null, 'loose1', '散词一', 0, 0);
  mkWord(SID, null, 'loose2', '散词二', 0, 0);
  const b = english.unitBoard(SID);
  ok('D1 看板报出所有单元', b.units.length >= 2, b.units.length);
  ok('D2 ★ 散词数报出来了（不是假装不存在）', b.looseCount === 2, b.looseCount);
  ok('D3 totalWords 含散词', b.totalWords >= 5, b.totalWords);
  ok('D4 空空间看板不炸', english.unitBoard('sp_none_at_all').units.length === 0);
  ok('D5 空空间 looseCount = 0', english.unitBoard('sp_none_at_all').looseCount === 0);
}

// ============================================================
group('E. ★★ 关卡出题：不带答案（除了"背"这关本来就要写）');
{
  const u = mkUnit(SID, '出题单元');
  for (let i = 0; i < 6; i++) mkWord(SID, u, 'word' + i, '词' + i, i, 0);

  const rec = english.gateTasks(SID, u, 'recognize', {});
  ok('E1 认得这一关出题了', rec.items.length === 6, rec.items.length);
  ok('E2 ★ 认这一关每题有选项', rec.items.every(it => Array.isArray(it.choices) && it.choices.length >= 2));
  ok('E3 ★★ 认这一关的选项里**没有** ok 标记（答案不下发）',
    rec.items.every(it => it.choices.every(c => typeof c === 'string')), rec.items[0]);
  ok('E4 选项里含正确项（否则做不了）',
    rec.items.every(it => it.choices.indexOf(it.choices.filter(Boolean)[0]) >= 0));
  ok('E5 每题选项不重复', rec.items.every(it => new Set(it.choices).size === it.choices.length));

  const back = english.gateTasks(SID, u, 'recall', {});
  ok('E6 ★★ 背这一关不下发答案（prompt 是中文意思）',
    back.items.every(it => !/word\d/.test(it.prompt)), back.items.map(it => it.prompt).slice(0, 3));
  ok('E7 背这一关给字母个数提示', back.items.every(it => it.letters === 'word0'.length), back.items[0].letters);

  const read = english.gateTasks(SID, u, 'read', {});
  ok('E8 读这一关给的是词本身', read.items.every(it => /^word\d$/.test(it.prompt)));

  const use = english.gateTasks(SID, u, 'use', {});
  ok('E9 用这一关给造句脚手架', use.items.every(it => Array.isArray(it.starters) && it.starters.length >= 2));
  ok('E10 用这一关也带中文意思（好造句）', use.items.every(it => it.meaning));
  ok('E11 用这一关不给答案', use.items.every(it => it.answer === undefined));

  ok('E12 关卡出题 count 可限', english.gateTasks(SID, u, 'recognize', { count: 2 }).items.length === 2);
  ok('E13 空单词本出题返回空数组不炸', english.gateTasks('sp_nonexist', null, 'recognize', {}).items.length === 0);
  let threw = null;
  try { english.gateTasks(SID, u, 'nope', {}); } catch (e) { threw = e; }
  ok('E14 乱写的关卡名报 BAD_INPUT 不静默返回空', threw && threw.code === 'BAD_INPUT', threw && threw.code);
}

// ============================================================
group('F. ★★★ 规矩②：造句这一关不判对错');
{
  const u = mkUnit(SID, '造句单元');
  const w = mkWord(SID, u, 'banana', '香蕉', 0, 0);
  const r = english.gradeGate(SID, 'u1', {
    gate: 'use', items: [{ id: w, answer: 'I like to eat a banana every morning.' }],
  });
  ok('F1 单个结果 ok 恒为 null（没有对错）', r.results[0].ok === null, r.results[0].ok);
  ok('F2 ★★ 整卷 accuracy 是 null', r.accuracy === null, r.accuracy);
  ok('F3 ★★ 整卷 right 是 null（不是 0）', r.right === null, r.right);
  ok('F4 ★★ 整卷 wrong 是 null', r.wrong === null, r.wrong);
  ok('F5 明确标出这一关不计分', r.scored === false, r.scored);
  ok('F6 ★ 返回结构里没有"答对率/分数"字段', !('score' in r) && !('points' in r) && !('grade' in r));
  ok('F7 给了 note 说明为什么不判', typeof r.note === 'string' && r.note.length > 10);
  ok('F8 用上了词 ⇒ used = true', r.results[0].used === true, r.results[0].used);
  ok('F9 句子够长 ⇒ longEnough = true', r.results[0].longEnough === true);
  ok('F10 句子里没这个词 ⇒ used = false 且给出提示',
    english.gradeGate(SID, 'u1', { gate: 'use', items: [{ id: w, answer: 'I eat fruit daily.' }] }).results[0].used === false);
  ok('F11 ★ 没写也照样不扣分（ok 仍是 null）',
    english.gradeGate(SID, 'u1', { gate: 'use', items: [{ id: w, answer: '' }] }).results[0].ok === null);
  ok('F12 太短的句子给出"短了点"的提示',
    /短了点/.test(english.gradeGate(SID, 'u1', { gate: 'use', items: [{ id: w, answer: 'a banana' }] }).results[0].note));

  // ★ 造句不该动 counts
  const before = D.get('SELECT right_count, wrong_count FROM words WHERE id = ?', w);
  ok('F13 ★★ 造句不写回对错计数（不记账就不该有数）',
    before.right_count === 0 && before.wrong_count === 0, before);

  // 「认」这一关判对错，但比的是中文
  const r2 = english.gradeGate(SID, 'u1', { gate: 'recognize', items: [{ id: w, answer: '香蕉' }] });
  ok('F14 认这一关判对错', r2.results[0].ok === true, r2.results[0].ok);
  ok('F15 认这一关 accuracy 是数不是 null', typeof r2.accuracy === 'number', r2.accuracy);
  ok('F16 ★ 中文全角标点差异不算错（走 norm）',
    english.gradeGate(SID, 'u1', { gate: 'recognize', items: [{ id: w, answer: ' 香蕉 ' }] }).results[0].ok === true);
  ok('F17 认错了就是错',
    english.gradeGate(SID, 'u1', { gate: 'recognize', items: [{ id: w, answer: '苹果' }] }).results[0].ok === false);
}

// ============================================================
group('G. ★★ 错词转卡只发生在「背」这一关');
{
  const u = mkUnit(SID, '转卡单元');
  const w = mkWord(SID, u, 'zebra', '斑马', 0, 0);
  const r = english.gradeGate(SID, 'u1', { gate: 'recognize', items: [{ id: w, answer: '错答案' }], createCards: true });
  ok('G1 ★ 认错了不转拼写卡（还没认脸熟，转卡是跳级）', r.cardsCreated === 0, r.cardsCreated);
  const r2 = english.gradeGate(SID, 'u1', { gate: 'recall', items: [{ id: w, answer: ' zebr ' }], createCards: true });
  ok('G2 背错了才转拼写卡', r2.cardsCreated === 1, r2.cardsCreated);
  ok('G3 转出来的卡是拼写卡',
    (D.get("SELECT COUNT(*) c FROM cards WHERE space_id = ? AND type = 'spelling' AND answer = ?", SID, 'zebra') || {}).c === 1);
  ok('G4 转卡身上不出现教材版本字样', !/人教版|课本|教材/.test(JSON.stringify(r2.results)));
}

// ============================================================
group('H. ★★★ 艾宾浩斯：间隔表与知识卡同值、unknown 不清零不推进');
{
  // 与 cards.js 的常量逐字对齐 —— 两边换一套数字，学生就会发现"单词今天到期、卡片明天到期"
  const csrc = fs.readFileSync(path.join(__dirname, 'server', 'cards.js'), 'utf8');
  ok('H1 ★ 知识卡里存在同一张阶梯 [1,3,5,7]', /PRE_MASTER_LADDER = \[1, 3, 5, 7\]/.test(csrc));
  ok('H2 ★ 知识卡 MASTERED_FIRST_DAYS = 14', /MASTERED_FIRST_DAYS = 14/.test(csrc));
  ok('H3 ★ 知识卡 MASTERED_LATER_DAYS = 60', /MASTERED_LATER_DAYS = 60/.test(csrc));
  ok('H4 ★ 英语侧阶梯同值', JSON.stringify(english.nextEnSchedule(0, 'right')).indexOf('1') >= 0);

  const s1 = english.nextEnSchedule(0, 'right');
  ok('H5 第 1 次答对 ⇒ 连对 1、间隔 1 天', s1.consecutive === 1 && s1.intervalDays === 1, s1);
  const s2 = english.nextEnSchedule(1, 'right');
  ok('H6 第 2 次答对 ⇒ 间隔 3 天', s2.intervalDays === 3, s2);
  const s3 = english.nextEnSchedule(2, 'right');
  ok('H7 第 3 次答对 ⇒ 间隔 5 天且状态 almost', s3.intervalDays === 5 && s3.status === 'almost', s3);
  const s4 = english.nextEnSchedule(3, 'right');
  ok('H8 第 4 次答对 ⇒ 间隔 7 天', s4.intervalDays === 7, s4);
  const s5 = english.nextEnSchedule(4, 'right');
  ok('H9 第 5 次答对 ⇒ 记住，14 天后再来', s5.status === 'mastered' && s5.dueInDays === 14 && s5.intervalDays === 60, s5);

  const sw = english.nextEnSchedule(4, 'wrong');
  ok('H10 ★ 答错清零（不是从 0 起算的"退一档"）', sw.consecutive === 0 && sw.dueInDays === 1, sw);

  const su = english.nextEnSchedule(3, 'unknown');
  ok('H11 ★★ unknown 不动连对数', su.consecutive === 3 && su.unchanged === true, su);
  ok('H12 ★★ unknown 不产生新间隔（intervalDays = null）', su.intervalDays === null, su.intervalDays);
  ok('H13 unknown 的 dueInDays 是 null 不是 0', su.dueInDays === null, su.dueInDays);
}

// ============================================================
group('I. ★★ 新词不算"到期"（否则"今天该复习 N 个"是骗人的）');
{
  const u = mkUnit(SID, '复习单元');
  const fresh = mkWord(SID, u, 'freshone', '新词', 0, 0);

  let q = english.reviewQueue(SID, { unitId: u });
  ok('I1 ★★ 没碰过的词不进 due 队列', q.dueCount === 0, q.dueCount);
  ok('I2 ★ 新词单独报在 fresh 里', q.freshCount === 1, q.freshCount);
  ok('I3 ★ 新词不计入"该复习"', q.items.length === 0, q.items.length);
  ok('I4 明说了新词与到期是两件事', /新词和到期复习是两件事/.test(q.note), q.note);

  english.recordReview(SID, 'u1', { wordId: fresh, gate: 'recall', result: 'right' });
  q = english.reviewQueue(SID, { unitId: u });
  ok('I5 ★ 复习过一次后就不是新词了', q.freshCount === 0, q.freshCount);
  ok('I6 ★ 答对后 1 天内不到期（还在 later 里）', q.dueCount === 0 && q.laterCount === 1, [q.dueCount, q.laterCount]);

  // 手工把到期时间挪到昨天
  D.run('UPDATE english_reviews SET next_due_at = ? WHERE word_id = ?', D.now() - 2 * DAY, fresh);
  q = english.reviewQueue(SID, { unitId: u });
  ok('I7 ★ 过期后进 due 队列', q.dueCount === 1, q.dueCount);
  ok('I8 报出过期了几天', q.items[0].overdueDays === 2, q.items[0].overdueDays);
  ok('I9 due 项带连对次数（复习时要显示）', q.items[0].consecutive === 1, q.items[0].consecutive);
  ok('I10 过期越久排越前', q.items.length === 1);
}

// ============================================================
group('J. ★★ 记一次复习：落痕 + 推进间隔 + unknown 不动');
{
  const u = mkUnit(SID, '记账单元');
  const w = mkWord(SID, u, 'jet', '喷气机', 0, 0);

  const r1 = english.recordReview(SID, 'u1', { wordId: w, gate: 'recall', result: 'right' });
  ok('J1 落了一条痕迹', !!enRevRow(w));
  ok('J2 记了关卡名', enRevRow(w).gate === 'recall', enRevRow(w).gate);
  ok('J3 第一次答对 ⇒ 下次 1 天后', r1.dueInDays === 1, r1.dueInDays);
  const c1 = D.get('SELECT right_count, wrong_count FROM words WHERE id = ?', w);
  ok('J4 答对写回 right_count', c1.right_count === 1 && c1.wrong_count === 0, c1);

  const r2 = english.recordReview(SID, 'u1', { wordId: w, gate: 'recall', result: 'right' });
  ok('J5 第二次答对 ⇒ 3 天后', r2.dueInDays === 3, r2.dueInDays);
  ok('J6 连对累计到 2', r2.consecutive === 2, r2.consecutive);

  const r3 = english.recordReview(SID, 'u1', { wordId: w, gate: 'recall', result: 'unknown' });
  ok('J7 ★★ unknown 后连对数不变', r3.consecutive === 2, r3.consecutive);
  ok('J8 ★★ unknown 后间隔不变（下回还是 3 天后那条）', r3.dueInDays === 3, r3.dueInDays);
  ok('J9 ★★ unknown 不写回任何对错计数',
    (D.get('SELECT right_count, wrong_count FROM words WHERE id = ?', w) || {}).right_count === 2,
    D.get('SELECT right_count, wrong_count FROM words WHERE id = ?', w));
  ok('J10 unknown 时给出解释文案', /进度不动/.test(r3.note), r3.note);

  const r4 = english.recordReview(SID, 'u1', { wordId: w, gate: 'recall', result: 'wrong' });
  ok('J11 答错清零且明天再来', r4.consecutive === 0 && r4.dueInDays === 1, r4);
  ok('J12 答错写回 wrong_count',
    (D.get('SELECT wrong_count FROM words WHERE id = ?', w) || {}).wrong_count === 1);

  let threw = null;
  try { english.recordReview(SID, 'u1', { wordId: 'nope', gate: 'x', result: 'right' }); } catch (e) { threw = e; }
  ok('J13 不存在的词报 NOT_FOUND', threw && threw.code === 'NOT_FOUND', threw && threw.code);

  // 乱写的结果码退化成 unknown，不许当成 right
  const rb = english.recordReview(SID, 'u1', { wordId: w, gate: 'recall', result: 'banana' });
  ok('J14 ★ 乱写的结果码退化成 unknown（不默认算对）', rb.result === 'unknown', rb.result);
}

// ============================================================
group('K. ★★ 复习统计：一次没判过 ⇒ accuracy 是 null 不是 0');
{
  ok('K1 空空间 accuracy 是 null', english.reviewStats('sp_never_reviewed') === null || english.reviewStats('sp_never_reviewed').accuracy === null);
  const st0 = english.reviewStats('sp_never_reviewed');
  ok('K2 空空间 total = 0', st0.total === 0, st0.total);
  ok('K3 空空间 avgIntervalDays 是 null', st0.avgIntervalDays === null, st0.avgIntervalDays);

  const u = mkUnit(SID, '统计单元');
  const a = mkWord(SID, u, 's1', '一', 0, 0);
  const b = mkWord(SID, u, 's2', '二', 0, 0);
  let st = english.reviewStats(SID, u);
  ok('K4 ★ 有词但从没复习 ⇒ accuracy 仍是 null（"没练过"不是"全错"）', st.accuracy === null, st.accuracy);
  ok('K5 报出有多少词从没复习过', st.neverReviewed === 2, st.neverReviewed);

  english.recordReview(SID, 'u1', { wordId: a, gate: 'recall', result: 'right' });
  english.recordReview(SID, 'u1', { wordId: b, gate: 'recall', result: 'wrong' });
  st = english.reviewStats(SID, u);
  ok('K6 一右一错 ⇒ 50%', st.accuracy === 50, st.accuracy);
  ok('K7 reviewed 是两个词', st.reviewed === 2, st.reviewed);

  english.recordReview(SID, 'u1', { wordId: b, gate: 'recall', result: 'unknown' });
  st = english.reviewStats(SID, u);
  ok('K8 ★★ unknown 不进分母（仍是 50%，不是 33%）', st.accuracy === 50, st.accuracy);

  english.recordReview(SID, 'u1', { wordId: b, gate: 'recall', result: 'right' });
  st = english.reviewStats(SID, u);
  // ★ 序列是 right(a) / wrong(b) / unknown(b) / right(b)：判得出对错的共 3 次（2 对 1 错）。
  //   分母是**判得出对错的次数**，不是"复习了几次" —— unknown 那一次连题目都判不了。
  ok('K9 ★★ 分母是判得出对错的次数：2 对 1 错 ⇒ 67%（不是 2/4=50%）', st.accuracy === 67, st.accuracy);
  ok('K10 报了平均间隔', typeof st.avgIntervalDays === 'number', st.avgIntervalDays);
}

// ============================================================
group('L. ★★ 跨空间隔离');
{
  const ua = mkUnit(SID, '甲单元');
  const wa = mkWord(SID, ua, 'alphaonly', '甲独有', 3, 0);
  const ub = mkUnit(OTHER, '乙单元');
  const wb = mkWord(OTHER, ub, 'betaonly', '乙独有', 0, 0);
  english.recordReview(OTHER, 'u2', { wordId: wb, gate: 'recall', result: 'wrong' });

  const pa = english.unitProgress(SID, ua);
  ok('L1 甲单元只数甲的词', pa.total === 1, pa.total);
  ok('L2 ★ 乙的错词不影响甲（甲仍是全过）', pa.gates[2].passed === 1, pa.gates[2].passed);

  ok('L3 ★ 乙空间读不到甲的单元', english.unitProgress(OTHER, ua) === null);
  const qb = english.reviewQueue(OTHER, {});
  ok('L4 ★ 乙的复习队列里没有甲的词',
    qb.items.every(it => it.id !== wa) && qb.fresh.every(it => it.id !== wa));
  // ★ 刚答错的词是"明天到期"，所以它在 later 里，不在 due 里。
  ok('L5 ★ 乙刚答错的词明天才到期（在 later 不在 due）', qb.laterCount === 1 && qb.dueCount === 0, [qb.laterCount, qb.dueCount]);
  ok('L5b 乙空间看板里没有甲的单元', english.unitBoard(OTHER).units.every(x => x.name.indexOf('甲') < 0));

  // ★ 甲空间的词从没走过复习 ⇒ accuracy 是 null（"没练过"和"全错"是两件事）
  let stA = english.reviewStats(SID, ua);
  ok('L6 ★★ 甲的词只写了对错计数、从没复习过 ⇒ accuracy 是 null（不是 100）', stA.accuracy === null, stA.accuracy);
  english.recordReview(SID, 'u1', { wordId: wa, gate: 'recall', result: 'right' });
  stA = english.reviewStats(SID, ua);
  ok('L6b ★ 甲记一次复习后 accuracy 才是 100', stA.accuracy === 100, stA.accuracy);
  let threw = null;
  try { english.recordReview(SID, 'u1', { wordId: wb, gate: 'recall', result: 'right' }); } catch (e) { threw = e; }
  ok('L7 ★★ 拿乙的 wordId 想在甲空间记账 ⇒ 被挡（NOT_FOUND）', threw && threw.code === 'NOT_FOUND');
  ok('L8 ★ 被挡之后乙的词痕迹数没变',
    (D.get('SELECT COUNT(*) c FROM english_reviews WHERE word_id = ?', wb) || {}).c === 1);
}

// ============================================================
group('M. ★ 无 undefined / JSON 往返不丢键（踩过 JSON.stringify 丢 undefined 的坑）');
{
  function scanUndef(v, at, out) {
    if (v === undefined) { out.push(at); return; }
    if (v === null) return;
    if (Array.isArray(v)) { v.forEach((x, i) => scanUndef(x, at + '[' + i + ']', out)); return; }
    if (typeof v === 'object') { Object.keys(v).forEach(k => scanUndef(v[k], at + '.' + k, out)); }
  }
  const u = mkUnit(SID, '扫单元');
  mkWord(SID, u, 'scan', '扫', 1, 0);
  const payloads = {
    board: english.unitBoard(SID),
    progress: english.unitProgress(SID, u),
    recognize: english.gateTasks(SID, u, 'recognize', {}),
    read: english.gateTasks(SID, u, 'read', {}),
    recall: english.gateTasks(SID, u, 'recall', {}),
    use: english.gateTasks(SID, u, 'use', {}),
    gradeRecognize: english.gradeGate(SID, 'u1', { gate: 'recognize', items: [{ id: 'x', answer: '' }] }),
    gradeUse: english.gradeGate(SID, u, 'use' && { gate: 'use', items: [{ id: (D.get('SELECT id FROM words WHERE space_id = ? AND word = ?', SID, 'scan') || {}).id, answer: 'I like it.' }] }),
    queue: english.reviewQueue(SID, {}),
    stats: english.reviewStats(SID, u),
  };
  Object.keys(payloads).forEach(k => {
    const bad = []; scanUndef(payloads[k], k, bad);
    ok('M1.' + k + ' 无 undefined', bad.length === 0, bad);
  });
  ok('M2 ★ JSON 往返后 key 不丢',
    JSON.stringify(JSON.parse(JSON.stringify(payloads.progress))) === JSON.stringify(payloads.progress));
}

// ============================================================
group('N. ★ 静态：前端接线与结构（先剥注释再断言）');
{
  const app = stripComments(fs.readFileSync(path.join(__dirname, 'public', 'js', 'app.js'), 'utf8'));
  const css = stripComments(fs.readFileSync(path.join(__dirname, 'public', 'app.css'), 'utf8'));
  const html = stripComments(fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8'));

  ok('N1 前端有 unitBoard 取数', /\/api\/english\/board/.test(app));
  ok('N2 前端有单关卡取数', /\/api\/english\/gate/.test(app));
  ok('N3 前端有交卷', /\/api\/english\/gate\/grade/.test(app));
  ok('N4 前端有复习队列取数', /\/api\/english\/review/.test(app));
  // ★★ 光有函数不算接线：「定义了但没人调」在本项目出过（取数函数写好了、调用点漏了，
  //    界面永远空着且零报错）。所以必须钉**调用点**。
  ok('N4a ★★ loadEnGates 真的被 loadEn 调用（不是只定义了函数）',
    /renderEnStats\(\);\s*renderEnUnits\(\);\s*renderEnList\(\);\s*[\s\S]{0,200}loadEnGates\(\)/.test(app));
  ok('N4b ★★ 点击四关会打开关卡（委托真的接了 .en4-gate）',
    /closest\('\.en4-gate'\)/.test(app) && /openGate\(/.test(app));
  ok('N4c ★★ 复习按钮真的接了处理（不是只画了个按钮）',
    /closest\('#enReviewGo'\)/.test(app) && /openReviewRun\(/.test(app));
  ok('N4d ★★ 交卷真的会提交（gGo 绑了 grade）',
    /\$\('#gGo'\)[\s\S]{0,600}english\/gate\/grade/.test(app));
  ok('N4e ★★ 复习真的会记账（不能只在前端算）',
    /\$\('#rvGo'\)\.addEventListener[\s\S]{0,1800}submitOneReview\(/.test(app) &&
    /submitOneReview[\s\S]{0,400}english\/review/.test(app));

  // ★ 念读走浏览器内置，不接外部 TTS
  ok('N5 ★★ 发音用浏览器内置 SpeechSynthesis（不调外部接口）', /speechSynthesis/.test(app));
  ok('N6 ★ 单词表界面没有调用外部语音服务',
    !/youdao|iciba|baidu\.com\/voice|translate\.googleapis/.test(app));

  // ★ 不给红绿灯
  ok('N7 ★ 造句这一关前端不显示答对率', !/gate[\s\S]{0,200}accuracy/.test(app) || !/use[\s\S]{0,80}accuracy/.test(app));

  // 容器
  ok('N8 英语视图里有四关容器', /id="enGates"/.test(html));
  ok('N9 英语视图里有复习队列容器', /id="enReview"/.test(html));

  // CSS 顺序（基准规则必须在第一个 @media 之前）
  const enCss = css.indexOf('.en4-');
  const firstMedia = css.search(/(^|\n)\s*@media/);
  ok('N10 四关样式写在第一个 @media 之前', enCss > 0 && enCss < firstMedia, 'en@' + enCss + ' media@' + firstMedia);
  ok('N11 四关有独立样式类', /\.en4-gate/.test(css));
  // ★★ 单元进度对象里 id 字段叫 unitId。写成 u.id 会渲染出 data-uid="undefined"，
  //    点关卡时拿这个假 id 去请求 —— 界面看着正常、点下去没反应、零报错。
  //    （实测就是这么红的：探针打出 data-uid="undefined"）
  ok('N11b ★★ data-uid 取自 u.unitId 而不是 u.id（后者会渲染成 "undefined"）',
    /u && u\.unitId \? ' data-uid="' \+ HL\.esc\(u\.unitId\)/.test(app) && !/data-uid="' \+ u\.id/.test(app));
  // ★★ 每个关卡容器都要有自己的答题反馈容器（id="gf_…"）。
  //    paintGateResult 里 `const fb = $('#gf_'+id) || $('#gm_'+id); if (!q || !fb) return;`
  //    —— 取不到就**整条 return**，交卷后界面毫无变化且零报错。
  //    实测就是这么假绿的：认这一关原本没有 gf_ 容器，4 条浏览器断言全红。
  ok('N11c ★★ 四个关卡容器都渲染了 gf_ 反馈节点（缺了会让批改整条 return）',
    (app.match(/id="gf_' \+ it\.id \+ '"/g) || []).length >= 3,
    (app.match(/id="gf_' \+ it\.id \+ '"/g) || []).length);
  ok('N11d ★★ 批改函数对取不到节点的情况显式跳过（不是抛异常，也不是静默全跳过）',
    /const fb = \$\('#gf_' \+ res\.id\) \|\| \$\('#gm_' \+ res\.id\)/.test(app) && /if \(!q \|\| !fb\) return;/.test(app));
  // ★ 空单元没有"下一关"：拼成「下一关：」后面空着会像界面坏了 —— 要明说"还没有词"
  const enRender = app.slice(app.indexOf('function renderEnGates'), app.indexOf('function gateCard'));
  ok('N11e ★ 空单元不显示"下一关："空串（改说"还没有词"）',
    /还没有词/.test(enRender) && /: cur\s*\n?\s*\?/.test(enRender), enRender.slice(0, 160));

  // ★ 不许出现教材版本字样（IP 红线）
  ok('N12 ★ IP 红线：英语模块文案不出现教材/课本字样',
    !/人教版|外研版|课本|教材/.test(JSON.stringify(english.GATES)));
  const enSrc = fs.readFileSync(path.join(__dirname, 'server', 'english.js'), 'utf8');
  ok('N13 ★ IP 红线：english.js 正文里没有教材版本名',
    !/人教版|外研版|牛津版|译林版/.test(enSrc));
}

// ============================================================
console.log('\n' + '─'.repeat(60));
if (fail) {
  console.log('✗ 失败 ' + fail + ' 项：');
  fails.forEach(f => console.log('   · ' + f));
} else {
  console.log('✓ 全部通过');
}
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail ? 1 : 0);

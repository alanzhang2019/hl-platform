'use strict';
/**
 * 批次3 自检（模块级）：知识卡深度。
 *
 * 对齐 §5 的规则：连续答对 5 次 = 已掌握；答错第二天再来（1 天）；
 * 已掌握后 14 天再来考考你、再对 → 60 天；自由练习不计入复习计划；
 * 复习计划（今天/明天/待更新）；学习进度规则文案；每日生成额度；
 * AI 主动提醒收卡（草稿）；提示隐藏泄题；理解核对只核对要点。
 *
 * 直接打 cards.js / db.js，不起服务。LLM 通道全部用桩。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hl-p3-'));
process.env.DATA_DIR = TMP;
process.env.NO_DOTENV = '1';
delete process.env.LLM_API_KEY;

let pass = 0, fail = 0;
const fails = [];
function ok(cond, name, extra) {
  if (cond) { pass++; }
  else { fail++; fails.push(name + (extra !== undefined ? ' → ' + JSON.stringify(extra) : '')); }
}
async function rejects(fn, code, name) {
  try { await fn(); fail++; fails.push(name + ' → 期望抛 ' + code + '，实际没抛'); }
  catch (e) { ok(e.code === code, name, { got: e.code, msg: e.message }); }
}

const D = require('./server/db');
const core = require('./server/core');
const cards = require('./server/cards');
const llm = require('./server/llm');
const auth = require('./server/auth');

// 桩：需要时替换 LLM 返回
function mockJSON(obj) { llm.completeJSON = async () => obj; }
function mockComplete(str) { llm.complete = async () => str; }

const DAY = 24 * 60 * 60 * 1000;
const sid = '0001';
const uid = 'u_p3';

(async () => {
  auth.ensureDefaultSpace();

  // ---------- 1. schema：新列到位 ----------
  const cardCols = D.all('PRAGMA table_info(cards)').map(c => c.name);
  ['consecutive_right', 'plan'].forEach(c => ok(cardCols.indexOf(c) >= 0, 'cards 新列：' + c));
  const revCols = D.all('PRAGMA table_info(card_reviews)').map(c => c.name);
  ok(revCols.indexOf('is_free') >= 0, 'card_reviews 新列：is_free');

  // ---------- 2. 建卡初始态 ----------
  const c0 = cards.create(sid, uid, { knowledge: '勾股定理', type: 'choice', question: '直角三角形斜边?', answer: 'c²=a²+b²', options: { choices: ['c²=a²+b²', 'a²=b²+c²', 'a+b=c', 'abc'], answerIndex: 0 } });
  ok(c0.stage === 0 && c0.consecutiveRight === 0, '新卡 stage/consecutive 为 0', { stage: c0.stage, cr: c0.consecutiveRight });
  ok(c0.plan === 'scheduled', '新卡 plan=scheduled');
  ok(c0.overdue === true, '新卡立即到期');
  ok(c0.status === 'learning' && c0.statusLabel === '学习中', '新卡状态 学习中');

  // ---------- 3. 连续答对 5 次 = 已掌握 ----------
  const seq = [];
  for (let i = 0; i < 5; i++) {
    const r = cards.review(sid, uid, c0.id, { result: 'right', studentAnswer: 'c²=a²+b²' });
    seq.push({ stage: r.card.stage, status: r.card.status, cr: r.card.consecutiveRight, iv: r.intervalDays });
  }
  ok(seq[4].status === 'mastered', '第 5 次答对即已掌握', seq[4]);
  ok(seq[4].cr === 5, '连续答对计数 = 5', seq[4]);
  ok(seq[4].iv === 14, '刚掌握间隔 14 天（§5：14 天后再来考考你）', seq[4]);
  ok(seq.every((s, i) => i === 0 || s.cr >= seq[i - 1].cr), '连续计数单调不减');

  // 已掌握后再核对（对）→ 60 天
  const r6 = cards.review(sid, uid, c0.id, { result: 'right', studentAnswer: '对' });
  ok(r6.card.status === 'mastered' && r6.intervalDays === 60, '已掌握再核对 → 60 天（§5：60 天后再来看看）', { st: r6.card.status, iv: r6.intervalDays });
  const r7 = cards.review(sid, uid, c0.id, { result: 'right', studentAnswer: '对' });
  ok(r7.intervalDays === 60, '再次核对仍 60 天');

  // ---------- 4. 已掌握答错 → 退回学习中（§5：答错第二天再来）----------
  const w = cards.review(sid, uid, c0.id, { result: 'wrong', studentAnswer: '错' });
  ok(w.card.status === 'learning' && w.card.stage === 0 && w.card.consecutiveRight === 0, '已掌握答错退回学习中、计数归零', { st: w.card.status, stage: w.card.stage, cr: w.card.consecutiveRight });
  ok(w.intervalDays === 1, '答错间隔 1 天（第二天）', w.intervalDays);
  ok(/明天|第二天|1 天/.test(w.message), '答错文案含"明天/第二天"', w.message);

  // 学习中答错也不清零式保留（保持 learning）
  const c1 = cards.create(sid, uid, { knowledge: '二次方程求根', type: 'understanding', question: '说说求根公式', answer: 'x=(-b±√(b²-4ac))/2a' });
  const w1 = cards.review(sid, uid, c1.id, { result: 'wrong', studentAnswer: '不会' });
  ok(w1.card.status === 'learning' && w1.card.stage === 0, '学习中答错保持 learning/stage0');

  // ---------- 5. unknown 不改调度 ----------
  const u = cards.review(sid, uid, c1.id, { result: 'unknown' });
  ok(u.card.stage === 0 && u.card.consecutiveRight === 0 && u.card.status === 'learning', 'unknown 不改档');
  ok(u.unchanged === true, 'unknown 标记 unchanged');
  ok(/没有记为答错/.test(u.message), 'unknown 文案说明没记为答错', u.message);
  ok(u.card.reviewCount >= 2, 'unknown 也计入 review 次数（保留作答）', u.card.reviewCount);

  // ---------- 6. 自由练习：不计入复习计划 ----------
  const before = cards.getCard(sid, c1.id);
  const fp = cards.freePractice(sid, uid, c1.id, { result: 'right', studentAnswer: '我试着答了' });
  const after = cards.getCard(sid, c1.id);
  ok(fp.free === true, '自由练习标记 free');
  ok(after.status === before.status && after.stage === before.stage && after.consecutiveRight === before.consecutiveRight && after.dueAt === before.dueAt,
    '自由练习不改 status/stage/计数/due', { b: before, a: after });
  ok(after.freeCount >= 1, '自由练习计入 freeCount', after.freeCount);
  ok(after.reviewCount > before.reviewCount, '自由练习也留痕（reviewCount 增加）');

  // ---------- 7. 复习计划管理：今天/明天/待更新 ----------
  // ★ 这里必须**先取一次 now** 再比较：#setPlan 内部用的是它自己那一刻的 D.now()，
  //   而断言若再去调 D.now()（尤其是 {due, now} 里又调一次），两次调用之间的漂移
  //   在磁盘吃紧的机器上能到几秒 ⇒ 公差 ±2000ms 会被打穿，报成"推后约 1 天"失败。
  const nowT = D.now();
  const tp = cards.setPlan(sid, c1.id, 'today');
  ok(tp.dueAt <= nowT + 3000 && tp.plan === 'scheduled', '今天再练 → 立即到期', { due: tp.dueAt, now: nowT });
  const tm = cards.setPlan(sid, c1.id, 'tomorrow');
  ok(tm.dueAt >= nowT + DAY - 5000 && tm.dueAt <= nowT + DAY + 5000, '明天再练 → 推后约 1 天', { due: tm.dueAt, now: nowT, delta: tm.dueAt - nowT });
  const pd = cards.setPlan(sid, c1.id, 'pending');
  ok(pd.plan === 'pending', '复习时间待更新 → plan=pending');
  const pdCard = cards.getCard(sid, c1.id);
  ok(pdCard.overdue === false, 'pending 卡不算逾期');
  const dueList = cards.list(sid, { status: 'due' });
  ok(!dueList.items.some(it => it.id === c1.id), '到期列表排除 plan=pending 的卡');
  const reset = cards.setPlan(sid, c1.id, 'reset');
  ok(reset.plan === 'scheduled', 'reset 回到 scheduled');
  await rejects(() => cards.setPlan(sid, c1.id, 'nonsense'), 'BAD_INPUT', '未知 plan 操作被拒');

  // ---------- 8. 学习进度规则文案 ----------
  const rl = cards.rules();
  ok(rl.title && Array.isArray(rl.points) && rl.points.length >= 4, 'rules 返回标题+要点');
  ok(rl.points.some(p => /5 次/.test(p)), '规则含"连续答对 5 次"', rl.points);
  ok(rl.points.some(p => /14 天/.test(p)) && rl.points.some(p => /60 天/.test(p)), '规则含 14 天 / 60 天');

  // ---------- 9. 每日生成额度 ----------
  const el0 = cards.eligibility(sid);
  ok(el0.eligible === true && el0.limit > 0 && el0.used === 0 && el0.remaining === el0.limit, '初始额度可用、remaining=limit', el0);
  ok(el0.resetAt > D.now(), 'resetAt 在未来');

  // ---------- 10. AI 主动提醒收卡（草稿，不落库）----------
  mockJSON([
    { knowledge: '质数', type: 'choice', question: '哪个是质数?', answer: '7', options: ['7', '8', '9', '10'], answerIndex: 0 },
    { knowledge: '光合作用', type: 'understanding', question: '说说光合作用', answer: '植物用光能合成有机物' },
  ]);
  const beforeTotal = cards.list(sid, { status: 'all' }).total;
  const sug = await cards.suggest(sid, uid, { text: '我们学了质数和光合作用', count: 3 });
  ok(Array.isArray(sug.drafts) && sug.drafts.length === 2, 'suggest 返回 2 条草稿', sug);
  ok(sug.drafts[0].type === 'choice' && sug.drafts[0].options && sug.drafts[0].options.answerIndex === 0, '草稿含卡型与选项');
  ok(cards.list(sid, { status: 'all' }).total === beforeTotal, 'suggest 不自动建卡（仅草稿）');

  // 真正生成会落库并扣额度
  const made = await cards.generateFromText(sid, uid, { text: '我们学了质数和光合作用', count: 3 });
  ok(made.length === 2, 'generateFromText 落库 2 张', made.length);
  const el1 = cards.eligibility(sid);
  ok(el1.used === 2, '生成后额度 used=2', el1);
  ok(el1.remaining === el0.limit - 2, '生成后 remaining 减少');

  // ---------- 11. 提示系统：隐藏泄题 ----------
  const cLeak = cards.create(sid, uid, { knowledge: '计算 6×7', type: 'choice', question: '6×7=?', answer: '42', options: { choices: ['42', '48', '36', '49'], answerIndex: 0 } });
  mockComplete('答案是 42，记得乘法表');   // 泄题
  const hLeak = await cards.hint(sid, cLeak.id);
  ok(hLeak.hidden === true && hLeak.reason === 'leaked', '提示含答案 → 隐藏（reason=leaked）', hLeak);
  mockComplete('想想 6 个 7 相加是多少');     // 安全且 ≤25 字
  const hOk = await cards.hint(sid, cLeak.id);
  ok(hOk.hidden === false && hOk.hint.length <= 25 && hOk.hint.indexOf('42') < 0, '安全提示给出且不超 25 字、不含答案', hOk);

  // ---------- 12. 理解核对：只核对要点 ----------
  const cU = cards.create(sid, uid, { knowledge: '水的沸点', type: 'understanding', question: '说说水的沸点', answer: '标准大气压下 100℃' });
  // solid → 算答对，推进
  mockJSON({ verdict: 'solid', covered: ['100℃'], missing: [], comment: '说到了要点' });
  const uSolid = await cards.checkUnderstanding(sid, cU.id, '水在标准大气压下烧开是 100 度');
  ok(uSolid.verdict === 'solid', '理解核对返回 solid');
  const cSolid = await cards.completeUnderstanding(sid, uid, cU.id, '水在标准大气压下烧开是 100 度', uSolid);
  ok(cSolid.card.consecutiveRight === 1 && cSolid.card.status === 'learning', 'solid 算答对推进', { cr: cSolid.card.consecutiveRight, st: cSolid.card.status });
  // off → 算答错，退回
  mockJSON({ verdict: 'off', covered: [], missing: ['温度'], comment: '有偏差' });
  const uOff = await cards.checkUnderstanding(sid, cU.id, '水的沸点是 50 度');
  const cOff = await cards.completeUnderstanding(sid, uid, cU.id, '水的沸点是 50 度', uOff);
  ok(cOff.card.consecutiveRight === 0 && cOff.card.status === 'learning', 'off 算答错退回', { cr: cOff.card.consecutiveRight, st: cOff.card.status });
  // unknown → 不算错
  mockJSON(null);
  const uUn = await cards.checkUnderstanding(sid, cU.id, '水会烧开');
  const cUn = await cards.completeUnderstanding(sid, uid, cU.id, '水会烧开', uUn);
  ok(cUn.card.consecutiveRight === 0 && cUn.unchanged === true, 'unknown 不算错、不改档', { cr: cUn.card.consecutiveRight });

  // ---------- 13. 我已经会了 → 推迟 14 天，可撤销 ----------
  const cK = cards.create(sid, uid, { knowledge: '九九乘法表', type: 'spelling', question: '背一遍', answer: '一一得一' });
  const sk = cards.selfKnown(sid, cK.id);
  ok(sk.card.status === 'retired', 'self-known → retired（无需再复习）');
  ok(sk.card.dueAt > D.now() + 13 * DAY, 'self-known 推迟约 14 天', { due: sk.card.dueAt, now: D.now() });
  ok(sk.deferDays === 14, 'deferDays=14');
  const un = cards.undoSelfKnown(sid, cK.id, sk.previous);
  ok(un.status === 'learning' && un.stage === 0, '撤销 self-known → 回到 learning');

  // ---------- 14. 跨空间隔离 ----------
  const sidB = '0002';
  auth.ensureDefaultSpace();
  // 用另一个 space 的计数应独立
  const sumA = cards.summary(sid);
  const sumB = cards.summary(sidB);
  ok(sumB.total === 0, 'B 空间看不到 A 的知识卡', { a: sumA.total, b: sumB.total });
  await rejects(() => cards.review(sidB, uid, c0.id, { result: 'right' }), 'NOT_FOUND', 'B 空间不能改 A 的卡');

  console.log('PASS  通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  if (fails.length) { console.log('失败项：'); fails.forEach(f => console.log('  ✗ ' + f)); }
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('自检崩溃：', e); process.exit(2); });

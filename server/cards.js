'use strict';
/**
 * 知识卡：教育内核
 *
 * 用词约定（这是产品价值观，不是文案技巧）：
 *   不说"错题"，说"需要调整的理解"；不说"你错了"，说"这里有一点理解偏差"。
 *
 * 三个关键设计：
 *   1. 艾宾浩斯间隔推进，答对进一档、答错退回一档（不是清零，避免挫败）
 *   2. 理解题的 AI 核对**只核对要点，不要求背原句**；判断不了时记为 unknown，**不算答错**
 *   3. 提示单条 ≤25 字，且自动隐藏可能泄题的内容；生成不出来就坦白说"先自己试试看"
 */
const D = require('./db');
const core = require('./core');
const llm = require('./llm');
const subjects = require('./subjects');

const DAY = 24 * 60 * 60 * 1000;
const MASTER_THRESHOLD = 5;                 // §5：连续答对 5 次 = 已掌握
const WRONG_DAYS = 1;                       // §5：答错的卡，第二天会再来
const MASTERED_FIRST_DAYS = 14;             // §5：已掌握后，14 天再来考考你
const MASTERED_LATER_DAYS = 60;             // §5：之后每 60 天再看一次
const PRE_MASTER_LADDER = [1, 3, 5, 7];     // 未掌握时连续答对 1..4 次的间隔（天）
const SELF_KNOWN_DEFER_DAYS = 14;           // "我已经会了" → 14 天后再核对一次
const HINT_MAX_CHARS = 25;
const DAILY_GEN_LIMIT = 20;                  // 每日 AI 生成卡片额度

const STATUS = { learning: '学习中', almost: '快记住了', mastered: '已掌握', retired: '无需再复习' };

// §5 对齐：连续答对 5 次即"已掌握"；答错第二天再来（不保留虚假进度）；
// 已掌握后答对一次 → 60 天，答错 → 退回学习中。
function nextSchedule(card, result, isFree) {
  if (isFree) return { free: true };
  const wasMastered = card.status === 'mastered';
  let consecutive = Number(card.consecutive_right) || 0;
  if (result === 'unknown') {
    return { unchanged: true, status: card.status, stage: Number(card.stage) || 0, consecutive, dueDays: null };
  }
  let status, stage, dueDays;
  if (result === 'wrong') {
    consecutive = 0; status = 'learning'; stage = 0; dueDays = WRONG_DAYS;
  } else {                                  // right
    consecutive += 1;
    if (wasMastered) { status = 'mastered'; stage = MASTER_THRESHOLD; dueDays = MASTERED_LATER_DAYS; }
    else if (consecutive >= MASTER_THRESHOLD) { status = 'mastered'; stage = MASTER_THRESHOLD; dueDays = MASTERED_FIRST_DAYS; }
    else { status = consecutive >= 3 ? 'almost' : 'learning'; stage = consecutive; dueDays = PRE_MASTER_LADDER[consecutive - 1] || 1; }
  }
  return { free: false, unchanged: false, status, stage, consecutive, dueDays };
}

function getRaw(spaceId, id) {
  return D.get('SELECT * FROM cards WHERE id = ? AND space_id = ?', id, spaceId);
}

function shape(c) {
  const last = D.get('SELECT * FROM card_reviews WHERE card_id = ? ORDER BY reviewed_at DESC LIMIT 1', c.id);
  const plan = c.plan || 'scheduled';
  const isPending = plan === 'pending';
  let intervalDays = last ? last.interval_days : (c.status === 'mastered' ? MASTERED_FIRST_DAYS : 1);
  if (c.status === 'retired' || isPending) intervalDays = null;
  return {
    id: c.id,
    knowledge: c.knowledge,
    question: c.question,
    answer: c.answer,
    type: c.type,
    subject: c.subject || '',
    options: c.options_json ? core.safeJSON(c.options_json) : null,
    status: c.status,
    statusLabel: STATUS[c.status] || c.status,
    stage: c.stage,
    consecutiveRight: Number(c.consecutive_right) || 0,
    plan,
    intervalDays,
    dueAt: c.due_at,
    overdue: !isPending && c.status !== 'retired' && c.due_at <= D.now(),
    lastReviewedAt: c.last_reviewed_at,
    lastResult: last ? last.result : null,
    lastIntervalDays: last ? last.interval_days : null,
    reviewCount: (D.get('SELECT COUNT(*) c FROM card_reviews WHERE card_id = ?', c.id) || {}).c || 0,
    freeCount: (D.get('SELECT COUNT(*) c FROM card_reviews WHERE card_id = ? AND is_free = 1', c.id) || {}).c || 0,
    createdAt: c.created_at,
  };
}

function list(spaceId, { status, q, sort, page, pageSize, subject } = {}) {
  let sql = 'SELECT * FROM cards WHERE space_id = ?';
  const p = [spaceId];
  if (subject && subject !== 'all') { sql += ' AND subject = ?'; p.push(subject); }
  if (status && status !== 'all') {
    if (status === 'due') { sql += ' AND status != ? AND plan != ? AND due_at <= ?'; p.push('retired', 'pending', D.now()); }
    else { sql += ' AND status = ?'; p.push(status); }
  }
  if (q) { sql += ' AND (knowledge LIKE ? OR question LIKE ?)'; p.push('%' + q + '%', '%' + q + '%'); }
  const order = sort === 'created' ? 'created_at DESC'
    : sort === 'knowledge' ? 'knowledge ASC'
      : 'due_at ASC';                                    // 默认：最早到期优先
  sql += ' ORDER BY ' + order;
  const rows = D.all(sql, ...p).map(shape);
  const size = Math.max(1, Math.min(100, Number(pageSize) || 20));
  const total = rows.length;
  const pg = Math.max(1, Number(page) || 1);
  return { items: rows.slice((pg - 1) * size, pg * size), total, page: pg, pageSize: size, pages: Math.ceil(total / size) || 1 };
}

function summary(spaceId) {
  const g = (sql, ...p) => (D.get(sql, spaceId, ...p) || {}).c || 0;
  const now = D.now();
  return {
    total: g('SELECT COUNT(*) c FROM cards WHERE space_id = ?'),
    due: g('SELECT COUNT(*) c FROM cards WHERE space_id = ? AND status != ? AND plan != ? AND due_at <= ?', 'retired', 'pending', now),
    learning: g('SELECT COUNT(*) c FROM cards WHERE space_id = ? AND status = ?', 'learning'),
    almost: g('SELECT COUNT(*) c FROM cards WHERE space_id = ? AND status = ?', 'almost'),
    mastered: g('SELECT COUNT(*) c FROM cards WHERE space_id = ? AND status = ?', 'mastered'),
    retired: g('SELECT COUNT(*) c FROM cards WHERE space_id = ? AND status = ?', 'retired'),
  };
}

function getCard(spaceId, id) {
  const c = D.get('SELECT * FROM cards WHERE id = ? AND space_id = ?', id, spaceId);
  return c ? shape(c) : null;
}

function create(spaceId, userId, data) {
  const knowledge = String(data.knowledge || '').trim();
  if (!knowledge) { const e = new Error('知识点不能为空'); e.code = 'BAD_INPUT'; throw e; }
  const id = D.uid('k_');
  const type = ['choice', 'spelling', 'understanding'].indexOf(data.type) >= 0 ? data.type : 'choice';
  // 学科白名单来自 server/subjects.js —— 以前这里硬写了一份，加学科必漏。
  // fallback 传 ''：建卡时没选学科就留空，不要假装是"综合"。
  const subject = subjects.normSubject(data.subject, '');
  D.run(`INSERT INTO cards(id,space_id,user_id,knowledge,question,answer,type,options_json,subject,status,stage,consecutive_right,plan,due_at,
                           source_conversation_id,source_message_id,created_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id, spaceId, userId || null, knowledge.slice(0, 200),
    String(data.question || '').slice(0, 1000), String(data.answer || '').slice(0, 2000), type,
    data.options ? JSON.stringify(data.options) : null, subject,
    'learning', 0, 0, 'scheduled', D.now(), data.sourceConversationId || null, data.sourceMessageId || null, D.now());
  core.logActivity(spaceId, userId, 'card_created', id, { knowledge });
  return getCard(spaceId, id);
}

function remove(spaceId, id) {
  const c = D.get('SELECT 1 FROM cards WHERE id = ? AND space_id = ?', id, spaceId);
  if (!c) return false;
  D.run('DELETE FROM card_reviews WHERE card_id = ?', id);
  D.run('DELETE FROM cards WHERE id = ?', id);
  return true;
}

// 提交一次练习结果（isFree=true 即自由练习，不计入复习计划）
function review(spaceId, userId, id, { result, studentAnswer, verdict, verdictJson, isFree }) {
  const c = getRaw(spaceId, id);
  if (!c) { const e = new Error('知识卡不存在'); e.code = 'NOT_FOUND'; throw e; }
  const r = ['right', 'wrong', 'unknown'].indexOf(result) >= 0 ? result : 'unknown';
  const s = nextSchedule(c, r, !!isFree);
  const reviewedAt = D.now();
  const isFreeR = !!s.free;
  const isUnchanged = !!s.unchanged;
  const nextDue = isFreeR || isUnchanged ? c.due_at : reviewedAt + (s.dueDays || 1) * DAY;
  D.run(`INSERT INTO card_reviews(id,card_id,result,student_answer,ai_verdict,verdict_json,is_free,interval_days,next_due_at,reviewed_at)
         VALUES(?,?,?,?,?,?,?,?,?,?)`,
    D.uid('rv_'), id, r, String(studentAnswer || '').slice(0, 2000), verdict || null,
    verdictJson ? JSON.stringify(verdictJson) : null, isFreeR ? 1 : 0,
    isFreeR || isUnchanged ? (s.dueDays || 0) : (s.dueDays || 1), nextDue, reviewedAt);
  if (!isFreeR && !isUnchanged) {
    D.run('UPDATE cards SET status = ?, stage = ?, consecutive_right = ?, due_at = ?, last_reviewed_at = ? WHERE id = ?',
      s.status, s.stage, s.consecutive, nextDue, reviewedAt, id);
  } else if (isUnchanged) {
    D.run('UPDATE cards SET last_reviewed_at = ? WHERE id = ?', reviewedAt, id);
  }
  core.logActivity(spaceId, userId, isFreeR ? 'card_free_practice' : 'card_review', id, { result: r, stage: s.stage });
  // 宠物成长值：按"理解质量"给，不按次数给（P9 的结算挂在这里）；自由练习不计
  if (!isFreeR) {
    try { require('./pet').onCardReview(spaceId, userId, { result: r, verdict, fromStage: c.stage, toStage: s.stage, cardId: id }); } catch (e) {}
  }
  let message;
  if (isFreeR) message = '自由练习，不计入复习计划。';
  else if (isUnchanged) message = '这次没法判断，没有记为答错。你的回答还在，可以再试一次。';
  else if (r === 'right') {
    if (c.status === 'mastered') message = '又核对对了 · ' + s.dueDays + ' 天后再来看看';
    else if (s.status === 'mastered') message = '连续答对 ' + s.consecutive + ' 次，已经掌握了 · ' + s.dueDays + ' 天后再来考考你';
    else if (s.status === 'almost') message = '快记住了 · ' + s.dueDays + ' 天后再练';
    else message = '记住啦 · ' + s.dueDays + ' 天后再练';
  } else message = '这次没答对 · 明天再练';
  return { card: getCard(spaceId, id), intervalDays: s.dueDays, nextDueAt: nextDue, free: isFreeR, unchanged: isUnchanged, message };
}

// 自由练习：只记录作答与理解核对，绝不改动复习计划（status/stage/due 全不动）
function freePractice(spaceId, userId, id, opts) {
  return review(spaceId, userId, id, Object.assign({}, opts, { isFree: true }));
}

// 复习计划管理：今天再练 / 明天再练 / 复习时间待更新 / 复位
function setPlan(spaceId, id, when) {
  const c = getRaw(spaceId, id);
  if (!c) { const e = new Error('知识卡不存在'); e.code = 'NOT_FOUND'; throw e; }
  const now = D.now();
  if (when === 'today') D.run('UPDATE cards SET due_at = ?, plan = ? WHERE id = ?', now, 'scheduled', id);
  else if (when === 'tomorrow') D.run('UPDATE cards SET due_at = ?, plan = ? WHERE id = ?', now + DAY, 'scheduled', id);
  else if (when === 'pending') D.run('UPDATE cards SET plan = ? WHERE id = ?', 'pending', id);  // 复习时间待更新
  else if (when === 'reset') D.run('UPDATE cards SET plan = ? WHERE id = ?', 'scheduled', id);
  else { const e = new Error('未知的复习计划操作'); e.code = 'BAD_INPUT'; throw e; }
  return getCard(spaceId, id);
}

// 学习进度规则（供"规则说明"弹窗）
function rules() {
  return {
    title: '学习进度规则',
    points: [
      '刚收下的新卡，从这里开始记。',
      '连续答对 5 次，这张卡就是已掌握。',
      '答错的卡，第二天会再来，别灰心。',
      '已掌握的卡，14 天后再来考考你；之后每 60 天再看一次。',
      '觉得早就会的卡，点 ⋯ 标上「我已经会了」，14 天后再核对一次。',
      '自由练习不计入复习计划，随你练多少。',
    ],
  };
}

function pad2(n) { return n < 10 ? '0' + n : '' + n; }
function dayKey(spaceId) { const d = new Date(D.now()); return 'cardgen:' + d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()) + ':' + spaceId; }
function recordGen(spaceId, n) { if (!n || n <= 0) return; D.metaSet(dayKey(spaceId), (Number(D.metaGet(dayKey(spaceId), 0)) || 0) + n); }
// 每日 AI 生成额度（§5：/flashcards/eligibility）
function eligibility(spaceId) {
  const used = Number(D.metaGet(dayKey(spaceId), 0)) || 0;
  const limit = DAILY_GEN_LIMIT;
  const d = new Date(D.now()); d.setDate(d.getDate() + 1); d.setHours(0, 0, 0, 0);
  return { eligible: used < limit, used, limit, remaining: Math.max(0, limit - used), resetAt: d.getTime() };
}

// 「我已经会了」：推迟 14 天，且可撤销
function selfKnown(spaceId, id) {
  const c = D.get('SELECT * FROM cards WHERE id = ? AND space_id = ?', id, spaceId);
  if (!c) { const e = new Error('知识卡不存在'); e.code = 'NOT_FOUND'; throw e; }
  const prev = { status: c.status, stage: c.stage, due_at: c.due_at };
  const due = D.now() + SELF_KNOWN_DEFER_DAYS * DAY;
  D.run('UPDATE cards SET status = ?, due_at = ? WHERE id = ?', 'retired', due, id);
  return { card: getCard(spaceId, id), previous: prev, deferDays: SELF_KNOWN_DEFER_DAYS };
}

function undoSelfKnown(spaceId, id, previous) {
  const c = D.get('SELECT * FROM cards WHERE id = ? AND space_id = ?', id, spaceId);
  if (!c) { const e = new Error('知识卡不存在'); e.code = 'NOT_FOUND'; throw e; }
  const p = previous || { status: 'learning', stage: 0, due_at: D.now() };
  D.run('UPDATE cards SET status = ?, stage = ?, due_at = ? WHERE id = ?',
    p.status || 'learning', Number(p.stage) || 0, Number(p.due_at) || D.now(), id);
  return getCard(spaceId, id);
}

function restoreReview(spaceId, id) {
  const c = getRaw(spaceId, id);
  if (!c) { const e = new Error('知识卡不存在'); e.code = 'NOT_FOUND'; throw e; }
  D.run('UPDATE cards SET status = ?, stage = ?, consecutive_right = ?, plan = ?, due_at = ? WHERE id = ?',
    'learning', 0, 0, 'scheduled', D.now(), id);
  return getCard(spaceId, id);
}

// ---------- 提示（≤25 字，自动隐藏泄题内容）----------
// "泄题"判定：提示里出现答案的关键片段，或出现完整算式结果。
function leaksAnswer(hint, answer) {
  const h = String(hint || ''), a = String(answer || '').trim();
  if (!a) return false;
  if (a.length >= 2 && h.indexOf(a) >= 0) return true;
  // 答案里的数字/关键短语出现在提示里
  const nums = a.match(/\d+(\.\d+)?/g) || [];
  if (nums.some(n => n.length >= 2 && h.indexOf(n) >= 0)) return true;
  const keys = a.replace(/[，。；：、\s]/g, ' ').split(' ').filter(w => w.length >= 3);
  return keys.some(k => h.indexOf(k) >= 0);
}

async function hint(spaceId, id) {
  const c = D.get('SELECT * FROM cards WHERE id = ? AND space_id = ?', id, spaceId);
  if (!c) { const e = new Error('知识卡不存在'); e.code = 'NOT_FOUND'; throw e; }
  const ask = `学生正在练习这个知识点，卡住了，需要一句提示。

知识点：${c.knowledge}
题目：${c.question || '（无题目，只有知识点）'}
正确答案：${c.answer || '（无）'}

请给一句提示，要求：
1. 只指出"下一步该想什么方向"，绝不能包含答案本身，也不能包含答案里的数字。
2. 不超过 ${HINT_MAX_CHARS} 个汉字。
3. 不要用"你可以……"这种空话，要具体指向一个思考动作。
只输出提示本身，不要引号、不要解释。`;
  let h = '';
  try {
    h = (await llm.complete({ messages: [{ role: 'user', content: ask }], model: 'default' })).trim();
  } catch (e) { h = ''; }
  h = String(h).replace(/^["'「]|["'」]$/g, '').replace(/\s+/g, ' ').trim();
  const tooLong = h.length > HINT_MAX_CHARS;
  const leaked = leaksAnswer(h, c.answer);
  if (!h || tooLong || leaked) {
    return {
      hint: '', hidden: true,
      reason: !h ? 'empty' : tooLong ? 'too_long' : 'leaked',
      message: !h || tooLong
        ? '这道题没想出更好的提示，先自己试试看'
        : '知识卡提示已隐藏可能泄题的内容',
    };
  }
  return { hint: h, hidden: false, reason: null, message: '' };
}

// ---------- 理解核对（只核对要点，不要求背原句）----------
async function checkUnderstanding(spaceId, id, studentAnswer) {
  const c = D.get('SELECT * FROM cards WHERE id = ? AND space_id = ?', id, spaceId);
  if (!c) { const e = new Error('知识卡不存在'); e.code = 'NOT_FOUND'; throw e; }
  const ans = String(studentAnswer || '').trim();
  if (!ans) { const e = new Error('先写一个答案，再确认。'); e.code = 'BAD_INPUT'; throw e; }

  const ask = `一个学生在用自己的话解释一个知识点。请核对他的理解，**只核对要点，不要求他背原句**。

知识点：${c.knowledge}
参考要点：${c.answer || '（无参考答案，请依据知识点本身判断）'}

学生的原话：
${ans}

请输出 JSON：
{
  "verdict": "solid | partial | off | unknown",
  "covered": ["他已经说到的要点"],
  "missing": ["还差的关键要点，最多 2 条，每条不超过 15 字"],
  "comment": "一句具体的反馈，指出他哪里想得好、哪里偏了。不要说'你真棒'这类空话。"
}

判定标准：
- solid：要点基本齐全，表达可以完全不同。
- partial：说到了一部分，还有关键点没提到。
- off：理解有明显偏差。
- unknown：信息不足，无法判断（这时**不要**判成错）。
只输出 JSON。`;

  let v = null;
  try { v = await llm.completeJSON({ messages: [{ role: 'user', content: ask }], model: 'default' }); } catch (e) {}
  if (!v || ['solid', 'partial', 'off', 'unknown'].indexOf(v.verdict) < 0) {
    v = { verdict: 'unknown', covered: [], missing: [], comment: '这次没法判断，没有记为答错。你的回答还在，请重试。' };
  }
  return v;
}

function completeUnderstanding(spaceId, userId, id, studentAnswer, verdictObj) {
  const v = verdictObj && verdictObj.verdict;
  // 只有明确"有偏差"才算答错；partial 算部分正确（按答对推进但降一档）；unknown 不算错
  const result = v === 'solid' ? 'right' : v === 'off' ? 'wrong' : v === 'partial' ? 'right' : 'unknown';
  const r = review(spaceId, userId, id, {
    result, studentAnswer, verdict: v, verdictJson: verdictObj,
  });
  return { ...r, verdict: verdictObj };
}

// ---------- 从对话生成知识卡 ----------
async function generateFromText(spaceId, userId, { text, conversationId, messageId, count, draftOnly }) {
  const n = Math.max(1, Math.min(6, Number(count) || 3));
  const ask = `下面是一段学习对话的片段。请从中挑出最多 ${n} 个**值得记住的知识点**，做成知识卡。

要求：
- 只挑真正需要理解的点，不要挑"今天学了第三章"这种流水账。
- 选择题要有一个明确正确项和三个有迷惑性的错误项（错误项要是学生真会犯的错）。
- 拼写题用于英文单词或专有名词。
- 理解题用于概念、原理——这类题的 answer 写"参考要点"，不写标准答案原文。
- 全部用中文（拼写题的答案可以是英文）。

对话片段：
${String(text || '').slice(0, 6000)}

输出 JSON 数组：
[{"knowledge":"知识点","type":"choice|spelling|understanding","question":"题目","answer":"答案或参考要点","options":["A","B","C","D"],"answerIndex":0}]
只输出 JSON。`;
  let arr = null;
  try { arr = await llm.completeJSON({ messages: [{ role: 'user', content: ask }], model: 'default' }); } catch (e) {}
  if (!Array.isArray(arr)) arr = [];
  const norm = (it) => {
    if (!it || !it.knowledge) return null;
    const type = ['choice', 'spelling', 'understanding'].indexOf(it.type) >= 0 ? it.type : 'understanding';
    let options = null;
    if (type === 'choice' && Array.isArray(it.options) && it.options.length >= 2) {
      options = { choices: it.options.map(String), answerIndex: Number(it.answerIndex) || 0 };
    }
    return { knowledge: String(it.knowledge).slice(0, 200), type, question: String(it.question || '').slice(0, 1000), answer: String(it.answer || '').slice(0, 2000), options };
  };
  const drafts = arr.slice(0, n).map(norm).filter(Boolean);
  // draftOnly：只返回草稿（AI 主动提醒"这段值得收成卡片"，由用户确认后再建）
  if (draftOnly) return { drafts };
  const made = [];
  for (const d of drafts) {
    made.push(create(spaceId, userId, Object.assign({ sourceConversationId: conversationId, sourceMessageId: messageId }, d)));
  }
  recordGen(spaceId, made.length);
  return made;
}

// AI 主动提醒收卡：返回候选草稿，不自动落库
async function suggest(spaceId, userId, opts) {
  return generateFromText(spaceId, userId, Object.assign({}, opts, { draftOnly: true }));
}

module.exports = {
  STATUS, HINT_MAX_CHARS, SELF_KNOWN_DEFER_DAYS,
  MASTER_THRESHOLD, WRONG_DAYS, MASTERED_FIRST_DAYS, MASTERED_LATER_DAYS, DAILY_GEN_LIMIT,
  list, summary, getCard, create, remove, review, freePractice,
  selfKnown, undoSelfKnown, restoreReview, setPlan,
  hint, leaksAnswer, checkUnderstanding, completeUnderstanding, generateFromText, suggest,
  rules, eligibility, nextSchedule,
};

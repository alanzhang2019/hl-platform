'use strict';
/**
 * 测评（P6）
 *
 * 和对标站最大的差别：**测评不是终点**。
 * 做完的每一道题都会回流到知识卡的间隔复习里 —— 答错的题会按"退一档"进入复习队列，
 * 答对的题会推进档位。所以测评是复习系统的一个入口，不是一次性的考试。
 *
 * 另外两条：
 *   · 出题阶段**不下发答案**（取卷接口会剥掉 answer 和正确选项），防止前端一抓就抄。
 *   · 理解题在无法判断时记为 unknown，**不计入错题、不扣分**，与知识卡保持一致。
 */
const D = require('./db');
const cards = require('./cards');
const core = require('./core');

const TYPES = ['choice', 'spelling', 'understanding'];

/**
 * 剥掉答案。
 * 注意 options 里也藏着答案（answerIndex）—— 只剥 items[].answer 是不够的，
 * 那样打开开发者工具就能看见正确选项。这里把 answerIndex 一并摘掉。
 */
function stripAnswer(it) {
  let options = null;
  if (it.options && it.options.choices) {
    options = { choices: it.options.choices };
  }
  return {
    id: it.id, cardId: it.cardId, type: it.type, subject: it.subject,
    knowledge: it.knowledge, question: it.question, options: options,
  };
}

function shapeExam(e, opts) {
  const o = opts || {};
  let items = [];
  try { items = JSON.parse(e.items_json) || []; } catch (err) { items = []; }
  const answers = e.answers_json ? core.safeJSON(e.answers_json) : null;
  return {
    id: e.id, title: e.title, projectId: e.project_id,
    status: e.status, itemCount: items.length,
    createdAt: e.created_at, submittedAt: e.submitted_at,
    score: e.score_json ? core.safeJSON(e.score_json) : null,
    // 取卷时不下发答案（items[].answer 和 options.answerIndex 都要摘掉）
    items: o.withItems
      ? items.map(it => (o.reveal ? it : stripAnswer(it)))
      : undefined,
    answers: o.reveal ? answers : undefined,
  };
}

function listExams(spaceId, opts) {
  const o = opts || {};
  let sql = 'SELECT * FROM exams WHERE space_id = ?';
  const p = [spaceId];
  if (o.projectId) { sql += ' AND project_id = ?'; p.push(o.projectId); }
  sql += ' ORDER BY created_at DESC LIMIT 100';
  return D.all(sql, ...p).map(e => shapeExam(e));
}

function getExam(spaceId, id, opts) {
  const e = D.get('SELECT * FROM exams WHERE id = ? AND space_id = ?', id, spaceId);
  if (!e) return null;
  const o = opts || {};
  return shapeExam(e, { withItems: true, reveal: o.reveal || e.status === 'submitted' });
}

/**
 * 出卷。题源是已有的知识卡 —— 保证"考的就是学过的"，
 * 而不是让模型凭空编一套和孩子学习内容无关的题。
 */
function createExam(spaceId, userId, opts) {
  const o = opts || {};
  const want = Math.max(1, Math.min(30, Number(o.count) || 8));
  const subjects = Array.isArray(o.subjects) && o.subjects.length ? o.subjects : null;
  const types = Array.isArray(o.types) && o.types.length ? o.types.filter(t => TYPES.indexOf(t) >= 0) : null;

  let pool = D.all('SELECT * FROM cards WHERE space_id = ?', spaceId);
  if (subjects) pool = pool.filter(c => subjects.indexOf(c.subject || 'general') >= 0);
  if (types) pool = pool.filter(c => types.indexOf(c.type) >= 0);
  if (!pool.length) {
    const e = new Error('还没有可以出题的知识卡。先在对话里把学过的内容收成知识卡，再回来出卷。');
    e.code = 'NO_CARDS'; throw e;
  }

  // 优先出"薄弱"的：答错过、状态还是学习中、档位低的排前面
  const stats = {};
  D.all('SELECT card_id, result, COUNT(*) c FROM card_reviews WHERE card_id IN (SELECT id FROM cards WHERE space_id = ?) GROUP BY card_id, result',
    spaceId).forEach(r => {
      stats[r.card_id] = stats[r.card_id] || { wrong: 0, right: 0, unknown: 0 };
      stats[r.card_id][r.result] = r.c;
    });
  const ranked = pool.map(c => {
    const s = stats[c.id] || { wrong: 0, right: 0, unknown: 0 };
    return { c: c, weight: s.wrong * 10 + (c.status === 'learning' ? 5 : c.status === 'almost' ? 2 : 0) - s.right * 2 };
  }).sort((a, b) => b.weight - a.weight);

  const picked = [];
  const byType = {};
  // 尽量让题型均衡：先按权重轮着取不同类型的题
  ranked.forEach(r => {
    if (picked.length >= want) return;
    const t = r.c.type;
    if ((byType[t] || 0) >= Math.ceil(want / 2)) return;
    byType[t] = (byType[t] || 0) + 1;
    picked.push(r.c);
  });
  ranked.forEach(r => { if (picked.length < want && picked.indexOf(r.c) < 0) picked.push(r.c); });

  const items = picked.map(c => ({
    id: D.uid('qi_'),
    cardId: c.id,
    type: c.type,
    subject: c.subject || 'general',
    knowledge: c.knowledge,
    question: c.question || c.knowledge,
    answer: c.answer,
    options: c.options_json ? core.safeJSON(c.options_json) : null,
  }));

  const title = String(o.title || '').trim().slice(0, 60) ||
    ('测评卷 · ' + new Date().toLocaleDateString('zh-CN') + ' · ' + items.length + ' 题');
  const id = D.uid('ex_');
  D.run(`INSERT INTO exams(id,space_id,user_id,project_id,title,items_json,status,created_at)
         VALUES(?,?,?,?,?,?,?,?)`,
    id, spaceId, userId || null, o.projectId || null, title, JSON.stringify(items), 'open', D.now());
  return getExam(spaceId, id, { reveal: false });
}

function norm(s) {
  return String(s == null ? '' : s).toLowerCase().trim().replace(/\s+/g, '').replace(/[，。；：、,.;:!?！？"'「」]/g, '');
}

/**
 * 交卷批改。
 * 返回：逐题结果、总分、按题型/学科的分布、以及**回流到知识卡的明细**。
 */
async function submit(spaceId, userId, examId, answers) {
  const e = D.get('SELECT * FROM exams WHERE id = ? AND space_id = ?', examId, spaceId);
  if (!e) { const err = new Error('测评卷不存在'); err.code = 'NOT_FOUND'; throw err; }
  if (e.status === 'submitted') { const err = new Error('这张卷子已经交过了'); err.code = 'ALREADY'; throw err; }

  const items = core.safeJSON(e.items_json) || [];
  const ans = {};
  (Array.isArray(answers) ? answers : []).forEach(a => { if (a && a.cardId) ans[a.cardId] = a; });

  const results = [];
  for (const it of items) {
    const a = ans[it.cardId] || {};
    let verdict = 'unknown';
    let result = 'unknown';
    let studentAnswer = a.answer;
    let extra = null;

    if (it.type === 'choice' && it.options) {
      const pick = Number(a.answerIndex);
      const correct = Number(it.options.answerIndex) || 0;
      const answered = Number.isFinite(pick) && pick >= 0;
      result = !answered ? 'unknown' : (pick === correct ? 'right' : 'wrong');
      verdict = !answered ? 'unknown' : (pick === correct ? 'solid' : 'off');
      studentAnswer = answered && it.options.choices ? it.options.choices[pick] : '';
      extra = { correctIndex: correct, pickIndex: answered ? pick : null };
    } else if (it.type === 'spelling') {
      const got = String(a.answer == null ? '' : a.answer);
      if (!got.trim()) { result = 'unknown'; verdict = 'unknown'; }
      else { const ok2 = norm(got) === norm(it.answer); result = ok2 ? 'right' : 'wrong'; verdict = ok2 ? 'solid' : 'off'; }
      studentAnswer = got;
    } else {
      // 理解题：交给 AI 核对要点；判断不了记为 unknown，不算错
      const got = String(a.answer == null ? '' : a.answer);
      if (!got.trim()) { result = 'unknown'; verdict = 'unknown'; }
      else {
        try {
          const v = await cards.checkUnderstanding(spaceId, it.cardId, got);
          extra = v;
          verdict = v.verdict;
          result = v.verdict === 'solid' ? 'right' : v.verdict === 'off' ? 'wrong' : v.verdict === 'partial' ? 'right' : 'unknown';
        } catch (err) { result = 'unknown'; verdict = 'unknown'; }
      }
      studentAnswer = got;
    }

    // 回流：测评的每一题都进知识卡的复习队列
    let fed = null;
    try {
      fed = cards.review(spaceId, userId, it.cardId, { result: result, studentAnswer: studentAnswer, verdict: verdict, verdictJson: extra });
    } catch (err) { fed = null; }

    results.push({
      cardId: it.cardId, type: it.type, subject: it.subject, knowledge: it.knowledge,
      question: it.question, answer: it.answer, studentAnswer: studentAnswer,
      result: result, verdict: verdict, detail: extra,
      nextDueAt: fed ? fed.nextDueAt : null,
      cardStatus: fed ? fed.card.status : null,
      message: fed ? fed.message : '',
    });
  }

  const counted = results.filter(r => r.result !== 'unknown');
  const right = counted.filter(r => r.result === 'right').length;
  const byType = {}, bySubject = {};
  results.forEach(r => {
    const bt = byType[r.type] = byType[r.type] || { total: 0, right: 0, wrong: 0, unknown: 0 };
    const bs = bySubject[r.subject] = bySubject[r.subject] || { total: 0, right: 0, wrong: 0, unknown: 0 };
    bt.total++; bt[r.result]++;
    bs.total++; bs[r.result]++;
  });

  const score = {
    total: results.length,
    counted: counted.length,
    right: right,
    wrong: counted.length - right,
    unknown: results.length - counted.length,
    accuracy: counted.length ? Math.round(right / counted.length * 100) : 0,
    byType: byType, bySubject: bySubject,
    // 需要回头看的（答错的和没判断的）
    revisit: results.filter(r => r.result !== 'right').map(r => ({ cardId: r.cardId, knowledge: r.knowledge, subject: r.subject, result: r.result })),
  };

  D.run('UPDATE exams SET status = ?, answers_json = ?, score_json = ?, submitted_at = ? WHERE id = ?',
    'submitted', JSON.stringify(answers || []), JSON.stringify(score), D.now(), examId);
  core.logActivity(spaceId, userId, 'exam_submit', examId, { right: right, total: results.length });

  return { exam: getExam(spaceId, examId, { reveal: true }), score: score, results: results };
}

function removeExam(spaceId, id) {
  D.run('DELETE FROM exams WHERE id = ? AND space_id = ?', id, spaceId);
  return true;
}

/** 学科维度的掌握情况（给看板/测评报告共用） */
function subjectBreakdown(spaceId) {
  const rows = D.all('SELECT subject, status, COUNT(*) c FROM cards WHERE space_id = ? GROUP BY subject, status', spaceId);
  const out = {};
  rows.forEach(r => {
    const k = r.subject || 'general';
    out[k] = out[k] || { subject: k, total: 0, learning: 0, almost: 0, mastered: 0, retired: 0 };
    out[k].total += r.c;
    out[k][r.status] = (out[k][r.status] || 0) + r.c;
  });
  return Object.keys(out).map(k => out[k]).sort((a, b) => b.total - a.total);
}

module.exports = { TYPES, createExam, listExams, getExam, submit, removeExam, subjectBreakdown };

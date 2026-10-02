'use strict';
/**
 * 批次16 自检（模块级）：学习周报。
 *
 * 周报 = 把多天日报的「事实层」汇总。
 * 核心要守的：汇总数字必须正确（去重、合计、不丢天）。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hl-p16-'));
process.env.DATA_DIR = TMP;
process.env.NO_DOTENV = '1';
delete process.env.LLM_API_KEY;
delete process.env.ADMIN_PASSWORD;

let pass = 0, fail = 0;
const fails = [];
function ok(name, cond, extra) {
  if (cond) { pass++; }
  else { fail++; fails.push(name + (extra !== undefined ? ' → ' + JSON.stringify(extra) : '')); }
}
function group(t) { console.log('\n' + t); }

const D = require('./server/db');
const daily = require('./server/daily');
const weekly = require('./server/weekly');

const DAY = 24 * 60 * 60 * 1000;
const DAY_ANCHOR = (() => { const d = new Date(); d.setHours(12, 0, 0, 0); return d.getTime(); })();
const SP = '_public';

function mkCard(knowledge, subject) {
  const id = D.uid('c_');
  D.run('INSERT INTO cards(id,space_id,user_id,knowledge,question,answer,type,subject,status,stage,due_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
    id, SP, null, knowledge, 'q', 'a', 'choice', subject || 'math', 'learning', 0, 0, D.now());
  return id;
}
function mkReview(cardId, result, dayOffset) {
  const id = D.uid('r_');
  const at = DAY_ANCHOR + dayOffset * DAY - 30 * 60000; // 当天 11:30
  D.run('INSERT INTO card_reviews(id,card_id,result,student_answer,ai_verdict,is_free,reviewed_at) VALUES(?,?,?,?,?,?,?)',
    id, cardId, result, 'ans', 'verdict', 0, at);
  return id;
}
function mkActivity(kind, dayOffset) {
  const at = DAY_ANCHOR + dayOffset * DAY - 60 * 60000; // 当天 11:00
  D.run('INSERT INTO activity(space_id,user_id,kind,ref_id,meta_json,at) VALUES(?,?,?,?,?,?)',
    SP, null, kind, null, null, at);
}

const D0 = daily.dayKey(DAY_ANCHOR);
const DM1 = daily.dayKey(DAY_ANCHOR - DAY);
const DM2 = daily.dayKey(DAY_ANCHOR - 2 * DAY);

// ---------- A. 空范围结构 ----------
group('A. 空范围结构');

let w = weekly.build(SP, D0, D0);
ok('返回 from/to', w.from === D0 && w.to === D0);
ok('daysCount = 1', w.daysCount === 1);
ok('summary.records = 0', w.summary.records === 0);
ok('summary.accuracy = null（不是 0）', w.summary.accuracy === null, w.summary.accuracy);
ok('summary.cardsTouched = 0', w.summary.cardsTouched === 0);
ok('days 有 1 项', w.days.length === 1);
ok('day[0].hasRecord = false', w.days[0].hasRecord === false);
ok('notScored 非空', w.notScored.length >= 3);
ok('limits 非空', w.limits.length >= 3);
ok('coverage.totalCards = 0', w.coverage.totalCards === 0);
ok('isCurrentWeek = true（今天属于本周）', w.isCurrentWeek === true);

// ---------- B. 范围边界 ----------
group('B. 范围边界');

ok('7 天范围允许', (() => {
  try { weekly.build(SP, DM1, D0); return true; }
  catch (e) { return false; }
})());
ok('8 天范围拒绝', (() => {
  try { weekly.build(SP, daily.dayKey(DAY_ANCHOR - 7 * DAY), D0); return false; }
  catch (e) { return e.message === 'range_too_long'; }
})());
ok('无效 from 拒绝', (() => {
  try { weekly.build(SP, 'bad', D0); return false; }
  catch (e) { return e.message === 'invalid_range'; }
})());
ok('to < from 拒绝', (() => {
  try { weekly.build(SP, D0, DM1); return false; }
  catch (e) { return e.message === 'invalid_range'; }
})());

// ---------- C. 造数据（3 天） ----------
const c1 = mkCard('一元二次方程', 'math');
const c2 = mkCard('牛顿第一定律', 'physics');
const c3 = mkCard('细胞结构', 'biology');

mkReview(c1, 'wrong', -2);  // 前天 c1 错
mkReview(c2, 'right', -2);  // 前天 c2 对
mkActivity('chat', -2);
mkActivity('card_review', -2);

mkReview(c1, 'wrong', -1);  // 昨天 c1 错（累计 stuck）
mkReview(c3, 'right', -1);  // 昨天 c3 对
mkActivity('chat', -1);

mkReview(c1, 'right', 0);   // 今天 c1 对
mkActivity('kb_upload', 0);

// ---------- D. 汇总数字 ----------
group('D. 汇总数字');

w = weekly.build(SP, DM2, D0);
ok('daysCount = 3', w.daysCount === 3);
ok('summary.records = 4（activity 总数）', w.summary.records === 4, w.summary.records);
ok('summary.reviews = 5', w.summary.reviews === 5, w.summary.reviews);
ok('summary.right = 3（c2 + c3 + c1 今天）', w.summary.right === 3, w.summary.right);
ok('summary.wrong = 2（c1 前天+昨天）', w.summary.wrong === 2, w.summary.wrong);
ok('summary.judged = 5', w.summary.judged === 5, w.summary.judged);
ok('summary.accuracy = 60%（3/5）', w.summary.accuracy === 60, w.summary.accuracy);
ok('summary.cardsTouched = 3（c1/c2/c3 去重）', w.summary.cardsTouched === 3, w.summary.cardsTouched);
ok('summary.daysWithRecord = 3', w.summary.daysWithRecord === 3, w.summary.daysWithRecord);
ok('summary.stuckCount = 1（c1 跨天累计 ≥2 次 wrong）', w.summary.stuckCount === 1, w.summary.stuckCount);
ok('stuckCards[0].cardId = c1', w.summary.stuckCards[0].cardId === c1);
ok('stuckCards[0].wrongs = 2', w.summary.stuckCards[0].wrongs === 2);
ok('subjects 按 reviews 降序，math 第一', w.summary.subjects[0].subject === 'math');
ok('math 科目 reviews = 3', w.summary.subjects[0].reviews === 3);
ok('math 科目 right = 1', w.summary.subjects[0].right === 1);
ok('math 科目 wrong = 2', w.summary.subjects[0].wrong === 2);

// ---------- E. 覆盖 ----------
group('E. 覆盖');

ok('coverage.totalCards = 3', w.coverage.totalCards === 3);
ok('coverage.bySubject 有 3 个科目', w.coverage.bySubject.length === 3);
const subNames = w.coverage.bySubject.map(x => x.subject).sort();
ok('科目包含 biology/math/physics', subNames.join(',') === 'biology,math,physics');

// ---------- F. 单日一致性 ----------
group('F. 单日一致性');

const dOnly = weekly.build(SP, D0, D0);
const dayReport = daily.build(SP, D0);
ok('单日范围的 records 等于日报 records',
  dOnly.summary.records === dayReport.metrics.filter(m => m.key === 'records')[0].value);
ok('单日范围的 reviews 等于当天 review 数', dOnly.summary.reviews === 1);

// ---------- G. 非本周 ----------
group('G. 非本周');

const pastWeek = weekly.build(SP, DM2, DM1);
ok('isCurrentWeek = false（过去周）', pastWeek.isCurrentWeek === false);

// ---------- 清理 ----------
try { D.db.close(); } catch (e) {}
fs.rmSync(TMP, { recursive: true, force: true });

// ---------- 汇总 ----------
console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
if (fail) {
  fails.forEach(s => console.log('  ✗ ' + s));
  process.exit(1);
}

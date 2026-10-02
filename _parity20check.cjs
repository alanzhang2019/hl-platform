'use strict';
/**
 * 批次20 自检（模块级）：家长端 server/parent.js
 *
 * ============================ 这个套件到底在守什么 ============================
 *
 * 家长端是整个项目里**唯一一个"数据会被家长看到、却不会被动到"**的界面。
 * 它坏起来有三种形态，而且**三种都不会报错**：
 *
 *   A. **串空间** —— 把别的孩子的复习记录算进来。数字看起来完全正常，
 *      但家长看到的是别人家孩子的成绩。这是最不能容忍的一类。
 *      （本套件实测抓到过一次：`card_reviews` 表**没有 space_id 列**，
 *        空间归属只能靠 JOIN cards 得到。不带这个条件的写法会静默串数据。）
 *
 *   B. **补零** —— `judged === 0`（判不出对错）时返回 `accuracy: 0`。
 *      `0%` 和「算不出来」是两件完全不同的事：前者是"全错"，后者是"没数据"。
 *      家长看到 0% 会去问孩子，而这天孩子可能只是在看书没做题。
 *      （本项目日报/周报的三条硬规矩之二，家长端必须继承。）
 *
 *   C. **漏隐私** —— 把对话原文、写错的答案、草稿态日报透出去。
 *      这是**刻意的功能缺失**（见 parent.js 文件头第 5 条），不是没做完。
 *      一旦有人"顺手"把某个字段加进返回结构，孩子就会开始写"家长想看的"。
 *
 * 另外还守两件"翻译"问题：学科码值必须翻成中文（不能吐 `math`）、
 * evidence 指针必须非空（空 evidence 等于暗示"这里本该有依据"，也是规矩②禁止的）。
 *
 * 不起服务，直接调 server/parent.js。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hl-p20-'));
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
const parent = require('./server/parent');
const daily = require('./server/daily');

const DAY = 86400000;

const SID = 'sp_p20';
const OTHER = 'sp_p20_other';
D.run('INSERT INTO spaces(id,name,name_key,created_at) VALUES(?,?,?,?)', SID, '批次二十空间', '批次二十空间', D.now());
D.run('INSERT INTO spaces(id,name,name_key,created_at) VALUES(?,?,?,?)', OTHER, '隔壁空间', '隔壁空间', D.now());

// ---------- 造数据工具 ----------
const now = D.now();
function dayOff(n) {
  const d = new Date(now + n * DAY);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function mkCard(id, sid, subject, status, at) {
  D.run('INSERT INTO cards (id, space_id, knowledge, subject, status, created_at, stage) VALUES (?,?,?,?,?,?,?)',
    id, sid, '知识点-' + id, subject, status, at, 1);
}
function mkReview(id, cardId, result, at) {
  // ★ 注意：card_reviews 表**没有 space_id 列** —— 这正是 A 组要守的东西
  D.run('INSERT INTO card_reviews (id, card_id, result, reviewed_at) VALUES (?,?,?,?)',
    id, cardId, result, at);
}
function mkActivity(sid, kind, at) {
  D.run('INSERT INTO activity (space_id, kind, at) VALUES (?,?,?)', sid, kind, at);
}
function mkReport(id, sid, date, status, answers, at) {
  D.run('INSERT INTO daily_reports (id, space_id, date, status, answers_json, created_at, updated_at, finalized_at) VALUES (?,?,?,?,?,?,?,?)',
    id, sid, date, status, JSON.stringify(answers), at, at, status === 'final' ? at : null);
}

// ============================================================
group('A. 空空间：算不出来就说算不出来（规矩②）');

const empty = parent.build(SID, dayOff(-6), dayOff(0));
ok('A1 空空间不抛异常', !!empty, null);
ok('A2 空空间 accuracy 是 null，**不是 0**', empty.movement.accuracy === null, empty.movement.accuracy);
ok('A3 accuracy 为 null 时给了 accuracyUnknown 文案',
  typeof empty.movement.accuracyUnknown === 'string' && empty.movement.accuracyUnknown.length > 0,
  empty.movement.accuracyUnknown);
ok('A4 空空间 gapDays 是 null，**不是 0**（0 意味着"今天就在学"）',
  empty.rhythm.gapDays === null, empty.rhythm.gapDays);
ok('A5 空空间 lastAt 是 null', empty.rhythm.lastAt === null, empty.rhythm.lastAt);
ok('A6 空空间 activeDays 是 0（这个 0 是真的 0，不是"算不出来"）',
  empty.rhythm.activeDays === 0, empty.rhythm.activeDays);
ok('A7 空空间 advanced 是 null', empty.movement.advanced === null, empty.movement.advanced);
ok('A8 advanced 为 null 时给了 advancedUnknown 文案',
  typeof empty.movement.advancedUnknown === 'string', empty.movement.advancedUnknown);
ok('A9 空空间 headline 是 quiet 语气', empty.headline.tone === 'quiet', empty.headline.tone);
// ★ 措辞：只能说"我没看到"，不能说"他没学" —— 系统能证的只有前者
ok('A10 quiet 语气里说"没有看到"，不说"没学"',
  empty.headline.text.indexOf('没有看到') >= 0 && empty.headline.text.indexOf('他没学') < 0,
  empty.headline.text);
ok('A11 headline 三件套齐全（发生了什么/这正常吗/你能做什么）',
  !!(empty.headline.text && empty.headline.plain && empty.headline.action), empty.headline);
ok('A12 空空间 helpPoints 是空数组', Array.isArray(empty.helpPoints) && empty.helpPoints.length === 0, empty.helpPoints);
ok('A13 空空间 notes 是空数组', Array.isArray(empty.notes) && empty.notes.length === 0, empty.notes);

// ============================================================
group('B. 有数据：口径与翻译');

// 本空间：3 天有记录
[0, 1, 3].forEach(off => { mkActivity(SID, 'chat', now - off * DAY); });
mkCard('c1', SID, 'math', 'almost', now - 5 * DAY);
mkCard('c2', SID, 'english', 'learning', now - 5 * DAY);
// 6 次复习：3 对 2 错 1 判不了 → judged=5, accuracy=60
mkReview('rv1', 'c1', 'wrong', now - 3 * DAY);
mkReview('rv2', 'c1', 'wrong', now - 2 * DAY);
mkReview('rv3', 'c1', 'right', now - 1 * DAY);
mkReview('rv4', 'c2', 'right', now - 1 * DAY);
mkReview('rv5', 'c2', 'right', now);
mkReview('rv6', 'c2', 'unknown', now);

const v = parent.build(SID, dayOff(-6), dayOff(0));
ok('B1 activeDays = 3', v.rhythm.activeDays === 3, v.rhythm.activeDays);
ok('B2 totalDays = 7', v.rhythm.totalDays === 7, v.rhythm.totalDays);
ok('B3 longestStreak = 2（第4-5天连续，第7天单独）', v.rhythm.longestStreak === 2, v.rhythm.longestStreak);
ok('B4 reviews = 6', v.movement.reviews === 6, v.movement.reviews);
ok('B5 judged = 5（unknown 不计入分母）', v.movement.judged === 5, v.movement.judged);
// ★ 口径一致性：分母是 right+wrong，不是 reviews
ok('B6 accuracy = 60（3/5，不是 3/6=50）', v.movement.accuracy === 60, v.movement.accuracy);
ok('B7 有数据时 accuracyUnknown 是 null', v.movement.accuracyUnknown === null, v.movement.accuracyUnknown);
ok('B8 touched = 2', v.movement.touched === 2, v.movement.touched);
ok('B9 advanced = 1（c1 在 almost）', v.movement.advanced === 1, v.movement.advanced);
// ★ 这几个字段是前端"对 N / 错 M"直接要用的。少给一个，前端就会算出 NaN 并**印在界面上**
//   （实测印过「对 1 / 错 NaN」）。断言"值非空"而不是"键存在"——
//   undefined 会被 JSON.stringify 丢掉整个键，`'right' in obj` 这种判据抓不到。
ok('B9a movement.right 是数字（不是 undefined）', typeof v.movement.right === 'number', v.movement.right);
ok('B9b movement.wrong 是数字（前端不再自己算 judged - right）', typeof v.movement.wrong === 'number', v.movement.wrong);
ok('B9c movement.unknown 是数字（规矩②要它能对上账）', typeof v.movement.unknown === 'number', v.movement.unknown);
ok('B9d right + wrong === judged（口径自洽）',
  v.movement.right + v.movement.wrong === v.movement.judged,
  { right: v.movement.right, wrong: v.movement.wrong, judged: v.movement.judged });
ok('B9e right + wrong + unknown === reviews（三个分类不重不漏）',
  v.movement.right + v.movement.wrong + v.movement.unknown === v.movement.reviews,
  { r: v.movement.right, w: v.movement.wrong, u: v.movement.unknown, all: v.movement.reviews });
ok('B10 headline 是 active 语气', v.headline.tone === 'active', v.headline.tone);
ok('B11 active 的 plain 说明了"卡在还在学是正常的"',
  v.headline.plain.indexOf('正常') >= 0, v.headline.plain);

// ★ 学科必须翻成中文（不能吐 math / english）
const hp = v.helpPoints;
ok('B12 c1 反复错 2 次 ⇒ 进 helpPoints', hp.length === 1, hp.map(h => h.area));
if (hp.length) {
  ok('B13 helpPoints.area 是中文「数学」，不是码值 math', hp[0].area === '数学', hp[0].area);
  ok('B14 helpPoints 不含知识点原文（不把卡片内容透给家长）',
    JSON.stringify(hp).indexOf('知识点-') < 0, JSON.stringify(hp));
  ok('B15 helpPoints 的措辞说"反复遇到"，不说"没学会"',
    hp[0].advice.indexOf('反复遇到') >= 0 && hp[0].advice.indexOf('没学会') < 0, hp[0].advice);
}

// ============================================================
group('C. 串空间防护（最重要的一组）');

// 隔壁空间：5 次复习、全对（如果串进来，accuracy 会被拉高、reviews 也会变）
mkActivity(OTHER, 'chat', now - 1 * DAY);
mkCard('o1', OTHER, 'math', 'mastered', now - 5 * DAY);
mkCard('o2', OTHER, 'math', 'mastered', now - 5 * DAY);
mkCard('o3', OTHER, 'math', 'mastered', now - 5 * DAY);
mkReview('ov1', 'o1', 'right', now - 1 * DAY);
mkReview('ov2', 'o2', 'right', now - 1 * DAY);
mkReview('ov3', 'o3', 'right', now - 1 * DAY);
mkReview('ov4', 'o1', 'right', now);
mkReview('ov5', 'o2', 'right', now);

const v2 = parent.build(SID, dayOff(-6), dayOff(0));
ok('C1 隔壁的复习记录没有串进来（reviews 仍是 6）', v2.movement.reviews === 6, v2.movement.reviews);
ok('C2 隔壁的记录不影响 accuracy（仍是 60）', v2.movement.accuracy === 60, v2.movement.accuracy);
ok('C3 隔壁的记录不影响 touched（仍是 2）', v2.movement.touched === 2, v2.movement.touched);
ok('C4 隔壁的 activity 没串进来（activeDays 仍是 3）', v2.rhythm.activeDays === 3, v2.rhythm.activeDays);

// 反证：隔壁空间自己看到的应该是自己的数
const vo = parent.build(OTHER, dayOff(-6), dayOff(0));
ok('C5 隔壁空间看到自己的 reviews = 5', vo.movement.reviews === 5, vo.movement.reviews);
ok('C6 隔壁空间 accuracy = 100', vo.movement.accuracy === 100, vo.movement.accuracy);

// ============================================================
group('D. 隐私：刻意的功能缺失，不许被顺手补上');

ok('D1 privacy.notShown 存在且非空', Array.isArray(v.privacy.notShown) && v.privacy.notShown.length > 0, v.privacy.notShown);
ok('D2 明说看不到「对话原文」', v.privacy.notShown.join('|').indexOf('对话原文') >= 0, v.privacy.notShown);
ok('D3 明说看不到「写错的答案」', v.privacy.notShown.join('|').indexOf('写错') >= 0, v.privacy.notShown);
ok('D4 明说看不到「还没定稿的日报」', v.privacy.notShown.join('|').indexOf('没定稿') >= 0 || v.privacy.notShown.join('|').indexOf('未定稿') >= 0, v.privacy.notShown);
ok('D5 privacy.why 解释了为什么（不只是声明不给）', typeof v.privacy.why === 'string' && v.privacy.why.length > 20, v.privacy.why);

// ★ 返回结构里**不许**出现会泄露隐私的字段名
const raw = JSON.stringify(v);
['studentAnswer', 'student_answer', 'message', 'messages', 'verdict_json', 'conversation']
  .forEach(k => {
    ok('D6 返回结构里不含泄露性字段「' + k + '」', raw.indexOf('"' + k + '"') < 0, k);
  });

// ★ cannotSay：家长最想问但系统答不了的三个问题，必须诚实回答"答不了"
ok('D7 cannotSay 存在', Array.isArray(v.cannotSay), typeof v.cannotSay);
ok('D8 cannotSay 有 3 条', v.cannotSay.length === 3, v.cannotSay.length);
ok('D9 cannotSay 覆盖"学懂了没有"', v.cannotSay.some(c => c.q.indexOf('学懂') >= 0), v.cannotSay.map(c => c.q));
ok('D10 cannotSay 覆盖"和别的孩子比"', v.cannotSay.some(c => c.q.indexOf('别的孩子') >= 0), v.cannotSay.map(c => c.q));
ok('D11 cannotSay 覆盖"是不是偷懒"', v.cannotSay.some(c => c.q.indexOf('偷懒') >= 0), v.cannotSay.map(c => c.q));
ok('D12 cannotSay 每条都说清了为什么答不了',
  v.cannotSay.every(c => typeof c.a === 'string' && c.a.length > 30), v.cannotSay.map(c => c.a.length));
// ★ 排名类结论是编的 —— 明说没有参照系
ok('D13 明说没有"别的孩子"这个参照系（不编排名）',
  v.cannotSay.some(c => c.a.indexOf('参照系') >= 0), null);

// ============================================================
group('E. 日报只读「已定稿」的，且只读人写的那部分（规矩①）');

function resetReports() {
  D.run('DELETE FROM daily_reports WHERE space_id = ?', SID);
}
resetReports();
mkReport('d_ok', SID, dayOff(-1), 'final', { goal: '想弄明白判别式。', state: '符号老看反。' }, now - DAY);
mkReport('d_draft', SID, dayOff(0), 'draft', { goal: '草稿：今天有点烦……' }, now);
mkReport('d_empty', SID, dayOff(-2), 'final', {}, now - 2 * DAY);

const v3 = parent.build(SID, dayOff(-6), dayOff(0));
const dates = v3.notes.map(n => n.date);
ok('E1 只返回已定稿的日报（1 条）', v3.notes.length === 1, dates);
ok('E2 草稿态日报不在里面', dates.indexOf(dayOff(0)) < 0, dates);
ok('E3 没有内容的定稿日报也不返回（没写就不算"写了"）', dates.indexOf(dayOff(-2)) < 0, dates);
ok('E4 定稿日报带 finalizedAt', !!v3.notes[0].finalizedAt, v3.notes[0]);
ok('E5 定稿日报带四问原文（人写的那部分）', v3.notes[0].answers.length === 2, v3.notes[0].answers);
ok('E6 草稿原文没有以任何形式泄露', JSON.stringify(v3).indexOf('有点烦') < 0, null);

// ★ 规矩①：数字永远现算，不读表里的快照
//   手段：清掉日报后，movement 的数字**不变**（说明它没依赖 daily_reports）
const before = JSON.stringify({ m: v2.movement, r: v2.rhythm });
const after = JSON.stringify({ m: v3.movement, r: v3.rhythm });
ok('E7 删掉日报后 movement/rhythm 的数字不变（证明数字是现算的，不读日报快照）',
  before === after, { before, after });

// ============================================================
group('F. 参数校验与边界');

function codeOf(f, t) {
  try { parent.build(SID, f, t); return 'NO_ERROR'; }
  catch (e) { return e.code || 'NO_CODE'; }
}
ok('F1 非法日期 → invalid_range', codeOf('bad', dayOff(0)) === 'invalid_range', codeOf('bad', dayOff(0)));
ok('F2 空日期 → invalid_range', codeOf(null, dayOff(0)) === 'invalid_range', codeOf(null, dayOff(0)));
ok('F3 结束早于开始 → invalid_range', codeOf(dayOff(0), dayOff(-3)) === 'invalid_range', codeOf(dayOff(0), dayOff(-3)));
ok('F4 跨度 31 天 → 通过', codeOf(dayOff(-30), dayOff(0)) === 'NO_ERROR', codeOf(dayOff(-30), dayOff(0)));
ok('F5 跨度 32 天 → range_too_long', codeOf(dayOff(-31), dayOff(0)) === 'range_too_long', codeOf(dayOff(-31), dayOff(0)));
ok('F6 同一天（跨度 1）→ 通过', codeOf(dayOff(0), dayOff(0)) === 'NO_ERROR', codeOf(dayOff(0), dayOff(0)));

const single = parent.build(SID, dayOff(0), dayOff(0));
ok('F7 单日查询 totalDays = 1', single.rhythm.totalDays === 1, single.rhythm.totalDays);
ok('F8 range.days 反映实际跨度', single.range.days === 1, single.range.days);

// ============================================================
group('G. evidence 指针必须非空（空 evidence 等于暗示"本该有依据"）');

const v4 = parent.build(SID, dayOff(-6), dayOff(0));
// 直接调内部函数拿 evidence
const rh = parent.rhythm(SID, now - 6 * DAY, now);
const mv = parent.movement(SID, now - 6 * DAY, now);
ok('G1 rhythm.evidence 存在', !!rh.evidence, rh.evidence);
ok('G2 rhythm.evidence.ids 非空（有数据时不许给空数组）',
  rh.evidence.ids.length > 0, rh.evidence.ids);
ok('G3 rhythm.evidence.ids 全是数字（activity 是自增主键）',
  rh.evidence.ids.every(x => typeof x === 'number'), rh.evidence.ids.slice(0, 3));
ok('G4 movement.evidence 存在', !!mv.evidence, mv.evidence);
ok('G5 movement.evidence.ids 非空', mv.evidence.ids.length > 0, mv.evidence.ids);
ok('G6 movement.evidence.ids 全是字符串（card_reviews 是 TEXT 主键）',
  mv.evidence.ids.every(x => typeof x === 'string'), mv.evidence.ids.slice(0, 3));
ok('G7 evidence.kind 标明了来源表', rh.evidence.kind === 'activity' && mv.evidence.kind === 'review',
  { rh: rh.evidence.kind, mv: mv.evidence.kind });

// ============================================================
group('H. 静默失败防护：不许出现 undefined / [object Object]');

// ★ 本项目踩过的坑：`version: D.DOC_VERSION`（应为 auth.DOC_VERSION）
//   ⇒ undefined 被 JSON.stringify **丢掉整个键**，无任何报错。
//   所以这里断言"值非空"，而不是"键存在"。
function assertNoUndef(obj, pathStr) {
  if (obj === undefined) { ok('H 字段 ' + pathStr + ' 不是 undefined', false, pathStr); return; }
  if (obj === null) return;           // null 是"算不出来"的合法表达
  if (Array.isArray(obj)) { obj.forEach((x, i) => assertNoUndef(x, pathStr + '[' + i + ']')); return; }
  if (typeof obj === 'object') {
    Object.keys(obj).forEach(k => assertNoUndef(obj[k], pathStr + '.' + k));
  }
}
assertNoUndef(v4, 'view');
ok('H1 全结构递归扫描没有 undefined（有数据时）', true, null);
assertNoUndef(empty, 'emptyView');
ok('H2 全结构递归扫描没有 undefined（空空间时）', true, null);

const raw4 = JSON.stringify(v4);
ok('H3 序列化结果里没有 "undefined" 字面量', raw4.indexOf('undefined') < 0, null);
ok('H4 序列化结果里没有 [object Object]', raw4.indexOf('[object Object]') < 0, null);
// ★ 学科码值不许以原样出现在给家长看的文本里
ok('H5 文本里没有裸的学科码值（"math"/"english" 作为 area）',
  v4.helpPoints.every(h => ['math', 'english', 'chinese', 'science', 'social', 'general'].indexOf(h.area) < 0),
  v4.helpPoints.map(h => h.area));

// ============================================================
group('I. 路由接线（server.js + 前端）');

const SERVERJS = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
const APPJS = fs.readFileSync(path.join(__dirname, 'public', 'js', 'app.js'), 'utf8');

ok('I1 server.js require 了 parent 模块',
  /require\(['"]\.\/server\/parent['"]\)/.test(SERVERJS), null);
ok('I2 server.js 注册了 GET /api/parent',
  /p === '\/api\/parent' && method === 'GET'/.test(SERVERJS), null);
ok('I3 /api/health 的 apis 数组里有 parent',
  /'dashboard', 'daily', 'weekly', 'parent'/.test(SERVERJS), null);
ok('I4 家长端接口把 e.code 透出去（不是笼统 BAD_INPUT）',
  /parent\.build\(sid[\s\S]{0,200}e\.code/.test(SERVERJS), null);

// 前端：家长端必须能从界面到达（否则后端写得再好也没人看得见）
ok('I5 前端有家长视角的调用', /api\/parent/.test(APPJS), null);
ok('I6 家长端不是一个新的顶级导航（顶级导航只有 对话/知识库）',
  (APPJS.match(/nav-i\[data-view/g) || []).length <= 3, (APPJS.match(/nav-i\[data-view/g) || []).length);

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

'use strict';
/**
 * 7 阶段成长画像（批次22-③）模块级测试。
 *
 * 本套件要钉死的三件事（对应 growth.js 头部的三条规矩）：
 *  ① **不评分** —— 返回结构里不许出现 score / grade / rank / level 这类字段。
 *  ② **算不出来就说算不出来** —— 空空间六维度全是 null（不是 0）；null 与 0 分开。
 *  ③ **不给外部激励** —— 阶段表里不许出现"等级/排行/超越百分之多少"的措辞。
 * 外加：全部**现算**（删掉任何快照表不影响）、跨空间隔离、unknown 不计入分母。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hl-growth-'));
process.env.DATA_DIR = TMP;
process.env.NO_DOTENV = '1';

let pass = 0, fail = 0;
const fails = [];
function ok(name, cond, extra) {
  if (cond) { pass++; } else { fail++; fails.push(name + (extra !== undefined ? '  [' + JSON.stringify(extra) + ']' : '')); }
}
function group(t) { console.log('\n' + t); }

const D = require('./server/db');
const growth = require('./server/growth');

const DAY = 86400000;
const SID = 'sp_growth';
const OTHER = 'sp_growth_other';

function dayOff(n) { const d = new Date(Date.now() + n * DAY); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
function tsAt(dateStr, hour) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d, hour || 10, 0, 0).getTime();
}

let seq = 0;
function addCard(spaceId, knowledge, status, subject, stage) {
  seq++;
  const id = spaceId + '_gc' + seq;
  D.run('INSERT INTO cards(id,space_id,knowledge,question,answer,type,subject,status,stage,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
    id, spaceId, knowledge, 'q', 'a', 'choice', subject || 'math', status || 'learning', stage || 0, D.now());
  return id;
}
function addReview(cardId, dayIdx, result, opts) {
  const o = opts || {};
  D.run(`INSERT INTO card_reviews(id,card_id,result,student_answer,ai_verdict,verdict_json,is_free,interval_days,next_due_at,reviewed_at)
    VALUES(?,?,?,?,?,?,?,?,?,?)`,
    'gr_' + Math.random().toString(36).slice(2, 10), cardId, result, o.answer || '',
    o.verdict || null, null, 0, 0, 0, tsAt(dayOff(dayIdx), o.hour || 10));
}

// ============================================================
group('A. ★★ 规矩②：空空间算不出来就说算不出来（六维全 null，不是 0）');
{
  const p = growth.portrait('sp_empty');
  ok('A1 空空间也返回 7 个阶段', p.stages.length === 7, p.stages.length);
  ok('A2 空空间 currentStage = 0（一段都没走到）', p.currentStage === 0, p.currentStage);
  ok('A3 ★★ 六个维度全是 null，一个 0 都不许有',
    p.dimensions.length === 6 && p.dimensions.every(d => d.value === null),
    p.dimensions.map(d => d.key + '=' + d.value));
  ok('A4 ★★ overview 是 null 而不是 0（没有可算的就不给数）', p.overview === null, p.overview);
  ok('A5 unknownDimensions 如实列出全部六项',
    Array.isArray(p.unknownDimensions) && p.unknownDimensions.length === 6, p.unknownDimensions);
  ok('A6 每个算不出来的维度都给了"为什么算不出来"', p.dimensions.every(d => d.value !== null || !!d.why),
    p.dimensions.filter(d => d.value === null && !d.why).map(d => d.key));
  ok('A7 空空间 nextStage 是第一步（不是 null）', p.nextStage && p.nextStage.index === 1, p.nextStage && p.nextStage.index);
}

// ============================================================
group('B. ★★ 规矩①：返回结构里不许出现"分数/等级/名次"字段');
{
  // 造一个数据比较全的空间
  const c1 = addCard(SID, '判别式', 'mastered', 'math', 4);
  const c2 = addCard(SID, '过去完成时', 'almost', 'english', 3);
  const c3 = addCard(SID, '光合作用', 'learning', 'science', 1);
  addReview(c1, -14, 'right', { verdict: 'solid' });
  addReview(c1, -8, 'right', { verdict: 'solid' });
  addReview(c1, -1, 'right', {});
  addReview(c2, -9, 'right', {});
  addReview(c2, -2, 'wrong', {});
  addReview(c3, -5, 'unknown', {});
  D.run("INSERT INTO projects(id,space_id,name,instructions,created_at,updated_at) VALUES(?,?,?,?,?,?)",
    'pj_g1', SID, '我的项目', '', D.now(), D.now());

  const p = growth.portrait(SID);
  const raw = JSON.stringify(p);
  ok('B1 ★★ 全结构里没有 score 字段', !/"score"\s*:/.test(raw), (raw.match(/"score"\s*:/) || [])[0]);
  ok('B2 ★★ 没有 grade 字段', !/"grade"\s*:/.test(raw));
  ok('B3 ★★ 没有 rank / ranking 字段', !/"rank(ing)?"\s*:/.test(raw));
  ok('B4 ★★ 没有 level 字段', !/"level"\s*:/.test(raw));
  // ★ 顶层不许有"总分"字段。注意 raw 里的 `raw.total`（覆盖率的分母）是**合法**的，
  //   它是"这张卡分母是多少"，不是"你得了几分"。所以要按**层级**判，不能全局 grep。
  ok('B5 ★★ 顶层没有 total / totalScore / overall 这类"总分"字段',
    !/"(total|totalScore|overall|avg)"\s*:/.test('{' + raw.replace(/^\{/, '').split('"dimensions"')[0]) &&
    !/"totalScore"\s*:/.test(raw) && !/"overall"\s*:/.test(raw),
    Object.keys(p));
  ok('B6 overview 不叫"分数"，且它是"已看得出来部分的平均"（可为 null）',
    p.overview === null || typeof p.overview === 'number', typeof p.overview);
  ok('B7 ★★ notScored 是结构化条目（有条目、每条带 why），不是一段散文',
    Array.isArray(p.notScored) && p.notScored.length >= 3 && p.notScored.every(x => x.title && x.why),
    p.notScored.length);
}

// ============================================================
group('C. ★★ 规矩③：阶段名/文案里不许有"等级感、攀比感"的措辞');
{
  const p = growth.portrait(SID);
  // ★ 判据不是"这些字永不出现" —— 我们的 notScored 文案里**恰恰要说明**
  //   "我们不叫青铜/王者、不排名"。那是**否定性声明**，不是激励。
  //   所以要判的是：这些词只出现在"否定语境"（不/没有/而非）里，且**不出现在**任何
  //   阶段名、维度标签、阶段说明、evidence 的字段值里。
  const rewardWords = ['青铜', '白银', '黄金', '王者', '钻石', '大师', '排行榜', '击败', '打败', '领先', '百分位'];
  const stageBlob = JSON.stringify({
    names: p.stages.map(s => s.name),
    descs: p.stages.map(s => s.desc),
    whys: p.stages.map(s => s.why),
    labels: p.dimensions.map(d => d.label),
  });
  rewardWords.forEach(w => {
    ok('C: 阶段名/描述/维度标签里不许出现「' + w + '」', stageBlob.indexOf(w) < 0, w);
  });
  // 「排名/比较」只许以否定形式出现
  const nsText = JSON.stringify(p.notScored) + JSON.stringify(p.limits);
  const badRank = /(?<!不)(?<!没有)(?<!不做)(?<!不显示)排名/.test(nsText) && !/不排名|不做任何跨用户排行|不给排名/.test(nsText);
  ok('C-rank ★ 出现「排名」时必须是在声明"我们不排名"，不是在做排名', !badRank, badRank);
  ok('C-last ★ 7 个阶段名都是"动作"而不是"等级"',
    growth.STAGES.every(s => !/^等级|^Lv|^Level/.test(s.name)), growth.STAGES.map(s => s.name));
  ok('C-count ★★ 阶段数正好是 7', growth.STAGES.length === 7, growth.STAGES.length);
}

// ============================================================
group('D. ★ 口径：unknown 不计入分母（与 daily/weekly/parent 逐字一致）');
{
  const s = growth.gather(SID);
  // 该空间复习：c1 三次 right、c2 一次 right 一次 wrong、c3 一次 unknown
  ok('D1 right 计数正确', s.reviews.right === 4, s.reviews.right);
  ok('D2 wrong 计数正确', s.reviews.wrong === 1, s.reviews.wrong);
  ok('D3 unknown 单独计数', s.reviews.unknown === 1, s.reviews.unknown);
  ok('D4 ★★ judged = right + wrong（unknown 不计入）', s.reviews.judged === 5, s.reviews.judged);
  ok('D5 ★ 答得准维度 = right / judged',
    growth.portrait(SID).dimensions.filter(d => d.key === 'accuracy')[0].value === Math.round(4 / 5 * 100),
    growth.portrait(SID).dimensions.filter(d => d.key === 'accuracy')[0].value);
  ok('D6 理解核对：verdict 计数来自 ai_verdict 列', s.reviews.verdicts === 2 && s.reviews.solid === 2,
    { verdicts: s.reviews.verdicts, solid: s.reviews.solid });
}

// ============================================================
group('E. ★ 跨度：只有一次复习 = 0 天（真事实）；一次都没有 = null（算不出来）');
{
  const s = growth.gather(SID);
  // c1 从 -14 到 -1 ⇒ 13 天，是最大值
  ok('E1 最大跨度按最早/最近两次复习算', s.cards.maxSpanDays === 13, s.cards.maxSpanDays);
  ok('E2 avgSpanDays 是数字', typeof s.cards.avgSpanDays === 'number', s.cards.avgSpanDays);

  const S2 = 'sp_growth_span';
  const a = addCard(S2, '只复习过一次', 'learning', 'math', 0);
  addReview(a, -3, 'right', {});
  const s2 = growth.gather(S2);
  ok('E3 ★★ 只有一次复习 ⇒ 跨度 0 天（不是 null）', s2.cards.maxSpanDays === 0, s2.cards.maxSpanDays);
  ok('E4 ★ 只有一次复习时"记得久"维度是 0 而不是 null',
    growth.portrait(S2).dimensions.filter(d => d.key === 'stability')[0].value === 0,
    growth.portrait(S2).dimensions.filter(d => d.key === 'stability')[0].value);

  const S3 = 'sp_growth_nospan';
  addCard(S3, '完全没复习', 'learning', 'math', 0);
  const s3 = growth.gather(S3);
  ok('E5 ★★ 一次复习都没有 ⇒ 跨度 null（"算不出来"，与 0 天分得开）', s3.cards.maxSpanDays === null, s3.cards.maxSpanDays);
  ok('E6 此时"记得久"维度是 null 而不是 0',
    growth.portrait(S3).dimensions.filter(d => d.key === 'stability')[0].value === null,
    growth.portrait(S3).dimensions.filter(d => d.key === 'stability')[0].value);
}

// ============================================================
group('F. ★★ 全部现算：删掉任何"快照味道"的表，数字一个都不许变');
{
  const before = JSON.stringify(growth.portrait(SID));
  // weekly_reports / daily_reports 是仅有的"人写"表；画像不该依赖它们
  D.run('DELETE FROM weekly_reports');
  D.run('DELETE FROM daily_reports');
  const after = JSON.stringify(growth.portrait(SID));
  ok('F1 ★★ 删掉 weekly_reports / daily_reports 后画像一字节不变', before === after,
    before === after ? null : '变了');
}

// ============================================================
group('G. ★★ 跨空间隔离：甲的数据绝不出现在乙的画像里');
{
  const c = addCard(OTHER, '隔壁空间的卡', 'mastered', 'math', 5);
  addReview(c, -2, 'right', { verdict: 'solid' });
  const pOther = growth.portrait(OTHER);
  const pMine = growth.portrait(SID);
  ok('G1 隔壁空间自己的数字是对的（不是 0）',
    pOther.dimensions.filter(d => d.key === 'depth')[0].value > 0,
    pOther.dimensions.filter(d => d.key === 'depth')[0].value);
  // 把隔壁的卡删掉，我这边必须一字节不变
  const mineBefore = JSON.stringify(pMine);
  D.run('DELETE FROM cards WHERE space_id = ?', OTHER);
  const mineAfter = JSON.stringify(growth.portrait(SID));
  ok('G2 ★★ 改隔壁空间后，我的画像一字节不动', mineBefore === mineAfter, '被串了');
  ok('G3 ★★ 隔壁的卡不进我的"碰过范围"',
    growth.gather(SID).cards.total === 3, growth.gather(SID).cards.total);
}

// ============================================================
group('H. 阶段推进：逐条事实推进到对应阶段');
{
  const S = 'sp_growth_stages';
  // 阶段1：收下卡
  const c = addCard(S, '卡1', 'learning', 'math', 0);
  let p = growth.portrait(S);
  ok('H1 有 1 张卡 ⇒ 第 1 步已走到', p.stages[0].reached === true, p.stages[0].reached);
  ok('H2 但第 2 步（复习满 5 次）还没到', p.stages[1].reached === false, p.stages[1].reached);
  ok('H3 currentStage = 1', p.currentStage === 1, p.currentStage);
  ok('H4 nextStage 是第 2 步', p.nextStage && p.nextStage.index === 2, p.nextStage && p.nextStage.index);

  // 补到 5 次复习 ⇒ 第 2 步
  for (let i = 0; i < 5; i++) addReview(c, -5 + i, 'right', {});
  p = growth.portrait(S);
  ok('H5 复习满 5 次 ⇒ 第 2 步已走到', p.stages[1].reached === true, p.stages[1].reached);
  ok('H6 currentStage 推到 2', p.currentStage === 2, p.currentStage);

  // 判得出对错满 10 次 ⇒ 第 4 步（跳过第 3 步是可以的：阶段各自独立判定）
  for (let i = 0; i < 5; i++) addReview(c, -3, 'right', {});
  p = growth.portrait(S);
  ok('H7 判得出对错满 10 次 ⇒ 第 4 步已走到', p.stages[3].reached === true, p.stages[3].reached);

  // 理解核对 solid 满 3 次 ⇒ 第 5 步
  for (let i = 0; i < 3; i++) addReview(c, -2 + i, 'right', { verdict: 'solid' });
  p = growth.portrait(S);
  ok('H8 理解到位满 3 次 ⇒ 第 5 步已走到', p.stages[4].reached === true, p.stages[4].reached);
  ok('H9 ★ 每个"已走到"的阶段都带 evidence 指针',
    p.stages.filter(s => s.reached).every(s => s.evidence && typeof s.evidence === 'object'),
    p.stages.filter(s => s.reached).map(s => s.key));
}

// ============================================================
group('I. 递归扫：返回结构里不许有 undefined（JSON.stringify 会丢键）');
{
  const walk = (v, p, bad) => {
    if (v === undefined) { bad.push(p); return; }
    if (v === null) return;
    if (Array.isArray(v)) { v.forEach((x, i) => walk(x, p + '[' + i + ']', bad)); return; }
    if (typeof v === 'object') Object.keys(v).forEach(k => walk(v[k], p + '.' + k, bad));
  };
  const bad = [];
  walk(growth.portrait(SID), 'portrait', bad);
  ok('I1 portrait() 无 undefined', bad.length === 0, bad.slice(0, 5));
  const bad2 = [];
  walk(growth.portrait('sp_empty'), 'empty', bad2);
  ok('I2 空空间的 portrait() 也无 undefined', bad2.length === 0, bad2.slice(0, 5));
}

// ============================================================
group('J. 静态：前端用**原生 SVG** 画（不许出图片）、null 不补 0、不出现分数字样');
{
  const app = fs.readFileSync(path.join(__dirname, 'public/js/app.js'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, 'public/app.css'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, 'public/index.html'), 'utf8');

  ok('J1 前端有 loadGrowth（调 /api/growth）', /\/api\/growth/.test(app));
  const gStart = app.indexOf('function growthRadar');
  const gFn = gStart >= 0 ? app.slice(gStart, app.indexOf('function renderGrowth', gStart)) : '';
  ok('J2 ★★ 雷达用原生 <svg> 生成（不是 <img>/图片）',
    /'<svg class="g-radar"/.test(gFn) && !/<img/.test(gFn), gFn.slice(0, 60));
  ok('J3 ★★ null 的维度画成虚线空心点（与"有值"的实心点区分开）',
    /stroke-dasharray="2 2"/.test(gFn), '没找到虚线空心点');
  ok('J4 ★★ null 的维度只连"算得出来"的那些（known.length >= 2 才画多边形）',
    /known\.length >= 2/.test(gFn), '没看到 known 过滤');
  ok('J5 ★ "还看不出来"与百分比是两套渲染，不共用',
    /还看不出来/.test(app) && /g-na/.test(app) && /g-dim-v/.test(app));
  ok('J6 ★★ 前端不许把 null 显示成 0%：null 分支里不出现 0 + % 的组合',
    !/value === null[\s\S]{0,80}'\s*\+\s*0\s*\+\s*'%/.test(app));
  // 页面上不许出现"总分/得分"这类字样（画像区域内）。
  // ★ 「排名」在我们自己的 notScored 文案里是**否定性声明**（"不排名"），
  //   所以这里只查真正会印在用户眼前的分数字样，且排除否定形式。
  const rFn = app.slice(app.indexOf('function renderGrowth'), app.indexOf('// ================= 测评（P6）'));
  ['总分', '得分', '你的分数', '评级'].forEach(w => {
    ok('J7 画像区文案里不许出现「' + w + '」', rFn.indexOf(w) < 0, w);
  });
  ok('J7b ★ 「排名」若出现必须是"不排名/不给排名"的声明',
    !/排名/.test(rFn) || /不给排名|不排名|不做任何跨用户排行/.test(rFn), null);
  ok('J8 容器 #growthBox 在 index.html 里存在', /id="growthBox"/.test(html));
  ok('J9 loadExams 会去取画像', /loadGrowth\(\)/.test(app));
  // CSS 顺序：画像样式在第一个 @media 之前
  const gcss = css.indexOf('.g-wrap');
  const firstMedia = css.search(/(^|\n)\s*@media/);
  ok('J10 画像样式写在第一个 @media 之前', gcss > 0 && gcss < firstMedia, 'g@' + gcss + ' media@' + firstMedia);
  ok('J11 ★ 算不出来的维度有独立样式（不是只靠颜色淡一点）',
    /\.g-na \{/.test(css) && /\.g-dim\.na b/.test(css));
  ok('J12 雷达图有 aria-label（不是纯装饰图）', /aria-label=/.test(gFn));
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

'use strict';
/**
 * 批次10 自检（模块级）：学习日报。
 *
 * 这套测试守的不是"功能能不能跑"，而是**这份日报会不会说谎**。
 * 日报是最容易悄悄变坏的一类功能：数字错了没人会报错，
 * 学生看到"正确率 0%"就真的以为自己不行了。
 *
 * 六组：
 *   A. 四问齐全、问句非空
 *   B. 每个数字都必须带 evidence（点得开），否则"可溯源"是假的
 *   C. ★ 算不出来就说算不出来（null 而非 0），且必须附上为什么
 *   D. ★ 口径一致：说"判不了对错的没算进对错"，分母就必须真的不含它
 *   E. 溯源指向的是**原始记录**（带学生自己写的原话），且跨空间取不到
 *   F. 草稿/定稿/历史 的边界行为
 *
 * 只读设计：写入落在临时 DATA_DIR，跑完删掉。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hl-p10-'));
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
const core = require('./server/core');
const daily = require('./server/daily');

const TODAY = daily.dayKey(D.now());
/**
 * ★ 造练习记录的时间基准 = **今天中午 12:00**，不是"现在往前推 N 分钟"。
 *
 * 原来用 `D.now() - 40 分钟`，在午夜刚过时跑就会推到**昨天**：TODAY 已经是新的一天，
 * 当天一条判得出对错的记录都没有 → judged=0 → accuracy 的 evidence 按设计置 null
 * → 下面那句 `acc.evidence.ids.length` 直接把进程崩掉，整套统计成 0 项，
 * 看着像"这一批全挂了"。2026-10-02 00:14 真踩了一次。
 *
 * 以中午为锚点往前推，不管几点跑，日期都落在今天。
 */
const DAY_ANCHOR = (() => { const d = new Date(); d.setHours(12, 0, 0, 0); return d.getTime(); })();
const SP = '_public';
const OTHER = '_other_space';

function mkCard(knowledge, subject) {
  const id = D.uid('c_');
  D.run('INSERT INTO cards(id,space_id,user_id,knowledge,question,answer,type,subject,status,stage,due_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
    id, SP, null, knowledge, 'q', 'a', 'choice', subject || 'math', 'learning', 0, 0, D.now());
  return id;
}
function mkReview(cardId, result, answer, aiVerdict, minutesAgo) {
  const id = D.uid('r_');
  D.run('INSERT INTO card_reviews(id,card_id,result,student_answer,ai_verdict,is_free,reviewed_at) VALUES(?,?,?,?,?,?,?)',
    id, cardId, result, answer || '', aiVerdict || '', 0, DAY_ANCHOR - (minutesAgo || 0) * 60000);
  return id;
}

// ---------- A. 空空间：四问齐全 ----------
group('A. 四问框架');

let r = daily.build(SP, TODAY);
ok('四问数量为 4', r.questions.length === 4, r.questions.length);
ok('四问 key 与顺序固定：goal / state / process / adjust',
  r.questions.map(q => q.key).join(',') === 'goal,state,process,adjust', r.questions.map(q => q.key));
r.questions.forEach(q => {
  ok('「' + q.key + '」有标题', !!q.title);
  ok('★ 「' + q.key + '」有自己的问句（不是空的占位）', typeof q.ask === 'string' && q.ask.length >= 6, q.ask);
  ok('「' + q.key + '」findings 是数组', Array.isArray(q.findings));
  ok('「' + q.key + '」unknown 是数组', Array.isArray(q.unknown));
});
// 问句必须是"问句"—— 用问号收尾，这是产品立场（不给答案，只反问）
const asksWithQuestion = r.questions.filter(q => /[？?]/.test(q.ask)).length;
ok('★ 四问的问句都以问号收尾（反问而非给答案）', asksWithQuestion === 4, asksWithQuestion);

// ---------- B. 每个数字都要能溯源 ----------
group('B. 指标必须带 evidence');

ok('指标非空', r.metrics.length >= 6, r.metrics.length);
r.metrics.forEach(m => {
  ok('指标「' + m.key + '」有 label', !!m.label);
  ok('指标「' + m.key + '」有 value 字段', 'value' in m);
  // ★ 判据要分开写：**有数字**的指标必须能溯源；value 为 null 的指标不该给假依据。
  //   一开始我写成"所有指标都必须有 evidence"，结果在空数据下自己红了 —— 那是测试错，不是实现错。
  if (m.value === null) {
    ok('★ 指标「' + m.key + '」没有数字，所以也不给 evidence（不许造依据）', m.evidence === null, m.evidence);
  } else {
    ok('★ 指标「' + m.key + '」有数字，就必须带 evidence（否则"可溯源"是假的）',
      !!m.evidence && Array.isArray(m.evidence.ids), m.evidence);
    ok('指标「' + m.key + '」evidence.kind 是已知类型',
      !!m.evidence && ['activity', 'review', 'card'].indexOf(m.evidence.kind) >= 0, m.evidence && m.evidence.kind);
  }
});
ok('存在 scope=now 的指标（到期未练是"此刻"而不是"当天"）',
  r.metrics.some(m => m.scope === 'now'), r.metrics.map(m => m.key + ':' + m.scope));
ok('指标 key 不重复', new Set(r.metrics.map(m => m.key)).size === r.metrics.length);

// ---------- C. 算不出来就说算不出来 ----------
group('C. 空数据时不许补零');

const acc0 = r.metrics.filter(m => m.key === 'accuracy')[0];
const span0 = r.metrics.filter(m => m.key === 'span')[0];
ok('★ 无练习时 accuracy 是 null（不是 0）', acc0.value === null, acc0.value);
ok('★ accuracy 为 null 时附了原因', typeof acc0.unknown === 'string' && acc0.unknown.length >= 6, acc0.unknown);
ok('★ accuracy 为 null 时 evidence 也是 null（没数字就别给假依据）', acc0.evidence === null, acc0.evidence);
ok('★ 不足两条记录时 span 是 null（0 分钟没有意义）', span0.value === null, span0.value);
ok('★ span 为 null 时附了原因', typeof span0.unknown === 'string' && span0.unknown.length >= 6, span0.unknown);
ok('★ headline 明说今天没有记录', r.headline.indexOf('还没有留下') >= 0, r.headline);
ok('★ hasRecord=false', r.hasRecord === false);
ok('★ 空数据时四问给出了"说不清"的说明',
  r.questions.every(q => q.unknown.length > 0 || q.findings.length > 0),
  r.questions.map(q => q.key + ':' + q.unknown.length + '/' + q.findings.length));

// 每个"value 为 null"的指标都必须有 unknown 文案（这条是 C 组的总闸）
ok('★ 所有 null 值指标都有 unknown 文案',
  r.metrics.filter(m => m.value === null).every(m => typeof m.unknown === 'string' && m.unknown.length > 0),
  r.metrics.filter(m => m.value === null).map(m => m.key));

// ---------- 造数据 ----------
const c1 = mkCard('勾股定理', 'math');
const c2 = mkCard('光合作用', 'science');
const rWrongA = mkReview(c1, 'wrong', '我写的第一版答案', 'off', 40);
const rWrongB = mkReview(c1, 'wrong', '我写的第二版答案', '', 20);
const rUnknown = mkReview(c2, 'unknown', '我自己也说不清', 'unknown', 10);
core.logActivity(SP, null, 'chat', 'conv_1', { title: '问了一道题' });
core.logActivity(SP, null, 'card_created', c1, {});
core.logActivity(SP, null, 'card_review', c1, {});

r = daily.build(SP, TODAY);

// ---------- D. 口径一致（核心） ----------
group('D. 口径必须处处一致');

ok('有记录时 hasRecord=true', r.hasRecord === true);
const acc = r.metrics.filter(m => m.key === 'accuracy')[0];
ok('★ 正确率分母只含判得出对错的（2 错 0 对 → 0%）', acc.value === 0, acc.value);
ok('★ accuracy 的 evidence 恰好是那 2 条判得出对错的，不含 unknown 那条',
  acc.evidence && acc.evidence.ids.length === 2 &&
  acc.evidence.ids.indexOf(rUnknown) < 0 &&
  acc.evidence.ids.indexOf(rWrongA) >= 0 && acc.evidence.ids.indexOf(rWrongB) >= 0,
  acc.evidence && acc.evidence.ids);
ok('unknown 指标单独计数为 1', r.metrics.filter(m => m.key === 'unknown')[0].value === 1);

const nsUnknown = r.notScored.filter(x => x.title.indexOf('只统计能对上原话的') >= 0)[0];
ok('★ notScored 里点名了"判不了对错的没有计入对错"',
  !!nsUnknown && nsUnknown.why.indexOf('没有') >= 0 && nsUnknown.why.indexOf('1 次') >= 0, nsUnknown && nsUnknown.why);
// 反证：如果哪天有人把分母改回全部练习，上面两条会同时红 —— 这就是这组的意义
// （right/wrong 从 facts 取 —— build() 的返回值里没有这两个字段，我一开始就取错了）
const f10 = daily.facts(SP, TODAY);
// ★ 断言表达式里也得判空：evidence 在"今天没有能判对错的练习"时是**故意置 null** 的，
//   直接 `.ids.length` 会把整个套件崩成 0 项，把后面所有断言的结果一起掩盖掉 ——
//   看起来像"全挂了"，实际只是这一条不成立。宁可让这一条红，也别让输出被带走。
const accIds = (acc.evidence && acc.evidence.ids) ? acc.evidence.ids.length : null;
ok('★ 「不计入对错」的说法与 accuracy 的分母一致（口径不自相矛盾）',
  nsUnknown.why.indexOf('计入对错') >= 0 && accIds === f10.right + f10.wrong,
  { evidence: accIds, judged: f10.right + f10.wrong, right: f10.right, wrong: f10.wrong, unknown: f10.unknown });

const stateQ = r.questions.filter(q => q.key === 'state')[0];
const stateAll = stateQ.findings.map(f => f.text).join(' ');
ok('state 里报了对错数', stateAll.indexOf('答对 0 次') >= 0 && stateAll.indexOf('没答对 2 次') >= 0, stateAll);
ok('★ state 里把"判不了对错"的次数单独说明，不混进对错',
  stateAll.indexOf('判不了对错') >= 0, stateAll);
ok('★ 反复没答对的知识点被点名（勾股定理 2 次）',
  stateAll.indexOf('勾股定理') >= 0 && stateAll.indexOf('2 次') >= 0, stateAll);

// ---------- 不评分的原因 ----------
group('D2. 「不评分的原因」必须写满');

ok('notScored 至少 4 条', r.notScored.length >= 4, r.notScored.length);
r.notScored.forEach(x => {
  ok('notScored「' + x.title + '」有标题', !!x.title);
  ok('★ notScored「' + x.title + '」有实质说明（≥20 字）', typeof x.why === 'string' && x.why.length >= 20, x.why && x.why.length);
});
const nsAll = r.notScored.map(x => x.title + x.why).join(' ');
ok('★ 明说"分数会把没答对说成你不行"', nsAll.indexOf('你不行') >= 0 || nsAll.indexOf('分数') >= 0);
ok('★ 明说"数字不等于掌握"', nsAll.indexOf('掌握') >= 0);
ok('★ 明说"算不出来就说算不出来，不补 0"', nsAll.indexOf('0') >= 0 && nsAll.indexOf('不知道') >= 0);

ok('limits 至少 3 条', r.limits.length >= 3, r.limits.length);
ok('★ limits 明说日报只覆盖本空间（不冒充全貌）', r.limits.join(' ').indexOf('这个空间') >= 0);
ok('★ limits 明说"记录多不等于学得好"', r.limits.join(' ').indexOf('不等于') >= 0);
ok('★ limits 明说"以原始记录为准"', r.limits.join(' ').indexOf('原始记录') >= 0);

// ---------- D3. 反证：分母口径（用一组"两种算法结果不同"的数据） ----------
group('D3. 反证：正确率的分母口径');

// 上面那组是 0 对 2 错 1 未知 —— 0/2 和 0/3 都等于 0，**区分不出**两种算法。
// 要验出差异，必须造一组"分子不为 0"的数据：1 对 1 错 1 未知。
//   只算判得出对错的：1/2 = 50%
//   把 unknown 也算进去：1/3 = 33%
// 这两个数不同，所以断言 50 才真的在测"分母口径"，而不是在测一个巧合。
const SD = '_denom_space';
function mkCardIn(space, knowledge) {
  const id = D.uid('c_');
  D.run('INSERT INTO cards(id,space_id,user_id,knowledge,question,answer,type,subject,status,stage,due_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
    id, space, null, knowledge, 'q', 'a', 'choice', 'math', 'learning', 0, 0, D.now());
  return id;
}
function mkReviewIn(cardId, result, answer, minutesAgo) {
  D.run('INSERT INTO card_reviews(id,card_id,result,student_answer,ai_verdict,is_free,reviewed_at) VALUES(?,?,?,?,?,?,?)',
    D.uid('r_'), cardId, result, answer, '', 0, DAY_ANCHOR - (minutesAgo || 0) * 60000);
}
const dc1 = mkCardIn(SD, '甲');
const dc2 = mkCardIn(SD, '乙');
const dc3 = mkCardIn(SD, '丙');
mkReviewIn(dc1, 'right', '答对了的那次', 30);
mkReviewIn(dc2, 'wrong', '答错了的那次', 20);
mkReviewIn(dc3, 'unknown', '说不清的那次', 10);

const rd = daily.build(SD, TODAY);
const accD = rd.metrics.filter(m => m.key === 'accuracy')[0];
ok('★ 1 对 1 错 1 未知 → 正确率 50%（分母只算判得出对错的 2 次）', accD.value === 50, accD.value);
ok('★ 不是 33%（如果把 unknown 也算进分母，就会是 33 —— 这条能验出区别）', accD.value !== 33, accD.value);
ok('★ 溯源只列那 2 条判得出对错的',
  !!accD.evidence && accD.evidence.ids.length === 2,
  accD.evidence ? accD.evidence.ids.length : null);
ok('unknown 单列为 1', rd.metrics.filter(m => m.key === 'unknown')[0].value === 1);
const stateD = rd.questions.filter(q => q.key === 'state')[0].findings.map(f => f.text).join(' ');
ok('state 里报了 1 对 1 错', stateD.indexOf('答对 1 次') >= 0 && stateD.indexOf('没答对 1 次') >= 0, stateD);

// ---------- E. 溯源 ----------
group('E. 溯源指向原始记录');

const ev = daily.evidence(SP, TODAY, 'accuracy');
ok('溯源条数与指标一致', ev.items.length === 2, ev.items.length);
ok('★ 溯源里带学生当时写的原话', ev.items.some(i => i.detail.indexOf('我写的第一版答案') >= 0), ev.items.map(i => i.detail));
ok('★ 溯源里带 AI 当时的判定', ev.items.some(i => i.aiVerdict === 'off'), ev.items.map(i => i.aiVerdict));
ok('★ 溯源里带判定结果（答对/没答对/没法判断）', ev.items.every(i => ['答对', '没答对', '没法判断'].indexOf(i.verdict) >= 0), ev.items.map(i => i.verdict));
ok('溯源带时间', ev.items.every(i => /^\d{2}:\d{2}$/.test(i.time)), ev.items.map(i => i.time));

const evAct = daily.evidence(SP, TODAY, 'records');
ok('活动类指标溯源可用', evAct.items.length >= 3, evAct.items.length);
ok('活动类溯源带中文动作名', evAct.items.every(i => i.title.length > 0 && !/^[a-z_]+$/.test(i.title)), evAct.items.map(i => i.title));

ok('未知指标返回空而不是报错', daily.evidence(SP, TODAY, '__nope__').items.length === 0);
ok('★ 跨空间溯源取不到（别的空间看不到我的记录）',
  daily.evidence(OTHER, TODAY, 'accuracy').items.length === 0);

// ---------- F. 草稿 / 定稿 / 历史 ----------
group('F. 草稿、定稿与历史');

daily.saveDraft(SP, TODAY, { goal: '想弄明白勾股定理' });
ok('草稿存下来了', daily.getReport(SP, TODAY).answers.goal === '想弄明白勾股定理');
daily.saveDraft(SP, TODAY, { goal: '想弄明白勾股定理', state: '有点卡' });
const rows = D.get('SELECT COUNT(*) c FROM daily_reports WHERE space_id = ? AND date = ?', SP, TODAY);
ok('★ 反复存草稿是覆盖，不是每次新建一行', rows.c === 1, rows.c);
ok('草稿状态是 draft', daily.getReport(SP, TODAY).status === 'draft');

daily.saveDraft(SP, TODAY, { goal: 'x', state: 'y', process: 'z', adjust: 'w', __evil: '注入' });
const rep = daily.getReport(SP, TODAY);
ok('★ answers 只收四问的 key，别的键被丢掉', !('__evil' in rep.answers), Object.keys(rep.answers));
ok('四问的 key 都在', ['goal', 'state', 'process', 'adjust'].every(k => k in rep.answers), Object.keys(rep.answers));

const longStr = 'x'.repeat(5000);
daily.saveDraft(SP, TODAY, { goal: longStr });
ok('★ 单条自述被截断（防超长撑爆存储）', daily.getReport(SP, TODAY).answers.goal.length <= 2000, daily.getReport(SP, TODAY).answers.goal.length);
daily.saveDraft(SP, TODAY, { goal: '正常内容' });
ok('非字符串被忽略而不是报错', typeof daily.getReport(SP, TODAY).answers.goal === 'string');

daily.finalize(SP, TODAY, { goal: '定稿时的内容' });
ok('定稿后 status=final', daily.getReport(SP, TODAY).status === 'final');
ok('定稿保留了内容', daily.getReport(SP, TODAY).answers.goal === '定稿时的内容');
daily.saveDraft(SP, TODAY, { goal: '事后篡改' });
ok('★ 定稿后再存草稿无效（"当时写的"不该被后来改写）',
  daily.getReport(SP, TODAY).answers.goal === '定稿时的内容', daily.getReport(SP, TODAY).answers.goal);

const yesterday = daily.dayKey(D.now() - 86400000);
daily.saveDraft(SP, yesterday, { goal: '昨天写的' });
const hist = daily.history(SP, 10);
ok('历史含两天', hist.length === 2, hist.length);
ok('★ 历史按日期倒序（今天在前）', hist[0].date === TODAY && hist[1].date === yesterday, hist.map(h => h.date));
ok('历史带状态', hist[0].status === 'final' && hist[1].status === 'draft', hist.map(h => h.status));
ok('★ 历史带"填了几问"（4 问里填了几个）', hist.every(h => h.filled >= 0 && h.filled <= 4), hist.map(h => h.filled));

// build() 里也要带出 answers，否则前端拿不到草稿
const built = daily.build(SP, TODAY);
ok('★ build() 带出已保存的自述（前端刷新后草稿还在）', built.answers.goal === '定稿时的内容', built.answers);
ok('build() 带出状态', built.status === 'final', built.status);

// ---------- G. 跨空间隔离 ----------
group('G. 跨空间隔离');

const otherRep = daily.build(OTHER, TODAY);
ok('★ 别的空间看不到我的记录', otherRep.hasRecord === false);
ok('★ 别的空间看不到我的日报草稿', JSON.stringify(otherRep.answers) === '{}', otherRep.answers);
ok('★ 别的空间的历史是空的', daily.history(OTHER, 10).length === 0);

// ---------- 汇总 ----------
console.log('\n' + '─'.repeat(60));
if (fail) {
  console.log('✗ 通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  fails.forEach(f => console.log('  ✗ ' + f));
} else {
  console.log('✓ 通过 ' + pass + ' 项，失败 0 项');
}
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
process.exit(fail ? 1 : 0);

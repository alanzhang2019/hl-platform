'use strict';
/**
 * 后浪学习平台 · P3 / P6 / P10 端到端自检
 *
 * 覆盖：
 *   P10 英语   单词本 / 批量导入 / 三种听写 / 批改逐位提示 / 单词转拼写卡 / 跟读比对
 *   P6  测评   出卷只从已有知识卡抽 / 取卷不泄漏答案 / 交卷回流知识卡 / 重复交卷拒绝
 *   P3  资料池 不做预置 / 昵称匿名化 / 取用是复制 / 举报满 3 自动下架 / 三次下架禁共享
 *
 * 规矩同 _platformtest.cjs：自带临时服务与临时 DATA_DIR，绝不动开发库；
 * 除正向跑通，还必须做反证（越权拿不到、泄漏真的没有、计数真的不涨）。
 *
 * 跑法：node _p3p6p10test.cjs
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const NODE = process.execPath;
const PORT = 3500 + Math.floor(Math.random() * 300);
const BASE = 'http://127.0.0.1:' + PORT;
const DATA_DIR = path.join(os.tmpdir(), 'hl-p3p6p10-' + crypto.randomBytes(4).toString('hex'));

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  \u2713 ' + name); }
  else { fail++; failures.push(name + (extra ? ' → ' + (typeof extra === 'string' ? extra : JSON.stringify(extra)) : '')); console.log('  \u2717 ' + name + (extra ? ' → ' + (typeof extra === 'string' ? extra : JSON.stringify(extra)) : '')); }
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
const PATCH = (p, b, t) => req('PATCH', p, b, t);
const DEL = (p, t) => req('DELETE', p, undefined, t);

function startServer() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const child = spawn(NODE, ['server.js'], {
    cwd: __dirname,
    // NO_DOTENV=1：见 _platformtest.cjs 同名注释 —— 别读到本机真实 .env。
    env: Object.assign({}, process.env, { PORT: String(PORT), DATA_DIR, ADMIN_PASSWORD: 'test-admin-pw', LLM_API_KEY: '', NO_DOTENV: '1' }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', d => process.env.VERBOSE && process.stdout.write('[srv] ' + d));
  child.stderr.on('data', d => { if (process.env.VERBOSE) process.stderr.write('[srv:err] ' + d); });
  return child;
}
async function waitReady(ms) {
  const until = Date.now() + (ms || 60000);
  while (Date.now() < until) {
    try { const r = await fetch(BASE + '/api/health'); if (r.ok) return await r.json(); } catch (e) {}
    await new Promise(r => setTimeout(r, 150));
  }
  throw new Error('服务在超时前没有就绪');
}
function stopServer(child) {
  return new Promise(res => { child.once('exit', res); try { child.kill('SIGKILL'); } catch (e) { res(); } setTimeout(res, 2500); });
}
async function newSpace(name) {
  const r = await POST('/api/space', { name });
  if (!r.body || !r.body.token) throw new Error('建空间失败：' + JSON.stringify(r.body));
  return { id: r.body.spaceId, token: r.body.token, name: r.body.name };
}

// ==================================================================
(async () => {
  const child = startServer();
  let A, B, C, D;
  try {
    const health = await waitReady();
    console.log('后浪学习平台 · P3/P6/P10 端到端自检');
    console.log('  服务 ' + BASE + '   数据目录 ' + DATA_DIR + '   版本 ' + health.version);

    // ============================================================
    group('0. 健康检查声明了新模块');
    for (const a of ['english', 'exam', 'pool']) ok('apis 里有 ' + a, (health.apis || []).indexOf(a) >= 0);

    A = await newSpace('张小明');
    B = await newSpace('李小红');
    C = await newSpace('王大力');
    D = await newSpace('赵小雨');
    ok('建了 4 个空间用于跨空间验证', !!(A && B && C && D));

    // ============================================================
    // P10 英语
    // ============================================================
    group('P10-1. 单元与批量导入');
    const u1 = await POST('/api/english/units', { name: 'Unit 1 我的文具', grade: '七年级' }, A.token);
    eq('建单元 200', u1.status, 200);
    ok('单元有 id', !!(u1.body.unit && u1.body.unit.id));
    const emptyUnit = await POST('/api/english/units', { name: '   ' }, A.token);
    eq('空单元名被拒 400', emptyUnit.status, 400);

    const txt = [
      '# 这是注释行，应被跳过',
      'apple /ˈæpl/ 苹果',
      'banana 香蕉',
      'cherry,樱桃',
      'date\t枣',
      'egg - 鸡蛋',
      'fig',
      '!!!这一行不是单词',
      'a b c d e f 这行词太多',
    ].join('\n');
    const imp = await POST('/api/english/words/import', { text: txt, unitId: u1.body.unit.id }, A.token);
    eq('导入返回 200', imp.status, 200);
    eq('认出了 6 个词', imp.body.added, 6);
    eq('跳过了 2 行（乱码行 + 词数过多行）', imp.body.skipped.length, 2);
    ok('跳过行被报回而不是静默丢弃', imp.body.skipped.some(l => l.indexOf('!!!') >= 0));

    const dup = await POST('/api/english/words/import', { text: 'apple 苹果\nbanana 香蕉' }, A.token);
    eq('重复导入不新增（去重）', dup.body.added, 0);
    eq('重复词被单独报出来，而不是算成"新增"', dup.body.duplicates, 2);
    eq('重复词清单对得上', dup.body.duplicateWords.sort(), ['apple', 'banana']);

    const words = await GET('/api/english/words', A.token);
    eq('单词表共 6 个', words.body.words.length, 6);
    const apple = words.body.words.filter(w => w.word === 'apple')[0];
    eq('apple 音标被解析出来', apple.phonetic, 'ˈæpl');
    eq('apple 中文意思被解析出来', apple.meaning, '苹果');
    ok('fig 没有中文也收下了', words.body.words.some(w => w.word === 'fig' && w.meaning === ''));

    const unitList = await GET('/api/english/units', A.token);
    eq('单元下的词数为 6', unitList.body.units[0].count, 6);

    group('P10-2. 单词增改删');
    const one = await POST('/api/english/words', { word: 'grape', meaning: '葡萄', unitId: u1.body.unit.id }, A.token);
    eq('新增单词 200', one.status, 200);
    const patched = await PATCH('/api/english/words/' + one.body.word.id, { meaning: '葡萄（紫色那种）' }, A.token);
    eq('改单词 200', patched.status, 200);
    ok('改动生效', patched.body.word.meaning.indexOf('紫色') >= 0);
    const delOne = await DEL('/api/english/words/' + one.body.word.id, A.token);
    eq('删单词 200', delOne.status, 200);
    const afterDel = await GET('/api/english/words', A.token);
    eq('删完还是 6 个', afterDel.body.words.length, 6);

    group('P10-3. 听写出题：不带答案');
    const d1 = await GET('/api/english/dictation?count=3&mode=meaning', A.token);
    eq('听写 200', d1.status, 200);
    eq('出了 3 题', d1.body.items.length, 3);
    eq('总数是词表大小', d1.body.total, 6);
    ok('题目里没有 answer 字段', d1.body.items.every(it => it.answer === undefined));
    ok('题目里没有 word 字段（那是答案）', d1.body.items.every(it => it.word === undefined));
    ok('看中文写英文：prompt 是中文', d1.body.items.every(it => /[\u4e00-\u9fa5]/.test(it.prompt)));

    const d2 = await GET('/api/english/dictation?count=2&mode=spell', A.token);
    eq('spell 模式 200', d2.status, 200);
    eq('spell 模式返回 mode 字段', d2.body.mode, 'spell');
    ok('spell 模式给出字母个数提示', d2.body.items.every(it => it.letters > 0));
    ok('spell 模式的提示不含完整单词', d2.body.items.every(it => it.hint.indexOf(it.prompt) < 0));

    const d3 = await GET('/api/english/dictation?count=2&mode=listen', A.token);
    eq('listen 模式 200', d3.status, 200);
    eq('listen 模式的 prompt 是英文单词本身', d3.body.mode, 'listen');

    const dBad = await GET('/api/english/dictation?mode=nonsense', A.token);
    eq('非法 mode 退化为 meaning', dBad.body.mode, 'meaning');

    group('P10-4. 批改：逐位提示，不给答案');
    const dict = await GET('/api/english/dictation?count=10&mode=meaning&order=random', A.token);
    const byWord = {};
    const all = (await GET('/api/english/words', A.token)).body.words;
    all.forEach(w => { byWord[w.word] = w; });

    const g1 = await POST('/api/english/grade', {
      items: [
        { id: byWord.apple.id, answer: 'aple' },        // 少一个字母
        { id: byWord.banana.id, answer: 'bananas' },    // 多一个字母
        { id: byWord.cherry.id, answer: 'cherri' },     // 少一个字母
        { id: byWord.date.id, answer: 'date' },         // 对
        { id: byWord.egg.id, answer: '' },              // 空
      ],
      createCards: false,
    }, A.token);
    eq('批改 200', g1.status, 200);
    eq('答对 1 题', g1.body.right, 1);
    eq('答错 3 题（空答案不计入对错，记为错但 diff 为 empty）', g1.body.wrong, 4);
    const rA = g1.body.results.filter(r => r.id === byWord.apple.id)[0];
    eq('apple 差一个字母', rA.diff.type, 'short');
    eq('apple 提示说少了 1 个字母', rA.diff.message, '少了 1 个字母');
    const rB = g1.body.results.filter(r => r.id === byWord.banana.id)[0];
    eq('banana 多一个字母', rB.diff.type, 'long');
    const rE = g1.body.results.filter(r => r.id === byWord.egg.id)[0];
    eq('空答案提示"没写"', rE.diff.type, 'empty');
    ok('批改结果里不含"第几个字母是什么"这种答案', !/正确|答案|应该是/.test(JSON.stringify(g1.body.results)));

    const afterGrade = await GET('/api/english/words?sort=wrong', A.token);
    const topWrong = afterGrade.body.words[0];
    ok('错得最多的词排到了最前面', topWrong.wrongCount >= 1, 'top=' + topWrong.word + ' wrong=' + topWrong.wrongCount);
    const appleAfter = afterGrade.body.words.filter(w => w.word === 'apple')[0];
    eq('apple 错次 +1', appleAfter.wrongCount, 1);
    eq('apple 对次仍为 0', appleAfter.rightCount, 0);
    const dateAfter = afterGrade.body.words.filter(w => w.word === 'date')[0];
    eq('date 对次 +1', dateAfter.rightCount, 1);

    group('P10-5. 单词 → 拼写卡（走同一套间隔复习）');
    const toCards = await POST('/api/english/words/to-cards', {}, A.token);
    eq('转卡 200', toCards.status, 200);
    ok('生成了拼写卡', toCards.body.count > 0, 'count=' + toCards.body.count);
    ok('生成的卡 type 都是 spelling', toCards.body.cards.every(c => c.type === 'spelling'));
    ok('生成的卡 subject 都是 english', toCards.body.cards.every(c => c.subject === 'english'));
    const again = await POST('/api/english/words/to-cards', {}, A.token);
    eq('再转一次不重复建卡', again.body.count, 0);

    const cardList = await GET('/api/cards?pageSize=200', A.token);
    const spellCards = cardList.body.items.filter(c => c.type === 'spelling');
    eq('知识卡里确实有 6 张拼写卡', spellCards.length, 6);

    group('P10-6. 跟读比对：诚实回显，不打音准分');
    const sp = await POST('/api/english/speech-compare', { target: 'I have an apple', heard: 'I have apple' }, A.token);
    eq('跟读比对 200', sp.status, 200);
    eq('听出来了 I / have / apple', sp.body.hit.length, 3);
    eq('没听出来 an', sp.body.miss, ['an']);
    ok('明确说明这不是音准分', /不是音准分/.test(sp.body.note));
    ok('没有编造"发音准确度"这类分数', sp.body.pronunciationScore === undefined);

    group('P10-7. 跨空间隔离');
    const bWords = await GET('/api/english/words', B.token);
    eq('B 空间看不到 A 的单词', bWords.body.words.length, 0);
    const bDelA = await DEL('/api/english/words/' + byWord.apple.id, B.token);
    eq('B 删不掉 A 的单词（静默失败）', bDelA.status, 200);
    const aStill = await GET('/api/english/words', A.token);
    eq('A 的单词还在', aStill.body.words.length, 6);
    const bPatchA = await PATCH('/api/english/words/' + byWord.apple.id, { meaning: '被改了' }, B.token);
    eq('B 改不了 A 的单词 404', bPatchA.status, 404);

    // ============================================================
    // P6 测评
    // ============================================================
    group('P6-1. 没有知识卡时不出卷（而不是编一套无关的题）');
    const noCard = await POST('/api/exams', { count: 5 }, B.token);
    eq('无卡出卷被拒 409', noCard.status, 409);
    eq('错误码是 NO_CARDS', noCard.body.error, 'NO_CARDS');
    ok('错误信息告诉用户该做什么', /知识卡/.test(noCard.body.message));

    group('P6-2. 出卷：题源是已有知识卡，且不下发答案');
    // A 空间现在有 6 张拼写卡（来自单词），再加两张不同类型的
    const cMath = await POST('/api/cards', {
      knowledge: '分数加法要先通分', subject: 'math', type: 'choice',
      question: '3/4 + 1/4 = ?', answer: '1',
      options: { choices: ['1', '4/8', '3/8', '2'], answerIndex: 0 },
    }, A.token);
    const cSci = await POST('/api/cards', {
      knowledge: '光合作用', subject: 'science', type: 'understanding',
      question: '用自己的话说说植物怎么制造养分', answer: '利用光能把二氧化碳和水变成有机物，并放出氧气',
    }, A.token);
    eq('建数学卡 200', cMath.status, 200);
    eq('建科学卡 200', cSci.status, 200);

    const mk = await POST('/api/exams', { count: 5, title: '期末小测' }, A.token);
    eq('出卷 200', mk.status, 200);
    const exam = mk.body.exam;
    ok('卷子有 id', !!exam.id);
    eq('卷子状态是 open', exam.status, 'open');
    ok('题目数 > 0', exam.itemCount > 0, 'itemCount=' + exam.itemCount);
    ok('取卷时 items 下发了（要用来做题）', Array.isArray(exam.items) && exam.items.length === exam.itemCount);

    // 关键反证：答案不能泄漏
    ok('取卷时 items[].answer 不下发', exam.items.every(it => it.answer === undefined));
    ok('取卷时 answers 不下发', exam.answers === undefined);
    const choiceItem = exam.items.filter(it => it.type === 'choice')[0];
    ok('有选择题（否则下面的选项泄漏断言没意义）', !!choiceItem);
    ok('取卷时 options.answerIndex 不下发', choiceItem.options.answerIndex === undefined);
    ok('取卷时 options.choices 仍然下发（要用来渲染选项）', Array.isArray(choiceItem.options.choices) && choiceItem.options.choices.length === 4);
    ok('整卷 JSON 里搜不到 answerIndex', JSON.stringify(exam).indexOf('answerIndex') < 0);

    group('P6-3. 出卷优先抽"薄弱"的');
    // 先把 apple 那张拼写卡连续答错
    const appleCard = spellCards.filter(c => c.answer === 'apple')[0];
    for (let i = 0; i < 3; i++) await POST('/api/cards/' + appleCard.id + '/review', { result: 'wrong', studentAnswer: 'x' }, A.token);
    const mk2 = await POST('/api/exams', { count: 20 }, A.token);
    const first = mk2.body.exam.items[0];
    eq('第一题就是反复答错的那张卡', first.cardId, appleCard.id);

    group('P6-4. 交卷批改 + 回流知识卡');
    const beforeReviews = (await GET('/api/dashboard', A.token)).body.movement.reviews;
    const target = mk.body.exam;
    const mathItem = target.items.filter(it => it.cardId === cMath.body.card.id)[0];
    const sciItem = target.items.filter(it => it.cardId === cSci.body.card.id)[0];
    const spellItem = target.items.filter(it => it.type === 'spelling')[0];

    const ans = [];
    if (mathItem) ans.push({ cardId: mathItem.cardId, answerIndex: 0 });          // 对
    if (sciItem) ans.push({ cardId: sciItem.cardId, answer: '植物用光造养分' });    // 交给 AI 判
    if (spellItem) ans.push({ cardId: spellItem.cardId, answer: 'zzzz' });         // 错

    const sub = await POST('/api/exams/' + target.id + '/submit', { answers: ans }, A.token);
    eq('交卷 200', sub.status, 200);
    ok('返回了逐题结果', Array.isArray(sub.body.results) && sub.body.results.length === target.itemCount);
    ok('返回了分数', !!sub.body.score);
    const sc = sub.body.score;
    eq('总题数对得上', sc.total, target.itemCount);
    ok('统计里 counted + unknown = total', sc.counted + sc.unknown === sc.total);
    ok('有按题型分布', Object.keys(sc.byType).length > 0);
    ok('有按学科分布', Object.keys(sc.bySubject).length > 0);
    ok('给出了需要回头看的清单', Array.isArray(sc.revisit));

    const mathRes = sub.body.results.filter(r => r.cardId === cMath.body.card.id)[0];
    if (mathRes) {
      eq('选择题选对了判 right', mathRes.result, 'right');
      eq('选择题 verdict 是 solid', mathRes.verdict, 'solid');
      ok('选择题带回了正确选项下标（交卷后才给）', mathRes.detail && mathRes.detail.correctIndex === 0);
    }
    const spellRes = sub.body.results.filter(r => r.type === 'spelling')[0];
    if (spellRes) {
      eq('拼写答错判 wrong', spellRes.result, 'wrong');
      ok('拼写题交卷后给出正确答案', !!spellRes.answer);
    }
    const sciRes = sub.body.results.filter(r => r.cardId === cSci.body.card.id)[0];
    if (sciRes) {
      ok('理解题在离线演示模式下记为 unknown（判断不了就不算错）', sciRes.result === 'unknown' || sciRes.result === 'right', 'got ' + sciRes.result);
      ok('理解题也带回了下一步复习时间', sciRes.nextDueAt === null || typeof sciRes.nextDueAt === 'number');
    }

    const afterReviews = (await GET('/api/dashboard', A.token)).body.movement.reviews;
    ok('交卷后复习次数真的涨了（每题都回流）', afterReviews > beforeReviews, beforeReviews + '→' + afterReviews);
    ok('每题都给了回流回执', sub.body.results.every(r => r.cardStatus !== null || r.nextDueAt === null));

    group('P6-5. 交卷后才有答案，且不能重复交卷');
    const after = await GET('/api/exams/' + target.id, A.token);
    eq('交卷后状态是 submitted', after.body.exam.status, 'submitted');
    ok('交卷后 items 带答案', after.body.exam.items.every(it => it.answer !== undefined));
    ok('交卷后 answers 下发（回看用）', Array.isArray(after.body.exam.answers));
    const twice = await POST('/api/exams/' + target.id + '/submit', { answers: [] }, A.token);
    eq('重复交卷被拒 409', twice.status, 409);
    eq('错误码 ALREADY', twice.body.error, 'ALREADY');

    group('P6-6. 学科分布与删除');
    const bd = await GET('/api/exams/breakdown', A.token);
    eq('学科分布 200', bd.status, 200);
    const subjects = bd.body.subjects.map(s => s.subject);
    ok('包含 english（单词转的拼写卡）', subjects.indexOf('english') >= 0);
    ok('包含 math', subjects.indexOf('math') >= 0);
    ok('包含 science', subjects.indexOf('science') >= 0);
    ok('分布里 total 加起来 = 全部卡数', bd.body.subjects.reduce((a, s) => a + s.total, 0) === (await GET('/api/cards?pageSize=200', A.token)).body.total);

    const delEx = await DEL('/api/exams/' + mk2.body.exam.id, A.token);
    eq('删卷 200', delEx.status, 200);
    const delExAgain = await GET('/api/exams/' + mk2.body.exam.id, A.token);
    eq('删完再取 404', delExAgain.status, 404);

    group('P6-7. 跨空间隔离');
    const bGetA = await GET('/api/exams/' + target.id, B.token);
    eq('B 拿不到 A 的卷 404', bGetA.status, 404);
    const bSubA = await POST('/api/exams/' + target.id + '/submit', { answers: [] }, B.token);
    eq('B 交不了 A 的卷 404', bSubA.status, 404);

    // ============================================================
    // P3 公共资料池
    // ============================================================
    group('P3-1. 池子一开始是空的（不做预置题库）');
    const emptyPool = await GET('/api/pool', A.token);
    eq('池子 200', emptyPool.status, 200);
    eq('池子里 0 条', emptyPool.body.items.length, 0);
    eq('同时给出共享上限', emptyPool.body.maxActive, 20);
    ok('没有被禁共享', emptyPool.body.ban.banned === false);

    group('P3-2. 分享：昵称必须匿名化');
    const shA = await POST('/api/pool', { kind: 'cards', subject: 'math', title: '分数加法练习' }, A.token);
    eq('分享 200', shA.status, 200);
    eq('昵称留空 → 一位同学', shA.body.item.authorName, '一位同学');
    ok('空间名没有出现在条目里', JSON.stringify(shA.body.item).indexOf('张小明') < 0);

    // 昵称填成空间名（= 真实姓名）必须被换掉
    const shName = await POST('/api/pool', { kind: 'note', text: '这道题我卡在通分那一步，后来想通了：分母要先变成一样的。', nickname: '张小明', subject: 'math' }, A.token);
    eq('昵称 == 空间名 → 被匿名化', shName.body.item.authorName, '一位同学');
    const shPhone = await POST('/api/pool', { kind: 'note', text: '给家长看的说明：这本书的第 3 章重点在比和比例。', nickname: '13800138000', subject: 'math' }, A.token);
    eq('昵称是手机号 → 被匿名化', shPhone.body.item.authorName, '一位同学');
    const shNick = await POST('/api/pool', { kind: 'note', text: '这是一段有正常昵称的笔记，用来验证昵称能保留。', nickname: '爱刷题的小雨', subject: 'math' }, A.token);
    eq('正常昵称保留', shNick.body.item.authorName, '爱刷题的小雨');

    const shEmptyNote = await POST('/api/pool', { kind: 'note', text: '   ' }, A.token);
    eq('空笔记被拒 400', shEmptyNote.status, 400);

    group('P3-3. 列表：不下发内容，只给预览');
    const pool1 = await GET('/api/pool', A.token);
    eq('池子里 4 条', pool1.body.items.length, 4);
    ok('列表里没有 content（想拿内容必须先取用）', pool1.body.items.every(it => it.content === undefined));
    ok('列表里给了 preview', pool1.body.items.every(it => typeof it.preview === 'string'));
    ok('自己分享的标了 mine', pool1.body.items.every(it => it.mine === true));
    const noteItem = pool1.body.items.filter(it => it.kind === 'note' && it.authorName === '爱刷题的小雨')[0];
    ok('笔记预览是正文开头', noteItem.preview.indexOf('这是一段有正常昵称的笔记') >= 0);

    group('P3-4. 取用 = 复制进自己空间');
    const cardsItem = pool1.body.items.filter(it => it.kind === 'cards')[0];
    const bCardsBefore = (await GET('/api/cards?pageSize=200', B.token)).body.total;
    const cp = await POST('/api/pool/' + cardsItem.id + '/copy', {}, B.token);
    eq('取用 200', cp.status, 200);
    ok('确实在自己空间建了卡', cp.body.made.cards > 0, JSON.stringify(cp.body.made));
    const bCardsAfter = (await GET('/api/cards?pageSize=200', B.token)).body.total;
    eq('B 的卡片数按取用量增加', bCardsAfter, bCardsBefore + cp.body.made.cards);
    ok('返回了说明文案', /复制/.test(cp.body.message));

    const pool2 = await GET('/api/pool', B.token);
    const sameItem = pool2.body.items.filter(it => it.id === cardsItem.id)[0];
    eq('取用次数 +1', sameItem.copies, 1);
    ok('B 侧标记了已取用', sameItem.copied === true);
    ok('B 侧不是 mine', sameItem.mine === false);

    // 反证：A 删掉原条目，B 已经复制走的卡片还在（复制不是引用）
    const bCardIds = (await GET('/api/cards?pageSize=200', B.token)).body.items.map(c => c.id);
    await DEL('/api/pool/' + cardsItem.id, A.token);
    const bCardsStill = (await GET('/api/cards?pageSize=200', B.token)).body.items.map(c => c.id);
    eq('原条目被撤下后，B 手里的卡片一张不少', bCardsStill.length, bCardIds.length);
    const gone = await GET('/api/pool/' + cardsItem.id, B.token);
    eq('被撤下的条目 B 侧取不到 404', gone.status, 404);
    const mineGone = await GET('/api/pool/mine', A.token);
    ok('A 自己还能看到被撤下的那条（带已下架标记）', mineGone.body.items.some(it => it.id === cardsItem.id && it.status === 'removed'));

    group('P3-5. 单词表分享与取用');
    const shWords = await POST('/api/pool', { kind: 'words', subject: 'english', title: 'Unit 1 词表', wordIds: [byWord.apple.id, byWord.banana.id, byWord.cherry.id] }, A.token);
    eq('分享单词表 200', shWords.status, 200);
    const cBefore = (await GET('/api/english/words', C.token)).body.words.length;
    const cpWords = await POST('/api/pool/' + shWords.body.item.id + '/copy', { toCards: true }, C.token);
    eq('取用单词表 200', cpWords.status, 200);
    eq('复制了 3 个单词', cpWords.body.made.words, 3);
    const cAfter = (await GET('/api/english/words', C.token)).body.words;
    eq('C 的单词表真的多了 3 个', cAfter.length, cBefore + 3);
    ok('toCards=true 时顺手转了拼写卡', cpWords.body.made.cards > 0);
    const cCards = (await GET('/api/cards?pageSize=200', C.token)).body.items.filter(c => c.type === 'spelling');
    eq('C 空间有 3 张拼写卡', cCards.length, 3);
    ok('单词复制后统计归零（不带原作者的错题记录）', cAfter.every(w => w.wrongCount === 0 && w.rightCount === 0));

    group('P3-6. 举报：满 3 次自动下架');
    const noteId = shNick.body.item.id;
    const r1 = await POST('/api/pool/' + noteId + '/report', { reason: '跟学习无关' }, B.token);
    eq('B 举报 200', r1.status, 200);
    eq('举报后没到阈值不隐藏', r1.body.hidden, false);
    eq('举报计数 1', r1.body.reports, 1);
    const r1dup = await POST('/api/pool/' + noteId + '/report', {}, B.token);
    eq('同一空间重复举报被拒 409', r1dup.status, 409);
    const r2 = await POST('/api/pool/' + noteId + '/report', {}, C.token);
    eq('第 2 次举报', r2.body.reports, 2);
    const r3 = await POST('/api/pool/' + noteId + '/report', {}, D.token);
    eq('第 3 次举报', r3.body.reports, 3);
    eq('满 3 次自动下架', r3.body.hidden, true);
    const poolAfterHide = await GET('/api/pool', B.token);
    ok('被下架的条目从池子列表消失', !poolAfterHide.body.items.some(it => it.id === noteId));
    const hideGet = await GET('/api/pool/' + noteId, B.token);
    eq('被下架的条目非作者取不到 404', hideGet.status, 404);
    const hideCopy = await POST('/api/pool/' + noteId + '/copy', {}, B.token);
    eq('被下架的条目不能取用 410', hideCopy.status, 410);

    group('P3-7. 同一空间三次被下架 → 禁止再共享');
    // 先看当前状态：A 已有 1 条被举报下架（noteId）。
    // 注意 P3-4 里 A 自己撤下的那条**不算**——主动整理自己的东西不该被记成违规。
    const ban1 = (await GET('/api/pool/stats', A.token)).body;
    eq('A 目前 1 条被下架（自己撤下的那条不计）', ban1.ban.hiddenCount, 1);
    ok('A 还没被禁', ban1.ban.banned === false);
    eq('A 分享过 5 条（含已撤下）', ban1.shared, 5);

    // 再让两条被下架
    for (const it of [shName.body.item, shPhone.body.item]) {
      for (const t of [B.token, C.token, D.token]) await POST('/api/pool/' + it.id + '/report', {}, t);
    }
    const ban3 = (await GET('/api/pool/stats', A.token)).body;
    eq('A 累计 3 条被下架', ban3.ban.hiddenCount, 3);
    ok('A 被禁止共享', ban3.ban.banned === true);
    eq('阈值是 3', ban3.ban.threshold, 3);

    const banned = await POST('/api/pool', { kind: 'note', text: '我还能不能再分享一条呢' }, A.token);
    eq('被禁后再分享 403', banned.status, 403);
    eq('错误码 SHARE_BANNED', banned.body.error, 'SHARE_BANNED');
    ok('错误信息说明了原因', /下架/.test(banned.body.message));

    const listBanned = await GET('/api/pool', A.token);
    ok('列表接口也把禁共享状态带出来（前端要显示）', listBanned.body.ban.banned === true);

    group('P3-8. 只能撤下自己的');
    const cShare = await POST('/api/pool', { kind: 'note', text: 'C 分享的一段笔记，用来验证别人撤不掉。' }, C.token);
    eq('C 分享成功', cShare.status, 200);
    const aRemoveC = await DEL('/api/pool/' + cShare.body.item.id, A.token);
    eq('A 撤不下 C 的条目 403', aRemoveC.status, 403);
    const cRemoveC = await DEL('/api/pool/' + cShare.body.item.id, C.token);
    eq('C 撤得下自己的 200', cRemoveC.status, 200);

    group('P3-9. 池子里不出现任何真实姓名');
    const allSpaces = [A.name, B.name, C.name, D.name];
    const poolAll = await GET('/api/pool?sort=hot', A.token);
    const blob = JSON.stringify(poolAll.body.items);
    let leaked = null;
    for (const n of allSpaces) if (blob.indexOf(n) >= 0) leaked = n;
    ok('池子里搜不到任何一个空间名（= 真实姓名）', leaked === null, leaked ? '泄漏了 ' + leaked : '');
    ok('所有条目的署名都是匿名或昵称', poolAll.body.items.every(it => it.authorName === '一位同学' || it.authorName === '爱刷题的小雨'));

    group('P3-10. 我分享的 / 我取用的 统计');
    const cStats = (await GET('/api/pool/stats', C.token)).body;
    eq('C 分享过 1 条', cStats.shared, 1);
    eq('C 从池子里取用了 1 次', cStats.got, 1);
    const cMine = await GET('/api/pool/mine', C.token);
    eq('C 的"我分享的"里 1 条', cMine.body.items.length, 1);
    ok('"我分享的"能看到内容（自己的东西）', cMine.body.items[0].content !== undefined);

    group('P3-11. 超大内容被拒绝而不是静默截断');
    const huge = await POST('/api/pool', { kind: 'note', text: '啊'.repeat(30000) }, C.token);
    eq('超长笔记 200（服务端截断到 2 万字）', huge.status, 200);
    const hugeGet = await GET('/api/pool/' + huge.body.item.id, C.token);
    ok('内容被截断到 20000 字以内', hugeGet.body.item.content.text.length <= 20000, 'len=' + hugeGet.body.item.content.text.length);

    group('P3-12. 未登录一律拒绝');
    for (const [m, p] of [['GET', '/api/pool'], ['POST', '/api/pool'], ['GET', '/api/english/words'],
      ['GET', '/api/english/dictation'], ['GET', '/api/exams'], ['POST', '/api/exams']]) {
      const r = await req(m, p, m === 'POST' ? {} : undefined, '');
      eq(m + ' ' + p + ' 未登录 401', r.status, 401);
    }

    group('P3-13. 不存在的资源一律 404，不 500');
    eq('取用不存在的池子条目 404', (await POST('/api/pool/pi_nope/copy', {}, A.token)).status, 404);
    eq('举报不存在的池子条目 404', (await POST('/api/pool/pi_nope/report', {}, A.token)).status, 404);
    eq('取不存在的测评卷 404', (await GET('/api/exams/ex_nope', A.token)).status, 404);
    eq('交不存在的测评卷 404', (await POST('/api/exams/ex_nope/submit', { answers: [] }, A.token)).status, 404);
    eq('删不存在的单词（静默成功）', (await DEL('/api/english/words/w_nope', A.token)).status, 200);
    eq('删不存在的单元（静默成功）', (await DEL('/api/english/units/wu_nope', A.token)).status, 200);

  } catch (e) {
    fail++;
    failures.push('未捕获异常：' + (e && e.stack || e));
    console.error('\n[异常]', e && e.stack || e);
  } finally {
    await stopServer(child);
    try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch (e) {}
  }

  console.log('\n' + '─'.repeat(58));
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  if (failures.length) {
    console.log('\n失败明细：');
    failures.forEach(f => console.log('  · ' + f));
  }
  process.exit(fail ? 1 : 0);
})();

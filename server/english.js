'use strict';
/**
 * 英语模块（P10）
 *
 * 设计取舍：对标站的英语靠"阿里云语音评测"打分。这里不接外部服务，改用**浏览器自带的
 * 语音合成与识别**（SpeechSynthesis / SpeechRecognition），代价是评分粒度粗
 * ——只能判"听出来的词对不对"，给不出音准分。
 * 与其编一个假的音准分骗孩子，不如老实说"这句话我听成了什么，你自己对一下"。
 *
 * 单词表不预置：课程版本太多，预置任何一种都是错的。改为支持把自己的词表批量粘贴导入。
 * （IP 红线：不预置、不标注任何教材版本；界面文案一律叫「你的资料」。）
 */
const D = require('./db');
const cards = require('./cards');

// ---------- 单元 ----------
function listUnits(spaceId) {
  return D.all('SELECT * FROM word_units WHERE space_id = ? ORDER BY created_at ASC', spaceId)
    .map(u => ({
      id: u.id, name: u.name, grade: u.grade, createdAt: u.created_at,
      count: (D.get('SELECT COUNT(*) c FROM words WHERE space_id = ? AND unit_id = ?', spaceId, u.id) || {}).c || 0,
      mastered: (D.get('SELECT COUNT(*) c FROM words WHERE space_id = ? AND unit_id = ? AND wrong_count = 0 AND right_count >= 2', spaceId, u.id) || {}).c || 0,
    }));
}
function createUnit(spaceId, { name, grade }) {
  const nm = String(name || '').trim().slice(0, 40);
  if (!nm) { const e = new Error('单元名称不能为空'); e.code = 'BAD_INPUT'; throw e; }
  const id = D.uid('wu_');
  D.run('INSERT INTO word_units(id,space_id,name,grade,created_at) VALUES(?,?,?,?,?)',
    id, spaceId, nm, String(grade || '').slice(0, 20), D.now());
  return listUnits(spaceId).filter(u => u.id === id)[0];
}
function deleteUnit(spaceId, id) {
  D.run('UPDATE words SET unit_id = NULL WHERE space_id = ? AND unit_id = ?', spaceId, id);
  D.run('DELETE FROM word_units WHERE id = ? AND space_id = ?', id, spaceId);
  return true;
}

// ---------- 单词 ----------
function shapeWord(w) {
  return {
    id: w.id, unitId: w.unit_id, word: w.word, phonetic: w.phonetic,
    meaning: w.meaning, example: w.example,
    wrongCount: w.wrong_count, rightCount: w.right_count, createdAt: w.created_at,
  };
}
function listWords(spaceId, opts) {
  const o = opts || {};
  let sql = 'SELECT * FROM words WHERE space_id = ?';
  const p = [spaceId];
  if (o.unitId) { sql += ' AND unit_id = ?'; p.push(o.unitId); }
  if (o.q) { sql += ' AND (word LIKE ? OR meaning LIKE ?)'; p.push('%' + o.q + '%', '%' + o.q + '%'); }
  sql += o.sort === 'wrong' ? ' ORDER BY wrong_count DESC, created_at DESC' : ' ORDER BY created_at ASC';
  return D.all(sql, ...p).map(shapeWord);
}
function addWord(spaceId, data) {
  const word = String(data.word || '').trim().slice(0, 60);
  if (!word) { const e = new Error('单词不能为空'); e.code = 'BAD_INPUT'; throw e; }
  const dup = D.get('SELECT id FROM words WHERE space_id = ? AND word = ?', spaceId, word);
  if (dup) return shapeWord(D.get('SELECT * FROM words WHERE id = ?', dup.id));
  const id = D.uid('w_');
  D.run('INSERT INTO words(id,space_id,unit_id,word,phonetic,meaning,example,created_at) VALUES(?,?,?,?,?,?,?,?)',
    id, spaceId, data.unitId || null, word,
    String(data.phonetic || '').slice(0, 60), String(data.meaning || '').slice(0, 120),
    String(data.example || '').slice(0, 200), D.now());
  return shapeWord(D.get('SELECT * FROM words WHERE id = ?', id));
}
function updateWord(spaceId, id, patch) {
  const w = D.get('SELECT * FROM words WHERE id = ? AND space_id = ?', id, spaceId);
  if (!w) { const e = new Error('单词不存在'); e.code = 'NOT_FOUND'; throw e; }
  const map = { word: 'word', phonetic: 'phonetic', meaning: 'meaning', example: 'example', unitId: 'unit_id' };
  Object.keys(map).forEach(k => {
    if (patch[k] !== undefined) D.run('UPDATE words SET ' + map[k] + ' = ? WHERE id = ?', patch[k], id);
  });
  return shapeWord(D.get('SELECT * FROM words WHERE id = ?', id));
}
function deleteWord(spaceId, id) {
  D.run('DELETE FROM words WHERE id = ? AND space_id = ?', id, spaceId);
  return true;
}

/**
 * 批量导入。支持从任何词表里直接粘贴（笔记、自己整理的、老师发的都行），常见几种写法都认：
 *   apple /ˈæpl/ 苹果
 *   apple 苹果
 *   apple,苹果
 *   apple	苹果  （制表符）
 *   apple - 苹果
 *   apple [ˈæpl] 苹果
 * 一行一个词。识别不出中文的行会被跳过并报回来，不静默丢弃。
 */
function parseWordLines(text) {
  const out = [], skipped = [];
  String(text || '').replace(/\r\n?/g, '\n').split('\n').forEach(raw => {
    const line = raw.trim();
    if (!line || /^#/.test(line)) return;

    // 1) 先把音标摘出来（/.../ 或 [...]）。
    //    注意是"摘出来"而不是"丢掉"——单词表里音标是有用的信息，丢掉等于白解析。
    let phonetic = '';
    let rest = line;
    const pm = rest.match(/[/\[]([^/\]]+)[/\]]/);
    if (pm) {
      phonetic = pm[1].trim().slice(0, 60);
      rest = rest.replace(pm[0], ' ').replace(/\s+/g, ' ').trim();
    }

    // 2) 取开头**最长**的一段英文（最多 3 个词）。
    //    这里必须是"最长"而不是"最短"：用最短匹配时，"a b c d e f 这行是噪音"
    //    会被切成 word="a"、meaning="b c d e f 这行是噪音"，一行噪音就变成了
    //    一个看起来合法的单词。取最长段，6 个词超限，才会被正确跳过。
    const wm = rest.match(/^([A-Za-z][A-Za-z'’\-]*(?:\s+[A-Za-z][A-Za-z'’\-]*)*)/);
    if (!wm) { skipped.push(line); return; }
    const word = wm[1].trim();
    const meaning = rest.slice(wm[1].length).replace(/^[\s\-—–,，:：;；|]+/, '').trim();

    if (!word) { skipped.push(line); return; }
    if (word.split(/\s+/).length > 3) { skipped.push(line); return; }
    out.push({ word: word, meaning: meaning, phonetic: phonetic });
  });
  return { words: out, skipped: skipped };
}
function importWords(spaceId, { unitId, text, words }) {
  let list = Array.isArray(words) ? words : [];
  let skipped = [];
  if (!list.length && text) {
    const r = parseWordLines(text);
    list = r.words; skipped = r.skipped;
  }
  const made = [], dupes = [];
  list.forEach(w => {
    const raw = String(w.word || '').trim();
    if (!raw) { skipped.push(String(w.word || '')); return; }
    // addWord 对重复词是"返回已有的那条"，不报错。所以这里必须自己先查一次，
    // 否则重复导入会显示"新增了 6 个"，而实际上一个都没新增 —— 数字对不上就是骗人。
    const exist = D.get('SELECT id FROM words WHERE space_id = ? AND word = ?', spaceId, raw);
    if (exist) { dupes.push(raw); return; }
    try { made.push(addWord(spaceId, { word: w.word, meaning: w.meaning, phonetic: w.phonetic, unitId: unitId })); }
    catch (e) { skipped.push(raw); }
  });
  return { added: made.length, duplicates: dupes.length, duplicateWords: dupes, words: made, skipped: skipped };
}

/** 单词 → 拼写知识卡（走同一套间隔复习，不另起一套机制） */
function toCards(spaceId, userId, wordIds) {
  const ids = Array.isArray(wordIds) && wordIds.length ? wordIds : null;
  const list = ids
    ? ids.map(id => D.get('SELECT * FROM words WHERE id = ? AND space_id = ?', id, spaceId)).filter(Boolean)
    : D.all('SELECT * FROM words WHERE space_id = ?', spaceId);
  const made = [];
  list.forEach(w => {
    const exist = D.get('SELECT id FROM cards WHERE space_id = ? AND type = ? AND answer = ?', spaceId, 'spelling', w.word);
    if (exist) return;
    made.push(cards.create(spaceId, userId, {
      knowledge: w.meaning ? (w.meaning + '（' + w.word + '）') : w.word,
      type: 'spelling',
      subject: 'english',
      question: w.meaning ? ('写出「' + w.meaning + '」对应的英文单词') : ('拼写这个单词：' + w.word),
      answer: w.word,
    }));
  });
  return made;
}

// ---------- 单元四关（批次24）----------
/**
 * ★ 四关的排列不是"把功能拆成四块"，而是**四个不同的动作**，按"输入→输出"递进：
 *
 *   1. 认（recognize）—— 看英文词，选出/说出中文意思。**只要求认得出**，最容易。
 *   2. 读（read）     —— 点词听音、跟读比对。练的是"耳朵和嘴"，不判分只回显。
 *   3. 背（recall）   —— 看中文写英文。这就是原来的 meaning 听写，难度上来了。
 *   4. 用（use）      —— 看中文/英文，**自己造一句**。没有标准答案，只做"单词用上了吗"的检查。
 *
 * ★ 为什么"用"这一关不给对错：造句的正确答案有无穷多个。给它打对错，等于用一把尺子量
 *   所有形状。所以这一关只回显"你这句里有没有用上这个词""句子长度够不够"，剩下的交给
 *   学生自己判断。这不是偷懒，是不肯编一个假的对错。
 *
 * ★ 每一关的"过关"判据都落在**已有的 right_count / wrong_count 上**，不新开一套记账 ——
 *   同一件事记两个数，迟早会对不上。
 */
const GATES = [
  {
    key: 'recognize', name: '认', short: '认得出',
    what: '看英文，说出中文意思。只要求认得出，认错了不要紧。',
    needRight: 1, size: 12,
    // 认这一关按"最少碰过"优先：新词先混个脸熟
    order: 'freshest',
  },
  {
    key: 'read', name: '读', short: '读得准',
    what: '点词听标准读音，跟着读。这一关不打分，只告诉你识别成了什么。',
    needRight: 1, size: 12,
    order: 'freshest',
  },
  {
    key: 'recall', name: '背', short: '写得出',
    what: '看中文，写出英文单词。这一关开始算对错。',
    needRight: 2, size: 10,
    order: 'wrong',
  },
  {
    key: 'use', name: '用', short: '用得上',
    what: '拿这个词造一句自己的话。没有标准答案，只看你有没有把它用进去。',
    needRight: 1, size: 8,
    order: 'wrong',
  },
];

function gateByKey(k) { return GATES.filter(g => g.key === k)[0] || null; }

/** 单元 × 四关的进度矩阵。数字全部现算，不落库。 */
function unitProgress(spaceId, unitId) {
  const u = D.get('SELECT * FROM word_units WHERE id = ? AND space_id = ?', unitId, spaceId);
  if (!u) return null;
  const ws = D.all('SELECT * FROM words WHERE space_id = ? AND unit_id = ?', spaceId, unitId);
  const total = ws.length;

  const gates = GATES.map(g => {
    // "这一关过了的词"：碰过且错 0（认/读只要求碰过，背要求对 2 次）
    const passed = ws.filter(w => w.wrong_count === 0 && w.right_count >= g.needRight).length;
    // 分母是"这一关能算的词"—— 没有词就是 null，不是 0%（0 会读成"一个都没过"）
    const pct = total ? Math.round(passed / total * 100) : null;
    return { key: g.key, name: g.name, short: g.short, what: g.what, size: g.size, needRight: g.needRight, passed, total, pct };
  });

  const allPassed = total > 0 && gates.every(g => g.passed === total);

  return {
    unitId: u.id, name: u.name, grade: u.grade, createdAt: u.created_at,
    total, gates, allPassed,
    // 第一关没过完的，指向它；全过了就是 null
    nextGate: (gates.filter(g => g.passed < total)[0] || {}).key || null,
  };
}

/** 所有单元的四关进度。没归入任何单元的词也单独报一条 —— 否则那批词等于消失。 */
function unitBoard(spaceId) {
  const units = listUnits(spaceId);
  const rows = units.map(u => unitProgress(spaceId, u.id)).filter(Boolean);
  const loose = D.get('SELECT COUNT(*) c FROM words WHERE space_id = ? AND (unit_id IS NULL OR unit_id = ?)', spaceId, '') || { c: 0 };
  const looseTotal = loose.c || 0;
  return {
    units: rows,
    // 「未归入单元」不假装成一个单元，但也不能不告诉你有多少词 —— 否则学生以为词丢了
    looseCount: looseTotal,
    totalWords: (D.get('SELECT COUNT(*) c FROM words WHERE space_id = ?', spaceId) || {}).c || 0,
  };
}

/**
 * 出某一关的题。★ 只有「背」这一关带答案校验；「认」把正确项和干扰项给前端自己判（不出答案）；
 * 「读」不需要题（就是词表本身）；「用」给提示不给答案。
 */
function gateTasks(spaceId, unitId, gateKey, opts) {
  const g = gateByKey(gateKey);
  if (!g) { const e = new Error('没有这一关'); e.code = 'BAD_INPUT'; throw e; }
  const o = opts || {};
  const n = Math.max(1, Math.min(50, Number(o.count) || g.size));
  let pool = listWords(spaceId, unitId ? { unitId: unitId } : {});
  if (!pool.length) return { gate: g.key, name: g.name, items: [], total: 0, mode: g.key };

  const shuffled = (arr) => {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); const t = a[i]; a[i] = a[j]; a[j] = t; }
    return a;
  };

  if (g.order === 'wrong') pool.sort((a, b) => (b.wrongCount - a.wrongCount) || (a.rightCount - b.rightCount));
  else pool.sort((a, b) => (a.rightCount - b.rightCount) || (b.wrongCount - a.wrongCount));

  const picked = pool.slice(0, n);
  const items = picked.map(w => {
    if (g.key === 'recognize') {
      // 干扰项从**同空间其他词**里抽，抽不到就少给几个选项（不编假词）
      const others = shuffled(pool.filter(x => x.id !== w.id)).slice(0, 3);
      const choices = shuffled([{ t: w.meaning || w.word, ok: true }].concat(
        others.map(x => ({ t: x.meaning || x.word, ok: false }))
      )).map(c => c.t);
      return {
        id: w.id, prompt: w.word, phonetic: w.phonetic,
        // 故意不带 ok 标记：答案在前端比对时不比对"哪个选项对"，而是交卷时送回服务端判
        choices: choices, wrongCount: w.wrongCount,
      };
    }
    if (g.key === 'read') {
      return { id: w.id, prompt: w.word, phonetic: w.phonetic, meaning: w.meaning, wrongCount: w.wrongCount };
    }
    if (g.key === 'use') {
      return {
        id: w.id, prompt: w.word, meaning: w.meaning,
        // 给的脚手架：词性看不出来就不说，不猜
        starters: ['I can ...', 'This is a ...', 'Do you ...', '... is ...'],
        minWords: 4, wrongCount: w.wrongCount,
      };
    }
    // recall：和原 listen/meaning 对齐，看中文写英文
    return {
      id: w.id, prompt: w.meaning || w.word, phonetic: w.phonetic,
      letters: w.word.length, wrongCount: w.wrongCount,
    };
  });

  return { gate: g.key, name: g.name, what: g.what, mode: g.key, total: pool.length, items: items };
}

/**
 * 批改「认」这一关。answer 传选中的**中文文本**（不是选项下标）——
 * 传下标的话，前端只要错一位就整卷错位，而且服务端还得把选项拼回来才判得了。
 */
function gradeGate(spaceId, userId, { gate, items, createCards: mkCards }) {
  const g = gateByKey(gate);
  if (!g) { const e = new Error('没有这一关'); e.code = 'BAD_INPUT'; throw e; }
  const arr = Array.isArray(items) ? items : [];
  const results = [];

  // 「用」这一关：不判对错，只检查"用没用上"+"够不够长"
  if (g.key === 'use') {
    arr.forEach(it => {
      const w = D.get('SELECT * FROM words WHERE id = ? AND space_id = ?', it.id, spaceId);
      // ★ 字段必须补齐：缺 word/meaning 时前端 res.word 读到 undefined，
      //   而 JSON.stringify 会把 undefined 整个键丢掉 ⇒ 界面显示空白且零报错。
      if (!w) {
        results.push({
          id: it.id, ok: null, missing: true, word: '', meaning: '', answer: String(it.answer || ''),
          used: false, wordCount: 0, longEnough: false,
          note: '这个词在单词本里找不到了，可能已经被删掉。',
        });
        return;
      }
      const sent = String(it.answer || '').trim();
      const words = sent.split(/\s+/).filter(Boolean);
      const used = norm(sent).indexOf(norm(w.word)) >= 0;
      const longEnough = words.length >= 4;
      // ★ ok 恒为 null：造句没有唯一正确答案。这里只给"做到了什么"。
      results.push({
        id: w.id, ok: null, missing: false,
        word: w.word, meaning: w.meaning, answer: sent,
        used: used, wordCount: words.length, longEnough: longEnough,
        note: !sent ? '还没写。写一句自己的话就行，用不用得上都不扣分。'
          : !used ? '这一句里没找到「' + w.word + '」，再试一次？'
            : !longEnough ? '用上了，但句子短了点 —— 多写几个词更像话。'
              : '用上了。这一句是你自己的，对错自己判断。',
      });
    });
    return {
      gate: g.key, name: g.name, results: results,
      // ★ 永远不报 accuracy：这一关没有"答对率"这回事
      right: null, wrong: null, total: results.length, accuracy: null,
      scored: false,
      note: '造句没有标准答案，所以这一关不判对错。上面写的是"用到了没有"，不是分数。',
    };
  }

  D.tx(() => {
    arr.forEach(it => {
      const w = D.get('SELECT * FROM words WHERE id = ? AND space_id = ?', it.id, spaceId);
      if (!w) { results.push({ id: it.id, ok: false, missing: true, word: '', meaning: '', phonetic: '', answer: String(it.answer || '') }); return; }
      const ans = String(it.answer || '').trim();
      let right;
      let extra = {};
      if (g.key === 'recognize') {
        // 中文比对走 norm：全角半角、标点、空格差异不该算错
        right = norm(ans) === norm(w.meaning) || norm(ans) === norm(w.word);
      } else if (g.key === 'read') {
        // 这一关前端不交卷（只跟读回显），真交了只认"词打对了"
        right = norm(ans) === norm(w.word);
      } else {
        right = norm(ans) === norm(w.word);
        if (!right) extra = { diff: diffHint(ans, w.word) };
      }
      D.run('UPDATE words SET right_count = right_count + ?, wrong_count = wrong_count + ? WHERE id = ?',
        right ? 1 : 0, right ? 0 : 1, w.id);
      results.push(Object.assign({
        id: w.id, ok: right, missing: false,
        word: w.word, answer: ans, meaning: w.meaning, phonetic: w.phonetic,
      }, extra));
    });
  });

  const wrongIds = results.filter(r => !r.ok && !r.missing).map(r => r.id);
  let madeCards = [];
  // 只有「背」这一关的错词才转拼写卡：认错了说明这个词还没认脸熟，转拼写卡是跳级
  if (mkCards && g.key === 'recall' && wrongIds.length) madeCards = toCards(spaceId, userId, wrongIds);
  const right = results.filter(r => r.ok).length;
  return {
    gate: g.key, name: g.name, results: results,
    right: right, wrong: results.length - right, total: results.length,
    accuracy: results.length ? Math.round(right / results.length * 100) : null,
    scored: true,
    wrongWords: results.filter(r => !r.ok).map(r => ({ id: r.id, word: r.word, meaning: r.meaning })),
    cardsCreated: madeCards.length,
  };
}

// ---------- 艾宾浩斯（批次24）----------
/**
 * ★ 这里用的是**跟知识卡同一张间隔表**（1 / 3 / 5 / 7 天，连对 5 次后 14 → 60 天）。
 *   同一份记忆规律，不因为"这是英语"就换一套数字。换一套的唯一后果是学生发现
 *   "单词今天到期、卡片明天到期"，然后不再相信任何一边。
 *
 * ★ 每次复习落一条 english_reviews（谁、哪个词、哪一关、对错、当时定的下次间隔）。
 *   为什么落库而不是现算：间隔推进是**有状态的**（连对次数只在前一条上），
 *   现算需要重放全部历史。这与日报"系统侧事实现算"不冲突 ——
 *   日报不落库是因为它**能**现算；这里落库是因为它**是**一条学习痕迹（和 card_reviews 同理）。
 */
const EN_LADDER = [1, 3, 5, 7];        // 连对 1..4 次后的间隔（天），与 cards.PRE_MASTER_LADDER 同值
const EN_MASTER_DAYS = 14;             // 连对 5 次 = 记住，14 天后再看看
const EN_MASTER_LATER = 60;            // 之后每 60 天
const EN_MASTER_STREAK = 5;
const DAY = 24 * 60 * 60 * 1000;

/** 由「当前连对次数 + 这次结果」推下一次。纯函数，方便测。 */
function nextEnSchedule(consecutive, result) {
  const c = Number(consecutive) || 0;
  if (result === 'unknown') return { consecutive: c, intervalDays: null, dueInDays: null, unchanged: true };
  if (result === 'wrong') return { consecutive: 0, intervalDays: EN_LADDER[0], dueInDays: EN_LADDER[0], status: 'learning' };
  const n = c + 1;
  if (n >= EN_MASTER_STREAK) return { consecutive: n, intervalDays: EN_MASTER_LATER, dueInDays: EN_MASTER_DAYS, status: 'mastered' };
  return { consecutive: n, intervalDays: EN_LADDER[n - 1] || 1, dueInDays: EN_LADDER[n - 1] || 1, status: n >= 3 ? 'almost' : 'learning' };
}

/** 这个词现在该不该复习。返回 null 表示"还没开始记，谈不上到期"。 */
function wordDue(w, lastReview, now) {
  if (!lastReview) return null;
  return {
    dueAt: lastReview.next_due_at,
    overdue: lastReview.next_due_at <= now,
    inDays: Math.round((lastReview.next_due_at - now) / DAY),
  };
}

/**
 * 今天该复习哪些词。★ 没碰过的词**不算"到期"**，单独归到 newWords ——
 * 把新词塞进"复习队列"会让"今天该复习 20 个"这个数字骗人。
 */
function reviewQueue(spaceId, opts) {
  const o = opts || {};
  const now = D.now();
  const unitId = o.unitId || null;
  const ws = listWords(spaceId, unitId ? { unitId: unitId } : {});
  const lastOf = (wid) => D.get(
    'SELECT * FROM english_reviews WHERE word_id = ? ORDER BY reviewed_at DESC, rowid DESC LIMIT 1', wid);

  const due = [], fresh = [], later = [];
  ws.forEach(w => {
    const last = lastOf(w.id);
    const d = wordDue(w, last, now);
    if (!d) { fresh.push(w); return; }
    if (d.overdue) due.push(Object.assign({}, w, {
      dueAt: d.dueAt, overdueDays: Math.floor((now - d.dueAt) / DAY),
      consecutive: last ? last.consecutive : 0,
    }));
    else later.push(Object.assign({}, w, { dueAt: d.dueAt, inDays: d.inDays, consecutive: last ? last.consecutive : 0 }));
  });
  due.sort((a, b) => a.dueAt - b.dueAt);

  const limit = Math.max(1, Math.min(100, Number(o.count) || 20));
  return {
    now: now,
    dueCount: due.length,
    freshCount: fresh.length,
    laterCount: later.length,
    // ★ 只有 due 进复习队列；新词要单独给学生看，不能混进来
    items: due.slice(0, limit),
    fresh: fresh.slice(0, limit),
    later: later.slice(0, limit),
    note: fresh.length
      ? '还有 ' + fresh.length + ' 个词从来没碰过，它们不在"该复习"里 —— 新词和到期复习是两件事。'
      : '',
  };
}

/** 记一次复习并推进间隔。返回这一次的间隔与下次到期 */
function recordReview(spaceId, userId, { wordId, gate, result }) {
  const w = D.get('SELECT * FROM words WHERE id = ? AND space_id = ?', wordId, spaceId);
  if (!w) { const e = new Error('单词不存在'); e.code = 'NOT_FOUND'; throw e; }
  const r = ['right', 'wrong', 'unknown'].indexOf(result) >= 0 ? result : 'unknown';
  const last = D.get('SELECT * FROM english_reviews WHERE word_id = ? ORDER BY reviewed_at DESC, rowid DESC LIMIT 1', wordId);
  const sched = nextEnSchedule(last ? last.consecutive : 0, r);
  const now = D.now();
  // unknown 不改任何状态：既不等同答对（虚报进步），也不等同答错（凭空退步）
  const nextDue = sched.unchanged ? (last ? last.next_due_at : now + DAY) : now + (sched.dueInDays || 1) * DAY;
  const consecutive = sched.unchanged ? (last ? last.consecutive : 0) : sched.consecutive;

  D.tx(() => {
    D.run(`INSERT INTO english_reviews(id,space_id,user_id,word_id,gate,result,consecutive,interval_days,next_due_at,reviewed_at)
           VALUES(?,?,?,?,?,?,?,?,?,?)`,
      D.uid('er_'), spaceId, userId || null, wordId, gate || '', r,
      consecutive, sched.intervalDays, nextDue, now);
    if (!sched.unchanged) {
      D.run('UPDATE words SET right_count = right_count + ?, wrong_count = wrong_count + ? WHERE id = ?',
        r === 'right' ? 1 : 0, r === 'wrong' ? 1 : 0, wordId);
    }
  });
  return {
    wordId: wordId, word: w.word, result: r, consecutive: consecutive,
    intervalDays: sched.intervalDays, dueAt: nextDue,
    dueInDays: Math.round((nextDue - now) / DAY),
    note: sched.unchanged ? '这次没判出对错，进度不动 —— 不清零也不推进。' : '',
  };
}

/** 一个空间/单元的复习统计。★ 没复习过的词不计入准确率分母。 */
function reviewStats(spaceId, unitId) {
  const ws = listWords(spaceId, unitId ? { unitId: unitId } : {});
  const ids = ws.map(w => w.id);
  if (!ids.length) return { total: 0, reviewed: 0, dueCount: 0, accuracy: null, neverReviewed: 0, avgIntervalDays: null };
  const ph = ids.map(() => '?').join(',');
  const g = (sql, ...p) => (D.get(sql, ...p) || {}).c || 0;
  // ★ 只数 judged 的（排掉 unknown）—— 与项目里其余地方口径一致
  const judged = g('SELECT COUNT(*) c FROM english_reviews WHERE space_id = ? AND word_id IN (' + ph + ") AND result IN ('right','wrong')", spaceId, ...ids);
  const right = g('SELECT COUNT(*) c FROM english_reviews WHERE space_id = ? AND word_id IN (' + ph + ") AND result = 'right'", spaceId, ...ids);
  const reviewedWords = g('SELECT COUNT(DISTINCT word_id) c FROM english_reviews WHERE space_id = ? AND word_id IN (' + ph + ')', spaceId, ...ids);
  const q = reviewQueue(spaceId, { unitId: unitId });
  const avg = D.get('SELECT AVG(interval_days) a FROM english_reviews WHERE space_id = ? AND word_id IN (' + ph + ') AND interval_days IS NOT NULL', spaceId, ...ids);
  return {
    total: ids.length,
    reviewed: reviewedWords,
    neverReviewed: ids.length - reviewedWords,
    dueCount: q.dueCount,
    // 一次都没判过 ⇒ null（"没练过"和"全错"是两件事）
    accuracy: judged ? Math.round(right / judged * 100) : null,
    avgIntervalDays: avg && avg.a != null ? Math.round(avg.a * 10) / 10 : null,
  };
}

// ---------- 听写 ----------
/**
 * 出题。三种模式：
 *   meaning（看中文写英文）/ listen（听音写词，前端用 TTS 读）/ spell（看英文写英文，练拼写）
 * 默认优先挑"错得多"的词 —— 听写要练的就是没记住的那些。
 */
function dictation(spaceId, { unitId, count, mode, order }) {
  const n = Math.max(1, Math.min(50, Number(count) || 10));
  let pool = listWords(spaceId, { unitId: unitId });
  if (!pool.length) return { items: [], total: 0 };
  if (order === 'random') {
    pool = pool.slice();
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const t = pool[i]; pool[i] = pool[j]; pool[j] = t;
    }
  } else {
    pool.sort((a, b) => (b.wrongCount - a.wrongCount) || (a.rightCount - b.rightCount));
  }
  const m = ['meaning', 'listen', 'spell'].indexOf(mode) >= 0 ? mode : 'meaning';
  return {
    total: pool.length,
    mode: m,
    // 注意：这里**不带答案**，答案只在批改时用
    items: pool.slice(0, n).map(w => ({
      id: w.id,
      prompt: m === 'meaning' ? (w.meaning || w.word) : w.word,
      phonetic: w.phonetic,
      hint: m === 'spell' ? (w.meaning ? w.meaning.slice(0, 1) + '…' : '') : '',
      letters: m === 'spell' ? w.word.length : 0,
      wrongCount: w.wrongCount,
    })),
  };
}

function norm(s) {
  return String(s == null ? '' : s).toLowerCase().trim()
    .replace(/[’']/g, "'").replace(/\s+/g, ' ');
}

/**
 * 批改。返回逐题结果 + 错词表。
 * 不写回 words 的统计是"不记账"——错得多的词必须能排到前面去。
 */
function grade(spaceId, userId, { items, createCards: mkCards }) {
  const arr = Array.isArray(items) ? items : [];
  const results = [];
  D.tx(() => {
    arr.forEach(it => {
      const w = D.get('SELECT * FROM words WHERE id = ? AND space_id = ?', it.id, spaceId);
      if (!w) { results.push({ id: it.id, ok: false, missing: true, word: '', meaning: '', phonetic: '', answer: String(it.answer || '') }); return; }
      const right = norm(it.answer) === norm(w.word);
      D.run('UPDATE words SET right_count = right_count + ?, wrong_count = wrong_count + ? WHERE id = ?',
        right ? 1 : 0, right ? 0 : 1, w.id);
      results.push({
        id: w.id, ok: right, missing: false,
        word: w.word, answer: String(it.answer || ''),
        meaning: w.meaning, phonetic: w.phonetic,
        // 差在哪：给出"你写的"和"正确的"对比，让学生自己看出漏了哪个字母
        diff: right ? null : diffHint(String(it.answer || ''), w.word),
      });
    });
  });
  const wrongIds = results.filter(r => !r.ok && !r.missing).map(r => r.id);
  let madeCards = [];
  if (mkCards && wrongIds.length) madeCards = toCards(spaceId, userId, wrongIds);
  const right = results.filter(r => r.ok).length;
  return {
    results: results,
    right: right, wrong: results.length - right, total: results.length,
    accuracy: results.length ? Math.round(right / results.length * 100) : 0,
    wrongWords: results.filter(r => !r.ok).map(r => ({ id: r.id, word: r.word, meaning: r.meaning })),
    cardsCreated: madeCards.length,
  };
}

/** 逐位对比，指出第一个不同处（比"错了"具体，又不直接给答案） */
function diffHint(got, want) {
  const a = norm(got), b = norm(want);
  if (!a) return { type: 'empty', at: 0, message: '没写' };
  if (a.length < b.length) return { type: 'short', at: a.length, message: '少了 ' + (b.length - a.length) + ' 个字母' };
  if (a.length > b.length) return { type: 'long', at: b.length, message: '多了 ' + (a.length - b.length) + ' 个字母' };
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return { type: 'diff', at: i, message: '第 ' + (i + 1) + ' 个字母不对' };
  }
  return { type: 'diff', at: 0, message: '有细微差别' };
}

/** 跟读比对：把浏览器识别出来的文本和原句比，给出"哪个词没听出来" */
function compareSpeech(target, heard) {
  const t = norm(target).split(' ').filter(Boolean);
  const h = norm(heard).split(' ').filter(Boolean);
  const hit = [], miss = [];
  t.forEach(w => { (h.indexOf(w) >= 0 ? hit : miss).push(w); });
  return {
    target: target, heard: heard,
    hit: hit, miss: miss,
    accuracy: t.length ? Math.round(hit.length / t.length * 100) : 0,
    // 诚实说明：这是"识别成了什么"，不是音准评分
    note: '这是浏览器把你说的识别成了什么，不是音准分数。重点看没识别出来的那几个词。',
  };
}

module.exports = {
  listUnits, createUnit, deleteUnit,
  listWords, addWord, updateWord, deleteWord, parseWordLines, importWords, toCards,
  dictation, grade, compareSpeech, diffHint,
  // 批次24：单元四关 + 艾宾浩斯
  GATES, gateByKey, unitProgress, unitBoard, gateTasks, gradeGate,
  nextEnSchedule, reviewQueue, recordReview, reviewStats, wordDue,
};

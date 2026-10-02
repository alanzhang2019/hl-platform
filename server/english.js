'use strict';
/**
 * 英语模块（P10）
 *
 * 设计取舍：对标站的英语靠"阿里云语音评测"打分。这里不接外部服务，改用**浏览器自带的
 * 语音合成与识别**（SpeechSynthesis / SpeechRecognition），代价是评分粒度粗
 * ——只能判"听出来的词对不对"，给不出音准分。
 * 与其编一个假的音准分骗孩子，不如老实说"这句话我听成了什么，你自己对一下"。
 *
 * 单词表不预置：课程版本太多，预置任何一种都是错的。改为支持从课本批量粘贴导入。
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
 * 批量导入。支持从课本/教辅里直接粘贴，常见几种写法都认：
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
      if (!w) { results.push({ id: it.id, ok: false, missing: true, answer: '' }); return; }
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
};

'use strict';
/**
 * 公共资料池（P3）
 *
 * 三条立场，写在最前面，因为它们决定了这个模块该有什么、不该有什么：
 *
 * 1. **只放用户主动共享的东西，不做预置题库。** 池子一开始是空的。空着就空着 ——
 *    一旦预置，就等于替所有孩子决定了"该学什么"，而课程版本、进度、地区差异太大，
 *    任何一种预置都是对一部分人的错。池子的价值来自"同学之间互相给"。
 *
 * 2. **取用是"复制"，不是"引用"。** 别人分享的卡片复制进自己空间后，就是自己的了：
 *    可以改、可以删、复习记录也只记在自己名下。不做跨空间的实时读 —— 那样会让
 *    "我删了别人还能看到"这种纠缠不清的状态出现，而且一旦原作者改了内容，
 *    已经学过的人的知识结构会莫名其妙地变。
 *
 * 3. **池子里不出现真实姓名。** 空间名默认就是孩子的姓名（这是本平台的设计），
 *    所以绝不能拿空间名当作者名。作者名只用用户自己填的昵称，填的和空间名一样
 *    也会被换掉 —— 分享学习资料不需要署名，需要署名的是家长群。
 */
const D = require('./db');
const core = require('./core');
const cards = require('./cards');
const english = require('./english');
const auth = require('./auth');
const subjects = require('./subjects');

const KINDS = ['note', 'cards', 'words', 'exam'];
const SUBJECTS = subjects.SUBJECTS;

// 池子规则集中放这里，改规则只改一处
const HIDE_THRESHOLD = 3;      // 被举报满 3 次自动隐藏
const BAN_THRESHOLD = 3;       // 累计 3 条被隐藏 → 该空间禁止再共享
const MAX_ACTIVE = 20;         // 单个空间同时在池中的上限
const MAX_CONTENT_BYTES = 200 * 1024;

const ANON = '一位同学';

// ---------- 小工具 ----------
// 池子里的条目必须有个学科才能被筛出来，所以不认识的一律落回 'general'。
// 归一逻辑本身在 subjects.js，这里只是把它包一层，保住 pool 自己的默认值语义。
function normSubject(s) { return subjects.normSubject(s, 'general'); }
function normKind(k) {
  const v = String(k || '').trim().toLowerCase();
  return KINDS.indexOf(v) >= 0 ? v : 'note';
}

/**
 * 昵称净化。空 → 匿名；和空间名（≈真实姓名）相同或包含 → 匿名。
 * 不做"模糊匹配"，因为这里只需要挡住最直接的一种泄漏。
 */
function pickNick(raw, spaceName) {
  const n = String(raw || '').trim().replace(/\s+/g, ' ').slice(0, 20);
  const sp = String(spaceName || '').trim();
  if (!n) return ANON;
  if (sp && (n === sp || n.indexOf(sp) >= 0)) return ANON;
  // 纯数字/手机号也挡掉（孩子可能顺手填家长手机号）
  if (/^\d{6,}$/.test(n)) return ANON;
  return n;
}

function shapeItem(it, opts) {
  const o = opts || {};
  let content = null;
  try { content = JSON.parse(it.content_json); } catch (e) { content = null; }
  return {
    id: it.id,
    title: it.title,
    kind: it.kind,
    subject: it.subject,
    grade: it.grade,
    summary: it.summary,
    authorName: it.author_name,
    status: it.status,
    copies: it.copies,
    reports: it.reports,
    createdAt: it.created_at,
    mine: o.spaceId ? it.space_id === o.spaceId : false,
    // 只有取用的时候才把内容下发（列表里不下发，省流量也少一点"照抄"的冲动）
    content: o.withContent ? content : undefined,
    preview: o.withContent ? undefined : previewOf(it.kind, content),
  };
}

function previewOf(kind, content) {
  if (!content) return '';
  if (kind === 'note') return String(content.text || '').slice(0, 80);
  if (kind === 'cards') return (content.items || []).slice(0, 3).map(c => c.knowledge).join(' / ');
  if (kind === 'words') return (content.items || []).slice(0, 6).map(w => w.word).join(', ');
  if (kind === 'exam') return (content.items || []).slice(0, 3).map(c => c.knowledge).join(' / ');
  return '';
}

/**
 * 该空间是否被禁共享。
 *
 * 只数 'hidden'（被别人举报到下架的），**不数 'removed'**。
 * 为什么：'removed' 是作者自己主动撤下的。把"自己收拾自己的东西"也算成违规，
 * 等于惩罚整理行为 —— 孩子撤掉一条自己觉得放错的资料，反而不许再分享了。
 */
function shareBan(spaceId) {
  const row = D.get(
    "SELECT COUNT(*) c FROM pool_items WHERE space_id = ? AND status = 'hidden'",
    spaceId);
  const n = (row || {}).c || 0;
  return { banned: n >= BAN_THRESHOLD, hiddenCount: n, threshold: BAN_THRESHOLD };
}

function activeCount(spaceId) {
  const row = D.get("SELECT COUNT(*) c FROM pool_items WHERE space_id = ? AND status = 'active'", spaceId);
  return (row || {}).c || 0;
}

// ---------- 内容快照 ----------
/**
 * 把"自己的东西"打成一份快照放进池子。
 * 快照 = 复制，之后原内容再改也不会影响池子里这一份。
 */
function buildContent(spaceId, userId, kind, body) {
  const b = body || {};
  if (kind === 'note') {
    const text = String(b.text || '').trim();
    if (!text) { const e = new Error('笔记内容不能为空'); e.code = 'BAD_INPUT'; throw e; }
    return { text: text.slice(0, 20000) };
  }

  if (kind === 'cards' || kind === 'exam') {
    let list = [];
    if (kind === 'exam' && b.examId) {
      const ex = D.get('SELECT * FROM exams WHERE id = ? AND space_id = ?', b.examId, spaceId);
      if (!ex) { const e = new Error('找不到这张测评卷'); e.code = 'NOT_FOUND'; throw e; }
      list = core.safeJSON(ex.items_json) || [];
      // 分享测评卷 = 分享题目（答案一起给，等于一份带答案的练习）
      return { title: ex.title, items: list.map(c => ({
        knowledge: c.knowledge, type: c.type, subject: c.subject || 'general',
        question: c.question, answer: c.answer,
        options: c.options || null,
      })) };
    }
    const ids = Array.isArray(b.cardIds) ? b.cardIds : null;
    const rows = ids && ids.length
      ? ids.map(id => D.get('SELECT * FROM cards WHERE id = ? AND space_id = ?', id, spaceId)).filter(Boolean)
      : D.all('SELECT * FROM cards WHERE space_id = ? AND status != ? ORDER BY created_at DESC LIMIT 40', spaceId, 'retired');
    if (!rows.length) { const e = new Error('没有可以分享的知识卡'); e.code = 'BAD_INPUT'; throw e; }
    return { items: rows.map(c => ({
      knowledge: c.knowledge, type: c.type, subject: c.subject || 'general',
      question: c.question, answer: c.answer,
      options: c.options_json ? core.safeJSON(c.options_json) : null,
    })) };
  }

  if (kind === 'words') {
    const ids = Array.isArray(b.wordIds) ? b.wordIds : null;
    const rows = ids && ids.length
      ? ids.map(id => D.get('SELECT * FROM words WHERE id = ? AND space_id = ?', id, spaceId)).filter(Boolean)
      : D.all('SELECT * FROM words WHERE space_id = ? ORDER BY created_at ASC LIMIT 200', spaceId);
    if (!rows.length) { const e = new Error('没有可以分享的单词'); e.code = 'BAD_INPUT'; throw e; }
    return { items: rows.map(w => ({ word: w.word, phonetic: w.phonetic, meaning: w.meaning, example: w.example })) };
  }

  const e = new Error('不认识的内容类型：' + kind); e.code = 'BAD_INPUT'; throw e;
}

/** 按内容自动起一个标题/摘要，用户没填的时候用 */
function autoTitle(kind, content, spaceName) {
  if (kind === 'note') return String(content.text || '').split('\n')[0].slice(0, 30) || '一段笔记';
  const n = (content.items || []).length;
  if (kind === 'cards') return '知识卡 · ' + n + ' 张';
  if (kind === 'words') return '单词表 · ' + n + ' 个词';
  if (kind === 'exam') return '练习卷 · ' + n + ' 题';
  return '学习资料';
}
function autoSummary(kind, content) {
  const n = (content.items || []).length;
  if (kind === 'cards') return n + ' 张知识卡，可直接复制进自己的卡片盒复习。';
  if (kind === 'words') return n + ' 个单词，可导入单词本并生成拼写卡。';
  if (kind === 'exam') return n + ' 道题，含答案，复制后变成你自己的知识卡。';
  if (kind === 'note') return '一段学习笔记，' + String(content.text || '').length + ' 字。';
  return '';
}

// ---------- 共享 ----------
function share(spaceId, userId, body) {
  const b = body || {};
  const kind = normKind(b.kind);

  const ban = shareBan(spaceId);
  if (ban.banned) {
    const e = new Error('你的空间已有 ' + ban.hiddenCount + ' 条内容被下架，暂时不能向资料池共享内容了。');
    e.code = 'SHARE_BANNED'; throw e;
  }
  if (activeCount(spaceId) >= MAX_ACTIVE) {
    const e = new Error('池子里最多同时放 ' + MAX_ACTIVE + ' 条，先撤掉几条再分享吧。');
    e.code = 'TOO_MANY'; throw e;
  }

  const content = buildContent(spaceId, userId, kind, b);
  const raw = JSON.stringify(content);
  if (Buffer.byteLength(raw, 'utf8') > MAX_CONTENT_BYTES) {
    const e = new Error('这条内容太大了（超过 200KB），拆小一点再分享。');
    e.code = 'TOO_BIG'; throw e;
  }

  const sp = auth.getSpace(spaceId) || {};
  const authorName = pickNick(b.nickname, sp.name);
  const title = String(b.title || '').trim().slice(0, 60) || autoTitle(kind, content, sp.name);
  const summary = String(b.summary || '').trim().slice(0, 200) || autoSummary(kind, content);
  const subject = normSubject(b.subject);

  const id = D.uid('pi_');
  D.run(`INSERT INTO pool_items(id,space_id,author_name,title,kind,subject,grade,summary,content_json,status,copies,reports,created_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,0,0,?)`,
    id, spaceId, authorName, title, kind, subject,
    String(b.grade || '').slice(0, 20), summary, raw, 'active', D.now());

  core.logActivity(spaceId, userId, 'pool_share', id, { kind: kind, subject: subject });
  return shapeItem(D.get('SELECT * FROM pool_items WHERE id = ?', id), { spaceId: spaceId, withContent: true });
}

// ---------- 浏览 ----------
/**
 * 列表。默认只出 active 的，按学科/类型/关键词过滤。
 * 不下发 content —— 想看内容得先"取用"（复制），这是刻意的：
 * 池子是用来拿走的，不是用来刷的。
 */
function list(spaceId, opts) {
  const o = opts || {};
  let sql = 'SELECT * FROM pool_items WHERE status = ?';
  const p = ['active'];
  if (o.subject && o.subject !== 'all') { sql += ' AND subject = ?'; p.push(normSubject(o.subject)); }
  if (o.kind && o.kind !== 'all') { sql += ' AND kind = ?'; p.push(normKind(o.kind)); }
  if (o.mine) { sql += ' AND space_id = ?'; p.push(spaceId); }
  if (o.q) {
    sql += ' AND (title LIKE ? OR summary LIKE ? OR author_name LIKE ?)';
    p.push('%' + o.q + '%', '%' + o.q + '%', '%' + o.q + '%');
  }
  sql += o.sort === 'hot'
    ? ' ORDER BY copies DESC, created_at DESC'
    : ' ORDER BY created_at DESC';
  sql += ' LIMIT 200';

  const rows = D.all(sql, ...p);
  const myReports = D.all("SELECT item_id FROM pool_actions WHERE space_id = ? AND action = 'report'", spaceId)
    .map(r => r.item_id);
  const myCopies = D.all("SELECT item_id FROM pool_actions WHERE space_id = ? AND action = 'copy'", spaceId)
    .map(r => r.item_id);

  return {
    items: rows.map(r => {
      const s = shapeItem(r, { spaceId: spaceId });
      s.reported = myReports.indexOf(r.id) >= 0;
      s.copied = myCopies.indexOf(r.id) >= 0;
      return s;
    }),
    ban: shareBan(spaceId),
    active: activeCount(spaceId),
    maxActive: MAX_ACTIVE,
  };
}

function get(spaceId, id, opts) {
  const it = D.get('SELECT * FROM pool_items WHERE id = ?', id);
  if (!it) return null;
  const o = opts || {};
  // 隐藏/下架的条目：只有作者自己能看
  if (it.status !== 'active' && it.space_id !== spaceId && !o.admin) return null;
  const s = shapeItem(it, { spaceId: spaceId, withContent: true });
  s.reported = !!D.get("SELECT id FROM pool_actions WHERE item_id = ? AND space_id = ? AND action = 'report'", id, spaceId);
  s.copied = !!D.get("SELECT id FROM pool_actions WHERE item_id = ? AND space_id = ? AND action = 'copy'", id, spaceId);
  return s;
}

/** 我分享出去的：能看到自己的、包括被隐藏的 */
function mine(spaceId) {
  return D.all('SELECT * FROM pool_items WHERE space_id = ? ORDER BY created_at DESC LIMIT 100', spaceId)
    .map(r => {
      const s = shapeItem(r, { spaceId: spaceId, withContent: true });
      s.preview = previewOf(r.kind, s.content);
      return s;
    });
}

// ---------- 取用 ----------
/**
 * 复制进自己的空间。
 * 复制之后两边再无关系 —— 原条目被删，你手里的还在；你改了，原条目也不变。
 *
 * ★ 整个函数包在一个事务里。
 *   取用 6 张卡 = 6×INSERT cards + 6×logActivity + 2×pool ≈ 14 次写。
 *   不包事务时每写一次都是一次独立事务、各 fsync 两次，本机实测 **约 7 秒**；
 *   包起来只 fsync 一次，**约 0.6 秒**（见 `server/db.js` 的 `tx()` 注释与 `_wprobe.cjs`）。
 *   这里能包，是因为 `tx()` 现在可重入了 —— 里面第 319 行那个 `D.tx()` 会降级成 SAVEPOINT。
 */
function copy(spaceId, userId, id, opts) {
  return D.tx(() => copyInner(spaceId, userId, id, opts));
}

function copyInner(spaceId, userId, id, opts) {
  const o = opts || {};
  const it = D.get('SELECT * FROM pool_items WHERE id = ?', id);
  if (!it) { const e = new Error('这条资料不存在或已被移除'); e.code = 'NOT_FOUND'; throw e; }
  if (it.status !== 'active') { const e = new Error('这条资料已被下架，不能取用了'); e.code = 'GONE'; throw e; }

  const content = core.safeJSON(it.content_json) || {};
  const made = { cards: [], words: 0, note: '' };

  if (it.kind === 'note') {
    made.note = String(content.text || '');
  } else if (it.kind === 'words') {
    (content.items || []).forEach(w => {
      try { english.addWord(spaceId, { word: w.word, meaning: w.meaning, phonetic: w.phonetic, example: w.example }); made.words++; }
      catch (e) { /* 重名/空词跳过 */ }
    });
    if (o.toCards) {
      try { made.cards = english.toCards(spaceId, userId, null); } catch (e) { made.cards = []; }
    }
  } else {
    // cards / exam 都是"题目 → 知识卡"
    (content.items || []).forEach(c => {
      try {
        made.cards.push(cards.create(spaceId, userId, {
          knowledge: c.knowledge, type: c.type, subject: c.subject,
          question: c.question, answer: c.answer,
          options: c.options || undefined,
        }));
      } catch (e) { /* 重复或字段不合法就跳过，不整条失败 */ }
    });
  }

  D.tx(() => {
    D.run('UPDATE pool_items SET copies = copies + 1 WHERE id = ?', id);
    D.run('INSERT INTO pool_actions(id,item_id,space_id,action,reason,created_at) VALUES(?,?,?,?,?,?)',
      D.uid('pa_'), id, spaceId, 'copy', null, D.now());
  });
  core.logActivity(spaceId, userId, 'pool_copy', id, { kind: it.kind, cards: made.cards.length, words: made.words });

  return {
    item: get(spaceId, id),
    made: { cards: made.cards.length, words: made.words, note: made.note ? made.note.length : 0 },
    note: made.note,
    // 复制不是"占有"：告诉孩子这些东西现在归你了，可以随便改
    message: it.kind === 'note'
      ? '已经复制到你的空间了，可以在对话里引用它。'
      : '已经复制进你自己的卡片盒了，之后复习、修改都只影响你自己这一份。',
  };
}

// ---------- 举报 ----------
function report(spaceId, userId, id, reason) {
  const it = D.get('SELECT * FROM pool_items WHERE id = ?', id);
  if (!it) { const e = new Error('这条资料不存在'); e.code = 'NOT_FOUND'; throw e; }
  const dup = D.get("SELECT id FROM pool_actions WHERE item_id = ? AND space_id = ? AND action = 'report'", id, spaceId);
  if (dup) { const e = new Error('你已经举报过这条了'); e.code = 'ALREADY'; throw e; }

  let hidden = false;
  D.tx(() => {
    D.run('INSERT INTO pool_actions(id,item_id,space_id,action,reason,created_at) VALUES(?,?,?,?,?,?)',
      D.uid('pa_'), id, spaceId, 'report', String(reason || '').slice(0, 200), D.now());
    D.run('UPDATE pool_items SET reports = reports + 1 WHERE id = ?', id);
    const now = D.get('SELECT reports FROM pool_items WHERE id = ?', id);
    // 满 3 次自动隐藏 —— 不做人工审核队列，池子里本来也不该出现需要"审核"的东西
    if (((now || {}).reports || 0) >= HIDE_THRESHOLD && it.status === 'active') {
      D.run("UPDATE pool_items SET status = 'hidden' WHERE id = ?", id);
      hidden = true;
    }
  });
  core.logActivity(spaceId, userId, 'pool_report', id, { hidden: hidden });

  const ban = shareBan(it.space_id);
  return {
    hidden: hidden,
    reports: ((D.get('SELECT reports FROM pool_items WHERE id = ?', id) || {}).reports) || 0,
    threshold: HIDE_THRESHOLD,
    authorBanned: ban.banned,
    message: hidden
      ? '这条资料已被下架。'
      : '已记录，累计 ' + HIDE_THRESHOLD + ' 次举报会自动下架。',
  };
}

// ---------- 撤回 ----------
function removeShare(spaceId, id) {
  const it = D.get('SELECT * FROM pool_items WHERE id = ?', id);
  if (!it) { const e = new Error('这条资料不存在'); e.code = 'NOT_FOUND'; throw e; }
  if (it.space_id !== spaceId) { const e = new Error('只能撤下自己分享的资料'); e.code = 'FORBIDDEN'; throw e; }
  D.run("UPDATE pool_items SET status = 'removed' WHERE id = ?", id);
  return true;
}

/** 我这边的情况：分享了几条、被复制几次、有没有被禁 */
function myStats(spaceId) {
  const row = D.get('SELECT COUNT(*) n, COALESCE(SUM(copies),0) c, COALESCE(SUM(reports),0) r FROM pool_items WHERE space_id = ?', spaceId) || {};
  const got = D.get("SELECT COUNT(*) n FROM pool_actions WHERE space_id = ? AND action = 'copy'", spaceId) || {};
  return {
    shared: row.n || 0, copiesGained: row.c || 0, reportsReceived: row.r || 0,
    got: got.n || 0, ban: shareBan(spaceId),
  };
}

module.exports = {
  KINDS, SUBJECTS, HIDE_THRESHOLD, BAN_THRESHOLD, MAX_ACTIVE,
  share, list, get, mine, copy, report, removeShare, myStats, shareBan,
  pickNick, buildContent, autoTitle,
};

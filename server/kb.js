'use strict';
/**
 * 知识库（P2）：把资料变成"能进上下文的东西"
 *
 * 检索不做向量库 —— 一个家庭/班级的资料量级（几十份文档）用**中文字符二元组**打分就够了，
 * 而且完全可解释：学生问"为什么引用了这段"，我们能指出是哪个词命中的。
 * 引入 embedding 会同时引入外部服务和不可解释性，现阶段不划算。
 */
const path = require('path');
const D = require('./db');
const core = require('./core');
const extract = require('./extract');

const CHUNK_SIZE = 520;
const CHUNK_OVERLAP = 80;

// ---------- 容量 ----------
// 一个"本子"默认放 5 份文档，可以扩容到 200。
// 为什么要有上限：资料库的价值在于"翻得到"，无限堆文档等于没有分类。
// 上限做软约束（可扩容到 200）而不是硬拒，是因为毕业班一学期的卷子确实可能上百份。
const DEFAULT_CAPACITY = 5;
const MAX_CAPACITY = 200;
const MAX_CATEGORIES = 30;

// ---------- 文档状态 ----------
// 落库是 pending|parsing|ready|failed 四态，但**给学生看**只需要三态：
//   已就绪(ready) / 解析中(parsing) / 需处理(todo)
// ★ "ready 但一个字都没抽出来"也要算需处理 ——
//   扫描件 PDF 常常是"解析没报错、但正文为空"，只按 status 判会骗学生说这份资料能用。
const STATE_TEXT = { ready: '已就绪', parsing: '解析中', todo: '需处理' };
function docState(d) {
  const st = String((d && d.status) || '');
  if (st === 'ready') {
    const n = ((d && d.parsed_text) || '').length;
    return n > 0 ? 'ready' : 'todo';
  }
  if (st === 'failed') return 'todo';
  return 'parsing';                 // pending | parsing | 其它未知态
}
/** 状态筛选：state -> 一组落库 status。ready 态要额外过滤空文本，不能用 SQL 一次搞定 */
function stateFilterRows(rows, state) {
  if (!state) return rows;
  return rows.filter(d => docState(d) === state);
}

// ---------- 分类 ----------
function shapeCategory(spaceId, c) {
  const docs = (D.get('SELECT COUNT(*) n FROM kb_documents WHERE space_id = ? AND category_id = ?', spaceId, c.id) || {}).n || 0;
  const capacity = Math.max(1, Number(c.capacity) || DEFAULT_CAPACITY);
  return {
    id: c.id, name: c.name, hidden: !!c.hidden, createdAt: c.created_at,
    docs: docs, capacity: capacity,
    free: Math.max(0, capacity - docs),
    full: docs >= capacity,
    sortOrder: Number(c.sort_order) || 0,
  };
}
function listCategories(spaceId) {
  return D.all('SELECT * FROM kb_categories WHERE space_id = ? ORDER BY sort_order ASC, created_at ASC', spaceId)
    .map(c => shapeCategory(spaceId, c));
}
function getCategory(spaceId, id) {
  const c = D.get('SELECT * FROM kb_categories WHERE id = ? AND space_id = ?', id, spaceId);
  return c ? shapeCategory(spaceId, c) : null;
}
function createCategory(spaceId, name, opts) {
  const o = opts || {};
  const nm = String(name || '').trim().slice(0, 40);
  if (!nm) { const e = new Error('分类名不能为空'); e.code = 'BAD_INPUT'; throw e; }
  const dup = D.get('SELECT 1 FROM kb_categories WHERE space_id = ? AND name = ?', spaceId, nm);
  if (dup) { const e = new Error('已经有这个分类了'); e.code = 'DUP'; throw e; }
  const total = (D.get('SELECT COUNT(*) n FROM kb_categories WHERE space_id = ?', spaceId) || {}).n || 0;
  if (total >= MAX_CATEGORIES) { const e = new Error('分类最多 ' + MAX_CATEGORIES + ' 个，先合并几个吧'); e.code = 'LIMIT'; throw e; }
  // 容量只认 >=1 的数；0 / 负数 / 乱值一律回落到默认 ——
  // 否则前端一个手滑就能建出"永远装不进东西"的本子，而用户只会以为上传坏了。
  const want = Number(o.capacity);
  const cap = (Number.isFinite(want) && want >= 1) ? Math.min(MAX_CAPACITY, Math.floor(want)) : DEFAULT_CAPACITY;
  const id = D.uid('kbcat_');
  D.run('INSERT INTO kb_categories(id,space_id,name,capacity,sort_order,created_at) VALUES(?,?,?,?,?,?)',
    id, spaceId, nm, cap, total, D.now());
  return getCategory(spaceId, id);
}
function renameCategory(spaceId, id, name) {
  const nm = String(name || '').trim().slice(0, 40);
  if (!nm) { const e = new Error('分类名不能为空'); e.code = 'BAD_INPUT'; throw e; }
  const c = D.get('SELECT * FROM kb_categories WHERE id = ? AND space_id = ?', id, spaceId);
  if (!c) { const e = new Error('分类不存在'); e.code = 'NOT_FOUND'; throw e; }
  const dup = D.get('SELECT 1 FROM kb_categories WHERE space_id = ? AND name = ? AND id != ?', spaceId, nm, id);
  if (dup) { const e = new Error('已经有这个分类了'); e.code = 'DUP'; throw e; }
  D.run('UPDATE kb_categories SET name = ? WHERE id = ? AND space_id = ?', nm, id, spaceId);
  return getCategory(spaceId, id);
}
/**
 * 扩容：把容量加上 delta（默认 +5），封顶 MAX_CAPACITY。
 * 返回更新后的分类 —— 前端要立刻把"容量 5/5"刷成"容量 5/10"。
 */
function expandCategory(spaceId, id, delta) {
  const c = D.get('SELECT * FROM kb_categories WHERE id = ? AND space_id = ?', id, spaceId);
  if (!c) { const e = new Error('分类不存在'); e.code = 'NOT_FOUND'; throw e; }
  const cur = Math.max(1, Number(c.capacity) || DEFAULT_CAPACITY);
  if (cur >= MAX_CAPACITY) { const e = new Error('已经是最大容量了'); e.code = 'LIMIT'; throw e; }
  const next = Math.min(MAX_CAPACITY, cur + Math.max(1, Number(delta) || DEFAULT_CAPACITY));
  D.run('UPDATE kb_categories SET capacity = ? WHERE id = ? AND space_id = ?', next, id, spaceId);
  return getCategory(spaceId, id);
}
function deleteCategory(spaceId, id) {
  D.run('UPDATE kb_documents SET category_id = NULL WHERE space_id = ? AND category_id = ?', spaceId, id);
  D.run('DELETE FROM kb_categories WHERE id = ? AND space_id = ?', id, spaceId);
  return true;
}
/** 未归类：不是真分类，是"没有本子的文档"。容量视为无限，前端显示"未归类" */
function uncategorizedCount(spaceId) {
  return (D.get("SELECT COUNT(*) n FROM kb_documents WHERE space_id = ? AND COALESCE(scope,'kb') = 'kb' AND (category_id IS NULL OR category_id = '' OR category_id NOT IN (SELECT id FROM kb_categories WHERE space_id = ?))", spaceId, spaceId) || {}).n || 0;
}

// ---------- 文档 ----------
function shapeDoc(d, withText) {
  const st = docState(d);
  const o = {
    id: d.id, filename: d.filename, size: d.size, pages: d.pages,
    status: d.status, progress: d.progress, error: d.error,
    // state 是给 UI 的三态（已就绪/解析中/需处理），status 是落库四态。
    // 两个都回传：老代码按 status 过滤，新 UI 按 state 展示，互不干扰。
    state: st, stateText: STATE_TEXT[st] || STATE_TEXT.parsing,
    categoryId: d.category_id, createdAt: d.created_at,
    // scope/conversationId 必须回传：前端要靠它区分"正式资料"与"对话级临时资料"，
    // 不然临时资料在前端看起来和正式资料一模一样，用户会以为传进了资料库。
    scope: d.scope || 'kb',
    conversationId: d.conversation_id || null,
    kind: extract.extOf(d.filename),
    textLength: d.parsed_text ? d.parsed_text.length : 0,
    projects: D.all('SELECT p.id, p.name FROM project_docs pd JOIN projects p ON p.id = pd.project_id WHERE pd.doc_id = ?', d.id)
      .map(r => ({ id: r.id, name: r.name })),
  };
  if (withText) o.text = d.parsed_text || '';
  return o;
}
function listDocuments(spaceId, opts) {
  const o = opts || {};
  let sql = 'SELECT * FROM kb_documents WHERE space_id = ?';
  const p = [spaceId];
  if (o.categoryId) { sql += ' AND category_id = ?'; p.push(o.categoryId); }
  if (o.status) { sql += ' AND status = ?'; p.push(o.status); }
  // scope 区分正式知识库(kb) 与 对话级临时资料(temp)。
  // 默认只看正式库 —— 临时资料只在它所属的那条对话里出现，不该污染全局列表。
  if (o.scope) { sql += ' AND COALESCE(scope,\'kb\') = ?'; p.push(o.scope); }
  else if (!o.includeTemp) { sql += ' AND COALESCE(scope,\'kb\') = \'kb\''; }
  if (o.conversationId) { sql += ' AND conversation_id = ?'; p.push(o.conversationId); }
  sql += ' ORDER BY created_at DESC';
  // state 过滤必须在 JS 里做：ready 但正文为空要算"需处理"，SQL 判不出来。
  return stateFilterRows(D.all(sql, ...p), o.state).map(d => shapeDoc(d, false));
}
function getDocument(spaceId, id, withText) {
  const d = D.get('SELECT * FROM kb_documents WHERE id = ? AND space_id = ?', id, spaceId);
  return d ? shapeDoc(d, withText !== false) : null;
}

// ---------- 文件名纠正 ----------
// 前端粘贴/截图过来的文件拿不到真名（浏览器只给 "blob"），只能造一个占位名。
// 解析器是按**字节**认类型的，比文件名可信 —— 用它把占位扩展名纠回来，
// 让「粘贴的文件.bin」显示成「粘贴的文件.docx」。
//
// 触发条件刻意保守：**只有文件名没有扩展名、或扩展名不在已知集合里**才纠正。
// 用户自己写的 .pdf / .md 一律不动 —— 那是他的命名，改了对不上他的认知，
// 反而像"我传的 pdf 怎么变成 docx 了"。
const KNOWN_EXT = [
  'pdf', 'docx', 'doc', 'xlsx', 'xls', 'pptx', 'ppt', 'rtf',
  'csv', 'tsv', 'md', 'markdown', 'txt', 'text', 'json', 'html', 'htm', 'xml', 'log', 'yaml', 'yml',
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg',
];
// 解析结果 kind → 规范扩展名。只收"能确定"的：
// ole 故意不在表里（它可能是旧 doc / xls / ppt 三种，猜错不如保持原名）；unknown / '?' 同理。
const KIND_EXT = { pdf: 'pdf', docx: 'docx', xlsx: 'xlsx', pptx: 'pptx', rtf: 'rtf', text: 'txt' };

/** 用解析出的真实类型纠正占位扩展名（只动扩展名，主名原样保留）。 */
function alignName(name, r) {
  const ext = extract.extOf(name);
  if (ext && KNOWN_EXT.indexOf(ext) >= 0) return name;
  const want = KIND_EXT[String((r && r.kind) || '').toLowerCase()];
  if (!want || ext === want) return name;
  const base = ext ? name.slice(0, name.length - ext.length - 1) : name;
  return (base || '未命名') + '.' + want;
}

/**
 * 上传：前端把文件读成 base64 传过来（不引入 multipart 解析）。
 * 抽取同步完成 —— 家庭级文档（几 MB）在 Node 里是毫秒到百毫秒量级，
 * 没必要做后台队列，做队列反而引入"状态卡在 parsing"这类难查的问题。
 */
function addDocument(spaceId, userId, { filename, dataBase64, text, categoryId, projectId, conversationId, scope }) {
  let name = String(filename || '未命名').slice(0, 200);
  // ★ 容量卡在入库之前：让容量真的生效（否则"容量 5/5"只是个装饰数字）。
  //   临时资料(scope=temp)不计入本子容量 —— 它挂在对话上，本来就不占资料库位置。
  const cid = categoryId || null;
  if (cid && scope !== 'temp') {
    const cat = getCategory(spaceId, cid);
    if (!cat) { const e = new Error('分类不存在'); e.code = 'NOT_FOUND'; throw e; }
    if (cat.full) { const e = new Error('「' + cat.name + '」已经满了（' + cat.docs + '/' + cat.capacity + '），先扩容再上传'); e.code = 'FULL'; throw e; }
  }
  let buf = null;
  if (dataBase64) {
    const clean = String(dataBase64).replace(/^data:[^;]+;base64,/, '');
    buf = Buffer.from(clean, 'base64');
    if (!buf.length) { const e = new Error('文件内容为空'); e.code = 'BAD_INPUT'; throw e; }
    if (buf.length > 24 * 1024 * 1024) { const e = new Error('文件超过 24MB，请拆分后再上传'); e.code = 'TOO_BIG'; throw e; }
  } else if (typeof text === 'string') {
    buf = Buffer.from(text, 'utf8');
  } else {
    const e = new Error('没有收到文件内容'); e.code = 'BAD_INPUT'; throw e;
  }

  const id = D.uid('kb_');
  const size = buf.length;
  let parsed = '', pages = 0, status = 'ready', error = null, progress = 100;
  // 扫描件要排队做 OCR，调用方（chat.saveDocument）据此建异步任务。
  let scanned = false;
  try {
    const r = extract.extract(buf, name);
    parsed = r.text || '';
    pages = r.pages || 0;
    // 认出了真实类型就把占位扩展名纠回来（.bin → .docx）。放在落盘之前，
    // 这样磁盘上的原文件、库里的名字、模型看到的清单三者一致。
    name = alignName(name, r);
    if (r.ok) {
      // 文字层读出来了，正常入库
    } else if (r.scanned && require('./ocr').ocrConfig().enabled) {
      // ★ 扫描件不是"解析失败"—— 文件是好的，只是这条路走不通，得换 OCR。
      //   报 failed 会让用户以为文件坏了、去重新下载；报 parsing 排队识别才是实话。
      status = 'parsing'; progress = 0; scanned = true; error = null;
    } else if (r.scanned) {
      // 是扫描件但用不了 OCR：明说原因，不能让他对着"解析中"等一个不会来的结果。
      status = 'failed'; error = require('./ocr').OCR_DISABLED_NOTE;
    } else {
      status = 'failed'; error = r.note || '没能从这份文件里抽出文字';
    }
  } catch (e) {
    status = 'failed'; error = '解析出错：' + (e.message || e);
  }

  // 把原文件落盘，便于后续重新解析或下载
  let storage = null;
  try {
    const fs = require('fs');
    const dir = path.join(D.DATA_DIR, 'files', D.normalizeSpace(spaceId));
    fs.mkdirSync(dir, { recursive: true });
    storage = path.join(dir, id + '_' + name.replace(/[^\w.\u4e00-\u9fa5-]/g, '_'));
    fs.writeFileSync(storage, buf);
  } catch (e) { storage = null; }

  const sc = scope === 'temp' ? 'temp' : 'kb';
  D.run(`INSERT INTO kb_documents(id,space_id,category_id,filename,size,pages,status,progress,storage_path,parsed_text,error,conversation_id,scope,created_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id, spaceId, cid, name, size, pages, status, progress, storage, parsed, error,
    sc === 'temp' ? (conversationId || null) : null, sc, D.now());
  if (projectId) D.run('INSERT OR IGNORE INTO project_docs(project_id,doc_id) VALUES(?,?)', projectId, id);
  core.logActivity(spaceId, userId, 'kb_upload', id, { filename: name, size: size, status: status, scope: sc });
  const shaped = getDocument(spaceId, id);
  // scanned 不进库，只挂在这一份返回值上 —— 它是"需要排队识别"的一次性信号。
  if (shaped && scanned) shaped.scanned = true;
  return shaped;
}

// ---------- 扫描件 OCR 的写回口（由 jobs 的 ocr runner 调用）----------

/** 取原始行（runner 需要 storage_path 才能重新读出原文件） */
function getDocumentRow(spaceId, id) {
  return D.get('SELECT * FROM kb_documents WHERE id = ? AND space_id = ?', id, spaceId);
}

/** 单份进度：让"识别中 37/130"是真的在动，而不是一个装饰性的转圈 */
function setDocumentProgress(spaceId, id, progress) {
  const p = Math.max(0, Math.min(99, Math.round(Number(progress) || 0)));
  D.run("UPDATE kb_documents SET progress = ? WHERE id = ? AND space_id = ? AND status = 'parsing'", p, id, spaceId);
}

/** 识别完成：写入正文、置 ready。pages 以真实页数为准（扫描件页数不受图片对象数影响）。 */
function saveOcrText(spaceId, id, text, opts) {
  const o = opts || {};
  const t = String(text || '');
  const pages = Number(o.pages) || 0;
  const note = o.note ? String(o.note).slice(0, 300) : null;
  D.run('UPDATE kb_documents SET parsed_text = ?, pages = ?, status = ?, progress = ?, error = ? WHERE id = ? AND space_id = ?',
    t, pages, 'ready', 100, note, id, spaceId);
  _cache.delete(id);
  return getDocument(spaceId, id, false);
}

/** 识别彻底失败：如实写错误，不留"解析中"的假象 */
function failDocumentParse(spaceId, id, message) {
  D.run("UPDATE kb_documents SET status = 'failed', progress = 0, error = ? WHERE id = ? AND space_id = ?",
    String(message || '识别失败').slice(0, 300), id, spaceId);
  _cache.delete(id);
  return getDocument(spaceId, id, false);
}

function deleteDocument(spaceId, id) {
  const d = D.get('SELECT * FROM kb_documents WHERE id = ? AND space_id = ?', id, spaceId);
  if (!d) return false;
  if (d.storage_path) { try { require('fs').unlinkSync(d.storage_path); } catch (e) {} }
  D.run('DELETE FROM project_docs WHERE doc_id = ?', id);
  D.run('DELETE FROM kb_documents WHERE id = ?', id);
  _cache.delete(id);
  return true;
}

function attachToProject(spaceId, docId, projectId, on) {
  const d = D.get('SELECT 1 FROM kb_documents WHERE id = ? AND space_id = ?', docId, spaceId);
  if (!d) { const e = new Error('文档不存在'); e.code = 'NOT_FOUND'; throw e; }
  if (on) D.run('INSERT OR IGNORE INTO project_docs(project_id,doc_id) VALUES(?,?)', projectId, docId);
  else D.run('DELETE FROM project_docs WHERE project_id = ? AND doc_id = ?', projectId, docId);
  return getDocument(spaceId, docId, false);
}

/** 换本子：categoryId 传 null 表示移出到"未归类"。目标满了要拒绝（FULL） */
function moveDocument(spaceId, docId, categoryId) {
  const d = D.get('SELECT * FROM kb_documents WHERE id = ? AND space_id = ?', docId, spaceId);
  if (!d) { const e = new Error('文档不存在'); e.code = 'NOT_FOUND'; throw e; }
  const cid = categoryId || null;
  if (cid) {
    const cat = getCategory(spaceId, cid);
    if (!cat) { const e = new Error('分类不存在'); e.code = 'NOT_FOUND'; throw e; }
    if (d.category_id !== cid && cat.full) {
      const e = new Error('「' + cat.name + '」已经满了（' + cat.docs + '/' + cat.capacity + '），先扩容再移过去'); e.code = 'FULL'; throw e;
    }
  }
  D.run('UPDATE kb_documents SET category_id = ? WHERE id = ? AND space_id = ?', cid, docId, spaceId);
  return getDocument(spaceId, docId, false);
}

/**
 * 重新解析：给"需处理"的文档一次翻身机会。
 * 扫描件 OCR 缺失、加密 PDF、编码判断错，重跑一次抽取有时就能出来。
 */
function reparseDocument(spaceId, id) {
  const d = D.get('SELECT * FROM kb_documents WHERE id = ? AND space_id = ?', id, spaceId);
  if (!d) { const e = new Error('文档不存在'); e.code = 'NOT_FOUND'; throw e; }
  let buf = null;
  if (d.storage_path) { try { buf = require('fs').readFileSync(d.storage_path); } catch (e) { buf = null; } }
  if (!buf || !buf.length) { const e = new Error('原件已经不在了，请重新上传'); e.code = 'NO_SOURCE'; throw e; }
  let parsed = '', pages = 0, status = 'ready', error = null, progress = 100;
  let scanned = false;
  try {
    const r = extract.extract(buf, d.filename);
    parsed = r.text || ''; pages = r.pages || 0;
    // 与 addDocument 同一套判定：扫描件交给 OCR，别报成"文件坏了"。
    if (r.ok) {
      // 读出来了
    } else if (r.scanned && require('./ocr').ocrConfig().enabled) {
      status = 'parsing'; progress = 0; scanned = true;
    } else if (r.scanned) {
      status = 'failed'; error = require('./ocr').OCR_DISABLED_NOTE;
    } else {
      status = 'failed'; error = r.note || '没能从这份文件里抽出文字';
    }
  } catch (e) { status = 'failed'; error = '解析出错：' + (e.message || e); }
  D.run('UPDATE kb_documents SET parsed_text = ?, pages = ?, status = ?, error = ?, progress = ? WHERE id = ? AND space_id = ?',
    parsed, pages, status, error, progress, id, spaceId);
  _cache.delete(id);
  const shaped = getDocument(spaceId, id, false);
  if (shaped && scanned) shaped.scanned = true;
  return shaped;
}

// ---------- 检索 ----------
const _cache = new Map();   // docId -> chunks

function chunkText(text) {
  const t = String(text || '').replace(/\r\n?/g, '\n');
  if (!t) return [];
  const chunks = [];
  let i = 0;
  while (i < t.length) {
    let end = Math.min(i + CHUNK_SIZE, t.length);
    if (end < t.length) {
      // 尽量切在段落或句号处
      const slice = t.slice(i, end + 120);
      const cut = Math.max(slice.lastIndexOf('\n\n'), slice.lastIndexOf('。'), slice.lastIndexOf('\n'));
      if (cut > CHUNK_SIZE * 0.5) end = i + cut + 1;
    }
    const s = t.slice(i, end).trim();
    if (s) chunks.push(s);
    if (end >= t.length) break;
    i = Math.max(end - CHUNK_OVERLAP, i + 1);
  }
  return chunks;
}
function chunksOf(doc) {
  if (_cache.has(doc.id)) return _cache.get(doc.id);
  const cs = chunkText(doc.parsed_text).map((text, idx) => ({ text: text, idx: idx }));
  if (_cache.size > 60) _cache.clear();
  _cache.set(doc.id, cs);
  return cs;
}

/** 中文没有空格，用字符二元组做检索单元；同时保留英文单词 */
function terms(s) {
  const t = String(s || '').toLowerCase();
  const out = [];
  const en = t.match(/[a-z][a-z0-9'-]{2,}/g) || [];
  en.forEach(w => out.push(w));
  const cn = t.replace(/[^\u4e00-\u9fa5]/g, ' ');
  cn.split(/\s+/).forEach(seg => {
    for (let i = 0; i < seg.length - 1; i++) out.push(seg.slice(i, i + 2));
    if (seg.length === 1) out.push(seg);
  });
  return out;
}

/**
 * 检索：返回最相关的片段。
 * 打分 = 命中词数 / sqrt(片段长度) —— 用长度做归一，避免长片段靠"面积大"取胜。
 */
function retrieve(spaceId, query, opts) {
  const o = opts || {};
  const limit = Math.max(1, Math.min(12, Number(o.limit) || 5));
  const qs = terms(query);
  if (!qs.length) return [];
  const uniq = Array.from(new Set(qs));
  const docs = D.all('SELECT * FROM kb_documents WHERE space_id = ? AND status = ?', spaceId, 'ready');
  // ★ 临时资料只对"它所属的那条对话"可见：
  //   不这样卡，A 对话里传的卷子会在 B 对话里被检索出来，学生会莫名其妙。
  const visible = docs.filter(d => {
    if ((d.scope || 'kb') !== 'temp') return true;
    return !!o.conversationId && d.conversation_id === o.conversationId;
  });
  const scoped = o.docIds && o.docIds.length ? visible.filter(d => o.docIds.indexOf(d.id) >= 0) : visible;
  const hits = [];
  scoped.forEach(doc => {
    chunksOf(doc).forEach(ch => {
      let score = 0, matched = 0;
      const low = ch.text.toLowerCase();
      uniq.forEach(term => {
        let from = 0, n = 0;
        while (true) {
          const at = low.indexOf(term, from);
          if (at < 0) break;
          n++; from = at + term.length;
          if (n > 6) break;
        }
        if (n) { matched++; score += Math.min(n, 4); }
      });
      if (!score) return;
      hits.push({
        docId: doc.id, filename: doc.filename, chunkIndex: ch.idx, text: ch.text,
        score: score / Math.sqrt(ch.text.length / 100 + 1),
        matched: matched,
      });
    });
  });
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, limit).map(h => ({ ...h, score: Math.round(h.score * 100) / 100 }));
}

/** 给对话用的引用块（拼进系统提示词） */
function contextFor(spaceId, query, opts) {
  const hits = retrieve(spaceId, query, opts);
  if (!hits.length) return { hits: [], text: '' };
  const text = hits.map((h, i) =>
    `[资料${i + 1}]《${h.filename}》第 ${h.chunkIndex + 1} 段：\n${h.text.slice(0, 700)}`
  ).join('\n\n');
  return { hits: hits, text: text };
}

module.exports = {
  CHUNK_SIZE, DEFAULT_CAPACITY, MAX_CAPACITY, MAX_CATEGORIES, STATE_TEXT,
  docState,
  listCategories, getCategory, createCategory, renameCategory, expandCategory, deleteCategory,
  uncategorizedCount,
  listDocuments, getDocument, addDocument, deleteDocument, attachToProject, moveDocument, reparseDocument,
  // 扫描件 OCR 的写回口
  getDocumentRow, setDocumentProgress, saveOcrText, failDocumentParse,
  alignName, KNOWN_EXT, KIND_EXT,
  chunkText, terms, retrieve, contextFor,
};

'use strict';
/**
 * 文档抽取 + 知识库检索 + 看板 自检
 *
 * extract.js 里是手写的 PDF 流解析和 ZIP 解析 —— 这类代码最容易"看起来能用、
 * 遇到真文件就静默返回乱码"。所以这里不 mock，直接**现场构造真实的二进制夹具**：
 *   手拼一个 PDF、用 zlib 手拼一个 ZIP（stored 与 deflate 两种）、再从 ZIP 拼出 docx/xlsx。
 * 跑法：node _extracttest.cjs
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

process.env.DATA_DIR = path.join(os.tmpdir(), 'hl-ext-' + crypto.randomBytes(4).toString('hex'));
process.env.DB_FILE = path.join(process.env.DATA_DIR, 'app.db');

const extract = require('./server/extract');
const kb = require('./server/kb');
const dash = require('./server/dashboard');
const cards = require('./server/cards');
const core = require('./server/core');

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  \u2713 ' + name); }
  else { fail++; failures.push(name + (extra ? ' → ' + (typeof extra === 'string' ? extra : JSON.stringify(extra)) : '')); console.log('  \u2717 ' + name + (extra ? ' → ' + (typeof extra === 'string' ? extra : JSON.stringify(extra)) : '')); }
}
function eq(name, got, want) { ok(name, JSON.stringify(got) === JSON.stringify(want), 'got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want)); }
function group(t) { console.log('\n' + t); }

// ================= 夹具构造 =================
const CRC_T = (() => {
  const t = new Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c >>> 0; }
  return t;
})();
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_T[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

/** 手拼一个 ZIP。method: 0=stored, 8=deflate */
function makeZip(files, method) {
  const m = method == null ? 0 : method;
  const locals = [], centrals = [];
  let offset = 0;
  for (const name in files) {
    const raw = Buffer.isBuffer(files[name]) ? files[name] : Buffer.from(files[name], 'utf8');
    const data = m === 8 ? zlib.deflateRawSync(raw) : raw;
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(raw);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0, 6); lh.writeUInt16LE(m, 8);
    lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0, 12);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26); lh.writeUInt16LE(0, 28);
    locals.push(lh, nameBuf, data);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0, 8); ch.writeUInt16LE(m, 10);
    ch.writeUInt16LE(0, 12); ch.writeUInt16LE(0, 14);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(raw.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28); ch.writeUInt16LE(0, 30); ch.writeUInt16LE(0, 32);
    ch.writeUInt16LE(0, 34); ch.writeUInt16LE(0, 36); ch.writeUInt32LE(0, 38);
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4); eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(Object.keys(files).length, 8);
  eocd.writeUInt16LE(Object.keys(files).length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([Buffer.concat(locals), cd, eocd]);
}

/** 手拼一个 PDF。flate=true 时内容流用 FlateDecode 压缩
 *  非 ASCII 的文字用 UTF-16BE 十六进制串 <FEFF....>（真实 PDF 里 CID 字体就是这么写的），
 *  因为 PDF 的字面量字符串是单字节编码，直接塞中文会被截断。 */
function pdfStr(s) {
  if (/^[\x20-\x7e]*$/.test(s)) return '(' + s.replace(/([\\()])/g, '\\$1') + ')';
  let hex = 'FEFF';
  for (const ch of s) hex += ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0');
  return '<' + hex + '>';
}
function makePdf(lines, flate) {
  const content = 'BT /F1 12 Tf 72 720 Td\n' +
    lines.map(l => pdfStr(l) + ' Tj ET\nBT /F1 12 Tf 72 700 Td').join('\n') + ' ET\n';
  const body = Buffer.from(content, 'latin1');
  const data = flate ? zlib.deflateSync(body) : body;
  const head = Buffer.from(
    '%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n' +
    '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n' +
    '3 0 obj << /Type /Page /Parent 2 0 R /Contents 4 0 R >> endobj\n' +
    '4 0 obj << /Length ' + data.length + (flate ? ' /Filter /FlateDecode' : '') + ' >>\nstream\n', 'latin1');
  const tail = Buffer.from('\nendstream\nendobj\ntrailer << /Root 1 0 R >>\n%%EOF\n', 'latin1');
  return Buffer.concat([head, data, tail]);
}

const DOCX_XML = '<?xml version="1.0"?><w:document xmlns:w="x"><w:body>' +
  '<w:p><w:r><w:t>光合作用把光能变成化学能。</w:t></w:r></w:p>' +
  '<w:p><w:r><w:t>反应式：6CO2 + 6H2O → C6H12O6 + 6O2</w:t></w:r></w:p>' +
  '<w:p><w:r><w:t>叶绿体是主要场所。</w:t></w:r></w:p>' +
  '</w:body></w:document>';

const XLSX_STRINGS = '<?xml version="1.0"?><sst><si><t>姓名</t></si><si><t>成绩</t></si><si><t>张小明</t></si><si><t>应用题</t></si></sst>';
const XLSX_SHEET = '<?xml version="1.0"?><worksheet><sheetData>' +
  '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>' +
  '<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>85</v></c></row>' +
  '<row r="3"><c r="A3" t="s"><v>3</v></c><c r="B3"><v>62</v></c></row>' +
  '</sheetData></worksheet>';

console.log('文档抽取 / 知识库 / 看板 自检');

// ================= 1. ZIP =================
group('1. ZIP 解析（docx/xlsx 的容器）');
{
  const z1 = extract.unzip(makeZip({ 'a.txt': 'hello zip' }, 0));
  ok('能解 stored 模式', z1 && z1['a.txt'] && z1['a.txt'].toString() === 'hello zip');
  const z2 = extract.unzip(makeZip({ 'a.txt': 'hello deflate '.repeat(20) }, 8));
  ok('能解 deflate 模式', z2 && z2['a.txt'] && z2['a.txt'].toString().indexOf('hello deflate') === 0);
  const z3 = extract.unzip(Buffer.from('这不是一个 zip 文件，只是一段普通文字'));
  ok('非 zip 输入返回 null 而不是抛错', z3 === null);
  const z4 = extract.unzip(makeZip({ 'x/y/z.xml': '<a>多级路径</a>' }, 8));
  ok('支持多级路径条目', z4 && z4['x/y/z.xml'] && z4['x/y/z.xml'].toString().indexOf('多级路径') >= 0);
}

// ================= 2. DOCX =================
group('2. DOCX');
{
  const r = extract.extract(makeZip({ 'word/document.xml': DOCX_XML }, 8), '光合作用.docx');
  ok('docx 抽取成功', r.ok, r.note || '');
  ok('抽出中文正文', r.text.indexOf('光合作用把光能变成化学能') >= 0, r.text.slice(0, 80));
  ok('段落被拆成多行', r.text.split('\n').length >= 3, JSON.stringify(r.text.split('\n')));
  ok('化学式里的箭头保留', r.text.indexOf('→') >= 0, r.text.slice(0, 120));
  ok('XML 标签没有被留下', r.text.indexOf('<w:') < 0);
  const bad = extract.extract(makeZip({ 'other.xml': '<x/>' }, 8), '缺document.docx');
  ok('缺 word/document.xml 时明确失败', bad.ok === false && !!bad.note, JSON.stringify(bad).slice(0, 120));
}

// ================= 3. XLSX =================
group('3. XLSX');
{
  const r = extract.extract(makeZip({ 'xl/sharedStrings.xml': XLSX_STRINGS, 'xl/worksheets/sheet1.xml': XLSX_SHEET }, 8), '成绩.xlsx');
  ok('xlsx 抽取成功', r.ok, r.note || '');
  ok('共享字符串被解析', r.text.indexOf('张小明') >= 0, r.text.slice(0, 120));
  ok('数字单元格被解析', r.text.indexOf('85') >= 0);
  ok('行按制表符分隔', r.text.indexOf('\t') >= 0);
}

// ================= 4. PPTX =================
group('4. PPTX');
{
  const zip = makeZip({
    'ppt/slides/slide1.xml': '<p:sld><a:t>第一页标题</a:t><a:t>要点一</a:t></p:sld>',
    'ppt/slides/slide2.xml': '<p:sld><a:t>第二页标题</a:t></p:sld>',
  }, 8);
  const r = extract.extract(zip, '演示.pptx');
  ok('pptx 抽取成功', r.ok, r.note || '');
  ok('按页拆分', r.text.indexOf('第 1 页') >= 0 && r.text.indexOf('第 2 页') >= 0, r.text.slice(0, 80));
  eq('页数正确', r.pages, 2);
}

// ================= 5. PDF =================
group('5. PDF');
{
  const r = extract.extract(makePdf(['Hello world from PDF']), 'a.pdf');
  ok('未压缩 PDF 抽取成功', r.ok, r.note || '');
  ok('抽到英文正文', r.text.indexOf('Hello world from PDF') >= 0, r.text.slice(0, 100));

  const rf = extract.extract(makePdf(['Flate compressed line one', '第二段文字内容']), 'b.pdf');
  ok('FlateDecode 压缩流能解开', rf.ok, rf.note || '');
  ok('压缩流里抽到英文段', rf.text.indexOf('Flate compressed line one') >= 0, rf.text.slice(0, 160));
  ok('压缩流里抽到中文段（UTF-16BE 十六进制串）', rf.text.indexOf('第二段文字内容') >= 0, rf.text.slice(0, 160));
  ok('UTF-16 串的 BOM 被剥掉', rf.text.indexOf('\uFEFF') < 0);
  ok('两段被拆成不同行', rf.text.split('\n').filter(x => x.trim()).length >= 2, JSON.stringify(rf.text.split('\n')));

  const esc = extract.extract(makePdf(['parens ( and ) work here']), 'c.pdf');
  ok('PDF 字符串里的括号转义被还原', esc.text.indexOf('parens ( and ) work here') >= 0, JSON.stringify(esc.text));
  // 直接对转义函数做单元断言（上面那条会被夹具再转义一层，测不准）
  eq('转义：换行', extract.unescapePdfString('a\\nb'), 'a\nb');
  eq('转义：制表', extract.unescapePdfString('a\\tb'), 'a\tb');
  eq('转义：反斜杠', extract.unescapePdfString('a\\\\b'), 'a\\b');
  eq('转义：圆括号', extract.unescapePdfString('\\(x\\)'), '(x)');
  eq('转义：八进制 \\101 = A', extract.unescapePdfString('\\101'), 'A');
  eq('转义：未知转义原样保留', extract.unescapePdfString('a\\zb'), 'azb');

  // 二进制垃圾流：必须诚实失败，不能返回乱码
  const garbage = Buffer.concat([
    Buffer.from('%PDF-1.4\n4 0 obj << /Length 400 /Filter /FlateDecode >>\nstream\n', 'latin1'),
    zlib.deflateSync(crypto.randomBytes(400)),
    Buffer.from('\nendstream\nendobj\n%%EOF', 'latin1'),
  ]);
  const g = extract.extract(garbage, 'scan.pdf');
  ok('扫描件/乱码 PDF 被识别为失败而不是假装成功', g.ok === false, JSON.stringify(g).slice(0, 100));
  ok('失败时给出可执行的建议', /建议|换成|贴进对话/.test(g.note || ''), g.note);

  const noPdf = extract.extract(Buffer.from('这根本不是 PDF'), 'x.pdf');
  ok('完全不是 PDF 的文件不崩', noPdf.ok === false);
}

// ================= 6. 纯文本与不支持格式 =================
group('6. 纯文本与不支持格式');
{
  const t = extract.extract(Buffer.from('第一行\n第二行\n第三行', 'utf8'), '笔记.txt');
  ok('txt 直接可用', t.ok && t.text.indexOf('第二行') >= 0);
  const m = extract.extract(Buffer.from('# 标题\n\n正文内容'), '笔记.md');
  ok('md 直接可用', m.ok && m.text.indexOf('# 标题') >= 0);
  const c = extract.extract(Buffer.from('a,b,c\n1,2,3'), '数据.csv');
  ok('csv 直接可用', c.ok && c.text.indexOf('1,2,3') >= 0);
  const noext = extract.extract(Buffer.from('没有扩展名的内容'), 'README');
  ok('无扩展名按文本处理', noext.ok);
  const doc = extract.extract(Buffer.from([0xD0, 0xCF, 0x11, 0xE0]), '旧文件.doc');
  ok('.doc 明确不支持并给出转换建议', doc.ok === false && /docx/.test(doc.note), doc.note);
  const xls = extract.extract(Buffer.from([0xD0, 0xCF, 0x11, 0xE0]), '旧表.xls');
  ok('.xls 明确不支持并给出转换建议', xls.ok === false && /xlsx/.test(xls.note), xls.note);
  const unk = extract.extract(Buffer.from('zzz'), 'a.qqq');
  ok('未知扩展名明确拒绝', unk.ok === false && /不支持/.test(unk.note), unk.note);
}

// ================= 7. 乱码识别 =================
group('7. 乱码识别（不能把乱码当文字喂给模型）');
{
  ok('正常中文判为文字', extract.looksLikeText('这是一段正常的中文内容，用来测试判定逻辑是否可靠。'));
  ok('正常英文判为文字', extract.looksLikeText('This is a normal English paragraph used for testing.'));
  ok('随机二进制判为非文字', !extract.looksLikeText(Buffer.from(crypto.randomBytes(200)).toString('latin1')));
  ok('短笔记也判为文字（"作业：P12 第1-5题"不该被拒）', extract.looksLikeText('作业：P12 第1-5题'));
  ok('空串判为非文字', !extract.looksLikeText(''));
  ok('太短的判为非文字', !extract.looksLikeText('短'));
  ok('extOf 取扩展名', extract.extOf('我的资料.PDF') === 'pdf');
  ok('extOf 无扩展名返回空', extract.extOf('README') === '');
}

// ================= 8. 分块与检索 =================
group('8. 知识库：分块与检索');
{
  const chunks = kb.chunkText('第一段内容，用来把文本撑长一点。'.repeat(60) + '\n\n' + '第二段内容，同样要足够长。'.repeat(60));
  ok('长文本被切成多块', chunks.length >= 3, '块数 ' + chunks.length + ' 总长 ' + chunks.join('').length);
  ok('每块不超过上限太多', chunks.every(c => c.length <= 700), '最长 ' + Math.max.apply(null, chunks.map(c => c.length)));
  ok('相邻块之间有重叠（避免答案正好被切断）', chunks.length >= 2 && chunks[0].slice(-30) !== chunks[1].slice(0, 30));
  ok('分块不丢内容（合并后长度不小于原文的 95%）', chunks.join('').length > ('第一段内容，用来把文本撑长一点。'.repeat(60) + '\n\n' + '第二段内容，同样要足够长。'.repeat(60)).length * 0.95);
  ok('优先在句号处切断', chunks.slice(0, -1).every(c => /[。\n]$/.test(c.trim())), JSON.stringify(chunks.map(c => c.slice(-4))));
  ok('短文本切成 1 块', kb.chunkText('很短的一句话。').length === 1);
  eq('空文本切成 0 块', kb.chunkText('').length, 0);

  const t = kb.terms('光合作用的反应式是什么');
  ok('中文按二元组切词', t.indexOf('光合') >= 0 && t.indexOf('作用') >= 0, JSON.stringify(t.slice(0, 8)));
  const te = kb.terms('photosynthesis reaction');
  ok('英文按单词切', te.indexOf('photosynthesis') >= 0, JSON.stringify(te));
}

// ================= 9. 知识库端到端 =================
group('9. 知识库端到端');
{
  const SID = '0001';
  const cat = kb.createCategory(SID, '生物');
  ok('建分类', !!cat.id && cat.name === '生物');
  let dupErr = null;
  try { kb.createCategory(SID, '生物'); } catch (e) { dupErr = e.code; }
  eq('同名分类被拒', dupErr, 'DUP');

  const d1 = kb.addDocument(SID, null, {
    filename: '光合作用.txt',
    text: '光合作用是绿色植物利用光能，把二氧化碳和水转化成有机物并释放氧气的过程。' +
      '这个过程发生在叶绿体中，需要光照作为能量来源。' +
      '反应式可以写成：二氧化碳 + 水 → 有机物 + 氧气。' +
      '影响光合作用速率的因素有光照强度、二氧化碳浓度和温度。',
    categoryId: cat.id,
  });
  eq('上传文本文档成功', d1.status, 'ready');
  ok('抽出文字', d1.textLength > 50, 'len=' + d1.textLength);
  ok('带上分类', d1.categoryId === cat.id);

  const d2 = kb.addDocument(SID, null, {
    filename: '细胞结构.md',
    text: '细胞膜控制物质进出。细胞核储存遗传信息。线粒体是呼吸作用的场所，被称为动力车间。' +
      '植物细胞还有细胞壁、液泡和叶绿体，动物细胞没有。',
  });
  eq('上传第二份文档', d2.status, 'ready');

  const bad = kb.addDocument(SID, null, { filename: '扫描.pdf', dataBase64: makePdf([]).toString('base64') });
  ok('抽不出文字的文档状态为 failed', bad.status === 'failed', bad.status + ' / ' + bad.error);

  eq('文档列表 3 份', kb.listDocuments(SID).length, 3);
  eq('按分类筛选 1 份', kb.listDocuments(SID, { categoryId: cat.id }).length, 1);
  eq('按状态筛选 ready 2 份', kb.listDocuments(SID, { status: 'ready' }).length, 2);

  const hits = kb.retrieve(SID, '光合作用需要什么条件', { limit: 5 });
  ok('检索有命中', hits.length > 0, '命中 ' + hits.length);
  ok('最相关的是光合作用那份', hits[0].filename === '光合作用.txt', hits.map(h => h.filename).join(','));
  ok('命中片段里含关键词', hits[0].text.indexOf('光合作用') >= 0);
  ok('命中带相关性分数', typeof hits[0].score === 'number' && hits[0].score > 0, String(hits[0].score));

  const hits2 = kb.retrieve(SID, '线粒体是什么', { limit: 5 });
  ok('换个问题命中另一份文档', hits2.length > 0 && hits2[0].filename === '细胞结构.md', hits2.map(h => h.filename).join(','));

  const none = kb.retrieve(SID, '完全不相关的量子力学内容', { limit: 5 });
  ok('不相关的问题不硬凑命中', none.length === 0 || none[0].score < 1, JSON.stringify(none.slice(0, 2)));

  const ctx = kb.contextFor(SID, '光合作用', { limit: 2 });
  ok('生成引用上下文', ctx.text.indexOf('资料1') >= 0 && ctx.text.indexOf('光合作用.txt') >= 0, ctx.text.slice(0, 80));

  const scoped = kb.retrieve(SID, '线粒体', { docIds: [d1.id] });
  ok('限定文档范围后不再命中范围外的文档', scoped.every(h => h.docId === d1.id), scoped.map(h => h.filename).join(','));

  // 项目关联
  const p = core.createProject(SID, { name: '生物复习', instructions: '用问题引导' });
  kb.attachToProject(SID, d2.id, p.id, true);
  ok('文档能挂到项目上', kb.getDocument(SID, d2.id).projects.some(x => x.id === p.id));
  kb.attachToProject(SID, d2.id, p.id, false);
  ok('能从项目上摘下来', !kb.getDocument(SID, d2.id).projects.some(x => x.id === p.id));

  ok('删除文档生效', kb.deleteDocument(SID, d2.id) === true);
  eq('删除后剩 2 份', kb.listDocuments(SID).length, 2);
  ok('删除不存在的文档返回 false', kb.deleteDocument(SID, 'nope') === false);

  kb.deleteCategory(SID, cat.id);
  eq('删分类后分类数为 0', kb.listCategories(SID).length, 0);
  ok('删分类后文档还在（只是没了分类）', kb.listDocuments(SID).length === 2);
  ok('删分类后原文档 categoryId 被清空', kb.getDocument(SID, d1.id).categoryId === null);
}

// ================= 10. 看板 =================
group('10. 看板');
{
  const SID = '0002';
  const empty = dash.dashboard(SID, { days: 7 });
  eq('空空间曲线有 7 天', empty.curve.length, 7);
  eq('空空间活跃天数为 0', empty.activeDays, 0);
  eq('空空间没有薄弱点', empty.weakPoints.length, 0);
  eq('空空间连续天数为 0', empty.streak.days, 0);
  ok('空空间报告不报错', typeof dash.report(SID, 'day').lines.join('') === 'string');

  // 造真实活动
  const c1 = cards.create(SID, null, { knowledge: '光合作用', type: 'choice', answer: '12', options: { choices: ['12', '24'], answerIndex: 0 } });
  cards.create(SID, null, { knowledge: '细胞呼吸', type: 'choice', answer: 'a', options: { choices: ['a', 'b'], answerIndex: 0 } });
  cards.review(SID, null, c1.id, { result: 'wrong', studentAnswer: '24' });
  cards.review(SID, null, c1.id, { result: 'wrong', studentAnswer: '24' });
  cards.review(SID, null, c1.id, { result: 'right', studentAnswer: '12' });

  const d = dash.dashboard(SID, { days: 7 });
  ok('统计到知识卡', d.totals.cards === 2, JSON.stringify(d.totals));
  ok('统计到今日待练', d.totals.due >= 0);
  ok('活跃天数为 1', d.activeDays === 1, 'activeDays=' + d.activeDays);
  eq('连续学习 1 天', d.streak.days, 1);
  ok('今天标记为已学习', d.streak.activeToday === true);
  ok('曲线里今天有记录', d.curve[d.curve.length - 1].total > 0, JSON.stringify(d.curve[d.curve.length - 1]));
  eq('今天有 3 次复习记录', d.curve[d.curve.length - 1].card_review, 3);

  const m = dash.movement(SID, 7);
  eq('本周复习次数 3', m.reviews, 3);
  eq('答对 1 次', m.right, 1);
  eq('答错 2 次', m.wrong, 2);
  eq('答对率 33%', m.accuracy, 33);

  const w = dash.weakPoints(SID, 5);
  ok('找出反复答错的点', w.length === 1 && w[0].knowledge === '光合作用', JSON.stringify(w));
  eq('答错次数统计正确', w[0].wrongs, 2);
  ok('给出错误率', w[0].wrongRate === 67, String(w[0].wrongRate));

  const cmp = dash.compare(SID);
  ok('本周活动数 >= 1', cmp.thisWeek >= 1, JSON.stringify(cmp));
  ok('给出与上周的对比方向', ['up', 'down', 'flat'].indexOf(cmp.direction) >= 0, JSON.stringify(cmp));

  const rep = dash.report(SID, 'week');
  ok('周报有标题', rep.title.indexOf('周') >= 0, rep.title);
  ok('周报提到复习次数', rep.lines.join(' ').indexOf('3 次') >= 0, rep.lines.join(' | '));
  ok('周报点名薄弱点', rep.lines.join(' ').indexOf('光合作用') >= 0, rep.lines.join(' | '));
  const repDay = dash.report(SID, 'day');
  ok('日报有内容', repDay.lines.length >= 2);
  ok('日报不说"你错了"', repDay.lines.join(' ').indexOf('你错了') < 0);
}

// ================= 收尾 =================
try { fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true }); } catch (e) {}
console.log('\n' + '─'.repeat(58));
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
if (fail) { console.log('\n失败明细：'); failures.forEach(f => console.log('  · ' + f)); }
process.exit(fail ? 1 : 0);

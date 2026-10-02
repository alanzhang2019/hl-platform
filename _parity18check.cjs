'use strict';
/**
 * 批次18 自检：聊天窗口里粘贴的文档，AI 到底读没读？
 *
 * 背景（2026-10-02 用户报障「粘贴的文档，AI 似乎没有读取」）：
 *   查下来是**两个独立原因**，缺一不可，两个都得修：
 *   ① 粘贴过来的文件常常没有可信文件名 —— 前端取不到 type 时只能叫 `.bin`
 *      （见 app.js 的 paste 监听），而 `.bin` 正好落到 extract() 的「暂不支持」分支，
 *      于是**粘贴的 Word / PDF 一律解析失败**。
 *   ② 就算解析成功，对话级临时资料也**既不进系统提示词的资料清单、又只能靠关键词检索命中**。
 *      问得泛（"帮我看看我传的这份文档"）时检索 0 命中 ⇒ 模型手里完全没有这份资料的痕迹，
 *      表现出来就是"AI 没读我的文档"。
 *
 * 覆盖：
 *   1) 嗅探 —— ZIP 条目名分辨 docx/xlsx/pptx、PDF/OLE/RTF 魔数、认不出就返回空串
 *   2) 解析 —— .bin 假名带真字节能读出来；真二进制**如实失败且正文为空**；原有 .docx/.txt 路径不变
 *   3) 兜底 —— buildTempDocContext 的边界（空 / 全失败 / 单份截断 / 总量封顶 / 脏输入不崩）
 *   4) 提示词 —— 清单必带；失败的资料必须标注并禁止假装看过；检索有命中时**不重复**塞正文
 *   5) 接线 —— server.js 真的取了临时资料并传下去；★ app.js 的文字守卫必须排在 preventDefault 之前
 *
 * 不起服务、不连外网。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const zlib = require('zlib');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hl-p17-'));
process.env.DATA_DIR = TMP;
process.env.NO_DOTENV = '1';
delete process.env.LLM_API_KEY;
delete process.env.ADMIN_PASSWORD;

const extract = require('./server/extract');
const llm = require('./server/llm');
const kb = require('./server/kb');
const SERVERJS = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
const APPJS = fs.readFileSync(path.join(__dirname, 'public/js/app.js'), 'utf8');

let pass = 0, fail = 0;
const fails = [];
function ok(cond, name, extra) {
  if (cond) { pass++; }
  else { fail++; fails.push(name + (extra !== undefined ? ' → ' + JSON.stringify(extra) : '')); }
}
function eq(got, want, name) {
  ok(got === want, name + '（期望 ' + JSON.stringify(want) + '，实际 ' + JSON.stringify(got) + '）');
}
function has(hay, needle) { return String(hay).indexOf(needle) >= 0; }

/** 手拼一个 ZIP（docx / xlsx / pptx 的容器都是它） */
function makeZip(files, method) {
  const m = method == null ? 0 : method;
  const locals = [], centrals = [];
  let offset = 0;
  for (const name in files) {
    const raw = Buffer.isBuffer(files[name]) ? files[name] : Buffer.from(files[name], 'utf8');
    const data = m === 8 ? zlib.deflateRawSync(raw) : raw;
    const nb = Buffer.from(name, 'utf8');
    const crc = zlib.crc32(raw);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0, 6); lh.writeUInt16LE(m, 8);
    lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0, 12); lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(nb.length, 26); lh.writeUInt16LE(0, 28);
    locals.push(lh, nb, data);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0, 8); ch.writeUInt16LE(m, 10);
    ch.writeUInt16LE(0, 12); ch.writeUInt16LE(0, 14); ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(raw.length, 24);
    ch.writeUInt16LE(nb.length, 28); ch.writeUInt16LE(0, 30); ch.writeUInt16LE(0, 32);
    ch.writeUInt16LE(0, 34); ch.writeUInt16LE(0, 36); ch.writeUInt32LE(0, 38);
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, nb);
    offset += 30 + nb.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const eo = Buffer.alloc(22);
  eo.writeUInt32LE(0x06054b50, 0);
  eo.writeUInt16LE(0, 4); eo.writeUInt16LE(0, 6);
  eo.writeUInt16LE(Object.keys(files).length, 8); eo.writeUInt16LE(Object.keys(files).length, 10);
  eo.writeUInt32LE(cd.length, 12); eo.writeUInt32LE(offset, 16); eo.writeUInt16LE(0, 20);
  return Buffer.concat([Buffer.concat(locals), cd, eo]);
}

const DOCX_XML = '<?xml version="1.0"?><w:document><w:body>'
  + '<w:p><w:t>一、分数乘法应用题</w:t></w:p>'
  + '<w:p><w:t>1. 一根绳子长 3/4 米，用去了 2/3，用去了多少米？求一个数的几分之几，用乘法。</w:t></w:p>'
  + '<w:p><w:t>2. 已知一个数的几分之几是多少，求这个数，用除法。</w:t></w:p>'
  + '</w:body></w:document>';
const DOCX = makeZip({ '[Content_Types].xml': '<Types/>', 'word/document.xml': DOCX_XML }, 8);
const XLSX = makeZip({ '[Content_Types].xml': '<Types/>', 'xl/worksheets/sheet1.xml': '<sheetData/>' }, 8);
const PPTX = makeZip({ '[Content_Types].xml': '<Types/>', 'ppt/slides/slide1.xml': '<a:t>分数的意义</a:t>' }, 8);
const OLE = Buffer.concat([Buffer.from([0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1]), Buffer.alloc(24)]);
const REALLY_BINARY = Buffer.from([0, 1, 2, 3, 255, 254, 0, 9, 7, 6, 5, 4, 3, 2, 1, 0, 200, 201, 202]);

console.log('\n批次18（粘贴的文档能不能读）：');

// ---------- 1) 类型嗅探 ----------
eq(extract.sniffType(DOCX), 'docx', 'ZIP 里有 word/ ⇒ docx');
eq(extract.sniffType(XLSX), 'xlsx', 'ZIP 里有 xl/ ⇒ xlsx');
eq(extract.sniffType(PPTX), 'pptx', 'ZIP 里有 ppt/ ⇒ pptx');
eq(extract.sniffType(Buffer.from('%PDF-1.7\n%%EOF')), 'pdf', 'PDF 魔数');
eq(extract.sniffType(Buffer.from('{\\rtf1\\ansi hello}')), 'rtf', 'RTF 头');
eq(extract.sniffType(OLE), 'ole', 'OLE 复合文档（旧版 .doc/.xls/.ppt）');
eq(extract.sniffType(REALLY_BINARY), '', '认不出来就返回空串 —— 不硬猜');
eq(extract.sniffType(Buffer.alloc(0)), '', '空 buffer 不崩');
eq(extract.sniffType(null), '', 'null 不崩');

// ---------- 2) 解析：假名也能读 + 真二进制如实失败 ----------
const rBin = extract.extract(DOCX, '粘贴的文件.bin');
ok(rBin.ok && has(rBin.text, '分数乘法应用题'),
  '★ .bin 假名 + docx 字节要能读出来（本次要修的头号问题）', rBin.kind + '/ok=' + rBin.ok);
eq(rBin.kind, 'docx', '.bin 被按字节纠正成 docx');

const rTxt = extract.extract(Buffer.from('作业：P12 第1-5题，先做分数乘法，再做分数除法，最后订正总结。', 'utf8'), '粘贴的文件.bin');
ok(rTxt.ok && has(rTxt.text, '先做分数乘法'),
  '★ .bin 假名 + 纯文本要按文本收下（很多"粘贴的文件"其实就是文本）', rTxt.kind);

const rBad = extract.extract(REALLY_BINARY, '粘贴的文件.bin');
ok(!rBad.ok && !!rBad.note, '★ 真二进制必须如实失败，绝不返回乱码冒充成功', rBad.kind + '/ok=' + rBad.ok);
eq(rBad.text, '', '失败时正文必须是空的');
ok(has(rBad.note, '＋'), '失败提示要给出路（用「＋」重选原文件）', rBad.note);

const rOle = extract.extract(OLE, '旧卷子.doc');
ok(!rOle.ok && has(rOle.note, '另存为'), '旧版 .doc 如实说明并指路（另存为 .docx）', rOle.note);

// 原有路径不能被改坏
const rDocx = extract.extract(DOCX, '分数应用题.docx');
ok(rDocx.ok && has(rDocx.text, '用去了多少米'), '原有 .docx 真名路径不变');
const rPlain = extract.extract(Buffer.from('光合作用是绿色植物利用光能，把二氧化碳和水转化成有机物的过程。', 'utf8'), 'a.txt');
ok(rPlain.ok && has(rPlain.text, '光合作用'), '原有 .txt 路径不变');
const rXlsx = extract.extract(XLSX, '粘贴的文件.bin');
ok(rXlsx.ok && has(rXlsx.text, '工作表'), '.bin 假名 + xlsx 字节也能读', rXlsx.text.slice(0, 12));

// ---------- 2.5) 文件名纠正：占位名按真实类型纠回来 ----------
// 用户报的第 2 件事：资料条上写着「粘贴的文件.bin」，可它其实是 docx。
// 服务端早就认出来了（r.kind），只是拿到后**丢掉了**，没用来纠正文件名。
// 触发条件刻意保守 —— 只碰"没有扩展名 / 扩展名不认识"的占位名。
eq(kb.alignName('粘贴的文件.bin', { kind: 'docx' }), '粘贴的文件.docx', '★ .bin + docx ⇒ 纠成 .docx（本次要修的观感问题）');
eq(kb.alignName('粘贴的文件.bin', { kind: 'pdf' }), '粘贴的文件.pdf', '.bin + pdf ⇒ .pdf');
eq(kb.alignName('粘贴的文件.bin', { kind: 'text' }), '粘贴的文件.txt', '.bin + 纯文本 ⇒ .txt');
eq(kb.alignName('粘贴的文件.bin', { kind: 'xlsx' }), '粘贴的文件.xlsx', '.bin + xlsx ⇒ .xlsx');
eq(kb.alignName('作业', { kind: 'text' }), '作业.txt', '压根没扩展名 ⇒ 补一个');
eq(kb.alignName('粘贴的文件.BIN', { kind: 'docx' }), '粘贴的文件.docx', '大写占位名同理');
eq(kb.alignName('', { kind: 'docx' }), '未命名.docx', '空名 ⇒ 兜一个「未命名」（不产出光秃秃的 .docx）');

// 保守边界：不碰用户自己写的合法扩展名
eq(kb.alignName('分数应用题.docx', { kind: 'docx' }), '分数应用题.docx', '真名 .docx ⇒ 原样不动');
eq(kb.alignName('笔记.md', { kind: 'text' }), '笔记.md', '★ 用户写的 .md 不许被改成 .txt（他给的名字要尊重）');
eq(kb.alignName('作业.pdf', { kind: 'docx' }), '作业.pdf', '★ 名字与内容冲突也不改 —— 改了像"我传的 pdf 怎么变 docx 了"');

// 认不出类型时保持原名，别乱猜
eq(kb.alignName('粘贴的文件.bin', { kind: 'ole' }), '粘贴的文件.bin', '★ OLE 可能是旧 doc/xls/ppt，猜错不如保持原名');
eq(kb.alignName('粘贴的文件.bin', { kind: 'unknown' }), '粘贴的文件.bin', 'unknown ⇒ 原名');
eq(kb.alignName('粘贴的文件.bin', null), '粘贴的文件.bin', '没给解析结果 ⇒ 原名（不崩）');
eq(kb.alignName('粘贴的文件.bin', {}), '粘贴的文件.bin', '空对象 ⇒ 原名（不崩）');

// 光纯函数对不算数 —— 走完整入库路径验一遍接线
const e2e = kb.addDocument('9001', null, {
  filename: '粘贴的文件.bin', dataBase64: DOCX.toString('base64'),
  conversationId: 'conv_name', scope: 'temp',
});
eq(e2e.filename, '粘贴的文件.docx', '★ 走完 addDocument 也纠正了（改了纯函数没接线就等于没改）');
eq(e2e.status, 'ready', '  并且内容真的解析出来了');
ok(has(e2e.text || '', '分数乘法应用题'), '  正文里有题目内容（名字对了、内容也没丢）');

// ---------- 3) 兜底注入的边界 ----------
const readyDoc = { filename: '分数应用题专项.txt', status: 'ready',
  text: '一、分数乘法应用题\n1. 一根绳子长 3/4 米，用去了 2/3，用去了多少米？求一个数的几分之几，用乘法。' };
const failedDoc = { filename: '扫描卷.pdf', status: 'failed', error: '这份 PDF 用了扫描图片，没抽出文字' };

eq(llm.buildTempDocContext([]), '', '没有临时资料 → 空串');
eq(llm.buildTempDocContext(null), '', 'null → 空串（不崩）');
eq(llm.buildTempDocContext([failedDoc]), '', '全是解析失败的 → 不塞正文（别拿垃圾冒充内容）');

const one = llm.buildTempDocContext([{ filename: '长卷.txt', status: 'ready', text: '题'.repeat(5000) }]);
ok(one.length <= llm.TEMP_DOC_PER_DOC + 200, '单份资料截断在 PER_DOC 以内', one.length);
ok(has(one, '《长卷.txt》'), '带上文件名（好让模型说清引用的是哪一份）');

const many = llm.buildTempDocContext([1, 2, 3, 4, 5, 6].map(i =>
  ({ filename: '第' + i + '份.txt', status: 'ready', text: '内'.repeat(3000) })));
ok(many.length <= llm.TEMP_DOC_BUDGET + 600, '多份时总量封顶在 BUDGET 附近', many.length);
ok(!has(many, 'NaN'), '兜底正文里不含 NaN');

const dirtyOut = (() => {
  try {
    return llm.buildTempDocContext([
      { filename: 'a.txt', status: 'ready', text: 123456 },   // text 不是字符串
      { status: 'ready', text: '没有文件名' },                 // 缺 filename
      null, undefined, 'not-an-object',
      { filename: 'b.txt', status: 'ready' },                 // 没有 text
      { filename: 'c.txt', status: 'ready', text: '' },       // 空 text
      { filename: 'd.txt', status: 'parsing', text: '还没解析完' },
      { filename: 'e.txt', status: 'ready', text: '这一份是正常的' },
    ]);
  } catch (e) { return 'THREW:' + e.message; }
})();
ok(typeof dirtyOut === 'string' && !has(dirtyOut, 'NaN') && !has(dirtyOut, 'THREW'),
  '★ 脏输入不崩、不产生 NaN（`.slice` 打在不字符串上是最难查的那类崩）', dirtyOut);
ok(has(dirtyOut, 'e.txt') && !has(dirtyOut, 'a.txt'), '只收合格的那一份，其余静默跳过');

// ---------- 4) 系统提示词 ----------
ok(!has(llm.buildSystemPrompt({ mode: 'selfstudy' }), '学生这次在对话里上传的资料'),
  '没有临时资料时不该凭空冒出清单段');

const s1 = llm.buildSystemPrompt({ mode: 'selfstudy', tempDocs: [readyDoc] });
ok(has(s1, '学生这次在对话里上传的资料'), '★ 有资料 → 出现「上传的资料」清单段');
ok(has(s1, '分数应用题专项.txt'), '清单里点到文件名的份');
ok(has(s1, '他上传资料的正文开头'), '★ 检索为空时兜底注入正文');
ok(has(s1, '用去了多少米'), '★ 注入的正文里真的有题目内容');
ok(has(s1, '不要补出'), '明确禁止补出资料里没有的题目/数字');
ok(!has(s1, 'NaN'), '提示词里不含 NaN');

const s2 = llm.buildSystemPrompt({ mode: 'selfstudy', tempDocs: [readyDoc], docContext: '[资料1]《x》第 1 段：…' });
ok(!has(s2, '他上传资料的正文开头'), '检索有命中时不重复塞正文（省 token）');
ok(has(s2, '学生这次在对话里上传的资料'), '但清单段照旧带上（模型得知道资料存在）');

const s3 = llm.buildSystemPrompt({ mode: 'selfstudy', tempDocs: [failedDoc] });
ok(has(s3, '没读出内容'), '★ 解析失败的资料必须如实标注');
ok(has(s3, '不要假装看过'), '★ 并明确禁止假装看过、禁止猜它写了什么');
ok(!has(s3, '他上传资料的正文开头'), '失败的资料不会被当成正文塞进去');

const s4 = llm.buildSystemPrompt({ mode: 'selfstudy', tempDocs: [readyDoc, failedDoc] });
ok(has(s4, '分数应用题专项.txt') && has(s4, '扫描卷.pdf'), '成功的与失败的同时列出（别只报喜）');
ok(!has(s4, 'NaN'), '混合场景提示词里也不含 NaN');

// ---------- 5) 接线 ----------
ok(has(SERVERJS, 'chat.listTempDocs(sid, conv.id)'), '★ server.js 真的取了本对话的临时资料');
ok(has(SERVERJS, 'tempDocs: tempDocs'), '★ 并传给了 buildSystemPrompt（取了不用等于没取）');
ok(has(SERVERJS, "kb.getDocument(sid, d.id)"), '取正文，供检索零命中时兜底');

ok(has(APPJS, "getData('text/plain')"), '★ 粘贴监听会看剪贴板里的文字');
const pasteAt = APPJS.indexOf("addEventListener('paste'");
const seg = APPJS.slice(pasteAt, pasteAt + 2600);
const atPlain = seg.indexOf("getData('text/plain')");
const atPrevent = seg.indexOf('e.preventDefault()');
ok(atPlain > 0, '  └ 守卫真的写在 paste 监听里');
ok(atPrevent > 0 && atPlain < atPrevent, '★ 文字守卫必须排在 e.preventDefault() 之前 —— 顺序反了就白改');
ok(has(seg, '已按文字粘贴'), '  └ 守卫分支给了 toast 提示，不是静默吞掉');

console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
if (fail) { console.log('\n失败清单：'); fails.forEach(f => console.log('  ✗ ' + f)); }

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
process.exit(fail ? 1 : 0);

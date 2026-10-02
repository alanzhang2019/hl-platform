'use strict';
/**
 * 批次21 自检：扫描件 PDF 能不能读？
 *
 * 背景（2026-10-02 用户报障「不能对 PDF 解析吗」）：
 *   用户传的是《数学·六年级·上册》（北师大版，130 页）—— 解剖下来是
 *   **零字体 + 每页一张 JPEG 的纯扫描件**，内容流里只有 `q 725 0 0 1024 0 0 cm /fzImg0 Do Q`。
 *   也就是说：这份文件里**根本没有文字**，任何解析器都抽不出来（grep 出的 "Tj/TJ"
 *   全是 JPEG 二进制里碰巧的字节）。→ 唯一出路是 OCR。
 *
 * 所以这一批做的是：**扫描件不是"解析失败"，是"得换条路"**。
 *   ① 判定：零字体 + 有整页图 = 扫描件，要和"真失败"区分开
 *   ② 抠图：按**页序**把每页位图取出来（页对象顺序 ≠ 对象号顺序，这条必须验）
 *   ③ 识别：逐页交给视觉模型，并发有上限、单页有超时、失败要重试、结果按页序回填
 *   ④ 异步：上百次调用几分钟起步，必须走 jobs 表；进度要真写库
 *   ⑤ ★不死锁：任务被清掉后，文档不能永远停在"识别中"（用户既没进度也没法重试）
 *   ⑥ 说人话：用不了 OCR 时明说原因，不让他干等
 *
 * 不起服务、不连外网（视觉接口用假 fetch 顶替）。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const zlib = require('zlib');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hl-p21-'));
process.env.DATA_DIR = TMP;
process.env.NO_DOTENV = '1';
delete process.env.LLM_API_KEY;
delete process.env.LLM_BASE_URL;
delete process.env.OCR_DISABLED;
delete process.env.OCR_MAX_PAGES;
delete process.env.OCR_CONCURRENCY;
delete process.env.ADMIN_PASSWORD;

const extract = require('./server/extract');
const ocr = require('./server/ocr');
const kb = require('./server/kb');
const chat = require('./server/chat');
const llm = require('./server/llm');
const db = require('./server/db');
const APPJS = fs.readFileSync(path.join(__dirname, 'public/js/app.js'), 'utf8');
const APPCSS = fs.readFileSync(path.join(__dirname, 'public/app.css'), 'utf8');

let pass = 0, fail = 0;
const fails = [];
function ok(cond, name, extra) {
  if (cond) { pass++; }
  else { fail++; fails.push(name + (extra !== undefined ? ' → ' + JSON.stringify(extra) : '')); }
}
function eq(got, want, name) { ok(got === want, name, 'got=' + JSON.stringify(got) + ' want=' + JSON.stringify(want)); }
function has(s, sub) { return String(s).indexOf(sub) >= 0; }

// ---------- 夹具：手拼 PDF ----------
/** 1x1 的合法 JPEG —— 抠图断言要验魔数，所以不能拿随便的字节糊 */
const TINY_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwc' +
  'KDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAA' +
  'AAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==', 'base64');

/** 有文字层的 PDF（老契约：这条路径不能被扫描件逻辑带坏） */
function pdfWithText(lines) {
  const content = 'BT /F1 12 Tf 72 720 Td\n' +
    lines.map(l => {
      let s = '';
      if (/^[\x20-\x7e]*$/.test(l)) s = '(' + l.replace(/([\\()])/g, '\\$1') + ')';
      else { let hex = 'FEFF'; for (const ch of l) hex += ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0'); s = '<' + hex + '>'; }
      return s + ' Tj ET\nBT /F1 12 Tf 72 700 Td';
    }).join('\n') + ' ET\n';
  return Buffer.from(
    '%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n' +
    '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n' +
    '3 0 obj << /Type /Page /Parent 2 0 R /Contents 4 0 R >> endobj\n' +
    '4 0 obj << /Length ' + Buffer.byteLength(content, 'latin1') + ' >>\nstream\n' + content +
    '\nendstream\nendobj\ntrailer << /Root 1 0 R >>\n%%EOF\n', 'latin1');
}

/**
 * 扫描件 PDF：每页一张 JPEG，零字体。
 * 刻意做得比真实情况更"刁"——三页用了三种不同的 Resources 写法：
 *   第 1 页：内联 Resources + 内联 XObject
 *   第 2 页：Resources 走间接引用，且内容流是 FlateDecode 压缩的
 *   第 3 页：内联 Resources，但图片对象号比第 2 页的**小**
 * 这样能验出"按页序"而不是"按对象号顺序"。
 */
function scannedPdf() {
  const jpeg = TINY_JPEG;
  const img = n => '<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB' +
    ' /BitsPerComponent 8 /Filter /DCTDecode /Length ' + jpeg.length + ' >>\nstream\n' + jpeg.toString('latin1') + '\nendstream\n';
  const cRaw = 'q 300 0 0 400 0 0 cm /Im0 Do Q';
  const c2 = zlib.deflateSync(Buffer.from('q 300 0 0 400 0 0 cm /ImX Do Q', 'latin1'));
  const c3 = 'q 300 0 0 400 0 0 cm /Im2 Do Q';
  const parts = [
    '%PDF-1.4\n',
    '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n',
    '2 0 obj << /Type /Pages /Kids [3 0 R 4 0 R 5 0 R] /Count 3 >> endobj\n',
    '3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Resources << /XObject << /Im0 6 0 R >> >> /Contents 7 0 R >> endobj\n',
    '4 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Resources 8 0 R /Contents 9 0 R >> endobj\n',
    '5 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Resources << /XObject << /Im2 10 0 R >> >> /Contents 11 0 R >> endobj\n',
    '6 0 obj ' + img() + 'endobj\n',           // 第 1 页的图
    '7 0 obj << /Length ' + cRaw.length + ' >>\nstream\n' + cRaw + '\nendstream\nendobj\n',
    '8 0 obj << /XObject << /ImX 12 0 R >> >> endobj\n',   // 间接 Resources
    '9 0 obj << /Length ' + c2.length + ' /Filter /FlateDecode >>\nstream\n' + c2.toString('latin1') + '\nendstream\nendobj\n',
    '10 0 obj ' + img() + 'endobj\n',          // 第 3 页的图（对象号更小）
    '11 0 obj << /Length ' + c3.length + ' >>\nstream\n' + c3 + '\nendstream\nendobj\n',
    '12 0 obj ' + img() + 'endobj\n',          // 第 2 页的图（对象号最大）
    'trailer << /Root 1 0 R >>\n%%EOF\n',
  ];
  return Buffer.from(parts.join(''), 'latin1');
}

async function main() {
console.log('批次21（扫描件 PDF 能不能读）：\n');

// ================= 1) 判定：扫描件 ≠ 失败 =================
{
  const real = scannedPdf();
  const info = extract.pdfInfo(real);
  eq(info.fonts, 0, '① 合成扫描件：零字体');
  eq(info.images, 3, '  └ 三张页图');
  eq(info.pages, 3, '  └ 三页');
  const r = extract.extract(real, '数学 · 六年级 · 上册.pdf');
  eq(r.scanned, true, '★ 零字体 + 有整页图 → 判定为扫描件');
  eq(r.ok, false, '  └ 它确实抽不出文字（ok=false 不能改，否则等于假装成功）');
  ok(has(r.note, '扫描件'), '  └ 说明里明说是扫描件，不说"解析失败"');

  // 有文字层的 PDF 不能被误判成扫描件
  const txt = pdfWithText(['分数的混合运算：先乘除后加减。']);
  const rt = extract.extract(txt, '讲义.pdf');
  eq(rt.ok, true, '② 有文字层的 PDF 照旧读出文字');
  eq(rt.scanned, false, '  └ 不许误判成扫描件');
  ok(has(rt.text, '分数'), '  └ 正文内容正确');

  // 老契约：没字也没图的 PDF 仍然是 failed（不是扫描件 —— 没有图可识别）
  const empty = pdfWithText([]);
  const re = extract.extract(empty, '扫描.pdf');
  eq(re.ok, false, '③ 无字无图的 PDF 仍然失败（保住既有契约）');
  eq(re.scanned, false, '  └ 且不被判成扫描件（没有图可 OCR，硬判会排一个永远干不完的任务）');
}

// ================= 2) 抠图：页序 =================
{
  const imgs = extract.pdfPageImages(scannedPdf());
  eq(imgs.length, 3, '④ 三个页面各抠出一张图');
  eq(imgs.map(i => i.page).join(','), '1,2,3', '  └ 页码从 1 连续编号');
  // ★ 关键：按页序而不是对象号 —— 第 2 页的图是 obj12，比第 3 页的 obj10 大
  eq(imgs.map(i => i.objNum).join(','), '6,12,10', '★ 必须按页序取图（对象号顺序是 6,10,12，会串页）');
  ok(imgs.every(i => i.data[0] === 0xFF && i.data[1] === 0xD8), '  └ 取到的是真 JPEG（魔数 FF D8）');
  ok(imgs.every(i => i.filter === 'DCTDecode'), '  └ 过滤类型识别正确');
  ok(imgs.every(i => i.width === 1 && i.height === 1), '  └ 尺寸从图字典读出来');

  // 间接 Resources + FlateDecode 内容流都要认（第 2 页）
  eq(imgs[1].objNum, 12, '  └ 间接 Resources 引用认得（第 2 页）');
  eq(imgs[2].objNum, 10, '  └ 压缩内容流认得（第 3 页对象号更小，仍排在第 3）');

  // 脏输入
  eq(extract.pdfPageImages(Buffer.alloc(0)).length, 0, '⑤ 空 buffer 返回空数组不崩');
  eq(extract.pdfPageImages(Buffer.from('这根本不是 PDF')).length, 0, '  └ 非 PDF 返回空数组不崩');
  eq(extract.pdfPageImages(Buffer.from('%PDF-1.4 没有任何对象')).length, 0, '  └ 无对象返回空数组');
}

// ================= 3) OCR 模块 =================
{
  const cfgOff = ocr.ocrConfig();
  eq(cfgOff.enabled, false, '⑥ 没配 Key → OCR 判定为不可用（不能排一个永远等不到结果的任务）');
  ok(cfgOff.model.length > 0, '  └ 默认模型名非空');

  process.env.LLM_API_KEY = 'test-key';
  process.env.LLM_BASE_URL = 'https://fake.local/v1';
  const cfgOn = ocr.ocrConfig();
  eq(cfgOn.enabled, true, '⑦ 配齐 Key + BaseURL → 可用');
  eq(cfgOn.base, 'https://fake.local/v1', '  └ BaseURL 末尾斜杠被规范掉');
  process.env.OCR_CONCURRENCY = '99';
  eq(ocr.ocrConfig().concurrency, 6, '★ 并发上限被夹到 6（防止一本书把连接和额度一起吃光）');
  process.env.OCR_MAX_PAGES = '20';
  eq(ocr.ocrConfig().maxPages, 20, '  └ 页数上限可配');
  delete process.env.OCR_CONCURRENCY;
  delete process.env.OCR_MAX_PAGES;

  eq(ocr.cleanPageText('```text\n好的，以下是转写内容：\n分数除法\n```'), '分数除法', '⑧ 清洗：剥 markdown 围栏与客套话');
  eq(ocr.cleanPageText('本页无文字'), '', '  └ 纯插图页返回空串（不写进正文冒充内容）');
  eq(ocr.cleanPageText(null), '', '  └ 脏输入不崩');
  eq(ocr.assembleOcrText(['甲', '', '乙']), '【第 1 页】\n甲\n\n【第 3 页】\n乙', '⑨ 拼接带页码标记、跳过空页');
  eq(ocr.assembleOcrText(null), '', '  └ 脏输入不崩');
  ok(has(ocr.PAGE_PROMPT, '逐字转写'), '⑩ 提示词要求逐字转写');
  ok(has(ocr.PAGE_PROMPT, '不要总结'), '  └ 明确禁止总结（这是教材原文，总结会失真）');
  ok(has(ocr.OCR_DISABLED_NOTE, '没有可用的模型配置'), '  └ 用不了 OCR 时给的是实话，不是"解析失败"');

  // ★ 限速器是**进程级共享**的：不重置的话，某个用例被限流降过速会拖死后面所有用例的等待预算
  //   （这正是加了限速后本套件从 87/0 变成 81/6 的原因 —— 不是功能坏了，是等不起）。
  //   测试验的是逻辑不是线上速率，所以把基准调到 100ms 级；生产默认速率由单独一条断言锁住。
  eq(ocr.DEFAULT_RPM, 10, '★ 生产默认 ' + ocr.DEFAULT_RPM + ' RPM（并发 3 不限速时 130 页烂掉 122 页，默认值不许再调激进）');
  ok(ocr.DEFAULT_CONCURRENCY <= 2, '  └ 默认并发也被压在 2 以内');
  process.env.OCR_RPM = '600';
  ocr.resetPacer(600);
  eq(ocr.pacerInfo().intervalMs, 100, '★ resetPacer 后限速基准由 OCR_RPM 决定（600 RPM → 100ms）');

  // 并发与页序：用假 fetch 顶替视觉接口
  const seen = [];
  let inflight = 0, maxInflight = 0;
  global.fetch = async (url, opt) => {
    const body = JSON.parse(opt.body);
    const img = body.messages[0].content[0].image_url.url;
    inflight++; maxInflight = Math.max(maxInflight, inflight);
    await new Promise(r => setTimeout(r, 15));
    inflight--;
    seen.push(img);
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '第 ' + seen.length + ' 页' } }] }), text: async () => '' };
  };
  const many = Array.from({ length: 8 }, (_, i) => ({ page: i + 1, data: Buffer.from('img' + i) }));
  const res = await ocr.ocrImages(many, { concurrency: 3 });
  eq(res.total, 8, '⑪ 8 页全部处理');
  eq(res.done, 8, '  └ done 计数正确');
  eq(res.failed.length, 0, '  └ 无失败页');
  ok(maxInflight <= 3, '★ 并发真的受控（实测峰值 ' + maxInflight + ' ≤ 3）');
  eq(res.pages.length, 8, '  └ 结果数组长度对齐');
  ok(res.pages.every(p => /^第 \d+ 页$/.test(p)), '  └ 每页都有结果');
  eq(ocr.assembleOcrText(res.pages).indexOf('【第 1 页】'), 0, '  └ 结果按页序回填（并发不会打乱顺序）');

  // 失败要重试一次；两次都失败要如实记录，不能静默成空串
  let calls = 0;
  global.fetch = async () => {
    calls++;
    if (calls === 1) return { ok: false, status: 502, json: async () => ({}), text: async () => 'upstream_error' };
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '好了' } }] }), text: async () => '' };
  };
  const r2 = await ocr.ocrImages([{ page: 1, data: Buffer.from('a') }, { page: 2, data: Buffer.from('b') }], { concurrency: 1 });
  eq(r2.failed.length, 0, '⑬ 502 抖动后重试能救回来（第 1 页第 2 次成功）');
  ok(calls >= 3, '  └ 确实重试过而不是直接跳过（调用 ' + calls + ' 次）');

  let calls2 = 0;
  global.fetch = async () => { calls2++; return { ok: false, status: 502, json: async () => ({}), text: async () => 'boom' }; };
  const r3 = await ocr.ocrImages([{ page: 1, data: Buffer.from('a') }], { concurrency: 1 });
  eq(r3.failed.length, 1, '★ 重试仍失败 → 记进 failed（不能静默变成"这页没有内容"）');
  eq(r3.pages[0], '', '  └ 该页文本为空');
  ok(calls2 >= 2, '  └ 确实重试过（调用了 ' + calls2 + ' 次）');
}

// ============ 3b) 限流（429）—— parity21 真书实拍暴露的那条路径 ============
// 2026-10-02 拿一本 130 页的扫描教材真跑：**122 页烂掉**，全是 HTTP 429。
// 当时的代码把 429 当成普通错误、退避 800ms，等于睡醒又撞同一堵墙。
// 这一节就是钉住修复：必须单独分类、必须**整体降速**（不是这一页自己重试）、
// 必须有天花板、顺畅了要能恢复。
{
  process.env.LLM_API_KEY = 'test-key';
  process.env.LLM_BASE_URL = 'https://fake.local/v1';
  process.env.OCR_RPM = '600';
  process.env.OCR_RATE_RETRIES = '3';          // 只跑 3 次重试，否则这条用例要等半分钟
  ocr.resetPacer(600);

  const rate429 = () => ({ ok: false, status: 429, json: async () => ({}), text: async () => 'rate limit reached for RPM' });
  const pass = () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '好' } }] }), text: async () => '' });

  // 429 单独分类 + 整体降速
  let n429 = 0;
  let inflightPeak = 0, inflight = 0;
  global.fetch = async () => {
    n429++; inflight++; inflightPeak = Math.max(inflightPeak, inflight);
    await new Promise(r => setTimeout(r, 5));
    inflight--;
    return rate429();
  };
  const before = ocr.pacerInfo().intervalMs;
  const rr = await ocr.ocrImages([{ page: 1, data: Buffer.from('a') }], { concurrency: 1 });
  eq(rr.failed.length, 1, '⑫ 一直 429 → 如实记进 failed（不假装识别成功）');
  eq(rr.failed[0].reason, 'RATE_LIMIT', '★ 失败原因标成 RATE_LIMIT，不是笼统的"识别失败"（否则没法判断该不该重来）');
  eq(n429, 3, '★ 限流重试到 OCR_RATE_RETRIES 次才放弃（普通错误只重试 1 次）');
  const after = ocr.pacerInfo();
  ok(after.throttled >= 3, '★ 每次 429 都触发了**整体降速**（累计 ' + after.throttled + ' 次）—— 只重试不降速就是继续撞墙');
  ok(after.intervalMs > before, '★ 全局间隔真的被拉长（' + before + 'ms → ' + after.intervalMs + 'ms）');
  ok(inflightPeak === 1, '  └ 重试也没有偷偷把并发打上去');

  // 天花板：否则连续限流会把间隔指数级推高，一本书跑成十几个小时
  for (let i = 0; i < 40; i++) ocr.slowDown();
  eq(ocr.pacerInfo().intervalMs, ocr.MAX_INTERVAL_MS, '★ 连续降速封顶在 ' + ocr.MAX_INTERVAL_MS + 'ms（不封顶会把书跑成十几个小时）');
  ok(ocr.pacerInfo().throttled >= 40, '  └ 限流次数被记下来，线上能看出"这本书一直在被限流"（' + ocr.pacerInfo().throttled + ' 次）');

  // 恢复：没有这一步，一次限流会让服务此后一直用最慢速度跑到重启
  const slowest = ocr.pacerInfo().intervalMs;
  global.fetch = async () => pass();
  const r2 = await ocr.ocrImages([{ page: 1, data: Buffer.from('a') }], { concurrency: 1 });
  eq(r2.failed.length, 0, '  └ 限流缓解后能正常识别');
  const faster = ocr.pacerInfo().intervalMs;
  ok(faster < slowest, '★ 顺畅后间隔缓慢收窄（' + slowest + 'ms → ' + faster + 'ms），不是一直卡在最慢');

  // 恢复要**有下限**（不能一路退回"随便打"），也不能高于还在生效的配置基准。
  // 这里把间隔人为推到降速区间再连打，而不是拿刚触顶的 12s 去跑 —— 那要白等 69 秒。
  ocr.resetPacer(600);
  ocr.slowDown(); ocr.slowDown();
  const pre = ocr.pacerInfo().intervalMs;
  const r3 = await ocr.ocrImages(Array.from({ length: 6 }, (_, i) => ({ page: i + 1, data: Buffer.from('p' + i) })), { concurrency: 2 });
  eq(r3.failed.length, 0, '  └ 连续成功不再掉页');
  const settled = ocr.pacerInfo().intervalMs;
  ok(settled < pre, '★ 顺畅后间隔从 ' + pre + 'ms 收窄到 ' + settled + 'ms（不是一直卡在降速区间）');
  ok(settled >= ocr.pacerInfo().baseIntervalMs, '★ 收窄的底线是配置基准 ' + ocr.pacerInfo().baseIntervalMs + 'ms，不会比配置更激进');

  delete process.env.OCR_RATE_RETRIES;
  delete process.env.OCR_RPM;
  ocr.resetPacer(ocr.DEFAULT_RPM);
  eq(ocr.pacerInfo().intervalMs, Math.round(60000 / ocr.DEFAULT_RPM), '★ 重置后回到生产默认速率（测试之间必须隔离限速器）');
}

// ===== 3c) 聊天链路的 429 韧性（扫描件识别会长时间占用同一配额） =====
// 识别一本 130 页的书要十几分钟，用的是**和聊天同一个 Key、同一个账号级配额** ——
// 学生在这期间提问就是会被限流。这里锁住"等一等自动重发"，而不是把 429 甩到脸上。
{
  const savedFetch = global.fetch;
  let calls = 0;
  const r429 = () => ({ ok: false, status: 429, headers: { get: () => null }, json: async () => ({}), text: async () => 'rate limit reached for RPM' });
  const rOk = () => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ ok: 1 }), text: async () => '' });

  global.fetch = async () => { calls++; return calls === 1 ? r429() : rOk(); };
  const r1 = await llm.fetchWithRetry('https://fake.local/v1/chat/completions', {});
  eq(r1.status, 200, '⑬ ★ 遇到 429 自动重发（学生看到的是"稍等一下"，不是"AI 出错了"）');
  eq(calls, 2, '  └ 确实重发了一次');

  calls = 0;
  global.fetch = async () => { calls++; return r429(); };
  const r2 = await llm.fetchWithRetry('https://fake.local/v1/chat/completions', {}, 2);
  eq(calls, 2, '★ 一直 429 时重试次数受控（不无限打，也不把请求堆成雪崩）');
  eq(r2.status, 429, '  └ 重试完仍失败就如实返回 429，不吞掉、不伪造成成功');

  calls = 0;
  global.fetch = async () => { calls++; return { ok: false, status: 500, headers: { get: () => null }, json: async () => ({}), text: async () => 'boom' }; };
  await llm.fetchWithRetry('https://fake.local/v1/chat/completions', {}, 3);
  eq(calls, 1, '★ 非 429 一律不重试（否则会把真实错误伪装成"慢"，排查时更难）');

  calls = 0;
  global.fetch = async () => {
    calls++;
    return calls === 1
      ? { ok: false, status: 429, headers: { get: (k) => (String(k).toLowerCase() === 'retry-after' ? '0.001' : null) }, json: async () => ({}), text: async () => '' }
      : rOk();
  };
  const t0 = Date.now();
  await llm.fetchWithRetry('https://fake.local/v1/chat/completions', {});
  ok(Date.now() - t0 < 1500, '  └ 上游给了 Retry-After 就听上游的，不硬等自己的退避（' + (Date.now() - t0) + 'ms）');

  global.fetch = savedFetch;
}

// ================= 4) 端到端：入库 → 排队 → 识别 → 就绪 =================
{
  const SID = 'sp_p21';
  db.run('INSERT INTO spaces(id,name,name_key,created_at) VALUES(?,?,?,?)', SID, '扫描件测试', '扫描件测试', db.now());
  process.env.LLM_API_KEY = 'test-key';
  process.env.LLM_BASE_URL = 'https://fake.local/v1';
  // 端到端也按 100ms/次跑：验的是"入库→排队→识别→就绪"这条链路，
  // 不是线上速率（线上 10 RPM 已被上面的默认值断言锁住）。等待预算给足，机器忙时不至于假红。
  process.env.OCR_RPM = '600';
  ocr.resetPacer(600);

  let usedModel = '';
  global.fetch = async (url, opt) => {
    const body = JSON.parse(opt.body);
    usedModel = body.model;
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '分数的混合运算：先算乘除，再算加减。' } }] }), text: async () => '' };
  };

  const doc = chat.saveDocument(SID, null, { filename: '数学 · 六年级 · 上册.pdf', dataBase64: scannedPdf().toString('base64') });
  eq(doc.status, 'parsing', '⑭ 扫描件入库后是 parsing（不是 failed —— 文件是好的）');
  ok(!!doc.jobId, '★ 自动排了一个识别任务（用户不用点任何按钮）');
  eq(doc.state, 'parsing', '  └ 前端三态为 parsing');

  const job = chat.getJob(SID, doc.jobId);
  eq(job.kind, 'ocr', '  └ 任务类型是 ocr');

  // 让 worker 自己把任务跑完（不发 manual 调用，验的是真实调度路径）
  const t0 = Date.now();
  let j = job;
  while (j && j.status !== 'done' && j.status !== 'failed' && Date.now() - t0 < 15000) {
    await new Promise(r => setTimeout(r, 60));
    j = chat.getJob(SID, doc.jobId);
  }
  eq(j.status, 'done', '⑮ 任务跑完（走的是 worker 调度，不是手调）');
  const after = kb.getDocument(SID, doc.id, true);
  eq(after.status, 'ready', '★ 识别完成后资料变成「已就绪」');
  eq(after.progress, 100, '  └ 进度归位 100');
  eq(after.pages, 3, '  └ 页数记录下来');
  ok(has(after.text, '【第 1 页】'), '★ 正文按页写进去了，带页码标记（AI 才能引用"第几页"）');
  ok(has(after.text, '分数的混合运算'), '  └ 识别内容真的进了库');
  eq(after.error, null, '  └ 全部成功时不写错误（不留无用的警告）');

  // 列表接口要能把它算作已就绪
  const listed = kb.listDocuments(SID).filter(d => d.id === doc.id)[0];
  eq(listed.state, 'ready', '  └ 列表里状态是 ready');

  // ★ 不死锁：任务被清掉后，文档不能永远停在"识别中"
  db.run("UPDATE kb_documents SET status = 'parsing', progress = 40 WHERE id = ?", doc.id);
  db.run('DELETE FROM jobs WHERE doc_id = ?', doc.id);
  await chat.tick();
  const rescued = kb.getDocument(SID, doc.id, false);
  eq(rescued.status, 'failed', '★ 任务没了 → 对账把资料从「识别中」捞出来（否则会永远转圈）');
  ok(has(rescued.error, '重新识别'), '  └ 并且告诉用户怎么补救');

  // 有活任务时不能误伤
  db.run("UPDATE kb_documents SET status = 'parsing' WHERE id = ?", doc.id);
  const keepJob = chat.createJob(SID, null, 'ocr', { docId: doc.id });
  db.run("UPDATE jobs SET doc_id = ? WHERE id = ?", doc.id, keepJob.id);
  await chat.tick();
  eq(kb.getDocument(SID, doc.id, false).status, 'parsing', '  └ 任务还在跑的不许误伤（仍是 parsing）');
  chat.failJob(keepJob.id, '收尾');
  db.run("UPDATE kb_documents SET status = 'failed' WHERE id = ?", doc.id);
}

// ================= 5) 用不了 OCR 时要说实话 =================
{
  const SID = 'sp_p21b';
  db.run('INSERT INTO spaces(id,name,name_key,created_at) VALUES(?,?,?,?)', SID, '无Key测试', '无Key测试', db.now());
  delete process.env.LLM_API_KEY;
  const doc = chat.saveDocument(SID, null, { filename: '扫描的卷子.pdf', dataBase64: scannedPdf().toString('base64') });
  eq(doc.status, 'failed', '⑯ 没有模型配置时**如实报失败**，不排一个等不到结果的任务');
  ok(has(doc.error, '没有可用的模型配置'), '  └ 错误文案说清原因，不说"解析失败"糊弄');
  ok(!doc.jobId, '  └ 没有建任务');
  process.env.LLM_API_KEY = 'test-key';
}

// ================= 6) 前端：进度可见 + 自动刷新 =================
{
  ok(has(APPJS, 'doc-prog'), '⑰ 资料行有识别进度条');
  ok(has(APPJS, "d.state === 'parsing'"), '  └ 识别中时单独渲染');
  ok(has(APPJS, '识别中 '), '  └ 状态标签显示"识别中 N%"');
  ok(has(APPJS, 'function scheduleKbPoll'), '★ 有识别中的资料时会自动轮询刷新（不用用户手点）');
  ok(has(APPJS, 'scheduleKbPoll((S.kbDocs || []).some(d => d.state === \'parsing\'))'), '  └ 且判定条件绑在真实状态上');
  ok(has(APPJS, 'kbPollLeft'), '  └ 轮询有次数上限，不会无限打接口');
  // ★ 上限必须比后端任务上限长。原来按 400 次（20 分钟）封顶，而一本 130 页的书实测要 20 分钟左右
  //   —— 正好卡在识别差不多的时刻，表现是"进度条停住不动"，看着像卡死。这条断言就是钉住这个关系。
  // 取"重填上限"那一处（`kbPollLeft = 0` 是清零，别被它抢先匹配到）
  const pollCapN = Number((/kbPollLeft\s*=\s*(\d{2,})\s*;/.exec(APPJS) || [])[1]);
  const pollCapMin = pollCapN * 3 / 60;
  const ocrMaxMin = chat.JOB_MAX_MS.ocr / 60000;
  ok(pollCapMin > ocrMaxMin, '★ 前端自动刷新窗口（' + pollCapMin + ' 分钟）必须比后端任务上限（' + ocrMaxMin + ' 分钟）长，否则进度条会停在半路');
  ok(has(APPJS, 'const tdSleep'), '★ 临时资料轮询改为按时间给截止（原来连打 40 次，对几分钟的识别根本不够）');
  ok(!has(APPJS, 'if (k > 40) return;'), '  └ 旧的"连打 40 次"写法已移除');
  ok(has(APPCSS, '.doc-i .doc-prog'), '  └ 进度条样式在 CSS 里');
  ok(has(APPCSS, '.doc-i .doc-prog-t'), '  └ 进度文案样式在 CSS 里');
  ok(has(APPJS, "d.kind === 'pdf' ? '重新识别' : '重新解析'"), '  └ PDF 的失败按钮叫「重新识别」，措辞对得上');
}

// ================= 7) 接线：服务端真的把扫描件交给了 OCR =================
{
  const SERVERJS = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  ok(has(SERVERJS, 'chat.startWorker()'), '⑱ 服务端启动了任务 worker（否则排了队也没人跑）');
  const CHATJS = fs.readFileSync(path.join(__dirname, 'server/chat.js'), 'utf8');
  ok(has(CHATJS, "registerRunner('ocr'"), '  └ ocr runner 已注册');
  ok(has(CHATJS, 'reconcileOcrDocs'), '  └ 有"识别中却没有活任务"的对账');
  ok(has(CHATJS, "JOB_MAX_MS") && has(CHATJS, 'ocr: 45 * 60 * 1000'), '  └ OCR 任务给了够用的超时上限');
  const DBJS = fs.readFileSync(path.join(__dirname, 'server/db.js'), 'utf8');
  ok(has(DBJS, "['jobs', 'doc_id', 'TEXT']"), '  └ jobs 加了 doc_id 列（对账要靠它反查）');

  // ★ 这两个是"看着像接线对了、其实没接上"的高危点：
  //   ① 知识库上传路由如果直接调 kb.addDocument（而不是 chat.saveDocument），
  //      文档会被标成 parsing 却没人排队 —— 永远转圈。实测确实写成过 kb.addDocument。
  //   ② 点「重新识别」走的是 /reparse，那条路也得重新排队。
  const kbPost = SERVERJS.slice(SERVERJS.indexOf("p === '/api/kb/documents' && method === 'POST'"));
  const kbPostSeg = kbPost.slice(0, 1400);
  ok(has(kbPostSeg, 'chat.saveDocument'), '★ 知识库上传路由走 chat.saveDocument（直连 kb 就不会排 OCR 任务）');
  ok(!has(kbPostSeg, 'kb.addDocument(sid'), '  └ 不许再出现直连 kb.addDocument（注释里提到不算）');
  ok(has(kbPostSeg, "doc.status === 'failed' ? 422 : 200"), '★ 识别中必须回 200 而不是 422（回 422 前端会当成上传失败）');
  const rp = SERVERJS.slice(SERVERJS.indexOf("act === 'reparse'"));
  ok(has(rp.slice(0, 900), 'queueOcrJob'), '★ 「重新识别」也要重新排队（否则点了只会转圈）');
  ok(has(CHATJS, 'function queueOcrJob'), '  └ 排队逻辑抽成了一个共用函数（两个入口都用它）');
}

console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
if (fail) { console.log('\n失败清单：'); fails.forEach(f => console.log('  ✗ ' + f)); }

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
process.exit(fail ? 1 : 0);
}

main().catch(e => {
  console.error('批次21 自检异常：', (e && e.stack) || e);
  process.exit(1);
});

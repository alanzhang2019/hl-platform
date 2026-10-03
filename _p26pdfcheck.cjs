'use strict';
/**
 * 批次26 自检：**内嵌子集字体**的中文 PDF 能不能读出文字？
 *
 * 背景（2026-10-03 用户报障「这个 PDF 识别的问题之前是不是解决过？」）：
 *   用户传的 AI-report.pdf 报「用了内嵌子集字体，没能抽出可用的文字」。
 *   这**不是**批次21 那个问题 —— 批次21 处理的是"扫描件"（零字体 + 整页图 → OCR）；
 *   这一份是**有字体、有文字层**，但字体是 **CID 子集**（Identity-H），
 *   内容流里写的是 **CID（字形序号）不是 Unicode**。
 *
 * 病根：`textFromContentStream` 原来对 `<hex>` 只会
 *   `String.fromCharCode(cid)` —— 那得到的是乱码，`looksLikeText` 判不过，
 *   于是整份 PDF 被当成"读不出来"。而正确答案就写在字体字典的 /ToUnicode 里，
 *   原来一行都没读。
 *
 * 这一批做三件事：
 *   ① **读 /ToUnicode CMap**：bfchar / bfrange（含 [] 数组目标、多字节目标），
 *      把 CID 映回真字符。这是"能不能读中文 PDF"的关键。
 *   ② **FlateDecode 是 zlib 不是 gzip**：CMap 流解不开就等于没读（第一版就踩了，
 *      只认 0x1f8b 的解压器解不了 0x78 开头的 zlib 流）。
 *   ③ **三种"读不出"要分清**，且都以 `scanned` 作为"排队 OCR"的信号：
 *      零字体+有图 / 有字体+无ToUnicode+有图 / 有字体+有ToUnicode但抽不出+有图。
 *      而**没有图**的才是真死路（如实报错，不许假装成扫描件）。
 *
 * 不起服务、不连外网。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const zlib = require('zlib');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hl-p26pdf-'));
process.env.DATA_DIR = TMP;
process.env.NO_DOTENV = '1';

const extract = require('./server/extract');

let pass = 0, fail = 0;
const fails = [];
function ok(cond, name, extra) {
  if (cond) { pass++; }
  else { fail++; fails.push(name + (extra !== undefined ? ' → ' + JSON.stringify(extra) : '')); }
}
function eq(got, want, name) { ok(got === want, name, 'got=' + JSON.stringify(got) + ' want=' + JSON.stringify(want)); }
function has(s, sub) { return String(s).indexOf(sub) >= 0; }

// ================= 夹具 =================
/** 1x1 的合法 JPEG（抠图/图片计数断言要验魔数） */
const TINY_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwc' +
  'KDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAA' +
  'AAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==', 'base64');

/** 把字符编成 UTF-16BE 十六进制（CMap 目标串的标准写法） */
function utf16beHex(s) {
  let hex = '';
  for (const ch of s) hex += ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0');
  return hex;
}

/**
 * 合成一份「CID 子集字体」PDF。
 * @param {object} o
 *   o.chars    字符数组，生成 CID 1..n → 对应字符
 *   o.text     内容流里要写的文本（按 chars 顺序取 CID）
 *   o.toUnicode  true=带 /ToUnicode，false=不带；'range'=用 bfrange 段
 *   o.image      true=额外挂一张整页图（用来验"有图才能救"）
 *   o.cmapZlib   true=CMap 流用 FlateDecode（默认 true；false 验未压缩也能读）
 */
function subsetFontPdf(o) {
  const opt = o || {};
  const chars = opt.chars || ['你', '好', '世', '界'];
  const ids = chars.map((_, i) => i + 1);
  const hexText = ids.map(i => i.toString(16).toUpperCase().padStart(4, '0')).join('');

  let content = 'BT /F1 12 Tf 72 720 Td\n<' + hexText + '> Tj\nET\n';
  // ★ 再加一段 TJ 数组（带每字间距）——中文 PDF 的真实写法，
  //   也是"抽出来是原始码"那个 bug 的现场（见 D8）。
  content += 'BT /F1 12 Tf 72 700 Td\n[(' + '<' + hexText + '>' + ')] TJ\nET\n';
  let extraObjs = [];
  let nextNum = 6;   // 5 是字体对象

  // ---- ToUnicode CMap ----
  let toUniRef = null;
  if (opt.toUnicode) {
    let cmap = '/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n' +
      '1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n';
    if (opt.toUnicode === 'range') {
      // ★ bfrange 的语义是 **dstStart + k**（spec 原文），不是"每个 CID 各指一个字符"。
      //   所以只有**连续**的 Unicode 才配用纯 range 写法；'你好世界' 不连续，
      //   要用 bfrange 的 **[] 数组形式**（每个目标显式给出）。
      //   夹具造错了会让"解析器正确"看起来像"解析器错了"——A4~A9 已经把两种形式分别钉住。
      const lo = 1, hi = chars.length;
      const arr = chars.map(ch => '<' + utf16beHex(ch) + '>').join(' ');
      cmap += '1 beginbfrange\n' +
        '<' + lo.toString(16).toUpperCase().padStart(4, '0') + '> ' +
        '<' + hi.toString(16).toUpperCase().padStart(4, '0') + '> ' +
        '[' + arr + ']\nendbfrange\n';
    } else {
      const lines = chars.map((ch, i) =>
        '<' + (i + 1).toString(16).toUpperCase().padStart(4, '0') + '> <' + utf16beHex(ch) + '>').join('\n');
      cmap += chars.length + ' beginbfchar\n' + lines + '\nendbfchar\n';
    }
    cmap += 'endcmap\nend\nend\n';
    const cmapBuf = Buffer.from(cmap, 'latin1');
    const stored = opt.cmapZlib === false ? cmapBuf : zlib.deflateSync(cmapBuf);
    toUniRef = nextNum;
    extraObjs.push(nextNum + ' 0 obj << /Length ' + stored.length +
      (opt.cmapZlib === false ? '' : ' /Filter /FlateDecode') +
      ' >>\nstream\n' + stored.toString('latin1') + '\nendstream\nendobj\n');
    nextNum++;
  }

  const fontObj = '5 0 obj << /Type /Font /Subtype /Type0 /BaseFont /ABCDEF+SimSun ' +
    '/Encoding /Identity-H ' + (toUniRef ? '/ToUnicode ' + toUniRef + ' 0 R ' : '') +
    '/DescendantFonts [' + nextNum + ' 0 R] >> endobj\n';
  extraObjs.push(nextNum + ' 0 obj << /Type /Font /Subtype /CIDFontType2 /BaseFont /ABCDEF+SimSun >> endobj\n');
  nextNum++;

  // ---- 可选的整页图 ----
  let imgRef = null, resExtra = '', contentExtra = '';
  if (opt.image) {
    imgRef = nextNum;
    extraObjs.push(nextNum + ' 0 obj << /Type /XObject /Subtype /Image /Width 1 /Height 1 ' +
      '/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ' + TINY_JPEG.length +
      ' >>\nstream\n' + TINY_JPEG.toString('latin1') + '\nendstream\nendobj\n');
    resExtra = ' /XObject << /Im0 ' + imgRef + ' 0 R >>';
    contentExtra = '\nq 300 0 0 400 0 0 cm /Im0 Do Q\n';
    nextNum++;
  }

  const fullContent = content + contentExtra;

  const parts = [
    '%PDF-1.4\n',
    '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n',
    '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n',
    '3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] ' +
      '/Resources << /Font << /F1 5 0 R >>' + resExtra + ' >> /Contents 4 0 R >> endobj\n',
    '4 0 obj << /Length ' + fullContent.length + ' >>\nstream\n' + fullContent + '\nendstream\nendobj\n',
    fontObj,
    ...extraObjs,
    'trailer << /Root 1 0 R >>\n%%EOF\n',
  ];
  return Buffer.from(parts.join(''), 'latin1');
}

/** 老契约：有文字层的普通 PDF（不许被子集字体逻辑带坏） */
function plainTextPdf(text) {
  const content = 'BT /F1 12 Tf 72 720 Td\n(' + text.replace(/([\\()])/g, '\\$1') + ') Tj ET\n';
  return Buffer.from(
    '%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n' +
    '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n' +
    '3 0 obj << /Type /Page /Parent 2 0 R /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >> endobj\n' +
    '4 0 obj << /Length ' + content.length + ' >>\nstream\n' + content + '\nendstream\nendobj\n' +
    '5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj\n' +
    'trailer << /Root 1 0 R >>\n%%EOF\n', 'latin1');
}

/** 造一段 bfchar CMap 文本（`pairs` 是 [cid, 字符] 的数组） */
function cmapFor(pairs) {
  const body = pairs.map(([cid, ch]) =>
    '<' + cid.toString(16).toUpperCase().padStart(4, '0') + '> <' + utf16beHex(ch) + '>').join('\n');
  return 'begincmap\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n' +
    pairs.length + ' beginbfchar\n' + body + '\nendbfchar\nendcmap\n';
}

/** deflate 一段流数据；末尾补一个**不是** 0x0a/0x0d 的字节 ——
 *  scanObjects 会把流尾的换行剪掉，若压缩流最后一字节恰好是换行就会被剪断、解压失败。 */
function zstream(data) {
  const d = zlib.deflateSync(data);
  return d[d.length - 1] === 0x0a || d[d.length - 1] === 0x0d
    ? Buffer.concat([d, Buffer.from([0x20])]) : d;
}

/** 一段确定性伪随机字节（当"二进制"用；不用 Math.random，测试要可复现） */
function junkBytes(n, seed) {
  const b = Buffer.alloc(n);
  for (let i = 0; i < n; i++) b[i] = ((i * 2654435761 + (seed || 0)) >>> 16) & 0xFF;
  return b;
}

/**
 * 合成一份"脏"PDF —— 正文很小，旁边躺着两类**解压出来一大坨二进制**的东西：
 *   ① 内嵌字体程序（`/Length1` 是字体程序的标志）
 *   ② 透明组 Form XObject（`/Subtype /Form` + 嵌套 `/Group << … >>`）
 * 而且**页字典里也带嵌套 `/Group << … >>`**（Word / InDesign 导出极常见）。
 *
 * ★ 为什么要造这一份：旧写法用 `raw.lastIndexOf('<<')` 反查"这个流属于哪个字典"，
 *   碰到嵌套字典会切到内层 `<<`，于是既看不出 `/Filter /FlateDecode`、
 *   也看不出这是字体程序，把**压缩后的二进制**当内容流喂进文本解析器，
 *   吐出成百上千倍的垃圾把正文淹掉 —— 整份 PDF 被判"读不出来"。
 *   用户那份 10 页测评报告就是这么死的。
 */
function dirtyPdf() {
  // ★ 字数必须 ≥8：looksLikeText 的长度门槛是 8，夹具自己的正文得先达标，
  //   否则"读出来了"和"没读出来"分不清，测的就不是流选择了。
  const chars = ['甲', '乙', '丙', '丁', '戊', '己', '庚', '辛', '壬'];
  const hexText = chars.map((_, i) => (i + 1).toString(16).toUpperCase().padStart(4, '0')).join('');
  const content = 'BT /F1 12 Tf 72 720 Td\n<' + hexText + '> Tj\nET\n';
  const cmapStored = zstream(Buffer.from(cmapFor(chars.map((ch, i) => [i + 1, ch])), 'latin1'));
  const fontBin = junkBytes(40000, 0);
  Buffer.from('FONTMARKER').copy(fontBin, 20000);      // 独有标记，用来断言"没被当正文"
  const fontStored = zstream(fontBin);
  const formStored = zstream(junkBytes(30000, 7919));
  return Buffer.from(
    '%PDF-1.4\n' +
    '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n' +
    '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n' +
    // ★ 页字典里带嵌套 /Group
    '3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] ' +
      '/Group << /S /Transparency /CS /DeviceGray /I true >> ' +
      '/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >> endobj\n' +
    '4 0 obj << /Length ' + content.length + ' >>\nstream\n' + content + '\nendstream\nendobj\n' +
    '5 0 obj << /Type /Font /Subtype /Type0 /BaseFont /ABCDEF+SimSun /Encoding /Identity-H ' +
      '/ToUnicode 6 0 R /DescendantFonts [7 0 R] >> endobj\n' +
    '6 0 obj << /Filter /FlateDecode /Length ' + cmapStored.length +
      ' >>\nstream\n' + cmapStored.toString('latin1') + '\nendstream\nendobj\n' +
    '7 0 obj << /Type /Font /Subtype /CIDFontType2 /BaseFont /ABCDEF+SimSun >> endobj\n' +
    // ★ 字体程序二进制
    '8 0 obj << /Length1 40000 /Filter /FlateDecode /Length ' + fontStored.length +
      ' >>\nstream\n' + fontStored.toString('latin1') + '\nendstream\nendobj\n' +
    // ★ 透明组 Form XObject（字典里同样有嵌套 /Group）
    '9 0 obj << /Type /XObject /Subtype /Form /BBox [0 0 595 842] ' +
      '/Group << /Type /Group /S /Transparency /CS /DeviceGray /I true >> ' +
      '/Filter /FlateDecode /Length ' + formStored.length +
      ' >>\nstream\n' + formStored.toString('latin1') + '\nendstream\nendobj\n' +
    'trailer << /Root 1 0 R >>\n%%EOF\n', 'latin1');
}

/**
 * 合成一份**两个子集字体、CID 空间故意重叠**的 PDF：
 *   /F1 的 CID 1..4 → 题目训练      /F2 的 CID 1..4 → 考点盲区
 * ★ 这是"合成一张全局映射表"必然出错的地方：合并表里 CID 1..4 只留先到的
 *   「题目训练」，于是 /F2 那行被解成「题目训练」——实测在用户报告里表现为
 *   「已通过题**明**」（应为「题目」）、「高频标**线**」（应为「考点」）。
 */
function twoFontPdf() {
  const f1 = [[1, '题'], [2, '目'], [3, '训'], [4, '练']];
  const f2 = [[1, '考'], [2, '点'], [3, '盲'], [4, '区']];
  const c1 = zstream(Buffer.from(cmapFor(f1), 'latin1'));
  const c2 = zstream(Buffer.from(cmapFor(f2), 'latin1'));
  const hex = '<0001000200030004>';
  const content = 'BT /F1 12 Tf 72 720 Td\n' + hex + ' Tj\nET\n' +
                  'BT /F2 12 Tf 72 700 Td\n' + hex + ' Tj\nET\n';
  return Buffer.from(
    '%PDF-1.4\n' +
    '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n' +
    '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n' +
    '3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] ' +
      '/Resources << /Font << /F1 5 0 R /F2 8 0 R >> >> /Contents 4 0 R >> endobj\n' +
    '4 0 obj << /Length ' + content.length + ' >>\nstream\n' + content + '\nendstream\nendobj\n' +
    '5 0 obj << /Type /Font /Subtype /Type0 /BaseFont /ABCDEF+SimSun /Encoding /Identity-H ' +
      '/ToUnicode 6 0 R /DescendantFonts [7 0 R] >> endobj\n' +
    '6 0 obj << /Filter /FlateDecode /Length ' + c1.length +
      ' >>\nstream\n' + c1.toString('latin1') + '\nendstream\nendobj\n' +
    '7 0 obj << /Type /Font /Subtype /CIDFontType2 /BaseFont /ABCDEF+SimSun >> endobj\n' +
    '8 0 obj << /Type /Font /Subtype /Type0 /BaseFont /ABCDEF+KaiTi /Encoding /Identity-H ' +
      '/ToUnicode 9 0 R /DescendantFonts [10 0 R] >> endobj\n' +
    '9 0 obj << /Filter /FlateDecode /Length ' + c2.length +
      ' >>\nstream\n' + c2.toString('latin1') + '\nendstream\nendobj\n' +
    '10 0 obj << /Type /Font /Subtype /CIDFontType2 /BaseFont /ABCDEF+KaiTi >> endobj\n' +
    'trailer << /Root 1 0 R >>\n%%EOF\n', 'latin1');
}

// ================= 断言 =================
function main() {
  console.log('批次26（内嵌子集字体 PDF 能不能读）：\n');

  // ---------- A. CMap 解析本身（纯函数） ----------
  {
    const cmap = '/CIDInit /ProcSet findresource begin\n' +
      '1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n' +
      '2 beginbfchar\n<0001> <4F60>\n<0002> <597D>\nendbfchar\n' +
      'endcmap\nend\nend\n';
    const m = extract.parseToUnicode(cmap);
    eq(m.size, 2, 'A1 parseToUnicode 认出 2 条 bfchar');
    eq(m.get(1), '你', 'A2 CID 1 → 你');
    eq(m.get(2), '好', 'A3 CID 2 → 好');

    // bfrange：连续区间。★ 语义是 dstStart + k（不是"所有 CID 都指同一个字符"）
    const cmap2 = 'beginbfrange\n<0001> <0003> <0041>\nendbfrange\n';
    const m2 = extract.parseToUnicode(cmap2);
    eq(m2.size, 3, 'A4 bfrange（连续）展开成 3 条');
    eq(m2.get(1), 'A', '  └ CID1 → A（dstStart 本身）');
    eq(m2.get(2), 'B', '  └ CID2 → B（dstStart+1，★ 不是"又指回 A"）');
    eq(m2.get(3), 'C', '  └ CID3 → C（dstStart+2）');

    // bfrange 用 [] 数组给目标（每个显式指定，可以不连续）
    const cmap3 = 'beginbfrange\n<0001> <0002> [<4F60> <597D>]\nendbfrange\n';
    const m3 = extract.parseToUnicode(cmap3);
    eq(m3.get(1), '你', 'A7 bfrange 数组形式：CID1 → 你');
    eq(m3.get(2), '好', 'A8 bfrange 数组形式：CID2 → 好');

    // 多字节目标（一个 CID 映到多个字符）
    const cmap4 = 'beginbfchar\n<0001> <00410042>\nendbfchar\n';
    const m4 = extract.parseToUnicode(cmap4);
    eq(m4.get(1), 'AB', 'A9 一个 CID 可以映到多个字符（连字）');

    // ★ 空/坏输入不许崩
    eq(extract.parseToUnicode('').size, 0, 'A10 空 CMap → 空映射（不崩）');
    eq(extract.parseToUnicode('garbage not a cmap').size, 0, 'A11 乱输入 → 空映射（不崩）');
  }

  // ---------- B. ★ FlateDecode 是 zlib 不是 gzip ----------
  {
    // zlib 流（0x78 开头）—— PDF 的标准写法
    const z = zlib.deflateSync(Buffer.from('beginbfchar\n<0001> <4F60>\nendbfchar\n', 'latin1'));
    eq(z[0], 0x78, 'B1 前置：PDF 的 FlateDecode 头就是 0x78（zlib），不是 0x1f8b（gzip）');
    // 直接把 zlib 字节发给 parseToUnicode（它内部要能自己解）
    const m = extract.parseToUnicode(z.toString('latin1'));
    eq(m.get(1), '你', 'B2 ★ zlib 压缩的 CMap 能被解开并解析（第一版只认 gzip，这条会红）');

    // gzip 也要能认（有些工具会写 gzip）
    const g = zlib.gzipSync(Buffer.from('beginbfchar\n<0001> <4F5C>\nendbfchar\n', 'latin1'));
    eq(g[0], 0x1f, 'B3 前置：gzip 头是 0x1f');
    eq(extract.parseToUnicode(g.toString('latin1')).get(1), '作', 'B4 gzip 压缩的 CMap 也能解（两种都认）');
  }

  // ---------- C. toUnicodeMaps：从整份 PDF 里收映射 ----------
  {
    const buf = subsetFontPdf({ chars: ['你', '好', '世', '界'], toUnicode: true });
    const tu = extract.toUnicodeMaps(buf);
    ok(tu.fonts >= 1, 'C1 认出带 ToUnicode 的字体数 ≥1', tu.fonts);
    eq(tu.map.size, 4, 'C2 合并出 4 条映射');
    eq(tu.map.get(3), '世', 'C3 CID 3 → 世');

    // 没有 ToUnicode 的字体不贡献映射
    const buf2 = subsetFontPdf({ chars: ['甲', '乙'], toUnicode: false });
    eq(extract.toUnicodeMaps(buf2).map.size, 0, 'C4 没有 /ToUnicode → 空映射（不硬猜）');
  }

  // ---------- D. ★★ 端到端：这就是用户报的那个场景 ----------
  {
    // D1：★★ 带 ToUnicode 的子集字体 PDF —— 现在必须**读出中文**
    const good = subsetFontPdf({ chars: ['你', '好', '世', '界'], toUnicode: true });
    const r1 = extract.extractPdf(good);
    ok(has(r1.text, '你好世界'), 'D1 ★★ 带 ToUnicode 的内嵌子集字体 PDF：真的读出了「你好世界」', r1.text);
    eq(r1.scanned, false, '  └ 读出来了就不是扫描件，不该去排队 OCR');
    eq(r1.cidMapped, true, '  └ 标记了"用上了 CID 映射表"');
    ok(!r1.note, '  └ 读出来了就不该带任何"读不出"的说明');

    // D2：bfrange 形式同样要能读（用 [] 数组形式；连续区间见 A4-A6）
    const r2 = extract.extractPdf(subsetFontPdf({ chars: ['你', '好', '世', '界'], toUnicode: 'range' }));
    ok(has(r2.text, '你好世界'), 'D2 bfrange（[] 数组形式）的 CMap 也能读（两种段都要支持）', r2.text);
    eq(r2.cidMapped, true, '  └ 同样走的是 CID 映射');

    // D3：CMap 未压缩（没有 /Filter）也要能读
    // ★ 这里必须给够字数：`looksLikeText` 的门槛是 8 个字符，3 个字×2 处只有 6 个。
    //   旧写法能"通过"是因为它把 **CMap 流也当正文**解了、凑够了字数 ——
    //   那正是 G 组要禁止的行为，所以夹具得自己把字数给足，不能靠 bug 撑着。
    const r3 = extract.extractPdf(subsetFontPdf({ chars: ['甲', '乙', '丙', '丁', '戊'], toUnicode: true, cmapZlib: false }));
    ok(has(r3.text, '甲乙丙丁戊'), 'D3 未压缩的 CMap 流也能读', r3.text);

    // D4：★ 没有 ToUnicode —— 不许把它读成乱码冒充成功
    const noMap = subsetFontPdf({ chars: ['你', '好'], toUnicode: false });
    const r4 = extract.extractPdf(noMap);
    eq(r4.text, '', 'D4 ★ 没有映射表时**不许**输出乱码（宁可空着）');
    eq(r4.scanned, false, '  └ 且这一份没有任何图片 ⇒ 两条路都走不通，标 scanned=false');

    // D5：★★ 没有 ToUnicode 但**有整页图** ⇒ 归到 scanned（可以走 OCR 救）
    const noMapImg = subsetFontPdf({ chars: ['你', '好'], toUnicode: false, image: true });
    const r5 = extract.extractPdf(noMapImg);
    eq(r5.text, '', 'D5 ★★ 无映射但有页图：文字仍抽不出');
    eq(r5.scanned, true, '  └ ★ 但要标 scanned=true —— 上层据此排队 OCR，用户不用重新准备文件');
    ok(has(r5.note, '识别'), '  └ 说明里要讲清"正在识别"，不是干等', r5.note);

    // D6：三种"读不出"的说明文案要各不相同（不能一句话糊弄所有情况）
    const noteNoMapImg = r5.note;
    const noteNoMapNoImg = r4.note;
    ok(noteNoMapImg !== noteNoMapNoImg, 'D6 有图（能救）与无图（死路）的说明文案必须不同');

    // D7：老契约 —— 普通有文字层的 PDF 不受影响
    const plain = extract.extractPdf(plainTextPdf('Hello world, this is a plain PDF.'));
    ok(has(plain.text, 'Hello world'), 'D7 普通文字层 PDF 照常读出（没被子集字体逻辑带坏）', plain.text);
    eq(plain.scanned, false, '  └ 不是扫描件');
    eq(plain.cidMapped, false, '  └ 没走 CID 映射');

    // ---------- D8：★★ TJ 数组（带每字间距）—— 中文 PDF 里极常见的写法 ----------
    // `[(<0001>) -50 (<0002>)] TJ` 里的 `(<hex>)` 与 `<hex>` 是同一个意思。
    // ★ 这一条是**实测踩出来的**：修好 <hex> 之后跑真实结构演练，
    //   发现 TJ 数组里抽出来的是字面的 "<0002><0005>" —— 走 `(` 分支的串
    //   永远不会去查 CID 表，于是中文 PDF 满屏原始码，且**不报任何错**。
    {
      const cm = new Map([[1, '而'], [2, '之']]);
      const tjArr = extract.textFromContentStream('BT /F1 12 Tf 72 720 Td [(<0001>) -50 (<0002>)] TJ ET', cm);
      ok(has(tjArr, '而之'), 'D8 ★★ TJ 数组里的 (<hex>) 也要查 CID 表（不许吐 "<0001>" 这种原始码）', tjArr);
      const tjArr2 = extract.textFromContentStream('BT /F1 12 Tf 72 720 Td [(<0001>)] TJ ET', cm);
      ok(has(tjArr2, '而'), '  └ 单个元素的 TJ 数组同样');
      // 对照：裸 <hex> 的 Tj 一直是对的（两条路必须给出同一个字）
      const bare = extract.textFromContentStream('BT /F1 12 Tf 72 720 Td <0001> Tj ET', cm);
      ok(has(bare, '而'), '  └ 对照：裸 <hex> 的 Tj 抽出同一个字（两条路不许漂移）');
      // ★ 反证：真的普通文本里带尖括号，不许被误当成十六进制
      const legit = extract.textFromContentStream('BT /F1 12 Tf 72 720 Td (a <b> c) Tj ET', cm);
      ok(has(legit, '<b>'), 'D9 ★ 反证：普通文本里的尖括号不许被误当十六进制解掉', legit);
      // ★ 没有 cidMap 时**与裸 <hex> 分支行为必须一致**（尽力而为按字节解），
      //   绝不能吐出字面的 "<0001>" —— 那是纯 ASCII，looksLikeText 会放行，
      //   于是原始码冒充正文。这一条钉的是"两条路不许漂移"。
      const noMapBare = extract.textFromContentStream('BT /F1 12 Tf 72 720 Td <0001> Tj ET', null);
      const noMapTj = extract.textFromContentStream('BT /F1 12 Tf 72 720 Td [(<0001>)] TJ ET', null);
      eq(noMapTj, noMapBare, 'D10 ★ 没有映射表时 TJ 数组与裸 <hex> 抽出的结果必须**逐字相同**（不许一条查表一条不查）');
      ok(!has(noMapTj, '<0001>'), '  └ ★ 且**不许**留下字面的 "<0001>"（纯 ASCII 会被 looksLikeText 放行 ⇒ 原始码冒充正文）');
    }
  }

  // ---------- E. 不许把"有没有图"当成唯一判据 ----------
  {
    // 有字体、有 ToUnicode、有图、但内容流是空的 ⇒ 文字仍是空，但有图 → 归 scanned
    const imgOnly = subsetFontPdf({ chars: ['你'], toUnicode: true, image: true });
    // 人为把内容流里的文字 hex 抹掉，模拟"字体和图都在、就是没文字"
    const raw = imgOnly.toString('latin1').replace(/<0001> Tj/, '');
    const r = extract.extractPdf(Buffer.from(raw, 'latin1'));
    eq(r.text, '', 'E1 内容流没文字时抽不出');
    eq(r.scanned, true, 'E2 ★ 有图 ⇒ 仍归到 scanned（让 OCR 去试），不武断判死');
  }

  // ---------- G. ★★ 只解析真正的页面内容流 ----------
  // 背景：用户那份 10 页测评报告，字体映射表**是齐的**，却整份读不出来。
  // 真因是旧写法把**内嵌字体程序的二进制**解压后当正文解析，吐出 1.8MB 垃圾
  // 把 8KB 正文彻底淹没。这一组钉的就是"只认 /Contents"。
  {
    const buf = dirtyPdf();
    const r = extract.extractPdf(buf);
    ok(has(r.text, '甲乙丙丁戊己庚辛壬'), 'G1 ★ 页字典带嵌套 /Group、旁边躺着字体程序与透明组时，正文照样读得出', r.text);
    ok(!has(r.text, 'FONTMARKER'), 'G2 ★★ 字体程序流**不许**被当成正文（旧写法会把它解压后喂进文本解析器）');
    // ★ 最严的一条：抽出来必须**恰好**是内容流里那串。
    //   多一个字，就说明又去解析了非内容流（CMap / 字体 / Form 里都能解出字来）。
    eq(r.text.replace(/\s+/g, ''), '甲乙丙丁戊己庚辛壬', 'G3 ★★ 抽出的文字必须**恰好**等于内容流里的正文（多一个字就是把非内容流当正文了）');
    eq(r.scanned, false, '  └ 读出来了就不该排队 OCR');
    eq(r.pages, 1, '  └ 页数照旧从 /Type /Page 数出来');
  }

  // ---------- H. ★★ 按字体分表：同一 CID 在不同子集字体里是**不同的字** ----------
  // 背景：一份 PDF 里常有 9～27 个子集字体，CID 空间互相独立。
  // 合成一张全局表时"先到的赢"，后一个字体里同号的字就被译成前一个的字 ——
  // 实测表现为「已通过题**明**」（应为「题目」）、「高频标**线**」（应为「考点」）。
  // 这种**看着像人话的错字**比读不出来更危险：AI 会照着错字讲。
  {
    const buf = twoFontPdf();
    const r = extract.extractPdf(buf);
    ok(has(r.text, '题目训练'), 'H1 ★ 多字体 PDF：/F1 的映射用对了', r.text);
    ok(has(r.text, '考点盲区'), 'H2 ★★ /F2 里同号 CID 必须按 /F2 自己的表解（合成一张全局表这里会解成「题目训练」）', r.text);
    ok(!has(r.text, '题明') && !has(r.text, '考目'), '  └ 且不许出现串味的错字（题明 / 考目）');
  }

  // ---------- F. 静态：接线与顺序 ----------
  {
    const EX = fs.readFileSync(path.join(__dirname, 'server/extract.js'), 'utf8');
    // ★ 钉"调用点"不是"字符串存在"：从 `const txt = ` 起头才算调用点，
    //   否则函数**定义**里的 `(s, cidMap)` 也能让这条断言变绿（等于没测）。
    ok(/const txt = textFromContentStream\([\s\S]{0,80}?cidMap/.test(EX), 'F1 `textFromContentStream` 的调用点**真的传了** cidMap（不是只在定义处有个参数）');
    ok(/const\s+cidMap\s*=/.test(EX), 'F2 extractPdf 里真的建了 cidMap');
    ok(/toUnicodeMaps\(buf\)/.test(EX), 'F3 extractPdf 里真的调了 toUnicodeMaps');
    // ToUnicode 要在**抽文字之前**就收齐
    const idxMap = EX.indexOf('toUnicodeMaps(buf)');
    const idxLoop = EX.indexOf('const txt = textFromContentStream(');
    ok(idxMap >= 0 && idxLoop >= 0 && idxMap < idxLoop, 'F4 ★ 先收映射、后抽文字（顺序倒了等于没读）');
    // 不许再把"抽不出"一律说成"内嵌子集字体"（那是旧的一刀切文案）
    ok(!has(EX, '这份 PDF 的文字用了内嵌子集字体，没能抽出可用的文字。建议'), 'F5 旧的一刀切文案已清掉（改为按有无图分别说明）');
    // ★★ 不许再用 `lastIndexOf('<<')` 反查"这个流属于哪个字典" ——
    //    碰到嵌套字典（页字典里的 /Group << … >>）会切到内层，判不出 FlateDecode，
    //    于是把压缩后的字体二进制当正文喂进去（G 组的病根）。
    ok(!/lastIndexOf\('<<'/.test(EX), 'F6 ★★ 已不再用 lastIndexOf(<<) 反查流字典（嵌套字典会切错）');
    // ★ 真的按 /Type /Page → /Contents 取流，而不是"所有 stream 都试一遍"
    ok(/dictRefList\(pg\.dict, 'Contents'\)/.test(EX), 'F7 ★ extractPdf 真的按 /Contents 取页面内容流');
    // ★ 调用点真的传了按字体分好的表（H 组靠它才成立）
    ok(/cidMap, fmaps\)/.test(EX), 'F8 ★ 调用点真的传了按字体分好的表（不传就退回全局表 ⇒ 又串味）');
    // 兜底路径必须滤掉二进制流，否则老毛病会在没有 /Type /Page 的文件上复发
    ok(has(EX, '/Length[123]'), 'F9 兜底扫全流时滤掉字体程序等二进制流');
  }

  console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  if (fail) { console.log('\n失败清单：'); fails.forEach(f => console.log('  ✗ ' + f)); }

  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
  process.exit(fail ? 1 : 0);
}

try { main(); } catch (e) {
  console.error('批次26 自检异常：', (e && e.stack) || e);
  process.exit(1);
}

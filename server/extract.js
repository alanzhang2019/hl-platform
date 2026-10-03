'use strict';
/**
 * 文档文本抽取（零依赖）
 *
 * 为什么自己写而不装 pdf-parse / mammoth：
 *   这个平台的地基是"零依赖 Node 22"。多一个 npm 依赖，就多一条供应链风险，
 *   也意味着部署时要联网。PDF 的 FlateDecode、DOCX 的 ZIP 容器，
 *   用内置的 zlib 都能解，代码量在可维护范围内。
 *
 * 诚实原则：抽不出来就明说抽不出来（status='failed' + error），
 * 绝不返回一段乱码假装成功 —— 那会让 AI 基于垃圾内容瞎讲。
 */
const zlib = require('zlib');

// ================= 工具 =================
function tryInflate(buf) {
  const tries = [
    () => zlib.inflateSync(buf),
    () => zlib.inflateRawSync(buf),
    () => zlib.unzipSync(buf),
  ];
  for (const t of tries) { try { return t(); } catch (e) {} }
  return null;
}

/** 判定抽取结果是不是"看起来像文字"。乱码要能被识别出来，不能冒充成功。
 *  长度门槛压到 8：像"作业：P12 第1-5题"这种短笔记也该收进来，
 *  拦乱码主要靠下面的可用字符比例，不靠长度。 */
function looksLikeText(s) {
  const t = String(s || '');
  if (t.length < 8) return false;
  const usable = (t.match(/[\u4e00-\u9fa5A-Za-z0-9，。；：、！？（）《》""''\s.,;:!?()\[\]{}<>+\-*/=%$#@&_'"|~^`]/g) || []).length;
  return usable / t.length > 0.75;
}

// ================= ZIP（DOCX / XLSX 的容器）=================
function unzip(buf) {
  // 从尾部找 EOCD
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66000); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return null;
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = {};
  for (let i = 0; i < count && p + 46 <= buf.length; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const cmtLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString('utf8');
    // 本地头：签名(4) 版本(2) 标志(2) 方法(2) 时间(2) 日期(2) crc(4) 压缩(4) 原始(4) 名长(2) 扩展(2)
    if (localOff + 30 <= buf.length && buf.readUInt32LE(localOff) === 0x04034b50) {
      const lNameLen = buf.readUInt16LE(localOff + 26);
      const lExtraLen = buf.readUInt16LE(localOff + 28);
      const start = localOff + 30 + lNameLen + lExtraLen;
      let data = buf.slice(start, start + (compSize || buf.readUInt32LE(localOff + 18)));
      if (method === 8) { const inf = tryInflate(data); if (inf) data = inf; }
      files[name] = data;
    }
    p += 46 + nameLen + extraLen + cmtLen;
  }
  return files;
}

function xmlToText(xml) {
  return String(xml)
    .replace(/<w:p\b[^>]*\/>/g, '\n')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<w:tab\b[^>]*\/>/g, '\t')
    .replace(/<w:br\b[^>]*\/>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, '&')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function extractDocx(buf) {
  const z = unzip(buf);
  if (!z || !z['word/document.xml']) return { text: '', note: '不是有效的 docx（缺少 word/document.xml）' };
  return { text: xmlToText(z['word/document.xml'].toString('utf8')) };
}

function extractXlsx(buf) {
  const z = unzip(buf);
  if (!z) return { text: '', note: '不是有效的 xlsx' };
  // 共享字符串
  const shared = [];
  if (z['xl/sharedStrings.xml']) {
    const sx = z['xl/sharedStrings.xml'].toString('utf8');
    (sx.match(/<si\b[\s\S]*?<\/si>/g) || []).forEach(si => {
      shared.push((si.match(/<t\b[^>]*>([\s\S]*?)<\/t>/g) || [])
        .map(t => t.replace(/<[^>]+>/g, '')).join('')
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'));
    });
  }
  const sheets = Object.keys(z).filter(k => /^xl\/worksheets\/sheet\d+\.xml$/.test(k)).sort();
  const out = [];
  sheets.forEach((name, si) => {
    const xml = z[name].toString('utf8');
    out.push('【工作表 ' + (si + 1) + '】');
    (xml.match(/<row\b[\s\S]*?<\/row>/g) || []).forEach(row => {
      const cells = (row.match(/<c\b[\s\S]*?<\/c>|<c\b[^>]*\/>/g) || []).map(c => {
        const v = /<v>([\s\S]*?)<\/v>/.exec(c);
        if (!v) {
          const inline = /<is>[\s\S]*?<t\b[^>]*>([\s\S]*?)<\/t>/.exec(c);
          return inline ? inline[1] : '';
        }
        if (/t="s"/.test(c)) return shared[Number(v[1])] != null ? shared[Number(v[1])] : '';
        return v[1];
      });
      const line = cells.join('\t').replace(/\t+$/, '');
      if (line.trim()) out.push(line);
    });
  });
  return { text: out.join('\n') };
}

// ================= PDF =================
/** 解 PDF 字符串字面量里的转义 */
function unescapePdfString(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c !== '\\') { out += c; continue; }
    const n = s[++i];
    if (n === 'n') out += '\n';
    else if (n === 'r') out += '\r';
    else if (n === 't') out += '\t';
    else if (n === 'b') out += '\b';
    else if (n === 'f') out += '\f';
    else if (n === '(') out += '(';
    else if (n === ')') out += ')';
    else if (n === '\\') out += '\\';
    else if (n >= '0' && n <= '7') {
      let oct = n;
      while (oct.length < 3 && s[i + 1] >= '0' && s[i + 1] <= '7') oct += s[++i];
      out += String.fromCharCode(parseInt(oct, 8));
    } else out += n;
  }
  return out;
}

// ================= ToUnicode CMap（子集字体能不能读出来的关键） =================
// 为什么必须有：中文 PDF 普遍用**内嵌子集字体**（Identity-H 编码）。
// 内容流里 `<000100020003>` 写的是 **CID**（字形在子集里的序号），
// 不是 Unicode —— 直接 `String.fromCharCode(cid)` 得到的是乱码，
// 于是 looksLikeText 判不过，整份 PDF 被当成"读不出来"。
// 正确做法是读字体字典里的 `/ToUnicode` CMap，把 CID 映回真正的字符。
// 认不出（没有 ToUnicode）就如实返回空映射，让上层照旧报"读不出来"，不许硬猜。

/** 解一段 CMap 流的字节（可能是 FlateDecode 压缩的）。
 *  ★ PDF 的 FlateDecode 是 **zlib 格式**（头 0x78 …），不是 gzip（0x1f 0x8b）；
 *    两者混了会让 CMap 解不出来 → 映射表为空 → 白干（本函数第一版就踩了）。
 *    这里干脆**直接试着解压**：`tryInflate` 解不开会返回 null，再按原文处理，
 *    比"猜魔术字节"更稳（有些流前面还有别的字节）。 */
function cmapBytes(buf) {
  const inf = tryInflate(buf);
  const d = inf || buf;
  return d.toString('latin1');
}

/**
 * 解析 ToUnicode CMap 的 `beginbfchar` / `beginbfrange` 段。
 * @returns {Map<number,string>} CID → 字符串（一个 CID 可能映到多个字符，如连字）
 */
function parseToUnicode(text) {
  const map = new Map();
  const src = cmapBytes(Buffer.from(text, 'latin1'));
  const hex2 = h => parseInt(h, 16);
  // 一个 <dst> 里的 UTF-16BE 字节 → 字符串
  const dstOf = h => {
    let s = '';
    const clean = h.replace(/\s+/g, '');
    for (let i = 0; i + 3 < clean.length; i += 4) {
      const u = parseInt(clean.substr(i, 4), 16);
      if (u) s += String.fromCharCode(u);
    }
    return s;
  };
  // beginbfchar: <src> <dst>
  let m;
  const bfcharRe = /beginbfchar([\s\S]*?)endbfchar/g;
  while ((m = bfcharRe.exec(src)) !== null) {
    const body = m[1];
    const pairRe = /<([0-9A-Fa-f\s]+)>\s*<([0-9A-Fa-f\s]+)>/g;
    let p;
    while ((p = pairRe.exec(body)) !== null) map.set(hex2(p[1].replace(/\s+/g, '')), dstOf(p[2]));
  }
  // beginbfrange: <lo> <hi> <dstStart>  或  <lo> <hi> [<d1> <d2> ...]
  const bfrangeRe = /beginbfrange([\s\S]*?)endbfrange/g;
  while ((m = bfrangeRe.exec(src)) !== null) {
    const body = m[1];
    const rre = /<([0-9A-Fa-f\s]+)>\s*<([0-9A-Fa-f\s]+)>\s*(<[0-9A-Fa-f\s]+>|\[[\s\S]*?\])/g;
    let r;
    while ((r = rre.exec(body)) !== null) {
      const lo = hex2(r[1].replace(/\s+/g, ''));
      const hi = hex2(r[2].replace(/\s+/g, ''));
      const tgt = r[3];
      if (tgt[0] === '[') {
        const items = tgt.match(/<[0-9A-Fa-f\s]+>/g) || [];
        for (let i = 0; i < items.length && lo + i <= hi; i++) map.set(lo + i, dstOf(items[i].slice(1, -1)));
      } else {
        const startHex = tgt.slice(1, -1).replace(/\s+/g, '');
        const start = parseInt(startHex, 16);
        const wide = startHex.length > 4;   // 目标是多字节 UTF-16
        for (let c = lo; c <= hi && c - lo < 65536; c++) {
          const u = start + (c - lo);
          map.set(c, wide ? dstOf(u.toString(16).padStart(startHex.length, '0')) : String.fromCharCode(u));
        }
      }
    }
  }
  return map;
}

/**
 * 扫出文档里所有字体的 ToUnicode 映射，**合并成一张表**。
 *
 * 合并而不是"按资源名分表"：本项目只做「把文字读出来」这一件事，
 * 不做逐字形排版还原；同文档里不同子集字体的 CID 空间各自独立，
 * 但实践中互相冲突的概率极低，而分表的复杂度（要跟着 Tf 切字体）明显更高。
 * 冲突时**后者不覆盖前者** —— 先到的留着，避免把已经映对的覆盖成错的。
 */
function toUnicodeMaps(buf) {
  const raw = buf.toString('latin1');
  const objs = scanObjects(buf);
  const merged = new Map();
  let found = 0;
  objs.forEach(o => {
    if (!/\/Type\s*\/Font/.test(o.dict)) return;
    const ref = dictRefNum(o.dict, 'ToUnicode');
    if (ref == null) return;
    const co = objs.get(ref);
    if (!co || co.dataStart < 0) return;
    let d = buf.slice(co.dataStart, co.dataEnd);
    const cm = parseToUnicode(d.toString('latin1'));
    if (cm.size) {
      found++;
      cm.forEach((v, k) => { if (!merged.has(k)) merged.set(k, v); });
    }
  });
  return { map: merged, fonts: found };
}

/** 把一段十六进制字符串（`<...>` 里的内容，已去掉尖括号与空白）解成文字。
 *  @param {Map<number,string>|null} cidMap CID→字符（来自 ToUnicode） */
function decodeHexText(hex, cidMap) {
  if (!hex || !/^[0-9A-Fa-f]+$/.test(hex)) return '';
  let t = '';
  // ★ 有 ToUnicode 就用它查（子集字体的正道）；查不到的 CID 跳过而不是猜。
  if (cidMap && cidMap.size) {
    const w = hex.length % 4 === 0 ? 4 : 2;   // 2 字节一 CID 是最常见写法
    for (let i = 0; i + w <= hex.length; i += w) {
      const cid = parseInt(hex.substr(i, w), 16);
      const hit = cidMap.get(cid);
      if (hit != null) t += hit;
    }
  } else if (hex.length % 4 === 0) {
    // 没有 ToUnicode：2 字节一字符（常见于 CID 字体），尽力而为
    for (let i = 0; i < hex.length; i += 4) t += String.fromCharCode(parseInt(hex.substr(i, 4), 16));
  } else {
    for (let i = 0; i + 1 < hex.length; i += 2) t += String.fromCharCode(parseInt(hex.substr(i, 2), 16));
  }
  return t;
}

/** 从一段已解码的内容流里抽文字。
 *  @param {Map<number,string>|null} cidMap CID→字符（来自 ToUnicode）；没有就尽力而为 */
function textFromContentStream(s, cidMap) {
  let out = '';
  const re = /\((?:\\.|[^\\()])*\)|<[0-9A-Fa-f\s]+>|\bT[dD]\b|\bT\*\b|\bTJ\b|\bTj\b|\bET\b/g;
  let m, pending = '';
  while ((m = re.exec(s)) !== null) {
    const tok = m[0];
    if (tok[0] === '(') {
      const inner = tok.slice(1, -1);
      const un = unescapePdfString(inner);
      // ★★ `[(<0001>) -50 (<0002>)] TJ` 是**极常见**的写法（TJ 数组带每字间距），
      //    里面的 `(<hex>)` 与 `<hex>` 是同一个意思 —— 但走 `(` 分支的话
      //    只会得到字面的 "<0001>" 字符串，**永远不会去查 CID 表**，
      //    于是中文 PDF 抽出来的是满屏 `<0002><0005>` 这种原始码（实测踩到）。
      //    判据：整个串就是一段**尖括号包着的**十六进制（`(<...>)` 的写法，
      //    括号不会被 unescape 吃掉）—— 才当十六进制解；
      //    否则老老实实当普通文本（真文字里出现 `<` 也是可能的，别误伤）。
      //    注意「有没有 cidMap」都要走这条路：带了映射就查表，没带就按
      //    裸 <hex> 的老行为尽力而为 —— 两条路必须**行为一致**，
      //    否则没映射时 TJ 数组会吐出字面的 "<00010002>"，
      //    而那是**纯 ASCII**，looksLikeText 会放行 ⇒ 原始码冒充正文（实测踩到）。
      const m2 = /^<([0-9A-Fa-f\s]+)>$/.exec(un);
      if (m2) {
        pending += decodeHexText(m2[1].replace(/\s+/g, ''), cidMap);
      } else {
        pending += un;
      }
    } else if (tok[0] === '<') {
      pending += decodeHexText(tok.slice(1, -1).replace(/\s+/g, ''), cidMap);
    } else if (tok === 'Td' || tok === 'TD' || tok === 'T*') {
      if (pending) { out += pending + '\n'; pending = ''; }
    } else if (tok === 'TJ' || tok === 'Tj') {
      out += pending; pending = '';
    } else if (tok === 'ET') {
      if (pending) { out += pending + '\n'; pending = ''; }
      out += '\n';
    }
  }
  if (pending) out += pending;
  return out;
}

// ================= 扫描件专用：把每页的位图抠出来 =================
// 教材/试卷扫描件是"整页一张图"，内容流里只有 `q ... cm /fzImg0 Do Q`，
// 没有任何字体。想读它只能 OCR 图片，所以先把图按页序抠出来。
// 这里全部自己实现（零依赖），只认经典结构；认不出就返回空数组，
// 让上层**如实报"认不出"**，不要硬猜出一堆错位的页。

/** 顺序扫出所有 `N 0 obj … endobj`，并记下 stream 的字节区间 */
function scanObjects(buf) {
  const raw = buf.toString('latin1');
  const re = /(\d+)\s+(\d+)\s+obj\b/g;
  const objs = new Map();
  let m, skipTo = -1;
  while ((m = re.exec(raw)) !== null) {
    if (m.index < skipTo) continue;              // 落在上一个流内部的"假对象头"
    const num = Number(m[1]);
    const headStart = m.index + m[0].length;
    const sIdx = raw.indexOf('stream', headStart);
    const eIdx = raw.indexOf('endstream', headStart);
    const endObj = raw.indexOf('endobj', headStart);
    const hasStream = sIdx >= 0 && eIdx >= 0 && (endObj < 0 || sIdx < endObj);
    const dictEnd = hasStream ? sIdx : (endObj >= 0 ? endObj : raw.length);
    let dataStart = -1, dataEnd = -1;
    if (hasStream) {
      dataStart = sIdx + 6;
      if (buf[dataStart] === 0x0d) dataStart++;
      if (buf[dataStart] === 0x0a) dataStart++;
      dataEnd = eIdx;
      while (dataEnd > dataStart && (buf[dataEnd - 1] === 0x0a || buf[dataEnd - 1] === 0x0d)) dataEnd--;
      skipTo = eIdx + 9;
    } else {
      skipTo = endObj >= 0 ? endObj + 6 : headStart;
    }
    objs.set(num, { num: num, dict: raw.slice(headStart, dictEnd), dataStart: dataStart, dataEnd: dataEnd });
  }
  return objs;
}

/** 取 `/Key` 的值：间接引用返回它指向对象的字典，内联则返回 `<<…>>` / `[…]` 原文 */
function dictValue(raw, dict, key, objs) {
  const idx = dict.indexOf('/' + key);
  if (idx < 0) return null;
  const rest = dict.slice(idx);
  const rm = /^\/[A-Za-z0-9_.#-]+\s+(\d+)\s+\d+\s+R/.exec(rest);
  if (rm && objs.has(Number(rm[1]))) return objs.get(Number(rm[1])).dict;
  const bi = rest.indexOf('<<'), li = rest.indexOf('[');
  const useArr = li >= 0 && (bi < 0 || li < bi);
  const open = useArr ? li : bi;
  if (open < 0) return null;
  const openTok = useArr ? '[' : '<<', closeTok = useArr ? ']' : '>>';
  let depth = 0;
  for (let i = open; i < rest.length; i++) {
    if (rest.startsWith(openTok, i)) { depth++; i += openTok.length - 1; }
    else if (rest.startsWith(closeTok, i)) { depth--; i += closeTok.length - 1; if (!depth) return rest.slice(open, i + 1); }
  }
  return null;
}

/** 取 `/Key N 0 R` 里的对象号（Contents 要的是**流**不是字典，不能走 dictValue） */
function dictRefNum(dict, key) {
  const m = new RegExp('/' + key + '\\s+(\\d+)\\s+\\d+\\s+R').exec(dict);
  return m ? Number(m[1]) : null;
}

function dictRefList(dict, key) {
  const m = new RegExp('/' + key + '\\s*\\[([^\\]]*)\\]').exec(dict);
  return m ? Array.from(m[1].matchAll(/(\d+)\s+\d+\s+R/g)).map(x => Number(x[1])) : [];
}

/** 字体数 / 图片数 / 页数 —— 用来判断"这是不是扫描件" */
function pdfInfo(buf) {
  const objs = scanObjects(buf);
  const info = { fonts: 0, images: 0, pages: 0, objects: objs.size };
  objs.forEach(o => {
    if (/\/Type\s*\/Page(?![A-Za-z])/.test(o.dict)) info.pages++;
    if (/\/Type\s*\/Font/.test(o.dict)) info.fonts++;
    if (/\/Subtype\s*\/Image/.test(o.dict)) info.images++;
  });
  return info;
}

/**
 * 按页序抠出每页的位图。
 * @returns {Array<{page:number, data:Buffer, filter:string, width:number, height:number}>}
 */
function pdfPageImages(buf) {
  const raw = buf.toString('latin1');
  const objs = scanObjects(buf);
  if (!objs.size) return [];
  const pages = [];
  objs.forEach(o => { if (/\/Type\s*\/Page(?![A-Za-z])/.test(o.dict)) pages.push(o); });
  pages.sort((a, b) => a.num - b.num);           // 页对象在文件里的先后 ≈ 页码先后
  const out = [];
  for (const pg of pages) {
    // ① 本页 XObject 名字表：/fzImg0 → 对象号
    const resDict = dictValue(raw, pg.dict, 'Resources', objs);
    const xo = {};
    if (resDict) {
      const xd = dictValue(raw, resDict, 'XObject', objs);
      if (xd) {
        const rre = /\/([A-Za-z0-9_.#-]+)\s+(\d+)\s+\d+\s+R/g;
        let mm;
        while ((mm = rre.exec(xd)) !== null) xo[mm[1]] = Number(mm[2]);
      }
    }
    // ② 内容流里 `/Name Do` 的先后就是贴图顺序
    let refs = dictRefList(pg.dict, 'Contents');
    if (!refs.length) { const one = dictRefNum(pg.dict, 'Contents'); if (one != null) refs = [one]; }
    let content = '';
    for (const cr of refs) {
      const co = objs.get(cr);
      if (!co || co.dataStart < 0) continue;
      let d = buf.slice(co.dataStart, co.dataEnd);
      if (/FlateDecode/.test(co.dict)) { const inf = tryInflate(d); if (inf) d = inf; }
      content += d.toString('latin1');
    }
    let imgNum = null;
    const dre = /\/([A-Za-z0-9_.#-]+)\s+Do\b/g;
    let dm;
    while ((dm = dre.exec(content)) !== null) {
      if (xo[dm[1]] != null) { imgNum = xo[dm[1]]; break; }
    }
    if (imgNum == null) continue;
    const io = objs.get(imgNum);
    if (!io || io.dataStart < 0 || !/\/Subtype\s*\/Image/.test(io.dict)) continue;
    const fm = /\/Filter\s*(\[[^\]]*\]|\/[A-Za-z0-9]+)/.exec(io.dict);
    out.push({
      page: out.length + 1,
      objNum: imgNum,
      data: buf.slice(io.dataStart, io.dataEnd),
      filter: fm ? fm[1].replace(/[\[\]\/\s]/g, '') : '',
      width: Number((/\/Width\s+(\d+)/.exec(io.dict) || [])[1] || 0),
      height: Number((/\/Height\s+(\d+)/.exec(io.dict) || [])[1] || 0),
    });
  }
  return out;
}

const SCANNED_NOTE = '这是一份**扫描件**（整页都是图片，没有文字层），正在用 AI 逐页识别文字，'
  + '识别完就能在上面提问、也能被 AI 引用。页数多的时候要等几分钟，可以先放着。';

function extractPdf(buf) {
  const raw = buf.toString('latin1');
  // ★ 先收齐字体里的 ToUnicode 映射 —— 中文 PDF 普遍是内嵌子集字体，
  //   没有这张表，内容流里的 CID 全是乱码（见 toUnicodeMaps 的注释）。
  const tu = toUnicodeMaps(buf);
  const cidMap = tu.map.size ? tu.map : null;
  const chunks = [];
  const re = /stream\r?\n?/g;
  let m;
  while ((m = re.exec(raw)) !== null) {
    const start = m.index + m[0].length;
    const end = raw.indexOf('endstream', start);
    if (end < 0) break;
    // 往前看字典，判断是否 FlateDecode
    const dictStart = Math.max(0, raw.lastIndexOf('<<', m.index));
    const dict = raw.slice(dictStart, m.index);
    let data = buf.slice(start, end);
    // 去掉尾部换行
    while (data.length && (data[data.length - 1] === 0x0a || data[data.length - 1] === 0x0d)) data = data.slice(0, -1);
    if (/FlateDecode/.test(dict)) {
      const inf = tryInflate(data);
      if (!inf) continue;
      data = inf;
    }
    const txt = textFromContentStream(data.toString('latin1'), cidMap);
    if (txt.trim()) chunks.push(txt);
  }
  let text = chunks.join('\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  // 去掉控制字符；以及 UTF-16 十六进制串开头常见的 BOM（<FEFF...> 是 CID 字体的标准写法）
  text = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').replace(/\uFEFF/g, '');
  const info = pdfInfo(buf);
  const pages = info.pages || (raw.match(/\/Type\s*\/Page[^s]/g) || []).length || (chunks.length || 0);
  if (!text || !looksLikeText(text)) {
    // ★ 抽不出文字时，先问一句「**有没有页图**」，因为那决定了这条路还能不能救：
    //   有图 → 可以像扫描件一样逐页 OCR（换个引擎去认，用户不用重新准备文件）；
    //   没图 → 真的是死路（既没文字层也没图），只能如实说明并建议换文件。
    //
    //   三种"读不出"要分清，但它们**都**归到 scanned（= 排队 OCR 的信号）：
    //     ① 零字体 + 有图      —— 经典扫描件
    //     ② 有字体 + 无 ToUnicode + 有图 —— CID 子集且没带映射表（中文 PDF 常见）
    //     ③ 有字体 + 有 ToUnicode，仍抽不出 + 有图 —— 映射表不全（映射表可能是残缺的）
    //   而「有字体、有 ToUnicode、却还是没有图」这种，映射已经在用了还读不出，
    //   说明不是映射问题，如实报"抽不出"比假装成扫描件更诚实。
    if (info.images > 0) {
      const why = info.fonts === 0
        ? SCANNED_NOTE
        : (cidMap
          ? '这份 PDF 有文字层，但字形映射不完整，没能可靠地抽出文字。正在用 AI 逐页识别，识别完就能在上面提问、也能被 AI 引用。'
          : '这份 PDF 用了内嵌子集字体且没带 Unicode 映射表，没能抽出文字。正在用 AI 逐页识别，识别完就能在上面提问、也能被 AI 引用。');
      return { text: '', pages: pages, scanned: true, fonts: info.fonts, images: info.images, note: why };
    }
    return {
      text: '', pages: pages, scanned: false, fonts: info.fonts, images: info.images,
      note: (info.fonts > 0
        ? '这份 PDF 的文字用了内嵌子集字体且没带 Unicode 映射表，'
        : '这份 PDF 里没有找到可用的文字层，')
        + '而它也没有可识别的整页图片，所以两条路都走不通。'
        + '建议：换成可复制文字的 PDF，或直接把关键段落贴进对话。',
    };
  }
  return { text: text, pages: pages, scanned: false, fonts: info.fonts, images: info.images, cidMapped: !!cidMap };
}

// ================= 统一入口 =================
const TEXT_EXT = ['txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'log', 'js', 'ts', 'py', 'html', 'htm', 'xml', 'yml', 'yaml', 'sql', 'css'];

function extOf(filename) {
  const m = /\.([A-Za-z0-9]+)$/.exec(String(filename || ''));
  return m ? m[1].toLowerCase() : '';
}

/** 支持的文件类型（按扩展名分派） */
const OFFICE_EXT = ['pdf', 'docx', 'doc', 'xlsx', 'xlsm', 'xls', 'pptx'];
const KNOWN_EXT = OFFICE_EXT.concat(TEXT_EXT);

/** 旧版 Office（.doc/.xls/.ppt）的 OLE 复合文档魔数 */
const OLE_MAGIC = Buffer.from([0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1]);

/**
 * 按**字节**猜真实类型。
 *
 * 为什么必须有这一步：聊天窗口粘贴过来的文件常常拿不到可信文件名 ——
 * 前端取不到 type 时只能起名 `.bin`（见 app.js 的 paste 监听），
 * 而 `.bin` 正好落到「暂不支持」分支，结果就是**粘贴的 Word/PDF 一律读不出来**，
 * 用户看到的现象是"AI 没读我的文档"。扩展名是别人给的，字节是自己长的，冲突时信字节。
 *
 * @returns {'pdf'|'docx'|'xlsx'|'pptx'|'ole'|'rtf'|''}
 */
function sniffType(buf) {
  if (!buf || buf.length < 4) return '';
  const head5 = buf.slice(0, 5).toString('latin1');
  if (head5 === '%PDF-') return 'pdf';
  if (head5 === '{\\rtf') return 'rtf';
  if (buf.length >= 8 && buf.slice(0, 8).equals(OLE_MAGIC)) return 'ole';
  // ZIP 容器：OOXML 三兄弟靠内部条目名区分（docx 有 word/、xlsx 有 xl/、pptx 有 ppt/）
  if (buf[0] === 0x50 && buf[1] === 0x4B) {
    const z = unzip(buf);
    if (z) {
      const keys = Object.keys(z);
      if (keys.some(k => k.indexOf('word/') === 0)) return 'docx';
      if (keys.some(k => k.indexOf('xl/') === 0)) return 'xlsx';
      if (keys.some(k => k.indexOf('ppt/') === 0)) return 'pptx';
    }
  }
  return '';
}

const OLE_NOTE = '这是旧版 Office 的二进制格式（.doc/.xls/.ppt），本服务解析不了。'
  + '用 WPS 或 Office 打开后「另存为」成 .docx / .xlsx / .pptx，再传一次就能读了。';
const RTF_NOTE = 'RTF 富文本格式暂不支持。用 WPS 或 Office 另存为 .docx，再传一次就能读了。';

/**
 * @param {Buffer} buf
 * @param {string} filename
 * @returns {{text:string, pages:number, kind:string, note?:string, ok:boolean}}
 */
function extract(buf, filename) {
  const rawExt = extOf(filename);
  let ext = rawExt;
  let sniffed = '';
  // 扩展名不可信（粘贴来的 .bin、或干脆没扩展名）→ 先看字节再决定用哪个解析器
  if (KNOWN_EXT.indexOf(rawExt) < 0) {
    sniffed = sniffType(buf);
    if (sniffed === 'ole') return { text: '', pages: 0, kind: 'ole', ok: false, note: OLE_NOTE, sniffed: 'ole' };
    if (sniffed === 'rtf') return { text: '', pages: 0, kind: 'rtf', ok: false, note: RTF_NOTE, sniffed: 'rtf' };
    if (sniffed) ext = sniffed;
  }
  try {
    if (ext === 'pdf') {
      const r = extractPdf(buf);
      // scanned 要带出去：上层据此决定「排队 OCR」还是「如实报失败」。
      return {
        text: r.text, pages: r.pages, kind: 'pdf', note: r.note, ok: !!r.text,
        scanned: !!r.scanned, fonts: r.fonts || 0, images: r.images || 0,
      };
    }
    if (ext === 'docx') {
      const r = extractDocx(buf);
      return { text: r.text, pages: 0, kind: 'docx', note: r.note, ok: !!r.text };
    }
    if (ext === 'doc') {
      return { text: '', pages: 0, kind: 'doc', ok: false, note: '旧版 .doc 是二进制格式，无法可靠解析。请另存为 .docx 后重新上传。' };
    }
    if (ext === 'xlsx' || ext === 'xlsm') {
      const r = extractXlsx(buf);
      return { text: r.text, pages: 0, kind: 'xlsx', note: r.note, ok: !!r.text };
    }
    if (ext === 'xls') {
      return { text: '', pages: 0, kind: 'xls', ok: false, note: '旧版 .xls 是二进制格式，无法可靠解析。请另存为 .xlsx 后重新上传。' };
    }
    if (ext === 'pptx') {
      const z = unzip(buf);
      if (!z) return { text: '', pages: 0, kind: 'pptx', ok: false, note: '不是有效的 pptx' };
      const slides = Object.keys(z).filter(k => /^ppt\/slides\/slide\d+\.xml$/.test(k))
        .sort((a, b) => Number(/(\d+)/.exec(a)[1]) - Number(/(\d+)/.exec(b)[1]));
      const out = slides.map((s, i) => '【第 ' + (i + 1) + ' 页】\n' + xmlToText(z[s].toString('utf8')));
      const text = out.join('\n\n');
      return { text: text, pages: slides.length, kind: 'pptx', ok: !!text, note: text ? undefined : '这份 PPT 里没有可提取的文字' };
    }
    // 纯文本类
    let text = buf.toString('utf8');
    if (text.indexOf('\uFFFD') >= 0) {
      const gbk = buf.toString('latin1');
      if (gbk.indexOf('\uFFFD') < 0) text = gbk;
    }
    text = text.replace(/\r\n?/g, '\n');
    if (ext === 'csv' || ext === 'tsv') {
      return { text: text, pages: 0, kind: ext, ok: !!text.trim() };
    }
    if (TEXT_EXT.indexOf(ext) >= 0 || !ext) {
      return { text: text, pages: 0, kind: ext || 'text', ok: !!text.trim(), sniffed: sniffed || undefined };
    }
    // 走到这里 = 扩展名不认识、字节也没认出格式（既不是 PDF/Office，也不是 ZIP 容器）。
    // 内容确实像文字就照收 —— 很多"粘贴的文件"其实是纯文本，只是名字丢了。
    if (looksLikeText(text)) {
      return { text: text, pages: 0, kind: 'text', ok: true, sniffed: 'text' };
    }
    return { text: '', pages: 0, kind: ext || 'unknown', ok: false,
      note: '这个格式暂不支持（名字是「' + String(filename || '未命名') + '」，按内容也没认出是 PDF / Word / 表格或文本）。'
        + '如果它是 Word 或 PDF，试试用输入框左边的「＋」按钮重新选一次原文件。' };
  } catch (e) {
    return { text: '', pages: 0, kind: ext || '?', ok: false, note: '解析出错：' + (e.message || e) };
  }
}

module.exports = {
  extract, extOf, sniffType, unzip, looksLikeText, extractPdf, extractDocx, extractXlsx,
  textFromContentStream, unescapePdfString,
  // 子集字体（ToUnicode）
  parseToUnicode, toUnicodeMaps, dictRefNum,
  // 扫描件链路
  scanObjects, pdfInfo, pdfPageImages, SCANNED_NOTE,
};

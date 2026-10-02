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

/** 从一段已解码的内容流里抽文字 */
function textFromContentStream(s) {
  let out = '';
  const re = /\((?:\\.|[^\\()])*\)|<[0-9A-Fa-f\s]+>|\bT[dD]\b|\bT\*\b|\bTJ\b|\bTj\b|\bET\b/g;
  let m, pending = '';
  while ((m = re.exec(s)) !== null) {
    const tok = m[0];
    if (tok[0] === '(') pending += unescapePdfString(tok.slice(1, -1));
    else if (tok[0] === '<') {
      const hex = tok.slice(1, -1).replace(/\s+/g, '');
      let t = '';
      if (hex.length % 4 === 0 && /^[0-9A-Fa-f]+$/.test(hex)) {
        // 2 字节一字符（常见于 CID 字体），尽力而为
        for (let i = 0; i < hex.length; i += 4) t += String.fromCharCode(parseInt(hex.substr(i, 4), 16));
      } else {
        for (let i = 0; i + 1 < hex.length; i += 2) t += String.fromCharCode(parseInt(hex.substr(i, 2), 16));
      }
      pending += t;
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

function extractPdf(buf) {
  const raw = buf.toString('latin1');
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
    const txt = textFromContentStream(data.toString('latin1'));
    if (txt.trim()) chunks.push(txt);
  }
  let text = chunks.join('\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  // 去掉控制字符；以及 UTF-16 十六进制串开头常见的 BOM（<FEFF...> 是 CID 字体的标准写法）
  text = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').replace(/\uFEFF/g, '');
  const pages = (raw.match(/\/Type\s*\/Page[^s]/g) || []).length || (chunks.length || 0);
  if (!text || !looksLikeText(text)) {
    return {
      text: '', pages: pages,
      note: '这份 PDF 的文字用了内嵌子集字体或扫描图片，没能抽出可用的文字。建议：换成可复制文字的 PDF，或直接把关键段落贴进对话。',
    };
  }
  return { text: text, pages: pages };
}

// ================= 统一入口 =================
const TEXT_EXT = ['txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'log', 'js', 'ts', 'py', 'html', 'htm', 'xml', 'yml', 'yaml', 'sql', 'css'];

function extOf(filename) {
  const m = /\.([A-Za-z0-9]+)$/.exec(String(filename || ''));
  return m ? m[1].toLowerCase() : '';
}

/**
 * @param {Buffer} buf
 * @param {string} filename
 * @returns {{text:string, pages:number, kind:string, note?:string, ok:boolean}}
 */
function extract(buf, filename) {
  const ext = extOf(filename);
  try {
    if (ext === 'pdf') {
      const r = extractPdf(buf);
      return { text: r.text, pages: r.pages, kind: 'pdf', note: r.note, ok: !!r.text };
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
      return { text: text, pages: 0, kind: ext || 'text', ok: !!text.trim() };
    }
    return { text: '', pages: 0, kind: ext, ok: false, note: '暂不支持 .' + ext + ' 格式' };
  } catch (e) {
    return { text: '', pages: 0, kind: ext || '?', ok: false, note: '解析出错：' + (e.message || e) };
  }
}

module.exports = { extract, extOf, unzip, looksLikeText, extractPdf, extractDocx, extractXlsx, textFromContentStream, unescapePdfString };

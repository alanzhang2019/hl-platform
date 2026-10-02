'use strict';
/**
 * 网页正文读取（顺着学生发的链接去看）
 *
 * 学生直接把一个链接甩过来时，AI 应该**真的打开看**，而不是把 URL 当成关键词去搜。
 * （搜索接口拿到 "https://…" 只会搜到一堆转载页，答出来的东西和那个页面无关。）
 *
 * 四条硬约束：
 *  1) ★ **必须防 SSRF**：服务器会去 fetch 用户给的任意 URL。不做校验的话，
 *     任何人只要把链接发进来，就能让服务器去打内网 / 云元数据服务
 *     （169.254.169.254 能拿到实例凭证）。所以要：只放行 http(s)、
 *     **逐跳**校验重定向目标、对域名做 DNS 解析后校验每个 IP、禁内网字面量。
 *  2) **读不到就如实说**：抓取失败要明确告诉模型"没读到"。
 *     教育产品里，模型编一段"这个网页说的是…"比不回答坏得多 —— 学生没法分辨。
 *  3) **正文要截断**：一篇长文几万字，整段塞进上下文会把对话历史挤掉。
 *     默认 6000 字/页、最多 3 页。
 *  4) **不引入第三方解析库**：只要 title + 正文文字，正则足够；少一个依赖少一处供应链风险。
 */
const dns = require('dns').promises;

const MAX_LINKS = 3;
const MAX_CHARS = 6000;
const TIMEOUT_MS = 10000;
const MAX_REDIRECTS = 3;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

// 结尾的中文标点也要排除掉 —— 学生常写「看这个：https://x.com/a。」，句号不能带进 URL
const URL_RE = /https?:\/\/[^\s<>"'`）)】」,，。；;]+/gi;

// ---------------------------------------------------------------- URL 抽取

function extractUrls(text, max) {
  const limit = Math.max(1, Number(max) || MAX_LINKS);
  const out = [];
  const seen = new Set();
  const s = String(text || '');
  URL_RE.lastIndex = 0;
  let m;
  while ((m = URL_RE.exec(s))) {
    const u = m[0].replace(/[.,;:!?、，。；：！？]+$/, '');
    if (!u || seen.has(u)) continue;
    seen.add(u);
    out.push(u);
    if (out.length >= limit) break;
  }
  return out;
}

// ---------------------------------------------------------------- SSRF 防护

/** 这个主机名/IP 是不是"本机或内网" —— 是的话绝不能去 fetch */
function isPrivateHost(hostname) {
  let h = String(hostname || '').toLowerCase().trim().replace(/^\[/, '').replace(/\]$/, '');
  if (!h) return true;
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.home.arpa')) return true;

  const m4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m4) {
    const a = Number(m4[1]); const b = Number(m4[2]);
    if ([a, b, Number(m4[3]), Number(m4[4])].some(n => n > 255)) return true;  // 畸形地址，一律拒
    if (a === 0 || a === 127 || a === 10) return true;          // 本机 / 私网 A
    if (a === 172 && b >= 16 && b <= 31) return true;           // 私网 B
    if (a === 192 && b === 168) return true;                    // 私网 C
    if (a === 169 && b === 254) return true;                    // 链路本地（云元数据 169.254.169.254）
    if (a === 100 && b >= 64 && b <= 127) return true;          // CGNAT
    if (a >= 224) return true;                                  // 组播 / 保留
    return false;
  }

  if (h.includes(':')) {                                        // IPv6
    if (h === '::' || h === '::1') return true;
    if (/^f[cd]/.test(h)) return true;                          // fc00::/7 唯一本地
    if (/^fe80/.test(h)) return true;                           // 链路本地
    return false;
  }
  return false;
}

/**
 * 主机安全性：'ok' | 'private' | 'unresolved'。
 *
 * 为什么是三态而不是一个布尔：**"指向内网"和"解析不了"对学生是两件完全不同的事**。
 * 合成一个布尔之后，一个打错字母的域名会被报成"这个地址指向本机或内网"——
 * 他照着这句话去排查，永远查不出是自己少打了一个字母，只会来投诉"AI 坏了"。
 *
 * 字面量判过之后还要看 DNS 结果：域名可以解析到 127.0.0.1（DNS rebinding 的入门版）。
 */
async function checkHost(hostname) {
  const h = String(hostname || '').replace(/^\[/, '').replace(/\]$/, '');
  if (!h) return 'unresolved';
  if (isPrivateHost(h)) return 'private';
  if (/^[\d.]+$/.test(h) || h.includes(':')) return 'ok';       // 已经是 IP，上面判过了
  try {
    const addrs = await dns.lookup(h, { all: true });
    if (!addrs.length) return 'unresolved';
    return addrs.some(a => isPrivateHost(a.address)) ? 'private' : 'ok';
  } catch (e) {
    return 'unresolved';                                        // 解析不了就别去 fetch
  }
}

/** 便捷封装：true = 不能去抓 */
async function resolvesPrivate(hostname) {
  return (await checkHost(hostname)) !== 'ok';
}

// ---------------------------------------------------------------- HTML → 文本

const ENT = {
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", middot: '·',
  hellip: '…', mdash: '—', ndash: '–', ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’',
  laquo: '«', raquo: '»', times: '×', divide: '÷', deg: '°', copy: '©', reg: '®',
};

function decodeEntities(s) {
  return String(s || '').replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (m, g) => {
    if (g[0] === '#') {
      const isHex = g[1] === 'x' || g[1] === 'X';
      const code = isHex ? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return m;
      try { return String.fromCodePoint(code); } catch (e) { return m; }
    }
    const v = ENT[g.toLowerCase()];
    return v === undefined ? m : v;
  });
}

function htmlToText(html) {
  let s = String(html || '');
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');

  // ★ 先把 <title> 捞出来，**再**删 <head> —— 顺序反了的话 head 一删，标题也跟着没了
  //   （啃过这个坑：页面标题是判断"抓对了没有"最直接的信号，丢了很难看出问题）
  const tm = s.match(/<title[^>]*>([\s\S]*?)<\/title\s*>/i);
  const title = tm ? decodeEntities(tm[1]).replace(/\s+/g, ' ').trim().slice(0, 200) : '';

  // 脚本/样式/SVG 一定整块删掉 —— 不删的话 <script> 里的代码会被当成正文喂给模型
  s = s.replace(/<(script|style|noscript|svg|template|head)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ');

  let body = s;
  const art = s.match(/<article\b[^>]*>([\s\S]*?)<\/article\s*>/i)
    || s.match(/<main\b[^>]*>([\s\S]*?)<\/main\s*>/i);
  if (art) body = art[1];
  else {
    const b = s.match(/<body\b[^>]*>([\s\S]*?)<\/body\s*>/i);
    if (b) body = b[1];
  }

  // 块级标签换成换行，否则整页文字会挤成一行，模型读起来分不清段落
  body = body.replace(/<\s*br\s*\/?>/gi, '\n');
  body = body.replace(/<\s*\/\s*(p|div|li|h[1-6]|tr|section|article|blockquote)\s*>/gi, '\n');
  body = body.replace(/<[^>]*>/g, ' ');
  body = decodeEntities(body);
  body = body.replace(/[ \t\u00a0\u3000]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { title, text: body };
}

// ---------------------------------------------------------------- 抓取

/** 抓一页。**任何失败都返回 {ok:false, message} 而不是抛** —— 上层要能原样转达给学生 */
async function fetchOne(rawUrl, o) {
  const opts = o || {};
  const maxChars = Number(opts.maxChars) || MAX_CHARS;
  const timeoutMs = Number(opts.timeoutMs) || TIMEOUT_MS;
  const started = String(rawUrl || '').trim();
  let url = started;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let u;
    try { u = new URL(url); } catch (e) { return { ok: false, url: started, reason: 'BAD_URL', message: '这不是一个有效的网址' }; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      return { ok: false, url: started, reason: 'BAD_SCHEME', message: '只支持 http/https 开头的链接' };
    }
    const safety = await checkHost(u.hostname);
    if (safety === 'private') {
      return { ok: false, url: started, reason: 'PRIVATE', message: '这个地址指向本机或内网，出于安全考虑不去读取' };
    }
    if (safety === 'unresolved') {
      return { ok: false, url: started, reason: 'DNS', message: '打不开这个网址（域名解析不了，检查一下是不是打错了）' };
    }

    let res;
    try {
      res = await fetch(u.href, {
        redirect: 'manual',
        headers: {
          'User-Agent': UA,
          Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5',
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.6',
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      const raw = String((e && e.message) || e);
      const msg = /abort|timeout/i.test(raw) ? '打开超时（' + Math.round(timeoutMs / 1000) + ' 秒没响应）'
        : '打不开（' + raw.slice(0, 60) + '）';
      return { ok: false, url: started, reason: 'FETCH', message: msg };
    }

    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers && res.headers.get ? res.headers.get('location') : '';
      if (!loc) return { ok: false, url: started, reason: 'REDIRECT', message: '页面要求跳转，但没给出目标地址' };
      try { url = new URL(loc, u.href).href; } catch (e) { return { ok: false, url: started, reason: 'REDIRECT', message: '跳转目标地址不合法' }; }
      continue;                                  // ★ 下一跳会重新过一遍内网校验
    }
    if (!res.ok) return { ok: false, url: started, reason: 'HTTP', message: '网页返回 ' + res.status };

    const ctype = String((res.headers && res.headers.get ? res.headers.get('content-type') : '') || '');
    if (ctype && !/text\/html|application\/xhtml|text\/plain/i.test(ctype)) {
      return { ok: false, url: started, reason: 'TYPE', message: '这不是一个网页（' + (ctype.split(';')[0] || '未知类型') + '），我看不了里面是什么' };
    }

    let raw = '';
    try { raw = await res.text(); } catch (e) { return { ok: false, url: started, reason: 'READ', message: '网页内容读不出来' }; }

    const parsed = htmlToText(raw);
    let text = parsed.text;
    const truncated = text.length > maxChars;
    if (truncated) text = text.slice(0, maxChars);
    if (!text) {
      return { ok: false, url: started, reason: 'EMPTY', message: '这个页面里没有可读的文字（可能是纯图片，或者要登录才看得到）' };
    }
    return { ok: true, url: started, finalUrl: u.href, title: parsed.title, text, truncated, chars: text.length };
  }
  return { ok: false, url: started, reason: 'LOOP', message: '跳转次数太多，放弃了' };
}

/**
 * 读一批链接。**不抛错**：成功与失败都原样返回，由上层决定怎么说。
 * 并发抓 —— 三个链接串行 + 各自 10 秒超时就是 30 秒白等。
 */
async function readLinks(urls, o) {
  const opts = o || {};
  const list = (Array.isArray(urls) ? urls : []).filter(Boolean).slice(0, Number(opts.limit) || MAX_LINKS);
  if (!list.length) return { ok: false, pages: [], failed: [] };
  const settled = await Promise.all(list.map(u => fetchOne(u, opts)
    .catch(e => ({ ok: false, url: String(u), reason: 'ERROR', message: String((e && e.message) || e).slice(0, 80) }))));
  const pages = settled.filter(x => x.ok);
  const failed = settled.filter(x => !x.ok);
  return { ok: pages.length > 0, urlCount: list.length, pages, failed };
}

/** 拼成给模型的一段上下文 */
function linkContext(res) {
  if (!res) return '';
  const parts = [];
  if (res.pages && res.pages.length) {
    parts.push('【学生发来的链接（已读取正文）】');
    res.pages.forEach((p, i) => {
      parts.push('[链接' + (i + 1) + '] ' + (p.title || '（无标题）') + '\n' + p.finalUrl + '\n' + p.text +
        (p.truncated ? '\n…（页面过长，已截断）' : ''));
    });
    parts.push('以上是网页的**真实内容**，可以直接依据它回答。引用时说明是第几个链接；'
      + '仍然不要直接把结论给学生，用这些材料去反问。');
  }
  if (res.failed && res.failed.length) {
    parts.push('【没读到的链接】\n' + res.failed.map(f => '- ' + f.url + '：' + f.message).join('\n') +
      '\n**这些页面你没看到内容，不要假装看过**，直接说明没读到、并请他贴文字或换一个链接。');
  }
  return parts.join('\n\n');
}

module.exports = {
  MAX_LINKS, MAX_CHARS, TIMEOUT_MS, MAX_REDIRECTS,
  extractUrls, isPrivateHost, checkHost, resolvesPrivate, decodeEntities, htmlToText,
  fetchOne, readLinks, linkContext,
};

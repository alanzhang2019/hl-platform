/* 联网搜索
 *
 * 三条设计原则：
 *   1. **没配也能用**。以前只有配了 WEB_SEARCH_URL 才能联网，没配就直接报
 *      「暂时不可用」——用户看到的是"联网功能测试无效"。内置一条零依赖通道兜底，
 *      环境变量只是"想换更好的源"时的覆盖，不是能不能用的前提。
 *   2. **不假装搜过**。任何一路失败都必须能让前端说出来"本条回答未联网"。
 *      静默降级成离线回答，比不能联网糟糕得多：学生会拿它当事实引用。
 *   3. **结果要能被引**。title / url / snippet 三件套缺一不可，
 *      模型回答里要能标出"这是哪来的"。
 */
'use strict';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const DEFAULT_TIMEOUT_MS = 12000;
const MAX_LIMIT = 10;

// 没能联网时统一用这一句。前端有一处默认文案、测试有一致性断言，散着写迟早对不上。
const OFFLINE_MESSAGE = '联网搜索暂时不可用，本条回答未联网';
const EMPTY_MESSAGE = '没有搜到相关网页';
// 结果跟问题八竿子打不着时（搜索引擎丢词回退的产物）用这一句 —— 不能混同于"没搜到"
const IRRELEVANT_MESSAGE = '没有搜到跟这个问题直接相关的网页';

// 查询词命中率低于这个值就判定"这条不是在为这个问题服务"。
// 0.25 是照真机样本定的：搜「深圳中考数学高频考点」得到的「深圳市_百度百科」命中 1/9 ≈ 11%（杀掉），
// 而搜索结果只要真的沾上了两三个关键词（如「深圳中考数学考点分析」命中 4/9 ≈ 44%）就能过。
const REL_MIN_RATIO = 0.25;

// ---------------------------------------------------------------- 配置
function searchConfig() {
  const url = (process.env.WEB_SEARCH_URL || '').trim();
  // 关掉内置通道的唯一理由：部署环境明确不允许出网，留如实报错比挂半天强。
  const builtin = String(process.env.WEB_SEARCH_BUILTIN || '').trim() !== 'off';
  return {
    url: url,
    key: (process.env.WEB_SEARCH_API_KEY || '').trim(),
    builtin: builtin,
    // 以前 enabled 等价于"配了 URL"，这是"联网无效"的根因。
    enabled: !!url || builtin,
  };
}

// ---------------------------------------------------------------- HTML / 实体
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'", nbsp: ' ', '#160': ' ' };

/** 反复解直到稳定 —— `&amp;lt;` 解一次还剩 `<`，这种嵌套实体在搜索引擎的结果里很常见。 */
function decodeEntities(s) {
  let out = String(s == null ? '' : s);
  for (let i = 0; i < 3; i++) {
    const next = out.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, k) => {
      const low = k.toLowerCase();
      if (ENT[low] != null) return ENT[low];
      if (/^#x/i.test(k)) { const n = parseInt(k.slice(2), 16); return Number.isFinite(n) ? String.fromCodePoint(n) : m; }
      if (/^#/.test(k)) { const n = parseInt(k.slice(1), 10); return Number.isFinite(n) ? String.fromCodePoint(n) : m; }
      return ENT[low] != null ? ENT[low] : m;
    });
    if (next === out) break;
    out = next;
  }
  return out;
}

function stripTags(s) {
  return String(s == null ? '' : s).replace(/<[^>]*>/g, ' ');
}

/**
 * RSS / HTML 片段 → 一行干净的中文摘要。
 *
 * ★ 顺序不能换：必须先解实体、再剥标签。
 *   搜索引擎的描述经常把标签**实体编码**过（`&lt;b&gt;`）——只剥标签的话，
 *   解完实体才现形的 `<b>` 会原样漏进给模型的上下文里。
 *   所以剥两次：解之前一次、解之后再一次（后者抓"解出来才成形的标签"）。
 */
function snip(s, max) {
  let t = stripTags(String(s == null ? '' : s));
  t = decodeEntities(t);
  t = stripTags(t);
  t = t.replace(/\s+/g, ' ').trim();
  const cap = max || 300;
  return t.length > cap ? t.slice(0, cap) + '…' : t;
}

/** 从 XML 里取一个标签的内容（CDATA 也算） */
function tagText(xml, name) {
  const m = new RegExp('<' + name + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + name + '>', 'i').exec(xml);
  if (!m) return '';
  return String(m[1] || '').replace(/^\s*<!\[CDATA\[/, '').replace(/\]\]>\s*$/, '');
}

function xmlItems(xml) {
  return xml.match(/<item(?:\s[^>]*)?>[\s\S]*?<\/item>/gi) || [];
}

function safeUrl(u) {
  const s = String(u || '').trim();
  return /^https?:\/\//i.test(s) ? s : '';
}

function cleanResults(list, limit) {
  const seen = {};
  const out = [];
  (Array.isArray(list) ? list : []).forEach(r => {
    if (!r) return;
    const url = safeUrl(r.url);
    // 没有 URL 的结果对"可以追问出处"这件事毫无用处，宁可丢掉
    if (!url || seen[url]) return;
    const title = snip(r.title, 120);
    if (!title) return;
    seen[url] = 1;
    out.push({ title: title, url: url, snippet: snip(r.snippet, 300) });
    if (out.length >= limit) return false;   // forEach 里的 return false 只是跳出本轮；下面再切一刀
  });
  return out.slice(0, limit);
}

// ---------------------------------------------------------------- 相关性把关
/**
 * ★★★ 为什么必须有这一层（真机踩出来的）：
 *
 * 搜「深圳中考数学高频考点」，Bing 返回的全是「深圳市_百度百科 / 百度地图 / 深圳政府在线」。
 * 这不是我们解析错了，而是搜索引擎的**词元回退**：长查询找不到结果时，
 * 它就只保留主实体继续捞，于是"中考数学"被无声丢掉，只剩"深圳"。
 *
 * 后果比搜不到严重得多：`ok=true` + 5 条结果 ⇒ 系统会**当成查到了**喂给模型，
 * 模型手里握着一堆"深圳景点"，却被告知这些是"中考数学考点"的材料 ——
 * 它只能照着编。学生拿到的是一段语气笃定的胡说。
 *
 * 所以这里按"查询词命中比例"卡一道：命中率太低的整批丢掉，如实回"没搜到相关的"。
 * 宁肯让模型凭自己的知识答（它会明说是凭记忆），也不给它假材料。
 */

// 只统计有区分度的词。单字和虚词在任何网页里都命中，留着会把门槛稀释成零。
const STOPWORDS = ['的', '了', '是', '在', '和', '与', '或', '就', '都', '也', '很', '太', '不', '有', '没',
  '这', '那', '个', '们', '我', '你', '他', '它', '把', '被', '给', '让', '要', '会', '能', '到', '对', '从',
  '怎么', '怎样', '什么', '为什么', '哪些', '多少', '请问', '帮忙', '谢谢', '一下', '一个', '可以', '如何',
  '帮我', '我想', '请帮', '的是', '的是'];

/** 把查询切成一组"有区分度的词"。中文滑窗成 2-gram —— 没有分词库，但够用。 */
function grams(s) {
  const t = String(s == null ? '' : s).toLowerCase();
  const out = [];
  // 按非「中英数」劈成段：英文题目里混杂符号是常态
  t.split(/[^a-z0-9\u4e00-\u9fff]+/).forEach(w => {
    if (w.length < 2) return;
    if (/[a-z0-9]/.test(w)) out.push(w);            // 英文/数字整段算一个词
    const cn = w.replace(/[^一-鿿]/g, '');     // 剥掉段里混排的英数，只留中文再滑窗
    for (let i = 0; i + 2 <= cn.length; i++) {
      const g = cn.slice(i, i + 2);
      if (STOPWORDS.indexOf(g) < 0) out.push(g);
    }
  });
  return Array.from(new Set(out));
}

/** 一条结果命中了查询词的百分之多少 */
function relevance(hit, gs) {
  if (!gs.length) return 1;
  const text = String(hit.title || '') + ' ' + String(hit.snippet || '');
  const low = text.toLowerCase();
  let n = 0;
  gs.forEach(g => { if (low.indexOf(g) >= 0) n++; });
  return n / gs.length;
}

/**
 * 只留下真的在讲这个问题的结果。
 * @returns {{kept:Array, dropped:number}}
 */
function relevantResults(query, list, minRatio) {
  const arr = (Array.isArray(list) ? list : []).filter(Boolean);   // 源里混 null 是常态
  const gs = grams(query);
  if (!gs.length) return { kept: arr, dropped: 0 };   // 切不出词就别自作聪明地筛
  const thr = typeof minRatio === 'number' ? minRatio : REL_MIN_RATIO;
  const kept = arr.filter(h => relevance(h, gs) >= thr);
  return { kept: kept, dropped: arr.length - kept.length };
}

// ---------------------------------------------------------------- 内置通道
/**
 * ★★ 这一段的历史要写清楚，不然迟早有人把 Bing 加回来。
 *
 * v1（2026-10-02 白天）：只有 Bing 的 `&format=rss`。理由很充分——返回干净 XML、
 *   正则可拆、零依赖。本地假数据测试全绿，看起来修好了"联网无效"。
 *
 * v1 在真机上是怎么塌的：同一台机器真跑去搜「一元二次方程 判别式」，
 *   Bing 返回的全是**汉字"一"的字典词条**（百度百科"一（汉语汉字）"、汉典、汉语国学…）。
 *   搜「深圳中考数学高频考点」返回"深圳市_百度百科 / 百度地图 / 深圳政府在线"。
 *   www / cn 两个域、XML / HTML 两种格式、带不带 cc=CN 全部一样 ——
 *   是搜索引擎的**词元回退**，跟我们的解析无关，也不是偶发。
 *
 * 所以：**能不能通 ≠ 有没有用**。三个引擎同批实测，只有搜狗 / 360 给出了真相关的结果。
 * 现在改成多源择优：按质量排序依次试，第一个"真有货"的就用。
 * 而 Bing 留在队尾 —— 换个出口 IP 它可能就正常了，但绝不能再是唯一的一条路。
 */

/** 相对链接补全成绝对链接。跳转链虽然难看，但点得开，学生能核到出处。 */
function absUrl(u, base) {
  const s = String(u || '').trim();
  if (!s) return '';
  if (/^https?:\/\//i.test(s)) return s;
  if (/^\/\//.test(s)) return 'https:' + s;
  if (/^\//.test(s)) return String(base || '').replace(/\/+$/, '') + s;
  return '';                       // 其它形态（javascript: 等）一律不要
}

/** HTML 实体与标签一起清干净 —— 复用 solr؟ 不，这里是解 HTML 不是解 RSS，走 stripTags 的老路。 */
function htmlText(s) {
  const t = stripTags(s);
  return decodeEntities(t).replace(/\s+/g, ' ').trim();
}

/** 从一段 HTML 里抠 `<h3><a href="..">标题</a></h3>` */
function anchorTitle(block) {
  const h = /<h[23][^>]*>([\s\S]*?)<\/h[23]>/i.exec(block);
  if (!h) return null;
  const a = /<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/i.exec(h[1]);
  if (!a) return null;
  // ★ href 里带着 &amp;（微信/搜狗跳转链常见）——不解的话学生点进去是坏的参数
  return { url: decodeEntities(a[1]), title: htmlText(a[2]) };
}

/**
 * 摘要里有些值等于没有内容：搜狗给百度文库的结果，摘要一整块就是"Word文档""PPT文档"。
 * 这种塞给模型是噪音，还会让它以为通篇就在讲 Word。宁可不给摘要，只给标题。
 */
function meaningfulSnippet(s) {
  const t = String(s || '').trim();
  if (t.length < 12) return '';
  if (/^(word|ppt|pdf|excel|txt|xls|doc)\s*(文档|课件|格式)?$/i.test(t)) return '';
  if (/^(文档|课件|表格|压缩包)$/.test(t)) return '';
  return snip(t, 300);
}

async function fetchHtml(url, timeoutMs) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9', 'Accept': 'text/html,*/*' },
    signal: AbortSignal.timeout(timeoutMs || DEFAULT_TIMEOUT_MS),
    redirect: 'follow',
  });
  if (!res.ok) throw new Error('搜索通道返回 ' + res.status);
  const t = await res.text();
  // 反爬页不是"没搜到"，是"这条路被掐了"。如实抛出，好让下一个源接手。
  if (/请输入验证码|滑动验证|antispider|verify\.sogou|captcha/i.test(t.slice(0, 6000))) {
    throw new Error('被判定为爬虫，已跳过');
  }
  return t;
}

/** 搜狗：结果包在 <div class="vrwrap|rb"> 里 */
function parseSogou(html) {
  const out = [];
  html.split(/<div[^>]*class="(?:vrwrap|rb)["\s>]/i).slice(1).forEach(b => {
    const a = anchorTitle(b);
    if (!a || !a.title) return;
    const body = /class="[^"]*(?:text-layout|star-wiki|fz-mid)[^"]*"[^>]*>([\s\S]*?)<\/(?:div|p)>/i.exec(b);
    out.push({ title: a.title, url: a.url, snippet: meaningfulSnippet(body ? htmlText(body[1]) : '') });
  });
  return out;
}

/** 360：结果包在 <li class="res-list..."> 里。★ 首条常是 ai.so.com 的 AI 摘要，必须滤掉。 */
function parse360(html) {
  const out = [];
  (html.match(/<li[^>]*class="res-list[\s\S]*?<\/li>/gi) || []).forEach(b => {
    const a = anchorTitle(b);
    if (!a || !a.title) return;
    const u = absUrl(a.url, 'https://www.so.com');
    if (/^https?:\/\/ai\.so\.com/i.test(u)) return;   // 那是答案不是出处，不能当网页引
    const d = /<p[^>]*class="[^"]*res-(?:desc|rich)[^"]*"[^>]*>([\s\S]*?)<\/p>/i.exec(b) ||
      /<div[^>]*class="[^"]*res-(?:desc|rich)[^"]*"[^>]*>([\s\S]*?)<\/div>/i.exec(b);
    out.push({ title: a.title, url: u, snippet: meaningfulSnippet(d ? htmlText(d[1]) : '') });
  });
  return out;
}

async function searchHtml(name, url, parser, base, query, limit, timeoutMs) {
  const html = await fetchHtml(url, timeoutMs);
  const hits = parser(html).map(h => Object.assign({}, h, { url: absUrl(h.url, base) }));
  const clean = cleanResults(hits, limit * 2);
  const r = relevantResults(query, clean, REL_MIN_RATIO);
  return { engine: name, results: r.kept.slice(0, limit), dropped: r.dropped };
}

async function searchSogou(query, limit, timeoutMs) {
  return searchHtml('sogou',
    'https://www.sogou.com/web?query=' + encodeURIComponent(query),
    parseSogou, 'https://www.sogou.com', query, limit, timeoutMs);
}

async function search360(query, limit, timeoutMs) {
  return searchHtml('so360',
    'https://www.so.com/s?q=' + encodeURIComponent(query),
    parse360, 'https://www.so.com', query, limit, timeoutMs);
}

async function searchBing(query, limit, timeoutMs) {
  const want = Math.max(1, Math.min(MAX_LIMIT, limit));
  // 多要一倍候选：相关性过滤会砍掉一部分，只按 limit 去取的话，砍完可能一条都不剩。
  const ask = Math.min(MAX_LIMIT, want * 2);
  const res = await fetch('https://www.bing.com/search?q=' + encodeURIComponent(query) +
    '&format=rss&count=' + ask, {
    headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9' },
    signal: AbortSignal.timeout(timeoutMs || DEFAULT_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error('搜索通道返回 ' + res.status);
  const xml = await res.text();
  const hits = xmlItems(xml).map(it => ({
    title: tagText(it, 'title'),
    url: tagText(it, 'link'),
    snippet: meaningfulSnippet(tagText(it, 'description')),
  }));
  const clean = cleanResults(hits, ask);
  const r = relevantResults(query, clean, REL_MIN_RATIO);
  return { engine: 'bing', results: r.kept.slice(0, want), dropped: r.dropped };
}

/**
 * 内置多源择优：挨个试，**取第一个真有货的**。
 *
 * ★ 两个状态必须分开，不许合成一个布尔：
 *   - 一路都没连通（全抛异常）          → offline            = "联网暂时不可用"
 *   - 连上了但结果全被相关性判定丢弃    → no-useful-result   = "没搜到跟这个问题直接相关的网页"
 *   前者是运维问题，后者是"这个问题网上确实谈得少"。混为一谈，运维排查会被带偏。
 *
 * @returns {Promise<{state:'ok'|'offline'|'empty', results:Array, engine:string,
 *                    dropped:number, errors:Array<string>}>}
 */
async function searchBuiltin(query, limit, timeoutMs) {
  // 顺序 = 真机实测的结果质量排序。搜狗最准，Bing 垫底（见本段开头的历史）。
  const sources = [
    { name: 'sogou', run: () => searchSogou(query, limit, timeoutMs) },
    { name: 'so360', run: () => search360(query, limit, timeoutMs) },
    { name: 'bing', run: () => searchBing(query, limit, timeoutMs) },
  ];
  const errors = [];
  let dropped = 0;
  let sawOnline = false;

  for (const s of sources) {
    try {
      const r = await s.run();
      sawOnline = true;
      dropped += r.dropped || 0;
      if (r.results && r.results.length) return { state: 'ok', results: r.results, engine: s.name, dropped: dropped, errors: errors };
    } catch (e) {
      errors.push(s.name + ': ' + String(e.message || e));
    }
  }
  return {
    state: sawOnline ? 'empty' : 'offline',
    results: [], engine: 'none', dropped: dropped, errors: errors,
  };
}

// ---------------------------------------------------------------- 自定义通道
async function searchEndpoint(cfg, query, limit, timeoutMs) {
  const res = await fetch(cfg.url, {
    method: 'POST',
    headers: Object.assign({ 'Content-Type': 'application/json' },
      cfg.key ? { Authorization: 'Bearer ' + cfg.key } : {}),
    body: JSON.stringify({ query: query, limit: limit }),
    signal: AbortSignal.timeout(timeoutMs || DEFAULT_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error('搜索服务返回 ' + res.status);
  const j = await res.json();
  const raw = j.results || j.items || j.data || [];
  return cleanResults((Array.isArray(raw) ? raw : []).map(r => ({
    title: r.title || r.name || '',
    url: r.url || r.link || '',
    snippet: r.snippet || r.content || r.description || '',
  })), limit);
}

// ---------------------------------------------------------------- 对外入口
/**
 * @returns {Promise<{ok:boolean, query:string, results:Array, engine:string,
 *                    reason?:string, message?:string, fallback?:boolean, warned?:string}>}
 */
async function search(query, opts) {
  const q = String(query || '').trim();
  const o = opts || {};
  const limit = Math.max(1, Math.min(MAX_LIMIT, Number(o.limit) || 5));
  if (!q) return { ok: false, reason: 'EMPTY', query: q, results: [], engine: 'none', message: '没有要搜索的内容' };

  const cfg = searchConfig();
  if (!cfg.enabled) {
    return {
      ok: false, reason: 'DISABLED', query: q, results: [], engine: 'none',
      message: OFFLINE_MESSAGE,
    };
  }

  const timeoutMs = Number(o.timeoutMs) || DEFAULT_TIMEOUT_MS;
  const warned = [];

  if (cfg.url) {
    try {
      const rs = await searchEndpoint(cfg, q, limit, timeoutMs);
      if (!rs.length) return { ok: true, query: q, results: [], engine: 'custom', message: EMPTY_MESSAGE };
      return { ok: true, query: q, results: rs, engine: 'custom' };
    } catch (e) {
      // 配了自定义通道却失败 ≠ 不能用：内置多源还在，值得再试一遍。
      // 但要把"原本那路挂了"如实带回去，别让人以为一切都好。
      warned.push('custom: ' + String(e.message || e));
      if (!cfg.builtin) {
        return {
          ok: false, reason: 'ERROR', query: q, results: [], engine: 'custom',
          message: OFFLINE_MESSAGE, error: warned.join(' | '),
        };
      }
    }
  }

  return builtinOutcome(q, await searchBuiltin(q, limit, timeoutMs), warned);
}

/**
 * 把多源择优的结果组装成对外返回结构。三条路的收口径集中在这一处 ——
 * 以前每个分支各拼一次 ok/message，漏改一处就出现"这条路上没过滤"的裂缝。
 */
function builtinOutcome(query, r, warned) {
  const base = { query: query, dropped: r.dropped || 0 };
  const diagnostics = (warned && warned.length) ? warned.concat(r.errors || []) : (r.errors || []);
  if (diagnostics.length) base.diagnostics = diagnostics;

  if (r.state === 'ok') {
    return Object.assign(base, { ok: true, results: r.results, engine: r.engine });
  }
  if (r.state === 'empty') {
    // 连通了但没一份能用的东西 —— 要么这个话题网上确实谈得少，
    // 要么搜索引擎丢词回退了。两种情况对模型的要求一样：不许假装查到过。
    return Object.assign(base, {
      ok: true, results: [], engine: 'none',
      message: (r.dropped > 0) ? IRRELEVANT_MESSAGE : EMPTY_MESSAGE,
    });
  }
  return Object.assign(base, {
    ok: false, reason: 'ERROR', results: [], engine: 'none', message: OFFLINE_MESSAGE,
  });
}

/**
 * 把结果拼成给模型的一段上下文。
 * ★ 必须保留 URL —— 模型回答里要写"这是哪来的"，学生才能自己去核。
 */
function searchContext(hits) {
  // ★ 必须是数组。字符串也有 .length，光判 falsy 会让`getContext('xxx')`一路放行到 .map 才炸，
  //   而且炸在 SSE 中途 —— 消息已经发出去了，前端拿到半条。
  if (!Array.isArray(hits) || !hits.length) return '';
  return hits.map((h, i) => '[网页' + (i + 1) + '] ' + h.title + '\n' + h.url + '\n' + h.snippet).join('\n\n');
}

module.exports = {
  UA, DEFAULT_TIMEOUT_MS, MAX_LIMIT, OFFLINE_MESSAGE, EMPTY_MESSAGE, IRRELEVANT_MESSAGE,
  REL_MIN_RATIO,
  searchConfig, search, searchContext,
  searchBing, searchEndpoint, searchSogou, search360, searchBuiltin, builtinOutcome,
  absUrl, htmlText, anchorTitle, parseSogou, parse360, meaningfulSnippet,
  grams, relevance, relevantResults,
  // 拆出来是为了测试能直接喂脏 XML，不用真的去打网络
  decodeEntities, stripTags, snip, tagText, xmlItems, cleanResults, safeUrl,
};

'use strict';
/**
 * 扫描件 OCR —— 把 PDF 每页的位图交给**视觉模型**转写。
 *
 * 为什么用视觉模型而不是本地 OCR 引擎：
 *   本服务是零依赖（只有 Node 内置模块）且要跑在云主机上 —— 既没有 tesseract，
 *   也没有中文字库，装一套的代价远大于收益。视觉模型对中文教材的识别质量足够
 *   逐字使用：2026-10-02 拿一本六年级数学教材扫描件实测第 12/30 页，文字零错字、
 *   公式（6÷2/9 = 6×9/2 = 27）也对。
 *
 * 代价是**每页一次模型调用**，所以：
 *   ① 必须异步（走 jobs 表 + 心跳 + 进度），绝不能卡在 HTTP 请求里；
 *   ② 要有并发上限和超时，否则一本书能把连接池和额度一起吃光；
 *   ③ 失败的页要**如实记录**，不能拿空字符串糊过去 —— 少识别一页
 *      和识别出空内容，对学生来说是"AI 说教材里没有这一章"这种灾难性误导。
 */

const DEFAULT_MODEL = 'qwen-vl-max-2025-01-25';
// 并发 2 是保守起步。★ 2026-10-02 实测教训：并发 3、不限速，130 页里**烂掉 122 页**，
// 全部是 HTTP 429（rate limit reached for RPM）。一本书 = 上百次请求，
// 不节流就是把配额一次打爆，而"重试"在限流面前毫无用处。
const DEFAULT_CONCURRENCY = 2;
// 每分钟请求上限。★ 2026-10-02 实测这个 Key 的 qwen-vl-max：**匀速 3 秒一次也会被限流**
// （连打 5 次成功 → 一阵 429 → 又 5 次成功），说明 RPM 配额很低，而且很可能被别的
// 调用方共享。所以默认按 10 RPM 起步（6 秒一次），宁可慢也不要"烂掉大部分页"。
// 一本书 130 页 ≈ 13 分钟起步，慢的时候二十多分钟 —— 走的是后台任务，用户不用等。
// 有更高配额的 Key 就把 OCR_RPM 调大。
const DEFAULT_RPM = 10;
const DEFAULT_PAGE_TIMEOUT_MS = 90000;
/** 被限流时的最大重试次数 —— 比普通错误多得多，因为限流只是"等一下"，不是"坏了" */
const RATE_MAX_ATTEMPTS = 8;
/** 降速的天花板。不封顶的话连续限流会把间隔指数级推高，一本书直接跑成十几个小时。 */
const MAX_INTERVAL_MS = 12000;

/** 提示词只做一件事：逐字转写。任何"帮我总结"的倾向都是错的 —— 这是教材原文，不是问答。 */
const PAGE_PROMPT = [
  '请把这张教材页面上的所有中文文字**完整逐字转写**出来，按版面顺序（从上到下、从左到右）。',
  '数学公式用纯文本表示（比如 3/4、x²、12÷3、6÷2/9=27）。',
  '只输出转写结果：不要评论、不要总结、不要解释、不要用 markdown 标题或代码块。',
  '看不清的字用 [?] 标记，不要猜。',
  '如果这一页完全没有文字（纯插图、空白页），只输出四个字：本页无文字。',
].join('\n');

function num(v, dflt) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : dflt;
}

function ocrConfig() {
  const key = process.env.LLM_API_KEY || '';
  const base = String(process.env.LLM_BASE_URL || '').trim();
  const off = String(process.env.OCR_DISABLED || '').trim();
  return {
    // 没有 Key / 没配 BaseURL / 显式关掉 —— 三种都算"用不了"，
    // 上层据此如实告知用户"识别不了"，而不是排队等一个永远不会来的结果。
    enabled: !!key && !!base && !off,
    model: String(process.env.OCR_MODEL || '').trim() || DEFAULT_MODEL,
    concurrency: Math.max(1, Math.min(6, num(process.env.OCR_CONCURRENCY, DEFAULT_CONCURRENCY))),
    // 每分钟请求上限（账号级限流是共享的，所以这是"整本书"的速率，不是单页的）
    rpm: num(process.env.OCR_RPM, DEFAULT_RPM),
    // 0 / 未设 = 全部页。设成 N 就只识别前 N 页（省额度用）。
    maxPages: Math.max(0, Number(process.env.OCR_MAX_PAGES) || 0),
    // 被限流时一页最多重试几次。默认 8（限流只是"等一下"，值得多给机会）；
    // 允许调小，是为了测试能在几十秒内跑完"一直限流"这条路径。
    rateRetries: Math.max(1, Math.round(num(process.env.OCR_RATE_RETRIES, RATE_MAX_ATTEMPTS))),
    pageTimeoutMs: num(process.env.OCR_PAGE_TIMEOUT_MS, DEFAULT_PAGE_TIMEOUT_MS),
    base: base.replace(/\/+$/, ''),
  };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ---------------- 全局限速（所有页共享一个"下一次可发"的时刻） ----------------
// 为什么是全局而不是每页各自限速：限流是**账号级**的。每页自己礼貌没有意义 ——
// 3 页同时在飞，加起来还是 3 倍速率。
let _baseIntervalMs = Math.round(60000 / DEFAULT_RPM);
let _intervalMs = _baseIntervalMs;
let _nextAt = 0;
let _throttled = 0;          // 累计被限流次数，用于诊断与测试

/**
 * 按配置校准基准速率。
 * - 没被限流过 ⇒ 严格按配置（调快调慢都听配置的）；
 * - 被限流过 ⇒ **只允许更保守**，不许因为改配置就把限流的教训忘掉（那等于自己又撞一次墙）。
 */
function ensurePacer(rpm) {
  const want = Math.max(0, Math.round(60000 / Math.max(1, Number(rpm) || DEFAULT_RPM)));
  _baseIntervalMs = want;
  if (_throttled === 0) _intervalMs = want;
  else if (_intervalMs < want) _intervalMs = want;
}
/**
 * 把限速器恢复到"刚启动"的状态。
 * 两个用途：① 测试要能隔离（否则前一个用例的降速会拖死后一个的等待预算）；
 * ② 运维改了 `OCR_RPM` 后不必重启进程 —— 下次识别就会按新速率跑。
 */
function resetPacer(rpm) {
  if (rpm != null) {
    _baseIntervalMs = Math.max(0, Math.round(60000 / Math.max(1, Number(rpm) || DEFAULT_RPM)));
  }
  _intervalMs = _baseIntervalMs;
  _nextAt = 0;
  _throttled = 0;
}
/** 排队领一个发请求的名额 */
async function acquireSlot() {
  const now = Date.now();
  const at = Math.max(now, _nextAt);
  _nextAt = at + _intervalMs;
  const wait = at - now;
  if (wait > 0) await sleep(wait);
}
/**
 * 被限流就**整体降速**（AIMD 的乘性减小）。
 * 只做页面级重试是不够的：一边重试一边按原速率发新请求，等于把配额继续烧光，
 * 结果就是"重试全撞在限流上"，130 页里能烂掉 122 页。
 */
function slowDown() {
  _throttled++;
  // 1.25 倍而不是 1.6 倍：一本书几百次请求，乘得太狠会一路飙到"每页等半分钟"，
  // 自己把自己拖成超时。上限 12 秒也卡住了最坏情况。
  _intervalMs = _intervalMs < 1500 ? 2000 : Math.min(MAX_INTERVAL_MS, Math.round(_intervalMs * 1.25));
}
/**
 * 一路顺畅就慢慢把速度加回去（AIMD 的加性恢复）。
 * 没有这一步，一次限流会让服务此后一直用最慢的速度跑到重启为止。
 * 每次成功只收 4%，是为了宁可稳一点，也不要"刚加速完又被打回去"。
 */
function speedUp() {
  if (_intervalMs > _baseIntervalMs) _intervalMs = Math.max(_baseIntervalMs, Math.round(_intervalMs * 0.96));
}
function pacerInfo() {
  return { intervalMs: _intervalMs, baseIntervalMs: _baseIntervalMs, nextAt: _nextAt, throttled: _throttled, maxIntervalMs: MAX_INTERVAL_MS };
}

/** 模型偶尔会自作主张套一层 markdown 或加句"好的，以下是转写"。剥掉。 */
function cleanPageText(t) {
  let s = String(t || '').trim();
  if (!s) return '';
  s = s.replace(/^```[a-zA-Z]*\s*\n?/, '').replace(/\n?```\s*$/, '').trim();
  s = s.replace(/^(好的|好，|以下是|这是|下面是)[^\n]{0,30}(转写|文字|内容)[^\n]{0,10}[:：]?\s*\n?/, '').trim();
  if (/^本页无文字[。.]?$/.test(s.replace(/\s/g, ''))) return '';
  return s;
}

/**
 * 识别单页 / 看一张图。
 * @param {Buffer|string} data 图片字节（或已是 base64 字符串）
 * @param {object} [opt] { model, timeoutMs, mime, prompt, maxTokens }
 *   · mime  —— 默认 image/jpeg。真的是 PNG/WebP 时要给对：data URI 里写错类型，
 *              有的网关会直接判"图片格式不支持"（1x1 假图那次踩过）。
 *   · prompt —— 默认是"把这页文字抄下来"。让模型**描述一张图**时由 describeImage 换掉。
 */
async function ocrImage(data, opt) {
  const o = opt || {};
  const cfg = ocrConfig();
  if (!cfg.enabled) { const e = new Error('没有可用的模型配置，无法识别图片'); e.code = 'OCR_OFF'; throw e; }
  const b64 = Buffer.isBuffer(data) ? data.toString('base64') : String(data);
  const mime = /^image\//.test(String(o.mime || '')) ? String(o.mime) : 'image/jpeg';
  const prompt = String(o.prompt || PAGE_PROMPT);
  // 先排队领名额再计时 —— 否则"排队等待"会被算进单页超时，限速一慢就集体超时。
  await acquireSlot();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), num(o.timeoutMs, cfg.pageTimeoutMs));
  try {
    const r = await fetch(cfg.base + '/chat/completions', {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + process.env.LLM_API_KEY },
      body: JSON.stringify({
        model: String(o.model || cfg.model),
        max_tokens: Math.max(200, Number(o.maxTokens) || 2500),
        temperature: 0,
        messages: [{
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: 'data:' + mime + ';base64,' + b64 } },
            { type: 'text', text: prompt },
          ],
        }],
      }),
    });
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      const e = new Error('识别服务返回 ' + r.status + (body ? '：' + body.slice(0, 120) : ''));
      // 429 不是"这页有问题"，是"你发太快了"。必须单独分类 —— 它要等，
      // 而且要让**所有**页一起降速，不然重试会继续撞在同一堵墙上。
      e.code = r.status === 429 ? 'RATE_LIMIT' : 'HTTP_' + r.status;
      if (e.code === 'RATE_LIMIT') slowDown();
      throw e;
    }
    const j = await r.json();
    const txt = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
    speedUp();                                   // 顺利就慢慢把速度加回去
    return cleanPageText(txt);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 逐页识别（有限并发，结果按页序回填）。
 * @returns {{pages:string[], failed:Array<{page:number,reason:string}>, done:number, total:number}}
 */
async function ocrImages(images, opt) {
  const o = opt || {};
  const cfg = ocrConfig();
  ensurePacer(cfg.rpm);          // 按配置校准速率（已被限流降过速则保持慢速）
  const list = (Array.isArray(images) ? images : []).slice(0, cfg.maxPages || Infinity);
  const total = list.length;
  const out = new Array(total).fill('');
  const failed = [];
  const conc = Math.max(1, Math.min(6, num(o.concurrency, cfg.concurrency)));
  const maxAttempts = cfg.rateRetries;
  let next = 0, done = 0;

  async function worker() {
    for (;;) {
      const i = next++;
      if (i >= total) return;
      const im = list[i];
      let txt = '', lastErr = null;
      // 普通错误（上游 502 抖动）重试一次就够；**限流要单独对待** ——
      // 它只是"等一等"，等够了就能过，所以给更多次机会。
      // 实测：不区分 429 时，130 页会烂掉 122 页。
      let attempt = 0;
      while (attempt < maxAttempts) {
        try { txt = await ocrImage(im.data, { model: o.model, timeoutMs: o.timeoutMs }); lastErr = null; break; }
        catch (e) {
          lastErr = e;
          const rate = !!(e && e.code === 'RATE_LIMIT');
          attempt++;
          if (!rate && attempt >= 2) break;                 // 非限流：只重试一次
          // 上游刚抖了一下就立刻再打一次没意义，给个短间隔。
          if (!rate && attempt < maxAttempts) await sleep(800);
          // ★ 限流这里**故意不再额外 sleep**：`ocrImage` 开头已经 `acquireSlot()` 领过名额，
          // 而 429 又会 `slowDown()` 把全局间隔拉长 —— 重试天然就一次比一次间隔大。
          // 之前又叠一层 `min(20000, …×attempt)` 的退避，等于同一堵墙撞两遍，
          // 还会把"限流已缓解"的判断拖后：8 次重试光睡眠就 37 秒。
        }
      }
      out[i] = txt;
      if (lastErr) failed.push({ page: im.page, reason: lastErr.code || lastErr.message || '识别失败' });
      done++;
      if (typeof o.onPage === 'function') {
        try { o.onPage({ index: i, page: im.page, done: done, total: total, failed: failed.length }); }
        catch (e) { /* 进度回调出事不能拖垮识别本身 */ }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(conc, total) }, worker));
  return { pages: out, failed: failed, done: done, total: total };
}

/** 把每页文本拼成一篇：带页码标记，便于 AI 引用"第几页"。 */
function assembleOcrText(pages) {
  const parts = [];
  (Array.isArray(pages) ? pages : []).forEach((t, i) => {
    const s = String(t || '').trim();
    if (s) parts.push('【第 ' + (i + 1) + ' 页】\n' + s);
  });
  return parts.join('\n\n');
}

/**
 * 「看一张图」—— 不做逐页抄写，而是**把图里的信息说清楚**。
 *
 * 用在两个地方（旧代码在这两处都只会说"我看不到图片内容本身"）：
 *   1) 学生发来的**图片链接**（webdoc 抓回来的字节）；
 *   2) 学生直接拍照 / 截图**上传的附件**。
 * 一个"孩子拍错题来问"的产品，这两条路必须通 —— 否则最常用的入口是死的。
 *
 * 输出是**纯文本描述**：主模型（deepseek-chat）没有视觉能力，但它读文字很在行。
 * 把图转成文字再喂给它，比硬塞一张它看不见的图靠谱得多。
 */
const IMAGE_PROMPT = `请把这张图片的内容**如实、完整地**写成一段文字，供另一位老师阅读。
- 如果是题目 / 试卷 / 作业：把题干、条件、图中标注（数字、字母、单位）逐字抄下来；
  有图就说明图里画了什么、各点各线怎么标。
- 如果是手写笔记：忠实转写，不要"整理"、不要修正错别字。
- 如果是图表 / 表格：把行列标题和数值说清楚。
- 如果是生活照或截图：如实描述画面里与学习有关的信息。
只输出这段文字。不要写"好的""以下是"，不要评价，也不要解题。
看不清的地方写"此处看不清"，**不要猜**。`;

async function describeImage(data, opt) {
  const o = opt || {};
  const txt = await ocrImage(data, {
    mime: o.mime, model: o.model, timeoutMs: o.timeoutMs,
    prompt: o.prompt || IMAGE_PROMPT, maxTokens: 1500,
  });
  // 这里**不能**走 cleanPageText：那条"本页无文字→空串"的规则是给教材插图页用的，
  // 而一张图即使没有文字，我们仍然要知道它画了什么。
  return String(txt || '').replace(/^```[a-zA-Z]*\s*\n?/, '').replace(/\n?```\s*$/, '').trim();
}

/** 用不了 OCR 时给用户的实话 —— 不能让他对着"解析中"等一个永远不会来的结果。 */
const OCR_DISABLED_NOTE = '这是扫描件，需要 AI 逐页识别文字，但当前没有可用的模型配置（缺 LLM_API_KEY）。'
  + '可以先在设置里配好模型，再点「重新识别」。';

module.exports = {
  PAGE_PROMPT, IMAGE_PROMPT, OCR_DISABLED_NOTE,
  ocrConfig, ocrImage, ocrImages, describeImage, assembleOcrText, cleanPageText,
  // 限速器（导出是为了测试能直接验 429 的行为，不用真去打接口）
  pacerInfo, ensurePacer, resetPacer, slowDown, speedUp,
  RATE_MAX_ATTEMPTS, MAX_INTERVAL_MS,
  DEFAULT_RPM, DEFAULT_CONCURRENCY, DEFAULT_MODEL,
};

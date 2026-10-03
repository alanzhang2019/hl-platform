'use strict';
/**
 * Chat 富功能层（批次2）
 *
 * 这一层解决的是「对话除了能聊，还能干活」：
 *   消息级操作（朗读 / 翻译 / 收藏 / 删除 / 重新生成）
 *   附件与对话级临时资料
 *   联网搜索（可插拔）
 *   AI 配图（异步任务 + 心跳 + 轮询恢复）
 *   智能体选择（复用能力中心的技能注册表）
 *
 * 三条设计原则（与 account.js 一致，不另起一套）：
 *   1) 外部能力一律可插拔：TTS / 搜索 / 配图 都读环境变量，没配就降级到本地能做的，
 *      并且**如实告诉用户降级了**（"联网搜索暂时不可用，本条回答未联网"），
 *      不假装成功 —— 教育产品骗一次学生，信任就没了。
 *   2) 长任务必须落库：配图几十秒到几分钟，前端一定会断流/关页面。
 *      没有 jobs 表 + 心跳 + 轮询，就会出现"东西做好了但用户永远看不到"。
 *   3) 临时资料挂在对话上：聊完随对话删除，不污染正式知识库。
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const D = require('./db');
const core = require('./core');
const llm = require('./llm');
const webdoc = require('./webdoc');
const search = require('./search');
const kb = require('./kb');
const skills = require('./skills');
const extract = require('./extract');
const ocr = require('./ocr');

// ============================================================
// 一、消息朗读（TTS）
// ============================================================
// 对方的上限就是 5000 字。这个数字不是为了省事，是为了防"一次念十分钟"的失控。
const TTS_MAX_CHARS = 5000;
const TTS_RATE_MIN = 0.5;
const TTS_RATE_MAX = 2.0;

/**
 * ★ 2026-10-03 改造：从"只有一个通用 URL"扩成 provider 适配层。
 *
 * 起因：线上一直没配 TTS_PROVIDER_URL，朗读静默降级成浏览器 SpeechSynthesis，
 * 音色很机械（用户直接反馈"很机械"）。而平台用的模型网关（qnaigc）上
 * 81 个模型里**没有任何语音合成模型** —— minimax/minimax-m2.5-highspeed 是文本 LLM，
 * 拿它做 TTS 是不通的。所以必须接一个真正的外部 TTS。
 *
 * 两种上游协议：
 *   · kind='siliconflow' | 'openai' | 'openai-compatible'（OpenAI 兼容）
 *       POST {base}/audio/speech
 *       body { model, input, voice, speed, response_format:'mp3' }  ← 直接回音频字节
 *   · kind=''（默认，向后兼容）
 *       POST TTS_PROVIDER_URL
 *       body { text, voice, rate, format:'mp3' }  ← 回音频字节，或 JSON {audio|audioBase64|data|url}
 *
 * ★ base 两种写法都认：填 https://api.siliconflow.cn/v1 或直接填到 .../v1/audio/speech。
 *   少一个斜杠、多一个斜杠都不该让朗读整个坏掉。
 */
const OPENAI_TTS_KINDS = { openai: 1, siliconflow: 1, 'openai-compatible': 1 };

function ttsConfig() {
  const kind = (process.env.TTS_PROVIDER || '').trim().toLowerCase();
  const isOpenAI = !!OPENAI_TTS_KINDS[kind];
  let url = (process.env.TTS_BASE_URL || process.env.TTS_PROVIDER_URL || '').trim();
  if (isOpenAI && url && !/\/audio\/speech\/?$/.test(url)) {
    url = url.replace(/\/+$/, '') + '/audio/speech';
  }
  return {
    kind: kind,                                   // 原始取值，用于判断要不要补音色前缀
    protocol: isOpenAI ? 'openai' : 'custom',
    url: url,
    key: (process.env.TTS_API_KEY || '').trim(),
    model: (process.env.TTS_MODEL || '').trim(),
    voice: (process.env.TTS_VOICE || '').trim(),
    enabled: !!url,
  };
}

// ============================================================
// TTS 运行时覆盖（管理员看板切换 provider/model/voice/enabled/baseUrl）
// ============================================================
// ★ 设计跟 llm.js 的 setModelSlot 一致：值存 meta 表，优先于环境变量；
//   传空串/null/undefined = 清掉覆盖，回到部署时环境变量配的那个。
//   前端不用重启，改完下一条朗读就用新配置。
const TTS_META_KEY = {
  provider: 'tts:provider',
  model: 'tts:model',
  voice: 'tts:voice',
  baseUrl: 'tts:baseUrl',
  enabled: 'tts:enabled',
};

/** 返回带覆盖值与 env 原值的完整配置，字段名与 ttsConfig() 一致（兼容 speak()） */
function ttsSlot() {
  const env = ttsConfig();
  const provider = String(D.metaGet(TTS_META_KEY.provider, '') || env.kind || 'custom').trim();
  const model    = String(D.metaGet(TTS_META_KEY.model, '')    || env.model).trim();
  const voice    = String(D.metaGet(TTS_META_KEY.voice, '')    || env.voice).trim();
  const baseUrl  = String(D.metaGet(TTS_META_KEY.baseUrl, '')  || env.url).trim();
  const enabledRaw = String(D.metaGet(TTS_META_KEY.enabled, '')).trim();

  const isOpenAI = !!OPENAI_TTS_KINDS[provider];
  let url = baseUrl;
  if (isOpenAI && url && !/\/audio\/speech\/?$/.test(url)) {
    url = url.replace(/\/+$/, '') + '/audio/speech';
  }
  const isEnabled = enabledRaw === '' ? env.enabled : (enabledRaw === '1' || enabledRaw === 'true');

  return {
    kind: provider,
    protocol: isOpenAI ? 'openai' : 'custom',
    url: url,
    key: env.key,
    model: model,
    voice: voice,
    enabled: isEnabled,
    hasKey: !!env.key,
    envKind: env.kind || 'custom',
    envModel: env.model,
    envVoice: env.voice,
    envUrl: env.url,
    envEnabled: env.enabled,
    overridden: {
      kind: provider !== (env.kind || 'custom'),
      model: model !== env.model,
      voice: voice !== env.voice,
      url: url !== env.url,
      enabled: isEnabled !== env.enabled,
    },
  };
}

/** 设置 TTS 运行时覆盖。传空串 / null / undefined = 清掉覆盖。 */
function setTtsSlot(patch) {
  const env = ttsConfig();
  const toSave = {};
  if (patch.provider !== undefined) {
    const v = String(patch.provider === null ? '' : patch.provider).trim().toLowerCase();
    if (v && !/^(custom|siliconflow|openai|openai-compatible)$/.test(v)) {
      const e = new Error('不支持的 TTS 提供商：' + v); e.code = 'BAD_PROVIDER'; throw e;
    }
    toSave.provider = v;
  }
  if (patch.model !== undefined) {
    const v = String(patch.model === null ? '' : patch.model).trim();
    if (v.length > 120) { const e = new Error('模型名过长（120 字符以内）'); e.code = 'BAD_MODEL'; throw e; }
    toSave.model = v;
  }
  if (patch.voice !== undefined) {
    const v = String(patch.voice === null ? '' : patch.voice).trim();
    if (v.length > 120) { const e = new Error('音色名过长（120 字符以内）'); e.code = 'BAD_VOICE'; throw e; }
    toSave.voice = v;
  }
  if (patch.baseUrl !== undefined) {
    const v = String(patch.baseUrl === null ? '' : patch.baseUrl).trim();
    if (v && !/^https?:\/\/.+/.test(v)) { const e = new Error('URL 不合法（必须以 http:// 或 https:// 开头）'); e.code = 'BAD_URL'; throw e; }
    toSave.baseUrl = v;
  }
  if (patch.enabled !== undefined) {
    const v = patch.enabled === null || patch.enabled === undefined ? '' : String(patch.enabled).trim();
    if (v === '') {
      toSave.enabled = ''; // 空串 = 清除覆盖，让环境变量生效
    } else {
      toSave.enabled = (v === '1' || v === 'true') ? '1' : '0';
    }
  }
  Object.keys(toSave).forEach(function (k) { D.metaSet(TTS_META_KEY[k], toSave[k]); });
  return ttsSlot();
}

/** 各 provider 的已知音色候选（快速选择用），不全限制，管理员仍可手填。 */
function ttsVoiceCandidates() {
  const slot = ttsSlot();
  const known = {
    siliconflow: ['alex', 'anna', 'bella', 'benjamin', 'charlotte', 'claire', 'david', 'diana'],
    openai: ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'],
    'openai-compatible': [],
    custom: [],
  };
  return {
    provider: slot.kind,
    voices: known[slot.kind] || [],
  };
}

/**
 * SiliconFlow 的音色必须带模型前缀（`FunAudioLLM/CosyVoice2-0.5B:alex`），
 * 只写 `alex` 会 400。这里自动补全，免得管理员在设置里填个短名就整条朗读坏掉。
 * ★ 只对 siliconflow 生效 —— OpenAI 官方 TTS 的音色（alloy/nova…）本来就没有冒号，
 *   统一补前缀会把它们弄坏。
 */
function normalizeTtsVoice(cfg, voice) {
  const v = String(voice || '').trim();
  if (!v) return '';
  if (cfg.kind === 'siliconflow' && cfg.model && v.indexOf(':') < 0) return cfg.model + ':' + v;
  return v;
}

/**
 * 朗读偏好：语速/音色。
 *
 * ★ 存 meta 表而不是 users.preferences_json，原因很实在：
 *   空间口令登录的会话**没有 userId**（家长用口令进来的场景）。
 *   如果只认 users 表，这类用户一点"语速"就报错，功能对他们是坏的。
 *   按 userId 优先、没有就按 spaceId 兜底，两种登录方式都能用。
 */
function ttsKey(spaceId, userId) {
  return userId ? ('tts:u:' + userId) : ('tts:s:' + D.normalizeSpace(spaceId));
}

function getTtsPref(spaceId, userId) {
  const raw = D.metaGet(ttsKey(spaceId, userId), '');
  let t = {};
  if (raw) { try { t = JSON.parse(raw) || {}; } catch (e) { t = {}; } }
  return { rate: clampRate(t.rate), voice: String(t.voice || '') };
}

function clampRate(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 1;
  return Math.min(TTS_RATE_MAX, Math.max(TTS_RATE_MIN, Math.round(n * 100) / 100));
}

function setTtsPref(spaceId, userId, { rate, voice }) {
  const cur = getTtsPref(spaceId, userId);
  const next = {
    rate: rate === undefined ? cur.rate : clampRate(rate),
    voice: voice === undefined ? cur.voice : String(voice).slice(0, 80),
  };
  D.metaSet(ttsKey(spaceId, userId), JSON.stringify(next));
  return next;
}

/**
 * 朗读一段文字。
 * - 配了 TTS_PROVIDER_URL：调上游拿音频（返回 base64 或 URL），前端直接播。
 * - 没配：返回 mode='browser'，前端用浏览器自带的语音合成。
 *   这不是"降级凑数"—— 浏览器 TTS 对中文朗读质量足够，而且零成本、零延迟、不联网。
 *   真要说差别，是音色不如商业 TTS 好听；这一点如实写在返回里，不糊弄。
 */
async function speak(spaceId, userId, { text, rate, voice } = {}) {
  const raw = String(text || '').trim();
  if (!raw) { const e = new Error('没有要朗读的内容'); e.code = 'BAD_INPUT'; throw e; }
  if (raw.length > TTS_MAX_CHARS) {
    const e = new Error('一次最多朗读 ' + TTS_MAX_CHARS + ' 字，这条有 ' + raw.length + ' 字，请分段朗读');
    e.code = 'TOO_LONG'; e.maxChars = TTS_MAX_CHARS; e.length = raw.length;
    throw e;
  }
  const pref = getTtsPref(spaceId, userId);
  const useRate = rate === undefined ? pref.rate : clampRate(rate);
  const cfg = ttsSlot();
  // 音色优先级：本次请求 > 用户偏好 > 环境变量默认值。补前缀放在最后一步。
  let useVoice = normalizeTtsVoice(cfg, voice === undefined ? pref.voice : String(voice || '').slice(0, 80));
  if (!useVoice) useVoice = normalizeTtsVoice(cfg, cfg.voice);

  if (!cfg.enabled) {
    return {
      mode: 'browser', text: raw, rate: useRate, voice: useVoice,
      maxChars: TTS_MAX_CHARS,
      note: '当前使用浏览器语音合成（本地朗读，不走网络）',
    };
  }
  try {
    // OpenAI 兼容协议（SiliconFlow 等）的字段名与"通用自定义"完全不同：
    //   前者 input/model/response_format，后者 text/rate/format。
    // 混着发会 400，所以这里必须分叉，不能只改 URL 就指望能用。
    const payload = cfg.protocol === 'openai'
      ? {
          model: cfg.model || undefined,
          input: raw,
          voice: useVoice || undefined,
          speed: useRate,
          response_format: 'mp3',
        }
      : { text: raw, voice: useVoice, rate: useRate, format: 'mp3' };
    const res = await fetch(cfg.url, {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' },
        cfg.key ? { Authorization: 'Bearer ' + cfg.key } : {}),
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      // ★ 把上游的响应体带进错误里。只报 "返回 400" 的话，音色写错、模型写错、
      //   Key 过期这三种情况长得一模一样，排查只能靠猜。
      let detail = '';
      try { detail = (await res.text()).slice(0, 300); } catch (_) {}
      const err = new Error('朗读服务返回 ' + res.status + (detail ? '：' + detail : ''));
      err.status = res.status;
      throw err;
    }
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    if (ct.indexOf('application/json') >= 0) {
      const j = await res.json();
      const audio = j.audio || j.audioBase64 || j.data || '';
      if (audio) return { mode: 'audio', audio: audio, mime: j.mime || 'audio/mpeg', rate: useRate, maxChars: TTS_MAX_CHARS, provider: cfg.kind || 'custom' };
      if (j.url) return { mode: 'url', url: j.url, rate: useRate, maxChars: TTS_MAX_CHARS, provider: cfg.kind || 'custom' };
      throw new Error('朗读服务没有返回音频');
    }
    const buf = Buffer.from(await res.arrayBuffer());
    return { mode: 'audio', audio: buf.toString('base64'), mime: ct || 'audio/mpeg', rate: useRate, maxChars: TTS_MAX_CHARS, provider: cfg.kind || 'custom' };
  } catch (e) {
    // 上游挂了不能让"朗读"整个不可用 —— 退回浏览器合成，并把原因带回去。
    // ★ 原因分两层放：
    //   note   给用户看，只说"降级了"，不把上游的 500/400 甩到他脸上；
    //   detail 给日志和运维看，带上游响应体 —— 排查时不必再猜是音色写错、
    //          模型写错还是 Key 过期（这三种在只报状态码时长得一模一样）。
    return {
      mode: 'browser', text: raw, rate: useRate, voice: useVoice,
      maxChars: TTS_MAX_CHARS, degraded: true,
      note: '朗读服务暂时不可用，已改用浏览器语音合成',
      detail: String((e && e.message) || e).slice(0, 300),
    };
  }
}

// ============================================================
// 二、消息翻译
// ============================================================
const DIRECTIONS = { zh2en: '中→英', en2zh: '英→中' };

function detectDirection(text) {
  const s = String(text || '');
  let cjk = 0, latin = 0;
  for (const ch of s) {
    if (/[\u4e00-\u9fa5]/.test(ch)) cjk++;
    else if (/[a-zA-Z]/.test(ch)) latin++;
  }
  return cjk >= latin ? 'zh2en' : 'en2zh';
}

function hashKey(src, direction) {
  return crypto.createHash('sha1').update(direction + '\u0000' + src).digest('hex');
}

function cacheGet(src, direction) {
  const r = D.get('SELECT dst FROM translations WHERE hash = ?', hashKey(src, direction));
  return r ? r.dst : null;
}
function cacheSet(src, dst, direction) {
  D.run('INSERT OR REPLACE INTO translations(hash,src,dst,direction,created_at) VALUES(?,?,?,?,?)',
    hashKey(src, direction), String(src).slice(0, 4000), String(dst).slice(0, 8000), direction, D.now());
}

/**
 * 翻译一条消息。
 * 结果既写回消息（translated_json），也进翻译缓存 ——
 * 同一句话反复点翻译很常见，缓存能省掉大量上游调用。
 */
async function translateMessage(spaceId, messageId, direction, opts) {
  const m = core.getMessage(spaceId, messageId);
  if (!m) { const e = new Error('消息不存在'); e.code = 'NOT_FOUND'; throw e; }
  const src = String(m.content || '').trim();
  if (!src) { const e = new Error('这条消息没有内容'); e.code = 'BAD_INPUT'; throw e; }
  const dir = DIRECTIONS[direction] ? direction : detectDirection(src);

  const o = opts || {};
  if (!o.force) {
    const cachedOnMsg = m.translated && m.translated[dir];
    if (cachedOnMsg && cachedOnMsg.text) {
      return { direction: dir, label: DIRECTIONS[dir], text: cachedOnMsg.text, cached: true };
    }
  }
  const inCache = cacheGet(src, dir);
  if (inCache) {
    const translated = Object.assign({}, m.translated || {}, { [dir]: { text: inCache, at: D.now() } });
    core.updateMessage(spaceId, messageId, { translated: translated });
    return { direction: dir, label: DIRECTIONS[dir], text: inCache, cached: true };
  }

  const ask = dir === 'zh2en'
    ? '把下面这段中文翻译成地道的英文。只输出译文，不要解释、不要加引号。'
    : '把下面这段英文翻译成自然的中文。只输出译文，不要解释、不要加引号。';
  const out = await llm.complete({
    messages: [{ role: 'system', content: ask }, { role: 'user', content: src.slice(0, 4000) }],
    temperature: 0.2,
  });
  const dst = String(out || '').trim();
  if (!dst) { const e = new Error('翻译没有返回内容，请稍后再试'); e.code = 'EMPTY'; throw e; }
  cacheSet(src, dst, dir);
  const translated = Object.assign({}, m.translated || {}, { [dir]: { text: dst, at: D.now() } });
  core.updateMessage(spaceId, messageId, { translated: translated });
  return { direction: dir, label: DIRECTIONS[dir], text: dst, cached: false };
}

// ============================================================
// 三、联网搜索（可插拔）
// ============================================================
// 实现搬到 server/search.js（连推出了内置通道，见那里的注释）。
// 这里只保留转发，避免同一个行为在两处各写一遍。
function searchConfig() { return search.searchConfig(); }

/**
 * 联网搜索。
 * 没能联网时**不静默失败**：返回 ok:false + 一句人话，
 * 让前端能把「联网搜索暂时不可用，本条回答未联网」原样告诉学生。
 * 偷偷降级成不联网、还让学生以为查过网了，是最坏的做法。
 */
async function webSearch(query, opts) { return search.search(query, opts); }

/**
 * 联网搜索的第一步不是搜，是决定「要不要搜、拿什么搜」。
 *
 * ★ 为什么必须有这一步（真机踩出来的）：
 *   以前直接把学生整条消息当搜索词（`webSearch(opt.text)`）。
 *   数学辅导场景里消息大都是「格子只能从上边和左边来，那到达的数怎么算？」
 *   这类推理对话——整句丢进搜索引擎，搜回的全是字面沾边的垃圾页，
 *   前端再渲染成一排「新词搜索」链接，联网功能反而成了干扰。
 *
 *   现在先让模型做一次极快的意图判断 + 检索词提炼（非流式、几十个 token）：
 *     need=false → 这条消息根本不需要联网（数学推理/解题引导/追问确认/写作闲聊），
 *                  一条搜索请求都不发，前端也不显示任何"联网"字样；
 *     need=true  → 用提炼出的短检索词去搜（去掉"上边/这个"这类口语代词，
 *                  保留有区分度的实体与术语）。
 *   判断口径从严：拿不准就不联网——给学生塞一排无关网页，比不联网糟糕得多。
 *   规划本身挂掉时退回旧行为（整句当查询）——宁可搜得笨，不能让联网静默失效。
 */
async function planWebSearch(text, opts) {
  const o = opts || {};
  const raw = String(text || '').trim();
  if (!raw) return { need: false, reason: 'EMPTY' };
  if (llm.isMock()) return { need: false, reason: 'MOCK' };
  const history = (Array.isArray(o.history) ? o.history : [])
    .slice(-4)
    .map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content || '').slice(0, 500) }))
    .filter(m => m.content);
  const sys =
    '你是联网搜索的调度器。根据最近几轮对话，判断：要回答学生的最新一条消息，是否需要搜索互联网上的外部信息。\n' +
    '需要联网的例子：新闻时事、人物/公司/政策等事实、比赛或招生的报名信息、天气、价格、软件版本、百科知识、模型不掌握的最新资料。\n' +
    '不需要联网的例子：数学/物理等推理与解题引导、对上一条回复的追问与确认、写作与翻译、闲聊、概念理解核对——这些模型自己就会，搜了只会带回无关网页。\n' +
    '判断口径从严：拿不准就判不联网。\n' +
    '只输出 JSON：{"need":true或false,"query":"检索词"}。need=true 时 query 必须是 4~16 个字的搜索关键词组，' +
    '去掉口语和指示代词（如"上边""这个""那你想看一下"），保留有区分度的实体、术语与题目关键词；need=false 时 query 为空字符串。';
  const msgs = [{ role: 'system', content: sys }].concat(history, [{ role: 'user', content: raw }]);
  try {
    const plan = await llm.completeJSON({ messages: msgs, model: o.model || 'default', temperature: 0.1 });
    const need = !!(plan && plan.need);
    let query = need ? String((plan && plan.query) || '').trim() : '';
    if (need && !query) query = raw;   // 说要搜却没给词 → 退回整句
    return { need: need, query: query, reason: need ? 'PLAN' : 'PLAN_OFF' };
  } catch (e) {
    return { need: true, query: raw, reason: 'FALLBACK', error: String((e && e.message) || e) };
  }
}

/** 把搜索结果拼成给模型的一段上下文（实现在 search.js，保持单一出处） */
function searchContext(hits) { return search.searchContext(hits); }

// ============================================================
// 四、异步任务（AI 配图 / 后续的互动课堂）
// ============================================================
// 对方的心跳是 35 秒：超过这个时间没有心跳就判定"连接半开"，转 DB 轮询。
const JOB_HEARTBEAT_MS = 35000;
// 心跳的两倍还没动静 = 这个任务已经死了（进程重启 / 上游挂死），标记失败让用户重试。
const JOB_STALE_MS = JOB_HEARTBEAT_MS * 2;
const JOB_TICK_MS = 1200;
const JOB_MAX_MS = {
  image: 180000,
  interactive: 15 * 60 * 1000,
  // 扫描件 OCR：★ 2026-10-02 真书实测改口径 —— 一度以为"并发 3、约 5 分钟"，
  // 真跑 130 页才发现必须限速（不限速会烂掉大部分页），实际 **20 分钟左右**（≈10 秒/页）。
  // 45 分钟是留余量（大书 / 接口变慢 / 被限流降速），不是预期耗时 —— 真跑超了说明上游有问题。
  // 注意：前端自动轮询的上限必须比这个值长，否则进度条会停在半路（见 app.js 的 scheduleKbPoll）。
  ocr: 45 * 60 * 1000,
};

const RUNNERS = {};

function registerRunner(kind, fn) { RUNNERS[kind] = fn; }

function createJob(spaceId, userId, kind, payload) {
  if (!RUNNERS[kind]) { const e = new Error('不支持的任务类型：' + kind); e.code = 'BAD_KIND'; throw e; }
  const id = D.uid('job_');
  D.run(`INSERT INTO jobs(id,space_id,user_id,kind,conversation_id,message_id,status,progress,input_json,heartbeat_at,started_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
    id, spaceId, userId || null, kind,
    (payload && payload.conversationId) || null, (payload && payload.messageId) || null,
    'pending', '', JSON.stringify(payload || {}), D.now(), D.now());
  kick();
  return getJob(spaceId, id);
}

function shapeJob(j) {
  if (!j) return null;
  return {
    id: j.id, kind: j.kind, status: j.status, progress: j.progress,
    // spaceId 必须带出来：runner 拿到的是 shapeJob() 的结果，
    // 而"画完把图挂回原消息"必须知道属于哪个空间（没有它就只能干瞪眼）。
    spaceId: j.space_id, userId: j.user_id,
    conversationId: j.conversation_id, messageId: j.message_id,
    result: j.result_json ? core.safeJSON(j.result_json) : null,
    input: j.input_json ? core.safeJSON(j.input_json) : null,
    error: j.error || null,
    heartbeatAt: j.heartbeat_at, startedAt: j.started_at, finishedAt: j.finished_at || 0,
    stale: j.status === 'running' && (D.now() - (j.heartbeat_at || 0) > JOB_HEARTBEAT_MS),
  };
}

function getJob(spaceId, id) {
  return shapeJob(D.get('SELECT * FROM jobs WHERE id = ? AND space_id = ?', id, spaceId));
}

function listJobs(spaceId, opts) {
  const o = opts || {};
  let sql = 'SELECT * FROM jobs WHERE space_id = ?';
  const p = [spaceId];
  if (o.kind) { sql += ' AND kind = ?'; p.push(o.kind); }
  if (o.conversationId) { sql += ' AND conversation_id = ?'; p.push(o.conversationId); }
  if (o.messageId) { sql += ' AND message_id = ?'; p.push(o.messageId); }
  if (o.active) sql += " AND status IN ('pending','running')";
  sql += ' ORDER BY started_at DESC LIMIT 50';
  return D.all(sql, ...p).map(shapeJob);
}

function touchJob(id, progress) {
  D.run('UPDATE jobs SET heartbeat_at = ?, progress = ? WHERE id = ?', D.now(), String(progress || '').slice(0, 200), id);
}

function finishJob(id, result) {
  D.run("UPDATE jobs SET status = 'done', result_json = ?, progress = '', heartbeat_at = ?, finished_at = ? WHERE id = ?",
    JSON.stringify(result === undefined ? null : result), D.now(), D.now(), id);
}
function failJob(id, message) {
  D.run("UPDATE jobs SET status = 'failed', error = ?, progress = '', heartbeat_at = ?, finished_at = ? WHERE id = ?",
    String(message || '任务失败').slice(0, 300), D.now(), D.now(), id);
}

let _ticking = false;
let _timer = null;

/** 扫掉僵死任务：超过两倍心跳还没动，就是死了 */
function sweepStale() {
  const cut = D.now() - JOB_STALE_MS;
  D.all("SELECT id, kind FROM jobs WHERE status = 'running' AND heartbeat_at < ?", cut).forEach(j => {
    failJob(j.id, '任务中断了，请重新生成');
  });
  const started = D.now();
  Object.keys(JOB_MAX_MS).forEach(kind => {
    const limit = JOB_MAX_MS[kind];
    D.all("SELECT id FROM jobs WHERE status = 'running' AND kind = ? AND started_at < ?", kind, started - limit)
      .forEach(j => failJob(j.id, '生成超时，点此重新生成'));
  });
  reconcileOcrDocs();
}

/**
 * 把"没有活任务、却还停在解析中"的资料捞出来。
 *
 * 为什么必须有这一步：OCR 任务的失败路径有好几条（僵死、超时、进程重启丢掉
 * 内存里的任务、任务被清理），而文档状态是**落库**的。少了这个对账，
 * 用户会看到一份永远转圈的《数学·六年级·上册》，既没有进度也没有重试按钮 ——
 * 比直接报错难查得多。
 */
function reconcileOcrDocs() {
  let rows;
  try { rows = D.all("SELECT id, space_id FROM kb_documents WHERE status = 'parsing'"); }
  catch (e) { return; }
  rows.forEach(r => {
    const alive = D.get("SELECT 1 FROM jobs WHERE doc_id = ? AND status IN ('pending','running') LIMIT 1", r.id);
    if (alive) return;
    try {
      kb.failDocumentParse(r.space_id, r.id, '识别任务中断了，点「重新识别」可以再来一次。');
    } catch (e) { /* 对账失败不能反过来把 worker 拖死 */ }
  });
}

function kick() {
  if (_ticking) return;
  _ticking = true;
  setImmediate(() => { _ticking = false; tick().catch(() => {}); });
}

async function tick() {
  sweepStale();
  const pend = D.all("SELECT * FROM jobs WHERE status = 'pending' ORDER BY started_at ASC LIMIT 4");
  for (const j of pend) {
    D.run("UPDATE jobs SET status = 'running', heartbeat_at = ? WHERE id = ? AND status = 'pending'", D.now(), j.id);
    const runner = RUNNERS[j.kind];
    if (!runner) { failJob(j.id, '这个任务类型暂时不可用'); continue; }
    runner(shapeJob(j)).catch(e => failJob(j.id, e.message || String(e)));
  }
}

function startWorker() {
  if (_timer) return;
  _timer = setInterval(() => { tick().catch(() => {}); }, JOB_TICK_MS);
  if (_timer.unref) _timer.unref();   // 别拖着测试进程不退出
}
function stopWorker() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}

// ---------- 配图任务 ----------
function imageConfig() {
  const url = (process.env.IMAGE_PROVIDER_URL || '').trim();
  return {
    url: url,
    key: (process.env.IMAGE_API_KEY || '').trim(),
    model: (process.env.IMAGE_MODEL || 'dall-e-3').trim(),
    size: (process.env.IMAGE_SIZE || '1024x1024').trim(),
    enabled: !!url,
  };
}

/**
 * 「AI 生图」档位：规划 / 总结 / 计划这类回答要的不是**示意图**，是一张**好看的插画**。
 *
 * 为什么单开一档而不是复用 imageConfig()：
 *   · imageConfig() 走的是 OpenAI 风格的 POST /images/generations（同步返回 b64/url）；
 *   · 七牛的图像生成是**队列式**（POST 拿 request_id → 轮询 status_url → 取 images[0].url），
 *     两者协议不同，混在一起只会写成一堆 if。
 *
 * 默认直接用 .env 里那把 LLM_API_KEY 打到七牛的可灵图像队列上 ——
 * 这样"配图"开箱可用，不需要再让用户去申请第二个 Key。
 * 想换服务商，把 IMAGE_PROVIDER_URL 指过去即可；想关掉，设 IMAGE_AI_ART=0。
 */
const AIART_DEFAULT_URL = 'https://api.qnaigc.com/queue/fal-ai/kling-image/o1';
function aiArtConfig() {
  const url = (process.env.IMAGE_PROVIDER_URL || '').trim() || AIART_DEFAULT_URL;
  const key = (process.env.IMAGE_API_KEY || process.env.LLM_API_KEY || '').trim();
  const off = String(process.env.IMAGE_AI_ART || '').trim() === '0';
  return {
    url: url,
    key: key,
    resolution: (process.env.IMAGE_RESOLUTION || '1K').trim(),
    aspect: (process.env.IMAGE_ASPECT || '4:3').trim(),
    enabled: !off && !!url && !!key,
  };
}

const ILLUSTRATION_PROMPT = `你是一位给中学生画教学插画的插画师。请把用户描述的场景画成一张**矢量插画**。

输出一个 JSON 代码块（不要任何解释文字）：

\`\`\`svg-json
{"kind":"illustration","title":"标题","palette":["#2563EB","#7C3AED","#F59E0B","#10B981"],"elements":[...]}
\`\`\`

画布固定 800x520，坐标原点在左上角，x 向右、y 向下。
elements 里每一项必须是下面之一（type 字段决定形状）：
- {"type":"rect","x":0,"y":0,"w":800,"h":520,"fill":"#EEF2FF"}            背景/色块
- {"type":"circle","cx":400,"cy":260,"r":80,"fill":"#2563EB"}            圆
- {"type":"ellipse","cx":400,"cy":260,"rx":120,"ry":60,"fill":"#7C3AED"} 椭圆
- {"type":"line","x1":0,"y1":0,"x2":800,"y2":520,"stroke":"#0F172A","width":3}
- {"type":"polygon","points":[[100,100],[200,60],[300,120]],"fill":"#10B981"}
- {"type":"path","d":"M 100 100 Q 200 40 300 100","stroke":"#F59E0B","width":4,"fill":"none"}
- {"type":"text","x":400,"y":480,"text":"文字","size":22,"fill":"#0F172A","anchor":"middle"}

规则：
1. 用 12-25 个元素画出一个**能一眼看懂**的画面，不要抽象色块堆砌。
2. 颜色只用 palette 里的色 + 白色 #FFFFFF + 深色 #0F172A。
3. 文字只用来标注，不超过 6 个字，总数不超过 5 处。**所有文字一律 #0F172A**。
4. 画面要贴合内容，不要画装饰性无关元素。
5. **明暗必须拉开**：背景用最浅的色（#FFFFFF / #EEF2FF 这类），主体图形用 palette 里**最深**的色。
   绝不用浅色写字、更不要把浅色画在浅色上 —— 学生是要打印出来看的，浅叠浅会糊成一团，
   整张图白画。
6. 不要输出 image/svg 标签，只要上面那个 JSON。`;

/**
 * 插画元素的**服务端**白名单。
 *
 * 前端 render.js 里也有一份同样的规则 —— 这不是重复，是两层各自的职责：
 *   · 服务端这份保证**落库的数据是干净的**（分享页、导出、以后接别的渲染器都不会中招）；
 *   · 前端那份保证**渲染时是安全的**（哪怕库里存了脏数据也不执行）。
 * 只靠前端拦，等于把安全性押在"所有渲染入口都记得转义"上。
 */
const ILLU_FIELDS = {
  rect: ['type', 'x', 'y', 'w', 'h', 'fill', 'rx', 'opacity'],
  circle: ['type', 'cx', 'cy', 'r', 'fill', 'opacity'],
  ellipse: ['type', 'cx', 'cy', 'rx', 'ry', 'fill', 'opacity'],
  line: ['type', 'x1', 'y1', 'x2', 'y2', 'stroke', 'width', 'opacity'],
  polygon: ['type', 'points', 'fill', 'opacity'],
  path: ['type', 'd', 'stroke', 'width', 'fill', 'opacity'],
  text: ['type', 'x', 'y', 'text', 'size', 'fill', 'anchor', 'weight'],
};
const ILLU_COLOR = /^(#[0-9a-fA-F]{3,8}|rgba?\(\s*[\d.\s,%]+\)|var\(--[a-z0-9-]+\)|none|transparent)$/;

function safeColor(v, dflt) {
  const s = String(v == null ? '' : v).trim();
  return ILLU_COLOR.test(s) ? s : dflt;
}
function safeNum(v, dflt, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}

function sanitizeElements(raw) {
  const out = [];
  for (const e of (Array.isArray(raw) ? raw : [])) {
    if (!e || typeof e !== 'object') continue;
    const t = String(e.type || '').toLowerCase();
    const fields = ILLU_FIELDS[t];
    if (!fields) continue;                       // 白名单外的类型整条丢掉
    const clean = { type: t };
    fields.forEach(f => {
      if (f === 'type') return;
      if (f === 'fill' || f === 'stroke') { clean[f] = safeColor(e[f], f === 'fill' ? '#EEF2FF' : '#0F172A'); return; }
      if (f === 'text') { clean.text = String(e.text == null ? '' : e.text).slice(0, 60); return; }
      if (f === 'anchor') { clean.anchor = ['start', 'middle', 'end'].indexOf(String(e.anchor)) >= 0 ? String(e.anchor) : 'middle'; return; }
      if (f === 'd') { clean.d = String(e.d || '').replace(/[^MmLlHhVvCcSsQqTtAaZz0-9,.\s-]/g, '').slice(0, 4000); return; }
      if (f === 'points') {
        const pts = (Array.isArray(e.points) ? e.points : []).slice(0, 40).map(p => {
          const a = Array.isArray(p) ? p : [p && p.x, p && p.y];
          return [safeNum(a[0], 0, -2000, 4000), safeNum(a[1], 0, -2000, 4000)];
        });
        clean.points = pts;
        return;
      }
      clean[f] = safeNum(e[f], 0, -2000, 4000);
    });
    if (t === 'path' && !clean.d) continue;
    if (t === 'polygon' && (!clean.points || !clean.points.length)) continue;
    out.push(clean);
    if (out.length >= 80) break;
  }
  return out;
}

/**
 * 启发式：这条回复该不该自动配一张矢量插画？
 *
 * 只针对"几何/物理/生物/示意图"这类天生需要图的教学场景——而不是每道题都画。
 * 返回 true 不代表一定画：server 端还要再过一道 `!llm.isMock()`（离线演示模式没有模型，
 * generateIllustration 会直说"需要先配 Key"，由 try/catch 吞掉，不影响主回答）。
 *
 * 触发分两档：
 *   · 强触发词（几何/物理/生物/示意图/画一张…）出现任意一个即配；
 *   · 弱触发词（函数/曲线/坐标/圆…）出现 >=2 个，或回复里明确说"见图"且弱词 >=1，也配。
 */
const ILLU_STRONG = ['几何', '示意图', '图示', '物理', '生物', '化学', '画一张', '帮我画',
  '配图', '如图所示', '下图', '上图', '函数图像', '受力分析', '光路图', '电路图',
  '分子结构', '细胞', '地形图', '数轴', '立体图', '三视图', '圆锥曲线'];
const ILLU_SOFT = ['函数', '曲线', '坐标', '圆', '三角', '抛物线', '正弦', '余弦',
  '棱柱', '棱锥', '圆锥', '圆柱', '球体', '地图', '流程图', '线段', '角', '光路', '电路', '受力'];

function shouldIllustrate(text, full) {
  const s = String(text || '') + '\n' + String(full || '');
  for (const k of ILLU_STRONG) if (s.indexOf(k) >= 0) return true;
  let soft = 0;
  for (const k of ILLU_SOFT) if (s.indexOf(k) >= 0) soft++;
  if (soft >= 2) return true;
  if (soft >= 1 && /图(示|解|中|下|上)|看(这|下|右)图/.test(full)) return true;
  return false;
}

/** 没配图像服务时，用模型生成矢量插画 —— 零外部依赖，且天生可缩放 */
async function generateIllustration(prompt) {
  // 离线演示模式连模型都没有，这里必须**直说**，不能让学生以为"画失败了"是自己的问题
  if (llm.isMock()) throw new Error('当前是离线演示模式，配图需要先配置模型 Key');
  const obj = await llm.completeJSON({
    messages: [
      { role: 'system', content: ILLUSTRATION_PROMPT },
      { role: 'user', content: '要画的场景：' + String(prompt).slice(0, 600) },
    ],
  });
  if (!obj || !Array.isArray(obj.elements) || !obj.elements.length) {
    throw new Error('配图内容校验未通过，请重新生成');
  }
  const els = sanitizeElements(obj.elements);
  if (!els.length) throw new Error('配图内容校验未通过，请重新生成');
  return {
    mode: 'svg',
    title: String(obj.title || '').slice(0, 40),
    palette: (Array.isArray(obj.palette) ? obj.palette : []).slice(0, 8).map(c => safeColor(c, '#2563EB')),
    elements: els,
  };
}

// ---------- 计划卡档位：带天数 / 阶段结构的学习计划 ----------
/**
 * 为什么计划类要单独开一档（2026-10-02 对标竞品后加的）：
 *
 * 一张好的学习计划图，价值在「哪天干什么、具体学什么」——它是**信息图**，
 * 不是插画。而原有两条路都做不出信息图：
 *   · 矢量示意图：模型只拿到 300 字题干，手里**根本没有计划数据**，
 *     被要求"画一张示意图"时只能画个空壳标题 + 几个色块（线上实测就是这样）；
 *   · AI 生图：生图模型写不对中文，风格里本来就明令"不要出现文字"，
 *     只能给一张氛围插画 —— 好看，但一个字的信息量都没有。
 *
 * 所以计划类改成"模型出数据、模板出设计"：模型只负责把答复里的天数、
 * 主题、要点抽成结构化 JSON，排版交给前端的固定模板（render.js 的 planCard）。
 * 好处是文字 100% 准确、版式稳定、窄屏能自动折行，而且不依赖任何图像服务。
 */
const PLAN_PROMPT = `你在帮一名中学生把一份学习计划整理成一张**海报式的计划表**（信息图）。

严格从下面这段答复里抽取信息，输出一个 JSON 代码块（不要任何解释文字）：

\`\`\`svg-json
{"kind":"plancard","title":"20天数学冲刺计划","subtitle":"分数与百分数 · 自学","days":[{"label":"第1-2天","theme":"分数混合运算","points":["先乘除后加减","连除转乘倒数"],"focus":"0.6 = 60%，75% = 3/4"}],"tips":["每天 2~3 小时：先看例题，再做练习，最后订正"]}
\`\`\`

字段要求：
★ **时间优先**：答复里如果出现了具体的天数划分（如"第1-5天""前 3 天""20 天分几段"），
   label 就**照抄那段时间**，并按天数去分组 —— 能分到 **5~8 组**更好（列多一点才像一张真计划表）；
   答复确实没提天数时，才用阶段名。**不要把答复里明明写着的时间笼统压成"第一段"。**
1. days **3~8 组**，按答复里的先后顺序排。天数相近的合并成一组（如"第1-5天""基础阶段"）。
2. label＝这组的时间（"第1-2天""第一周""基础阶段"），不超过 10 个字。
3. theme＝这组的主题，不超过 14 个字。
4. points＝这组要学的**具体内容**，2~4 条，每条不超过 18 个字。
   **必须是答复里真的写过的**（公式、规则、题型、例题类型、数量）。
   ★ 绝不许写"认真复习""多做练习""巩固提高""查漏补缺"这类**空话** —— 填这种进去，整张图就白画了。
   答复里这一组确实没写具体内容时，**宁可少写两条，也不许自己编**。
5. focus＝这组最值得记住的**一句**（公式或易错点），不超过 20 个字；没有就不写这个字段。
6. tips＝答复里的提醒，0~3 条，每条不超过 40 个字。
7. title / subtitle：从答复里取；取不到就起一个朴素的标题（如"学习计划"）。
   ★ **subtitle 里绝对不要出现任何教材版本名**（如"人教版""北师大版""苏教版""部编版"，
   以及"X年级上册/下册"这种配套说法）。subtitle 只写**学了什么**（如"分数与百分数 · 自学"）。
   答复里带了版本名也**不要照抄** —— 这条是硬要求，没有例外。
8. 全部用中学生看得懂的大白话，不要出现"赋能""体系化""闭环""抓手"这类词。
9. **只输出那一个 JSON**，前后不要有任何解释。`;

/** 计划卡里每个字段的长度上限 —— 服务端和前端模板共用同一套口径，改这里就够 */
const PLAN_LIMITS = { days: 8, minDays: 2, points: 4, tips: 3, label: 10, theme: 14, point: 18, focus: 20, tip: 40, title: 30, subtitle: 40 };

function planStr(v, max) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max);
}
/** 取第一个非空字符串字段 —— 模型爱把同一个意思写成不同 key，这里一次认全 */
function planPick(o, keys, max) {
  for (const k of keys) {
    const s = planStr(o && o[k], max);
    if (s) return s;
  }
  return '';
}

/**
 * 计划卡消毒。落库前必须过一遍 —— 前端模板是靠"字段一定存在、一定是短字符串"
 * 才敢直接拼 HTML 的，模型少给一个字段就可能渲染出 `undefined`。
 * 结构不成立（少于两组）时返回 null，让调用方老实退回别的链路，别硬渲染一张空表。
 */
function sanitizePlan(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const rawDays = Array.isArray(raw.days) ? raw.days : (Array.isArray(raw.steps) ? raw.steps : []);
  const days = rawDays.slice(0, PLAN_LIMITS.days).map((d, i) => {
    if (!d || typeof d !== 'object') return null;
    const label = planPick(d, ['label', 'day', 'time', 'date'], PLAN_LIMITS.label) || ('第 ' + (i + 1) + ' 组');
    const theme = planPick(d, ['theme', 'title', 'topic', 'name'], PLAN_LIMITS.theme);
    const rawPts = Array.isArray(d.points) ? d.points : (Array.isArray(d.items) ? d.items : []);
    const points = rawPts
      .map(p => planStr(typeof p === 'string' ? p : planPick(p, ['text', 'label', 'name', 'desc'], PLAN_LIMITS.point), PLAN_LIMITS.point))
      .filter(Boolean)
      .slice(0, PLAN_LIMITS.points);
    const focus = planPick(d, ['focus', 'key', 'tip', 'hard'], PLAN_LIMITS.focus);
    if (!theme && !points.length && !focus) return null;      // 空组整条丢掉，不占一列
    return { label, theme, points, focus };
  }).filter(Boolean);
  if (days.length < PLAN_LIMITS.minDays) return null;          // 少于两组就不算"计划"

  const rawTips = Array.isArray(raw.tips) ? raw.tips : (Array.isArray(raw.notes) ? raw.notes : []);
  const tips = rawTips
    .map(t => planStr(typeof t === 'string' ? t : planPick(t, ['text', 'content', 'desc'], PLAN_LIMITS.tip), PLAN_LIMITS.tip))
    .filter(Boolean)
    .slice(0, PLAN_LIMITS.tips);

  return {
    kind: 'plancard',
    title: planPick(raw, ['title', 'name'], PLAN_LIMITS.title) || '学习计划',
    subtitle: planPick(raw, ['subtitle', 'sub', 'desc'], PLAN_LIMITS.subtitle),
    days,
    tips,
  };
}

/**
 * 计划类的触发判定 —— 必须排在 shouldIllustrate 之前。
 *
 * 顺序为什么关键：计划类的答复里几乎一定会出现"示意图""流程图"这类词
 * （"下面是学习计划示意图"），而 `shouldIllustrate` 见到"示意图"就直接认领。
 * 结果就是计划类被拉去做矢量示意图，而那一路根本拿不到计划数据。
 *
 * 三个条件同时满足才算：
 *   ① 答复已成篇（≥260 字）—— 一两句话配一张大图是喧宾夺主；
 *   ② 是个"计划类"需求（问句里有计划词，或答复里计划词 ≥2）；
 *   ③ 答复里**真的有多阶段结构**（第 N 天 / 每周 / 分几个阶段）——
 *      没有这个结构就画不出列，硬画出来就是一张空壳。
 */
const PLAN_ASK = ['计划', '规划', '安排', '时间表', '作息', '进度', '打卡', '冲刺', '备考',
  '复习表', '学习表', '路线图', '规划表', '怎么分', '多久', '几天'];
const PLAN_WORD = ['计划', '规划', '安排', '阶段', '时间表', '进度', '每天', '每日', '打卡', '复习', '预习', '刷题', '冲刺'];
const PLAN_MULTI = /第\s*[一二三四五六七八九十\d]+\s*[天周月个]|每天|每日|阶段|每个?\s*\d+\s*天|共\s*\d+\s*天|\d+\s*天\s*[内里]?|第一[周步阶]|第二[周步阶]|一周|两周/;

function shouldPlanCard(text, full) {
  const f = String(full || '');
  if (f.length < 260) return false;
  // ③ 先否决：没有"多阶段"结构，画不出能用的计划表
  if (!PLAN_MULTI.test(f)) return false;
  // ② 计划类需求：问句里直接说了，或答复里计划词够密
  const q = String(text || '');
  if (PLAN_ASK.some(k => q.indexOf(k) >= 0)) return true;
  let hit = 0;
  for (const k of PLAN_WORD) if (f.indexOf(k) >= 0) hit++;
  return hit >= 3;
}

/** 生成计划卡：抽取 → 消毒。失败抛错，由调用方降级到别的档位 */
async function generatePlanCard(question, answer) {
  if (llm.isMock()) throw new Error('当前是离线演示模式，配图需要先配置模型 Key');
  const obj = await llm.completeJSON({
    messages: [
      { role: 'system', content: PLAN_PROMPT },
      { role: 'user', content: '学生的问题：' + planStr(question, 300) + '\n\n要整理的答复：\n' + String(answer || '').slice(0, 3200) },
    ],
  });
  const plan = sanitizePlan(obj);
  if (!plan) throw new Error('计划卡内容校验未通过（可能答复里没有多阶段结构）');
  return plan;
}

// ---------- AI 生图档位：规划 / 总结 / 计划类 ----------
/**
 * 触发判定：这段回答该不该配一张「AI 场景插画」？
 *
 * 与 shouldIllustrate() 的分工（两条路不能混）：
 *   · shouldIllustrate → 几何 / 物理 / 生物：要的是**画得准**的示意图，走 SVG；
 *   · shouldConceptArt → 规划 / 总结 / 计划：要的是**好看**的场景插画，走 AI 生图。
 * 一道几何题的图一旦不准就是错的，所以前者绝不能外包给生图模型；
 * 反过来，AI 画的学习场景也不该被当成示意图去看 —— 两边各自诚实。
 */
const ART_ASK = ['规划', '计划', '总结', '复盘', '安排', '清单', '目标', '路线', '时间表', '打卡', '大纲', '梳理', '进度'];
const ART_HEAD = ['学习规划', '复习计划', '备考计划', '学习计划', '提分计划', '冲刺计划',
  '周计划', '月计划', '时间表', '打卡表', '学习路线', '成长路线', '学习地图', '知识地图',
  '知识梳理', '思维导图', '阶段总结', '阶段性总结', '复盘', '目标清单', '假期计划'];

function shouldConceptArt(text, full) {
  const f = String(full || '');
  // 一句话的回答配一张大插画是喧宾夺主：内容得先"成篇"才值一张图
  if (f.length < 220) return false;
  const q = String(text || '');
  for (const k of ART_ASK) if (q.indexOf(k) >= 0) return true;
  let hit = 0;
  for (const k of ART_HEAD) if (f.indexOf(k) >= 0) hit++;
  return hit >= 2;
}

/** 品牌插画风格：写死，免得每次让模型自由发挥导致风格漂移 */
const AI_ART_STYLE = '插画风格：现代扁平矢量插画（flat vector illustration），'
  + '清爽的蓝白色系（主色深蓝 #2563EB、浅蓝 #7DD3FC、点缀暖橙 #F59E0B）。'
  + '大留白、构图简洁、圆角造型、轻微层次与柔和阴影，整体明亮、积极、有成长感。'
  + '画面中不要出现任何文字、字母、数字、公式、水印或 logo。';

/**
 * 把「学生问的问题 + AI 的回答」压成一句**给画师看的场景描述**。
 *
 * 直接把题干丢给生图模型效果很差：原文全是条件与符号，模型只会画出一堆
 * 看不懂的元素。先让语言模型把它翻译成画面。失败就退回兜底场景 ——
 * 画得普通也好过画不出来。
 */
async function buildArtScene(question, answer) {
  const q = String(question || '').slice(0, 400);
  const a = String(answer || '').slice(0, 900);
  try {
    const t = await llm.complete({
      temperature: 0.4,
      messages: [
        { role: 'system', content:
          '你是插画师的分镜助手。把用户的学习需求翻译成**一句给画师看的横版场景描述**：' +
          '40-80 字，只描述画面里有什么（人物、动作、物品、环境、氛围），' +
          '必须是校园或书桌上画得出来的具体场景。不要出现文字、公式、图表、抽象概念。' +
          '只输出这句话本身，不要任何前后缀、不要引号。' },
        { role: 'user', content: '需求：' + q + '\n\nAI 给出的内容概要：' + a },
      ],
    });
    const s = String(t || '').replace(/^[\s"'「『]+|[\s"'」』]+$/g, '').trim();
    if (s.length >= 12) return s.slice(0, 200);
  } catch (e) { /* 模型挂了就用兜底场景 */ }
  return '一名中学生在书桌前认真做学习规划，桌上有摊开的笔记本、便签与一杯水，窗外是清晨的光';
}

/** 把附件挂回原消息 —— 不挂回去，刷新一下图就没了 */
function attachArtifact(spaceId, messageId, att) {
  if (!spaceId || !messageId) return false;
  try {
    const prev = core.getMessage(spaceId, messageId);
    if (!prev) return false;
    core.updateMessage(spaceId, messageId, { attachments: (prev.attachments || []).concat([att]) });
    return true;
  } catch (e) { return false; }
}

/** 队列式生图：建任务 → 轮询 → 取图 → 存成空间文件 */
async function generateAIImage(spaceId, scene, opts) {
  const cfg = aiArtConfig();
  if (!cfg.enabled) throw new Error('没有配置生图服务');
  const o = opts || {};
  const prompt = (String(scene || '').slice(0, 800) + '。' + AI_ART_STYLE).slice(0, 2400);
  const auth = { Authorization: 'Bearer ' + cfg.key };

  const res1 = await fetch(cfg.url, {
    method: 'POST',
    headers: Object.assign({ 'Content-Type': 'application/json' }, auth),
    body: JSON.stringify({ prompt: prompt, num_images: 1, resolution: cfg.resolution, aspect_ratio: cfg.aspect }),
    signal: AbortSignal.timeout(30000),
  });
  if (!res1.ok) {
    const t = await res1.text().catch(() => '');
    throw new Error('生图服务返回 ' + res1.status + (t ? '：' + t.slice(0, 120) : ''));
  }
  const created = await res1.json();
  const statusUrl = created.status_url || created.statusUrl;
  const resultUrl = created.response_url || created.responseUrl;
  if (!statusUrl) throw new Error('生图服务没有返回任务地址');

  // 实测出图 20-40 秒；默认 3 秒一探、最多 50 次（≈150 秒），超了直接认失败
  // （外面还有矢量插画兜底）。间隔与次数可调，只为了让自检能在秒级跑完。
  const pollMs = Math.max(10, Number(process.env.IMAGE_POLL_MS || 3000) || 3000);
  const pollMax = Math.max(1, Math.min(200, Number(process.env.IMAGE_POLL_MAX || 50) || 50));
  let done = null;
  for (let i = 0; i < pollMax; i++) {
    await new Promise(r => setTimeout(r, pollMs));
    const r = await fetch(statusUrl, { headers: auth, signal: AbortSignal.timeout(20000) });
    if (!r.ok) continue;
    const j = await r.json();
    const st = String(j.status || '').toUpperCase();
    if (st === 'COMPLETED' || st === 'OK' || st === 'SUCCESS') { done = j; break; }
    if (st === 'ERROR' || st === 'FAILED') throw new Error('生图失败：' + JSON.stringify(j).slice(0, 140));
  }
  // 图片可能挂在**两个地方**：状态接口的 result.images，或另一个 response_url。
  // 实测七牛是把图放在状态响应的 result 里，但只认一种写法就等着换服务商时炸，
  // 所以两边都看；实在没有才让调用方去退回矢量插画。
  const pickImg = bag => {
    if (!bag) return null;
    const a = (bag.images && bag.images[0]) || (bag.result && bag.result.images && bag.result.images[0]) || null;
    return a ? (a.url || a.image_url || null) : null;
  };
  let imgUrl = pickImg(done);
  if (!imgUrl && resultUrl) {
    const r = await fetch(resultUrl, { headers: auth, signal: AbortSignal.timeout(20000) });
    if (r.ok) { try { imgUrl = pickImg(await r.json()); } catch (e) {} }
  }
  if (!imgUrl) throw new Error('生图服务没有返回图片');

  const ir = await fetch(imgUrl, { signal: AbortSignal.timeout(45000) });
  if (!ir.ok) throw new Error('下载生成的图片失败 ' + ir.status);
  const buf = Buffer.from(await ir.arrayBuffer());
  if (!buf.length) throw new Error('生成的图片是空的');
  if (buf.length > IMAGE_MAX_BYTES) throw new Error('生成的图片超过 10MB');

  const file = saveImage(spaceId, {
    filename: 'AI配图-' + D.uid('') + '.png',
    dataBase64: buf.toString('base64'),
    conversationId: o.conversationId || null,
  });
  return {
    mode: 'raster', fileId: file.id, url: '/api/files/' + file.id,
    title: String(o.title || 'AI 配图').slice(0, 40), bytes: buf.length,
  };
}

async function runImageJob(job) {
  const p = job.input || {};
  const prompt = String(p.prompt || '').slice(0, 600);
  if (!prompt) { failJob(job.id, '没有描述要画什么'); return; }
  touchJob(job.id, '正在理解要画什么…');
  const cfg = imageConfig();
  if (cfg.enabled) {
    const res = await fetch(cfg.url, {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' },
        cfg.key ? { Authorization: 'Bearer ' + cfg.key } : {}),
      body: JSON.stringify({ model: cfg.model, prompt: prompt, n: 1, size: cfg.size, response_format: 'b64_json' }),
    });
    if (!res.ok) throw new Error('配图服务返回 ' + res.status);
    const j = await res.json();
    const d = (j.data && j.data[0]) || {};
    touchJob(job.id, '正在保存图片…');
    if (d.b64_json) { finishJob(job.id, { mode: 'raster', data: d.b64_json, mime: 'image/png', prompt: prompt }); return; }
    if (d.url) { finishJob(job.id, { mode: 'raster', url: d.url, prompt: prompt }); return; }
    throw new Error('配图服务没有返回图片');
  }
  // ★ AI 生图档位（规划 / 总结 / 计划）：这里要的是好看的成品插画，不是线条矢量图
  if (p.style === 'concept' && aiArtConfig().enabled) {
    try {
      touchJob(job.id, 'AI 正在画插图，约 20-40 秒…');
      const art = await generateAIImage(job.spaceId, prompt, { conversationId: p.conversationId, title: p.title });
      art.prompt = prompt;
      if (p.messageId) {
        attachArtifact(job.spaceId, p.messageId, {
          kind: 'illustration', mode: 'raster', fileId: art.fileId, title: art.title, prompt: prompt,
        });
      }
      finishJob(job.id, art);
      return;
    } catch (e) {
      // 生图失败不能让这条回答变成"什么都没有"：退回矢量插画兜底，
      // 并且**如实说**换了档 —— 教育产品不能假装成功。
      try { console.warn('[aiart] 生成失败，退回矢量插画：', e && e.message); } catch (_) {}
      touchJob(job.id, 'AI 出图失败，改用矢量插画…');
    }
  }
  touchJob(job.id, '正在画…');
  const art = await generateIllustration(prompt);
  art.prompt = prompt;
  if (p.messageId) {
    attachArtifact(job.spaceId, p.messageId, {
      kind: 'illustration', title: art.title, palette: art.palette, elements: art.elements,
    });
  }
  finishJob(job.id, art);
}

// ---------- 扫描件 OCR 任务 ----------
/**
 * 把一份扫描件 PDF 逐页识别成文字。
 *
 * 为什么必须走异步任务：一本教材 = 上百次视觉模型调用，几分钟起步。
 * 卡在 HTTP 请求里会超时，用户在资料列表里也看不到任何进展。
 *
 * 三条不能省的纪律：
 *   ① 心跳要自己续 —— 单页超时 90 秒、还要重试一次，比"任务僵死"阈值（70 秒）长，
 *      不自己续心跳，正在正常跑的活会被 sweepStale 当尸体清掉。
 *   ② 进度要真写库 —— 「识别中 37/130」得是真数字，不是装饰性转圈。
 *   ③ 部分失败要如实说 —— 少数几页没识别出来，和"书里本来没有这一页"是两回事，
 *      后者会让 AI 用"教材里没有讲"去误导学生。
 */
async function runOcrJob(job) {
  const p = job.input || {};
  const docId = p.docId;
  const row = kb.getDocumentRow(job.spaceId, docId);
  if (!row) throw new Error('这份资料已经不在了');
  // 下面几条"跑不起来"的原因都要**顺手把文档状态改掉**：
  // 只让任务失败、把文档留在 parsing，用户就会看到一份永远转圈的资料。
  if (!row.storage_path) {
    kb.failDocumentParse(job.spaceId, docId, '原件已经不在了，请重新上传这份资料。');
    throw new Error('原件已经不在了，请重新上传');
  }
  let buf;
  try { buf = fs.readFileSync(row.storage_path); }
  catch (e) {
    kb.failDocumentParse(job.spaceId, docId, '读不到原件，请重新上传这份资料。');
    throw new Error('读不到原件，请重新上传');
  }

  const cfg = ocr.ocrConfig();
  if (!cfg.enabled) {
    kb.failDocumentParse(job.spaceId, docId, ocr.OCR_DISABLED_NOTE);
    throw new Error(ocr.OCR_DISABLED_NOTE);
  }

  const images = extract.pdfPageImages(buf);
  if (!images.length) {
    kb.failDocumentParse(job.spaceId, docId,
      '这是一份扫描件，但没能从中取出逐页的图片，无法识别文字。建议换成可复制文字的 PDF。');
    finishJob(job.id, { docId: docId, pages: 0, ok: 0, failed: 0, chars: 0 });
    return;
  }
  const total = Math.min(images.length, cfg.maxPages || images.length);
  const truncated = total < images.length;
  touchJob(job.id, '正在识别第 1 / ' + total + ' 页…');

  // 自己续心跳：一页最长可能占住 90 秒 × 2 次重试，比僵死阈值长得多。
  const beat = setInterval(() => { try { touchJob(job.id, ''); } catch (_) {} }, Math.floor(JOB_HEARTBEAT_MS / 2));

  let res;
  try {
    res = await ocr.ocrImages(images, {
      onPage: function (s) {
        try {
          kb.setDocumentProgress(job.spaceId, docId, Math.round(s.done / s.total * 100));
          touchJob(job.id, '已识别 ' + s.done + ' / ' + s.total + ' 页…');
        } catch (_) {}
      },
    });
  } finally {
    clearInterval(beat);
  }

  const text = ocr.assembleOcrText(res.pages);
  const okPages = res.pages.filter(function (t) { return String(t || '').trim(); }).length;
  if (!text) {
    kb.failDocumentParse(job.spaceId, docId,
      '这份扫描件没能识别出文字（' + res.failed.length + ' 页识别失败）。可能是图片太模糊，或者整本都是插图。');
    finishJob(job.id, { docId: docId, pages: total, ok: 0, failed: res.failed.length, chars: 0 });
    return;
  }
  const notes = [];
  if (res.failed.length) {
    notes.push('有 ' + res.failed.length + ' 页没识别成功（第 '
      + res.failed.slice(0, 8).map(function (f) { return f.page; }).join('、')
      + (res.failed.length > 8 ? ' 等' : '') + ' 页），其余已入库。可点「重新识别」再试一次。');
  }
  if (truncated) notes.push('按设置只识别了前 ' + total + ' 页。');
  kb.saveOcrText(job.spaceId, docId, text, { pages: total, note: notes.join(' ') || null });
  touchJob(job.id, '识别完成');
  finishJob(job.id, {
    docId: docId, pages: total, ok: okPages,
    failed: res.failed.length, chars: text.length, truncated: truncated,
  });
}

registerRunner('ocr', runOcrJob);

registerRunner('image', runImageJob);
// interactive 任务由 interactive.js 自己 finishJob（含自愈与 preset 兜底），worker 不参与生成。
// 挂一个空 runner只是为了让 chat.createJob(spaceId, userId, 'interactive', payload) 通过 RUNNERS 校验，
// 且不会把任务误判为"失败"——否则 tick 里 `if (!runner) failJob(...)` 会把它判死。
registerRunner('interactive', async () => {});

// ============================================================
// 五、上传（图片 / 文档）
// ============================================================
// 对方的上限是 10MB，超了就跳过并说明，不是整个失败。
const IMAGE_MAX_BYTES = 10 * 1024 * 1024;
const IMAGE_TYPES = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp',
};

function extOf(name) {
  const m = String(name || '').toLowerCase().match(/\.([a-z0-9]+)$/);
  return m ? m[1] : '';
}

function uploadDir(spaceId) {
  const dir = path.join(D.DATA_DIR, 'uploads', D.normalizeSpace(spaceId));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function saveImage(spaceId, { filename, dataBase64, conversationId }) {
  const name = String(filename || '图片').slice(0, 200);
  const ext = extOf(name);
  if (!IMAGE_TYPES[ext]) {
    const e = new Error('请拖入图片文件（支持 PNG, JPG, GIF 等格式）');
    e.code = 'BAD_TYPE'; e.skipped = true;
    throw e;
  }
  const clean = String(dataBase64 || '').replace(/^data:[^;]+;base64,/, '');
  if (!clean) { const e = new Error('图片内容为空'); e.code = 'BAD_INPUT'; throw e; }
  const buf = Buffer.from(clean, 'base64');
  if (buf.length > IMAGE_MAX_BYTES) {
    const e = new Error('图片 ' + name + ' 大小超过 10MB，已跳过');
    e.code = 'TOO_BIG'; e.skipped = true;
    throw e;
  }
  const id = D.uid('att_');
  const file = path.join(uploadDir(spaceId), id + '.' + ext);
  fs.writeFileSync(file, buf);
  return {
    id: id, name: name, kind: 'image', size: buf.length,
    mime: IMAGE_TYPES[ext], path: file, conversationId: conversationId || null,
  };
}

/**
 * 给一份「扫描件」排 OCR 任务。
 *
 * 单独抽出来的原因：有**两个入口**都要排队 —— 上传入库（saveDocument），
 * 以及用户在列表里点「重新识别」（reparse）。只做前者的话，重新识别会
 * 把状态改成 parsing 却没人去跑，文档永远转圈。
 *
 * 返回 jobId；排不上队返回 null，并把文档改成可重试的失败态。
 */
function queueOcrJob(spaceId, userId, doc) {
  if (!doc || !doc.id) return null;
  let job = null;
  try {
    job = createJob(spaceId, userId, 'ocr', {
      docId: doc.id, filename: doc.filename, pages: doc.pages,
      conversationId: doc.conversationId || null,
    });
    // 把任务和资料绑起来：任务被清掉时靠它把文档从"识别中"捞出来
    // （见 reconcileOcrDocs）—— 不然文档会永远停在解析中。
    D.run('UPDATE jobs SET doc_id = ? WHERE id = ?', doc.id, job.id);
    return job.id;
  } catch (e) {
    // 排不上队必须立刻改状态 —— 否则这份资料会永远停在"解析中"，
    // 用户既看不到进度也不明白哪里错了。
    const why = '识别任务没能排上队，请点「重新识别」重试。';
    try { kb.failDocumentParse(spaceId, doc.id, why); } catch (_) {}
    doc.status = 'failed'; doc.error = why; doc.state = 'todo'; doc.stateText = '需处理';
    return null;
  }
}

function saveDocument(spaceId, userId, { filename, dataBase64, text, conversationId, categoryId, projectId, scope }) {
  const doc = kb.addDocument(spaceId, userId, {
    filename: filename, dataBase64: dataBase64, text: text,
    categoryId: categoryId, projectId: projectId,
    conversationId: conversationId, scope: scope || (conversationId ? 'temp' : 'kb'),
  });
  // 扫描件：kb 只把它标成 parsing，真正"排队去识别"这一步在这里做 ——
  // kb.js 不该依赖任务系统（它还要能在没有 worker 的脚本里被单独调用），反过来才顺。
  if (doc && doc.scanned) {
    const jobId = queueOcrJob(spaceId, userId, doc);
    if (jobId) doc.jobId = jobId;
    delete doc.scanned;
  }
  return doc;
}

/** 附件读取（供 /api/files/:id 用）。只允许读自己空间目录下的文件。 */
function readAttachment(spaceId, id) {
  if (!/^att_[a-z0-9]+$/.test(String(id || ''))) return null;
  const dir = path.join(D.DATA_DIR, 'uploads', D.normalizeSpace(spaceId));
  let names;
  try { names = fs.readdirSync(dir); } catch (e) { return null; }
  const hit = names.filter(n => n.indexOf(id + '.') === 0)[0];
  if (!hit) return null;
  const full = path.join(dir, hit);
  const ext = extOf(hit);
  return { path: full, mime: IMAGE_TYPES[ext] || 'application/octet-stream', name: hit };
}

// ============================================================
// 六、对话级临时资料
// ============================================================
function listTempDocs(spaceId, conversationId) {
  return kb.listDocuments(spaceId, { conversationId: conversationId, scope: 'temp' });
}

/**
 * 批量查询解析状态。
 * 前端在上传完一批文件后轮询这个接口，对应对方的
 * 「文档正在解析中，请稍候...」与「batch polling 临时文档状态失败」。
 */
function tempDocStatus(spaceId, ids) {
  const out = {};
  (Array.isArray(ids) ? ids : []).slice(0, 50).forEach(id => {
    const d = kb.getDocument(spaceId, id, false);
    if (!d) { out[id] = { status: 'missing', progress: 0 }; return; }
    out[id] = { status: d.status, progress: d.progress, filename: d.filename, pages: d.pages, error: d.error || null };
  });
  return out;
}

function removeTempDoc(spaceId, id) {
  const d = D.get('SELECT * FROM kb_documents WHERE id = ? AND space_id = ?', id, spaceId);
  if (!d) return false;
  if ((d.scope || 'kb') !== 'temp') {
    const e = new Error('这不是临时资料，请到资料库里删除'); e.code = 'NOT_TEMP';
    throw e;
  }
  return kb.deleteDocument(spaceId, id);
}

// ============================================================
// 七、智能体（复用能力中心的技能注册表）
// ============================================================
// 对方是"选择 AI 助手 / 搜索智能体 / 全部智能体"。
// 我们不另建一套智能体数据 —— 能力中心那 57 个技能就是我们的智能体，
// 这样"开了一个技能"和"能选一个智能体"是同一件事，学生不会困惑。
function listAgents(spaceId, opts) {
  const o = opts || {};
  const all = skills.list(spaceId, {});
  const q = String(o.q || '').trim().toLowerCase();
  const filtered = q
    ? all.filter(a => (a.name + ' ' + (a.description || '') + ' ' + (a.subject || '')).toLowerCase().indexOf(q) >= 0)
    : all;
  const cats = [];
  const seen = {};
  filtered.forEach(a => {
    if (!seen[a.category]) { seen[a.category] = 1; cats.push(a.category); }
  });
  return {
    total: all.length,
    categories: cats,
    agents: filtered.map(a => ({
      id: a.id, name: a.name, icon: a.icon, description: a.description,
      subject: a.subject, category: a.category, enabled: a.enabled,
      // locked / tierName / lockedNote 必须一起带上（2026-10-03）。
      // 原来只给 enabled，前端就只能把"没全局启用"和"档位锁住"都画成「未开启」——
      // 而这两件事后果完全不同：
      //   · 没启用 → **不影响**在这段对话里用它（对话级技能只过档位闸，
      //     见 skills.promptsFor 里那条注释），选中就生效；
      //   · 档位锁住 → 真的用不了，promptsFor 会把它静默滤掉。
      // 不区分的话，学生会选中一个锁住的助手、看到"已选「XX」"，
      // 然后 AI 表现毫无变化 —— 静默失效比直接拦下难查得多。
      locked: !!a.locked, tierName: a.tierName || '', lockedNote: a.lockedNote || '',
    })),
  };
}

// ============================================================
// 八、模型清单（带分类说明）
// ============================================================
const MODEL_TAGS = {
  default: { tag: '通用', tip: '日常对话与讲解，响应快' },
  deep: { tag: '深度思考', tip: '复杂难题拆解，慢一点但更稳' },
};

function listModels() {
  return llm.MODELS.map(m => {
    const t = MODEL_TAGS[m.id] || {};
    return {
      id: m.id, name: m.name, displayName: m.displayName,
      desc: m.desc || t.tip || '', tag: t.tag || m.name,
      color: m.color, thinking: !!m.thinking,
      mock: llm.isMock(),
    };
  });
}

// ============================================================
// 九、分享管理（列表 + 访问次数）
// ============================================================
function listShares(spaceId, kind) {
  let sql = 'SELECT * FROM shares WHERE space_id = ?';
  const p = [spaceId];
  if (kind) { sql += ' AND kind = ?'; p.push(kind); }
  sql += ' ORDER BY updated_at DESC LIMIT 100';
  return D.all(sql, ...p).map(s => {
    let title = '';
    if (s.kind === 'conversation') {
      const c = D.get('SELECT title FROM conversations WHERE id = ?', s.target_id);
      title = c ? c.title : '';
    } else if (s.kind === 'report') {
      // 报告分享表在批次5/6 才建；这里用 try 兜住，避免"表还不存在"时整个接口挂掉
      try {
        const r = D.get('SELECT title FROM reports WHERE id = ?', s.target_id);
        title = r ? r.title : '';
      } catch (e) { title = ''; }
    }
    return {
      id: s.id, kind: s.kind, targetId: s.target_id, token: s.token,
      title: title, views: s.views, active: !!s.active,
      createdAt: s.created_at, updatedAt: s.updated_at,
    };
  });
}

// ============================================================
// 十、对话删除时的附件清理
// ============================================================
function cleanupConversationFiles(spaceId, conversationId) {
  let n = 0;
  const msgs = D.all('SELECT attachments_json FROM messages WHERE conversation_id = ?', conversationId);
  msgs.forEach(m => {
    const list = m.attachments_json ? core.safeJSON(m.attachments_json) : null;
    (list || []).forEach(a => {
      if (a && a.path) { try { fs.unlinkSync(a.path); n++; } catch (e) {} }
    });
  });
  return n;
}

// ============================================================
// 十一、消息操作聚合（给路由用，减少 server.js 的分支）
// ============================================================
function toggleFavorite(spaceId, messageId) {
  const m = core.getMessage(spaceId, messageId);
  if (!m) { const e = new Error('消息不存在'); e.code = 'NOT_FOUND'; throw e; }
  const next = !m.isFavorite;
  core.updateMessage(spaceId, messageId, { isFavorite: next });
  return { isFavorite: next };
}

function listFavorites(spaceId) {
  const rows = D.all(`SELECT m.*, c.title AS conv_title FROM messages m
                      JOIN conversations c ON c.id = m.conversation_id
                      WHERE c.space_id = ? AND m.is_favorite = 1 AND m.deleted = 0
                      ORDER BY m.created_at DESC LIMIT 200`, spaceId);
  return rows.map(m => Object.assign(core.shapeMessage(m), { conversationTitle: m.conv_title }));
}

// ============================================================
// 三·五、图片：链接里的图 / 学生上传的图 —— 交给视觉模型变成文字
// ============================================================
/**
 * 读链接（**含图片**）。
 *
 * webdoc 只负责"把字节抓回来"：网页出正文，图片就把字节原样交给我们。
 * 图片这一步必须在**这一层**合流 —— 只有这里知道有没有视觉模型可用，
 * 而 webdoc 不该为了"读网页"这件事背上 OCR 的依赖。
 *
 * 转不成文字的图片**如实记进 failed**：不能让它静默消失在"已读取"里，
 * 那等于告诉模型"那张图是空的"。
 */
async function readLinks(urls, o) {
  const res = await webdoc.readLinks(urls, o);
  const pages = [];
  const failed = (res.failed || []).slice();
  for (const p of res.pages || []) {
    if (!p.image) { pages.push(p); continue; }
    let text = '';
    try { text = await ocr.describeImage(p.data, { mime: p.mime }); }
    catch (e) { text = ''; }
    if (text) {
      pages.push({
        url: p.url, finalUrl: p.finalUrl, fromImage: true, title: '图片',
        text: text, truncated: false, chars: text.length,
      });
    } else {
      failed.push({ url: p.url, reason: 'IMAGE', message: '这是一张图片，但没能识别出里面的内容（可能是识别模型没配好，或者图太糊了）' });
    }
  }
  return {
    ok: pages.length > 0, urlCount: res.urlCount, pages, failed,
    imageCount: (res.pages || []).filter(p => p.image).length,
  };
}

/**
 * 学生随消息上传的图片 → 文字。
 *
 * ★ 旧行为是告诉模型"你看不到图片内容本身"，于是模型只会回一句
 *   "请你用文字描述图里最关键的条件"。孩子拍了张错题照片来问，得到这个回答，
 *   是产品最不该出现的一幕（拍照问题比打字自然得多）。
 *
 * 现在：**有视觉模型就真的看图**，把它转成文字喂给主模型；识别不了就如实说。
 * 上限 3 张 —— 一次发十张图去识别会把配额和等待时间都拖爆。
 *
 * @returns {{text:string, ok:number, failed:number, total:number}}
 */
async function describeAttachments(spaceId, atts) {
  const imgs = (Array.isArray(atts) ? atts : []).filter(a => a && a.kind === 'image').slice(0, 3);
  if (!imgs.length) return { text: '', ok: 0, failed: 0, total: 0 };
  const blocks = [];
  let ok = 0, failed = 0;
  for (let i = 0; i < imgs.length; i++) {
    const a = imgs[i];
    const name = String(a.name || ('图片' + (i + 1)));
    let buf = null;
    try {
      if (a.path) buf = fs.readFileSync(a.path);
      else if (a.id) { const rd = readAttachment(spaceId, a.id); if (rd) buf = fs.readFileSync(rd.path); }
    } catch (e) { buf = null; }
    if (!buf || !buf.length) { failed++; blocks.push('《' + name + '》：文件读不到。'); continue; }
    if (buf.length > IMAGE_MAX_BYTES) { failed++; blocks.push('《' + name + '》：图片太大（超过 ' + Math.round(IMAGE_MAX_BYTES / 1048576) + 'MB）。'); continue; }
    let txt = '';
    try { txt = await ocr.describeImage(buf, { mime: a.mime }); } catch (e) { txt = ''; }
    if (txt) { ok++; blocks.push('《' + name + '》：\n' + txt); }
    else { failed++; blocks.push('《' + name + '》：没能识别出内容（当前没有可用的识别模型，或者图片太模糊）。'); }
  }
  return { text: blocks.join('\n\n'), ok, failed, total: imgs.length };
}

module.exports = {
  // TTS
  TTS_MAX_CHARS, speak, getTtsPref, setTtsPref, clampRate, ttsSlot, setTtsSlot, ttsVoiceCandidates,
  // 翻译
  DIRECTIONS, detectDirection, translateMessage,
  // 搜索（planWebSearch = 搜之前的意图判断与检索词提炼，见函数注释）
  webSearch, planWebSearch, searchContext, searchConfig,
  // 读链接（学生直接甩 URL 过来时真的去看那个页面；图片直链交给视觉模型看成文字）
  extractUrls: webdoc.extractUrls, readLinks, linkContext: webdoc.linkContext,
  // 学生上传的图片 → 文字（旧行为只会告诉模型"你看不到图片"，那是产品硬伤）
  describeAttachments,
  // 任务
  JOB_HEARTBEAT_MS, JOB_STALE_MS, JOB_MAX_MS, registerRunner, createJob, getJob, listJobs,
  touchJob, finishJob, failJob, tick, startWorker, stopWorker, sweepStale,
  imageConfig, generateIllustration, sanitizeElements, ILLU_FIELDS, shouldIllustrate,
  PLAN_PROMPT, PLAN_LIMITS, sanitizePlan, shouldPlanCard, generatePlanCard,
  aiArtConfig, shouldConceptArt, buildArtScene, generateAIImage, attachArtifact,
  // 上传
  IMAGE_MAX_BYTES, IMAGE_TYPES, saveImage, saveDocument, readAttachment, extOf,
  // 扫描件 OCR（runOcrJob / queueOcrJob 导出是为了测试能直接驱动它们）
  runOcrJob, queueOcrJob,
  // 临时资料
  listTempDocs, tempDocStatus, removeTempDoc,
  // 智能体 / 模型 / 分享
  listAgents, listModels, listShares,
  // 杂项
  cleanupConversationFiles, toggleFavorite, listFavorites,
};

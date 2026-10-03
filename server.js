'use strict';
/**
 * 后浪学习平台 · 服务端入口
 *
 * 零依赖：只用 Node 22 内置模块（http / fs / path / crypto / node:sqlite）。
 * 路由分发沿用旧版 handleApi 的结构，业务拆到 server/ 下的模块。
 *
 * 启动：node server.js
 * 环境变量：PORT / DATA_DIR / ADMIN_PASSWORD / LLM_BASE_URL / LLM_API_KEY / LLM_MODEL
 *   （也可写在同目录 .env 里；.env 只填未设置的变量，故沙箱注入的 PORT 优先）
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

/**
 * 极简 .env 加载（零依赖）：只填充**尚未设置**的环境变量。
 *
 * 为什么必须有它：发布到 WorkBuddy 云端时，发布工具**不能传环境变量**，
 * 沙箱里只有 PORT。模型 Key 只能随代码一起上传 —— 也就是靠这个 .env。
 * 没有它，云端会静默退化成"离线演示模式"，AI 只会回一句固定的话。
 *
 * ★ 位置很关键：必须放在下面 require('./server/*') **之前**。
 *   db.js 在 import 时就读 DATA_DIR、llm.js 读 LLM_API_KEY —— 加载器晚一行，
 *   这些模块拿到的就是默认值，.env 白写。
 *
 * 设 NO_DOTENV=1 可跳过（自动化测试必须用）：否则测试会读到开发者本机的真实 .env，
 * 把"未配置模型"这类用例污染成真实调用（旧项目曾因此误连真实生图接口）。
 */
(function loadEnv() {
  if (process.env.NO_DOTENV === '1') return;
  try {
    const ef = path.join(__dirname, '.env');
    if (!fs.existsSync(ef)) return;
    for (const raw of fs.readFileSync(ef, 'utf8').split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq < 0) continue;
      const k = line.slice(0, eq).trim();
      let v = line.slice(eq + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      // 只填未设置的 —— 这样沙箱注入的 PORT 一定优先于 .env 里的任何值
      if (process.env[k] === undefined) process.env[k] = v;
    }
  } catch (e) { /* .env 坏了不该拦住启动 */ }
})();

const D = require('./server/db');
const auth = require('./server/auth');
const account = require('./server/account');
const llm = require('./server/llm');
const core = require('./server/core');
const chat = require('./server/chat');
const cards = require('./server/cards');
const interactive = require('./server/interactive');
const pet = require('./server/pet');
const dash = require('./server/dashboard');
const daily = require('./server/daily');
const weekly = require('./server/weekly');
const parent = require('./server/parent');
const skills = require('./server/skills');
const kb = require('./server/kb');
const english = require('./server/english');
const exam = require('./server/exam');
const growth = require('./server/growth');
const pool = require('./server/pool');
const adminDash = require('./server/admin');

// 版本号：每次发布前 bump。不改的话，线上跑的是新代码还是旧沙箱根本分不出来
// （旧项目就吃过这个亏 —— 只能靠比对某个函数在不在前端文件里来判断）。
const APP_VERSION = '2026-10-03-admin-dash2';
const PORT = Number(process.env.PORT || 3100);
const PUBLIC_DIR = path.join(__dirname, 'public');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const ADMIN_TOKENS = new Set();

// ---------- 工具 ----------
function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}
function readBody(req, maxBytes) {
  const cap = maxBytes || 8 * 1024 * 1024;
  return new Promise((resolve) => {
    let d = '';
    req.on('data', c => { d += c; if (d.length > cap) req.destroy(); });
    req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch (e) { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
};
function serveStatic(req, res, pathname) {
  let rel;
  // decodeURIComponent 遇到畸形转义（如 /%）会抛异常 —— 那是客户端的问题，回 400。
  try { rel = decodeURIComponent(pathname); } catch (e) { return sendJSON(res, 400, { error: 'BAD_URL' }); }
  if (rel === '/' || rel === '') rel = '/index.html';
  // 管理员看板是独立页面，不塞进 SPA。
  // 为什么不走 index.html 的前端路由：它是内部工具，跟学生的对话界面没有共享状态，
  // 单独一个 html 更小、加载更快，也不会被学生侧的任何改动牵连。
  if (rel === '/admin' || rel === '/admin/') rel = '/admin.html';
  // 路径越界护栏。
  // ★ 不要用 startsWith 比较：'C:\proj\public-x' 是 'C:\proj\public' 的前缀，
  //   于是 /../public-x/… 这种请求能通过检查，读到一个名字以 public 开头的兄弟目录。
  //   现在项目根目录里放着带真实 Key 的 .env，这种"看起来能用"的护栏不能留。
  //   用 path.relative 判断落点是否真的在 public/ 里面。
  const root = path.resolve(PUBLIC_DIR);
  const file = path.resolve(root, '.' + (rel.charAt(0) === '/' ? rel : '/' + rel));
  const inside = path.relative(root, file);
  if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) {
    return sendJSON(res, 403, { error: 'FORBIDDEN' });
  }
  fs.readFile(file, (err, buf) => {
    if (err) {
      // SPA 回退：非 /api 的未知路径交回前端路由
      if (path.extname(rel) === '') return serveStatic(req, res, '/index.html');
      return sendJSON(res, 404, { error: 'NOT_FOUND' });
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
}

// ---------- 鉴权 ----------
// 云宿主(app.workbuddy.host)的反代会剥掉 Authorization / x-token 等自定义请求头，
// 导致所有带鉴权的接口收不到 token → 全员 401。已验证：同样的 token 放进查询串 ?_t= 能完整到达后端。
// 故优先读 ?_t=，再退回头（兼容 sg.agentos-app.run 等不剥头的宿主）。
function bearer(req) {
  try {
    const q = new URL(req.url, 'http://x').searchParams.get('_t');
    if (q) return q;
  } catch (_) {}
  const h = req.headers['authorization'] || '';
  if (h.startsWith('Bearer ')) return h.slice(7).trim();
  return req.headers['x-token'] || '';
}
function reqToken(req) {
  try {
    const q = new URL(req.url, 'http://x').searchParams.get('_t');
    if (q) return q;
  } catch (_) {}
  return req.headers['x-token'] || '';
}
// 返回 { spaceId, userId, kind } 或 null
function ctxOf(req) {
  const s = auth.resolveSession(bearer(req));
  if (!s) return null;
  return { spaceId: s.space_id, userId: s.user_id || null, kind: s.kind, token: s.token };
}

// ---------- 流式对话核心（发送 / 重新生成共用）----------
/**
 * 「停止生成」的显式标记。
 *
 * ★ 为什么需要它，而不是靠 req 的 close 事件判断：
 *   断流和"用户点了停止"在 TCP 层面长得一模一样 —— 都是连接没了。
 *   但它们要的结果完全相反：
 *     · 用户点停止  → 立刻停，保留已生成的部分（status='aborted'）
 *     · 网络断/切后台 → **继续生成**，写完库等前端回来捞
 *   所以必须让前端在"点停止"时明确说一声（POST /api/messages/:id/stop），
 *   剩下的 close 一律当成意外断流 —— 继续把答案生成完。
 *   否则"SSE 断流恢复：已从 DB 拉到完整回复"就是假的：
 *   DB 里只有半截，捞回来还是半截。
 */
const STOP_FLAGS = new Set();

/**
 * 一次 SSE 生成。
 *
 * 断流恢复的关键设计：助手回复**先落一行 status='streaming' 的占位消息**，
 * 边生成边把已产出的内容回写 DB；即使前端断开也继续生成到完成。
 */
async function streamReply(req, res, ctx, sid, opt) {
  const conv = opt.conv;
  const model = opt.model || conv.model || 'default';

  // 附件与文本一起存进用户消息 —— 这样刷新页面还能看到"当时发的是哪张图"
  const userMsg = opt.skipUserMessage ? null : core.addMessage(sid, conv.id, {
    role: 'user', content: opt.text,
    attachments: opt.attachments && opt.attachments.length ? opt.attachments : null,
    clientId: opt.clientId || null,
  });

  // 联网搜索：开了才搜；搜不到/没配通道都如实回传，由前端告诉学生"本条未联网"
  // ★ 2026-10-02 改：以前把整条消息直接当搜索词（webSearch(opt.text)）——
  //   学生说「格子只能从上边和左边来，那到达的数怎么算」，整句就被丢进搜索引擎，
  //   搜回一排字面沾边的垃圾页，前端渲染成「新词搜索」列表，纯属干扰。
  //   现在先让模型判断"这条要不要联网 + 提炼检索词"（chat.planWebSearch），
  //   不需要联网就一条请求都不发；需要联网也只拿提炼后的短关键词去搜。
  //   前端只在真搜过时显示「联网搜索：<检索词>」，没搜就完全不出现联网字样。
  let searchRes = null;
  if (opt.webSearch && opt.text) {
    let plan = null;
    try {
      // 最近几轮（不含刚落库的这条用户消息）给调度器做上下文，追问"那第二点呢"才有判断依据
      const planHist = core.buildContext(sid, conv.id, 8).messages
        .filter(m => m.content).slice(0, -1)
        .map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content).slice(0, 500) }));
      plan = await chat.planWebSearch(opt.text, { history: planHist, model: model });
    } catch (e) { plan = { need: true, query: opt.text }; }
    if (plan.need) {
      try { searchRes = await chat.webSearch(plan.query || opt.text, { limit: 5 }); }
      catch (e) { searchRes = { ok: false, reason: 'ERROR', results: [], message: '联网搜索暂时不可用，本条回答未联网' }; }
      if (searchRes) searchRes.query = plan.query || '';
    }
  }

  // 读链接：学生直接把 URL 发过来时，**真的去打开那个页面**。
  // 这和"联网搜索"是两件事 —— 搜索是把问题当关键词去搜（拿回来的是转载页），
  // 读链接是打开他指定的那一页。发链接本身就是明确指令（"你看下这个"），
  // 所以**不看联网搜索开关**，否则学生会以为发了链接 AI 却不看。
  // 抓取全程不抛错，读不到的链接也如实进上下文（见 webdoc.js）。
  let linkRes = null;
  if (opt.text) {
    const urls = chat.extractUrls(opt.text, 3);
    if (urls.length) {
      try { linkRes = await chat.readLinks(urls, { limit: 3 }); }
      catch (e) {
        linkRes = { ok: false, urlCount: urls.length, pages: [], failed: urls.map(u => ({ url: u, message: '读取失败' })) };
      }
    }
  }

  // 组装上下文
  const proj = conv.projectId ? core.getProject(sid, conv.projectId) : null;
  const mem = core.getMemory(sid);
  // 资料检索：优先在项目绑定的资料里找；没找到再退到全库
  // conversationId 必须传 —— 临时资料只对所属对话可见
  const projDocIds = proj && proj.docs.length ? proj.docs.map(d => d.id) : null;
  let docCtx = { hits: [], text: '' };
  try {
    docCtx = kb.contextFor(sid, opt.text, { limit: 5, docIds: projDocIds, conversationId: conv.id });
    if (!docCtx.hits.length && projDocIds) docCtx = kb.contextFor(sid, opt.text, { limit: 5, conversationId: conv.id });
  } catch (e) { docCtx = { hits: [], text: '' }; }

  // 技能提示词：全局启用的技能 + 这条对话选中的智能体
  let skillPrompts = skills.promptsFor(sid, opt.skillIds);
  if (conv.agentId) {
    const agentPrompt = skills.promptsFor(sid, [conv.agentId]);
    if (agentPrompt.length) skillPrompts = skillPrompts.concat(agentPrompt);
  }

  // 对话级临时资料（聊天窗口粘贴 / 「＋」传进来的）。只靠检索会漏：
  // 问得泛（"帮我看看这份卷子"）时一条都命中不了，模型手里就完全没有这份资料 ——
  // 用户看到的现象就是"AI 没读我粘贴的文档"。所以清单无条件带上，正文留着零命中时兜底。
  let tempDocs = [];
  try {
    tempDocs = chat.listTempDocs(sid, conv.id).map(d => ({
      filename: d.filename, status: d.status, error: d.error,
      text: d.status === 'ready' ? ((kb.getDocument(sid, d.id) || {}).text || '') : '',
    }));
  } catch (e) { tempDocs = []; }

  // ★ 模式只算一次，prompt 与落库共用同一个值。
  //   分开写的话，哪天默认值改了、或者某条分支忘了同步，看板上的模式分布
  //   就会和实际生效的模式不一致 —— 一个会撒谎的统计比没有统计更坏。
  const useMode = opt.mode || 'selfstudy';
  let system = llm.buildSystemPrompt({
    mode: useMode,
    spaceName: (auth.getSpace(sid) || {}).name,
    grade: ctx.userId ? (auth.profile(ctx.userId) || {}).grade : '',
    projectInstructions: proj ? proj.instructions : conv.instructions,
    docNames: proj ? proj.docs.map(d => d.filename) : [],
    memories: mem.enabled ? mem.memories.slice(0, 12) : [],
    skillPrompts: skillPrompts,
    docContext: docCtx.text,
    tempDocs: tempDocs,
  });
  // 学生随消息发来的图片：**真的看一眼**，再把内容以文字形式交给模型。
  // ★ 2026-10-02 改：以前这里只写"你看不到图片内容本身" —— 一个"拍错题来问"
  //   的产品，最常用的入口却只能让 AI 回一句"请你描述一下图里的条件"，是硬伤。
  //   现在走视觉模型转文字（主模型没有视觉能力，但读文字很在行）。
  if (opt.attachments && opt.attachments.length) {
    const imgs = opt.attachments.filter(a => a && a.kind === 'image');
    if (imgs.length) {
      let seen = { text: '', ok: 0, failed: 0, total: imgs.length };
      try { seen = await chat.describeAttachments(sid, imgs); } catch (e) { seen = { text: '', ok: 0, failed: imgs.length, total: imgs.length }; }
      if (seen.ok) {
        system += `\n\n【学生这次随消息发来的图片（已识别出内容，请直接使用）】\n${seen.text}\n`
          + `★ 这些就是他刚发给你的图片，内容已经转成文字放在上面。**不要再问"能不能描述一下图里的内容"**，直接依据它回答。`;
      } else {
        system += `\n\n【学生这次随消息发来的图片】\n${imgs.map(a => '- ' + a.name).join('\n')}\n`
          + `★ 这几张图**没能识别出内容**（原因见下），你看不到它们，不要假装看见了：\n${seen.text}\n`
          + `直接说明读不出来，并请他用文字说明图里最关键的条件。\n`
          + `（骗学生"我看到了"是最坏的做法：他会以为你看错了，而不是以为自己没说清楚。）`;
      }
    }
  }
  if (searchRes && searchRes.ok && searchRes.results.length) {
    system += `\n\n【本次联网搜索结果】\n${chat.searchContext(searchRes.results)}\n\n` +
      `引用网页时说明是第几条。仍然不要直接把结论给学生，用这些材料去反问。`;
  } else if (searchRes && searchRes.ok) {
    // ★ 联网是通的，但搜到的东西跟这个问题无关（搜索引擎丢词回退的产物）。
    //   这一支以前是空的 —— 意味着模型完全不知道自己没材料，最容易照着常识硬编。
    //   必须把"没材料"这件事明确告诉它，让它凭知识答并说明是凭知识。
    system += `\n\n【联网搜索】本次联网成功，但${searchRes.message || '没有搜到相关网页'}`
      + `（搜索引擎返回的都是跟这个话题沾边的泛泛页面，已经全部丢弃，没有一条能用）。\n`
      + `★ 回答时**不要声称查过网、也不要引用任何网页**。就当作没联网处理：`
      + `能凭你自己的知识答就答，并说清楚这是依据你掌握的内容、不是查到的；`
      + `拿不准就直说这个问题建议他去查官方的最新口径。严禁为了显得"查到了"而编造网页或数据。`;
  } else if (searchRes && !searchRes.ok) {
    system += `\n\n【联网搜索】本次未能联网（${searchRes.message}）。回答时不要声称查过网络。`;
  }
  const linkCtx = chat.linkContext(linkRes);
  if (linkCtx) system += '\n\n' + linkCtx;

  // 链接的元信息（**只存标题和错误，不存正文** —— 正文进 prompt 就够了，
  // 塞进 meta 会让消息记录膨胀好几倍，还会在前端重复渲染一遍）
  const linkMeta = linkRes ? {
    urlCount: linkRes.urlCount || 0,
    read: (linkRes.pages || []).length,
    // 读到的图片张数：前端据此把提示写成"已读取 1 张图片"，而不是笼统的"1 个链接"
    images: linkRes.imageCount || 0,
    pages: (linkRes.pages || []).map(p => ({ url: p.finalUrl, title: p.title, image: !!p.fromImage })),
    errors: (linkRes.failed || []).map(f => ({ url: f.url, message: f.message })),
  } : null;

  // 占位消息：先落库，再生成
  const placeholder = core.addMessage(sid, conv.id, {
    role: 'assistant', content: '', model: model, status: 'streaming',
    meta: {
      // mode 落库：以前只进 prompt 不落库，管理员看板想统计"自学/引导/深研"
      // 用了多少完全无从下手。写在这里，历史数据缺失的那段由看板如实标成 untracked。
      mode: useMode,
      sources: docCtx.hits.map(h => ({ docId: h.docId, filename: h.filename, chunk: h.chunkIndex, score: h.score })),
      agentId: conv.agentId || '',
      skills: skills.enabledIds(sid),
      webSearch: opt.webSearch ? (searchRes ? { ok: searchRes.ok, query: searchRes.query || '', results: (searchRes.results || []).slice(0, 5), message: searchRes.message || '' } : null) : null,
      links: linkMeta,
    },
  });

  const hist = core.buildContext(sid, conv.id, 20).messages
    .filter(m => m.content);   // 空占位行不进上下文

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const send = (event, data) => { try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch (e) {} };
  send('meta', {
    conversationId: conv.id,
    messageId: userMsg ? userMsg.id : null,
    replyId: placeholder.id,
    model: model,
    agentId: conv.agentId || '',
    skills: skills.enabledIds(sid),
    webSearch: searchRes ? { ok: searchRes.ok, query: searchRes.query || '', message: searchRes.message || '', results: (searchRes.results || []).slice(0, 5) } : null,
    links: linkMeta,
    sources: docCtx.hits.map(h => ({ docId: h.docId, filename: h.filename, chunk: h.chunkIndex, score: h.score })),
  });

  let full = '';
  // 模型的思考过程（reasoning_content）。先于正文流出，前端折叠展示。
  let reasoning = '';
  let aborted = false;
  let detached = false;                 // 前端连接没了（≠ 用户点了停止）
  req.on('close', () => { detached = true; });
  // 边生成边回写：每 400ms 或每 240 字写一次库（写太频繁会拖慢流）
  let lastFlush = Date.now(), sinceFlush = 0;
  const flush = (force) => {
    if (!force && sinceFlush < 240 && Date.now() - lastFlush < 400) return;
    lastFlush = Date.now(); sinceFlush = 0;
    try { core.appendMessageContent(sid, placeholder.id, full, { status: 'streaming', reasoning: reasoning }); } catch (e) {}
  };
  // ★ 思考过程必须**单独**节流回写。上面那个 flush 的触发条件是"正文字数够多"，
  //   而推理阶段正文一个字都还没来 —— 那个 flush 在这段时间一次都不会跑，
  //   中途刷新页面就会看到一个空的思考过程（正文反而没事，因为它在最后会整体落库）。
  let lastRFlush = Date.now(), sinceRFlush = 0;
  const flushReasoning = () => {
    if (sinceRFlush < 240 && Date.now() - lastRFlush < 400) return;
    lastRFlush = Date.now(); sinceRFlush = 0;
    try { core.appendMessageContent(sid, placeholder.id, full, { status: 'streaming', reasoning: reasoning }); } catch (e) {}
  };
  try {
    for await (const chunk of llm.streamChat({
      messages: [{ role: 'system', content: system }, ...hist],
      model: model,
      onReasoning: (t) => {
        reasoning += t; sinceRFlush += t.length;
        if (!detached) send('reasoning', { text: t });
        flushReasoning();
      },
    })) {
      if (STOP_FLAGS.has(placeholder.id)) { aborted = true; break; }
      full += chunk; sinceFlush += chunk.length;
      if (!detached) send('delta', { text: chunk });
      flush(false);
    }
  } catch (e) {
    if (!detached) send('error', { message: String(e.message || e) });
  }

  const status = aborted ? 'aborted' : (full ? 'done' : 'error');
  try { core.appendMessageContent(sid, placeholder.id, full, { status: status, reasoning: reasoning }); } catch (e) {}
  STOP_FLAGS.delete(placeholder.id);
  if (!detached) {
    send('done', {
      messageId: placeholder.id, replyId: placeholder.id,
      conversationId: conv.id, length: full.length, aborted: aborted, status: status,
      reasoningLength: reasoning.length,
    });
  }

  // ---------- Q2：AI 边讲边画（对话流里自动配图）----------
  // 配图不能阻塞 SSE 关闭，否则前端 #send 会一直 disabled 到画图完成。
  // 这里把画图放到后台：画完直接落库，刷新页面就能看到；
  // 实时 attachment 事件会丢失，但比让学生干等几"秒"要好得多。
  //
  // 分三档，互斥，顺序不能换（判准见 chat.js 的 shouldPlanCard / shouldIllustrate / shouldConceptArt）：
  //   · 带天数 / 阶段的学习计划 → **计划卡**（模型只出结构化数据，排版交给前端模板。
  //     要的是"哪天干什么"的**信息图**，不是插画）
  //   · 几何 / 物理 / 生物 → 矢量示意图（要的是**画得准**，模型只能画出线条图）
  //   · 其余规划 / 总结 / 复盘 → AI 场景插画（要的是**好看**，走异步任务，进度可查）
  if (!detached && !aborted && full && !llm.isMock()) {
    const _placeholderId = placeholder.id;
    const _spaceId = sid;
    const _text = String(opt.text || '').slice(0, 300);
    // 三档，互斥，顺序不能换：计划卡 → 矢量示意图 → AI 生图。
    // ★ 计划卡必须排在最前：计划类的答复里几乎一定带"示意图 / 流程图"这类词
    //   （"下面是学习计划示意图"），而 shouldIllustrate 见到"示意图"就直接认领，
    //   于是计划被拉去做矢量示意图 —— 那一路只拿到 300 字题干、手里没有计划数据，
    //   只能画出一个空壳标题（线上实测：一张白底卡片 + 四个阶段词）。
    //   计划类要的是"哪天干什么"的信息图，只能靠"模型出数据、模板出设计"。
    if (chat.shouldPlanCard(opt.text, full)) {
      send('art', { kind: 'plan' });
      setImmediate(async () => {
        try {
          const plan = await chat.generatePlanCard(opt.text, full);
          chat.attachArtifact(_spaceId, _placeholderId,
            { kind: 'illustration', mode: 'plan', title: plan.title, plan: plan });
        } catch (e) {
          // 抽不出结构（答复里确实没有多阶段内容）就静默不配图，
          // 不退回矢量示意图 —— 那正是我们要摆脱的空壳。
          try { console.warn('[plancard] 计划卡跳过：', e && e.message); } catch (_) {}
        }
      });
    } else if (chat.shouldIllustrate(opt.text, full)) {
      // 先告诉前端"这条会有图"，前端才会去盯附件（见 app.js watchArt）。
      // 不打招呼的话，前端要么傻等 2 分钟轮询、要么干脆不轮询。
      send('art', { kind: 'svg' });
      setImmediate(async () => {
        try {
          const prompt = '配合下面这段讲解，画一张能一眼看懂的教学示意图：' + _text;
          const art = await chat.generateIllustration(prompt);
          if (art && art.elements && art.elements.length) {
            const att = { kind: 'illustration', title: art.title, palette: art.palette, elements: art.elements };
            const prev = core.getMessage(_spaceId, _placeholderId);
            const atts = (prev && prev.attachments) ? prev.attachments.concat([att]) : [att];
            core.updateMessage(_spaceId, _placeholderId, { attachments: atts });
          }
        } catch (e) {
          try { console.warn('[illustration] 自动配图跳过：', e && e.message); } catch (_) {}
        }
      });
    } else if (chat.shouldConceptArt(opt.text, full)) {
      // 场景描述要再过一次模型（把题干翻译成画面），所以连建任务都放后台，
      // 免得这几百毫秒拖慢 SSE 的 done 事件。
      send('art', { kind: 'ai', etaSec: 45 });
      setImmediate(async () => {
        try {
          const scene = await chat.buildArtScene(opt.text, full);
          chat.createJob(_spaceId, ctx.userId, 'image', {
            prompt: scene, style: 'concept', title: 'AI 配图',
            conversationId: conv.id, messageId: _placeholderId,
          });
        } catch (e) {
          try { console.warn('[aiart] 建任务失败：', e && e.message); } catch (_) {}
        }
      });
    }
  }

  try { res.end(); } catch (e) {}
  return undefined;
}

// ---------- API ----------
async function handleApi(req, res, u) {
  const p = u.pathname;
  const method = req.method;

  // 健康检查（前端开机自检用，必须在鉴权前）
  if (p === '/api/health' && method === 'GET') {
    return sendJSON(res, 200, {
      ok: true, version: APP_VERSION,
      apis: ['auth', 'sms', 'docs', 'avatars', 'session', 'announcements', 'spaces', 'chat', 'stream',
        'messages', 'tts', 'translate', 'favorites', 'upload', 'tempdocs', 'jobs', 'agents', 'search', 'shares',
        'projects', 'memory', 'share', 'cards', 'flashcards', 'pet', 'skills', 'kb', 'dashboard', 'daily', 'weekly', 'parent', 'english', 'exam', 'growth', 'pool'],
      mockLLM: llm.isMock(),
      adminPanel: !!ADMIN_PASSWORD,
    });
  }

  // 可用模型（公开）
  if (p === '/api/models' && method === 'GET') {
    return sendJSON(res, 200, { ok: true, models: chat.listModels() });
  }

  // ---------- 协议文本（公开，登录页要能读）----------
  if (p === '/api/docs' && method === 'GET') return sendJSON(res, 200, { ok: true, version: auth.DOC_VERSION, docs: account.docs() });
  const docm = p.match(/^\/api\/docs\/([a-z-]+)$/);
  if (docm && method === 'GET') {
    const d = account.doc(docm[1]);
    return d ? sendJSON(res, 200, { ok: true, doc: d }) : sendJSON(res, 404, { error: 'NOT_FOUND' });
  }

  // ---------- 头像预设（公开）----------
  if (p === '/api/avatars' && method === 'GET') {
    return sendJSON(res, 200, { ok: true, avatars: account.AVATAR_PRESETS });
  }

  // ---------- 短信验证码 ----------
  if (p === '/api/auth/sms/send' && method === 'POST') {
    const b = await readBody(req);
    try {
      const r = await account.sendCode(b.phone, b.scene);
      return sendJSON(res, 200, { ok: true, ...r, message: r.sent ? '验证码已发送' : '验证码已生成（当前为开发模式，未真实发送）' });
    } catch (e) {
      const map = { BAD_PHONE: 400, TOO_OFTEN: 429 };
      return sendJSON(res, map[e.code] || 400, { error: e.code || 'BAD_INPUT', message: e.message, wait: e.wait });
    }
  }

  // 手机号 + 验证码登录（未注册则自动注册，需带 consents）
  if (p === '/api/auth/login/sms' && method === 'POST') {
    const b = await readBody(req);
    try {
      const r = account.loginBySms({ phone: b.phone, code: b.code, consents: b.consents, name: b.name, stage: b.stage, grade: b.grade });
      const token = auth.issueSession({ userId: r.userId, spaceId: r.spaceId, kind: 'account' });
      return sendJSON(res, 200, { ok: true, ...r, token });
    } catch (e) {
      const map = { BAD_PHONE: 400, BAD_CODE: 401, NO_CODE: 400, CODE_EXPIRED: 410, CODE_LOCKED: 429, NEED_CONSENT: 400 };
      return sendJSON(res, map[e.code] || 400, { error: e.code || 'BAD_INPUT', message: e.message, left: e.left });
    }
  }

  // 忘记密码：手机号 + 验证码 + 新密码
  if (p === '/api/auth/reset-password' && method === 'POST') {
    const b = await readBody(req);
    try {
      account.resetPassword({ phone: b.phone, code: b.code, password: b.password });
      return sendJSON(res, 200, { ok: true, message: '密码重置成功，请登录' });
    } catch (e) {
      const map = { BAD_PHONE: 400, BAD_CODE: 401, NO_CODE: 400, CODE_EXPIRED: 410, CODE_LOCKED: 429, NOT_FOUND: 404, BAD_PASSWORD: 400 };
      return sendJSON(res, map[e.code] || 400, { error: e.code || 'BAD_INPUT', message: e.message });
    }
  }

  // 空间名可用性预检（公开，只回能不能用 + 建议名）
  if (p === '/api/space-name' && method === 'GET') {
    const nm = String(u.searchParams.get('name') || '').trim().slice(0, 40);
    if (!nm) return sendJSON(res, 200, { ok: true, available: false, name: '', suggested: '' });
    const taken = auth.nameTaken(nm, null);
    return sendJSON(res, 200, { ok: true, available: !taken, name: nm, suggested: taken ? auth.suggestName(nm, null) : nm });
  }

  // ---------- 身份 ----------
  if (p === '/api/space' && method === 'POST') {
    const b = await readBody(req);
    const wantEnter = b.spaceId != null && String(b.spaceId).trim() !== '';
    try {
      if (wantEnter) {
        const r = auth.enterSpace(b.spaceId, b.passcode);
        const token = auth.issueSession({ spaceId: r.spaceId, kind: 'space' });
        return sendJSON(res, 200, { ok: true, ...r, token, existed: true });
      }
      const r = auth.createSpace({ name: b.name, passcode: b.passcode });
      const token = auth.issueSession({ spaceId: r.spaceId, kind: 'space' });
      return sendJSON(res, 200, { ok: true, ...r, token, existed: false });
    } catch (e) {
      const map = { NAME_TAKEN: 409, NOT_FOUND: 404, WRONG_PASSCODE: 403 };
      return sendJSON(res, map[e.code] || 400, { error: e.code || 'BAD_INPUT', message: e.message, suggested: e.suggested });
    }
  }

  if (p === '/api/auth/register' && method === 'POST') {
    const b = await readBody(req);
    try {
      const r = auth.register(b);
      const token = auth.issueSession({ userId: r.userId, spaceId: r.spaceId, kind: 'account' });
      return sendJSON(res, 200, { ok: true, ...r, token });
    } catch (e) {
      const map = { USERNAME_TAKEN: 409, PHONE_TAKEN: 409, NEED_CONSENT: 400 };
      return sendJSON(res, map[e.code] || 400, { error: e.code || 'BAD_INPUT', message: e.message });
    }
  }

  if (p === '/api/auth/login' && method === 'POST') {
    const b = await readBody(req);
    try {
      const r = auth.login({ account: b.account, password: b.password });
      const token = auth.issueSession({ userId: r.userId, spaceId: r.spaceId, kind: 'account' });
      return sendJSON(res, 200, { ok: true, ...r, token });
    } catch (e) {
      return sendJSON(res, e.code === 'BAD_CRED' ? 401 : 400, { error: e.code || 'BAD_INPUT', message: e.message });
    }
  }

  if (p === '/api/auth/logout' && method === 'POST') {
    auth.endSession(bearer(req));
    return sendJSON(res, 200, { ok: true });
  }

  // ---------- 管理员：空间管理 ----------
  // 注意：必须放在下面的"需要登录"闸门之前 —— 管理员用的是自己的 x-token，
  // 跟学习空间的会话令牌是两套体系，放在闸门后面会导致管理入口永远 401。
  if (p === '/api/admin/login' && method === 'POST') {
    if (!ADMIN_PASSWORD) return sendJSON(res, 403, { error: 'ADMIN_DISABLED', message: '未设置管理密码' });
    const b = await readBody(req);
    if (b.password !== ADMIN_PASSWORD) return sendJSON(res, 401, { error: 'BAD_PASSWORD', message: '管理密码不正确' });
    const tk = require('crypto').createHash('sha256').update(ADMIN_PASSWORD + Date.now() + Math.random()).digest('hex');
    ADMIN_TOKENS.add(tk);
    return sendJSON(res, 200, { ok: true, token: tk });
  }
  if (p === '/api/admin/spaces' && method === 'GET') {
    if (!ADMIN_PASSWORD) return sendJSON(res, 403, { error: 'ADMIN_DISABLED' });
    if (!ADMIN_TOKENS.has(reqToken(req))) return sendJSON(res, 401, { error: 'NO_AUTH' });
    return sendJSON(res, 200, { ok: true, spaces: auth.listSpaces() });
  }

  // ---------- 管理员：用户管理 ----------
  // 以前只有一个"空间列表"，管理员**看得见用户却管不着**——不能禁用、不能重置密码。
  // 删号不做：学生攒下的对话和错题是家长的资产，删掉不可逆；停用 + 可恢复才对。
  if (p === '/api/admin/users' && method === 'GET') {
    if (!ADMIN_PASSWORD) return sendJSON(res, 403, { error: 'ADMIN_DISABLED' });
    if (!ADMIN_TOKENS.has(reqToken(req))) return sendJSON(res, 401, { error: 'NO_AUTH' });
    try { return sendJSON(res, 200, { ok: true, users: auth.listUsers() }); }
    catch (e) { return sendJSON(res, 500, { error: 'LIST_FAILED', message: e.message }); }
  }
  const admUserM = p.match(/^\/api\/admin\/users\/([^/]+)\/(disabled|password)$/);
  if (admUserM && method === 'POST') {
    if (!ADMIN_PASSWORD) return sendJSON(res, 403, { error: 'ADMIN_DISABLED' });
    if (!ADMIN_TOKENS.has(reqToken(req))) return sendJSON(res, 401, { error: 'NO_AUTH' });
    const who = decodeURIComponent(admUserM[1]);
    const b = await readBody(req);
    try {
      if (admUserM[2] === 'disabled') return sendJSON(res, 200, { ok: true, ...auth.setUserDisabled(who, !!b.disabled, b.reason) });
      return sendJSON(res, 200, { ok: true, ...auth.adminResetPassword(who, b.password) });
    } catch (e) {
      const code = e.code || 'BAD_INPUT';
      const status = code === 'NOT_FOUND' ? 404 : (code === 'BAD_PASSWORD' ? 400 : 400);
      return sendJSON(res, status, { error: code, message: e.message });
    }
  }
  // 管理员发公告
  if (p === '/api/admin/announcements' && method === 'POST') {
    if (!ADMIN_PASSWORD) return sendJSON(res, 403, { error: 'ADMIN_DISABLED' });
    if (!ADMIN_TOKENS.has(reqToken(req))) return sendJSON(res, 401, { error: 'NO_AUTH' });
    const b = await readBody(req);
    try { return sendJSON(res, 200, { ok: true, announcement: account.publishAnnouncement(b) }); }
    catch (e) { return sendJSON(res, 400, { error: e.code || 'BAD_INPUT', message: e.message }); }
  }
  if (p === '/api/admin/announcements' && method === 'GET') {
    if (!ADMIN_PASSWORD) return sendJSON(res, 403, { error: 'ADMIN_DISABLED' });
    if (!ADMIN_TOKENS.has(reqToken(req))) return sendJSON(res, 401, { error: 'NO_AUTH' });
    return sendJSON(res, 200, { ok: true, announcements: account.listAnnouncements('_public', null, {}) });
  }

  // 管理员改空间档位（批次25：能力中心的"授权"，替代对标站的付费等级）
  const admTierM = p.match(/^\/api\/admin\/spaces\/([^/]+)\/tier$/);
  if (admTierM && method === 'POST') {
    if (!ADMIN_PASSWORD) return sendJSON(res, 403, { error: 'ADMIN_DISABLED' });
    if (!ADMIN_TOKENS.has(reqToken(req))) return sendJSON(res, 401, { error: 'NO_AUTH' });
    const sid = decodeURIComponent(admTierM[1]);
    const b = await readBody(req);
    try { return sendJSON(res, 200, { ok: true, space: skills.setSpaceTier(sid, b.tier), tiers: skills.TIERS }); }
    catch (e) { return sendJSON(res, e.code === 'NOT_FOUND' ? 404 : 400, { error: e.code || 'BAD_INPUT', message: e.message }); }
  }

  // 管理员重置空间口令（2026-10-03 新增）。
  // 为什么必须让管理员能做：口令在库里是 scrypt 哈希，**取不回来** —— 忘了只能给一个新的。
  // 语义：
  //   · 请求体不带 passcode 字段 → 自动生成一个 8 位随机口令（最常见的用法：用户忘了）
  //   · passcode 传空串        → **清空**口令，该空间恢复"凭 ID 即可进入"的开放状态
  //   · 传了具体值            → 用这个值
  // 返回里带明文 passcode，供管理员转达用户（与 adminResetPassword 同一口径）。
  const admPwM = p.match(/^\/api\/admin\/spaces\/([^/]+)\/passcode$/);
  if (admPwM && method === 'POST') {
    if (!ADMIN_PASSWORD) return sendJSON(res, 403, { error: 'ADMIN_DISABLED' });
    if (!ADMIN_TOKENS.has(reqToken(req))) return sendJSON(res, 401, { error: 'NO_AUTH' });
    const psid = decodeURIComponent(admPwM[1]);
    const b = await readBody(req);
    try {
      const want = (b.passcode === undefined || b.passcode === null) ? auth.randomPasscode() : b.passcode;
      return sendJSON(res, 200, { ok: true, ...auth.setSpacePasscode(psid, want) });
    } catch (e) {
      return sendJSON(res, e.code === 'NOT_FOUND' ? 404 : 400, { error: e.code || 'BAD_INPUT', message: e.message });
    }
  }
  // 管理员查看所有空间的档位（管理面板用）
  if (p === '/api/admin/skill-tiers' && method === 'GET') {
    if (!ADMIN_PASSWORD) return sendJSON(res, 403, { error: 'ADMIN_DISABLED' });
    if (!ADMIN_TOKENS.has(reqToken(req))) return sendJSON(res, 401, { error: 'NO_AUTH' });
    const spaces = auth.listSpaces().map(s => ({
      id: s.spaceId, name: s.name, tier: skills.spaceTier(s.spaceId),
    }));
    // coverage：每条技能要求哪一档的计数。管理端拿它算"本档可用 N/57"——
    // 档位只体现在学生侧的「能力」分区，不把这个数字摆出来，管理员改完档
    // 回到对话里看不出任何区别，会以为"改了没生效"。
    return sendJSON(res, 200, { ok: true, tiers: skills.TIERS, spaces: spaces, coverage: skills.tierCoverage() });
  }

  // ---------- 管理员：使用看板（2026-10-03 新增）----------
  // 需求是"看 AI 自学被怎么用了、具体聊了什么"。
  // 与上面几个管理接口一样，**必须放在下面的登录闸门之前** ——
  // 管理员用自己的一套令牌，跟学习空间会话是两套体系，放到闸门后面会永远 401。
  const requireAdmin = (res2) => {
    if (!ADMIN_PASSWORD) { sendJSON(res2, 403, { error: 'ADMIN_DISABLED', message: '未设置管理密码' }); return false; }
    if (!ADMIN_TOKENS.has(reqToken(req))) { sendJSON(res2, 401, { error: 'NO_AUTH' }); return false; }
    return true;
  };
  const adminQuery = () => { try { return new URL(req.url, 'http://x').searchParams; } catch (e) { return new URLSearchParams(); } };

  if (p === '/api/admin/overview' && method === 'GET') {
    if (!requireAdmin(res)) return;
    try { return sendJSON(res, 200, { ok: true, ...adminDash.overview({ days: adminQuery().get('days') }) }); }
    catch (e) { return sendJSON(res, 500, { error: 'OVERVIEW_FAILED', message: e.message }); }
  }
  if (p === '/api/admin/usage/spaces' && method === 'GET') {
    if (!requireAdmin(res)) return;
    try { return sendJSON(res, 200, { ok: true, spaces: adminDash.spaceUsage({ days: adminQuery().get('days') }) }); }
    catch (e) { return sendJSON(res, 500, { error: 'USAGE_FAILED', message: e.message }); }
  }
  const admSpaceUsageM = p.match(/^\/api\/admin\/spaces\/([^/]+)\/usage$/);
  if (admSpaceUsageM && method === 'GET') {
    if (!requireAdmin(res)) return;
    try {
      const d = adminDash.spaceDetail(decodeURIComponent(admSpaceUsageM[1]), { days: adminQuery().get('days') });
      return sendJSON(res, 200, { ok: true, ...d });
    } catch (e) {
      return sendJSON(res, e.code === 'NOT_FOUND' ? 404 : 500, { error: e.code || 'USAGE_FAILED', message: e.message });
    }
  }
  if (p === '/api/admin/conversations' && method === 'GET') {
    if (!requireAdmin(res)) return;
    try {
      const q = adminQuery();
      const d = adminDash.listConversations({
        spaceId: q.get('spaceId') || '', q: q.get('q') || '',
        limit: q.get('limit'), offset: q.get('offset'),
      });
      return sendJSON(res, 200, { ok: true, ...d });
    } catch (e) { return sendJSON(res, 500, { error: 'LIST_FAILED', message: e.message }); }
  }
  // ★ export 必须在下面那条"按 id 取详情"之前匹配。
  //   详情那条用的是 [^/]+ 锚定到结尾，本来也匹配不上 /export，
  //   但显式放在前面能避免以后有人把详情改成贪婪匹配时踩坑。
  const admExportM = p.match(/^\/api\/admin\/conversations\/([^/]+)\/export$/);
  if (admExportM && method === 'GET') {
    if (!requireAdmin(res)) return;
    try {
      const r = adminDash.exportConversation(decodeURIComponent(admExportM[1]));
      const body = Buffer.from(r.markdown, 'utf8');
      res.writeHead(200, {
        'Content-Type': 'text/markdown; charset=utf-8',
        // filename* 用 RFC 5987 编码 —— 文件名是中文，直接塞 filename= 会变乱码。
        'Content-Disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(r.filename),
        'Content-Length': body.length,
        'Cache-Control': 'no-store',
      });
      return res.end(body);
    } catch (e) {
      return sendJSON(res, e.code === 'NOT_FOUND' ? 404 : 500, { error: e.code || 'EXPORT_FAILED', message: e.message });
    }
  }
  const admConvM = p.match(/^\/api\/admin\/conversations\/([^/]+)$/);
  if (admConvM && method === 'GET') {
    if (!requireAdmin(res)) return;
    try {
      const d = adminDash.conversationDetail(decodeURIComponent(admConvM[1]), {
        includeDeleted: adminQuery().get('includeDeleted') === '1',
      });
      return sendJSON(res, 200, { ok: true, ...d });
    } catch (e) {
      return sendJSON(res, e.code === 'NOT_FOUND' ? 404 : 500, { error: e.code || 'DETAIL_FAILED', message: e.message });
    }
  }

  // ---------- 管理员：模型切换（2026-10-03 新增）----------
  // 「通用」/「深度思考」两个档位背后真实用哪个模型，改完立刻生效、不用重启。
  // 值存 meta 表并优先于环境变量；传空串即回到部署时环境变量配的那个。
  if (p === '/api/admin/models' && method === 'GET') {
    if (!requireAdmin(res)) return;
    try {
      const cat = await llm.modelCatalog(adminQuery().get('refresh') === '1');
      return sendJSON(res, 200, { ok: true, slots: llm.modelSlots(), catalog: cat });
    } catch (e) { return sendJSON(res, 500, { error: 'MODELS_FAILED', message: e.message }); }
  }
  if (p === '/api/admin/models' && method === 'POST') {
    if (!requireAdmin(res)) return;
    const b = await readBody(req);
    try {
      const slot = llm.setModelSlot(b.slot, b.model);
      return sendJSON(res, 200, { ok: true, slot: slot, slots: llm.modelSlots() });
    } catch (e) {
      const code = e.code || 'SET_FAILED';
      return sendJSON(res, code === 'BAD_SLOT' || code === 'BAD_MODEL' ? 400 : 500, { error: code, message: e.message });
    }
  }

  // ---------- 以下都需要登录 ----------
  const ctx = ctxOf(req);
  if (!ctx) return sendJSON(res, 401, { error: 'NO_AUTH', message: '请先进入学习空间' });
  const sid = ctx.spaceId;

  if (p === '/api/me' && method === 'GET') {
    const sp = auth.getSpace(sid);
    return sendJSON(res, 200, {
      ok: true,
      // hasPasscode：个人中心要据此显示「已设置 / 未设置」并给对应的按钮文案。
      // 口令本身（哈希）不出后端 —— 谁都取不回来，只有重置这一条路。
      space: { id: sid, name: sp ? sp.name : sid, tier: sp ? sp.tier : 'self', hasPasscode: !!(sp && sp.passcode) },
      profile: ctx.userId ? auth.profile(ctx.userId) : null,
      kind: ctx.kind,
      stats: core.stats(sid),
    });
  }
  if (p === '/api/me' && method === 'PATCH') {
    if (!ctx.userId) return sendJSON(res, 400, { error: 'NO_ACCOUNT', message: '空间口令登录没有个人资料' });
    const b = await readBody(req);
    return sendJSON(res, 200, { ok: true, profile: auth.updateProfile(ctx.userId, b) });
  }

  // 改密码（必须验原密码）
  if (p === '/api/auth/change-password' && method === 'POST') {
    if (!ctx.userId) return sendJSON(res, 400, { error: 'NO_ACCOUNT', message: '空间口令登录没有密码' });
    const b = await readBody(req);
    try { return sendJSON(res, 200, { ok: true, ...auth.changePassword(ctx.userId, b) }); }
    catch (e) { return sendJSON(res, e.code === 'BAD_CRED' ? 401 : 400, { error: e.code, message: e.message }); }
  }

  // 改空间口令（自助）。2026-10-03 新增。
  // 为什么两种会话的校验不一样：
  //   · kind='space'（凭口令进来的）→ **必须报出当前口令**。会话令牌可能被人捡到，
  //     不验旧口令的话，谁拿到令牌谁就能把口令换掉、把空间据为己有。
  //   · kind='account'（账号登录）→ 不验。账号是更强的凭据；而且手机验证码注册的用户
  //     本来就不可能知道那个自动生成的口令，要求他报旧口令等于永久锁死。
  // 改完把"用旧口令进来的"会话踢掉（exceptToken 排除操作者自己），否则重置只是纸面上的。
  if (p === '/api/space/passcode' && method === 'POST') {
    const b = await readBody(req);
    const sp = auth.getSpace(sid);
    if (!sp) return sendJSON(res, 404, { error: 'NOT_FOUND', message: '空间不存在' });
    if (ctx.kind === 'space' && sp.passcode && !auth.passcodeMatches(sp.passcode, b.oldPasscode)) {
      return sendJSON(res, 401, { error: 'WRONG_PASSCODE', message: '当前口令不正确' });
    }
    try {
      const r = auth.setSpacePasscode(sid, b.newPasscode, { exceptToken: ctx.token });
      return sendJSON(res, 200, { ok: true, hasPasscode: r.hasPasscode, kicked: r.kicked });
    } catch (e) {
      return sendJSON(res, e.code === 'NOT_FOUND' ? 404 : 400, { error: e.code || 'BAD_INPUT', message: e.message });
    }
  }

  // ---------- 学习会话心跳（真实学习时长的唯一来源）----------
  if (p === '/api/users/session/start' && method === 'POST') {
    return sendJSON(res, 200, { ok: true, ...account.sessionStart(sid, ctx.userId, ctx.token) });
  }
  if (p === '/api/users/session/heartbeat' && method === 'POST') {
    return sendJSON(res, 200, { ok: true, ...account.sessionHeartbeat(sid, ctx.userId, ctx.token) });
  }
  if (p === '/api/users/session/end' && method === 'POST') {
    return sendJSON(res, 200, { ok: true, ...account.sessionEnd(sid, ctx.userId, ctx.token) });
  }
  if (p === '/api/users/session/stats' && method === 'GET') {
    const days = Math.min(90, Math.max(1, Number(u.searchParams.get('days')) || 7));
    const from = D.now() - days * 86400000;
    return sendJSON(res, 200, {
      ok: true, days,
      seconds: account.studySeconds(sid, from),
      minutes: account.studyMinutes(sid, from),
      todayMinutes: account.studyMinutes(sid, (() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); })()),
    });
  }

  // ---------- 公告 ----------
  if (p === '/api/announcements' && method === 'GET') {
    return sendJSON(res, 200, {
      ok: true,
      announcements: account.listAnnouncements(sid, ctx.userId, {}),
      unreadImportant: account.unreadImportantCount(ctx.userId),
    });
  }
  if (p === '/api/announcements/unread-important' && method === 'GET') {
    return sendJSON(res, 200, { ok: true, count: account.unreadImportantCount(ctx.userId), announcements: account.listAnnouncements(sid, ctx.userId, { unreadImportant: true }) });
  }
  const anm = p.match(/^\/api\/announcements\/([^/]+)\/read$/);
  if (anm && method === 'POST') {
    account.markAnnouncementRead(ctx.userId, anm[1]);
    return sendJSON(res, 200, { ok: true, unreadImportant: account.unreadImportantCount(ctx.userId) });
  }

  // 空间统计（看板地基）
  if (p === '/api/stats' && method === 'GET') {
    return sendJSON(res, 200, { ok: true, ...core.stats(sid) });
  }

  // ---------- 项目 ----------
  if (p === '/api/projects' && method === 'GET') return sendJSON(res, 200, { ok: true, projects: core.listProjects(sid) });
  if (p === '/api/projects' && method === 'POST') {
    const b = await readBody(req);
    return sendJSON(res, 200, { ok: true, project: core.createProject(sid, b) });
  }
  const pm = p.match(/^\/api\/projects\/([^/]+)$/);
  if (pm) {
    const id = pm[1];
    if (method === 'GET') { const x = core.getProject(sid, id); return x ? sendJSON(res, 200, { ok: true, project: x }) : sendJSON(res, 404, { error: 'NOT_FOUND' }); }
    if (method === 'PATCH') { const b = await readBody(req); try { return sendJSON(res, 200, { ok: true, project: core.updateProject(sid, id, b) }); } catch (e) { return sendJSON(res, 404, { error: e.code }); } }
    if (method === 'DELETE') return sendJSON(res, 200, { ok: true, deleted: core.deleteProject(sid, id) });
  }

  // ---------- 会话 ----------
  if (p === '/api/conversations' && method === 'GET') {
    return sendJSON(res, 200, { ok: true, conversations: core.listConversations(sid, { projectId: u.searchParams.get('projectId') || undefined, favorite: u.searchParams.get('favorite') === '1' }) });
  }
  if (p === '/api/conversations' && method === 'POST') {
    const b = await readBody(req);
    return sendJSON(res, 200, { ok: true, conversation: core.createConversation(sid, ctx.userId, b) });
  }
  const cm = p.match(/^\/api\/conversations\/([^/]+)$/);
  if (cm) {
    const id = cm[1];
    if (method === 'GET') {
      const c = core.getConversation(sid, id);
      if (!c) return sendJSON(res, 404, { error: 'NOT_FOUND' });
      return sendJSON(res, 200, { ok: true, conversation: c, messages: core.listMessages(sid, id) });
    }
    if (method === 'PATCH') { const b = await readBody(req); try { return sendJSON(res, 200, { ok: true, conversation: core.updateConversation(sid, id, b) }); } catch (e) { return sendJSON(res, 404, { error: e.code }); } }
    if (method === 'DELETE') {
      chat.cleanupConversationFiles(sid, id);   // 附件文件随对话一起清
      return sendJSON(res, 200, { ok: true, deleted: core.deleteConversation(sid, id) });
    }
  }

  // ---------- 流式对话（SSE）----------
  if (p === '/api/chat/stream' && method === 'POST') {
    const b = await readBody(req, 40 * 1024 * 1024);
    const text = String(b.text || '').trim();
    const atts = Array.isArray(b.attachments) ? b.attachments.slice(0, 10) : [];
    if (!text && !atts.length) return sendJSON(res, 400, { error: 'EMPTY', message: '说点什么吧' });

    let conv = b.conversationId ? core.getConversation(sid, b.conversationId) : null;
    if (!conv) conv = core.createConversation(sid, ctx.userId, {
      projectId: b.projectId, model: b.model, agentId: b.agentId, webSearch: b.webSearch,
    });
    // 会话级设置随每次发送同步（前端改了模型/智能体/联网开关，服务端要跟上）
    const patch = {};
    if (b.model) patch.model = b.model;
    if (b.agentId !== undefined) patch.agentId = b.agentId;
    if (b.webSearch !== undefined) patch.webSearch = b.webSearch;
    if (Object.keys(patch).length) conv = core.updateConversation(sid, conv.id, patch);

    return streamReply(req, res, ctx, sid, {
      conv: conv, text: text, model: b.model || conv.model,
      mode: b.mode, skillIds: b.skillIds, attachments: atts,
      clientId: b.clientId, webSearch: b.webSearch !== undefined ? !!b.webSearch : !!conv.webSearch,
      body: b,
    });
  }

  // ---------- 消息级操作（批次2）----------
  const msgm = p.match(/^\/api\/messages\/([^/]+)(?:\/([a-z-]+))?$/);
  if (msgm) {
    const id = msgm[1], action = msgm[2] || '';
    if (!action && method === 'GET') {
      const m = core.getMessage(sid, id);
      return m ? sendJSON(res, 200, { ok: true, message: m }) : sendJSON(res, 404, { error: 'NOT_FOUND' });
    }
    if (!action && method === 'DELETE') {
      return sendJSON(res, 200, { ok: true, deleted: core.deleteMessage(sid, id) });
    }
    if (action === 'favorite' && method === 'POST') {
      try { return sendJSON(res, 200, { ok: true, ...chat.toggleFavorite(sid, id) }); }
      catch (e) { return sendJSON(res, 404, { error: e.code, message: e.message }); }
    }
    if (action === 'translate' && method === 'POST') {
      const b = await readBody(req);
      try {
        const r = await chat.translateMessage(sid, id, b.direction, { force: !!b.force });
        return sendJSON(res, 200, { ok: true, ...r });
      } catch (e) { const sc = e.code === 'NOT_FOUND' ? 404 : 400; return sendJSON(res, sc, { error: e.code || 'FAIL', message: e.message }); }
    }
    if (action === 'speak' && method === 'POST') {
      const b = await readBody(req);
      const m = core.getMessage(sid, id);
      if (!m) return sendJSON(res, 404, { error: 'NOT_FOUND' });
      try {
        const r = await chat.speak(sid, ctx.userId, { text: m.content, rate: b.rate, voice: b.voice });
        return sendJSON(res, 200, { ok: true, ...r });
      } catch (e) { return sendJSON(res, 400, { error: e.code || 'FAIL', message: e.message }); }
    }
    if (action === 'stop' && method === 'POST') {
      const m = core.getMessage(sid, id);
      if (!m) return sendJSON(res, 404, { error: 'NOT_FOUND' });
      STOP_FLAGS.add(id);
      return sendJSON(res, 200, { ok: true, stopping: true });
    }
    if (action === 'regenerate' && method === 'POST') {
      const b = await readBody(req);
      const m = core.getMessage(sid, id);
      if (!m || m.role !== 'assistant') return sendJSON(res, 400, { error: 'NOT_ASSISTANT', message: '只能重新生成助手的回复' });
      const row = D.get('SELECT conversation_id c FROM messages WHERE id = ?', id);
      const conv = row ? core.getConversation(sid, row.c) : null;
      if (!conv) return sendJSON(res, 404, { error: 'NOT_FOUND' });
      // 把上一条回复软删（保留审计），再重新生成 —— 对应对方的
      // 「重新生成会发起一次新的模型请求并消耗相应额度，是否继续？」
      core.deleteMessage(sid, id);
      const hist = core.buildContext(sid, conv.id, 24).messages;
      const lastUser = [...hist].reverse().find(x => x.role === 'user');
      return streamReply(req, res, ctx, sid, {
        conv: conv, text: (lastUser && lastUser.content) || '', model: b.model || conv.model,
        mode: b.mode, skillIds: b.skillIds, skipUserMessage: true,
        webSearch: !!conv.webSearch, body: b,
      });
    }
  }

  // ---------- 收藏列表 ----------
  if (p === '/api/favorites' && method === 'GET') {
    return sendJSON(res, 200, { ok: true, messages: chat.listFavorites(sid) });
  }

  // ---------- 朗读（不绑定具体消息，任意文本都能念）----------
  if (p === '/api/tts/speak' && method === 'POST') {
    const b = await readBody(req);
    try { return sendJSON(res, 200, { ok: true, ...(await chat.speak(sid, ctx.userId, b)) }); }
    catch (e) { return sendJSON(res, 400, { error: e.code || 'FAIL', message: e.message, maxChars: e.maxChars, length: e.length }); }
  }
  if (p === '/api/tts/settings' && method === 'GET') {
    return sendJSON(res, 200, { ok: true, settings: chat.getTtsPref(sid, ctx.userId), maxChars: chat.TTS_MAX_CHARS });
  }
  if (p === '/api/tts/settings' && method === 'POST') {
    const b = await readBody(req);
    try { return sendJSON(res, 200, { ok: true, settings: chat.setTtsPref(sid, ctx.userId, b) }); }
    catch (e) { return sendJSON(res, 400, { error: e.code || 'FAIL', message: e.message }); }
  }

  // ---------- 联网搜索 ----------
  if (p === '/api/search' && method === 'POST') {
    const b = await readBody(req);
    const r = await chat.webSearch(b.query, { limit: b.limit });
    return sendJSON(res, 200, { ok: r.ok, ...r });
  }

  // ---------- AI 配图（异步任务）----------
  if (p === '/api/chat/image' && method === 'POST') {
    const b = await readBody(req);
    try {
      const job = chat.createJob(sid, ctx.userId, 'image', {
        prompt: String(b.prompt || b.text || '').slice(0, 600),
        conversationId: b.conversationId || null,
        messageId: b.messageId || null,
      });
      return sendJSON(res, 200, { ok: true, job: job, heartbeatMs: chat.JOB_HEARTBEAT_MS });
    } catch (e) { return sendJSON(res, 400, { error: e.code || 'FAIL', message: e.message }); }
  }
  if (p === '/api/chat/jobs' && method === 'GET') {
    return sendJSON(res, 200, {
      ok: true,
      jobs: chat.listJobs(sid, {
        kind: u.searchParams.get('kind') || undefined,
        conversationId: u.searchParams.get('conversationId') || undefined,
        messageId: u.searchParams.get('messageId') || undefined,
        active: u.searchParams.get('active') === '1',
      }),
      heartbeatMs: chat.JOB_HEARTBEAT_MS,
    });
  }
  const jobm = p.match(/^\/api\/chat\/jobs\/([^/]+)$/);
  if (jobm && method === 'GET') {
    const j = chat.getJob(sid, jobm[1]);
    return j ? sendJSON(res, 200, { ok: true, job: j, heartbeatMs: chat.JOB_HEARTBEAT_MS })
      : sendJSON(res, 404, { error: 'NOT_FOUND' });
  }

  // ---------- 上传 ----------
  if (p === '/api/upload/image' && method === 'POST') {
    const b = await readBody(req, 36 * 1024 * 1024);
    const list = Array.isArray(b.files) ? b.files : [b];
    const saved = [], skipped = [];
    for (const f of list.slice(0, 10)) {
      try { saved.push(chat.saveImage(sid, f)); }
      catch (e) { skipped.push({ name: (f && f.filename) || '', reason: e.message, code: e.code }); }
    }
    return sendJSON(res, 200, { ok: true, images: saved, skipped: skipped });
  }
  if (p === '/api/upload/document' && method === 'POST') {
    const b = await readBody(req, 36 * 1024 * 1024);
    const list = Array.isArray(b.files) ? b.files : [b];
    const saved = [], skipped = [];
    for (const f of list.slice(0, 10)) {
      try {
        saved.push(chat.saveDocument(sid, ctx.userId, Object.assign({}, f, { conversationId: b.conversationId })));
      } catch (e) { skipped.push({ name: (f && f.filename) || '', reason: e.message, code: e.code }); }
    }
    return sendJSON(res, 200, { ok: true, documents: saved, skipped: skipped });
  }
  const filem = p.match(/^\/api\/files\/([^/]+)$/);
  if (filem && method === 'GET') {
    const a = chat.readAttachment(sid, filem[1]);
    if (!a) return sendJSON(res, 404, { error: 'NOT_FOUND' });
    try {
      const buf = fs.readFileSync(a.path);
      res.writeHead(200, { 'Content-Type': a.mime, 'Cache-Control': 'private, max-age=86400', 'Content-Length': buf.length });
      return res.end(buf);
    } catch (e) { return sendJSON(res, 404, { error: 'NOT_FOUND' }); }
  }

  // ---------- 对话级临时资料 ----------
  const tdm = p.match(/^\/api\/conversations\/([^/]+)\/temp-documents$/);
  if (tdm) {
    const cid = tdm[1];
    if (!core.getConversation(sid, cid)) return sendJSON(res, 404, { error: 'NOT_FOUND' });
    if (method === 'GET') return sendJSON(res, 200, { ok: true, documents: chat.listTempDocs(sid, cid) });
    if (method === 'POST') {
      const b = await readBody(req, 36 * 1024 * 1024);
      const list = Array.isArray(b.files) ? b.files : [b];
      const saved = [], skipped = [];
      for (const f of list.slice(0, 10)) {
        try { saved.push(chat.saveDocument(sid, ctx.userId, Object.assign({}, f, { conversationId: cid, scope: 'temp' }))); }
        catch (e) { skipped.push({ name: (f && f.filename) || '', reason: e.message, code: e.code }); }
      }
      return sendJSON(res, 200, { ok: true, documents: saved, skipped: skipped });
    }
    if (method === 'DELETE') return sendJSON(res, 200, { ok: true, deleted: true });
  }
  const tdsm = p.match(/^\/api\/conversations\/([^/]+)\/temp-documents\/status$/);
  if (tdsm && method === 'POST') {
    const b = await readBody(req);
    return sendJSON(res, 200, { ok: true, status: chat.tempDocStatus(sid, b.ids) });
  }
  const tddm = p.match(/^\/api\/temp-documents\/([^/]+)$/);
  if (tddm && method === 'DELETE') {
    try { return sendJSON(res, 200, { ok: true, deleted: chat.removeTempDoc(sid, tddm[1]) }); }
    catch (e) { return sendJSON(res, 400, { error: e.code, message: e.message }); }
  }

  // ---------- 智能体 ----------
  if (p === '/api/agents' && method === 'GET') {
    return sendJSON(res, 200, { ok: true, ...chat.listAgents(sid, {
      q: u.searchParams.get('q') || '',
      category: u.searchParams.get('category') || '',
    }) });
  }

  // ---------- 分享管理 ----------
  if (p === '/api/shares' && method === 'GET') {
    return sendJSON(res, 200, { ok: true, shares: chat.listShares(sid, u.searchParams.get('kind') || undefined) });
  }

  // 分享
  const shm = p.match(/^\/api\/conversations\/([^/]+)\/share$/);
  if (shm) {
    const id = shm[1];
    if (method === 'GET') return sendJSON(res, 200, { ok: true, share: core.shareInfo(sid, 'conversation', id) });
    if (method === 'POST') return sendJSON(res, 200, { ok: true, share: core.createShare(sid, 'conversation', id) });
    if (method === 'DELETE') return sendJSON(res, 200, { ok: true, cancelled: core.cancelShare(sid, 'conversation', id) });
  }

  // ---------- 记忆 ----------
  if (p === '/api/memory' && method === 'GET') return sendJSON(res, 200, { ok: true, ...core.getMemory(sid) });
  if (p === '/api/memory' && method === 'POST') {
    const b = await readBody(req);
    try { return sendJSON(res, 200, { ok: true, id: core.addMemory(sid, ctx.userId, b.content, b.kind) }); }
    catch (e) { return sendJSON(res, 400, { error: e.code, message: e.message }); }
  }
  if (p === '/api/memory/settings' && method === 'POST') {
    const b = await readBody(req);
    core.setMemoryEnabled(sid, !!b.enabled);
    return sendJSON(res, 200, { ok: true, enabled: !!b.enabled });
  }
  const memm = p.match(/^\/api\/memory\/([^/]+)$/);
  if (memm && method === 'DELETE') { core.deleteMemory(sid, memm[1]); return sendJSON(res, 200, { ok: true }); }

  // ---------- 知识卡 ----------
  if (p === '/api/cards' && method === 'GET') {
    return sendJSON(res, 200, { ok: true, ...cards.list(sid, {
      status: u.searchParams.get('status') || 'all',
      q: u.searchParams.get('q') || '',
      sort: u.searchParams.get('sort') || 'due',
      page: u.searchParams.get('page'), pageSize: u.searchParams.get('pageSize'),
    }) });
  }
  if (p === '/api/cards/summary' && method === 'GET') return sendJSON(res, 200, { ok: true, ...cards.summary(sid) });
  if (p === '/api/cards/rules' && method === 'GET') return sendJSON(res, 200, { ok: true, ...cards.rules() });
  if (p === '/api/cards/eligibility' && method === 'GET') return sendJSON(res, 200, { ok: true, ...cards.eligibility(sid) });
  if (p === '/api/cards/suggest' && method === 'POST') {
    const b = await readBody(req);
    let text = String(b.text || '');
    if (!text && b.conversationId) {
      const msgs = core.listMessages(sid, b.conversationId) || [];
      text = msgs.slice(-6).map(m => (m.role === 'user' ? '学生：' : 'AI：') + m.content).join('\n\n');
    }
    const r = await cards.suggest(sid, ctx.userId, { text, conversationId: b.conversationId, messageId: b.messageId, count: b.count });
    return sendJSON(res, 200, { ok: true, ...r });
  }
  if (p === '/api/cards' && method === 'POST') {
    const b = await readBody(req);
    try { return sendJSON(res, 200, { ok: true, card: cards.create(sid, ctx.userId, b) }); }
    catch (e) { return sendJSON(res, 400, { error: e.code, message: e.message }); }
  }
  if (p === '/api/cards/generate' && method === 'POST') {
    const b = await readBody(req);
    let text = String(b.text || '');
    if (!text && b.conversationId) {
      const msgs = core.listMessages(sid, b.conversationId) || [];
      text = msgs.slice(-6).map(m => (m.role === 'user' ? '学生：' : 'AI：') + m.content).join('\n\n');
    }
    const made = await cards.generateFromText(sid, ctx.userId, { text, conversationId: b.conversationId, messageId: b.messageId, count: b.count });
    return sendJSON(res, 200, { ok: true, cards: made });
  }
  const cdm = p.match(/^\/api\/cards\/([^/]+)(?:\/([a-z-]+))?$/);
  if (cdm) {
    const id = cdm[1], action = cdm[2] || '';
    try {
      if (!action && method === 'GET') { const c = cards.getCard(sid, id); return c ? sendJSON(res, 200, { ok: true, card: c }) : sendJSON(res, 404, { error: 'NOT_FOUND' }); }
      if (!action && method === 'DELETE') return sendJSON(res, 200, { ok: true, deleted: cards.remove(sid, id) });
      if (action === 'review' && method === 'POST') { const b = await readBody(req); return sendJSON(res, 200, { ok: true, ...cards.review(sid, ctx.userId, id, b) }); }
      if (action === 'hint' && method === 'POST') return sendJSON(res, 200, { ok: true, ...(await cards.hint(sid, id)) });
      if (action === 'understanding-check' && method === 'POST') {
        const b = await readBody(req);
        const v = await cards.checkUnderstanding(sid, id, b.answer);
        return sendJSON(res, 200, { ok: true, verdict: v });
      }
      if (action === 'understanding-complete' && method === 'POST') {
        const b = await readBody(req);
        return sendJSON(res, 200, { ok: true, ...cards.completeUnderstanding(sid, ctx.userId, id, b.answer, b.verdict) });
      }
      if (action === 'self-known' && method === 'POST') {
        const r = cards.selfKnown(sid, id);
        return sendJSON(res, 200, { ok: true, ...r, message: '先不用练了，' + r.deferDays + ' 天后会再核对一次' });
      }
      if (action === 'undo-self-known' && method === 'POST') {
        const b = await readBody(req);
        return sendJSON(res, 200, { ok: true, card: cards.undoSelfKnown(sid, id, b.previous) });
      }
      if (action === 'restore-review' && method === 'POST') return sendJSON(res, 200, { ok: true, card: cards.restoreReview(sid, id) });
      if (action === 'free-practice' && method === 'POST') {
        const b = await readBody(req);
        return sendJSON(res, 200, { ok: true, ...cards.freePractice(sid, ctx.userId, id, { result: b.result, studentAnswer: b.studentAnswer, verdict: b.verdict, verdictJson: b.verdictJson }) });
      }
      if (action === 'plan' && method === 'POST') {
        const b = await readBody(req);
        try { return sendJSON(res, 200, { ok: true, card: cards.setPlan(sid, id, b.when) }); }
        catch (e) { return sendJSON(res, 400, { error: e.code || 'ERROR', message: e.message }); }
      }
    } catch (e) { return sendJSON(res, e.code === 'NOT_FOUND' ? 404 : 400, { error: e.code || 'ERROR', message: e.message }); }
  }

  // ---------- 互动课堂（批次4）----------
  if (p === '/api/interactive/generate' && method === 'POST') {
    const b = await readBody(req);
    try { return sendJSON(res, 200, { ok: true, ...(await interactive.generate(sid, ctx.userId, { text: b.text, messageId: b.messageId, conversationId: b.conversationId })) }); }
    catch (e) { return sendJSON(res, 400, { error: e.code || 'ERROR', message: e.message }); }
  }
  if (p === '/api/interactive' && method === 'POST') {
    // 直接提交一个已构建好的 DSL（前端/分享回显用），仅做校验 + 存为 job
    const b = await readBody(req);
    const v = interactive.validateDSL(b.dsl);
    if (!v.ok) return sendJSON(res, 400, { error: 'BAD_DSL', message: v.error });
    const job = chat.createJob(sid, ctx.userId, 'interactive', { conversationId: b.conversationId || null, messageId: b.messageId || null });
    chat.finishJob(job.id, b.dsl);
    return sendJSON(res, 200, { ok: true, jobId: job.id, id: job.id, dsl: b.dsl, source: 'manual', validated: true });
  }
  const im = p.match(/^\/api\/messages\/([^/]+)\/interactive$/);
  if (im && method === 'GET') {
    const owned = D.get('SELECT 1 FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE m.id = ? AND c.space_id = ?', im[1], sid);
    if (!owned) return sendJSON(res, 404, { error: 'NOT_FOUND' });
    return sendJSON(res, 200, { ok: true, items: interactive.getByMessage(sid, im[1]) });
  }
  const ish = p.match(/^\/api\/interactive\/([^/]+)\/share$/);
  if (ish && method === 'POST') {
    try { return sendJSON(res, 200, { ok: true, share: interactive.share(sid, ish[1]) }); }
    catch (e) { return sendJSON(res, 400, { error: e.code || 'ERROR', message: e.message }); }
  }
  if (ish && method === 'DELETE') {
    const cancelled = core.cancelShare(sid, 'interactive', ish[1]);
    return sendJSON(res, 200, { ok: true, cancelled: !!cancelled });
  }
  const ijob = p.match(/^\/api\/jobs\/([^/]+)$/);
  if (ijob && method === 'GET') {
    const j = interactive.getJob(sid, ijob[1]);
    if (!j) return sendJSON(res, 404, { error: 'NOT_FOUND' });
    // shapeJob 已经把 result_json 解析进 j.result，这里直接用，不要再取不存在的 result_json
    return sendJSON(res, 200, { ok: true, job: { id: j.id, kind: j.kind, status: j.status, progress: j.progress, result: j.result !== undefined ? j.result : null, error: j.error || null } });
  }

  // ---------- 宠物 ----------
  // 宠物不只是个装饰：它的阶段就是**功能解锁的门槛**（见 server/pet.js 的 UNLOCKS）。
  // 所以这里连 unlocks 一起回，前端据此决定哪些入口置灰。
  if (p === '/api/pet' && method === 'GET') {
    return sendJSON(res, 200, { ok: true, pet: pet.shape(sid, ctx.userId), unlocks: pet.unlockedFeatures(sid, ctx.userId) });
  }

  // ---------- 看板（P5）----------
  if (p === '/api/dashboard' && method === 'GET') {
    return sendJSON(res, 200, { ok: true, ...dash.dashboard(sid, { days: u.searchParams.get('days') }) });
  }
  if (p === '/api/dashboard/report' && method === 'GET') {
    return sendJSON(res, 200, { ok: true, ...dash.report(sid, u.searchParams.get('period')) });
  }

  // ---------- 学习日报（批次10）----------
  // 日报的"事实层"每次现算（见 server/daily.js 的注释），这里只负责存取"人写的那部分"。
  // 日期一律走 /api/daily/<YYYY-MM-DD>，不传就取今天。
  if (p === '/api/daily' && method === 'GET') {
    return sendJSON(res, 200, { ok: true, report: daily.build(sid, u.searchParams.get('date')) });
  }
  if (p === '/api/daily/history' && method === 'GET') {
    return sendJSON(res, 200, { ok: true, days: daily.history(sid, u.searchParams.get('limit')) });
  }
  // 溯源：把某个数字背后的原始记录取回来。强制按 sid 校验，跨空间取不到。
  const dEv = p.match(/^\/api\/daily\/(\d{4}-\d{2}-\d{2})\/evidence\/([a-z]+)$/);
  if (dEv && method === 'GET') {
    return sendJSON(res, 200, { ok: true, ...daily.evidence(sid, dEv[1], dEv[2]) });
  }
  // 四问里某一条发现的「看依据」：那条发现自带 kind + ids，按 id 精确取。
  const dEvIds = p.match(/^\/api\/daily\/(\d{4}-\d{2}-\d{2})\/evidence$/);
  if (dEvIds && method === 'POST') {
    const b = await readBody(req);
    return sendJSON(res, 200, { ok: true, ...daily.evidenceByIds(sid, dEvIds[1], b.kind, b.ids) });
  }
  const dDraft = p.match(/^\/api\/daily\/(\d{4}-\d{2}-\d{2})\/draft$/);
  if (dDraft && method === 'POST') {
    const b = await readBody(req);
    try { return sendJSON(res, 200, { ok: true, report: daily.saveDraft(sid, dDraft[1], b.answers) }); }
    catch (e) { return sendJSON(res, 400, { error: e.code || 'BAD_INPUT', message: e.message }); }
  }
  const dFin = p.match(/^\/api\/daily\/(\d{4}-\d{2}-\d{2})\/finalize$/);
  if (dFin && method === 'POST') {
    const b = await readBody(req);
    try { return sendJSON(res, 200, { ok: true, report: daily.finalize(sid, dFin[1], b.answers) }); }
    catch (e) { return sendJSON(res, 400, { error: e.code || 'BAD_INPUT', message: e.message }); }
  }

  // ---------- 学习周报（批次16）----------
  // 周报没有自己的表；所有数字从 daily.facts() 现算。
  if (p === '/api/weekly' && method === 'GET') {
    try {
      return sendJSON(res, 200, { ok: true, report: weekly.build(sid, u.searchParams.get('from'), u.searchParams.get('to')) });
    } catch (e) {
      return sendJSON(res, 400, { error: e.message || 'BAD_INPUT', message: e.message });
    }
  }

  // ---------- 历史周报（批次22）----------
  // ★ 关键设计：weekly_reports 表**只存人写的那两问**，汇总数字永不落库。
  //   所以下面这些接口里的数字全是现算的（history 也现算），溯源才指向原始记录而不是自己的副本。
  if (p === '/api/weekly/history' && method === 'GET') {
    return sendJSON(res, 200, { ok: true, weeks: weekly.history(sid, u.searchParams.get('limit')) });
  }
  // 某一段日期的「人写的那段」。没写过返回 null（不是空对象 —— 两者含义不同）。
  if (p === '/api/weekly/note' && method === 'GET') {
    try {
      return sendJSON(res, 200, { ok: true, note: weekly.getNote(sid, u.searchParams.get('from'), u.searchParams.get('to')) });
    } catch (e) {
      return sendJSON(res, 400, { error: e.code || e.message || 'BAD_INPUT', message: e.message });
    }
  }
  // 数字逐项溯源：把 summary 里某个数字拆回原始记录（跨天，每项带 date）。
  if (p === '/api/weekly/evidence' && method === 'GET') {
    try {
      return sendJSON(res, 200, { ok: true, ...weekly.evidenceByMetric(sid, u.searchParams.get('from'), u.searchParams.get('to'), u.searchParams.get('metric')) });
    } catch (e) {
      return sendJSON(res, 400, { error: e.code || e.message || 'BAD_INPUT', message: e.message });
    }
  }
  const wDraft = p.match(/^\/api\/weekly\/note\/(\d{4}-\d{2}-\d{2})\/(\d{4}-\d{2}-\d{2})$/);
  if (wDraft && method === 'POST') {
    const b = await readBody(req);
    try {
      const note = b && b.finalize
        ? weekly.finalize(sid, wDraft[1], wDraft[2], b.answers)
        : weekly.saveDraft(sid, wDraft[1], wDraft[2], b.answers);
      return sendJSON(res, 200, { ok: true, note: note });
    } catch (e) {
      return sendJSON(res, 400, { error: e.code || e.message || 'BAD_INPUT', message: e.message });
    }
  }

  // ---------- 家长端（批次20）----------
  // ★ 家长端没有自己的表；所有数字从 activity / card_reviews / cards 现算。
  //   它回答的不是"我做了什么"（看板），而是"我能做什么"。
  if (p === '/api/parent' && method === 'GET') {
    try {
      return sendJSON(res, 200, { ok: true, view: parent.build(sid, u.searchParams.get('from'), u.searchParams.get('to')) });
    } catch (e) {
      return sendJSON(res, 400, { error: e.code || 'BAD_INPUT', message: e.message });
    }
  }

  // ---------- 能力中心（P7）----------
  if (p === '/api/skills' && method === 'GET') {
    return sendJSON(res, 200, {
      ok: true,
      skills: skills.list(sid, { category: u.searchParams.get('category') || 'all', subject: u.searchParams.get('subject') || 'all' }),
      enabled: skills.enabledIds(sid),
      // 本空间档位 + 档位阶梯：前端要拿它显示"这条什么时候能用"
      tier: skills.spaceTier(sid),
      tiers: skills.TIERS,
    });
  }
  if (p === '/api/skills/enabled' && method === 'POST') {
    const b = await readBody(req);
    return sendJSON(res, 200, { ok: true, skills: skills.setEnabled(sid, b.skillIds), enabled: skills.enabledIds(sid) });
  }
  const skm = p.match(/^\/api\/skills\/([a-z0-9_-]+)\/grant$/);
  if (skm) {
    try {
      if (method === 'POST') return sendJSON(res, 200, { ok: true, skills: skills.grant(sid, skm[1]), enabled: skills.enabledIds(sid) });
      if (method === 'DELETE') return sendJSON(res, 200, { ok: true, skills: skills.revoke(sid, skm[1]), enabled: skills.enabledIds(sid) });
    } catch (e) {
      // 锁定 = 403（越权），不是 400（参数写错）—— 前端靠这个区分"该升级档位"和"点错了"
      const st = e.code === 'NOT_FOUND' ? 404 : (e.code === 'FORBIDDEN' ? 403 : 400);
      return sendJSON(res, st, { error: e.code, message: e.message });
    }
  }

  // ---------- 知识库（P2）----------
  if (p === '/api/kb/categories' && method === 'GET') {
    return sendJSON(res, 200, {
      ok: true,
      categories: kb.listCategories(sid),
      uncategorized: kb.uncategorizedCount(sid),
      defaults: { capacity: kb.DEFAULT_CAPACITY, maxCapacity: kb.MAX_CAPACITY, maxCategories: kb.MAX_CATEGORIES },
    });
  }
  if (p === '/api/kb/categories' && method === 'POST') {
    const b = await readBody(req);
    try { return sendJSON(res, 200, { ok: true, category: kb.createCategory(sid, b.name, { capacity: b.capacity }) }); }
    catch (e) { return sendJSON(res, e.code === 'DUP' ? 409 : e.code === 'LIMIT' ? 403 : 400, { error: e.code, message: e.message }); }
  }
  const kbce = p.match(/^\/api\/kb\/categories\/([^/]+)\/expand$/);
  if (kbce && method === 'POST') {
    const b = await readBody(req);
    try { return sendJSON(res, 200, { ok: true, category: kb.expandCategory(sid, kbce[1], b.delta) }); }
    catch (e) { return sendJSON(res, e.code === 'NOT_FOUND' ? 404 : e.code === 'LIMIT' ? 403 : 400, { error: e.code, message: e.message }); }
  }
  const kbc = p.match(/^\/api\/kb\/categories\/([^/]+)$/);
  if (kbc && method === 'DELETE') return sendJSON(res, 200, { ok: true, deleted: kb.deleteCategory(sid, kbc[1]) });
  if (kbc && method === 'PATCH') {
    const b = await readBody(req);
    try { return sendJSON(res, 200, { ok: true, category: kb.renameCategory(sid, kbc[1], b.name) }); }
    catch (e) { return sendJSON(res, e.code === 'NOT_FOUND' ? 404 : e.code === 'DUP' ? 409 : 400, { error: e.code, message: e.message }); }
  }

  if (p === '/api/kb/documents' && method === 'GET') {
    return sendJSON(res, 200, {
      ok: true,
      documents: kb.listDocuments(sid, {
        categoryId: u.searchParams.get('categoryId') || undefined,
        status: u.searchParams.get('status') || undefined,
        state: u.searchParams.get('state') || undefined,
      }),
    });
  }
  if (p === '/api/kb/documents' && method === 'POST') {
    // 文件以 base64 走 JSON（不引入 multipart 解析），上限放到 36MB
    const b = await readBody(req, 36 * 1024 * 1024);
    try {
      // ★ 必须走 chat.saveDocument 而不是 kb.addDocument：扫描件要在这里排队做 OCR。
      //   直接调 kb 的话，文档会被标成「识别中」却没有任何任务去跑 —— 永远转圈。
      const doc = chat.saveDocument(sid, ctx.userId, {
        filename: b.filename, dataBase64: b.dataBase64, text: b.text,
        categoryId: b.categoryId, projectId: b.projectId,
      });
      // 「识别中」是**已接受、正在处理**，不是 unprocessable。回 422 会让前端
      // 把它算成上传失败，用户看到的就是"扫描件传不上去"——正是这次报障的观感。
      return sendJSON(res, doc.status === 'failed' ? 422 : 200, {
        ok: doc.status !== 'failed', document: doc,
      });
    } catch (e) {
      // FULL 给 409：它是"目标位置满了"这种冲突，不是参数错，前端要据此提示"先扩容"
      const st = e.code === 'TOO_BIG' ? 413 : e.code === 'FULL' ? 409 : e.code === 'NOT_FOUND' ? 404 : 400;
      return sendJSON(res, st, { error: e.code || 'BAD_INPUT', message: e.message });
    }
  }
  const kbd = p.match(/^\/api\/kb\/documents\/([^/]+)(?:\/([a-z]+))?$/);
  if (kbd) {
    const id = kbd[1], act = kbd[2] || '';
    if (!act && method === 'GET') {
      const d = kb.getDocument(sid, id);
      return d ? sendJSON(res, 200, { ok: true, document: d }) : sendJSON(res, 404, { error: 'NOT_FOUND' });
    }
    if (!act && method === 'DELETE') return sendJSON(res, 200, { ok: true, deleted: kb.deleteDocument(sid, id) });
    if (act === 'move' && method === 'POST') {
      const b = await readBody(req);
      try { return sendJSON(res, 200, { ok: true, document: kb.moveDocument(sid, id, b.categoryId) }); }
      catch (e) { return sendJSON(res, e.code === 'NOT_FOUND' ? 404 : e.code === 'FULL' ? 409 : 400, { error: e.code, message: e.message }); }
    }
    if (act === 'reparse' && method === 'POST') {
      try {
        const doc = kb.reparseDocument(sid, id);
        // 扫描件「重新识别」= 重新排一次 OCR。少了这一段，点了按钮只会把状态
        // 改成 parsing，却没人去跑 —— 又是永远转圈。
        if (doc && doc.scanned) {
          const jid = chat.queueOcrJob(sid, ctx.userId, doc);
          if (jid) doc.jobId = jid;
          delete doc.scanned;
        }
        return sendJSON(res, 200, { ok: true, document: doc });
      }
      catch (e) { return sendJSON(res, e.code === 'NOT_FOUND' ? 404 : 400, { error: e.code || 'BAD_INPUT', message: e.message }); }
    }
    if (act === 'text' && method === 'GET') {
      const d = kb.getDocument(sid, id);
      if (!d) return sendJSON(res, 404, { error: 'NOT_FOUND' });
      return sendJSON(res, 200, { ok: true, id: d.id, filename: d.filename, text: d.text, textLength: d.textLength });
    }
    if (act === 'search' && method === 'GET') {
      return sendJSON(res, 200, { ok: true, hits: kb.retrieve(sid, u.searchParams.get('q') || '', { limit: u.searchParams.get('limit') }) });
    }
  }
  if (p === '/api/kb/search' && method === 'GET') {
    return sendJSON(res, 200, { ok: true, hits: kb.retrieve(sid, u.searchParams.get('q') || '', { limit: u.searchParams.get('limit') }) });
  }
  if (p === '/api/kb/attach' && method === 'POST') {
    const b = await readBody(req);
    try { return sendJSON(res, 200, { ok: true, document: kb.attachToProject(sid, b.docId, b.projectId, b.on !== false) }); }
    catch (e) { return sendJSON(res, e.code === 'NOT_FOUND' ? 404 : 400, { error: e.code, message: e.message }); }
  }

  // ---------- 英语（P10）----------
  // 说明：不接外部语音评测，跟读比对用的是浏览器识别结果，见 server/english.js 头部。
  if (p === '/api/english/units' && method === 'GET') return sendJSON(res, 200, { ok: true, units: english.listUnits(sid) });
  if (p === '/api/english/units' && method === 'POST') {
    const b = await readBody(req);
    try { return sendJSON(res, 200, { ok: true, unit: english.createUnit(sid, b) }); }
    catch (e) { return sendJSON(res, 400, { error: e.code, message: e.message }); }
  }
  const eum = p.match(/^\/api\/english\/units\/([^/]+)$/);
  if (eum && method === 'DELETE') return sendJSON(res, 200, { ok: true, deleted: english.deleteUnit(sid, eum[1]) });

  if (p === '/api/english/words' && method === 'GET') {
    return sendJSON(res, 200, { ok: true, words: english.listWords(sid, {
      unitId: u.searchParams.get('unitId') || undefined,
      q: u.searchParams.get('q') || '',
      sort: u.searchParams.get('sort') || 'new',
    }) });
  }
  if (p === '/api/english/words' && method === 'POST') {
    const b = await readBody(req);
    try { return sendJSON(res, 200, { ok: true, word: english.addWord(sid, b) }); }
    catch (e) { return sendJSON(res, 400, { error: e.code, message: e.message }); }
  }
  if (p === '/api/english/words/import' && method === 'POST') {
    const b = await readBody(req);
    const r = english.importWords(sid, { unitId: b.unitId, text: b.text, words: b.words });
    return sendJSON(res, 200, { ok: true, ...r });
  }
  if (p === '/api/english/words/to-cards' && method === 'POST') {
    const b = await readBody(req);
    const made = english.toCards(sid, ctx.userId, b.wordIds);
    return sendJSON(res, 200, { ok: true, cards: made, count: made.length });
  }
  const ewm = p.match(/^\/api\/english\/words\/([^/]+)$/);
  if (ewm) {
    try {
      if (method === 'PATCH') { const b = await readBody(req); return sendJSON(res, 200, { ok: true, word: english.updateWord(sid, ewm[1], b) }); }
      if (method === 'DELETE') return sendJSON(res, 200, { ok: true, deleted: english.deleteWord(sid, ewm[1]) });
    } catch (e) { return sendJSON(res, e.code === 'NOT_FOUND' ? 404 : 400, { error: e.code, message: e.message }); }
  }

  if (p === '/api/english/dictation' && method === 'GET') {
    return sendJSON(res, 200, { ok: true, ...english.dictation(sid, {
      unitId: u.searchParams.get('unitId') || undefined,
      count: u.searchParams.get('count'),
      mode: u.searchParams.get('mode') || 'meaning',
      order: u.searchParams.get('order') || 'wrong',
    }) });
  }
  if (p === '/api/english/grade' && method === 'POST') {
    const b = await readBody(req);
    return sendJSON(res, 200, { ok: true, ...english.grade(sid, ctx.userId, { items: b.items, createCards: b.createCards !== false }) });
  }
  if (p === '/api/english/speech-compare' && method === 'POST') {
    const b = await readBody(req);
    return sendJSON(res, 200, { ok: true, ...english.compareSpeech(b.target, b.heard) });
  }

  // ---------- 英语：单元四关 + 艾宾浩斯（批次24）----------
  // ★ 四关的"过了几个词"全部现算（落在 words.right_count 上），进度不落库。
  // 见 server/english.js 头部「单元四关」一节。
  if (p === '/api/english/board' && method === 'GET') {
    return sendJSON(res, 200, { ok: true, ...english.unitBoard(sid) });
  }
  const eug = p.match(/^\/api\/english\/units\/([^/]+)\/progress$/);
  if (eug && method === 'GET') {
    const r = english.unitProgress(sid, decodeURIComponent(eug[1]));
    if (!r) return sendJSON(res, 404, { error: '单元不存在' });
    return sendJSON(res, 200, { ok: true, progress: r });
  }
  if (p === '/api/english/gate' && method === 'GET') {
    const g = u.searchParams.get('gate') || 'recognize';
    try {
      return sendJSON(res, 200, { ok: true, ...english.gateTasks(sid, u.searchParams.get('unitId') || null, g, {
        count: u.searchParams.get('count'),
      }) });
    } catch (e) { return sendJSON(res, 400, { error: e.message, code: e.code || 'BAD_INPUT' }); }
  }
  if (p === '/api/english/gate/grade' && method === 'POST') {
    const b = await readBody(req);
    try {
      return sendJSON(res, 200, { ok: true, ...english.gradeGate(sid, ctx.userId, {
        gate: b.gate, items: b.items, createCards: b.createCards !== false,
      }) });
    } catch (e) { return sendJSON(res, 400, { error: e.message, code: e.code || 'BAD_INPUT' }); }
  }
  if (p === '/api/english/review' && method === 'GET') {
    return sendJSON(res, 200, { ok: true, queue: english.reviewQueue(sid, {
      unitId: u.searchParams.get('unitId') || null,
      count: u.searchParams.get('count'),
    }), stats: english.reviewStats(sid, u.searchParams.get('unitId') || null) });
  }
  if (p === '/api/english/review' && method === 'POST') {
    const b = await readBody(req);
    try {
      return sendJSON(res, 200, { ok: true, ...english.recordReview(sid, ctx.userId, {
        wordId: b.wordId, gate: b.gate, result: b.result,
      }) });
    } catch (e) { return sendJSON(res, e.code === 'NOT_FOUND' ? 404 : 400, { error: e.message, code: e.code || 'BAD_INPUT' }); }
  }

  // ---------- 测评（P6）----------
  // 出卷不下发答案；交卷后每题回流知识卡 —— 见 server/exam.js 头部。
  if (p === '/api/exams/breakdown' && method === 'GET') {
    return sendJSON(res, 200, { ok: true, subjects: exam.subjectBreakdown(sid) });
  }
  // 7 阶段成长画像（批次22-③）：全部现算、不落库、不评分。见 server/growth.js 头部。
  if (p === '/api/growth' && method === 'GET') {
    return sendJSON(res, 200, { ok: true, portrait: growth.portrait(sid) });
  }
  if (p === '/api/exams' && method === 'GET') {
    return sendJSON(res, 200, { ok: true, exams: exam.listExams(sid, { projectId: u.searchParams.get('projectId') || undefined }) });
  }
  if (p === '/api/exams' && method === 'POST') {
    const b = await readBody(req);
    try {
      return sendJSON(res, 200, { ok: true, exam: exam.createExam(sid, ctx.userId, b) });
    } catch (e) {
      const map = { NO_CARDS: 409 };
      return sendJSON(res, map[e.code] || 400, { error: e.code || 'BAD_INPUT', message: e.message });
    }
  }
  const exm = p.match(/^\/api\/exams\/([^/]+)(?:\/([a-z]+))?$/);
  if (exm) {
    const id = exm[1], act = exm[2] || '';
    try {
      if (!act && method === 'GET') {
        const x = exam.getExam(sid, id);
        return x ? sendJSON(res, 200, { ok: true, exam: x }) : sendJSON(res, 404, { error: 'NOT_FOUND' });
      }
      if (!act && method === 'DELETE') return sendJSON(res, 200, { ok: true, deleted: exam.removeExam(sid, id) });
      if (act === 'submit' && method === 'POST') {
        const b = await readBody(req);
        return sendJSON(res, 200, { ok: true, ...(await exam.submit(sid, ctx.userId, id, b.answers)) });
      }
    } catch (e) {
      const map = { NOT_FOUND: 404, ALREADY: 409 };
      return sendJSON(res, map[e.code] || 400, { error: e.code || 'ERROR', message: e.message });
    }
  }

  // ---------- 公共资料池（P3）----------
  // 只放用户主动共享的内容；取用是"复制进自己空间"，不做跨空间读写。
  if (p === '/api/pool/mine' && method === 'GET') {
    return sendJSON(res, 200, { ok: true, items: pool.mine(sid), stats: pool.myStats(sid) });
  }
  if (p === '/api/pool/stats' && method === 'GET') return sendJSON(res, 200, { ok: true, ...pool.myStats(sid) });
  if (p === '/api/pool' && method === 'GET') {
    return sendJSON(res, 200, { ok: true, ...pool.list(sid, {
      subject: u.searchParams.get('subject') || 'all',
      kind: u.searchParams.get('kind') || 'all',
      q: u.searchParams.get('q') || '',
      sort: u.searchParams.get('sort') || 'new',
      mine: u.searchParams.get('mine') === '1',
    }) });
  }
  if (p === '/api/pool' && method === 'POST') {
    const b = await readBody(req);
    try { return sendJSON(res, 200, { ok: true, item: pool.share(sid, ctx.userId, b) }); }
    catch (e) {
      const map = { SHARE_BANNED: 403, TOO_MANY: 429, TOO_BIG: 413, NOT_FOUND: 404 };
      return sendJSON(res, map[e.code] || 400, { error: e.code || 'BAD_INPUT', message: e.message });
    }
  }
  const pom = p.match(/^\/api\/pool\/([^/]+)(?:\/([a-z]+))?$/);
  if (pom) {
    const id = pom[1], act = pom[2] || '';
    try {
      if (!act && method === 'GET') {
        const it = pool.get(sid, id);
        return it ? sendJSON(res, 200, { ok: true, item: it }) : sendJSON(res, 404, { error: 'NOT_FOUND' });
      }
      if (!act && method === 'DELETE') return sendJSON(res, 200, { ok: true, removed: pool.removeShare(sid, id) });
      if (act === 'copy' && method === 'POST') {
        const b = await readBody(req);
        return sendJSON(res, 200, { ok: true, ...pool.copy(sid, ctx.userId, id, { toCards: b.toCards !== false }) });
      }
      if (act === 'report' && method === 'POST') {
        const b = await readBody(req);
        return sendJSON(res, 200, { ok: true, ...pool.report(sid, ctx.userId, id, b.reason) });
      }
    } catch (e) {
      const map = { NOT_FOUND: 404, GONE: 410, ALREADY: 409, FORBIDDEN: 403 };
      return sendJSON(res, map[e.code] || 400, { error: e.code || 'ERROR', message: e.message });
    }
  }

  return sendJSON(res, 404, { error: 'NOT_FOUND', message: '没有这个接口：' + p });
}

// ---------- 公开分享页数据（无需登录）----------
async function handlePublic(req, res, u) {
  const m = u.pathname.match(/^\/api\/share\/([a-zA-Z0-9]+)$/);
  if (m && req.method === 'GET') {
    const s = core.getShare(m[1]);
    if (!s) return sendJSON(res, 404, { error: 'SHARE_GONE', message: '这条分享不存在或已失效' });
    if (s.kind === 'conversation') {
      const msgs = D.all('SELECT role,content,created_at FROM messages WHERE conversation_id = ? AND deleted = 0 ORDER BY seq ASC', s.target_id)
        .map(x => ({ role: x.role, content: x.content, createdAt: x.created_at }));
      const sp = D.get('SELECT name FROM spaces WHERE id = ?', s.space_id);
      return sendJSON(res, 200, { ok: true, kind: 'conversation', title: '学习对话', spaceName: sp ? sp.name : '', messages: msgs });
    }
    if (s.kind === 'interactive') {
      const j = D.get('SELECT result_json FROM jobs WHERE id = ? AND space_id = ?', s.target_id, s.space_id);
      const dsl = j && j.result_json ? core.safeJSON(j.result_json) : null;
      if (!dsl) return sendJSON(res, 404, { error: 'SHARE_GONE', message: '这个互动课堂已下架' });
      const sp = D.get('SELECT name FROM spaces WHERE id = ?', s.space_id);
      return sendJSON(res, 200, { ok: true, kind: 'interactive', title: dsl.title || '互动课堂', spaceName: sp ? sp.name : '', dsl });
    }
    return sendJSON(res, 200, { ok: true, kind: s.kind });
  }
  return sendJSON(res, 404, { error: 'NOT_FOUND' });
}

// ---------- 服务器 ----------
const server = http.createServer(async (req, res) => {
  // 注意：不要用 url.parse() —— 它返回的 Url 对象**没有 searchParams**，
  // 所有带查询参数的接口都会在 u.searchParams.get() 上抛 TypeError。
  // new URL 才有标准的 searchParams，且 pathname 语义一致。
  let u;
  try { u = new URL(req.url, 'http://' + (req.headers.host || 'localhost')); }
  catch (e) { return sendJSON(res, 400, { error: 'BAD_URL' }); }
  try {
    if (u.pathname.startsWith('/api/share/')) return await handlePublic(req, res, u);
    if (u.pathname.startsWith('/api/')) return await handleApi(req, res, u);
    return serveStatic(req, res, u.pathname);
  } catch (e) {
    console.error('[error]', u.pathname, e);
    if (!res.headersSent) sendJSON(res, 500, { error: 'INTERNAL', message: String(e.message || e) });
    else try { res.end(); } catch (_) {}
  }
});

auth.ensureDefaultSpace();
// 空间口令：把 2026-10-03 之前存的**明文**口令换成 scrypt 哈希（幂等，已哈希的跳过）。
// 必须在监听之前做 —— enterSpace 现在按哈希比对，不迁移的话老空间会全部进不去。
const _pwMigrated = auth.migratePasscodes();
if (_pwMigrated) console.log('[口令] 已把 ' + _pwMigrated + ' 个空间的口令迁移为哈希存储');
skills.migrateTiers();   // 把旧的 required_tier='free' 归一到现行最低档（批次25 换过档位名）
skills.seed();   // 技能注册表是代码里的常量，每次启动同步进库（幂等）
chat.startWorker();   // AI 配图 / 互动课堂等异步任务的调度器（定时器已 unref，不拦测试退出）

if (require.main === module) {
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[后浪学习平台] v${APP_VERSION} → http://localhost:${PORT}`);
    console.log(`[数据] ${D.DB_FILE}`);
    console.log(`[模型] ${llm.isMock() ? '离线演示模式（未配置 LLM_API_KEY）' : '已配置'}`);
    console.log(`[配图] ${chat.imageConfig().enabled ? '外部图像服务' : '模型生成矢量插画（零外部依赖）'}`);
    console.log(`[联网] ${chat.searchConfig().enabled ? '已接入搜索通道' : '未配置，联网搜索会如实告知不可用'}`);
    console.log(`[管理] ${ADMIN_PASSWORD ? '管理员入口已开启' : '管理员入口关闭（未设 ADMIN_PASSWORD）'}`);
  });
}

module.exports = { server, APP_VERSION };

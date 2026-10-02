'use strict';
/**
 * 批次11 自检：AI 场景插画（规划 / 总结 / 计划）+ 通栏对话版式 + 新建项目即时可见。
 *
 * 覆盖三件事：
 *   1) 模块级 —— shouldConceptArt 触发判定、aiArtConfig 开关、
 *      generateAIImage 的队列式全流程（现场桩掉 fetch，验到"文件真的落到磁盘"）、
 *      attachArtifact 挂回消息。
 *   2) 静态 —— 前端渲染分支（raster → <img>）与轮询钩子必须在位。
 *   3) 静态 —— 版式（通栏）与"新建项目后刷左栏"不许被改回去。
 *
 * 不起服务、不连外网：生图上游用假 fetch 顶替，走的却是同一条代码路径。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hl-p11-'));
process.env.DATA_DIR = TMP;
process.env.NO_DOTENV = '1';
delete process.env.LLM_API_KEY;
delete process.env.ADMIN_PASSWORD;
delete process.env.IMAGE_PROVIDER_URL;
delete process.env.IMAGE_API_KEY;
delete process.env.IMAGE_AI_ART;

let pass = 0, fail = 0;
const fails = [];
function ok(cond, name, extra) {
  if (cond) { pass++; }
  else { fail++; fails.push(name + (extra !== undefined ? ' → ' + JSON.stringify(extra) : '')); }
}
async function rejects(fn, needle, name) {
  try { await fn(); fail++; fails.push(name + ' → 期望抛错，实际没抛'); }
  catch (e) { ok(String(e.message || e).indexOf(needle) >= 0, name, { msg: e.message }); }
}

const D = require('./server/db');
const core = require('./server/core');
const auth = require('./server/auth');
const chat = require('./server/chat');

const CSS = fs.readFileSync(path.join(__dirname, 'public', 'app.css'), 'utf8');
const APPJS = fs.readFileSync(path.join(__dirname, 'public', 'js', 'app.js'), 'utf8');
const SERVERJS = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');

/** 一段"计划/总结"式的回答：够长、有标题 */
const PLAN_ANSWER = [
  '## 期末复习计划', '',
  '我们把接下来四周拆成三轮，每一轮都盯住一个目标，别贪多。', '',
  '### 第一轮：把漏洞补上（第 1-2 周）', '',
  '1. 每天 20 分钟过一遍错题本，只看做错的题，不看已经会的；',
  '2. 周末做一套完整卷子，限时，模拟真实考试的节奏；',
  '3. 每周末写三行复盘：这周哪儿卡住了、下周怎么调。', '',
  '### 第二轮：把知识点串起来（第 3 周）', '',
  '按章节画知识地图，先画主干再挂细节 —— 这一步是为了让你看到知识点之间的关系。',
  '遇到串不起来的地方，就是我们下一步要补的地方。', '',
  '### 第三轮：稳住状态（第 4 周）', '',
  '不再做新题，只做两件事：把错题再做一遍、把作息调回来。',
  '作息比刷题更能决定你考场上的发挥，这一点很多人到最后才明白。',
].join('\n');

(async () => {
  // ============================================================
  // 一、shouldConceptArt 触发判定
  // ============================================================
  ok(chat.shouldConceptArt('帮我做个期末复习计划', PLAN_ANSWER) === true,
    '问题里出现"计划" + 成篇回答 → 触发');
  ok(chat.shouldConceptArt('这学期学成这样，帮我总结一下', PLAN_ANSWER) === true,
    '问题里出现"总结" → 触发');
  ok(chat.shouldConceptArt('怎么复盘这次月考', PLAN_ANSWER) === true, '问题里出现"复盘" → 触发');
  ok(chat.shouldConceptArt('今天天气怎么样', PLAN_ANSWER) === true,
    '问题不沾边但回答里堆了两条以上计划类标题 → 也触发（宁可多配一张）');

  ok(chat.shouldConceptArt('帮我做个计划', '好的。') === false,
    '反证：回答太短（<220 字）不配图，图会喧宾夺主');
  ok(chat.shouldConceptArt('勾股定理怎么证',
    '把三边设为 a、b、c，按面积法拼一个正方形，两边相等就出来了。'.repeat(6)) === false,
    '反证：普通数学讲解不配场景插画（那是 SVG 示意图的活）');
  ok(chat.shouldConceptArt('这首诗讲了什么',
    '作者借景抒情，先写景再写心，重点落在最后一句的转折上。'.repeat(8)) === false,
    '反证：语文赏析不配场景插画');
  ok(chat.shouldConceptArt('', '') === false, '反证：空文本不触发');
  ok(chat.shouldConceptArt(null, null) === false, '反证：null 不炸也不触发');

  // 与几何档互斥：几何题绝不能落到"AI 场景插画"这条路
  ok(chat.shouldIllustrate('这道几何题怎么证', PLAN_ANSWER) === true,
    '几何档仍然命中（上游先判它，AI 插画档就不会被走到）');

  // ============================================================
  // 二、aiArtConfig 开关
  // ============================================================
  let cfg = chat.aiArtConfig();
  ok(cfg.enabled === false, '没有 Key → 生图档关闭（不会静默烧钱）');
  ok(String(cfg.url).indexOf('qnaigc') >= 0, '默认上游指向七牛队列接口（开箱可用）');

  process.env.LLM_API_KEY = 'sk-test-only';
  cfg = chat.aiArtConfig();
  ok(cfg.enabled === true, '有 LLM_API_KEY → 生图档默认打开（不用再申请第二个 Key）');
  ok(cfg.aspect === '4:3', '默认 4:3 横版（插画是配图，不是装饰条）');

  process.env.IMAGE_AI_ART = '0';
  ok(chat.aiArtConfig().enabled === false, 'IMAGE_AI_ART=0 → 一键关掉生图');
  delete process.env.IMAGE_AI_ART;

  process.env.IMAGE_PROVIDER_URL = 'https://example.invalid/gen';
  ok(chat.aiArtConfig().url === 'https://example.invalid/gen', 'IMAGE_PROVIDER_URL 可以换服务商');
  delete process.env.IMAGE_PROVIDER_URL;

  // 轮询节奏改成毫秒级：默认是 3 秒一探、最多 50 次（线上该这么保守），
  // 但自检里等 150 秒没有任何意义。
  process.env.IMAGE_POLL_MS = '10';
  process.env.IMAGE_POLL_MAX = '3';

  // ============================================================
  // 三、generateAIImage 全流程（桩 fetch）
  // ============================================================
  auth.ensureDefaultSpace();
  const sid = '0001';
  const conv = core.createConversation(sid, null, { title: '批次11' });
  const reply = core.addMessage(sid, conv.id, { role: 'assistant', content: PLAN_ANSWER });

  // 1x1 透明 PNG
  const PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64');

  const calls = [];
  const REAL_FETCH = global.fetch;
  global.fetch = async (url, opt) => {
    const u = String(url);
    calls.push((opt && opt.method ? opt.method : 'GET') + ' ' + u);
    if (opt && opt.method === 'POST') {
      return jsonRes({ status: 'IN_QUEUE', request_id: 'q1', status_url: 'https://fake/status', response_url: 'https://fake/result' });
    }
    if (u.endsWith('/status')) return jsonRes({ status: 'COMPLETED', result: { images: [{ url: 'https://fake/img/0.png' }] } });
    if (u.endsWith('/result')) return jsonRes({ images: [{ url: 'https://fake/img/0.png' }] });
    if (u.indexOf('/img/') >= 0) {
      return { ok: true, status: 200, arrayBuffer: async () => PNG.buffer.slice(PNG.byteOffset, PNG.byteOffset + PNG.byteLength) };
    }
    return jsonRes({}, 404);
  };
  function jsonRes(o, st) {
    return { ok: (st || 200) < 400, status: st || 200, json: async () => o, text: async () => JSON.stringify(o) };
  }

  let art = null;
  try { art = await chat.generateAIImage(sid, '一名中学生在书桌前做复习计划，桌上有笔记本与便签', { conversationId: conv.id }); }
  catch (e) { fail++; fails.push('generateAIImage 正常路径不该抛：' + e.message); }

  ok(!!art && art.mode === 'raster', '出图成功 → mode=raster', art && art.mode);
  ok(!!art && /^att_[a-z0-9]+$/.test(String(art.fileId)), '落成一个空间文件（att_ 前缀）', art && art.fileId);
  ok(!!art && art.url === '/api/files/' + art.fileId, '附件地址指向 /api/files/<id>（不用 base64 塞消息体）', art && art.url);
  ok(calls[0] && calls[0].indexOf('POST') === 0, '先建任务（POST 队列接口）');
  ok(calls.some(c => c.indexOf('/status') >= 0), '轮询了任务状态');
  ok(calls.some(c => c.indexOf('/img/') >= 0), '把生成的图下载回来了');

  // 文件真的落到磁盘 + 能读回来（这一步才是"刷新后还在"的证据）
  let disk = [], read = null;
  if (art) {
    try { disk = fs.readdirSync(path.join(TMP, 'uploads', D.normalizeSpace(sid))); } catch (e) { disk = []; }
    read = chat.readAttachment(sid, art.fileId);
  }
  ok(!!art && disk.some(n => n.indexOf(art.fileId) === 0), '图片文件真的写进了空间上传目录', disk);
  ok(!!read && read.mime === 'image/png', 'readAttachment 能读回来（/api/files 走的就是它）', read && read.mime);

  ok(!!art && art.bytes > 0, '记录了图片字节数（便于排查"图挂了"）', art && art.bytes);

  // 状态接口一直说"排队中"，但 results 里其实已经有图了 —— 必须走兜底把图取回来，
  // 不能因为上游不报 COMPLETED 就白等 150 秒然后失败。
  global.fetch = async (url, opt) => {
    const u = String(url);
    if (opt && opt.method === 'POST') return jsonRes({ status: 'IN_QUEUE', status_url: 'https://fake/status', response_url: 'https://fake/result' });
    if (u.endsWith('/status')) return jsonRes({ status: 'IN_QUEUE' }, 202);
    if (u.endsWith('/result')) return jsonRes({ images: [{ url: 'https://fake/img/0.png' }] });
    return { ok: true, status: 200, arrayBuffer: async () => PNG.buffer.slice(PNG.byteOffset, PNG.byteOffset + PNG.byteLength) };
  };
  let art2 = null;
  try { art2 = await chat.generateAIImage(sid, '兜底场景', {}); } catch (e) { fail++; fails.push('兜底路径不该抛：' + e.message); }
  ok(!!art2 && art2.mode === 'raster', '状态一直排队但 results 有图 → 兜底也能拿到图');

  // 用不了的服务商：必须抛错，让上层退回矢量插画，而不是静默什么都不画
  global.fetch = async (url, opt) => {
    if (opt && opt.method === 'POST') return jsonRes({ status: 'IN_QUEUE', status_url: 'https://fake/status' });
    if (String(url).endsWith('/status')) return jsonRes({ status: 'ERROR' });
    return jsonRes({}, 404);
  };
  await rejects(() => chat.generateAIImage(sid, '场景', {}), '生图失败', '上游报 ERROR → 抛错（上层会退回矢量插画）');

  global.fetch = async (url, opt) => {
    if (opt && opt.method === 'POST') return jsonRes({ status: 'IN_QUEUE', status_url: 'https://fake/status' });
    return jsonRes({ status: 'IN_QUEUE' }, 202);
  };
  await rejects(() => chat.generateAIImage(sid, '场景', {}), '没有返回图片', '一直排队不出图 → 在超时上限内认失败');

  global.fetch = async (url, opt) => {
    if (opt && opt.method === 'POST') return jsonRes({ status: 'IN_QUEUE', status_url: 'https://fake/status' });
    if (String(url).endsWith('/status')) return jsonRes({ status: 'COMPLETED' });
    return jsonRes({ images: [] });
  };
  await rejects(() => chat.generateAIImage(sid, '场景', {}), '没有返回图片', '任务完成但没图 → 抛错');
  delete process.env.IMAGE_POLL_MS;
  delete process.env.IMAGE_POLL_MAX;
  global.fetch = REAL_FETCH;

  // ============================================================
  // 四、attachArtifact 挂回消息
  // ============================================================
  const FID = art ? art.fileId : 'att_missing';
  const att = { kind: 'illustration', mode: 'raster', fileId: FID, title: 'AI 配图' };
  ok(chat.attachArtifact(sid, reply.id, att) === true, '挂附件成功');
  const back = core.getMessage(sid, reply.id);
  ok((back.attachments || []).length === 1, '消息上确实多了一条附件');
  ok(back.attachments[0].mode === 'raster' && back.attachments[0].fileId === FID, '附件内容原样落库');
  ok(chat.attachArtifact(sid, 'm_不存在', att) === false, '消息不存在 → 返回 false，不抛错（后台任务不该炸）');
  ok(chat.attachArtifact('', reply.id, att) === false, '空间为空 → 返回 false');

  // 第二次挂：必须**追加**而不是覆盖（几何图 + 场景图能共存）
  chat.attachArtifact(sid, reply.id, { kind: 'illustration', title: '半成品' });
  ok(core.getMessage(sid, reply.id).attachments.length === 2, '再次挂附件是追加，不覆盖前面的');

  // ============================================================
  // 五、前端结构（静态）
  // ============================================================
  ok(APPJS.indexOf("att.mode === 'raster' && att.fileId") >= 0, '前端识得 raster 模式');
  ok(APPJS.indexOf('class="msg-att-illu art-ai"') >= 0, 'raster 走 art-ai 容器（比矢量图更宽）');
  ok(/msg-att-illu art-ai[\s\S]{0,400}fileUrl\(att\.fileId\)/.test(APPJS), 'raster 用 <img> 渲染，且走 fileUrl()');

  // ★ 图片直链必须带 ?_t= ：<img src> 带不上 Authorization 头，
  //   不加 token 会被鉴权闸门挡成 401 —— 表现是"图片一片空白"，很难查。
  ok(/function fileUrl\(id\)[\s\S]{0,400}\?_t=/.test(APPJS), 'fileUrl() 把 token 放进查询串');
  ok(APPJS.indexOf("'<img src=\"/api/files/' + esc(a.id)") < 0, '消息里的图片直链不再裸写（必须过 fileUrl）');
  ok(APPJS.indexOf("'/api/files/' + encodeURIComponent(id)") >= 0, 'fileUrl 对 id 做了 encode（不许直接拼）');
  ok(APPJS.indexOf('async function watchArt(') >= 0, '有配图等待器 watchArt');
  ok(APPJS.indexOf("ev === 'art'") >= 0 && APPJS.indexOf('expectingArt') >= 0, 'SSE art 事件被接住（不白轮询）');
  ok(APPJS.indexOf('if (expectingArt && replyId) watchArt(replyId, a);') >= 0, 'send() 结束后才去等图');
  ok(SERVERJS.indexOf("send('art', { kind: 'ai'") >= 0, '服务端在流里预告"要 AI 出图"');
  ok(SERVERJS.indexOf("send('art', { kind: 'svg'") >= 0, '服务端在流里预告"要矢量示意图"');
  ok(SERVERJS.indexOf('chat.shouldConceptArt(opt.text, full)') >= 0, '服务端真的接上了 shouldConceptArt');
  ok(/shouldIllustrate\(opt\.text, full\)\)[\s\S]{0,2000}else if \(chat\.shouldConceptArt\(opt\.text, full\)\)/.test(SERVERJS),
    '两档互斥：几何优先，几何不命中才走 AI 插画');

  // ============================================================
  // 六、版式与新建项目（静态守回归）
  // ============================================================
  ok(/\.stream-in\s*\{\s*max-width:\s*none;\s*margin:\s*0;\s*\}/.test(CSS),
    '对话列通栏（不再是 840px 居中 —— 宽屏上两边各空一大块）');
  ok(!/\.stream-in\s*\{[^}]*max-width:\s*840px/.test(CSS), '840px 居中已被撤掉');
  ok(/\.stream\s*\{[^}]*padding:\s*26px 32px 14px/.test(CSS), '通栏后左右各留 32px 安全区');
  ok(/\.msg\.user\s*\{[^}]*flex-direction:\s*row-reverse/.test(CSS), '用户消息靠右（头像在最右）');
  ok(/\.msg-att-illu\.art-ai\s*\{\s*max-width:\s*760px/.test(CSS), 'AI 插画容器放大到 760px');
  ok(/\.msg-att-img img\s*\{[^}]*max-width:\s*520px/.test(CSS), '消息图片跟着版式放大到 520px');

  ok(/closeModal\(\);[\s\S]{0,600}await loadSide\(\);/.test(APPJS),
    '新建项目后立刻刷左栏（原来只刷了「项目」视图，左栏要手刷才见）');
  ok(APPJS.indexOf('projectModal(null, { select: true })') >= 0,
    '从顶部下拉新建项目 → 建完自动归入，不用再选一次');

  // ============================================================
  // ★ 摘要行的格式必须与 _run-tests.cjs 的解析正则一致（"通过 N 项，失败 M 项"），
  //   否则全量回归里这一套会被统计成 0 项 —— 看着"通过"，其实根本没被算进去。
  console.log('\n批次11（AI 场景插画 + 通栏版式）：');
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  if (fail) { console.log('\n失败清单：'); fails.forEach(f => console.log('  ✗ ' + f)); }
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });

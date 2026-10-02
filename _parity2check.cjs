'use strict';
/**
 * 批次2 自检（模块级）：Chat 富功能层。
 *
 * 覆盖：数据层迁移、消息状态机与软删除、对话级设置、
 *       TTS / 翻译 / 联网搜索 / 配图任务 / 上传 / 临时资料 / 智能体 / 分享。
 *
 * 外部通道全部**现场起一个假上游**来验：不配通道时走降级分支，
 * 配上通道时走真实 fetch 分支 —— 两条路都得测，只测降级等于没测"接上了没"。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hl-p2-'));
process.env.DATA_DIR = TMP;
process.env.NO_DOTENV = '1';
delete process.env.LLM_API_KEY;
delete process.env.ADMIN_PASSWORD;
delete process.env.TTS_PROVIDER_URL;
delete process.env.WEB_SEARCH_URL;
delete process.env.IMAGE_PROVIDER_URL;

let pass = 0, fail = 0;
const fails = [];
function ok(cond, name, extra) {
  if (cond) { pass++; }
  else { fail++; fails.push(name + (extra !== undefined ? ' → ' + JSON.stringify(extra) : '')); }
}
async function rejects(fn, code, name) {
  try { await fn(); fail++; fails.push(name + ' → 期望抛 ' + code + '，实际没抛'); }
  catch (e) { ok(e.code === code, name, { got: e.code, msg: e.message }); }
}

const D = require('./server/db');
const core = require('./server/core');
const kb = require('./server/kb');
const llm = require('./server/llm');
const chat = require('./server/chat');
const auth = require('./server/auth');
const skills = require('./server/skills');

(async () => {
  // ---------- 1. schema 与迁移 ----------
  const msgCols = D.all('PRAGMA table_info(messages)').map(c => c.name);
  ['status', 'meta_json', 'attachments_json', 'client_id', 'deleted', 'edited_at']
    .forEach(c => ok(msgCols.indexOf(c) >= 0, 'messages 迁移列：' + c));
  const convCols = D.all('PRAGMA table_info(conversations)').map(c => c.name);
  ['agent_id', 'web_search'].forEach(c => ok(convCols.indexOf(c) >= 0, 'conversations 迁移列：' + c));
  const idx = D.all("SELECT name FROM sqlite_master WHERE type='index'").map(r => r.name);
  ok(idx.indexOf('idx_msg_client') >= 0, 'client_id 建了索引（幂等键要查得快）');
  require('./server/db');
  ok(D.all('PRAGMA table_info(messages)').filter(c => c.name === 'status').length === 1, '迁移幂等（status 只有一列）');

  // ---------- 2. 消息状态机 ----------
  auth.ensureDefaultSpace();
  const sid = '0001';
  const conv = core.createConversation(sid, null, { title: '批次2 测试' });
  ok(!!conv.id, '建对话');

  const m1 = core.addMessage(sid, conv.id, { role: 'user', content: '三角形的面积怎么算？', clientId: 'cl_abc' });
  ok(m1.status === 'done', '用户消息默认 done');

  const m2 = core.addMessage(sid, conv.id, { role: 'assistant', content: '', model: 'default', status: 'streaming', meta: { sources: [{ docId: 'd1', filename: '讲义.pdf', chunk: 0 }] } });
  ok(m2.status === 'streaming', '助手占位消息是 streaming');

  const got = core.getMessage(sid, m2.id);
  ok(got.status === 'streaming', 'getMessage 返回 status');
  ok(got.meta && got.meta.sources && got.meta.sources[0].filename === '讲义.pdf', 'meta_json 往返正常');
  ok(got.deleted === false && got.isFavorite === false, '默认未删除、未收藏');

  core.appendMessageContent(sid, m2.id, '先说说你打算从哪里下手？');
  const mid = core.getMessage(sid, m2.id);
  ok(mid.content.indexOf('从哪里下手') >= 0, 'appendMessageContent 回写正文');
  ok(mid.status === 'streaming', 'appendMessageContent 不改状态（除非显式给）');

  core.appendMessageContent(sid, m2.id, '先说说你打算从哪里下手？底乘高除以二。', { status: 'done' });
  ok(core.getMessage(sid, m2.id).status === 'done', '收尾时状态转 done');

  ok(core.findByClientId(sid, conv.id, 'cl_abc').id === m1.id, 'clientId 幂等键能查到');
  ok(core.findByClientId(sid, conv.id, 'cl_nope') === null, '不存在的 clientId 返回 null');
  ok(core.lastAssistant(sid, conv.id).id === m2.id, 'lastAssistant 拿到最后一条助手消息');

  // 收藏 / 译文 / 编辑
  core.updateMessage(sid, m1.id, { isFavorite: true });
  ok(core.getMessage(sid, m1.id).isFavorite === true, '收藏置位');
  core.updateMessage(sid, m1.id, { translated: { zh2en: { text: 'How to compute area?', at: D.now() } } });
  ok(core.getMessage(sid, m1.id).translated.zh2en.text === 'How to compute area?', '译文持久化');
  core.updateMessage(sid, m1.id, { content: '三角形的面积怎么算？急' });
  ok(core.getMessage(sid, m1.id).editedAt > 0, '改正文会写 edited_at');
  core.updateMessage(sid, m1.id, { translated: null });
  ok(core.getMessage(sid, m1.id).translated === null, '译文可清空');

  // 附件
  core.updateMessage(sid, m1.id, { attachments: [{ id: 'att_x', name: 'a.png', kind: 'image', size: 10, mime: 'image/png' }] });
  ok(core.getMessage(sid, m1.id).attachments.length === 1, '附件清单持久化');

  // 软删除：不进列表、不进上下文
  const m3 = core.addMessage(sid, conv.id, { role: 'assistant', content: '这段不该再发给模型' });
  ok(core.deleteMessage(sid, m3.id) === true, '软删除返回 true');
  ok(core.listMessages(sid, conv.id).some(x => x.id === m3.id) === false, '软删除后不在列表里');
  ok(core.listMessages(sid, conv.id, { includeDeleted: true }).some(x => x.id === m3.id) === true, '带 includeDeleted 能看到');
  ok(core.buildContext(sid, conv.id, 50).messages.some(x => /不该再发给模型/.test(x.content)) === false, '软删除不进模型上下文');
  ok(core.deleteMessage(sid, 'm_不存在') === false, '删不存在的消息返回 false');

  // ---------- 3. 对话级设置 ----------
  const c2 = core.createConversation(sid, null, { title: '带设置', agentId: 'math-algebra', webSearch: true });
  ok(c2.agentId === 'math-algebra' && c2.webSearch === true, '建对话时带智能体与联网开关');
  const c2b = core.updateConversation(sid, c2.id, { agentId: '', webSearch: false, title: '改名了' });
  ok(c2b.agentId === '' && c2b.webSearch === false && c2b.title === '改名了', '对话设置可改回');
  const c2c = core.updateConversation(sid, c2.id, { isFavorite: true });
  ok(c2c.isFavorite === true, '对话可收藏');
  ok(core.listConversations(sid, { favorite: true }).some(x => x.id === c2.id), '收藏筛选生效');
  ok(core.listConversations(sid, { q: '改名' }).some(x => x.id === c2.id), '标题搜索生效');
  ok(core.listConversations(sid, { q: 'zzz不存在' }).length === 0, '搜不到就是空');
  ok(core.listConversations(sid).every(x => x.messageCount >= 0), 'messageCount 不为负');

  // ---------- 4. 临时资料隔离 ----------
  const docA = kb.addDocument(sid, null, { filename: 'A对话的卷子.txt', text: '第一题 计算 1+1 等于几', conversationId: conv.id, scope: 'temp' });
  const docB = kb.addDocument(sid, null, { filename: '正式库的资料.txt', text: '第一题 计算 1+1 等于几' });
  ok(docA.scope === 'temp' && docA.conversationId === conv.id, '临时资料带 scope 与 conversationId');
  ok(docB.scope === 'kb', '默认上传进正式库');
  ok(kb.listDocuments(sid).every(d => d.id !== docA.id), '临时资料不出现在正式库列表');
  ok(kb.listDocuments(sid).some(d => d.id === docB.id), '正式资料在正式库列表');
  ok(kb.listDocuments(sid, { scope: 'temp', conversationId: conv.id }).some(d => d.id === docA.id), '按对话查临时资料');
  ok(kb.listDocuments(sid, { scope: 'temp', conversationId: c2.id }).length === 0, '别的对话查不到');

  const hitSame = kb.retrieve(sid, '第一题 计算', { conversationId: conv.id });
  ok(hitSame.some(h => h.docId === docA.id), '本对话检索能看到自己的临时资料');
  const hitOther = kb.retrieve(sid, '第一题 计算', { conversationId: c2.id });
  ok(hitOther.every(h => h.docId !== docA.id), '别的对话检索看不到临时资料');
  const hitNone = kb.retrieve(sid, '第一题 计算', {});
  ok(hitNone.every(h => h.docId !== docA.id), '不指定对话时也看不到临时资料');

  const st = chat.tempDocStatus(sid, [docA.id, 'kb_不存在']);
  ok(st[docA.id].status === 'ready' && st[docA.id].filename === 'A对话的卷子.txt', '批量解析状态');
  ok(st['kb_不存在'].status === 'missing', '未知文档返回 missing');
  await rejects(async () => chat.removeTempDoc(sid, docB.id), 'NOT_TEMP', '正式资料不能当临时资料删');

  // ---------- 5. TTS ----------
  ok(chat.TTS_MAX_CHARS === 5000, '朗读上限 5000 字');
  ok(chat.clampRate(9) === 2 && chat.clampRate(0.1) === 0.5 && chat.clampRate('x') === 1, '语速夹在 0.5–2 之间');

  const t1 = await chat.speak(sid, null, { text: '你好' });
  ok(t1.mode === 'browser' && t1.text === '你好', '未配通道时走浏览器合成');
  ok(/浏览器/.test(t1.note), '如实说明走的是本地合成');
  await rejects(() => chat.speak(sid, null, { text: 'x'.repeat(5001) }), 'TOO_LONG', '超长拒绝朗读');

  // 空间级偏好（空间口令登录没有 userId，也必须能存）
  const sp1 = chat.setTtsPref(sid, null, { rate: 1.6 });
  ok(sp1.rate === 1.6, '空间级语速可写');
  ok(chat.getTtsPref(sid, null).rate === 1.6, '空间级语速可读');
  chat.setTtsPref(sid, null, { rate: 9 });
  ok(chat.getTtsPref(sid, null).rate === 2, '写入时夹紧');
  // 用户级与空间级互不串
  const uu = D.uid('u_');
  D.run('INSERT INTO users(id,space_id,username,created_at) VALUES(?,?,?,?)', uu, sid, 'ttsu_' + uu.slice(-6), D.now());
  chat.setTtsPref(sid, uu, { rate: 0.8 });
  ok(chat.getTtsPref(sid, uu).rate === 0.8, '用户级语速独立存');
  ok(chat.getTtsPref(sid, null).rate === 2, '用户级不影响空间级');

  // ---------- 6. 翻译 ----------
  ok(chat.detectDirection('这是一段中文') === 'zh2en', '自动识别中→英');
  ok(chat.detectDirection('this is english') === 'en2zh', '自动识别英→中');
  const tr1 = await chat.translateMessage(sid, m2.id, 'zh2en');
  ok(tr1.direction === 'zh2en' && tr1.label === '中→英', '翻译方向与标签');
  ok(typeof tr1.text === 'string' && tr1.text.length > 0, '翻译有内容（离线模式也有占位）');
  ok(core.getMessage(sid, m2.id).translated.zh2en.text === tr1.text, '译文写回消息');
  const tr2 = await chat.translateMessage(sid, m2.id, 'zh2en');
  ok(tr2.cached === true && tr2.text === tr1.text, '第二次命中缓存（消息级）');
  const tr3 = await chat.translateMessage(sid, m2.id, 'zh2en', { force: true });
  ok(tr3.cached === true, 'force 会绕过消息级缓存但仍走翻译缓存表');
  await rejects(() => chat.translateMessage(sid, 'm_没有', 'zh2en'), 'NOT_FOUND', '翻译不存在的消息');

  // ---------- 7. 联网搜索 ----------
  // ★ 2026-10-02 改了语义：以前 `enabled` 等价于"配了 WEB_SEARCH_URL"，
  //   没配就直接不可用 —— 用户看到的是"联网功能测试无效"。现在内置通道默认开着，
  //   环境变量只是"想换更好的源"。**不变的那条硬规矩**是：失败必须如实告知。
  const s1 = await chat.webSearch('中考数学');
  ok(s1.ok === true || (s1.ok === false && s1.message === '联网搜索暂时不可用，本条回答未联网'),
    '联网失败必须如实告知（不许静默降级成"看起来像搜过"）', JSON.stringify({ ok: s1.ok, reason: s1.reason }));
  ok(s1.ok === true || s1.reason !== 'UNAVAILABLE', '不会再因为"没配环境变量"就直接判不可用', s1.reason);
  const s1b = await chat.webSearch('中考数学', { limit: 3 });
  ok(!s1b.ok || s1b.results.length <= 3, 'limit 真的生效');

  // 反证：只有**显式关掉**内置通道才是 DISABLED
  const saveBuiltin = process.env.WEB_SEARCH_BUILTIN;
  process.env.WEB_SEARCH_BUILTIN = 'off';
  const s1c = await chat.webSearch('中考数学');
  ok(s1c.ok === false && s1c.reason === 'DISABLED', '显式关闭后如实返回不可用');
  ok(s1c.message === '联网搜索暂时不可用，本条回答未联网', '降级文案与对方一致');
  if (saveBuiltin === undefined) delete process.env.WEB_SEARCH_BUILTIN;
  else process.env.WEB_SEARCH_BUILTIN = saveBuiltin;

  const s2 = await chat.webSearch('');
  ok(s2.ok === false && s2.reason === 'EMPTY', '空查询直接拒绝');
  ok(chat.searchContext([{ title: 'T', url: 'u', snippet: 's' }]).indexOf('[网页1]') === 0, '搜索结果拼上下文');
  ok(chat.searchContext([]) === '' && chat.searchContext(null) === '', '没有结果时上下文是空的');

  // ---------- 8. 假上游：搜索 / TTS / 配图 ----------
  const upstream = http.createServer(async (req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    await new Promise(r => req.on('end', r));
    const j = (() => { try { return JSON.parse(body); } catch (e) { return {}; } })();
    if (req.url === '/search') {
      if (j.query === '空结果') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ results: [] })); }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ results: [{ title: '中考数学大纲', url: 'https://example.com/a', snippet: '数与式' }] }));
    }
    if (req.url === '/tts') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ audio: Buffer.from('fake-audio').toString('base64'), mime: 'audio/mpeg' }));
    }
    if (req.url === '/tts-broken') { res.writeHead(500); return res.end('boom'); }
    if (req.url === '/img') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ data: [{ b64_json: Buffer.from('fake-png').toString('base64') }] }));
    }
    res.writeHead(404); res.end('{}');
  });
  await new Promise(r => upstream.listen(0, '127.0.0.1', r));
  const UP = 'http://127.0.0.1:' + upstream.address().port;

  process.env.WEB_SEARCH_URL = UP + '/search';
  const s3 = await chat.webSearch('中考数学');
  ok(s3.ok === true && s3.results.length === 1, '接上搜索通道后能拿到结果', s3);
  ok(s3.results[0].title === '中考数学大纲', '搜索结果字段归一');
  const s4 = await chat.webSearch('空结果');
  ok(s4.ok === true && s4.results.length === 0 && s4.message === '没有搜到相关网页', '搜到空结果有明确文案');

  process.env.TTS_PROVIDER_URL = UP + '/tts';
  const t2 = await chat.speak(sid, null, { text: '你好' });
  ok(t2.mode === 'audio' && t2.audio.length > 0, '接上 TTS 通道后返回音频');
  process.env.TTS_PROVIDER_URL = UP + '/tts-broken';
  const t3 = await chat.speak(sid, null, { text: '你好' });
  ok(t3.mode === 'browser' && t3.degraded === true, 'TTS 上游挂了自动退回浏览器合成');
  ok(/暂时不可用/.test(t3.note), '降级时说明原因');
  process.env.TTS_PROVIDER_URL = '';

  // ---------- 9. 配图任务 ----------
  const jobUnknown = (() => { try { chat.createJob(sid, null, '不存在类型', {}); return null; } catch (e) { return e.code; } })();
  ok(jobUnknown === 'BAD_KIND', '未知任务类型被拒');

  // 离线模式：必须**直说**是离线，不能让学生以为是自己画错了
  const jMock = chat.createJob(sid, null, 'image', { prompt: '一个直角三角形', conversationId: conv.id });
  await chat.tick();
  await new Promise(r => setTimeout(r, 120));
  const jMock2 = chat.getJob(sid, jMock.id);
  ok(jMock2.status === 'failed' && /离线演示模式/.test(jMock2.error), '离线模式配图给出诚实失败原因', jMock2);

  // 假模型：走 SVG 插画分支
  // 注意：generateIllustration 会先看 llm.isMock() 拦一道（离线时直说"没配模型 Key"），
  // 这里把 isMock 临时改成 false，才能测到"有模型时"的真实分支。
  const realCompleteJSON = llm.completeJSON;
  const realIsMock = llm.isMock;
  llm.isMock = () => false;
  llm.completeJSON = async () => ({
    kind: 'illustration', title: '直角三角形',
    palette: ['#2563EB'],
    elements: [
      { type: 'rect', x: 0, y: 0, w: 800, h: 520, fill: '#EEF2FF' },
      { type: 'polygon', points: [[100, 400], [500, 400], [100, 100]], fill: '#2563EB' },
      { type: 'text', x: 300, y: 460, text: '直角', size: 24 },
      { type: 'script', x: 1, y: 1, text: 'x' },            // 白名单外，应被丢掉
      { type: 'rect', x: 1, y: 1, w: 1, h: 1, fill: 'javascript:alert(1)' },  // 颜色非法，应被换掉
    ],
  });
  const jSvg = chat.createJob(sid, null, 'image', { prompt: '一个直角三角形', conversationId: conv.id, messageId: m2.id });
  await chat.tick();
  await new Promise(r => setTimeout(r, 150));
  const jSvg2 = chat.getJob(sid, jSvg.id);
  ok(jSvg2.status === 'done', '有模型时配图任务完成', jSvg2.error);
  ok(jSvg2.result.mode === 'svg' && jSvg2.result.elements.length === 4, '白名单外的元素被丢掉（script 那条没了，非法颜色那条留下但被换色）', jSvg2.result && jSvg2.result.elements && jSvg2.result.elements.length);
  ok(jSvg2.result.elements.every(e => e.type !== 'script'), 'script 元素不会进结果');
  ok(jSvg2.result.elements.every(e => !/javascript:/.test(String(e.fill || ''))), 'javascript: 伪协议不会进结果');
  ok(jSvg2.result.elements.every(e => Object.keys(e).every(k => (chat.ILLU_FIELDS[e.type] || []).indexOf(k) >= 0)), '每条元素只保留白名单字段');

  llm.completeJSON = async () => ({ kind: 'illustration', elements: [] });
  await rejects(() => chat.generateIllustration('x'), undefined, '空元素直接抛错（code 未定义也算抛）').catch(() => {});
  let illErr = null;
  try { await chat.generateIllustration('x'); } catch (e) { illErr = e; }
  ok(illErr && /校验未通过/.test(illErr.message), '内容校验不通过时有明确文案');

  llm.completeJSON = async () => null;
  let illErr2 = null;
  try { await chat.generateIllustration('x'); } catch (e) { illErr2 = e; }
  ok(illErr2 && /校验未通过/.test(illErr2.message), '模型返回 null 也算校验不通过');

  // 元素过多要截断
  llm.completeJSON = async () => ({ kind: 'illustration', elements: new Array(200).fill({ type: 'circle', cx: 1, cy: 1, r: 1 }) });
  const many = await chat.generateIllustration('x');
  ok(many.elements.length === 80, '元素数量截断到 80', many.elements.length);
  llm.completeJSON = realCompleteJSON;
  llm.isMock = realIsMock;

  // 假图像服务：走位图分支
  process.env.IMAGE_PROVIDER_URL = UP + '/img';
  const jRas = chat.createJob(sid, null, 'image', { prompt: '一个直角三角形' });
  await chat.tick();
  await new Promise(r => setTimeout(r, 150));
  const jRas2 = chat.getJob(sid, jRas.id);
  ok(jRas2.status === 'done' && jRas2.result.mode === 'raster' && !!jRas2.result.data, '接上图像服务后返回位图', jRas2.error);
  process.env.IMAGE_PROVIDER_URL = '';
  ok(chat.imageConfig().enabled === false, '撤掉配置后回到 SVG 分支');

  // 僵死任务：心跳停了两倍周期就该被判失败
  const jStale = chat.createJob(sid, null, 'image', { prompt: 'x' });
  D.run("UPDATE jobs SET status = 'running', heartbeat_at = ? WHERE id = ?", D.now() - chat.JOB_STALE_MS - 1000, jStale.id);
  chat.sweepStale();
  const jStale2 = chat.getJob(sid, jStale.id);
  ok(jStale2.status === 'failed' && /中断/.test(jStale2.error), '僵死任务被扫成失败');
  ok(chat.JOB_HEARTBEAT_MS === 35000, '心跳周期 35 秒（与对方一致）');

  ok(chat.listJobs(sid, { kind: 'image' }).length >= 3, '任务列表按类型过滤');
  ok(chat.listJobs(sid, { conversationId: conv.id }).length >= 1, '任务列表按对话过滤');

  // ---------- 10. 上传 ----------
  const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const img = chat.saveImage(sid, { filename: '照片.PNG', dataBase64: PNG });
  ok(img.kind === 'image' && img.mime === 'image/png', 'PNG 上传成功（扩展名大小写不敏感）');
  ok(fs.existsSync(img.path), '图片真的落盘了');
  const rd = chat.readAttachment(sid, img.id);
  ok(rd && rd.mime === 'image/png', '能按 id 读回附件');
  ok(chat.readAttachment(sid, 'att_../../etc/passwd') === null, '附件 id 有格式护栏，挡路径穿越');
  ok(chat.readAttachment(sid, 'att_0000000000000000') === null, '不存在的附件返回 null');
  ok(chat.readAttachment('9999', img.id) === null, '跨空间读不到别人的附件');
  ok(chat.IMAGE_MAX_BYTES === 10 * 1024 * 1024, '图片上限 10MB');

  let e1 = null; try { chat.saveImage(sid, { filename: 'a.txt', dataBase64: PNG }); } catch (e) { e1 = e; }
  ok(e1 && e1.code === 'BAD_TYPE' && e1.skipped === true, '非图片被跳过并标记 skipped');
  ok(/PNG, JPG, GIF/.test(e1.message), '跳过时说明支持哪些格式');

  let e2 = null;
  try { chat.saveImage(sid, { filename: 'big.png', dataBase64: Buffer.alloc(11 * 1024 * 1024).toString('base64') }); } catch (e) { e2 = e; }
  ok(e2 && e2.code === 'TOO_BIG' && /超过 10MB/.test(e2.message), '超 10MB 的图片被跳过并说明');

  let e3 = null; try { chat.saveImage(sid, { filename: 'a.png', dataBase64: '' }); } catch (e) { e3 = e; }
  ok(e3 && e3.code === 'BAD_INPUT', '空内容被拒');

  // 文档上传（走知识库）
  const d1 = chat.saveDocument(sid, null, { filename: '对话内资料.txt', text: '勾股定理 a²+b²=c²', conversationId: conv.id });
  ok(d1.scope === 'temp' && d1.conversationId === conv.id, '对话内上传自动成为临时资料');
  const d2 = chat.saveDocument(sid, null, { filename: '正式资料.txt', text: 'x' });
  ok(d2.scope === 'kb' && d2.conversationId === null, '不带对话时进正式库');

  // ---------- 11. 智能体 ----------
  skills.seed();
  const ag = chat.listAgents(sid, {});
  ok(ag.total === 57, '智能体总数 = 57 个技能', ag.total);
  ok(ag.agents.length === 57, '默认返回全部智能体');
  ok(ag.agents.every(a => a.name && a.description), '每个智能体都有名称与说明');
  const ag2 = chat.listAgents(sid, { q: '数学' });
  ok(ag2.agents.length > 0 && ag2.agents.length < 57, '关键词能收窄结果', ag2.agents.length);
  ok(chat.listAgents(sid, { q: '绝不可能存在的关键词xyz' }).agents.length === 0, '搜不到就是空');

  // ---------- 12. 模型 ----------
  const models = chat.listModels();
  ok(models.length >= 2 && models.every(m => m.tag && m.desc !== undefined), '模型带分类标签与说明');
  ok(models.some(m => m.id === 'default') && models.some(m => m.id === 'deep'), '两个基础模型都在');

  // ---------- 13. 分享管理 ----------
  const sh = core.createShare(sid, 'conversation', conv.id);
  const shl = chat.listShares(sid, 'conversation');
  const mine = shl.filter(x => x.token === sh.token)[0];
  ok(mine && mine.title === '批次2 测试' && mine.active === true, '分享列表带标题与状态');
  ok(mine.views === 0, '初始访问次数为 0');
  core.getShare(sh.token);
  ok(chat.listShares(sid, 'conversation').filter(x => x.token === sh.token)[0].views === 1, '访问后次数 +1');
  core.cancelShare(sid, 'conversation', conv.id);
  ok(chat.listShares(sid, 'conversation').filter(x => x.token === sh.token)[0].active === false, '取消后 active=false');

  // ---------- 14. 收藏聚合 ----------
  const favs = chat.listFavorites(sid);
  ok(favs.some(f => f.id === m1.id && f.conversationTitle === '批次2 测试'), '收藏列表带所属对话标题');
  ok(chat.toggleFavorite(sid, m1.id).isFavorite === false, '切换收藏 → 取消');
  ok(chat.toggleFavorite(sid, m1.id).isFavorite === true, '切换收藏 → 恢复');
  await rejects(async () => chat.toggleFavorite(sid, 'm_没有'), 'NOT_FOUND', '收藏不存在的消息');

  // ---------- 15. 删对话的级联清理 ----------
  const c3 = core.createConversation(sid, null, { title: '待删对话' });
  const a1 = chat.saveImage(sid, { filename: '待删.png', dataBase64: PNG });
  const msg = core.addMessage(sid, c3.id, { role: 'user', content: 'x', attachments: [a1] });
  const td = kb.addDocument(sid, null, { filename: '待删临时.txt', text: 'x', conversationId: c3.id, scope: 'temp' });
  chat.createJob(sid, null, 'image', { prompt: 'x', conversationId: c3.id });
  core.createShare(sid, 'conversation', c3.id);
  ok(fs.existsSync(a1.path), '清理前附件文件在');
  const n = chat.cleanupConversationFiles(sid, c3.id);
  ok(n === 1, 'cleanupConversationFiles 删掉 1 个附件文件', n);
  ok(!fs.existsSync(a1.path), '附件文件真的被删了');
  core.deleteConversation(sid, c3.id);
  ok(D.get('SELECT 1 FROM kb_documents WHERE id = ?', td.id) === undefined, '临时资料随对话删除');
  ok(D.get('SELECT 1 FROM jobs WHERE conversation_id = ?', c3.id) === undefined, '任务随对话删除');
  ok(D.get('SELECT 1 FROM messages WHERE conversation_id = ?', c3.id) === undefined, '消息随对话删除');
  ok(D.get('SELECT 1 FROM shares WHERE target_id = ?', c3.id) === undefined, '分享随对话删除');
  ok(D.get('SELECT 1 FROM kb_documents WHERE id = ?', d2.id) !== undefined, '正式库资料**不**受影响');
  ok(D.get('SELECT 1 FROM messages WHERE id = ?', msg.id) === undefined, '消息确实没了');

  // ---------- 16. 迁移兜底：老库升级 ----------
  // 造一个"只有旧列"的 messages 表，确认 migrate 能补列而不是报错。
  // ★ 用 in-process 重载而不是 spawn 子进程：这个环境里 spawnSync 会 EBUSY。
  const legacy = fs.mkdtempSync(path.join(os.tmpdir(), 'hl-p2legacy-'));
  {
    const { DatabaseSync } = require('node:sqlite');
    const ldb = new DatabaseSync(path.join(legacy, 'app.db'));
    ldb.exec('CREATE TABLE messages (id TEXT PRIMARY KEY, conversation_id TEXT, seq INTEGER, role TEXT, content TEXT, created_at INTEGER)');
    ldb.exec("INSERT INTO messages(id,conversation_id,seq,role,content,created_at) VALUES('m_old','c_old',0,'user','老消息',1)");
    ldb.close();
  }
  const savedDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = legacy;
  const dbPath = require.resolve('./server/db');
  delete require.cache[dbPath];
  const D2 = require('./server/db');
  const legacyRow = D2.get('SELECT * FROM messages WHERE id = ?', 'm_old');
  ok(legacyRow && legacyRow.status === 'done' && legacyRow.deleted === 0, '老库升级后新列拿到默认值',
    legacyRow ? { status: legacyRow.status, deleted: legacyRow.deleted } : null);
  ok(legacyRow && legacyRow.content === '老消息', '老库升级不丢数据');
  delete require.cache[dbPath];
  process.env.DATA_DIR = savedDataDir;
  try { fs.rmSync(legacy, { recursive: true, force: true }); } catch (e) {}

  chat.stopWorker();
  upstream.close();

  // ---------- 输出 ----------
  console.log('');
  if (fails.length) {
    fails.slice(0, 40).forEach(f => console.log('  ✗ ' + f));
    if (fails.length > 40) console.log('  …还有 ' + (fails.length - 40) + ' 项');
  }
  console.log('PASS  通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
  process.exit(fail ? 1 : 0);
})().catch(e => {
  console.error('批次2 自检自身异常：', e);
  process.exit(2);
});

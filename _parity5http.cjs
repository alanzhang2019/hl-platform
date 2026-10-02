'use strict';
/**
 * 批次5 · HTTP 端到端自检：AI 自动配图 + 项目↔对话关联。
 *
 * 自带两样东西：
 *   1. hl 服务（随机端口 + 临时 DATA_DIR），LLM_API_KEY/LLM_BASE_URL 指向本文件起的假模型服务；
 *   2. 假模型服务：OpenAI 兼容 /v1/chat/completions —— stream:true 回 SSE 讲解文本，
 *      stream:false 回 svg-json 插画。这样自动配图的**真实链路**（流式收尾 → shouldIllustrate
 *      → generateIllustration → 落 attachments → SSE attachment 事件）能被完整跑到。
 *
 * 覆盖：配图命中（SSE 事件 + 落库）、不命中反证、坏模型优雅跳过、
 *      项目建对话/过滤/移动/计数、跨项目反证。
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const http = require('http');

const NODE = process.execPath;
const PORT = 4100 + Math.floor(Math.random() * 300);
const FAKE_PORT = 4700 + Math.floor(Math.random() * 200);
const BASE = 'http://127.0.0.1:' + PORT;
const DATA_DIR = path.join(os.tmpdir(), 'hl-p5http-' + crypto.randomBytes(4).toString('hex'));

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, extra) {
  if (cond) { pass++; }
  else { fail++; failures.push(name + (extra !== undefined ? ' → ' + JSON.stringify(extra) : '')); }
}
function group(t) { console.log('\n' + t); }
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- 假模型服务 ----------
// artOk=false 时故意返回空 elements 的 svg-json，验证"画坏了不影响主回答"；
// streamN 计数器让第 2 条流式回复换成语文赏析（不命中配图启发式），做反证组。
let artOk = true;
let streamN = 0;
const REPLY_GOOD = '这道题我们用几何来分析：先看下图，三角形有三个内角。';
const REPLY_NONE = '这是一首诗的赏析：作者借景抒情，表达思乡之情。';

const GOOD_ART = {
  kind: 'illustration', title: '三角形示意', palette: ['#2563EB', '#F59E0B'],
  elements: [
    { type: 'polygon', points: [[400, 120], [250, 400], [550, 400]], fill: '#EEF2FF' },
    { type: 'text', x: 400, y: 430, text: '内角和 180°', size: 22, fill: '#0F172A' },
  ],
};

function fakeLLM() {
  return new Promise(resolve => {
    const srv = http.createServer((req, res) => {
      let buf = '';
      req.on('data', d => { buf += d; });
      req.on('end', () => {
        let body = {};
        try { body = JSON.parse(buf || '{}'); } catch (e) {}
        if (body.stream) {
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
          streamN++;
          const text = streamN === 2 ? REPLY_NONE : REPLY_GOOD;
          const chunks = text.match(/.{1,12}/g) || [''];
          let i = 0;
          const tick = setInterval(() => {
            if (i < chunks.length) {
              res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: chunks[i++] } }] }) + '\n\n');
            } else {
              res.write('data: [DONE]\n\n');
              clearInterval(tick);
              res.end();
            }
          }, 4);
          // 注意：要挂在 res 上 —— req 的 'close' 在请求体读完就触发，会把定时器提前清掉
          res.on('close', () => clearInterval(tick));
          return;
        }
        // completeJSON（插画）分支
        const art = artOk ? GOOD_ART : { kind: 'illustration', title: '坏图', elements: [] };
        const content = '```svg-json\n' + JSON.stringify(art) + '\n```';
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content } }] }));
      });
    });
    srv.listen(FAKE_PORT, '127.0.0.1', () => resolve(srv));
  });
}

// ---------- hl 服务 ----------
async function req(method, p, body, token) {
  const h = { 'Content-Type': 'application/json' };
  if (token) h.Authorization = 'Bearer ' + token;
  const r = await fetch(BASE + p, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  let j = null;
  try { j = await r.json(); } catch (e) { j = null; }
  return { status: r.status, body: j };
}
const GET = (p, t) => req('GET', p, undefined, t);
const POST = (p, b, t) => req('POST', p, b, t);
const PATCH = (p, b, t) => req('PATCH', p, b, t);

function startServer() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const child = spawn(NODE, ['server.js'], {
    cwd: __dirname,
    env: Object.assign({}, process.env, {
      PORT: String(PORT), DATA_DIR,
      LLM_API_KEY: 'test-key', LLM_BASE_URL: 'http://127.0.0.1:' + FAKE_PORT + '/v1',
      NO_DOTENV: '1',
      TTS_PROVIDER_URL: '', WEB_SEARCH_URL: '', IMAGE_PROVIDER_URL: '', SMS_PROVIDER_URL: '',
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', d => process.env.VERBOSE && process.stdout.write('[srv] ' + d));
  child.stderr.on('data', d => process.stderr.write('[srv:err] ' + d));
  return child;
}
async function waitReady(ms) {
  const until = Date.now() + (ms || 15000);
  while (Date.now() < until) {
    try { const r = await fetch(BASE + '/api/health'); if (r.ok) return await r.json(); } catch (e) {}
    await new Promise(r => setTimeout(r, 150));
  }
  throw new Error('服务在超时前没有就绪');
}
function stopServer(child) {
  return new Promise(res => {
    if (!child || child.killed) return res();
    child.on('exit', () => res());
    try { child.kill(); } catch (e) { res(); }
    setTimeout(() => { try { child.kill('SIGKILL'); } catch (e) {} res(); }, 3000);
  });
}

/** 走一次 SSE 流式对话，收集 meta / attachment / done */
async function sendMsg(token, payload) {
  const ctl = new AbortController();
  const res = await fetch(BASE + '/api/chat/stream', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify(payload), signal: ctl.signal,
  });
  if (!res.ok) return { status: res.status, meta: null, atts: [], done: null };
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '', meta = null, done = null;
  const atts = [];
  try {
    while (true) {
      const rd = await reader.read();
      if (rd.done) break;
      buf += dec.decode(rd.value, { stream: true });
      const parts = buf.split('\n\n'); buf = parts.pop();
      for (const part of parts) {
        let ev = '', data = '';
        part.split('\n').forEach(l => {
          if (l.indexOf('event:') === 0) ev = l.slice(6).trim();
          else if (l.indexOf('data:') === 0) data += l.slice(5).trim();
        });
        if (!data) continue;
        let j = null; try { j = JSON.parse(data); } catch (e) { continue; }
        if (ev === 'meta') meta = j;
        else if (ev === 'attachment') atts.push(j);
        else if (ev === 'done') done = j;
      }
    }
  } catch (e) {}
  return { status: 200, meta, atts, done };
}

(async () => {
  const fake = await fakeLLM();
  const child = startServer();
  try {
    const health = await waitReady();
    group('A. 健康检查与版本');
    // ★ 日期不写死：跨天 bump 一次就让 5 个套件同时红，纯属噪声。
    ok('版本是 parity 构建（形如 YYYY-MM-DD-parityN）', /^\d{4}-\d{2}-\d{2}-parity\d+/.test(String(health.version)), health.version);

    group('B. 建空间');
    const sp = await POST('/api/space', { name: '批次5孩子', password: '' });
    ok('建空间成功', sp.status === 200 && !!sp.body.token, JSON.stringify(sp.body).slice(0, 100));
    const T = sp.body.token;

    group('C. 自动配图：命中（几何题 → 后台画图 + 落库）');
    artOk = true;
    const cv = await POST('/api/conversations', { title: '配图对话' }, T);
    const CID = cv.body.conversation.id;
    const sm = await sendMsg(T, { text: '这道几何题怎么证？', conversationId: CID, mode: 'selfstudy' });
    ok('流式回复完成（done 事件）', sm.done && sm.done.status === 'done', sm.done);
    // 配图已改为后台异步，SSE 里不再推 attachment 事件，改走轮询
    await new Promise(r => setTimeout(r, 600));
    const im = await GET('/api/messages/' + sm.done.messageId, T);
    const atts = im.body.message && im.body.message.attachments;
    ok('落库后消息带 1 个 illustration 附件', Array.isArray(atts) && atts.length === 1 && atts[0].kind === 'illustration', atts);
    ok('落库附件里就是 svg-json（elements 未被二次序列化）', atts && atts[0].elements && atts[0].elements[0].type === 'polygon', atts && atts[0]);
    const att0 = atts && atts[0];
    ok('attachment 带 title/elements', att0 && att0.title === '三角形示意' && Array.isArray(att0.elements) && att0.elements.length === 2,
      att0 && { title: att0.title, n: att0.elements && att0.elements.length });

    group('D. 自动配图：不命中（语文赏析 → 无附件）');
    const sm2 = await sendMsg(T, { text: '帮我赏析这首诗', conversationId: CID, mode: 'selfstudy' });
    ok('回复照常完成', sm2.done && sm2.done.status === 'done', sm2.done);
    await new Promise(r => setTimeout(r, 400));
    const im2 = await GET('/api/messages/' + sm2.done.messageId, T);
    ok('消息 attachments 为空', !(im2.body.message && im2.body.message.attachments), im2.body.message && im2.body.message.attachments);

    group('E. 自动配图：模型画坏了 → 优雅跳过，主回答不受影响');
    artOk = false;
    const sm3 = await sendMsg(T, { text: '再讲一道几何题', conversationId: CID, mode: 'selfstudy' });
    ok('主回答照常 done', sm3.done && sm3.done.status === 'done', sm3.done);
    await new Promise(r => setTimeout(r, 400));
    const im3 = await GET('/api/messages/' + sm3.done.messageId, T);
    ok('消息 attachments 为空', !(im3.body.message && im3.body.message.attachments), im3.body.message && im3.body.message.attachments);
    artOk = true;

    group('F. 项目 ↔ 对话关联');
    const p1 = await POST('/api/projects', { name: '这学期几何', instructions: '先问不先讲' }, T);
    ok('建项目成功', p1.status === 200 && !!p1.body.project && !!p1.body.project.id, JSON.stringify(p1.body).slice(0, 120));
    const P1 = p1.body.project.id;
    const p2 = await POST('/api/projects', { name: '英语积累' }, T);
    const P2 = p2.body.project.id;
    ok('项目 conversationCount 初始为 0', p1.body.project.conversationCount === 0, p1.body.project.conversationCount);

    // 在项目下建对话（对话卡要能标出项目名，前端 loadConvs 会顺带拉 /api/projects）
    const cv1 = await POST('/api/conversations', { title: '全等三角形', projectId: P1 }, T);
    ok('建对话时带上 projectId', cv1.status === 200 && cv1.body.conversation.projectId === P1, cv1.body.conversation);
    const C1 = cv1.body.conversation.id;
    const cv2 = await POST('/api/conversations', { title: '不在项目里', }, T);
    const C2 = cv2.body.conversation.id;
    ok('不带 projectId 建对话为 null', cv2.body.conversation.projectId === null, cv2.body.conversation.projectId);

    const list1 = await GET('/api/conversations?projectId=' + P1, T);
    ok('?projectId= 只列出该项目的对话', list1.body.conversations.length === 1 && list1.body.conversations[0].id === C1,
      list1.body.conversations.map(c => c.id));
    ok('列表项回带 projectId（对话卡标项目名靠它）', list1.body.conversations[0].projectId === P1);
    const list2 = await GET('/api/conversations?projectId=' + P2, T);
    ok('另一个项目下没有对话', list2.body.conversations.length === 0, list2.body.conversations.length);

    // 把 C2 移进 P1：conversationCount 变 1
    const mv = await PATCH('/api/conversations/' + C2, { projectId: P1 }, T);
    ok('PATCH 移动对话进项目', mv.status === 200 && mv.body.conversation.projectId === P1, mv.body.conversation);
    const proj = await GET('/api/projects', T);
    const g1 = proj.body.projects.find(p => p.id === P1);
    const g2 = proj.body.projects.find(p => p.id === P2);
    ok('项目计数：P1=2、P2=0', g1 && g1.conversationCount === 2 && g2 && g2.conversationCount === 0,
      g1 && g2 && { p1: g1.conversationCount, p2: g2.conversationCount });

    // 移出项目
    const mvOut = await PATCH('/api/conversations/' + C2, { projectId: null }, T);
    ok('PATCH projectId=null 移出项目', mvOut.status === 200 && mvOut.body.conversation.projectId === null, mvOut.body.conversation);
    const list1b = await GET('/api/conversations?projectId=' + P1, T);
    ok('移出后项目下只剩 1 条', list1b.body.conversations.length === 1 && list1b.body.conversations[0].id === C1, list1b.body.conversations.length);

    group('G. 未登录反证');
    ok('未登录拿不到消息（含配图附件）', (await GET('/api/messages/' + sm.done.messageId, null)).status === 401);
    ok('未登录列不出项目对话', (await GET('/api/conversations?projectId=' + P1, null)).status === 401);
  } finally {
    await stopServer(child);
    fake.close();
    try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch (e) {}
  }

  console.log('\n' + '─'.repeat(58));
  if (failures.length) failures.forEach(f => console.log('  ✗ ' + f));
  console.log('PASS  通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  process.exit(fail ? 1 : 0);
})().catch(e => {
  console.error('批次5 HTTP 自检自身异常：', e);
  try { fake && fake.close(); } catch (_) {}
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch (_) {}
  process.exit(2);
});

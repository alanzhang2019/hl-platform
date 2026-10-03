'use strict';
/**
 * 批次4 · HTTP 端到端自检：互动课堂。
 *
 * 自带服务 + 随机端口 + 临时 DATA_DIR（LLM_API_KEY='' → mock → generate 恒走 preset 兜底）。
 * 覆盖：未登录反证 401、异步生成 + 轮询拿到 DSL、消息附件回取、分享 + 公开页、
 * 取消分享后下架、直接提交 DSL、跨空间隔离。
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const NODE = process.execPath;
const PORT = 3800 + Math.floor(Math.random() * 300);
const BASE = 'http://127.0.0.1:' + PORT;
const DATA_DIR = path.join(os.tmpdir(), 'hl-p4http-' + crypto.randomBytes(4).toString('hex'));

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, extra) {
  if (cond) { pass++; }
  else { fail++; failures.push(name + (extra !== undefined ? ' → ' + JSON.stringify(extra) : '')); }
}
function group(t) { console.log('\n' + t); }

async function req(method, p, body, token, extraHeaders) {
  const h = { 'Content-Type': 'application/json' };
  if (token) h.Authorization = 'Bearer ' + token;
  Object.assign(h, extraHeaders || {});
  const r = await fetch(BASE + p, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  let j = null;
  try { j = await r.json(); } catch (e) { j = null; }
  return { status: r.status, body: j };
}
const GET = (p, t) => req('GET', p, undefined, t);
const POST = (p, b, t) => req('POST', p, b, t);
const DEL = (p, t) => req('DELETE', p, undefined, t);

function startServer() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const child = spawn(NODE, ['server.js'], {
    cwd: __dirname,
    env: Object.assign({}, process.env, {
      PORT: String(PORT), DATA_DIR,
      LLM_API_KEY: '', NO_DOTENV: '1',
      TTS_PROVIDER_URL: '', WEB_SEARCH_URL: '', IMAGE_PROVIDER_URL: '', SMS_PROVIDER_URL: '',
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', d => process.env.VERBOSE && process.stdout.write('[srv] ' + d));
  child.stderr.on('data', d => process.stderr.write('[srv:err] ' + d));
  return child;
}
async function waitReady(ms) {
  const until = Date.now() + (ms || 60000);
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
const sleep = ms => new Promise(r => setTimeout(r, ms));
/** 走一次 SSE 流式对话，拿到 meta（含用户消息 id）与回复。mock 模式下也能落库。 */
async function sendMsg(token, payload) {
  const ctl = new AbortController();
  const res = await fetch(BASE + '/api/chat/stream', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify(payload), signal: ctl.signal,
  });
  if (!res.ok) return { status: res.status, meta: null };
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '', meta = null;
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
      }
    }
  } catch (e) {}
  return { status: 200, meta };
}
async function pollJob(token, id, ms) {
  const until = Date.now() + (ms || 60000);
  while (Date.now() < until) {
    const r = await GET('/api/jobs/' + id, token);
    if (r.status === 200 && (r.body.job.status === 'done' || r.body.job.status === 'failed')) return r.body.job;
    await sleep(300);
  }
  return null;
}

(async () => {
  const child = startServer();
  try {
    const health = await waitReady();
    group('A. 健康检查与版本');
    // ★ 日期不写死：跨天 bump 一次就让 5 个套件同时红，纯属噪声。
    ok('版本形如 YYYY-MM-DD-<标签>（是本项目的构建，不是默认模板）', /^\d{4}-\d{2}-\d{2}-[A-Za-z][\w.-]*$/.test(String(health.version)), health.version);

    group('B. 未登录一律拒绝（反证）');
    const guards = [
      ['POST', '/api/interactive/generate'], ['POST', '/api/interactive'],
      ['GET', '/api/messages/m_x/interactive'], ['POST', '/api/interactive/job_x/share'],
      ['DELETE', '/api/interactive/job_x/share'], ['GET', '/api/jobs/job_x'],
    ];
    let guardBad = [];
    for (const [m, p] of guards) {
      const r = await req(m, p, m === 'GET' || m === 'DELETE' ? undefined : {}, null);
      if (r.status !== 401) guardBad.push(m + ' ' + p + '→' + r.status);
    }
    ok('全部 ' + guards.length + ' 个互动接口未登录时返回 401', guardBad.length === 0, guardBad.join(' | '));

    group('C. 建空间与对话');
    const sp = await POST('/api/space', { name: '批次4孩子', password: '' });
    ok('建空间成功', sp.status === 200 && !!sp.body.token, JSON.stringify(sp.body).slice(0, 100));
    const T = sp.body.token;
    const cv = await POST('/api/conversations', { title: '批次4对话' }, T);
    ok('建对话成功', cv.status === 200 && !!cv.body.conversation.id);
    const CID = cv.body.conversation.id;
    // 用户消息通过 SSE 流式入口创建（没有直接 POST /api/messages 的路由）
    const sm = await sendMsg(T, { text: '二次函数怎么求顶点？', conversationId: CID, mode: 'selfstudy' });
    ok('发消息拿到 meta', sm.status === 200 && sm.meta && !!sm.meta.messageId, sm.meta);
    const MID = sm.meta.messageId;

    group('D. 异步生成 + 轮询拿到 DSL');
    const gen = await POST('/api/interactive/generate', { text: '二次函数怎么求顶点？', conversationId: CID, messageId: MID }, T);
    ok('创建互动生成任务', gen.status === 200 && !!gen.body.jobId, JSON.stringify(gen.body).slice(0, 160));
    ok('mock 下来源是 preset', gen.body.source === 'preset', gen.body.source);
    ok('二次关键词命中抛物线 preset', gen.body.dsl && gen.body.dsl.title === '二次函数图像', gen.body.dsl && gen.body.dsl.title);
    const JID = gen.body.jobId;
    const job = await pollJob(T, JID);
    ok('任务进入终态 done', job && job.status === 'done', job && job.status);
    ok('轮询拿到的 result 是 DSL 对象（未被二次序列化）', job && job.result && typeof job.result === 'object' && job.result.type === 'function-plot', job && job.result && typeof job.result);
    ok('result 与生成时的 dsl 一致', job && job.result && job.result.title === '二次函数图像', job && job.result && job.result && job.result.title);

    group('E. 消息附件回取');
    const im = await GET('/api/messages/' + MID + '/interactive', T);
    ok('按消息取到互动附件', im.status === 200 && im.body.items.length === 1, im.body);
    ok('附件回带 jobId', im.body.items[0].jobId === JID, im.body.items[0]);
    ok('附件 dsl 正确', im.body.items[0].dsl && im.body.items[0].dsl.title === '二次函数图像');

    group('F. 直接提交已构建的 DSL');
    const direct = await POST('/api/interactive', {
      dsl: { type: 'geometry', title: '三角形与角', shapes: [{ type: 'triangle', points: [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 1, y: 3 }] }], measures: ['side', 'angle'] },
      conversationId: CID, messageId: MID,
    }, T);
    ok('直接提交合法 DSL 成功', direct.status === 200 && !!direct.body.jobId && direct.body.source === 'manual', direct.body);
    const badDsl = await POST('/api/interactive', { dsl: { type: 'geometry', title: '', shapes: [] } }, T);
    ok('提交非法 DSL 被拒', badDsl.status === 400 && badDsl.body.error === 'BAD_DSL', badDsl.body);

    group('G. 分享 + 公开页');
    const sh = await POST('/api/interactive/' + JID + '/share', {}, T);
    ok('创建互动分享', sh.status === 200 && /^[0-9a-f]{16}$/.test(sh.body.share.token), sh.body);
    const TOK = sh.body.share.token;
    const pub = await GET('/api/share/' + TOK);
    ok('免登录打开分享页', pub.status === 200 && pub.body.ok === true, pub.status);
    ok('公开页标记 kind=interactive', pub.body.kind === 'interactive', pub.body.kind);
    ok('公开页带标题', pub.body.title === '二次函数图像', pub.body.title);
    ok('公开页带空间名', typeof pub.body.spaceName === 'string', pub.body.spaceName);
    ok('公开页返回 dsl 对象', pub.body.dsl && typeof pub.body.dsl === 'object' && pub.body.dsl.type === 'function-plot', pub.body.dsl && typeof pub.body.dsl);

    group('H. 取消分享后下架');
    const cancel = await DEL('/api/interactive/' + JID + '/share', T);
    ok('取消互动分享', cancel.status === 200 && cancel.body.cancelled === true, cancel.body);
    const pub2 = await GET('/api/share/' + TOK);
    ok('下架后公开页返回 404', pub2.status === 404, pub2.status);

    group('I. 跨空间隔离（反证）');
    const sp2 = await POST('/api/space', { name: '另一个孩子', password: '' });
    const T2 = sp2.body.token;
    ok('另一个空间取不到这条消息的附件', (await GET('/api/messages/' + MID + '/interactive', T2)).status === 404);
    ok('另一个空间轮询不到这个任务', (await GET('/api/jobs/' + JID, T2)).status === 404);
  } finally {
    await stopServer(child);
    try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch (e) {}
  }

  console.log('\n' + '─'.repeat(58));
  if (failures.length) failures.forEach(f => console.log('  ✗ ' + f));
  console.log('PASS  通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  process.exit(fail ? 1 : 0);
})().catch(e => {
  console.error('批次4 HTTP 自检自身异常：', e);
  process.exit(2);
});

'use strict';
/**
 * 深度思考开关 · HTTP 端到端（自带服务，真模型 mock）。
 *
 * 要证明的核心事实：**开关真的驱动模型档位**，而不是只改了个界面状态。
 * 做法：真注册账号 → 建会话 → 分别开/关 deepThink 发消息 →
 * 看服务端 `meta` 事件回传的 `model` 到底是 `deep` 还是 `default`。
 *
 * ★ mock 模型下不会真推理，但**档位路由是真实发生的**（server.js 先决定 model
 *   再调 llm），所以 meta.model 足以证明路由正确。这正是本套件的价值：
 *   把"开关只改了 UI、没改路由"这类静默失效挡在部署前。
 *
 * ★★ 特别钉住 regenerate：它会显式传 `model: conv.model`，若优先级写反
 *    （opt.model 优先），开了深度思考再点"重新生成"就会**静默掉回快速档**。
 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname);
let pass = 0, fail = 0;
const fails = [];
function ok(name, cond, extra) {
  if (cond) { pass++; }
  else { fail++; fails.push(name + (extra !== undefined ? ' → ' + JSON.stringify(extra) : '')); }
}
function group(t) { console.log('\n' + t); }

function waitReady(base, ms) {
  const deadline = Date.now() + (ms || 60000);
  return new Promise(resolve => {
    (function tick() {
      http.get(base + '/api/health', r => { r.resume(); resolve(true); })
        .on('error', () => { if (Date.now() > deadline) resolve(false); else setTimeout(tick, 200); });
    })();
  });
}

function req(base, method, p, body, token) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const headers = {};
    if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = data.length; }
    if (token) headers['Authorization'] = 'Bearer ' + token;
    const r = http.request(base + p, { method, headers }, res => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', c => { buf += c; });
      res.on('end', () => {
        let j = null; try { j = buf ? JSON.parse(buf) : null; } catch (e) { j = { __raw: buf }; }
        resolve({ status: res.statusCode, body: j, raw: buf });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

/** 发消息，从 SSE 里抠出 meta（含 model / deepThink）。拿到 meta 就断开，不等正文。 */
function sendMeta(base, token, convId, text, deepThink) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ text, conversationId: convId || undefined, deepThink });
    const r = http.request(base + '/api/chat/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), Authorization: 'Bearer ' + token },
    }, res => {
      if (res.statusCode !== 200) {
        let b = ''; res.setEncoding('utf8'); res.on('data', c => { b += c; });
        res.on('end', () => reject(new Error('stream ' + res.statusCode + ': ' + b.slice(0, 200))));
        return;
      }
      let buf = '', done = false;
      res.setEncoding('utf8');
      res.on('data', c => {
        buf += c;
        const parts = buf.split('\n\n');
        buf = parts.pop();
        for (const part of parts) {
          let ev = '', data = '';
          part.split('\n').forEach(l => {
            if (l.startsWith('event:')) ev = l.slice(6).trim();
            else if (l.startsWith('data:')) data += l.slice(5).trim();
          });
          if (ev === 'meta' && data && !done) {
            done = true;
            let meta = null; try { meta = JSON.parse(data); } catch (e) {}
            resolve(meta);
            try { res.destroy(); } catch (e) {}   // 验证够了，别等整条回答
          }
        }
      });
      res.on('end', () => { if (!done) resolve(null); });
      res.on('error', () => { if (!done) resolve(null); });
    });
    r.on('error', e => { if (!e.message.includes('aborted')) reject(e); });
    r.write(payload);
    r.end();
  });
}

(async () => {
  const dd = fs.mkdtempSync(path.join(os.tmpdir(), 'hl-dt-http-'));
  const port = await new Promise(r => { const s = require('net').createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
  const srv = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { PORT: String(port), DATA_DIR: dd, ADMIN_PASSWORD: 'dt-pw', LLM_API_KEY: '', NO_DOTENV: '1' }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const base = 'http://127.0.0.1:' + port;
  const up = await waitReady(base);
  if (!up) { console.error('服务没起来'); srv.kill('SIGKILL'); process.exit(1); }
  const GET = (p, t) => req(base, 'GET', p, undefined, t);
  const POST = (p, b, t) => req(base, 'POST', p, b, t);
  const PATCH = (p, b, t) => req(base, 'PATCH', p, b, t);
  const CONSENTS = ['terms', 'privacy', 'children-privacy'];

  try {
    group('1. 健康检查');
    const h = await GET('/api/health');
    ok('健康检查 200', h.status === 200, h.status);

    group('2. 建账号建会话');
    const reg = await POST('/api/auth/register', { username: 'dt_user', password: 'pw123456', name: '测试', consents: CONSENTS });
    const tok = reg.body && reg.body.token;
    ok('注册成功拿到 token', !!tok, [reg.status, reg.body && reg.body.error]);
    if (!tok) throw new Error('没有 token，后续无法继续');

    const mk = await POST('/api/conversations', { title: '深度思考验证' }, tok);
    const conv = (mk.body && (mk.body.conversation || mk.body.conv)) || mk.body || {};
    const convId = conv.id;
    ok('建会话成功', !!convId, mk.status);
    ok('★ 新会话 deepThink 默认 false（老行为不变）', conv.deepThink === false || conv.deepThink === undefined, conv.deepThink);

    group('3. ★★ 关 → default / 开 → deep（开关真的驱动档位）');
    const m1 = await sendMeta(base, tok, convId, '你好', false);
    ok('关闭时拿到 meta', !!m1);
    ok('★★ 关：model=default（快速档）', m1 && m1.model === 'default', m1 && m1.model);
    ok('关：meta.deepThink=false', m1 && m1.deepThink === false, m1 && m1.deepThink);

    const m2 = await sendMeta(base, tok, convId, '你好', true);
    ok('开启时拿到 meta', !!m2);
    ok('★★ 开：model=deep（真的切档位，不是只改 UI）', m2 && m2.model === 'deep', m2 && m2.model);
    ok('开：meta.deepThink=true', m2 && m2.deepThink === true, m2 && m2.deepThink);

    group('4. ★ 开关随发送落库');
    const c1 = await GET('/api/conversations/' + convId, tok);
    const cv1 = (c1.body && c1.body.conversation) || {};
    ok('★ 落库为 true（刷新/换设备记得住）', cv1.deepThink === true, cv1.deepThink);

    group('5. ★ PATCH 关掉后回到 default（双向可切）');
    const p = await PATCH('/api/conversations/' + convId, { deepThink: false, model: 'default' }, tok);
    ok('PATCH 200', p.status === 200, p.status);
    const m3 = await sendMeta(base, tok, convId, '你好', false);
    ok('★★ 关掉后 model=default', m3 && m3.model === 'default', m3 && m3.model);

    group('6. ★★★ regenerate 不许把开关静默降级');
    // 先把开关打开
    await PATCH('/api/conversations/' + convId, { deepThink: true, model: 'deep' }, tok);
    const m4 = await sendMeta(base, tok, convId, '再问一次', true);
    ok('开启状态下再发一条仍是 deep', m4 && m4.model === 'deep', m4 && m4.model);
    // 找到刚才那条助手消息，跑 regenerate（它内部会显式传 conv.model）
    const msgs = await GET('/api/conversations/' + convId, tok);
    const list = (msgs.body && msgs.body.messages) || [];
    const lastAssist = [...list].reverse().filter(m => m.role === 'assistant')[0];
    ok('找到助手消息', !!lastAssist, list.length);
    if (lastAssist) {
      // 直接用 regenerate 接口拿 meta（它走的是另一条分支）
      const rgMeta = await new Promise(resolve => {
        const payload = JSON.stringify({ model: 'default' });   // ★ 故意传 default，模拟前端可能带的旧值
        const r = http.request(base + '/api/messages/' + lastAssist.id + '/regenerate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), Authorization: 'Bearer ' + tok },
        }, res => {
          if (res.statusCode !== 200) { res.resume(); return resolve({ bad: res.statusCode }); }
          let buf = '', done = false;
          res.setEncoding('utf8');
          res.on('data', c => {
            buf += c;
            const parts = buf.split('\n\n'); buf = parts.pop();
            for (const part of parts) {
              let ev = '', data = '';
              part.split('\n').forEach(l => { if (l.startsWith('event:')) ev = l.slice(6).trim(); else if (l.startsWith('data:')) data += l.slice(5).trim(); });
              if (ev === 'meta' && data && !done) { done = true; let m = null; try { m = JSON.parse(data); } catch (e) {} resolve(m); try { res.destroy(); } catch (e) {} }
            }
          });
          res.on('end', () => { if (!done) resolve(null); });
        });
        r.on('error', () => resolve(null));
        r.write(payload); r.end();
      });
      ok('regenerate 拿到 meta（或已知状态）', !!rgMeta, rgMeta);
      ok('★★★ regenerate 时开关仍是 deep —— 显式传 model:default 也不许覆盖开关',
        rgMeta && rgMeta.model === 'deep', rgMeta && rgMeta.model);
    }

    group('7. 会话列表也带 deepThink');
    const lst = await GET('/api/conversations', tok);
    const arr = (lst.body && (lst.body.conversations || lst.body.convs)) || [];
    const hit = arr.filter(x => x.id === convId)[0];
    ok('★ 列表返回 deepThink 字段（恢复会话要用）', !!hit && hit.deepThink !== undefined, hit && hit.deepThink);

    group('8. 返回体干净');
    const cRaw = (await GET('/api/conversations/' + convId, tok)).raw;
    ok('不带 undefined', cRaw.indexOf('undefined') < 0);
    ok('不带 SQL 片段', cRaw.indexOf('SELECT') < 0 && cRaw.indexOf('deep_think') < 0);
  } finally {
    try { srv.kill('SIGKILL'); } catch (e) {}
    try { fs.rmSync(dd, { recursive: true, force: true }); } catch (e) {}
  }

  console.log('\n' + '─'.repeat(62));
  if (fails.length) { console.log('失败 ' + fails.length + ' 项：'); fails.forEach(f => console.log('  ✗ ' + f)); }
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('异常：', e.message); process.exit(1); });

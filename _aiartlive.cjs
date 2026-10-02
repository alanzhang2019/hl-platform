'use strict';
/**
 * 批次11 · 真链路验证（用真模型 + 真生图，跑一次要花几十秒与一次生图额度）。
 *
 * 与 _parity11check.cjs 的区别：那边桩掉 fetch 只验代码路径，
 * 这边**不打桩**，就为了回答一个问题：真的接上以后，学生是不是真能拿到一张写进磁盘的图。
 *
 * 流程：起真服务 → 建空间 → 发一句"帮我做期末复习计划" → 收 SSE →
 *       等 image 任务落库 → 拉消息附件 → 把图下载回来验字节。
 *
 * 用法：node _aiartlive.cjs            （正常跑）
 *      ART_LIVE=0 node ...            （跳过，服务里没有生图额度时用）
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const http = require('http');

const PORT = 4500 + Math.floor(Math.random() * 300);
const BASE = 'http://127.0.0.1:' + PORT;
const DATA_DIR = path.join(os.tmpdir(), 'hl-aiart-' + crypto.randomBytes(4).toString('hex'));

let pass = 0, fail = 0;
const fails = [];
function ok(cond, name, extra) {
  if (cond) pass++;
  else { fail++; fails.push(name + (extra !== undefined ? ' → ' + JSON.stringify(extra) : '')); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

function req(method, p, body, token) {
  return new Promise(resolve => {
    const data = body === undefined ? null : JSON.stringify(body);
    const h = {};
    if (data) h['Content-Type'] = 'application/json';
    if (token) h.Authorization = 'Bearer ' + token;
    if (data) h['Content-Length'] = Buffer.byteLength(data);
    const r = http.request({ host: '127.0.0.1', port: PORT, path: p, method, headers: h }, res => {
      let buf = '';
      res.on('data', d => { buf += d; });
      res.on('end', () => {
        let j = null; try { j = JSON.parse(buf); } catch (e) {}
        resolve({ status: res.statusCode, body: j, raw: buf, headers: res.headers });
      });
    });
    r.on('error', e => resolve({ status: 0, body: null, raw: String(e.message) }));
    if (data) r.write(data);
    r.end();
  });
}

/** 收 SSE：返回 { replyId, conversationId, artEvent, textLen } */
function streamChat(token, text, timeoutMs) {
  return new Promise(resolve => {
    const body = JSON.stringify({ text: text, mode: 'default' });
    const r = http.request({
      host: '127.0.0.1', port: PORT, path: '/api/chat/stream?_t=' + encodeURIComponent(token),
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token, 'Content-Length': Buffer.byteLength(body) },
    }, res => {
      let buf = ''; let textLen = 0; const out = { replyId: '', conversationId: '', artEvent: null, error: '' };
      res.on('data', d => {
        buf += d.toString('utf8');
        const parts = buf.split('\n\n'); buf = parts.pop();
        for (const part of parts) {
          let ev = '', data = '';
          part.split('\n').forEach(l => {
            if (l.indexOf('event:') === 0) ev = l.slice(6).trim();
            else if (l.indexOf('data:') === 0) data += l.slice(5).trim();
          });
          if (!data) continue;
          let j = {}; try { j = JSON.parse(data); } catch (e) { continue; }
          if (ev === 'meta') { out.replyId = j.replyId || ''; out.conversationId = j.conversationId || ''; }
          else if (ev === 'delta') textLen += String(j.text || '').length;
          else if (ev === 'art') out.artEvent = j;
          else if (ev === 'error') out.error = j.message || 'error';
        }
      });
      res.on('end', () => { out.textLen = textLen; resolve(out); });
    });
    r.on('error', e => resolve({ replyId: '', conversationId: '', artEvent: null, textLen: 0, error: String(e.message) }));
    r.setTimeout(timeoutMs || 120000, () => { try { r.destroy(); } catch (e) {} });
    r.write(body); r.end();
  });
}

function download(p, token) {
  return new Promise(resolve => {
    const h = token ? { Authorization: 'Bearer ' + token } : {};
    http.get({ host: '127.0.0.1', port: PORT, path: p, headers: h }, res => {
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => resolve({ status: res.statusCode, mime: res.headers['content-type'], buf: Buffer.concat(chunks) }));
    }).on('error', e => resolve({ status: 0, mime: '', buf: Buffer.alloc(0), err: String(e.message) }));
  });
}

(async () => {
  if (process.env.ART_LIVE === '0') { console.log('ART_LIVE=0，跳过真链路验证'); process.exit(0); }

  const srv = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    cwd: __dirname,
    env: Object.assign({}, process.env, { PORT: String(PORT), DATA_DIR: DATA_DIR, NO_DOTENV: '' }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  srv.stdout.on('data', d => { log += d.toString(); });
  srv.stderr.on('data', d => { log += d.toString(); });

  try {
    // 等服务起来
    let up = false;
    for (let i = 0; i < 60; i++) {
      await sleep(500);
      const r = await req('GET', '/api/health');
      if (r.status === 200 && r.body && r.body.ok) { up = true; break; }
    }
    if (!up) { console.log('服务没起来：\n' + log.slice(-1500)); process.exit(1); }

    const sp = await req('POST', '/api/space', { name: 'AI插画验证', password: '' });
    const T = sp.body && sp.body.token;
    ok(!!T, '建空间拿到 token', sp.status);
    if (!T) { console.log(log.slice(-1500)); process.exit(1); }

    console.log('· 发一句"期末复习计划"，跑真模型…');
    const st = await streamChat(T, '帮我做一个期末复习计划，要具体到每周做什么');
    ok(!!st.replyId, '拿到 replyId', st.replyId);
    ok(st.textLen > 220, '回答够长（触发档要求 ≥220 字）', st.textLen);
    ok(!!st.artEvent && st.artEvent.kind === 'ai', 'SSE 预告了 AI 配图', st.artEvent);

    // 等生图任务落库：直接盯消息附件，跟前端 watchArt 一个判据
    console.log('· 等生图（真接口约 20-60 秒）…');
    let atts = [];
    for (let i = 0; i < 60; i++) {
      await sleep(3000);
      const m = await req('GET', '/api/messages/' + st.replyId, undefined, T);
      atts = (m.body && m.body.message && m.body.message.attachments) || [];
      if (atts.some(a => a.mode === 'raster' && a.fileId)) break;
    }
    const art = atts.filter(a => a.mode === 'raster' && a.fileId)[0];
    ok(!!art, '生成了 raster 插画附件', atts.map(a => a.kind + '/' + (a.mode || 'svg')));
    if (art) {
      const dl = await download('/api/files/' + art.fileId, T);
      ok(dl.status === 200, '图片能下载（/api/files 200）', dl.status);
      ok(String(dl.mime || '').indexOf('image/') === 0, '返回的是图片类型', dl.mime);
      ok(dl.buf.length > 8000, '图片不是空壳', dl.buf.length);
      // PNG magic
      ok(dl.buf[0] === 0x89 && dl.buf.slice(1, 4).toString() === 'PNG', '真的是 PNG 文件头');
      // ★ <img src> 带不上 Authorization 头 —— 直链必须靠 ?_t= 过鉴权，
      //   否则学生看到的就是"图片一片空白 + 控制台一个 401"。
      const noTok = await download('/api/files/' + art.fileId, null);
      ok(noTok.status === 401, '不带 token 取图 → 401（所以前端必须走 fileUrl()）', noTok.status);
      const qTok = await download('/api/files/' + art.fileId + '?_t=' + encodeURIComponent(T), null);
      ok(qTok.status === 200 && qTok.buf.length > 8000, '带 ?_t= 取图 → 200 且字节数对（<img src> 走得通）', qTok.status + '/' + qTok.buf.length);
      const out = path.join(__dirname, '_shots', 'aiart-live.png');
      try { fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, dl.buf); console.log('· 样图已存：' + out); } catch (e) {}
    }

    // 任务本身也应该是一条 done 的 image 任务
    const jobs = await req('GET', '/api/chat/jobs?kind=image&conversationId=' + encodeURIComponent(st.conversationId), undefined, T);
    const job = (jobs.body && jobs.body.jobs && jobs.body.jobs[0]) || null;
    ok(!!job, '有一条 image 任务记录', jobs.status);
    if (job) {
      ok(job.status === 'done', '任务状态 done', job.status);
      ok(job.input && job.input.style === 'concept', '任务带 style=concept（走的是 AI 生图档）', job.input && job.input.style);
      ok(job.input && job.input.messageId === st.replyId, '任务挂在了这条回复上');
    }

    // 反证：普通闲聊不该触发 AI 生图（省钱）
    console.log('· 反证：普通提问不该触发…');
    const st2 = await streamChat(T, '什么是光合作用？用两句话讲');
    ok(!st2.artEvent || st2.artEvent.kind !== 'ai', '普通提问没有触发 AI 配图', st2.artEvent);
  } catch (e) {
    fail++; fails.push('异常：' + (e && e.message));
  } finally {
    try { srv.kill(); } catch (e) {}
    await sleep(300);
  }

  console.log('\n批次11 真链路（真模型 + 真生图）：');
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  if (fail) { console.log('\n失败清单：'); fails.forEach(f => console.log('  ✗ ' + f)); console.log('\n服务日志尾部：\n' + log.slice(-2000)); }
  process.exit(fail ? 1 : 0);
})();

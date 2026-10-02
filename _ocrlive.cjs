'use strict';
/**
 * 真书端到端实拍：130 页扫描件教材，从上传到「AI 能引用」。
 *
 * 为什么必须跑真的：批次21 的单测用的是**合成**扫描件（三页、假 fetch）。
 * 它能证明逻辑对，但证明不了三件只有真书才能暴露的事：
 *   ① 单页真实耗时（决定"要不要异步"这个架构判断对不对）
 *   ② 真实识别质量（模型会不会把教材读成乱码）
 *   ③ 130 页正文进库后，检索**还找不找得到**（量大以后检索可能失准）
 *
 * 跑法（花 130 次视觉调用 + 1 次对话额度）：
 *   NODE_PATH=<workspace>/node_modules node _ocrlive.cjs
 * 可选：PDF=路径  SHOT_DIR=截图目录  QUESTION=提问内容
 */
const net = require('net');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const { chromium } = require('playwright-core');

const NODE = process.execPath;
const ROOT = __dirname;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hl-ocrlive-'));
const DATA = path.join(TMP, 'data');
const PDF = process.env.PDF || 'C:/Users/zpy20/AppData/Local/Temp/math6.pdf';
const SHOT_DIR = process.env.SHOT_DIR || path.join(ROOT, '..', '产品截图-扫描件OCR');
const QUESTION = process.env.QUESTION || '我这份资料里，圆这一章大概是先讲什么、再讲什么？只根据资料里的内容说。';

function findChrome() {
  if (process.env.CHROME && fs.existsSync(process.env.CHROME)) return process.env.CHROME;
  const root = path.join(process.env.LOCALAPPDATA || '', 'ms-playwright');
  let best = null, bestN = -1;
  try {
    for (const d of fs.readdirSync(root)) {
      const m = /^chromium-(\d+)$/.exec(d);
      if (!m) continue;
      const exe = path.join(root, d, 'chrome-win64', 'chrome.exe');
      if (fs.existsSync(exe) && Number(m[1]) > bestN) { bestN = Number(m[1]); best = exe; }
    }
  } catch (e) {}
  return best;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
function freePort() {
  return new Promise(res => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
}
function saveShot(buf, name) {
  const f = path.join(SHOT_DIR, name);
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  fs.writeFileSync(f, buf);
  return f;
}
let pass = 0, fail = 0;
const fails = [];
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name + (extra !== undefined ? '  ← ' + JSON.stringify(extra) : '')); }
  else { fail++; fails.push(name + (extra !== undefined ? ' → ' + JSON.stringify(extra) : '')); console.log('  ✗ ' + name + (extra !== undefined ? '  ← ' + JSON.stringify(extra) : '')); }
}
const fmt = s => s >= 60 ? Math.floor(s / 60) + '分' + Math.round(s % 60) + '秒' : Math.round(s) + '秒';

(async () => {
  if (!fs.existsSync(PDF)) { console.error('找不到 PDF：' + PDF); process.exit(2); }
  const pdfBuf = fs.readFileSync(PDF);
  console.log('原件：' + path.basename(PDF) + '，' + (pdfBuf.length / 1048576).toFixed(2) + ' MB\n');

  const port = await freePort();
  const BASE = 'http://127.0.0.1:' + port;
  const env = Object.assign({}, process.env, { PORT: String(port), DATA_DIR: DATA });
  delete env.NO_DOTENV;                                  // ★ 要真调视觉模型，必须让 .env 生效
  const srv = spawn(NODE, [path.join(ROOT, 'server.js')], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let srvLog = '';
  srv.stdout.on('data', d => { srvLog += d; });
  srv.stderr.on('data', d => { srvLog += d; });
  const stopSrv = () => { try { srv.kill(); } catch (e) {} };
  process.on('exit', stopSrv);

  let browser = null;
  try {
    let up = false;
    for (let i = 0; i < 60; i++) {
      await sleep(500);
      try {
        const r = await fetch(BASE + '/api/health');
        if (r.ok) { const j = await r.json(); up = true; console.log('服务已起 | version = ' + j.version + ' | mockLLM = ' + j.mockLLM); if (j.mockLLM) console.log('★ 警告：mockLLM=true，没读到 Key，这不是真识别'); break; }
      } catch (e) {}
    }
    if (!up) throw new Error('服务没起来：' + srvLog.slice(-500));

    const jpost = async (p, body, token) => {
      const url = BASE + p + (token ? (p.indexOf('?') >= 0 ? '&' : '?') + '_t=' + encodeURIComponent(token) : '');
      const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      return { status: r.status, body: await r.json().catch(() => ({})) };
    };
    const jget = async (p, token) => {
      const url = BASE + p + (p.indexOf('?') >= 0 ? '&' : '?') + '_t=' + encodeURIComponent(token);
      const r = await fetch(url);
      return { status: r.status, body: await r.json().catch(() => ({})) };
    };

    const sp = await jpost('/api/space', { name: '扫描件验证' + Date.now().toString().slice(-4), passcode: '' });
    const spaceId = sp.body.spaceId, token = sp.body.token;
    console.log('空间：' + spaceId + '\n');

    // ---------- 上传 ----------
    console.log('① 上传（走真实接口，扫描件会在这里被自动排队识别）');
    const t0 = Date.now();
    const upRes = await jpost('/api/kb/documents', { filename: path.basename(PDF), dataBase64: pdfBuf.toString('base64') }, token);
    ok(upRes.status === 200, '★ 上传返回 200（不是 422 —— 回 422 前端会当成"上传失败"）', upRes.status);
    const doc = upRes.body.document || {};
    ok(doc.status === 'parsing', '★ 入库状态是「识别中」而不是「失败」', doc.status);
    ok(doc.pages === 130, '  └ 页数识别为 130', doc.pages);
    ok(!!doc.jobId, '  └ 自动排了识别任务', doc.jobId);

    // ---------- 开浏览器，先拍"识别中" ----------
    const chromePath = findChrome();
    if (chromePath) {
      browser = await chromium.launch({ executablePath: chromePath, args: ['--no-sandbox', '--disable-gpu'] });
      const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
      await page.goto(BASE, { waitUntil: 'domcontentloaded' });
      await page.click('.land-tab[data-tab="enter"]');
      await page.fill('#spId', spaceId);
      await page.click('#spEnter');
      await page.waitForSelector('#app:not([hidden])', { timeout: 20000 });
      await page.click('.nav-i[data-view="kb"]');
      await sleep(1200);
      saveShot(await page.screenshot({ fullPage: false }), '01-识别中.png');
      console.log('  · 已截图：识别中的样子');

      // ---------- 盯进度 ----------
      console.log('\n② 识别进度（每个进度变化打一行）');
      let last = -1, lastT = Date.now();
      const tStart = Date.now();
      let final = null;
      for (let i = 0; i < 900; i++) {
        const r = await jget('/api/kb/documents', token);
        const d = (r.body.documents || [])[0] || {};
        if (d.status !== 'parsing') { final = d; break; }
        if (d.progress !== last) {
          const el = (Date.now() - tStart) / 1000;
          const pct = d.progress || 0;
          const eta = pct > 3 ? (el / pct * (100 - pct)) : null;
          console.log('    ' + String(pct).padStart(3) + '%  ' + fmt(el) + ' 已用' + (eta ? '，预计还要 ' + fmt(eta) : ''));
          last = d.progress; lastT = Date.now();
        }
        await sleep(2500);
      }
      const total = (Date.now() - t0) / 1000;
      ok(!!final, '③ 识别跑完（没超时）', fmt(total));
      if (!final) throw new Error('识别没在时限内完成');

      console.log('\n④ 结果');
      ok(final.status === 'ready', '★ 状态 = 已就绪', final.status);
      ok(final.progress === 100, '  └ 进度 100', final.progress);
      ok(final.textLength > 20000, '★ 抽出正文（' + final.textLength + ' 字）', final.textLength);
      ok(!final.error, '  └ 无错误提示', final.error);

      const tr = await jget('/api/kb/documents/' + final.id + '/text', token);
      const text = tr.body.text || '';
      ok(/【第 1 页】/.test(text), '★ 正文带页码标记（AI 才能说"第几页"）');
      ok(/【第 130 页】/.test(text), '  └ 最后一页也在');
      const marks = (text.match(/【第 \d+ 页】/g) || []).length;
      ok(marks >= 120, '  └ 有效页数 ' + marks + ' / 130（纯插图页会没有文字，属正常）');
      ok(!/[\u0000-\u0008]/.test(text), '  └ 没有控制字符混进正文');
      console.log('\n  —— 正文抽样（第 30 页，圆周率那一页）——');
      const m30 = /【第 30 页】\n([\s\S]{0,260})/.exec(text);
      console.log('  ' + (m30 ? m30[1].slice(0, 240).replace(/\n/g, '\n  ') : '(没取到第 30 页)'));

      saveShot(await page.screenshot({ fullPage: false }), '02-识别完成.png');
      await page.click('.nav-i[data-view="chat"]');
      await sleep(500);

      // ---------- 让 AI 用它 ----------
      console.log('\n⑤ 让 AI 引用这份资料');
      await page.fill('#input', QUESTION);
      await page.click('#send');
      let reply = '', stable = 0;
      for (let i = 0; i < 150; i++) {
        await sleep(1000);
        const cur = await page.evaluate(() => {
          const els = document.querySelectorAll('#stream .msg.ai .body');
          return els.length ? (els[els.length - 1].innerText || '') : '';
        });
        if (cur && cur === reply && cur.length > 20) { stable++; if (stable >= 2) break; }
        else { stable = 0; reply = cur; }
      }
      console.log('\n  —— AI 答复 ——\n' + reply.split('\n').slice(0, 14).map(l => '  ' + l).join('\n'));
      const hit = ['圆', '半径', '直径', '周长', '面积', '圆规', '圆心'].filter(k => reply.indexOf(k) >= 0);
      ok(hit.length >= 2, '★ AI 用到了资料里的内容（命中关键词：' + hit.join('、') + '）', hit);
      ok(!/没有(找到|相关)资料|资料里没有/.test(reply), '  └ 没有说"资料里没有"');
      saveShot(await page.screenshot({ fullPage: false }), '03-AI引用.png');
    } else {
      console.log('（没找到 Chromium，跳过截图与问答）');
    }

    console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
    if (fail) { console.log('失败清单：'); fails.forEach(f => console.log('  ✗ ' + f)); }
  } catch (e) {
    console.error('\n实拍异常：' + ((e && e.stack) || e));
    console.error('--- 服务端日志尾部 ---\n' + srvLog.slice(-1500));
    fail++;
  } finally {
    try { if (browser) await browser.close(); } catch (e) {}
    stopSrv();
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
  }
  process.exit(fail ? 1 : 0);
})();

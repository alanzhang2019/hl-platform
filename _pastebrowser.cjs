'use strict';
/**
 * 浏览器端验证：粘贴上传 / 拖拽上传 / AI 读链接。
 *
 * 为什么必须真浏览器跑：这三个全是 DOM 事件（paste / drop / 流式补提示条），
 * 静态断言只能证明"代码里写了这段字"，证明不了"真按下去有反应"。
 *
 * 覆盖的点击流：
 *   ① 往输入框粘贴一张图片（模拟 Ctrl+V）→ 附件区出现 1 个
 *   ② 把图片拖到**输入框**上松开 → 附件区变成 2 个
 *      （旧代码只把拖拽绑在 #stream 上，拖到输入框附近是**完全没反应**的 —— 这条就是那次修改的证据）
 *   ③ 发一条带链接的消息 → 先出现"正在打开你发的链接…"，随后如实显示"没读到 + 原因"
 *   ④ 灌一条"读到了"的消息进库 → 刷新后提示条是"已读取 1 个链接"+ 可点标题
 *   ⑤ 全程控制台零报错
 *
 * 自起服务、自找空闲端口、离线演示模式（不配 Key，不花 token）。
 * 跑法：NODE_PATH=<workspace>/node_modules node _pastebrowser.cjs
 */
const net = require('net');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const { chromium } = require('playwright-core');

const NODE = process.execPath;
const ROOT = __dirname;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hl-paste-'));
const DATA = path.join(TMP, 'data');

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

let pass = 0, fail = 0;
const failures = [];
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  \u2713 ' + name); }
  else { fail++; failures.push(name + (extra ? ' → ' + (typeof extra === 'string' ? extra : JSON.stringify(extra)) : '')); console.log('  \u2717 ' + name + (extra ? ' → ' + (typeof extra === 'string' ? extra : JSON.stringify(extra)) : '')); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
function freePort() {
  return new Promise(res => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
}

// 往页面里塞一个 paste / drop 事件，dataTransfer 带一张真图片。
// ClipboardEvent/DragEvent 的 dataTransfer 是只读的，构造参数在新版 Chromium 上能用，
// 老一点的会被忽略 —— 所以两条路都走一遍。
// ★ 必须传**真函数**，不能传字符串：
//   page.evaluate("<箭头函数字符串>") 会把字符串当表达式求值 —— 得到的是一个函数对象，
//   既不会被调用，也不可序列化，于是返回 undefined、事件压根没派发。
//   （踩过：第一版就是这么写的，表现为"粘贴没反应"，排查了好几轮。）
//   函数体在页面上下文执行，所以这里可以直接用 DOM / ClipboardEvent。
async function fireEvent(kind) {
  const c = document.createElement('canvas');
  c.width = 320; c.height = 200;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#2563EB'; ctx.fillRect(0, 0, 320, 200);
  ctx.fillStyle = '#fff'; ctx.font = 'bold 22px sans-serif';
  ctx.fillText(kind === 'paste' ? '粘贴的图' : '拖进来的图', 24, 110);
  const blob = await new Promise(r => c.toBlob(r, 'image/png'));
  const file = new File([blob], 'image.png', { type: 'image/png' });
  const dt = new DataTransfer();
  dt.items.add(file);
  const target = document.getElementById('input');
  const evName = kind === 'paste' ? 'paste' : 'drop';
  const bag = kind === 'paste' ? 'clipboardData' : 'dataTransfer';
  const Ctor = kind === 'paste' ? ClipboardEvent : DragEvent;
  let ev = null;
  try {
    const init = { bubbles: true, cancelable: true };
    init[bag] = dt;
    ev = new Ctor(evName, init);
  } catch (e) { ev = null; }
  if (!ev || !ev[bag] || !ev[bag].files || !ev[bag].files.length) {
    ev = new Ctor(evName, { bubbles: true, cancelable: true });
    Object.defineProperty(ev, bag, { value: dt, configurable: true });
  }
  const before = document.querySelectorAll('#attachPreview .att-chip').length;
  target.dispatchEvent(ev);
  return {
    evType: ev.type,
    filesInBag: ev[bag] && ev[bag].files ? ev[bag].files.length : -1,
    defaultPrevented: ev.defaultPrevented,   // true = 页面确实接住了这个事件
    chipsBefore: before,
  };
}

(async () => {
  const PORT = await freePort();
  const BASE = 'http://127.0.0.1:' + PORT;
  const srvEnv = {
    PORT: String(PORT), DATA_DIR: DATA, NO_DOTENV: '1',
    LLM_API_KEY: '', ADMIN_PASSWORD: '', IMAGE_AI_ART: '0',
  };
  let srv = null;
  async function startServer() {
    srv = spawn(NODE, [path.join(ROOT, 'server.js')], { cwd: ROOT, env: Object.assign({}, process.env, srvEnv), stdio: ['ignore', 'pipe', 'pipe'] });
    srv.stderr.on('data', d => process.stderr.write('[srv] ' + d));
    for (let i = 0; i < 60; i++) {
      try { const r = await fetch(BASE + '/api/health'); if (r.ok) return true; } catch (e) {}
      await sleep(400);
    }
    return false;
  }
  async function stopServer() {
    if (!srv) return;
    const s = srv; srv = null;
    s.kill();
    for (let i = 0; i < 40; i++) { await sleep(150); try { await fetch(BASE + '/api/health'); } catch (e) { return; } }
  }

  if (!await startServer()) { console.error('服务没起来'); process.exit(2); }

  const post = async (p, body, token) => {
    const url = BASE + p + (token ? (p.indexOf('?') >= 0 ? '&' : '?') + '_t=' + encodeURIComponent(token) : '');
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };

  const sp = await post('/api/space', { name: '粘贴验证', passcode: '' });
  const spaceId = sp.body.spaceId;
  const token = sp.body.token;
  ok(!!spaceId && !!token, '建空间成功', sp.body);

  const chromePath = findChrome();
  if (!chromePath) { await stopServer(); console.error('找不到 Chromium'); process.exit(2); }
  const browser = await chromium.launch({ executablePath: chromePath, args: ['--no-sandbox', '--disable-gpu'] });
  const errs = [];
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
  page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
  page.on('pageerror', e => errs.push('pageerror: ' + e.message));

  console.log('\n浏览器点击流（粘贴 / 拖拽 / 读链接）');
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.land-tab[data-tab="enter"]', { timeout: 20000 });
  await page.click('.land-tab[data-tab="enter"]');
  await page.fill('#spId', spaceId);
  await page.click('#spEnter');
  await page.waitForSelector('#app:not([hidden])', { timeout: 20000 });
  ok(true, '登录进主界面');

  // ---------- ① 粘贴图片 ----------
  await page.fill('#input', '这是我从卷子上截的图');
  const diag = await page.evaluate(fireEvent, 'paste');
  console.log('    [诊断] ' + JSON.stringify(diag));
  await page.waitForSelector('#attachPreview .att-chip', { timeout: 10000 });
  let n = await page.locator('#attachPreview .att-chip').count();
  ok(n === 1, '★ 粘贴一张图 → 附件区出现 1 个（Ctrl+V 可用）', n);
  ok(!(await page.locator('#attachPreview').isHidden()), '附件预览区不再隐藏');
  await page.screenshot({ path: path.join(TMP, '01-粘贴图片.png') });

  // ---------- ② 拖到输入框上 ----------
  await page.evaluate(fireEvent, 'drop');
  await page.waitForTimeout(1200);
  n = await page.locator('#attachPreview .att-chip').count();
  ok(n === 2, '★★ 把图拖到**输入框**上松开也能上传（旧代码只绑了 #stream，拖这儿没反应）', n);
  ok(await page.locator('#stream.drop').count() === 0, '拖完高亮已复位（没有残留的 .drop）');
  await page.screenshot({ path: path.join(TMP, '02-拖拽到输入框.png') });

  // ---------- ③ 发一条带链接的消息 ----------
  // 用 .invalid 保留域名：一定解析不出来，所以这条断言不依赖外网是否通。
  await page.fill('#input', '帮我看看 https://this-site-really-does-not-exist-12345.invalid/page 讲了什么');
  await page.click('#send');
  await page.waitForFunction(() => document.getElementById('stop').hidden === false, null, { timeout: 8000 })
    .catch(() => {});

  const hint = await page.waitForSelector('.wait-hint', { timeout: 6000 }).catch(() => null);
  ok(!!hint, '★ 发链接后出现「正在打开你发的链接…」（否则那几秒会被当成卡死）',
    hint ? (await hint.textContent()) : '没抓到（可能太快）');

  await page.waitForSelector('.msg-net.off', { timeout: 40000 });
  const offTxt = (await page.textContent('.msg-net.off') || '').replace(/\s+/g, ' ');
  ok(offTxt.indexOf('没读到') >= 0, '读不到时如实显示「N 个链接没读到」', offTxt);
  ok(offTxt.indexOf('解析') >= 0, '★ 原因说的是「解析不了」，不是「指向内网」（文案不能骗人）', offTxt);
  await page.waitForFunction(() => document.getElementById('stop').hidden === true, null, { timeout: 40000 });
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(TMP, '03-链接读不到.png'), fullPage: false });

  // 正文是 mock 模型生成的，不看内容；但要确认这条消息真的落库了（否则刷新后提示条会消失）
  const msgs = await (await fetch(BASE + '/api/conversations?_t=' + encodeURIComponent(token))).json().catch(() => ({}));
  ok((msgs.conversations || []).length >= 1, '首条对话已落库', (msgs.conversations || []).length);

  // ---------- ④ 灌一条"读到了"的消息，看刷新后长什么样 ----------
  await stopServer();
  process.env.DATA_DIR = DATA;                 // ★ 必须在 require core 之前设
  process.env.NO_DOTENV = '1';
  const core = require('./server/core');
  const conv = core.createConversation(spaceId, null, { title: '链接已读取的样子' });
  core.addMessage(spaceId, conv.id, { role: 'user', content: '看看这篇 https://example.com/article 讲了什么' });
  const meta = {
    links: {
      urlCount: 1, read: 1,
      pages: [{ url: 'https://example.com/article', title: '示例文章：如何规划中考复习' }],
      errors: [],
    },
    sources: [],
  };
  core.addMessage(spaceId, conv.id, {
    role: 'assistant', status: 'done',
    content: '这篇讲的是把复习拆成三轮：**先扫一遍找漏洞**，再集中打薄弱点，最后整套卷子练手。\n\n你现在最想先解决哪一科？',
    meta: meta,
  });
  await startServer();

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#app:not([hidden])', { timeout: 20000 }).catch(async () => {
    // 万一 localStorage 的会话没恢复，就再登一次
    await page.waitForSelector('.land-tab[data-tab="enter"]', { timeout: 15000 });
    await page.click('.land-tab[data-tab="enter"]');
    await page.fill('#spId', spaceId);
    await page.click('#spEnter');
    await page.waitForSelector('#app:not([hidden])', { timeout: 20000 });
  });
  await page.waitForTimeout(400);
  await page.locator('#convList .conv-i', { hasText: '链接已读取的样子' }).click().catch(async () => {
    await page.waitForSelector('#convList .conv-i', { timeout: 8000 });
    await page.locator('#convList .conv-i').first().click();
  });
  await page.waitForSelector('.msg-net.on', { timeout: 15000 });
  const onTxt = (await page.textContent('.msg-net.on') || '').replace(/\s+/g, ' ');
  ok(onTxt.indexOf('已读取 1 个链接') >= 0, '★ 读到时显示「已读取 1 个链接」', onTxt);
  const linkTitle = await page.locator('.msg-net.on .net-list a').first().textContent().catch(() => '');
  ok((linkTitle || '').indexOf('示例文章') >= 0, '可点标题是那篇文章的标题', linkTitle);
  const href = await page.locator('.msg-net.on .net-list a').first().getAttribute('href').catch(() => '');
  ok(href === 'https://example.com/article', '标题链回原地址、新窗口打开', href);
  await page.screenshot({ path: path.join(TMP, '04-链接已读取.png') });

  ok(errs.length === 0, '全程控制台零报错', errs.slice(0, 3).join(' | '));

  await browser.close();
  await stopServer();

  console.log('\n截图目录：' + TMP);
  console.log('\n批次13 浏览器（粘贴 / 拖拽 / 读链接）：');
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  if (fail) { console.log('\n失败清单：'); failures.forEach(f => console.log('  ✗ ' + f)); }
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });

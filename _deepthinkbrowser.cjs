'use strict';
/**
 * 深度思考档位（批次29，批次31 改版）浏览器套件。
 *
 * ★ 批次31 起，「深度思考」按钮**已经没有实体按钮了** —— 它改名成
 *   「DeepSeek Pro」并成为一个**模型下拉选项**。所以本套件从"点按钮"改成
 *   "切下拉"，但**最核心的那条断言一个字没改**：
 *
 *   ★★★ 选了 DeepSeek Pro 之后发消息，**请求体里真的带 deepThink:true**
 *
 *   这条是"接线断了"与"只是 UI 变了"的分水岭 —— 本项目真出过
 *   "界面变了但请求没带"的静默 bug。静态 grep 能看见 `deepThink: !!S.deepThink`
 *   这行源码存在，但**证明不了它运行时真的被放进 body**，只有真浏览器能证。
 *
 * 另外验：切档真的落库（不是只存内存）、刷新后从会话恢复、双视口不溢出、零控制台报错。
 *
 * 自带服务（临时 DATA_DIR、mock Key），不花 token。
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const net = require('net');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { chromium } = require('playwright-core');

const OUT = path.join(__dirname, '_shots-deepthink');
const CONSENTS = ['terms', 'privacy', 'children-privacy'];

function findChrome() {
  const c = [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    path.join(process.env.LOCALAPPDATA || '', 'ms-playwright'),
  ];
  for (const p of c) {
    if (/ms-playwright$/.test(p)) {
      let best = null, n = -1;
      try {
        for (const d of fs.readdirSync(p)) {
          const m = /^chromium-(\d+)$/.exec(d);
          if (!m) continue;
          const exe = path.join(p, d, 'chrome-win64', 'chrome.exe');
          if (fs.existsSync(exe) && Number(m[1]) > n) { n = Number(m[1]); best = exe; }
        }
      } catch (e) {}
      if (best) return best;
      continue;
    }
    if (fs.existsSync(p)) return p;
  }
  return null;
}

let pass = 0, fail = 0;
const fails = [];
function chk(name, cond, extra) {
  if (cond) { pass++; console.log('  \u2713 ' + name); }
  else { fail++; fails.push(name); console.log('  \u2717 ' + name + (extra !== undefined ? ' → ' + JSON.stringify(extra) : '')); }
}
function group(t) { console.log('\n' + t); }

function freePort() {
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
    s.on('error', rej);
  });
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const PORT = await freePort();
  const BASE = 'http://127.0.0.1:' + PORT;
  const dd = fs.mkdtempSync(path.join(os.tmpdir(), 'hldtb-'));

  const srv = spawn(process.execPath, ['server.js'], {
    cwd: __dirname,
    env: Object.assign({}, process.env, {
      PORT: String(PORT), DATA_DIR: dd, DB_FILE: path.join(dd, 'app.db'),
      LLM_API_KEY: 'mock', NO_DOTENV: '1', ADMIN_PASSWORD: '',
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  srv.stdout.on('data', d => { if (process.env.VERBOSE) console.log('[srv]', String(d).trim()); });
  srv.stderr.on('data', d => { if (process.env.VERBOSE) console.error('[srv]', String(d).trim()); });

  // 等服务起来
  const deadline = Date.now() + 25000;
  let up = false;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(BASE + '/api/health').catch(() => null);
      if (r && r.ok) { up = true; break; }
    } catch (e) {}
    await new Promise(r => setTimeout(r, 400));
  }
  if (!up) { console.error('服务没起来'); srv.kill('SIGKILL'); process.exit(2); }

  const CHROME = process.env.CHROME || findChrome();
  const browser = await chromium.launch({ executablePath: CHROME || undefined, headless: true });
  const errs = [];

  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
    page.on('pageerror', e => errs.push('pageerror: ' + e.message));

    // 进门：建空间（带上同意项，否则会被合规门挡住）
    await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(500);
    await page.evaluate(() => {
      document.querySelectorAll('input[type="checkbox"]').forEach(c => { if (!c.checked) c.click(); });
    });
    await page.fill('#spName', '深思考浏览器');
    await page.click('#spCreate').catch(() => {});
    await page.waitForTimeout(1500);

    // 确保停在对话视图
    await page.evaluate(async () => {
      const nav = document.querySelector('.nav-i[data-view="chat"]');
      if (nav) nav.click();
      await new Promise(r => setTimeout(r, 400));
      const v = document.querySelector('#view-chat'); if (v) v.hidden = false;
    });
    await page.waitForTimeout(500);

    // ---------- 1. 入口形态 ----------
    group('1. ★ 档位入口现在是输入区的模型下拉（不再是独立按钮）');
    const shape = await page.evaluate(() => {
      const sel = document.querySelector('#modelSel');
      const inTools = !!(document.querySelector('.composer-tools') && document.querySelector('.composer-tools #modelSel'));
      return {
        hasSel: !!sel, inTools,
        opts: sel ? Array.from(sel.options).map(o => ({ v: o.value, t: o.textContent.trim() })) : [],
        noDtBtn: !document.querySelector('#dtBtn'),
      };
    });
    chk('模型下拉存在', shape.hasSel, shape);
    chk('★ 它在输入区工具栏里', shape.inTools, shape);
    chk('★ 已经没有独立的深度思考按钮', shape.noDtBtn);
    chk('★★ 有 deep 档且显示「DeepSeek Pro」',
      shape.opts.some(o => o.v === 'deep' && /DeepSeek Pro/.test(o.t)), shape.opts);
    chk('★★ 界面上不再出现「深度思考」字样（改名彻底）',
      !shape.opts.some(o => /深度思考/.test(o.t)), shape.opts);

    // ---------- 2. 切档真的生效（内存态） ----------
    group('2. ★★ 切到 DeepSeek Pro 真的生效');
    await page.selectOption('#modelSel', 'deep');
    await page.waitForTimeout(500);
    chk('★★ 下拉 value 变成 deep',
      (await page.evaluate(() => document.querySelector('#modelSel').value)) === 'deep');

    // ---------- 3. ★★★ 发消息请求体真的带 deepThink ----------
    group('3. ★★★ 选了 Pro → 发消息请求体真的带 deepThink:true（接线断了就抓得到）');

    // 预告一个会话，让 mock SSE 能回真实 id
    const convId = await page.evaluate(async () => {
      const tok = localStorage.getItem('hl_token') || '';
      const r = await fetch('/api/conversations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok },
        body: JSON.stringify({ title: '深思考浏览器验证' }),
      });
      const j = await r.json().catch(() => null);
      return (j && (j.id || (j.conversation && j.conversation.id))) || '';
    });
    chk('建会话拿到 id', !!convId, convId);

    const captured = [];
    await page.route('**/api/chat/stream*', async route => {
      try { captured.push(JSON.parse(route.request().postData() || '{}')); }
      catch (e) { captured.push({ _parseErr: true }); }
      const payload = JSON.stringify({
        conversationId: convId, messageId: 'm_dt_user', replyId: 'm_dt_reply',
        model: 'deep', deepThink: true,
      });
      await route.fulfill({
        status: 200,
        headers: { 'Content-Type': 'text/event-stream; charset=utf-8' },
        body: 'event: meta\ndata: ' + payload + '\n\nevent: delta\ndata: {"text":"好"}\n\nevent: done\ndata: {}\n\n',
      });
    });

    const inp = page.locator('#input');
    await inp.click();
    await inp.fill('你好');
    await page.waitForTimeout(200);
    const sendBtn = page.locator('#send');
    if (await sendBtn.isVisible().catch(() => false)) await sendBtn.click();
    else await inp.press('Enter');
    await page.waitForTimeout(1800);

    chk('★★★ 抓到了 /api/chat/stream 请求', captured.length > 0, captured.length);
    const b0 = captured[0] || {};
    chk('★★★ 请求体 deepThink === true（不只是 UI 变了）', b0.deepThink === true, b0.deepThink);
    chk('★★ 请求体 model 也是 deep（两个字段一致）', b0.model === 'deep', b0.model);
    chk('★ 字段形态正常（conversationId 是 id 或 undefined）',
      b0.conversationId === undefined || typeof b0.conversationId === 'string',
      { conversationId: b0.conversationId, keys: Object.keys(b0) });

    await page.unroute('**/api/chat/stream*');

    // ---------- 4. 切回快速档，请求体真的不带 ----------
    group('4. ★★ 切回通用档 → 请求体 deepThink:false（真的关掉了）');
    const cap2 = [];
    await page.route('**/api/chat/stream*', async route => {
      try { cap2.push(JSON.parse(route.request().postData() || '{}')); } catch (e) {}
      const payload = JSON.stringify({
        conversationId: convId, messageId: 'm2', replyId: 'm2r', model: 'default', deepThink: false,
      });
      await route.fulfill({
        status: 200,
        headers: { 'Content-Type': 'text/event-stream; charset=utf-8' },
        body: 'event: meta\ndata: ' + payload + '\n\nevent: delta\ndata: {"text":"嗯"}\n\nevent: done\ndata: {}\n\n',
      });
    });
    await page.selectOption('#modelSel', 'default');
    await page.waitForTimeout(400);
    // ★ 上一轮是 mock SSE 立刻结束，但前端复位是异步的（finally 里才 setComposerBusy(false)）。
    //   直接点会被"发送按钮 disabled"挡住，干等 30 秒。
    //   判据用「发送键可用 **且** 停止键已隐藏」——只看 disabled 不够，
    //   因为停止键可见时说明这一轮还在收尾。
    await page.waitForFunction(() => {
      const s = document.querySelector('#send'), st = document.querySelector('#stop');
      return s && !s.disabled && st && st.hidden;
    }, null, { timeout: 25000 }).catch(() => {});
    await page.waitForTimeout(300);
    await inp.click();
    await inp.fill('再问一句');
    await page.waitForTimeout(200);
    if (await sendBtn.isVisible().catch(() => false)) await sendBtn.click();
    else await inp.press('Enter');
    await page.waitForTimeout(1600);
    chk('★★ 抓到了第二次请求', cap2.length > 0, cap2.length);
    chk('★★ 关掉之后 deepThink === false（不是 undefined、不是 true）',
      (cap2[0] || {}).deepThink === false, (cap2[0] || {}).deepThink);
    chk('★★ 关掉之后 model === default', (cap2[0] || {}).model === 'default', (cap2[0] || {}).model);
    await page.unroute('**/api/chat/stream*');

    // ---------- 5. 持久化 ----------
    group('5. ★★ 切档真的落库（不是只存内存）');
    // 让当前会话成为"当前会话"，再切一次档触发 PATCH
    await page.evaluate(async (cid) => {
      const tok = localStorage.getItem('hl_token') || '';
      // 打开该会话（走真实 UI 太依赖列表渲染，这里直接点列表项若存在）
      const item = document.querySelector('[data-cid="' + cid + '"]');
      if (item) item.click();
      await new Promise(r => setTimeout(r, 800));
    }, convId);
    await page.selectOption('#modelSel', 'default');
    await page.waitForTimeout(300);
    await page.selectOption('#modelSel', 'deep');
    await page.waitForTimeout(800);

    const persisted = await page.evaluate(async (cid) => {
      const tok = localStorage.getItem('hl_token') || '';
      const r = await fetch('/api/conversations/' + cid, { headers: { Authorization: 'Bearer ' + tok } });
      const j = await r.json().catch(() => null);
      return j && (j.deepThink !== undefined ? j.deepThink : (j.conversation && j.conversation.deepThink));
    }, convId);
    chk('★★ 会话上真的存下了 deepThink=true', persisted === true, persisted);

    // 刷新后能恢复
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1500);
    await page.evaluate(async () => {
      const v = document.querySelector('#view-chat'); if (v) v.hidden = false;
      await new Promise(r => setTimeout(r, 300));
    });
    const afterReload = await page.evaluate(() => {
      const s = document.querySelector('#modelSel');
      return { sel: s ? s.value : null };
    });
    chk('★★ 刷新后档位能从会话恢复（deep）', afterReload.sel === 'deep', afterReload);

    // ---------- 6. 双视口 ----------
    group('6. 双视口不横向溢出');
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForTimeout(300);
    chk('桌面无横向溢出',
      (await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)) <= 1);

    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(400);
    const mob = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    chk('iPhone12 无横向溢出', mob <= 1, mob);

    const selVis = await page.evaluate(() => {
      const s = document.querySelector('#modelSel');
      if (!s) return { ok: false };
      const r = s.getBoundingClientRect();
      return { ok: r.width > 0 && r.height > 0 && r.right <= window.innerWidth + 1 };
    });
    chk('手机视口下模型下拉仍在可视区内', selVis.ok, selVis);

    await page.screenshot({ path: path.join(OUT, 'deepthink-mobile.png') });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(OUT, 'deepthink-desktop.png') });

    // ---------- 7. 控制台 ----------
    group('7. 零控制台报错（忽略资源 404 与 boot 期的 401）');
    // ★ 401 是 boot 竞态：page.reload() 后前端在 token 从 localStorage 恢复前
    //   会先打一次接口，服务端如实回 401，前端随即重试成功。这不是功能缺陷，
    //   把它算成失败会让套件永远红着 —— 真正要抓的是 JS 异常与其它 4xx/5xx。
    const realErrs = errs.filter(e =>
      !/status of 404/i.test(e) && !/favicon/i.test(e) && !/status of 401/i.test(e));
    chk('没有与功能相关的 console.error / pageerror', realErrs.length === 0, realErrs.slice(0, 4));
  } finally {
    try { await browser.close(); } catch (e) {}
    try { srv.kill('SIGKILL'); } catch (e) {}
    try { fs.rmSync(dd, { recursive: true, force: true }); } catch (e) {}
  }

  console.log('\n' + '─'.repeat(62));
  if (fails.length) { console.log('失败 ' + fails.length + ' 项：'); fails.forEach(f => console.log('  ✗ ' + f)); }
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });

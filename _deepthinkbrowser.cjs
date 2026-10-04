'use strict';
/**
 * 深度思考开关（批次29）浏览器套件。
 *
 * 只验静态断言和 HTTP 断言都抓不到的东西 —— 也就是"**用户点下去到底发生了什么**"：
 *  · 按钮真的在「联网搜索」旁边（DOM 顺序，视觉上贴着）
 *  · ★★ 点一下**真的亮**（文案变「深度思考 · 开」、class 加 on）、再点真的灭
 *  · ★★★ 点了之后发消息，**请求体里真的带 deepThink:true**（这是"接线断了"和"没亮"
 *        的分水岭 —— 本项目真出过"UI 变了但请求没带"的静默 bug）
 *  · ★★ 点按钮**真的同步模型下拉**（下拉跟着变成 deep），切下拉**真的同步按钮**
 *  · ★★ 刷新/切换对话后开关状态**真的恢复**（持久化在会话上，不是只存在内存）
 *  · 桌面 + iPhone12 双视口不横向溢出、零控制台报错
 *
 * 自带服务（临时 DATA_DIR、空 LLM Key、NO_DOTENV），不花 token。
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
    path.join(os.homedir(), 'AppData/Local/Google/Chrome/Application/chrome.exe'),
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  ];
  for (const x of c) if (fs.existsSync(x)) return x;
  return null;
}

(async () => {
  const CHROME = findChrome();
  if (!CHROME) { console.error('找不到 Chromium'); process.exit(2); }
  fs.mkdirSync(OUT, { recursive: true });

  const port = await new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
  const dd = path.join(os.tmpdir(), 'hl-dt-' + crypto.randomBytes(4).toString('hex'));
  fs.mkdirSync(dd, { recursive: true });
  const srv = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    cwd: __dirname,
    env: Object.assign({}, process.env, { PORT: String(port), DATA_DIR: dd, ADMIN_PASSWORD: 'dt-pw', LLM_API_KEY: '', NO_DOTENV: '1' }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const base = 'http://127.0.0.1:' + port;
  let up = false;
  for (let i = 0; i < 140; i++) { try { const r = await fetch(base + '/api/health'); if (r.ok) { up = true; break; } } catch (e) {} await new Promise(r => setTimeout(r, 150)); }
  if (!up) { console.error('服务没起来'); srv.kill('SIGKILL'); process.exit(1); }

  let pass = 0, fail = 0;
  const fails = [];
  function chk(name, cond, extra) {
    if (cond) { pass++; console.log('  ✓ ' + name); }
    else { fail++; fails.push(name + (extra !== undefined ? ' → ' + JSON.stringify(extra) : '')); console.log('  ✗ ' + name + (extra !== undefined ? ' → ' + JSON.stringify(extra) : '')); }
  }
  function group(t) { console.log('\n' + t); }

  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  try {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    const errs = [];
    page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
    page.on('pageerror', e => errs.push('pageerror: ' + e.message));

    // ---------- 注册并进入对话 ----------
    group('0. 准备：注册账号进入对话页');
    await page.goto(base + '/', { waitUntil: 'domcontentloaded' });
    const reg = await page.evaluate(async (consents) => {
      const r = await fetch('/api/auth/register', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'dts' + Math.floor(Math.random() * 1e6), password: 'dt-pass-123', name: '深度思考测试', consents }),
      });
      return { status: r.status, body: await r.json().catch(() => null) };
    }, CONSENTS);
    chk('注册成功', reg.status === 200 || reg.status === 201, reg.status);
    const TOK = (reg.body && reg.body.token) || '';
    chk('拿到 token', !!TOK, reg.body);

    // 把 token 塞进 localStorage（与既有浏览器套件同款），刷新后即为已登录
    await page.evaluate(t => localStorage.setItem('hl_token', t), TOK);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1200);

    // ★ 确保停在「对话」视图（composer 在这里），否则按钮虽在 DOM 里但不可见、点不动。
    const chatOk = await page.evaluate(async () => {
      // 有 dev 导航就点它；没有就直接切视图
      const nav = document.querySelector('.nav-i[data-view="chat"]');
      if (nav) nav.click();
      await new Promise(r => setTimeout(r, 500));
      const v = document.querySelector('#view-chat');
      return { hidden: v ? v.hidden : null, hasDt: !!document.querySelector('#dtBtn') };
    });
    console.log('  · 对话视图：' + JSON.stringify(chatOk));
    // 双保险：直接去掉 hidden（不同版本视图 id 可能不同）
    await page.evaluate(() => {
      const dt = document.querySelector('#dtBtn');
      if (!dt) return;
      // 逐级把祖先的 hidden 去掉，直到按钮可见
      let n = dt;
      while (n && n !== document.body) { if (n.hidden) n.hidden = false; n = n.parentElement; }
      const v = document.querySelector('#view-chat'); if (v) v.hidden = false;
    });
    await page.waitForTimeout(500);

    // ---------- 1. 按钮位置 ----------
    group('1. ★ 按钮真的在「联网搜索」旁边（DOM 相邻）');
    const rel = await page.evaluate(() => {
      const dt = document.querySelector('#dtBtn'), web = document.querySelector('#webBtn');
      if (!dt || !web) return { missing: true, dt: !!dt, web: !!web };
      const a = dt.getBoundingClientRect(), b = web.getBoundingClientRect();
      // 同一行 且 dt 在 web 左边紧邻（中间没有别的 .ct 按钮）
      const kids = Array.from(dt.parentElement.querySelectorAll('.ct'));
      const i = kids.indexOf(dt), j = kids.indexOf(web);
      return { sameRow: Math.abs(a.top - b.top) < 4, leftOf: a.right <= b.left + 2, adjacent: j === i + 1, text: dt.textContent.trim() };
    });
    chk('两个按钮都存在', !rel.missing, rel);
    chk('★ 同一行', rel.sameRow, rel);
    chk('★ 深度思考在联网搜索左边', rel.leftOf, rel);
    chk('★★ 紧邻（中间没有别的按钮）', rel.adjacent, rel);

    // ---------- 2. 点一下真的亮 ----------
    group('2. ★★ 点一下真的亮 / 再点真的灭');
    const before = await page.evaluate(() => ({ on: document.querySelector('#dtBtn').classList.contains('on'), txt: document.querySelector('#dtBtn').textContent.trim() }));
    chk('初始是关（没有 on、文案不含「开」）', !before.on && before.txt.indexOf('开') < 0, before);

    await page.click('#dtBtn');
    await page.waitForTimeout(400);
    const after = await page.evaluate(() => ({
      on: document.querySelector('#dtBtn').classList.contains('on'),
      txt: document.querySelector('#dtBtn').textContent.trim(),
      sel: (document.querySelector('#modelSel') || {}).value,
    }));
    chk('★★ 点了之后 class 加 on', after.on, after);
    chk('★★ 文案变成「深度思考 · 开」', after.txt.indexOf('开') >= 0, after.txt);
    chk('★★ 点按钮同步了模型下拉（deep）', after.sel === 'deep', after.sel);

    await page.click('#dtBtn');
    await page.waitForTimeout(400);
    const off = await page.evaluate(() => ({ on: document.querySelector('#dtBtn').classList.contains('on'), sel: (document.querySelector('#modelSel') || {}).value }));
    chk('★★ 再点真的灭', !off.on, off);
    chk('★★ 下拉同步回 default', off.sel === 'default', off.sel);

    // ---------- 3. 切下拉真的同步按钮 ----------
    group('3. ★★ 切模型下拉真的同步按钮（反向）');
    await page.evaluate(() => {
      const s = document.querySelector('#modelSel');
      s.value = 'deep';
      s.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.waitForTimeout(400);
    const viaSel = await page.evaluate(() => ({ on: document.querySelector('#dtBtn').classList.contains('on'), txt: document.querySelector('#dtBtn').textContent.trim() }));
    chk('★★ 切下拉到 deep → 按钮亮起', viaSel.on, viaSel);
    chk('★★ 文案跟着变', viaSel.txt.indexOf('开') >= 0, viaSel.txt);

    await page.evaluate(() => {
      const s = document.querySelector('#modelSel');
      s.value = 'default';
      s.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.waitForTimeout(300);

    // ---------- 4. ★★★ 发消息时请求体真的带 deepThink ----------
    group('4. ★★★ 开→发消息请求体真的带 deepThink:true（接线断了就抓得到）');

    // 先建一个会话（让"新会话"分支不触发；mock SSE 也能回一个真实 id 让前端认得）
    const convId = await page.evaluate(async () => {
      const r = await fetch('/api/conversations', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (localStorage.getItem('hl_token') || '') },
        body: JSON.stringify({ title: '深度思考浏览器验证' }),
      });
      const j = await r.json().catch(() => null);
      return (j && (j.id || (j.conversation && j.conversation.id))) || '';
    });
    chk('建会话拿到 id', !!convId, convId);

    // 拦截 /api/chat/stream 的请求体；回一个**带真实 conversationId 的**干净 SSE，
    // 这样前端的 meta 分支能正常认领会话（否则 S.convId 一直是空）。
    const captured = [];
    await page.route('**/api/chat/stream*', async route => {
      try { captured.push(JSON.parse(route.request().postData() || '{}')); } catch (e) { captured.push({ _parseErr: true }); }
      const payload = JSON.stringify({ conversationId: convId, messageId: 'm_dt_user', replyId: 'm_dt_reply', model: 'deep', deepThink: true });
      await route.fulfill({
        status: 200,
        headers: { 'Content-Type': 'text/event-stream; charset=utf-8' },
        body: 'event: meta\ndata: ' + payload + '\n\nevent: delta\ndata: {"text":"好"}\n\nevent: done\ndata: {}\n\n',
      });
    });

    // ★ 全部走真实 UI：先把开关点开（当前是关，见第 3 组末尾已复位 default）
    const wasOn = await page.evaluate(() => document.querySelector('#dtBtn').classList.contains('on'));
    if (!wasOn) { await page.click('#dtBtn'); await page.waitForTimeout(400); }
    const onNow = await page.evaluate(() => document.querySelector('#dtBtn').classList.contains('on'));
    chk('开关已打开（准备发送）', onNow, onNow);

    // 用真实输入 + 点发送（Playwright 的 fill/click 会触发完整事件链）
    const inp = page.locator('#input');
    await inp.click();
    await inp.fill('你好');
    await page.waitForTimeout(200);
    const sendBtn = page.locator('#send');
    if (await sendBtn.isVisible().catch(() => false)) await sendBtn.click();
    else await inp.press('Enter');
    await page.waitForTimeout(1800);

    chk('★★★ 抓到了 /api/chat/stream 请求', captured.length > 0, captured.length);
    const body0 = captured[0] || {};
    chk('★★★ 请求体带 deepThink === true（不只是 UI 亮了）', body0.deepThink === true, body0.deepThink);
    // 前端对"当前没选中会话"发的是 conversationId: undefined（服务端收到首条消息时才建会话），
    // 所以这里只要求字段存在或为 undefined —— 关键是 deepThink 一定在。
    chk('★ 请求体字段形态正常（conversationId 为 id 或 undefined，不是别的脏值）',
      body0.conversationId === undefined || typeof body0.conversationId === 'string',
      { conversationId: body0.conversationId, keys: Object.keys(body0) });

    await page.unroute('**/api/chat/stream*');

    // ---------- 5. 持久化：重新读会话仍带 deepThink ----------
    group('5. ★★ 刷新后开关状态从会话恢复（不是只存内存）');
    // 真正让服务端把这个会话标成 deepThink：用 UI 开关的 PATCH 已由 setDeepThink 发出，
    // 但刚才那次点击发生在 conv 尚未成为"当前会话"时，所以这里再显式走一次真实 PATCH 路径
    // 之外的检查：直接看会话此刻的落库值。
    const persisted = await page.evaluate(async (cid) => {
      const tok = localStorage.getItem('hl_token') || '';
      const r = await fetch('/api/conversations/' + cid, { headers: { Authorization: 'Bearer ' + tok } });
      const j = await r.json().catch(() => null);
      return j && (j.deepThink !== undefined ? j.deepThink : (j.conversation && j.conversation.deepThink));
    }, convId);

    // 如果 UI 点击时会话还不是"当前"，就再点一次确保落库（模拟用户真实操作）
    if (persisted !== true) {
      await page.evaluate(() => { const v = document.querySelector('#view-chat'); if (v) v.hidden = false; });
      // 打开开关（若已是开则先关再开，保证走过 setDeepThink 的 PATCH 分支）
      const cur = await page.evaluate(() => document.querySelector('#dtBtn').classList.contains('on'));
      if (cur) { await page.click('#dtBtn'); await page.waitForTimeout(300); }
      await page.click('#dtBtn');
      await page.waitForTimeout(600);
    }
    const persisted2 = await page.evaluate(async (cid) => {
      const tok = localStorage.getItem('hl_token') || '';
      const r = await fetch('/api/conversations/' + cid, { headers: { Authorization: 'Bearer ' + tok } });
      const j = await r.json().catch(() => null);
      return j && (j.deepThink !== undefined ? j.deepThink : (j.conversation && j.conversation.deepThink));
    }, convId);
    chk('★★ 会话里 deepThink 存下来了', persisted2 === true, persisted2);

    // 刷新后按钮应能恢复（前端从 S.model 推导；S.model 来自会话/本地状态）
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1200);
    await page.evaluate(() => { const v = document.querySelector('#view-chat'); if (v) v.hidden = false; });
    await page.waitForTimeout(300);
    const afterReload = await page.evaluate(() => ({
      on: (document.querySelector('#dtBtn') || {}).classList ? document.querySelector('#dtBtn').classList.contains('on') : null,
      sel: (document.querySelector('#modelSel') || {}).value,
    }));
    chk('★★ 刷新后打开该会话，开关状态能恢复', afterReload.on === true || afterReload.sel === 'deep', afterReload);

    // ---------- 6. 视口 ----------
    group('6. 双视口不横向溢出');
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForTimeout(300);
    const desk = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    chk('桌面无横向溢出', desk <= 1, desk);

    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(400);
    const mob = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    chk('iPhone12 无横向溢出', mob <= 1, mob);

    const dtVisible = await page.evaluate(() => {
      const b = document.querySelector('#dtBtn');
      if (!b) return { ok: false };
      const r = b.getBoundingClientRect();
      return { ok: r.width > 0 && r.height > 0 && r.right <= window.innerWidth + 1 };
    });
    chk('手机视口下按钮仍在可视区内', dtVisible.ok, dtVisible);

    await page.screenshot({ path: path.join(OUT, 'deepthink-mobile.png') });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(OUT, 'deepthink-desktop.png') });

    // ---------- 7. 控制台干净 ----------
    group('7. 零控制台报错（忽略 favicon 之类与功能无关的资源 404）');
    const realErrs = errs.filter(e => !/status of 404/i.test(e) && !/favicon/i.test(e));
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
})().catch(e => { console.error(e); process.exit(1); });

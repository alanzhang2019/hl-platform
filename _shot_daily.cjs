'use strict';
/**
 * 学习日报视觉快照 + 链路自检（批次10）。
 * 3 视口：建空间 → 造真实数据（走接口）→ 进看板 → 截图 → 点数字看溯源 → 写自述看草稿保存。
 */
const path = require('path');
const fsx = require('fs');
const os = require('os');
const crypto = require('crypto');
const net = require('net');
const { spawn } = require('child_process');
const { chromium } = require('playwright-core');

function findChrome() {
  if (process.env.CHROME && fsx.existsSync(process.env.CHROME)) return process.env.CHROME;
  const root = process.env.MS_PLAYWRIGHT_DIR ||
    path.join(process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Local'), 'ms-playwright');
  let best = null, bestN = -1;
  try {
    for (const d of fsx.readdirSync(root)) {
      const m = /^chromium-(\d+)$/.exec(d);
      if (!m) continue;
      const exe = path.join(root, d, 'chrome-win64', 'chrome.exe');
      if (!fsx.existsSync(exe)) continue;
      if (Number(m[1]) > bestN) { bestN = Number(m[1]); best = exe; }
    }
  } catch (e) {}
  return best;
}

const OUT = path.join(__dirname, '_shots-daily');
const VIEWPORTS = [
  { name: 'desktop', w: 1440, h: 900, mobile: false },
  { name: 'iphone12', w: 390, h: 844, mobile: true },
];

(async () => {
  const CHROME = findChrome();
  if (!CHROME) { console.error('找不到 Chromium'); process.exit(2); }
  fsx.mkdirSync(OUT, { recursive: true });

  const port = await new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
  const dd = path.join(os.tmpdir(), 'hl-daily-' + crypto.randomBytes(4).toString('hex'));
  fsx.mkdirSync(dd, { recursive: true });
  const srv = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    cwd: __dirname,
    env: Object.assign({}, process.env, { PORT: String(port), DATA_DIR: dd, ADMIN_PASSWORD: 'd-pw', LLM_API_KEY: '', NO_DOTENV: '1' }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const base = 'http://127.0.0.1:' + port;
  let up = false;
  for (let i = 0; i < 130; i++) { try { const r = await fetch(base + '/api/health'); if (r.ok) { up = true; break; } } catch (e) {} await new Promise(r => setTimeout(r, 150)); }
  if (!up) { console.error('服务没起来'); srv.kill('SIGKILL'); process.exit(1); }

  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });

  /** 进看板：窄屏侧栏是浮层，得先点汉堡拉开；桌面端侧栏常驻，直接点导航 */
  async function gotoDash(page) {
    // ★ .hamb 每个 view 里都有一个，必须限定"当前可见的 view"再取第一个。
    //   直接 locator('.hamb') 会命中多个 → isVisible() 在严格模式下抛错 →
    //   被 .catch() 吞掉 → 汉堡根本没点，然后卡在"nav 在视口外"。
    const hamb = page.locator('.view:not([hidden]) .hamb').first();
    if (await hamb.isVisible().catch(() => false)) {
      await hamb.click();
      await page.waitForTimeout(500);
    }
    await page.click('.nav-i[data-view="kb"]');
    await page.waitForTimeout(500);
    await page.click('.kb-tab[data-sub="dash"]');
    await page.waitForTimeout(1600);
  }

  /** 截图：日报很长，而它在一个 overflow:hidden 的滚动容器里 ——
   *  直接截元素会被裁到视口那一屏。先把视口撑到内容高度再截。 */
  async function shootDaily(page, vp, name) {
    const h = await page.evaluate(() => {
      const el = document.querySelector('#dailyBox');
      return el ? Math.ceil(el.getBoundingClientRect().height) : 0;
    });
    const keep = page.viewportSize();
    await page.setViewportSize({ width: vp.w, height: Math.min(Math.max(vp.h, h + 240), 6000) });
    await page.waitForTimeout(200);
    await page.locator('#dailyBox').screenshot({ path: path.join(OUT, name) });
    await page.setViewportSize(keep);
    await page.waitForTimeout(150);
  }

  for (const vp of VIEWPORTS) {
    const ctx = await browser.newContext({
      viewport: { width: vp.w, height: vp.h }, isMobile: vp.mobile, hasTouch: vp.mobile, locale: 'zh-CN',
    });
    const page = await ctx.newPage();
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#spName');
    await page.fill('#spName', '日报' + vp.name + Math.floor(Math.random() * 900 + 100));
    await page.click('#spCreate');
    await page.waitForSelector('#app', { state: 'visible' });
    await page.waitForTimeout(800);

    // 造真实数据（走正式接口，跟学生操作产生的记录同源）
    const seeded = await page.evaluate(async () => {
      const T = localStorage.getItem('hl_token');
      const H = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + T };
      const post = (p, b) => fetch(p, { method: 'POST', headers: H, body: JSON.stringify(b) }).then(r => r.json());
      const mk = (k, q, a, s) => post('/api/cards', { knowledge: k, question: q, answer: a, type: 'choice', subject: s });
      const c1 = await mk('勾股定理', '直角边 3、4，斜边多长？', '5', 'math');
      const c2 = await mk('光合作用', '产物是什么？', '氧气和有机物', 'science');
      const c3 = await mk('一般现在时第三人称', 'go 的第三人称单数？', 'goes', 'english');
      await post('/api/cards/' + c1.card.id + '/review', { result: 'wrong', studentAnswer: '我以为是 6，把 3+4 直接算了' });
      await post('/api/cards/' + c1.card.id + '/review', { result: 'wrong', studentAnswer: '这次写 7，还是记混了' });
      await post('/api/cards/' + c2.card.id + '/review', { result: 'right', studentAnswer: '氧气和有机物' });
      await post('/api/cards/' + c3.card.id + '/review', { result: 'unknown', studentAnswer: '我拿不准 go 还是 goes' });
      return { ok: true };
    });
    console.log(vp.name + ' 造数据 ' + JSON.stringify(seeded));

    // 进看板
    await gotoDash(page);
    await shootDaily(page, vp, vp.name + '-daily.png');
    console.log(vp.name + ' 日报截图 ok');

    // 点一个数字看溯源
    const numCount = await page.locator('#dailyBox .d-num').count();
    await page.locator('#dailyBox .d-num').first().click();
    await page.waitForSelector('#mask:not([hidden])', { timeout: 5000 });
    const evTitle = await page.locator('#modalTitle').innerText();
    const evRows = await page.locator('#modalBody .ev-i').count();
    await page.screenshot({ path: path.join(OUT, vp.name + '-evidence.png') });
    console.log(vp.name + ' 溯源：' + evTitle + ' / ' + evRows + ' 条（数字卡片共 ' + numCount + ' 个）');
    await page.click('#modalClose');
    await page.waitForSelector('#mask', { state: 'hidden' });

    // 写自述 → 看草稿保存
    await page.fill('#dailyBox .d-ans[data-k="goal"]', '今天想把勾股定理弄明白，结果还是记混了。');
    await page.waitForTimeout(1600);
    const hint = await page.locator('#dailySaveHint').innerText();
    console.log(vp.name + ' 草稿提示：' + hint);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#app', { state: 'visible' });
    await page.waitForTimeout(700);
    await gotoDash(page);
    const kept = await page.inputValue('#dailyBox .d-ans[data-k="goal"]');
    console.log(vp.name + ' 刷新后草稿：' + JSON.stringify(kept.slice(0, 24)));
    await shootDaily(page, vp, vp.name + '-draft.png');
    await ctx.close();
  }
  await browser.close();
  srv.kill('SIGKILL');
  await new Promise(r => setTimeout(r, 300));
  try { fsx.rmSync(dd, { recursive: true, force: true }); } catch (e) {}
  console.log('\n截图：' + OUT);
})().catch(e => { console.error('ERR ' + e.message + '\n' + e.stack); process.exit(1); });

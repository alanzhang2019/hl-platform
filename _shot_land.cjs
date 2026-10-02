'use strict';
/**
 * 落地页（空间门）视觉快照 —— 改版前 / 改版后各跑一次，当证据留档。
 * 3 视口 × 2 个 tab（创建 / 账号登录），不建空间、不写数据。
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

const TAG = process.argv[2] || 'before';
const OUT = path.join(__dirname, '_shots-land-' + TAG);
const VIEWPORTS = [
  { name: 'desktop', w: 1440, h: 900, mobile: false },
  { name: 'iphone12', w: 390, h: 844, mobile: true },
  { name: 'small', w: 320, h: 568, mobile: true },
];

(async () => {
  const CHROME = findChrome();
  if (!CHROME) { console.error('找不到 Chromium'); process.exit(2); }
  fsx.mkdirSync(OUT, { recursive: true });

  const port = await new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
  const dd = path.join(os.tmpdir(), 'hl-land-' + crypto.randomBytes(4).toString('hex'));
  fsx.mkdirSync(dd, { recursive: true });
  const srv = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    cwd: __dirname,
    env: Object.assign({}, process.env, { PORT: String(port), DATA_DIR: dd, ADMIN_PASSWORD: 'land-pw', LLM_API_KEY: '', NO_DOTENV: '1' }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const base = 'http://127.0.0.1:' + port;
  let up = false;
  for (let i = 0; i < 130; i++) { try { const r = await fetch(base + '/api/health'); if (r.ok) { up = true; break; } } catch (e) {} await new Promise(r => setTimeout(r, 150)); }
  if (!up) { console.error('服务没起来'); srv.kill('SIGKILL'); process.exit(1); }

  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  const report = [];
  for (const vp of VIEWPORTS) {
    const ctx = await browser.newContext({
      viewport: { width: vp.w, height: vp.h }, isMobile: vp.mobile, hasTouch: vp.mobile, locale: 'zh-CN',
    });
    const page = await ctx.newPage();
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#spName');
    await page.waitForTimeout(700);

    // ★ 判据：把 .land 滚到 0 之后，抬头还在不在可视区（top >= 0）。
    //   align-items:center 的坑是——内容超高时顶部被推到负区**且滚不回来**，
    //   此时 colTopAt0 < 0。这正是我要防的那件事。
    //   （别用 scrollHeight 当判据：flex 的 auto margin 会被算进可滚动区，读数虚高。）
    const probe = () => page.evaluate(() => {
      const land = document.querySelector('#land');
      const col = document.querySelector('.land-col');
      land.scrollTop = 0;
      const at0 = Math.round(col.getBoundingClientRect().top);
      const h = Math.round(col.getBoundingClientRect().height);
      const maxScroll = land.scrollHeight - land.clientHeight;
      const tabs = Array.from(document.querySelectorAll('.land-tab'))
        .map(t => t.textContent.trim() + '=' + Math.round(t.getBoundingClientRect().height));
      const footLinks = Array.from(document.querySelectorAll('.land-legal a'))
        .map(a => a.textContent.trim());
      const footVisible = !!document.querySelector('.land-legal') &&
        getComputedStyle(document.querySelector('.land-legal')).display !== 'none';
      return {
        colTopAt0: at0, colH: h, maxScroll: maxScroll,
        topReachable: at0 >= 0,
        hasHScroll: land.scrollWidth > land.clientWidth ||
          document.documentElement.scrollWidth > document.documentElement.clientWidth,
        tabH: tabs.join(' '), footLinks: footLinks, footVisible: footVisible,
      };
    });

    const m = await probe();
    report.push(Object.assign({ vp: vp.name, tab: 'create' }, m));
    console.log(vp.name + ' ok  ' + vp.w + '×' + vp.h +
      '  创建页：抬头top=' + m.colTopAt0 + ' 内容高=' + m.colH + ' 可滚=' + m.maxScroll +
      ' 顶部' + (m.topReachable ? '可达 ✓' : '被裁 ✗') + ' 横滚=' + m.hasHScroll);
    console.log('        tab 高度：' + m.tabH);
    console.log('        页脚合规链接：' + JSON.stringify(m.footLinks));

    // ★ 不能用 fullPage：.land 是 position:fixed + 自身 overflow:auto，
    //   文档本身不滚，fullPage 只截到视口那一屏；
    //   直接截元素也不行 —— 元素被滚动容器裁掉。所以先把视口撑到内容高度再截。
    async function shootCol(name, h) {
      const keep = page.viewportSize();
      await page.setViewportSize({ width: vp.w, height: Math.max(vp.h, Math.ceil(h) + 40) });
      await page.waitForTimeout(120);
      await page.locator('.land-col').screenshot({ path: path.join(OUT, name) });
      await page.setViewportSize(keep);
      await page.waitForTimeout(80);
    }
    await shootCol(vp.name + '-create.png', m.colH);

    // 账号 tab（合规勾选框在这里，注册面板最长）
    await page.click('.land-tab[data-tab="account"]');
    await page.click('#acctToRegister');
    await page.waitForTimeout(350);
    const m2 = await probe();
    report.push(Object.assign({ vp: vp.name, tab: 'account' }, m2));
    console.log('       账号页：内容高=' + m2.colH + ' 可滚=' + m2.maxScroll +
      ' 顶部' + (m2.topReachable ? '可达 ✓' : '被裁 ✗'));
    await shootCol(vp.name + '-account.png', m2.colH);
    await ctx.close();
  }
  fsx.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
  await browser.close();
  srv.kill('SIGKILL');
  await new Promise(r => setTimeout(r, 300));
  try { fsx.rmSync(dd, { recursive: true, force: true }); } catch (e) {}
  // 明细见 report.json
  console.log('截图：' + OUT);
})().catch(e => { console.error('ERR ' + e.message + '\n' + e.stack); process.exit(1); });

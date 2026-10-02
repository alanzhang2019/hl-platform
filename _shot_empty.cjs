'use strict';
/** 空状态视觉快照（桌面 + 手机），改版后肉眼确认用 */
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

const OUT = path.join(__dirname, '_shots-empty');
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
  const dd = path.join(os.tmpdir(), 'hl-se-' + crypto.randomBytes(4).toString('hex'));
  fsx.mkdirSync(dd, { recursive: true });
  const srv = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    cwd: __dirname,
    env: Object.assign({}, process.env, { PORT: String(port), DATA_DIR: dd, ADMIN_PASSWORD: 'se-pw', LLM_API_KEY: '', NO_DOTENV: '1' }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const base = 'http://127.0.0.1:' + port;
  let up = false;
  for (let i = 0; i < 130; i++) { try { const r = await fetch(base + '/api/health'); if (r.ok) { up = true; break; } } catch (e) {} await new Promise(r => setTimeout(r, 150)); }
  if (!up) { console.error('服务没起来'); srv.kill('SIGKILL'); process.exit(1); }

  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  for (const vp of VIEWPORTS) {
    const ctx = await browser.newContext({
      viewport: { width: vp.w, height: vp.h }, isMobile: vp.mobile, hasTouch: vp.mobile, locale: 'zh-CN',
    });
    const page = await ctx.newPage();
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#spName');
    // 空间名强制唯一 —— 三个视口必须用不同名字，否则第二个开始建不出来（#app 一直 hidden）
    await page.fill('#spName', '林知远' + vp.name);
    await page.click('#spCreate');
    await page.waitForSelector('#app', { state: 'visible' });
    await page.waitForTimeout(1000);
    await page.screenshot({ path: path.join(OUT, vp.name + '-empty.png') });

    // 点一张卡，看预填效果
    await page.click('#emptyCards .ec[data-ec="why"]');
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(OUT, vp.name + '-picked.png') });
    console.log(vp.name + ' ok  ' + vp.w + '×' + vp.h);
    await ctx.close();
  }
  await browser.close();
  srv.kill('SIGKILL');
  await new Promise(r => setTimeout(r, 300));
  try { fsx.rmSync(dd, { recursive: true, force: true }); } catch (e) {}
  console.log('截图：' + OUT);
})().catch(e => { console.error('ERR ' + e.message + '\n' + e.stack); process.exit(1); });

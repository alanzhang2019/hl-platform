'use strict';
/**
 * 截我们自己平台的界面：落地页 → 创建空间 → 对话空状态。
 * 打本地服务（隔离 DATA_DIR），不碰线上数据。
 */
const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');

function findChrome() {
  if (process.env.CHROME && fs.existsSync(process.env.CHROME)) return process.env.CHROME;
  const roots = [
    path.join(process.env.LOCALAPPDATA || '', 'ms-playwright'),
    path.join(process.env.USERPROFILE || '', 'AppData', 'Local', 'ms-playwright'),
  ];
  let best = null, bestN = -1;
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const d of fs.readdirSync(root)) {
      const m = /^chromium-(\d+)$/.exec(d);
      if (!m) continue;
      for (const sub of ['chrome-win64', 'chrome-win']) {
        const exe = path.join(root, d, sub, 'chrome.exe');
        if (fs.existsSync(exe) && Number(m[1]) > bestN) { bestN = Number(m[1]); best = exe; }
      }
    }
  }
  return best;
}

const OUT = path.join(__dirname, '_shots2');
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT);
const BASE = process.env.BASE || 'http://127.0.0.1:3399';

(async () => {
  const browser = await chromium.launch({ executablePath: findChrome(), args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN' });
  const page = await ctx.newPage();

  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(OUT, 'ours-landing.png') });

  await page.getByPlaceholder(/张小明/).first().fill('截图测试空间');
  await page.waitForTimeout(300);
  await page.click('button:has-text("创建并进入")');
  await page.waitForTimeout(4000);
  await page.screenshot({ path: path.join(OUT, 'ours-chat.png') });
  console.log('url: ' + page.url());

  const text = (await page.evaluate(() => document.body.innerText || '')).slice(0, 1500);
  console.log('--- 我们的对话页文字 ---');
  console.log(text);

  await browser.close();
})().catch(e => { console.error('ERR ' + e.message); process.exit(1); });

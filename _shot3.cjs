'use strict';
/**
 * 登录对标站，把 /chat 内部界面截下来。
 * 账号来自之前逆向时的只读探测记录（用户自己的测试账号）。
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

(async () => {
  const browser = await chromium.launch({ executablePath: findChrome(), args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN' });
  const page = await ctx.newPage();

  await page.goto('https://www.aiteen.top/login', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(6000);

  const inputs = await page.$$eval('input', els => els.map(e => ({ ph: e.placeholder, type: e.type })));
  const btns = await page.$$eval('button', els => els.map(e => (e.innerText || '').trim()).filter(Boolean));
  console.log('inputs: ' + JSON.stringify(inputs));
  console.log('buttons: ' + JSON.stringify(btns));

  await page.getByPlaceholder(/手机号|账号/).first().fill('18576723610');
  await page.getByPlaceholder(/密码/).first().fill('123459');
  await page.waitForTimeout(500);
  await page.getByRole('button', { name: '登录', exact: true }).click();

  await page.waitForTimeout(12000);
  console.log('after login url: ' + page.url());
  await page.screenshot({ path: path.join(OUT, 'aiteen-chat-in.png') });

  const text = (await page.evaluate(() => document.body.innerText || '')).slice(0, 1500);
  console.log('--- chat 页面文字 ---');
  console.log(text);

  await browser.close();
})().catch(e => { console.error('ERR ' + e.message); process.exit(1); });

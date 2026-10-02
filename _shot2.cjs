'use strict';
/**
 * 对标截图：把对标站和我们线上站的实际渲染结果抓下来。
 * 只用来看，不做任何写操作。
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

const TARGETS = [
  ['aiteen-home', 'https://www.aiteen.top/'],
  ['aiteen-chat', 'https://www.aiteen.top/chat'],
  ['ours-home', 'https://910e878611ce44c998676c3c8b9f6972.sg.agentos-app.run/'],
];

(async () => {
  const CHROME = findChrome();
  if (!CHROME) { console.error('找不到 Chromium'); process.exit(2); }
  console.log('chrome: ' + CHROME);
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text().slice(0, 100)); });

  for (const [name, url] of TARGETS) {
    errors.length = 0;
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(6000);
      await page.screenshot({ path: path.join(OUT, name + '.png') });
      const title = await page.title();
      const text = (await page.evaluate(() => document.body.innerText || '')).slice(0, 700);
      console.log('\n=== ' + name + ' ===');
      console.log('url   : ' + page.url());
      console.log('title : ' + title);
      console.log('text  : ' + text.replace(/\n+/g, ' | ').slice(0, 500));
      if (errors.length) console.log('errs  : ' + errors.slice(0, 3).join(' ;; '));
    } catch (e) {
      console.log('\n=== ' + name + ' === 失败: ' + e.message.slice(0, 150));
    }
  }

  await browser.close();
  console.log('\n截图目录: ' + OUT);
})();

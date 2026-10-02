'use strict';
/**
 * 补充采集：两边各截「知识库页」与「移动端对话页」。
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
const OUR_BASE = process.env.BASE || 'http://127.0.0.1:3399';

async function loginAiteen(page) {
  await page.goto('https://www.aiteen.top/login', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(6000);
  await page.getByPlaceholder(/手机号|账号/).first().fill('18576723610');
  await page.getByPlaceholder(/密码/).first().fill('123459');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.waitForTimeout(12000);
}

async function enterOurs(page) {
  await page.goto(OUR_BASE + '/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(1200);
  const name = '截图测试' + Math.floor(Math.random() * 9000 + 1000);
  await page.getByPlaceholder(/张小明/).first().fill(name);
  await page.click('button:has-text("创建并进入")');
  await page.waitForTimeout(3500);
}

(async () => {
  const browser = await chromium.launch({ executablePath: findChrome(), args: ['--no-sandbox'] });

  const d = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN' });
  const p1 = await d.newPage();

  await loginAiteen(p1);
  try {
    await p1.locator('text=知识库').first().click({ timeout: 8000 });
    await p1.waitForTimeout(4000);
    await p1.screenshot({ path: path.join(OUT, 'aiteen-kb.png') });
    console.log('aiteen-kb ok: ' + (await p1.evaluate(() => document.body.innerText)).replace(/\n+/g, ' | ').slice(0, 800));
  } catch (e) { console.log('aiteen-kb 失败: ' + e.message.slice(0, 100)); }

  await enterOurs(p1);
  try {
    await p1.click('button[data-view="kb"]', { timeout: 8000 });
    await p1.waitForTimeout(2500);
    await p1.screenshot({ path: path.join(OUT, 'ours-kb.png') });
    console.log('\nours-kb ok: ' + (await p1.evaluate(() => document.body.innerText)).replace(/\n+/g, ' | ').slice(0, 800));
  } catch (e) { console.log('ours-kb 失败: ' + e.message.slice(0, 100)); }

  const m = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: 'zh-CN' });
  const p2 = await m.newPage();

  await loginAiteen(p2);
  await p2.screenshot({ path: path.join(OUT, 'aiteen-chat-mobile.png') });
  console.log('\naiteen 移动端 ok');

  await enterOurs(p2);
  await p2.screenshot({ path: path.join(OUT, 'ours-chat-mobile.png') });
  console.log('ours 移动端 ok');

  await browser.close();
})().catch(e => { console.error('ERR ' + e.message); process.exit(1); });

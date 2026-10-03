// 真实浏览器验证：选中朗读按钮为什么"点了没反应"。
// 用 playwright-core + 系统 Chrome（不下载 chromium）。
// 用法：node test/_seltts-browser.mjs
// ESM 不认 NODE_PATH，所以用环境变量指路（这个包是装在工作区里的，项目本身零依赖）
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PAGE = 'file:///' + path.join(HERE, '_seltts-repro.html').replace(/\\/g, '/');
const PW_CORE = process.env.PW_CORE
  || 'file:///C:/Users/Administrator/.workbuddy-ai/binaries/node/workspace/node_modules/playwright-core/index.mjs';
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const { chromium } = await import(PW_CORE);

/** 打开某一模式，真实拖选一段文字，再点按钮；返回是否触发 click */
async function run(browser, mode) {
  const ctx = await browser.newContext({ viewport: { width: 1000, height: 700 } });
  const page = await ctx.newPage();
  await page.goto(PAGE + '?mode=' + mode);

  // 在正文段落里拖选：从行首偏左拖到偏右（同一行内，保证 anchor 落在文本节点上）
  const box = await page.locator('.md p').boundingBox();
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + 4, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.6, y, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(200);

  const hasBtn = await page.locator('#ttsBtn').count();
  let clicked = false;
  if (hasBtn) {
    await page.locator('#ttsBtn').click();
    await page.waitForTimeout(120);
    clicked = await page.evaluate(() => /PASS/.test(document.getElementById('verdict').textContent));
  }
  const verdict = await page.evaluate(() => document.getElementById('verdict').textContent);
  const log = await page.evaluate(() => document.getElementById('log').textContent);
  await ctx.close();
  return { mode, hasBtn, clicked, verdict, log };
}

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const buggy = await run(browser, 'buggy');
const fixed = await run(browser, 'fixed');
await browser.close();

for (const r of [buggy, fixed]) {
  console.log('\n══════ mode=' + r.mode + ' ══════');
  console.log('按钮是否弹出：' + (r.hasBtn ? '是' : '否'));
  console.log('点击是否生效：' + (r.clicked ? '是' : '否'));
  console.log('判定：' + r.verdict);
  console.log('--- 事件日志 ---');
  console.log(r.log);
}

const ok = buggy.hasBtn && !buggy.clicked && fixed.hasBtn && fixed.clicked;
console.log('\n══════ 结论 ══════');
console.log(ok
  ? '✅ 根因复现且修复成立：buggy 模式按钮弹出但点击无效，fixed 模式点击生效。'
  : '❌ 结论不符预期，需要重新检查（buggy.clicked=' + buggy.clicked + ', fixed.clicked=' + fixed.clicked + '）');
process.exit(ok ? 0 : 1);

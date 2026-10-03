// 线上冒烟测试：真浏览器打开 /ai/，确认能出页面、没有 JS 报错、没有资源加载失败。
// 每次部署后跑一遍 —— 静态资源换了名字或语法写坏，健康检查（只看 HTTP 状态码）是发现不了的。
//
//   node test/_smoke-live.mjs
//   URL=https://aijiangti.cn/ai/ node test/_smoke-live.mjs
import { fileURLToPath } from 'node:url';

const PW_CORE = process.env.PW_CORE
  || 'file:///C:/Users/Administrator/.workbuddy-ai/binaries/node/workspace/node_modules/playwright-core/index.mjs';
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const URL_ = process.env.URL || 'https://aijiangti.cn/ai/';
const { chromium } = await import(PW_CORE);

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errs = [];
page.on('pageerror', e => errs.push('pageerror: ' + e.message));
page.on('console', m => { if (m.type() === 'error') errs.push('console.error: ' + m.text()); });
page.on('requestfailed', r => errs.push('requestfailed: ' + r.url() + ' → ' + (r.failure() && r.failure().errorText)));

const resp = await page.goto(URL_, { waitUntil: 'networkidle', timeout: 45000 });
await page.waitForTimeout(1500);
const text = (await page.locator('body').innerText()).replace(/\s+/g, ' ');

console.log('URL      : ' + URL_);
console.log('HTTP     : ' + resp.status());
console.log('标题     : ' + await page.title());
console.log('可见文本 : ' + text.slice(0, 80));
console.log('报错     : ' + (errs.length ? '\n  ' + errs.join('\n  ') : '无'));

await browser.close();
const ok = resp.status() === 200 && errs.length === 0 && text.length > 20;
console.log('\n结论：' + (ok ? '✅ 线上页面正常' : '❌ 线上页面有问题'));
process.exit(ok ? 0 : 1);

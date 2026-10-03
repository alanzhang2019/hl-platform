// 对**真实 app.js 源码**里的「选中文字朗读」段做浏览器验证。
// 不复制代码、不手写镜像 —— 直接从 public/js/app.js 抠出那一段原样执行，
// 免得出现"测的和要发布的不是同一份代码"。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(HERE, '..', 'public', 'js', 'app.js');
// playwright-core 不在项目依赖里（本项目零依赖），用环境变量指路。
const PW_CORE = process.env.PW_CORE
  || 'file:///C:/Users/Administrator/.workbuddy-ai/binaries/node/workspace/node_modules/playwright-core/index.mjs';
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const { chromium } = await import(PW_CORE);

const src = fs.readFileSync(APP, 'utf8');
const START = '// ---------- 选中文字朗读 ----------';
const END = '// ---------- 发送（SSE 流式 + 断流恢复）----------';
const i = src.indexOf(START), k = src.indexOf(END);
if (i < 0 || k < 0 || k <= i) { console.error('没找到源码区块，标记可能被改过'); process.exit(2); }
const block = src.slice(i, k);
console.log('抠出源码区块 ' + block.length + ' 字符（' + src.slice(0, i).split('\n').length + ' 行起）');

const html = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>live</title>
<style>body{font:15px/1.7 system-ui;margin:24px}
.msg .md{border:1px solid #ddd;border-radius:8px;padding:12px;max-width:520px}
.sel-tts-btn{position:fixed;z-index:60}
#out{white-space:pre-wrap;font-family:ui-monospace,monospace;font-size:12px;background:#f4f4f6;padding:10px;border-radius:8px;margin-top:12px}</style>
</head><body>
<h3>真实 app.js 源码 · 选中朗读</h3>
<div class="msg ai"><div class="body">
  <div class="md"><p>这是一段可以被选中的文字，用来验证选中朗读按钮的行为是否正常。</p></div>
</div></div>
<div id="out">spoke: (还没朗读)</div>
<script>
window.__spoke = [];
function speakText(id, text, btn) { window.__spoke.push({ id: id, text: text }); document.getElementById('out').textContent = 'spoke: ' + JSON.stringify(window.__spoke); }
function toast(m) { window.__spoke.push({ toast: m }); }
${block}
window.__blockLoaded = true;
</script></body></html>`;

const tmp = path.join(HERE, '_seltts-live.tmp.html');
fs.writeFileSync(tmp, html, 'utf8');

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
page.on('pageerror', e => console.log('⚠️ 页面报错：' + e.message));
await page.goto('file:///' + tmp.replace(/\\/g, '/'));

const box = await page.locator('.md p').boundingBox();
const y = box.y + box.height / 2;
await page.mouse.move(box.x + 4, y);
await page.mouse.down();
await page.mouse.move(box.x + box.width * 0.6, y, { steps: 12 });
await page.mouse.up();
await page.waitForTimeout(300);

const btnCount = await page.locator('.sel-tts-btn').count();
const btnText = btnCount ? await page.locator('.sel-tts-btn').textContent() : '(无)';
console.log('浮动按钮：' + btnCount + ' 个，文案「' + btnText + '」');

let spoke = [];
if (btnCount) {
  await page.locator('.sel-tts-btn').click();
  await page.waitForTimeout(200);
  spoke = await page.evaluate(() => window.__spoke);
}
console.log('点击后 speakText 调用：' + JSON.stringify(spoke));

// 再验一次：点按钮不应把选区弄丢；点消息外面应收起按钮
let afterClickBtn = await page.locator('.sel-tts-btn').count();
console.log('点击后按钮是否收起：' + (afterClickBtn === 0 ? '是（正确）' : '否'));

await browser.close();
fs.unlinkSync(tmp);

const hit = spoke.some(s => s.text && s.text.indexOf('这是一段可以被选中的文字') === 0);
console.log('\n结论：' + (btnCount === 1 && hit && afterClickBtn === 0
  ? '✅ 真实源码通过 —— 拖选后按钮弹出、点击成功朗读选中文字、并自动收起'
  : '❌ 真实源码未通过'));
process.exit((btnCount === 1 && hit && afterClickBtn === 0) ? 0 : 1);

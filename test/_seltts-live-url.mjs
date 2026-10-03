// 从**线上真实拉取**的 app.js 里抠出「选中文字朗读」段落，丢进真浏览器跑一遍。
// 目的：线上那份是被 nginx sub_filter 重写过的，和仓库里的字节不同 ——
// 这一步证明"重写之后仍然能跑"，而不是只证明了仓库里的源码能跑。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PW_CORE = process.env.PW_CORE
  || 'file:///C:/Users/Administrator/.workbuddy-ai/binaries/node/workspace/node_modules/playwright-core/index.mjs';
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const URL_APP = process.env.APP_JS_URL || 'https://aijiangti.cn/ai/js/app.js';
const { chromium } = await import(PW_CORE);

const res = await fetch(URL_APP);
if (!res.ok) { console.error('拉不到线上 app.js：HTTP ' + res.status); process.exit(2); }
const src = await res.text();
console.log('线上 app.js：' + src.length + ' 字节');

const START = '// ---------- 选中文字朗读 ----------';
const END = '// ---------- 发送（SSE 流式 + 断流恢复）----------';
const i = src.indexOf(START), k = src.indexOf(END);
if (i < 0 || k < 0) { console.error('线上文件里没找到选中朗读区块'); process.exit(2); }
const block = src.slice(i, k);
console.log('抠出区块 ' + block.length + ' 字符');

const html = `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<style>body{font:15px/1.7 system-ui;margin:24px}
.msg .md{border:1px solid #ddd;border-radius:8px;padding:12px;max-width:520px}
.sel-tts-btn{position:fixed;z-index:60}</style></head><body>
<div class="msg ai"><div class="body"><div class="md"><p>这是一段可以被选中的文字，用来验证线上选中朗读按钮的行为是否正常。</p></div></div></div>
<div id="out">spoke: (还没朗读)</div>
<script>
window.__spoke=[];
function speakText(id,text,btn){window.__spoke.push({id:id,text:text});document.getElementById('out').textContent='spoke: '+JSON.stringify(window.__spoke);}
function toast(m){}
${block}
</script></body></html>`;

const tmp = path.join(os.tmpdir(), '_seltts-live-url.html');
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

const n = await page.locator('.sel-tts-btn').count();
console.log('浮动按钮：' + n + ' 个' + (n ? '，文案「' + await page.locator('.sel-tts-btn').textContent() + '」' : ''));
let spoke = [];
if (n) { await page.locator('.sel-tts-btn').click(); await page.waitForTimeout(200); spoke = await page.evaluate(() => window.__spoke); }
console.log('点击后 speakText：' + JSON.stringify(spoke));
const left = await page.locator('.sel-tts-btn').count();
await browser.close();
fs.unlinkSync(tmp);

const hit = spoke.some(s => s.text && s.text.indexOf('这是一段可以被选中的文字') === 0);
console.log('\n结论：' + (n === 1 && hit && left === 0
  ? '✅ 线上（经 nginx 重写后的）代码同样通过 —— 拖选弹按钮、点击朗读、自动收起'
  : '❌ 线上代码未通过'));
process.exit((n === 1 && hit && left === 0) ? 0 : 1);

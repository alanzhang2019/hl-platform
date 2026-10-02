'use strict';
/* 只看网格图长什么样：把渲染结果放进一张干净页面截图（落地页会挡住 body 上的注入元素） */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright-core');

const SHOT = process.env.HL_SHOT_DIR || path.join(os.tmpdir(), 'hl-b23-shot');
fs.mkdirSync(SHOT, { recursive: true });

function findChrome() {
  const base = path.join(process.env.LOCALAPPDATA || '', 'ms-playwright');
  const dirs = fs.readdirSync(base).filter(d => /^chromium-\d+$/.test(d)).sort().reverse();
  for (const d of dirs) {
    const p = path.join(base, d, 'chrome-win64', 'chrome.exe');
    if (fs.existsSync(p)) return p;
  }
  return '';
}

const CASES = [
  { file: '03-网格配图-方格取数.png', theme: 'light', title: '方格取数（4×4，起点 A 终点 B）', json: {
    kind: 'grid', title: '方格取数：从 A 走到 B，只能向右或向下',
    cells: [['3', '7', '5', '2'], ['1', '4', '9', '6'], ['8', '2', '1', '5'], ['4', '6', '3', '7']],
    rowLabels: ['第1行', '第2行', '第3行', '第4行'],
    colLabels: ['1列', '2列', '3列', '4列'],
    marks: [{ r: 0, c: 0, label: 'A' }, { r: 3, c: 3, label: 'B' }],
  } },
  { file: '04-网格配图-走路径.png', theme: 'light', title: '走路径（path 高亮）', json: {
    kind: 'grid', title: '一条从左上到右下的路径',
    cells: [['1', '2', '3'], ['4', '5', '6'], ['7', '8', '9']],
    path: [[0, 0], [0, 1], [1, 1], [1, 2], [2, 2]],
    marks: [{ r: 0, c: 0, label: '起' }, { r: 2, c: 2, label: '终' }],
  } },
  { file: '05-网格配图-深色.png', theme: 'dark', title: '深色模式', json: {
    kind: 'grid', title: '深色模式下的同一张方格图',
    cells: [['3', '7', '5', '2'], ['1', '4', '9', '6'], ['8', '2', '1', '5'], ['4', '6', '3', '7']],
    marks: [{ r: 0, c: 0, label: 'A' }, { r: 3, c: 3, label: 'B' }],
  } },
  { file: '06-网格配图-脏输入.png', theme: 'light', title: '脏输入（缺 kind / 行列不齐 / 空值）', json: {
    title: '脏输入也不能崩',
    cells: [['7', '3', null], [1, 'B'], ['只有一格']],
    marks: [{ r: 99, c: 99, label: '越界' }, { r: 0, c: 1, label: 'OK' }],
  } },
];

(async () => {
  const chrome = findChrome();
  if (!chrome) { console.error('没有 chromium'); process.exit(1); }
  const browser = await chromium.launch({ executablePath: chrome, args: ['--no-sandbox'] });

  for (const c of CASES) {
    const theme = c.theme;
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
    await page.setContent(`<!DOCTYPE html><html data-theme="${theme}"><head>
      <style>body{margin:0;padding:28px;background:var(--bg);font-family:'Noto Sans SC','Microsoft YaHei',system-ui,sans-serif}
      h3{font-size:14px;color:var(--dim);margin:0 0 12px;font-weight:600}</style>
      </head><body><h3>${c.title}</h3><div id="box"></div></body></html>`);
    // ★ CSS 必须内联。setContent 造出来的页面源是 about:blank，
    //   Chrome 会拒绝从它加载 file:// 子资源 —— 结果是样式全丢，
    //   var(--pri-soft) 之类全部退回黑色，出图看着像坏了，其实只是没穿衣服。
    await page.addStyleTag({ content: fs.readFileSync(path.join(process.cwd(), 'public/app.css'), 'utf8') });
    // 先注入 render.js 再渲染 —— 反过来要先抛一次异常，日志里会混进假报错
    await page.addScriptTag({ path: path.join(process.cwd(), 'public/js/render.js') });
    await page.waitForTimeout(300);
    const html = await page.evaluate((json) =>
      window.HL.render('```svg-json\n' + JSON.stringify(json) + '\n```'), c.json);
    await page.evaluate((h) => { document.getElementById('box').innerHTML = h; }, html);
    await page.waitForTimeout(600);
    const out = path.join(SHOT, c.file);
    await page.screenshot({ path: out });
    const nan = /NaN/.test(html);
    console.log((nan ? '✗ 含 NaN  ' : '✓ ') + c.file + '  ' + Math.round(html.length / 1024) + 'KB html');
    await page.close();
  }

  await browser.close();
  console.log('出图目录：' + SHOT);
})();

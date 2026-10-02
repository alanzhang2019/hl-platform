'use strict';
/**
 * 移动端布局诊断（只量不改）
 *
 * 起因：390×844 下对话页顶栏副标题被挤成竖排、溢出到顶栏按钮上。
 * 先量后定 —— 先把"到底谁溢出了、溢出多少"测出来，再决定改哪条 CSS。
 *
 * 判据：documentElement.scrollWidth 应 <= clientWidth。超出 1px 就算溢出。
 *
 * 坑：page.evaluate 传**字符串**时 Playwright 当表达式求值、**不吃第二个参数**，
 *     所以探针必须写成真正的函数再传进去（写成字符串会静默返回 undefined）。
 *
 * 跑法：NODE_PATH=.../node/workspace/node_modules node _mobilediag.cjs
 */
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

const SHOTS = path.join(__dirname, '_shots-mobile');
const NODE = process.execPath;
const ROOT = __dirname;

const VIEWPORTS = [
  { name: 'iphone12', width: 390, height: 844 },
  { name: 'small', width: 360, height: 640 },
  { name: 'ipadmini', width: 768, height: 1024 },
];

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

/* 下面三个探针会被序列化后丢进浏览器跑，所以**不能引用 Node 作用域里的任何东西**
 * （连 elLabel 这种小工具也不行 —— 序列化只带函数自己的源码）。 */
function probeOverflow(vw) {
  const lbl = el => el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') +
    (el.className && typeof el.className === 'string'
      ? '.' + el.className.trim().split(/\s+/).join('.') : '');
  const inScroller = el => {
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      const ox = getComputedStyle(p).overflowX;
      if (ox === 'auto' || ox === 'scroll') return true;
    }
    return false;
  };
  const out = [];
  for (const el of document.querySelectorAll('body *')) {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    if (cs.overflowX === 'auto' || cs.overflowX === 'scroll') continue;
    // 横滑容器**里面**的元素本来就允许滑出视口，不算溢出（否则满屏假红）
    if (inScroller(el)) continue;
    const over = Math.round(r.right - vw);
    if (over > 1) {
      out.push({
        sel: lbl(el), right: Math.round(r.right), width: Math.round(r.width), over,
        text: (el.textContent || '').trim().slice(0, 24),
      });
    }
  }
  out.sort((a, b) => b.over - a.over);
  return out.slice(0, 12);
}

/** 一个视图里可能有多个 .topbar（知识库外面一个、子面板里一个），全都要量 */
function probeTopbar() {
  const lbl = el => el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') +
    (el.className && typeof el.className === 'string'
      ? '.' + el.className.trim().split(/\s+/).join('.') : '');
  const out = [];
  for (const tb of document.querySelectorAll('.view:not([hidden]) .topbar')) {
    if (tb.closest('[hidden]')) continue;
    const box = tb.getBoundingClientRect();
    if (box.height === 0) continue;
    const kids = [];
    for (const el of tb.children) {
      const cs = getComputedStyle(el);
      if (cs.display === 'none') { kids.push({ sel: lbl(el), hidden: true }); continue; }
      const r = el.getBoundingClientRect();
      const lh = parseFloat(cs.lineHeight) || 20;
      kids.push({
        sel: lbl(el),
        w: Math.round(r.width), h: Math.round(r.height),
        left: Math.round(r.left), right: Math.round(r.right),
        lines: Math.round(r.height / lh),
        text: (el.textContent || '').trim().slice(0, 20),
      });
    }
    out.push({ topbarH: Math.round(box.height), topbarW: Math.round(box.width), kids: kids });
  }
  return out;
}

function probeSide() {
  const s = document.querySelector('.side');
  if (!s) return null;
  const r = s.getBoundingClientRect();
  return { left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width), open: s.classList.contains('open') };
}

async function enterSpace(page, name) {
  await page.goto(page._base, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#spName');
  await page.fill('#spName', name);
  await page.click('#spCreate');
  await page.waitForSelector('#app', { state: 'visible', timeout: 10000 });
  await page.waitForTimeout(900);
}

/** 移动端侧栏是浮层：点汉堡拉出来，点遮罩收回去
 *  （不能点汉堡收 —— 侧栏 280px 浮层正好盖住汉堡本身） */
async function gotoView(page, view) {
  const hamb = page.locator('.view:not([hidden]) .hamb').first();
  await hamb.click();
  await page.waitForTimeout(450);
  await page.click('.nav-i[data-view="' + view + '"]');
  await page.waitForTimeout(500);
}

async function report(page, tag) {
  const vw = await page.evaluate(() => window.innerWidth);
  const doc = await page.evaluate(() => ({
    scrollW: document.documentElement.scrollWidth,
    clientW: document.documentElement.clientWidth,
  }));
  const overflow = await page.evaluate(probeOverflow, vw);
  const topbar = await page.evaluate(probeTopbar);
  const side = await page.evaluate(probeSide);

  const overflowPx = doc.scrollW - doc.clientW;
  const maxOver = overflow.length ? overflow[0].over : 0;
  console.log('');
  console.log('  -- ' + tag + ' --');
  console.log('    视口 ' + vw + 'px | 元素级最大溢出 ' +
    (maxOver > 1 ? maxOver + 'px  [超标]' : maxOver + 'px  [ok]') +
    ' | 文档 scrollWidth ' + doc.scrollW + '（被 .app overflow:hidden 裁掉，不可作判据）');
  if (side) {
    console.log('    左栏 left=' + side.left + ' w=' + side.width + ' open=' + side.open +
      (side.left < 0 ? '  (已收起 ok)' : '  [没收起!]'));
  }
  if (topbar && topbar.length) {
    for (let i = 0; i < topbar.length; i++) {
      const tb = topbar[i];
      console.log('    顶栏[' + i + '] 高 ' + tb.topbarH + 'px | 子元素：');
      for (const k of tb.kids) {
        if (k.hidden) { console.log('      . ' + k.sel + '   display:none'); continue; }
        const warn = k.lines >= 3 ? '   [被压成 ' + k.lines + ' 行竖排!]'
          : (k.right > vw ? '   [超出视口 ' + (k.right - vw) + 'px!]' : '');
        console.log('      . ' + k.sel.padEnd(26) + ' w=' + String(k.w).padStart(4) +
          ' h=' + String(k.h).padStart(4) + ' [' + k.left + '->' + k.right + ']' + warn);
      }
    }
  }
  if (overflow.length) {
    console.log('    溢出元素：');
    for (const o of overflow) console.log('      . +' + o.over + 'px  ' + o.sel + '  「' + o.text + '」');
  }
  const maxTopbar = (topbar && topbar.length) ? Math.max.apply(null, topbar.map(t => t.topbarH)) : 0;
  return { overflowPx: maxOver, topbarH: maxTopbar };
}

(async () => {
  const CHROME = findChrome();
  if (!CHROME) { console.error('找不到 Chromium'); process.exit(2); }
  fsx.mkdirSync(SHOTS, { recursive: true });

  const port = await freePort();
  const dataDir = path.join(os.tmpdir(), 'hl-md-' + crypto.randomBytes(4).toString('hex'));
  fsx.mkdirSync(dataDir, { recursive: true });
  const srv = spawn(NODE, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      PORT: String(port), DATA_DIR: dataDir, ADMIN_PASSWORD: 'md-pw', LLM_API_KEY: '', NO_DOTENV: '1',
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const base = 'http://127.0.0.1:' + port;
  const until = Date.now() + 20000;
  let up = false;
  while (Date.now() < until) {
    try { const r = await fetch(base + '/api/health'); if (r.ok) { up = true; break; } } catch (e) {}
    await new Promise(r => setTimeout(r, 150));
  }
  if (!up) { console.error('服务没起来'); srv.kill('SIGKILL'); process.exit(1); }

  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  const results = [];
  let sidePass = 0, sideFail = 0;

  for (const vp of VIEWPORTS) {
    console.log('');
    console.log('=== ' + vp.name + '  ' + vp.width + 'x' + vp.height + ' ===');
    const ctx = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      isMobile: true, hasTouch: true, locale: 'zh-CN',
    });
    const page = await ctx.newPage();
    page._base = base;
    page.on('pageerror', e => console.log('    PAGEERROR ' + e.message));

    await enterSpace(page, '移动端诊断' + Math.floor(Math.random() * 9000 + 1000));

    // 抽屉开合：汉堡打开 → 遮罩关闭。
    // 这条很关键：侧栏浮层打开后正好盖住汉堡，如果只能靠汉堡切换，
    // 用户就会"点得到开、点不到关"。
    const sideBefore = await page.evaluate(probeSide);
    await page.locator('.view:not([hidden]) .hamb').first().click();
    await page.waitForTimeout(450);
    const sideOpen = await page.evaluate(probeSide);
    const maskOn = await page.evaluate(() => {
      const m = document.querySelector('#sideMask');
      if (!m) return null;
      const cs = getComputedStyle(m);
      return { pe: cs.pointerEvents, opacity: cs.opacity };
    });
    // 遮罩是 inset:0 全屏的，但左边 280px 被侧栏盖住 —— 得点右边没被盖的地方。
    // （点遮罩中心会被侧栏拦下，Playwright 会判定"被其它元素挡住"而超时。）
    await page.click('#sideMask', { position: { x: 340, y: 300 } });
    await page.waitForTimeout(500);
    const sideAfter = await page.evaluate(probeSide);
    console.log('    抽屉：初始 left=' + sideBefore.left +
      ' | 点汉堡 left=' + sideOpen.left + (sideOpen.left >= 0 ? ' (打开 ok)' : ' [没打开!]') +
      ' | 遮罩可点=' + (maskOn && maskOn.pe === 'auto' ? '是 ok' : '否 [FAIL]') +
      ' | 点遮罩 left=' + sideAfter.left + (sideAfter.left < 0 ? ' (收起 ok)' : ' [没收起!]'));
    if (sideOpen.left < 0 || !maskOn || maskOn.pe !== 'auto' || sideAfter.left >= 0) sideFail++; else sidePass++;

    const chat = await report(page, '对话页（空状态）');
    await page.screenshot({ path: path.join(SHOTS, vp.name + '-chat.png') });

    await gotoView(page, 'kb');
    await page.waitForSelector('#view-kb:not([hidden])');
    await page.waitForTimeout(600);
    const kb = await report(page, '知识库页');
    await page.screenshot({ path: path.join(SHOTS, vp.name + '-kb.png') });

    // 知识库子面板（项目）—— 里面还有一个独立的 .topbar。
    // 不用「能力」是因为它在阶段1 是锁的（批次7 的解锁门控），点了进不去。
    await page.click('#kbTabs .kb-tab[data-sub="projects"]').catch(() => {});
    await page.waitForTimeout(700);
    const sub = await report(page, '知识库 / 项目子面板');
    await page.screenshot({ path: path.join(SHOTS, vp.name + '-subpanel.png') });

    results.push({ vp: vp.name, chat: chat, kb: kb, sub: sub, side: [sideBefore, sideOpen, sideAfter] });
    await ctx.close();
  }

  console.log('');
  console.log('=== 汇总 ===');
  let bad = 0;
  for (const r of results) {
    for (const pair of [['对话', r.chat], ['知识库', r.kb], ['项目子面板', r.sub]]) {
      const v = pair[1];
      const flag = v.overflowPx > 1 ? '[FAIL]' : '[ok]  ';
      if (v.overflowPx > 1) bad++;
      console.log('  ' + flag + ' ' + r.vp.padEnd(10) + pair[0].padEnd(12) +
        '横向溢出 ' + v.overflowPx + 'px | 顶栏高 ' + v.topbarH + 'px');
    }
  }
  console.log('');
  console.log('  抽屉开合（汉堡开 / 遮罩关）：' + sidePass + ' 通过，' + sideFail + ' 失败');
  console.log('');
  console.log('  截图目录：' + SHOTS);

  await browser.close();
  srv.kill('SIGKILL');
  await new Promise(r => setTimeout(r, 300));
  try { fsx.rmSync(dataDir, { recursive: true, force: true }); } catch (e) {}
  process.exit(bad || sideFail ? 1 : 0);
})().catch(e => { console.error('ERR ' + e.message + '\n' + e.stack); process.exit(1); });

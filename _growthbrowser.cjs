'use strict';
/**
 * 7 阶段成长画像（批次22-③）浏览器套件。
 *
 * 只验静态断言抓不到的东西：
 *  · 雷达图**真的画出来了**（是 <svg> 且有多边形/点，不是空壳）
 *  · ★★ null 的维度在图上**画在中心 + 虚线圈**，而且**不参与多边形连线**
 *  · 「还看不出来」真的显示出来，页面上**没有 0%** 冒充
 *  · 有数据后多边形真的变了（不是画死的）
 *  · 不出现分数/排名/等级字样；零控制台报错；不横向溢出
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const net = require('net');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { chromium } = require('playwright-core');

const OUT = path.join(__dirname, '_shots-growth');

/**
 * 直接把宠物的成长值顶到能解锁「测评」的那一档。
 * ★ 为什么必须这么做：测评是**阶段 3** 才解锁的功能（pet.UNLOCKS），
 *   而成长画像挂在测评分区里。新空间点它是灰的、根本进不去 ——
 *   不顶成长值的话整套浏览器断言会在"点了没反应"上集体假红。
 * 判据：小树 need=90 ⇒ 给 120 稳过。
 *
 * ★ 实现方式：**在本进程内直连那个 SQLite 文件**，不要 spawn 子进程。
 *   实测 `execFileSync(process.execPath, …)` 在本沙箱里报 EBUSY
 *   （正在运行的 node.exe 不让再被 spawn）。
 */
function bumpPet(dd, spaceId) {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(path.join(dd, 'app.db'));
  try {
    db.prepare('UPDATE pets SET growth = 120 WHERE space_id = ?').run(spaceId);
  } finally { db.close(); }
}

function findChrome() {
  const c = [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    path.join(os.homedir(), 'AppData/Local/Google/Chrome/Application/chrome.exe'),
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  ];
  for (const x of c) if (fs.existsSync(x)) return x;
  return null;
}

const VIEWPORTS = [
  { name: 'desktop', w: 1440, h: 900, mobile: false },
  { name: 'iphone12', w: 390, h: 844, mobile: true },
];

(async () => {
  const CHROME = findChrome();
  if (!CHROME) { console.error('找不到 Chromium'); process.exit(2); }
  fs.mkdirSync(OUT, { recursive: true });

  const port = await new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
  const dd = path.join(os.tmpdir(), 'hl-growth-shot-' + crypto.randomBytes(4).toString('hex'));
  fs.mkdirSync(dd, { recursive: true });
  const srv = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    cwd: __dirname,
    env: Object.assign({}, process.env, { PORT: String(port), DATA_DIR: dd, ADMIN_PASSWORD: 'g-pw', LLM_API_KEY: '', NO_DOTENV: '1' }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const base = 'http://127.0.0.1:' + port;
  let up = false;
  for (let i = 0; i < 140; i++) { try { const r = await fetch(base + '/api/health'); if (r.ok) { up = true; break; } } catch (e) {} await new Promise(r => setTimeout(r, 150)); }
  if (!up) { console.error('服务没起来'); srv.kill('SIGKILL'); process.exit(1); }

  const results = [];
  function chk(name, cond, extra) {
    results.push({ name, ok: !!cond });
    console.log((cond ? '  ✓ ' : '  ✗ ') + name + (cond ? '' : (extra !== undefined ? ' → ' + JSON.stringify(extra) : '')));
  }

  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });

  // ---------- 场景 A：空空间（六维全 null）----------
  console.log('\n=== 场景 A：空空间（全 null）===');
  {
    const sp = await (await fetch(base + '/api/space', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: '空画像', passcode: '' }) })).json();
    // 让宠物先被 ensure() 建出来，再顶成长值解锁「测评」
    await (await fetch(base + '/api/pet', { headers: { Authorization: 'Bearer ' + sp.token } })).text();
    bumpPet(dd, sp.spaceId);
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errs = [];
    page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
    page.on('pageerror', e => errs.push(String(e)));
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.evaluate(t => localStorage.setItem('hl_token', t), sp.token);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.querySelectorAll('#kbTabs .kb-tab').length > 0, null, { timeout: 30000 });
    await page.click('.nav-i[data-view="kb"]');
    await page.waitForFunction(() => { const v = document.querySelector('#view-kb'); return v && !v.hidden; }, null, { timeout: 8000 });
    const exTab = await page.$('#kbTabs [data-sub="exam"]');
    if (exTab) await exTab.click();
    await page.waitForFunction(() => {
      const b = document.querySelector('#growthBox');
      return b && !b.querySelector('.skel') && b.innerHTML.length > 50;
    }, null, { timeout: 20000 }).catch(() => {});

    const g = await page.evaluate(() => {
      const box = document.querySelector('#growthBox');
      return {
        has: !!box,
        txt: box ? box.innerText : '',
        svg: box ? box.querySelectorAll('svg.g-radar').length : 0,
        polys: box ? box.querySelectorAll('svg.g-radar polygon').length : 0,
        dashedDots: box ? box.querySelectorAll('svg.g-radar circle[stroke-dasharray]').length : 0,
        solidDots: box ? box.querySelectorAll('svg.g-radar circle:not([stroke-dasharray])').length : 0,
        naCount: (box ? box.innerText : '').split('还看不出来').length - 1,
        steps: box ? box.querySelectorAll('.g-step').length : 0,
        onSteps: box ? box.querySelectorAll('.g-step.on').length : 0,
      };
    });
    chk('画像区渲染出来了', g.has && g.txt.length > 20, g.txt.slice(0, 40));
    chk('★★ 雷达是原生 <svg>（不是图片）', g.svg >= 1, g.svg);
    chk('★ 图里有网格多边形（真画了，不是空壳）', g.polys >= 4, g.polys);
    chk('★★ 空空间：6 个维度都画成虚线圈（null 的视觉标记）', g.dashedDots === 6, g.dashedDots);
    chk('★★ 空空间：没有实心点（一个都没算出来）', g.solidDots === 0, g.solidDots);
    chk('★★ 六处都写了「还看不出来」', g.naCount === 6, g.naCount);
    chk('★★ 页面上没有 "0%" 冒充算不出来的维度', !/0%/.test(g.txt.replace(/上一段|对比/g, '')), g.txt.slice(0, 120));
    chk('★ 7 步阶梯都在', g.steps === 7, g.steps);
    chk('★ 空空间：0 步走到', g.onSteps === 0, g.onSteps);
    chk('★ 明说不给分数', /不给分数|不给排名/.test(g.txt), g.txt.slice(0, 200));
    // 不横向溢出
    const of = await page.evaluate(vw => {
      const bad = [];
      document.querySelectorAll('#growthBox *').forEach(el => {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.right > vw + 1) bad.push(String(el.className).slice(0, 30));
      });
      return bad.slice(0, 4);
    }, 1440);
    chk('没有元素越过右边界', of.length === 0, of);
    chk('零控制台报错', errs.length === 0, errs.slice(0, 2));

    const h = await page.evaluate(() => { const b = document.querySelector('#growthBox'); return b ? Math.min(b.scrollHeight + 40, 2600) : 800; });
    await page.setViewportSize({ width: 1440, height: Math.max(900, h) });
    await page.waitForTimeout(250);
    const el = await page.$('#growthBox');
    if (el) await el.screenshot({ path: path.join(OUT, 'growth-empty.png') });
    chk('空空间截图已产出', fs.existsSync(path.join(OUT, 'growth-empty.png')));
    await page.close();
  }

  // ---------- 场景 B：有数据（部分维度算得出来）----------
  console.log('\n=== 场景 B：有痕迹（部分维度算得出来）===');
  for (const vp of VIEWPORTS) {
    const sp = await (await fetch(base + '/api/space', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: '有数据 ' + vp.name, passcode: '' }) })).json();
    await (await fetch(base + '/api/pet', { headers: { Authorization: 'Bearer ' + sp.token } })).text();
    bumpPet(dd, sp.spaceId);
    const H = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + sp.token };
    // 建 3 张卡，都复习，其中 2 张给 solid verdict
    for (let i = 0; i < 3; i++) {
      const c = await (await fetch(base + '/api/cards', { method: 'POST', headers: H, body: JSON.stringify({ knowledge: '知识点' + i, question: 'q', answer: 'a', type: 'choice', subject: 'math' }) })).json();
      const cid = c.card.id;
      await fetch(base + '/api/cards/' + cid + '/review', { method: 'POST', headers: H, body: JSON.stringify({ result: i === 0 ? 'wrong' : 'right', studentAnswer: 'x' }) });
    }
    const page = await browser.newPage({ viewport: { width: vp.w, height: vp.h }, isMobile: vp.mobile, hasTouch: vp.mobile });
    const errs = [];
    page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
    page.on('pageerror', e => errs.push(String(e)));
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.evaluate(t => localStorage.setItem('hl_token', t), sp.token);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.querySelectorAll('#kbTabs .kb-tab').length > 0, null, { timeout: 30000 });
    // ★ 移动端：抽屉**只在进知识库之前拉开一次**，之后一直开着。
    //   再点一次汉堡会把它切到关闭、但 .nav 仍拦着点击（实测 "intercepts pointer events" 卡 30 秒）。
    //   宽屏不需要抽屉。
    let onKb = false;
    for (let a = 0; a < 4 && !onKb; a++) {
      if (vp.mobile && a > 0) { await page.locator('.view:not([hidden]) .hamb').first().click(); await page.waitForTimeout(320); }
      await page.click('.nav-i[data-view="kb"]').catch(() => {});
      try {
        await page.waitForFunction(() => { const v = document.querySelector('#view-kb'); return v && !v.hidden; }, null, { timeout: 4000 });
        onKb = true;
      } catch (e) {}
    }
    const exTab = await page.$('#kbTabs [data-sub="exam"]');
    if (exTab) await exTab.click();
    await page.waitForFunction(() => {
      const b = document.querySelector('#growthBox');
      return b && !b.querySelector('.skel') && b.querySelector('svg.g-radar');
    }, null, { timeout: 20000 }).catch(() => {});

    const g = await page.evaluate(() => {
      const box = document.querySelector('#growthBox');
      const svg = box ? box.querySelector('svg.g-radar') : null;
      const label = box ? box.querySelector('.g-step.on') : null;
      return {
        txt: box ? box.innerText : '',
        polys: svg ? svg.querySelectorAll('polygon').length : 0,   // 4 圈网格 + 1 数据面 = 5
        dashedDots: svg ? svg.querySelectorAll('circle[stroke-dasharray]').length : 0,
        solidDots: svg ? svg.querySelectorAll('circle:not([stroke-dasharray])').length : 0,
        onSteps: box ? box.querySelectorAll('.g-step.on').length : 0,
        nextSteps: box ? box.querySelectorAll('.g-step.next').length : 0,
        hasOkBadge: box ? !!box.querySelector('.g-ok') : false,
      };
    });
    chk('[' + vp.name + '] 有数据：出现实心点（维度算出来了）', g.solidDots >= 3, g.solidDots);
    chk('[' + vp.name + '] ★★ 有数据的轴参与连线 ⇒ 多边形从 4 圈变成 5 个', g.polys === 5, g.polys);
    chk('[' + vp.name + '] ★ null 的维度仍画成虚线圈（与实心点并存）', g.dashedDots >= 1, g.dashedDots);
    chk('[' + vp.name + '] ★ 有"已走到"的阶段（点亮 + 已走到徽标）', g.onSteps >= 1 && g.hasOkBadge, { on: g.onSteps, badge: g.hasOkBadge });
    chk('[' + vp.name + '] ★ 有"下一步"高亮', g.nextSteps >= 1, g.nextSteps);
    chk('[' + vp.name + '] 文案里没有分数/排名/等级', !/总分|得分|评级|青铜|王者|排行榜/.test(g.txt), g.txt.slice(0, 80));
    // ★ 雷达图里的轴标签两两不许重叠（第一版半径给太大，实测"碰过的范围"压到右侧列表上）
    const lblOverlap = await page.evaluate(() => {
      const svg = document.querySelector('#growthBox svg.g-radar');
      if (!svg) return ['no-svg'];
      const ts = Array.prototype.map.call(svg.querySelectorAll('text'), t => {
        const r = t.getBoundingClientRect();
        return { s: t.textContent, l: r.left, r: r.right, t: r.top, b: r.bottom };
      });
      const bad = [];
      for (let i = 0; i < ts.length; i++) {
        for (let j = i + 1; j < ts.length; j++) {
          const a = ts[i], b = ts[j];
          // 矩形相交即算重叠（留 1px 容差）
          if (a.l < b.r - 1 && b.l < a.r - 1 && a.t < b.b - 1 && b.t < a.b - 1) bad.push(a.s + '×' + b.s);
        }
      }
      return bad;
    });
    chk('[' + vp.name + '] ★★ 雷达轴标签两两不重叠', lblOverlap.length === 0, lblOverlap);
    // ★ 轴标签不许越出 SVG 画布（会被裁掉或压到旁边列上）
    const lblOutside = await page.evaluate(() => {
      const svg = document.querySelector('#growthBox svg.g-radar');
      if (!svg) return ['no-svg'];
      const sr = svg.getBoundingClientRect();
      return Array.prototype.filter.call(svg.querySelectorAll('text'), t => {
        const r = t.getBoundingClientRect();
        return r.left < sr.left - 1 || r.right > sr.right + 1 || r.top < sr.top - 1 || r.bottom > sr.bottom + 1;
      }).map(t => t.textContent);
    });
    chk('[' + vp.name + '] ★ 雷达轴标签不越出画布', lblOutside.length === 0, lblOutside);
    const of = await page.evaluate(vw => {
      const bad = [];
      document.querySelectorAll('#growthBox *').forEach(el => {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.right > vw + 1) bad.push(String(el.className).slice(0, 30));
      });
      return bad.slice(0, 4);
    }, vp.w);
    chk('[' + vp.name + '] 没有元素越过右边界', of.length === 0, of);
    chk('[' + vp.name + '] 零控制台报错', errs.length === 0, errs.slice(0, 2));

    const h = await page.evaluate(() => { const b = document.querySelector('#growthBox'); return b ? Math.min(b.scrollHeight + 40, 2600) : 800; });
    await page.setViewportSize({ width: vp.w, height: Math.max(vp.h, h) });
    await page.waitForTimeout(250);
    const el = await page.$('#growthBox');
    if (el) await el.screenshot({ path: path.join(OUT, 'growth-' + vp.name + '.png') });
    chk('[' + vp.name + '] 截图已产出', fs.existsSync(path.join(OUT, 'growth-' + vp.name + '.png')));
    await page.close();
  }

  await browser.close();
  srv.kill('SIGKILL');
  try { fs.rmSync(dd, { recursive: true, force: true }); } catch (e) {}

  const bad = results.filter(r => !r.ok);
  console.log('\n' + '─'.repeat(60));
  if (bad.length) { console.log('✗ 失败 ' + bad.length + ' 项：'); bad.forEach(b => console.log('   · ' + b.name)); }
  else console.log('✓ 全部通过');
  console.log('通过 ' + results.filter(r => r.ok).length + ' 项，失败 ' + bad.length + ' 项');
  console.log('截图目录 ' + OUT);
  process.exit(bad.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });

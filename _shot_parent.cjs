'use strict';
/**
 * 家长视角视觉快照 + 链路自检（批次20）。
 *
 * 三件事必须用真浏览器看，静态断言看不出来：
 *   1. **知识库分区条里「家长视角」这一格真的在、点了能进去**（结构断言只能证明字符串存在）。
 *   2. **null 在界面上是「—」而不是 0** —— 这是本项目最容易犯、也最伤人的一个错。
 *      直接把 HTML 拼出来的字符串抓下来看，比读源码可靠。
 *   3. **窄屏不横向溢出、顶部不被吃**（`.card-list` 是 flex 滚动容器，
 *      scrollWidth 判据在本项目已知不可靠 ⇒ 逐元素量 right 边界 + 量滚动容器自己的 top）。
 *
 * 视口：1440×900（桌面）+ 390×844（手机，家长最可能的设备）。
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

const OUT = path.join(__dirname, '_shots-parent');
const VIEWPORTS = [
  { name: 'desktop', w: 1440, h: 900, mobile: false },
  { name: 'iphone12', w: 390, h: 844, mobile: true },
];

(async () => {
  const CHROME = findChrome();
  if (!CHROME) { console.error('找不到 Chromium'); process.exit(2); }
  fsx.mkdirSync(OUT, { recursive: true });

  const port = await new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
  const dd = path.join(os.tmpdir(), 'hl-parent-' + crypto.randomBytes(4).toString('hex'));
  fsx.mkdirSync(dd, { recursive: true });
  const srv = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    cwd: __dirname,
    env: Object.assign({}, process.env, { PORT: String(port), DATA_DIR: dd, ADMIN_PASSWORD: 'p-pw', LLM_API_KEY: '', NO_DOTENV: '1' }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const base = 'http://127.0.0.1:' + port;
  let up = false;
  for (let i = 0; i < 140; i++) { try { const r = await fetch(base + '/api/health'); if (r.ok) { up = true; break; } } catch (e) {} await new Promise(r => setTimeout(r, 150)); }
  if (!up) { console.error('服务没起来'); srv.kill('SIGKILL'); process.exit(1); }

  // ---- 造真实数据：建卡 → 反复答错（要触发 helpPoints）→ 答对 ----
  const sp = await (await fetch(base + '/api/space', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: '家长视角演示', passcode: '' }),
  })).json();
  const tok = sp.token;
  const H = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok };

  const made = await (await fetch(base + '/api/cards', {
    method: 'POST', headers: H,
    body: JSON.stringify({ knowledge: '一元二次方程的判别式', question: '判别式是什么？', answer: 'b²-4ac', type: 'choice', subject: 'math' }),
  })).json();
  const cid = made.card && made.card.id;
  if (cid) {
    // 2 次答错 → 让 helpPoints 出现（阈值是 wrongs >= 2）
    for (let i = 0; i < 2; i++) {
      await fetch(base + '/api/cards/' + cid + '/review', {
        method: 'POST', headers: H, body: JSON.stringify({ result: 'wrong', studentAnswer: 'b²+4ac' }),
      });
    }
    await fetch(base + '/api/cards/' + cid + '/review', {
      method: 'POST', headers: H, body: JSON.stringify({ result: 'right', studentAnswer: 'b²-4ac' }),
    });
  }

  // ---- 一条已定稿日报（要出现在「他自己写的那段」里）+ 一条草稿（不该出现）----
  const today = new Date();
  const dayStr = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  const yest = dayStr(new Date(today.getTime() - 86400000));
  await fetch(base + '/api/daily/' + yest + '/finalize', {
    method: 'POST', headers: H,
    body: JSON.stringify({ answers: { goal: '想弄明白判别式为什么能判断根的个数。', state: '符号老看反。', process: '画了图，慢慢对上了。' } }),
  });
  await fetch(base + '/api/daily/' + dayStr(today) + '/draft', {
    method: 'POST', headers: H,
    body: JSON.stringify({ answers: { goal: '草稿草稿草稿' } }),
  });

  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  const results = [];
  function chk(name, cond, extra) {
    results.push({ name, ok: !!cond, extra });
    console.log((cond ? '  ✓ ' : '  ✗ ') + name + (cond ? '' : (extra !== undefined ? ' → ' + JSON.stringify(extra) : '')));
  }

  for (const vp of VIEWPORTS) {
    console.log('\n=== ' + vp.name + ' ' + vp.w + 'x' + vp.h + ' ===');
    const page = await browser.newPage({ viewport: { width: vp.w, height: vp.h }, isMobile: vp.mobile, hasTouch: vp.mobile });
    const errs = [];
    page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
    page.on('pageerror', e => errs.push(String(e)));

    await page.goto(base, { waitUntil: 'domcontentloaded' });
    // 进空间：建了带口令的空间，但这里直接走"选已有空间"更麻烦 ——
    // 简化：用 localStorage 塞 token 后刷新（前端凭 token 直接进应用）。
    await page.evaluate((t) => {
      localStorage.setItem('hl_token', t);
    }, tok);
    await page.reload({ waitUntil: 'domcontentloaded' });

    // 等应用就绪：知识库分区条渲染完（enterApp 末尾 switchView('chat') 会把视图重置，
    // 所以必须等 renderKbTabs 的产物出现 —— 这是本项目踩过的竞态）
    await page.waitForFunction(() => document.querySelectorAll('#kbTabs .kb-tab').length > 0, null, { timeout: 30000 });

    // ★ 点「知识库」可能被 enterApp 末尾的 switchView('chat') 顶回去 ⇒ 确认-and-retry
    // ★ 窄屏（≤960）侧栏是**离屏抽屉**：导航按钮虽在 DOM 里、也"visible"，
    //   但 `element is outside of the viewport`，直接 click 会一直重试到超时。
    //   所以必须先点汉堡把抽屉拉出来。
    //   选择器沿用本项目既有约定 `.view:not([hidden]) .hamb` ——
    //   每个 view 里都有一个汉堡，不限定"当前可见的 view"就会命中多个（严格模式直接抛错）。
    async function openDrawer(pg) {
      await pg.locator('.view:not([hidden]) .hamb').first().click();
      await pg.waitForTimeout(320);
    }

    if (vp.mobile) {
      await openDrawer(page);
      const opened = await page.evaluate(() => {
        const s = document.querySelector('#side');
        return !!s && s.classList.contains('open');
      });
      chk('窄屏抽屉能拉开', opened);
    }

    let onKb = false;
    for (let a = 0; a < 4 && !onKb; a++) {
      // 窄屏：抽屉点了导航会自己关，下一轮要重新拉开
      if (vp.mobile && a > 0) await openDrawer(page);
      await page.click('.nav-i[data-view="kb"]');
      try {
        await page.waitForFunction(() => { const v = document.querySelector('#view-kb'); return v && !v.hidden; }, null, { timeout: 4000 });
        onKb = true;
      } catch (e) {}
    }
    chk('能停住知识库视图', onKb);

    const tab = await page.$('#kbTabs [data-sub="parent"]');
    chk('分区条里有「家长视角」这一格', !!tab);
    if (tab) {
      const label = await tab.textContent();
      chk('格子上的字是「家长视角」', label.indexOf('家长视角') >= 0, label);
      const locked = await tab.evaluate(el => el.classList.contains('locked'));
      chk('阶段 1 就解锁（不能是锁的）', !locked);
      await tab.click();
      await page.waitForTimeout(400);
    }
    const shown = await page.evaluate(() => { const v = document.querySelector('#view-parent'); return v && !v.hidden; });
    chk('家长视角分区被切出来了', shown);

    // 等真数据渲染完（骨架屏消失）
    await page.waitForFunction(() => {
      const b = document.querySelector('#parentBody');
      return b && !b.querySelector('.skel');
    }, null, { timeout: 20000 }).catch(() => {});

    const txt = await page.evaluate(() => (document.querySelector('#parentBody') || {}).innerText || '');
    chk('页面有内容（不是空的）', txt.length > 200, txt.length);
    chk('★ 有正确率数字（答对 1 次 ⇒ 33%）', /33%/.test(txt), txt.slice(0, 0));
    chk('★ 一句话总结在页面上', txt.indexOf('有记录') >= 0 || txt.indexOf('没看到') >= 0, null);
    chk('★ 「答不了的三件事」在页面上', txt.indexOf('答不了') >= 0, null);
    chk('★ 明说看不到对话原文', txt.indexOf('对话原文') >= 0, null);
    chk('★ helpPoints 只说到科目（数学），不吐 math', txt.indexOf('数学') >= 0 && txt.indexOf('math') < 0, null);
    chk('★ 已定稿日报出现在页面上', txt.indexOf('判别式') >= 0, null);
    chk('★★ 草稿没有泄露（页面上搜不到「草稿草稿草稿」）', txt.indexOf('草稿草稿草稿') < 0, null);
    chk('★ 没有出现「—」以外的 0% （算不出来不许写 0）', txt.indexOf('0%') < 0, null);
    // ★★ 这一条是实测抓到的真 bug：后端漏给 movement.right，前端算 `judged - right`
    //     得到 NaN，界面上就印出了「对 1 / 错 NaN」。**不报错、控制台也不报**，
    //     只有肉眼能看到。所以必须在最外层（渲染结果）拦一次。
    chk('★★ 页面上不许出现 NaN / undefined / null 字面量',
      txt.indexOf('NaN') < 0 && txt.indexOf('undefined') < 0 && txt.indexOf('null') < 0,
      { NaN: txt.indexOf('NaN'), undefined: txt.indexOf('undefined'), null: txt.indexOf('null') });
    chk('没有"排名/百分位"这类编造的概念', txt.indexOf('排名') < 0 && txt.indexOf('百分位') < 0, null);
    chk('没有"学习了多长时间"这类时长指标', txt.indexOf('学习时长') < 0, null);

    // ---- 横向溢出：逐元素量 right 边界（.app 有 overflow:hidden，scrollWidth 判据是假绿）----
    const overflow = await page.evaluate((vw) => {
      const bad = [];
      document.querySelectorAll('#view-parent *').forEach(el => {
        // 跳过横滑容器内部的元素（它们是设计上就该超出可视区的）
        let p = el.parentElement, skip = false;
        while (p && p !== document.body) {
          const ox = getComputedStyle(p).overflowX;
          if (ox === 'auto' || ox === 'scroll') { skip = true; break; }
          p = p.parentElement;
        }
        if (skip) return;
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.right > vw + 1) bad.push({ cls: el.className, right: Math.round(r.right) });
      });
      return bad.slice(0, 5);
    }, vp.w);
    chk('没有元素越过视口右边界', overflow.length === 0, overflow);

    // ---- 顶部不被吃：滚到 0 后第一个子元素 top 必须 >= 0 ----
    const topOk = await page.evaluate(() => {
      const box = document.querySelector('#parentBody');
      if (!box) return null;
      box.scrollTop = 0;
      const first = box.firstElementChild;
      if (!first) return null;
      return Math.round(first.getBoundingClientRect().top - box.getBoundingClientRect().top);
    });
    chk('滚动容器顶部没被吃掉（top >= -2）', topOk === null || topOk >= -2, topOk);

    // ---- 截图 ----
    // ★ fullPage:true 对 position:fixed 的滚动容器无效，只截一屏 ⇒ 先把视口撑高再截元素
    const h = await page.evaluate(() => {
      const b = document.querySelector('#parentBody');
      return b ? Math.min(b.scrollHeight + 120, 4200) : 1200;
    });
    await page.setViewportSize({ width: vp.w, height: Math.max(vp.h, h) });
    await page.waitForTimeout(300);
    const el = await page.$('#view-parent');
    if (el) await el.screenshot({ path: path.join(OUT, 'parent-' + vp.name + '.png') });
    chk('截图已产出', fsx.existsSync(path.join(OUT, 'parent-' + vp.name + '.png')));
    chk('零控制台报错', errs.length === 0, errs.slice(0, 2));

    await page.close();
  }

  await browser.close();
  srv.kill('SIGKILL');
  try { fsx.rmSync(dd, { recursive: true, force: true }); } catch (e) {}

  const bad = results.filter(r => !r.ok);
  console.log('\n' + '─'.repeat(60));
  if (bad.length) { console.log('✗ 失败 ' + bad.length + ' 项：'); bad.forEach(b => console.log('   · ' + b.name)); }
  else console.log('✓ 全部通过');
  console.log('通过 ' + results.filter(r => r.ok).length + ' 项，失败 ' + bad.length + ' 项');
  console.log('截图目录 ' + OUT);
  process.exit(bad.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });

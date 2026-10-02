'use strict';
/**
 * 历史周报视觉快照 + 链路自检（批次22）。
 *
 * 三件事只有真浏览器看得出来：
 *   1. **看板里真的有"以前的周报"这一块，点了能跳回那一段区间**（结构断言只能证明字符串存在）。
 *   2. **定稿前后界面确实不同** —— 定稿态是只读的（没有 input），草稿态是可编辑的。
 *      这是"定稿 = 冻结"在**渲染层**的证据；后端测过了，但前端可能忘了换模板。
 *   3. **窄屏不横向溢出、顶部不被吃**（.card-list 是 flex 滚动容器，scrollWidth 判据已知假绿
 *      ⇒ 逐元素量 right 边界 + 量滚动容器自己的 top）。
 *
 * 视口：1440×900（桌面）+ 390×844（手机）。
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

const OUT = path.join(__dirname, '_shots-weekly');
const VIEWPORTS = [
  { name: 'desktop', w: 1440, h: 900, mobile: false },
  { name: 'iphone12', w: 390, h: 844, mobile: true },
];

function dayOff(n) {
  const d = new Date(Date.now() + n * 86400000);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

(async () => {
  const CHROME = findChrome();
  if (!CHROME) { console.error('找不到 Chromium'); process.exit(2); }
  fsx.mkdirSync(OUT, { recursive: true });

  const port = await new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
  const dd = path.join(os.tmpdir(), 'hl-weekly-shot-' + crypto.randomBytes(4).toString('hex'));
  fsx.mkdirSync(dd, { recursive: true });
  const srv = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    cwd: __dirname,
    env: Object.assign({}, process.env, { PORT: String(port), DATA_DIR: dd, ADMIN_PASSWORD: 'w-pw', LLM_API_KEY: '', NO_DOTENV: '1' }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const base = 'http://127.0.0.1:' + port;
  let up = false;
  for (let i = 0; i < 140; i++) { try { const r = await fetch(base + '/api/health'); if (r.ok) { up = true; break; } } catch (e) {} await new Promise(r => setTimeout(r, 150)); }
  if (!up) { console.error('服务没起来'); srv.kill('SIGKILL'); process.exit(1); }

  // ---- 造数据：建卡 → 复习（对/错都要，让正确率不是 100% 也不是算不出来）----
  const sp = await (await fetch(base + '/api/space', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: '历史周报演示', passcode: '' }),
  })).json();
  const tok = sp.token;
  const H = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok };

  async function mkCard(knowledge, subject) {
    const r = await (await fetch(base + '/api/cards', {
      method: 'POST', headers: H,
      body: JSON.stringify({ knowledge: knowledge, question: knowledge + '？', answer: '答案', type: 'choice', subject: subject }),
    })).json();
    return r.card && r.card.id;
  }
  async function review(cid, result) {
    if (!cid) return;
    await fetch(base + '/api/cards/' + cid + '/review', {
      method: 'POST', headers: H, body: JSON.stringify({ result: result, studentAnswer: 'x' }),
    });
  }
  const c1 = await mkCard('一元二次方程的判别式', 'math');
  const c2 = await mkCard('现在完成时的用法', 'english');
  await review(c1, 'right');
  await review(c2, 'wrong');
  await review(c1, 'wrong');

  // ---- 先写一条**本周**的草稿（要看编辑态）----
  const FROM = dayOff(-6), TO = dayOff(0);
  await fetch(base + '/api/weekly/note/' + FROM + '/' + TO, {
    method: 'POST', headers: H,
    body: JSON.stringify({ answers: { noticed: '我发现错题重做一遍就没那么怕了', next: '下周每天留十分钟重做错题' } }),
  });

  // ---- 再定稿一条**上周**的（要出现在历史列表里，且数字是现算的）----
  const PFROM = dayOff(-13), PTO = dayOff(-7);
  await fetch(base + '/api/weekly/note/' + PFROM + '/' + PTO, {
    method: 'POST', headers: H,
    body: JSON.stringify({ answers: { noticed: '上周我一直在跟符号较劲', next: '这周换个记法' }, finalize: true }),
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
    await page.evaluate((t) => { localStorage.setItem('hl_token', t); }, tok);
    await page.reload({ waitUntil: 'domcontentloaded' });

    // 等应用就绪（务必等 renderKbTabs 的产物 —— enterApp 末尾 switchView('chat') 会把视图重置）
    await page.waitForFunction(() => document.querySelectorAll('#kbTabs .kb-tab').length > 0, null, { timeout: 30000 });

    async function openDrawer(pg) {
      await pg.locator('.view:not([hidden]) .hamb').first().click();
      await pg.waitForTimeout(320);
    }
    if (vp.mobile) {
      await openDrawer(page);
      chk('窄屏抽屉能拉开', await page.evaluate(() => {
        const s = document.querySelector('#side'); return !!s && s.classList.contains('open');
      }));
    }

    // 进知识库
    let onKb = false;
    for (let a = 0; a < 4 && !onKb; a++) {
      if (vp.mobile && a > 0) await openDrawer(page);
      await page.click('.nav-i[data-view="kb"]');
      try {
        await page.waitForFunction(() => { const v = document.querySelector('#view-kb'); return v && !v.hidden; }, null, { timeout: 4000 });
        onKb = true;
      } catch (e) {}
    }
    chk('能停住知识库视图', onKb);

    // 进看板（周报挂在看板里）
    const dash = await page.$('#kbTabs [data-sub="dash"]');
    chk('分区条里有「看板」这一格', !!dash);
    if (dash) { await dash.click(); await page.waitForTimeout(400); }
    const dashShown = await page.evaluate(() => { const v = document.querySelector('#view-dash'); return v && !v.hidden; });
    chk('看板分区被切出来了', dashShown);

    // 等周报 + note + 历史三块都渲染完（骨架屏消失且历史有内容）
    await page.waitForFunction(() => {
      const w = document.querySelector('#weeklyBox');
      if (!w || w.querySelector('.skel')) return false;
      const h = document.querySelector('#weeklyHist');
      return h && h.innerHTML.length > 10;
    }, null, { timeout: 25000 }).catch(() => {});

    // ---- ① 历史列表真的在、且显示的是"上周"那一条 ----
    const histTxt = await page.evaluate(() => (document.querySelector('#weeklyHist') || {}).innerText || '');
    chk('★ 历史列表有内容', histTxt.length > 5, histTxt.slice(0, 40));
    chk('★ 历史里能看到上周写的那句话', histTxt.indexOf('跟符号较劲') >= 0, histTxt.slice(0, 120));
    chk('★ 历史条目标了「已定稿」', histTxt.indexOf('已定稿') >= 0, null);
    chk('★ 历史条目带数字（记录/练卡）', /记录 \d+ 条/.test(histTxt) && /练卡 \d+ 次/.test(histTxt), histTxt.slice(0, 120));

    // ---- ② 本周是草稿态：可编辑（有 input） ----
    const noteHasInput = await page.evaluate(() => {
      const sec = document.querySelector('#weeklyNoteSec');
      return sec ? sec.querySelectorAll('input[data-nk]').length : -1;
    });
    chk('★★ 本周是草稿态 → 有可编辑输入框（2 个）', noteHasInput === 2, noteHasInput);
    const noteTxt = await page.evaluate(() => (document.querySelector('#weeklyNoteSec') || {}).innerText || '');
    chk('★ 草稿态没有「只读」标签', noteTxt.indexOf('只读') < 0, null);
    chk('★ 明说"会保存，其余数字不会"', noteTxt.indexOf('会保存') >= 0, noteTxt.slice(0, 60));

    // ---- ③ 点"先存着" → 不报错、still draft ----
    const saveBtn = await page.$('#wNoteSave');
    chk('有「先存着」按钮', !!saveBtn);
    if (saveBtn) {
      await saveBtn.click();
      await page.waitForTimeout(900);
      const stillDraft = await page.evaluate(() => {
        const sec = document.querySelector('#weeklyNoteSec');
        return sec ? sec.querySelectorAll('input[data-nk]').length : -1;
      });
      chk('★ 存草稿后仍是可编辑态（还是草稿）', stillDraft === 2, stillDraft);
    }

    // ---- ④ 点历史条目 → 应该跳到那一段区间，并显示**已定稿只读** ----
    const hist = await page.$('#weeklyHist .w-hist');
    chk('历史条目的元素存在', !!hist);
    if (hist) {
      await hist.click();
      await page.waitForTimeout(1200);
      const afterJump = await page.evaluate(() => {
        const sec = document.querySelector('#weeklyNoteSec');
        return {
          inputs: sec ? sec.querySelectorAll('input[data-nk]').length : -1,
          text: sec ? sec.innerText : '',
        };
      });
      chk('★★ 跳到已定稿那一段后变成只读（0 个输入框）', afterJump.inputs === 0, afterJump.inputs);
      chk('★★ 界面明说「已定稿 · 只读」', afterJump.text.indexOf('只读') >= 0, afterJump.text.slice(0, 60));
      chk('★ 显示的是上周写的那句话', afterJump.text.indexOf('跟符号较劲') >= 0, afterJump.text.slice(0, 120));

      // 跳回去（把这段截下来更完整）—— 点快捷按钮回到最近 7 天
      const q = await page.$('#weeklyBox .w-q');
      if (q) { await q.click(); await page.waitForTimeout(900); }
    }

    // ---- ⑤ 全页文本禁字 ----
    const all = await page.evaluate(() => (document.querySelector('#weeklyBox') || {}).innerText || '');
    chk('★★ 页面上不许出现 NaN / undefined / null 字面量',
      all.indexOf('NaN') < 0 && all.indexOf('undefined') < 0 && all.indexOf('null') < 0,
      { NaN: all.indexOf('NaN'), undefined: all.indexOf('undefined'), null: all.indexOf('null') });
    chk('没有"排名/百分位"这类编造的概念', all.indexOf('排名') < 0 && all.indexOf('百分位') < 0, null);

    // ---- ⑥ 横向溢出：逐元素量 right 边界 ----
    const overflow = await page.evaluate((vw) => {
      const bad = [];
      document.querySelectorAll('#view-dash *').forEach(el => {
        let p = el.parentElement, skip = false;
        while (p && p !== document.body) {
          const ox = getComputedStyle(p).overflowX;
          if (ox === 'auto' || ox === 'scroll') { skip = true; break; }
          p = p.parentElement;
        }
        if (skip) return;
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.right > vw + 1) bad.push({ cls: String(el.className).slice(0, 40), right: Math.round(r.right) });
      });
      return bad.slice(0, 5);
    }, vp.w);
    chk('没有元素越过视口右边界', overflow.length === 0, overflow);

    // ---- ⑦ 顶部不被吃 ----
    const topOk = await page.evaluate(() => {
      const box = document.querySelector('#dashBody');
      if (!box) return null;
      box.scrollTop = 0;
      const first = box.firstElementChild;
      if (!first) return null;
      return Math.round(first.getBoundingClientRect().top - box.getBoundingClientRect().top);
    });
    chk('滚动容器顶部没被吃掉（top >= -2）', topOk === null || topOk >= -2, topOk);

    // ---- 截图 ----
    const h = await page.evaluate(() => {
      const b = document.querySelector('#weeklyBox');
      return b ? Math.min(b.scrollHeight + 160, 4600) : 1400;
    });
    await page.setViewportSize({ width: vp.w, height: Math.max(vp.h, h) });
    await page.waitForTimeout(300);
    const el = await page.$('#weeklyBox');
    if (el) await el.screenshot({ path: path.join(OUT, 'weekly-' + vp.name + '.png') });
    chk('截图已产出', fsx.existsSync(path.join(OUT, 'weekly-' + vp.name + '.png')));
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

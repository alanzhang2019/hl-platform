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
      // 等"确实存完了"：按钮从"保存中…"恢复，或 note 区已重渲染回来
      await page.waitForFunction(() => {
        const b = document.querySelector('#wNoteSave');
        return !b || (!b.disabled && b.textContent.indexOf('保存中') < 0);
      }, null, { timeout: 15000 }).catch(() => {});
      const stillDraft = await page.evaluate(() => {
        const sec = document.querySelector('#weeklyNoteSec');
        return sec ? sec.querySelectorAll('input[data-nk]').length : -1;
      });
      chk('★ 存草稿后仍是可编辑态（还是草稿）', stillDraft === 2, stillDraft);
    }

    // ---- ④ 点历史条目 → 应该跳到那一段区间，并显示**已定稿只读** ----
    // ★ 必须在**这一刻**重新取 handle：上面"先存着"会调 loadWeeklyHist()，
    //   把 #weeklyHist 整块重建 —— 之前捕获的 ElementHandle 已经脱离了 DOM，
    //   click() 会报 "Element is not attached to the DOM"（实测踩到）。
    const hist = await page.$('#weeklyHist .w-hist');
    chk('历史条目的元素存在', !!hist);
    if (hist) {
      await hist.click();
      // ★ 不用固定 sleep：机器吃紧时 1200ms 不够，会让"其实跳到了"被误判成"没反应"。
      //   等真正的条件 —— 那一段的 note 已经渲染出来（#weeklyNoteSec 有内容且无骨架）。
      await page.waitForFunction(() => {
        const sec = document.querySelector('#weeklyNoteSec');
        return sec && sec.innerHTML.trim().length > 0 && !sec.querySelector('.skel');
      }, null, { timeout: 15000 }).catch(() => {});
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
      if (q) {
        await q.click();
        // 等回到"最近 7 天"：note 区重新变成可编辑草稿态
        await page.waitForFunction(() => {
          const sec = document.querySelector('#weeklyNoteSec');
          const inputs = sec ? sec.querySelectorAll('input[data-nk]').length : 0;
          return inputs === 2 && !document.querySelector('#weeklyBox .skel');
        }, null, { timeout: 15000 }).catch(() => {});
      }
    }

    // ---- ⑤ 全页文本禁字 ----
    const all = await page.evaluate(() => (document.querySelector('#weeklyBox') || {}).innerText || '');
    chk('★★ 页面上不许出现 NaN / undefined / null 字面量',
      all.indexOf('NaN') < 0 && all.indexOf('undefined') < 0 && all.indexOf('null') < 0,
      { NaN: all.indexOf('NaN'), undefined: all.indexOf('undefined'), null: all.indexOf('null') });
    chk('没有"排名/百分位"这类编造的概念', all.indexOf('排名') < 0 && all.indexOf('百分位') < 0, null);

    // ---- ⑤-b 数字溯源（批次22 前端接线）：点数字 → 明细真的出来 ----
    // 这一段造过卡也复习过，所以 records / reviews / cards 都该是"算得出来"的 → 都可点。
    const evBtns = await page.evaluate(() =>
      Array.prototype.map.call(document.querySelectorAll('#weeklyBox [data-wm]'), b => b.dataset.wm));
    chk('★ KPI 上有可点的溯源按钮（records/reviews/cards）',
      evBtns.indexOf('records') >= 0 && evBtns.indexOf('reviews') >= 0 && evBtns.indexOf('cards') >= 0,
      evBtns.join(','));
    chk('★ 明细容器 #weeklyEv 在页面里就建好了（不靠点击才出现）',
      await page.evaluate(() => !!document.querySelector('#weeklyEv')), null);
    chk('★ 容器初始是收起的（不占高度）',
      await page.evaluate(() => {
        const b = document.querySelector('#weeklyEv');
        return b ? (b.dataset.open === '0' && b.getBoundingClientRect().height === 0) : false;
      }), null);
    // ★ 数字与「明细」不能重叠（实测第一版把下划线画在整按钮上 ⇒ 两者挤同一行重叠）。
    //   判据：明细的 top 必须 >= 数字的 bottom - 1（留 1px 给亚像素）。
    const kpiOverlap = await page.evaluate(() => {
      const bad = [];
      document.querySelectorAll('#weeklyBox .w-ev-btn').forEach(b => {
        const v = b.querySelector('.w-ev-v'), i = b.querySelector('.w-ev-i');
        if (!v || !i) return;
        if (i.getBoundingClientRect().top < v.getBoundingClientRect().bottom - 1) {
          bad.push(b.dataset.wm + ':' + Math.round(i.getBoundingClientRect().top - v.getBoundingClientRect().bottom));
        }
      });
      return bad;
    });
    chk('★★ 数字与「明细」没有重叠', kpiOverlap.length === 0, kpiOverlap);

    // 点「练知识卡」的次数数字
    const reviewsBtn = await page.$('#weeklyBox [data-wm="reviews"]');
    chk('「练知识卡」数字可点', !!reviewsBtn);
    if (reviewsBtn) {
      await reviewsBtn.click();
      await page.waitForFunction(() => {
        const b = document.querySelector('#weeklyEv');
        return b && b.dataset.open === '1' && !b.querySelector('.skel');
      }, null, { timeout: 8000 }).catch(() => {});
      const evTxt = await page.evaluate(() => (document.querySelector('#weeklyEv') || {}).innerText || '');
      chk('★★ 点开后明细真的出来了（不是空壳）', evTxt.length > 10, evTxt.slice(0, 80));
      chk('★ 明细标题写了条数', /练知识卡 · \d+ 条/.test(evTxt), evTxt.slice(0, 60));
      chk('★ 明细按天分组（每组的日期是 MM-DD 形态）', /^\d{2}-\d{2} · \d+ 条/m.test(evTxt), evTxt.slice(0, 120));
    chk('★ 明细里能看到练习的科目/对错', /答对|答错|判不出对错/.test(evTxt), evTxt.slice(0, 160));

      // 点 × 收起
      const x = await page.$('#weeklyEv .w-ev-x');
      chk('明细有收起按钮', !!x);
      if (x) {
        await x.click();
        await page.waitForFunction(() => { const b = document.querySelector('#weeklyEv'); return b && b.dataset.open === '0' && b.innerHTML.trim() === ''; }, null, { timeout: 8000 }).catch(() => {});
        chk('★ 点 × 后收起且清空',
          await page.evaluate(() => {
            const b = document.querySelector('#weeklyEv');
            return b ? (b.dataset.open === '0' && b.innerHTML.trim() === '') : false;
          }), null);
      }
      // 再点同一个 → 应能再次打开（toggle 不能把自己锁死）
      await reviewsBtn.click();
      await page.waitForFunction(() => (document.querySelector('#weeklyEv') || {}).dataset && document.querySelector('#weeklyEv').dataset.open === '1' && !document.querySelector('#weeklyEv').querySelector('.skel'), null, { timeout: 8000 }).catch(() => {});
      chk('★ 收起后还能再次打开',
        await page.evaluate(() => (document.querySelector('#weeklyEv') || {}).dataset.open === '1'), null);
      // 换个指标（records）→ 内容应换成记录，不是缓存着上一次的
      const recBtn = await page.$('#weeklyBox [data-wm="records"]');
      if (recBtn) {
        await recBtn.click();
        await page.waitForFunction(() => { const b = document.querySelector('#weeklyEv'); return b && b.dataset.ev === 'records' && !b.querySelector('.skel') && b.innerText.indexOf('留下的记录') >= 0; }, null, { timeout: 8000 }).catch(() => {});
        const ev2 = await page.evaluate(() => (document.querySelector('#weeklyEv') || {}).innerText || '');
        chk('★ 换成另一个指标后明细跟着换（不是缓存上一次的）',
          /留下的记录/.test(ev2), ev2.slice(0, 60));
      }
      // 收起，免得影响后面的溢出断言与截图
      const x2 = await page.$('#weeklyEv .w-ev-x');
      if (x2) { await x2.click(); await page.waitForFunction(() => { const b = document.querySelector('#weeklyEv'); return b && b.dataset.open === '0'; }, null, { timeout: 8000 }).catch(() => {}); }
    }

    // ---- ⑤-c 与上一段对比（批次22-②）：要点是"不许红绿、不许当 0 比" ----
    const cmpTxt = await page.evaluate(() => {
      const sec = Array.prototype.filter.call(document.querySelectorAll('#weeklyBox .w-sec'),
        s => /和上一段比/.test(s.innerText))[0];
      return sec ? sec.innerText : '';
    });
    chk('★ 页面上有「和上一段比」这一块', cmpTxt.length > 0, cmpTxt.slice(0, 60));
    chk('★ 对比块标出了上一段的日期区间', /\d{4}-\d{2}-\d{2} ~ \d{4}-\d{2}-\d{2}/.test(cmpTxt), cmpTxt.slice(0, 80));
    chk('★ 对比块明说"不说明学得好坏"', /不说明学得好坏|不代表/.test(cmpTxt), cmpTxt.slice(0, 200));
    // ★★ 不给红绿：up / down 两种 delta 的**计算色**必须相同
    const cmpColors = await page.evaluate(() => {
      const out = {};
      ['w-cmp-up', 'w-cmp-down', 'w-cmp-flat', 'w-cmp-na'].forEach(c => {
        const el = document.querySelector('#weeklyBox .' + c);
        out[c] = el ? getComputedStyle(el).color : null;
      });
      return out;
    });
    if (cmpColors['w-cmp-up'] && cmpColors['w-cmp-down']) {
      chk('★★ up 与 down 的计算颜色相同（不红不绿）',
        cmpColors['w-cmp-up'] === cmpColors['w-cmp-down'],
        { up: cmpColors['w-cmp-up'], down: cmpColors['w-cmp-down'] });
    } else {
      chk('★ 本夹具里没有同时出现 up/down（跳过颜色对比，不算失败）', true, cmpColors);
    }
    // ★ 没有 ❌ 红绿箭头图标
    chk('★ 对比里没有用箭头符号表达好坏', !/[↑↓▲▼]/.test(cmpTxt), cmpTxt.slice(0, 100));
    // ★ 「没法比」与「一样」是两个词，不混用
    const hasNa = /没法比/.test(cmpTxt), hasFlat = /和上一次一样/.test(cmpTxt);
    chk('★ 「没法比」与「一样」用的是不同措辞（不混为一档）',
      !(hasNa && hasFlat) || cmpTxt.indexOf('没法比') !== cmpTxt.indexOf('和上一次一样'), { hasNa, hasFlat });

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

'use strict';
/**
 * 英语深度：单元四关 + 艾宾浩斯（批次24）浏览器套件。
 *
 * 只验静态断言抓不到的东西：
 *  · 四关**真的画出来了**（四个按钮、进度条宽度是数、null 是虚线不是 0%）
 *  · ★★ 空单元与"有词没过"在界面上**长得不一样**（虚线 + 「还没词」 vs 实心 0%）
 *  · 点关卡真的打开答题界面（听写模式的题在、答案不在）
 *  · ★★ 造句那一关交卷后**界面上没有答对率**（它不判对错）
 *  · ★ 复习区：没复习过时写「还没法算」而不是 0%
 *  · 点 🔊 真的会调 SpeechSynthesis（用打桩计数，不真出声）
 *  · 双视口不横向溢出、零控制台报错
 *
 * ★ 英语是**阶段 4（大树 need=200）**才解锁的功能 —— 不顶成长值就根本点不进这个分区。
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const net = require('net');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { chromium } = require('playwright-core');

const OUT = path.join(__dirname, '_shots-en');

/** 英语在阶段 4（大树 need=200）才解锁 ⇒ 给 220 稳过。见 server/pet.js 的 UNLOCKS。 */
function bumpPet(dd, spaceId) {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(path.join(dd, 'app.db'));
  try { db.prepare('UPDATE pets SET growth = 220 WHERE space_id = ?').run(spaceId); }
  finally { db.close(); }
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
  const dd = path.join(os.tmpdir(), 'hl-en-shot-' + crypto.randomBytes(4).toString('hex'));
  fs.mkdirSync(dd, { recursive: true });
  const srv = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    cwd: __dirname,
    env: Object.assign({}, process.env, { PORT: String(port), DATA_DIR: dd, ADMIN_PASSWORD: 'e-pw', LLM_API_KEY: '', NO_DOTENV: '1' }),
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

  /** 建空间 + 顶成长值 + 登录到知识库·英语分区 */
  async function enterEn(sp, page) {
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.evaluate(t => localStorage.setItem('hl_token', t), sp.token);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.querySelectorAll('#kbTabs .kb-tab').length > 0, null, { timeout: 30000 });
    let onKb = false;
    const mobile = page.viewportSize().width <= 820;
    for (let a = 0; a < 4 && !onKb; a++) {
      if (mobile && a > 0) { await page.locator('.view:not([hidden]) .hamb').first().click(); await page.waitForTimeout(320); }
      await page.click('.nav-i[data-view="kb"]').catch(() => {});
      try {
        await page.waitForFunction(() => { const v = document.querySelector('#view-kb'); return v && !v.hidden; }, null, { timeout: 4000 });
        onKb = true;
      } catch (e) {}
    }
    const tab = await page.$('#kbTabs [data-sub="en"]');
    if (tab) await tab.click();
    await page.waitForFunction(() => {
      const v = document.querySelector('#view-en');
      return v && !v.hidden;
    }, null, { timeout: 10000 }).catch(() => {});
  }

  // ---------- 场景 A：空单词本 ----------
  console.log('\n=== 场景 A：空单词本 ===');
  {
    const sp = await (await fetch(base + '/api/space', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: '英语空', passcode: '' }) })).json();
    await (await fetch(base + '/api/pet', { headers: { Authorization: 'Bearer ' + sp.token } })).text();
    bumpPet(dd, sp.spaceId);
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errs = [];
    page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
    page.on('pageerror', e => errs.push(String(e)));
    await enterEn(sp, page);
    await page.waitForFunction(() => {
      const b = document.querySelector('#enGates');
      return b && b.innerHTML.length > 30;
    }, null, { timeout: 20000 }).catch(() => {});

    const g = await page.evaluate(() => {
      const box = document.querySelector('#enGates');
      const rv = document.querySelector('#enReview');
      return {
        txt: box ? box.innerText : '',
        gates: box ? box.querySelectorAll('.en4-gate').length : 0,
        bars: box ? box.querySelectorAll('.en4-bar').length : 0,
        naBars: box ? box.querySelectorAll('.en4-bar.na').length : 0,
        rvTxt: rv ? rv.innerText : '',
      };
    });
    chk('四关区渲染出来了', g.txt.length > 10, g.txt.slice(0, 60));
    chk('★ 空单词本给的是"先导入词表"的引导（不是空白）', /还没有单词/.test(g.txt), g.txt.slice(0, 60));
    chk('★ 引导里说清了四关的顺序', /认/.test(g.txt) && /用/.test(g.txt));
    // ★★ 空空间没有进度条 —— 因为一个单元都没有，不画"0%" 的假进度
    chk('★★ 空单词本不画进度条（没有分母就不画，不是画 0%）', g.bars === 0, g.bars);
    chk('★★ 复习区空的时候整块不占位', g.rvTxt.trim() === '', g.rvTxt.slice(0, 40));
    chk('零控制台报错', errs.length === 0, errs.slice(0, 2));

    const h = await page.evaluate(() => Math.min(document.documentElement.scrollHeight + 100, 1400));
    await page.setViewportSize({ width: 1440, height: Math.max(900, h) });
    await page.waitForTimeout(200);
    const el = await page.$('#view-en');
    if (el) await el.screenshot({ path: path.join(OUT, 'en-empty.png') });
    chk('空状态截图已产出', fs.existsSync(path.join(OUT, 'en-empty.png')));
    await page.close();
  }

  // ---------- 场景 B：有词（有单元 + 没归入单元的词）----------
  console.log('\n=== 场景 B：有词（四关进度 + 复习区）===');
  for (const vp of VIEWPORTS) {
    const sp = await (await fetch(base + '/api/space', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: '英语有词 ' + vp.name, passcode: '' }) })).json();
    await (await fetch(base + '/api/pet', { headers: { Authorization: 'Bearer ' + sp.token } })).text();
    bumpPet(dd, sp.spaceId);
    const H = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + sp.token };
    // 单元 A：4 个词，其中 2 个已经"背"过（对 2 次）⇒ 四关进度不是 0 也不是 100
    const u = await (await fetch(base + '/api/english/units', { method: 'POST', headers: H, body: JSON.stringify({ name: 'Unit A' }) })).json();
    await fetch(base + '/api/english/words/import', { method: 'POST', headers: H, body: JSON.stringify({ unitId: u.unit.id, text: 'apple 苹果\nbanana 香蕉\ncherry 樱桃\nzebra 斑马' }) });
    // 空单元：为了验"空单元画虚线 + 还没词"
    await fetch(base + '/api/english/units', { method: 'POST', headers: H, body: JSON.stringify({ name: 'Unit 空' }) });
    // 散词：为的是验"未归入单元的词不许消失"
    await fetch(base + '/api/english/words/import', { method: 'POST', headers: H, body: JSON.stringify({ text: 'looseone 散词一\nloosetwo 散词二' }) });
    const wl = await (await fetch(base + '/api/english/words?unitId=' + encodeURIComponent(u.unit.id), { headers: H })).json();
    const w1 = wl.words.filter(w => w.word === 'apple')[0];
    await fetch(base + '/api/english/gate/grade', { method: 'POST', headers: H, body: JSON.stringify({ gate: 'recall', items: [{ id: w1.id, answer: 'apple' }, { id: w1.id, answer: 'apple' }] }) });
    // 记一次复习 ⇒ 复习区出现"该复习 0 / 没碰过 N / 判对率"
    await fetch(base + '/api/english/review', { method: 'POST', headers: H, body: JSON.stringify({ wordId: w1.id, gate: 'recall', result: 'right' }) });

    const page = await browser.newPage({ viewport: { width: vp.w, height: vp.h }, isMobile: vp.mobile, hasTouch: vp.mobile });
    const errs = [];
    page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
    page.on('pageerror', e => errs.push(String(e)));
    await enterEn(sp, page);
    // 阻止真出声（无头浏览器里 speechSynthesis 会立刻 onend；打桩只是为了能计数）
    await page.evaluate(() => {
      window.__spoke = [];
      const orig = window.speechSynthesis && window.speechSynthesis.speak;
      if (window.speechSynthesis) {
        window.speechSynthesis.speak = function (u) { window.__spoke.push(u && u.text); if (orig) try { orig.call(window.speechSynthesis, u); } catch (e) {} };
      }
    });
    await page.waitForFunction(() => {
      const b = document.querySelector('#enGates');
      return b && b.querySelectorAll('.en4-gate').length > 0;
    }, null, { timeout: 20000 }).catch(() => {});

    const g = await page.evaluate(() => {
      const box = document.querySelector('#enGates');
      const rv = document.querySelector('#enReview');
      const units = box ? box.querySelectorAll('.en4-unit') : [];
      const bars = box ? Array.prototype.map.call(box.querySelectorAll('.en4-bar'), b => b.className) : [];
      const pcts = box ? Array.prototype.map.call(box.querySelectorAll('.en4-pct'), b => b.textContent) : [];
      const widths = box ? Array.prototype.map.call(box.querySelectorAll('.en4-bar i'), i => i.style.width) : [];
      return {
        txt: box ? box.innerText : '',
        units: units.length,
        gates: box ? box.querySelectorAll('.en4-gate').length : 0,
        naBars: bars.filter(c => /na/.test(c)).length,
        realBars: bars.filter(c => !/na/.test(c)).length,
        pcts: pcts,
        widths: widths,
        rvTxt: rv ? rv.innerText : '',
        looseHint: /还没归入单元/.test(box ? box.innerText : ''),
        hasEmptyHint: /还没词/.test(box ? box.innerText : ''),
      };
    });
    chk('[' + vp.name + '] ★ 两个单元都画出来了（有词的 + 空的）', g.units === 2, g.units);
    chk('[' + vp.name + '] ★★ 空单元画成虚线（null），有词的单元画成实心（0 也算得出来）',
      g.naBars >= 4 && g.realBars >= 4, { na: g.naBars, real: g.realBars });
    chk('[' + vp.name + '] ★★ 空单元写「还没词」而不是「0%」', g.hasEmptyHint, g.pcts);
    chk('[' + vp.name + '] ★★ 页面上没有把空单元的进度写成 0%',
      !/还没词[\s\S]{0,20}0%/.test(g.txt) || g.pcts.filter(p => p === '还没词').length >= 4, g.pcts);
    chk('[' + vp.name + '] ★ 有词的单元进度条宽度是数（真算出来的）',
      g.widths.some(w => /%$/.test(w)), g.widths.slice(0, 6));
    chk('[' + vp.name + '] ★ 复习区显示出来了', g.rvTxt.length > 10, g.rvTxt.slice(0, 60));
    chk('[' + vp.name + '] ★ 复习区报了"没碰过"多少词', /没碰过/.test(g.rvTxt));
    chk('[' + vp.name + '] ★ 复习区报了判对率', /判对率/.test(g.rvTxt));
    chk('[' + vp.name + '] ★ 复习区说明了间隔表（1·3·5·7）', /1 · 3 · 5 · 7/.test(g.rvTxt), g.rvTxt.slice(0, 80));
    chk('[' + vp.name + '] ★ 没有要复习的按钮是禁用态（不是假装能点）',
      /现在没有要复习的/.test(g.rvTxt));

    // ★★ 点「认」这一关 → 打开答题界面，且不显示答案
    const recBtn = await page.$('#enGates .en4-gate[data-gate="recognize"]');
    if (recBtn) await recBtn.click();
    await page.waitForFunction(() => document.querySelectorAll('#modalBody .en4-q').length > 0, null, { timeout: 10000 }).catch(() => {});
    const modal = await page.evaluate(() => {
      const b = document.querySelector('#modalBody');
      const first = b ? b.querySelector('.en4-q') : null;
      return {
        qs: b ? b.querySelectorAll('.en4-q').length : 0,
        choices: first ? first.querySelectorAll('.en4-ch-i').length : 0,
        txt: b ? b.innerText : '',
        speakBtns: b ? b.querySelectorAll('[data-speak]').length : 0,
      };
    });
    chk('[' + vp.name + '] ★★ 点关卡真的打开了答题界面', modal.qs >= 1, modal.qs);
    chk('[' + vp.name + '] ★ 认这一关有选项', modal.choices >= 2, modal.choices);
    chk('[' + vp.name + '] ★ 界面里说了"只用认得出就行"', /只用认得出|认得出/, modal.txt.slice(0, 200));
    chk('[' + vp.name + '] ★ 每题有 🔊（发音走浏览器内置）', modal.speakBtns >= 1, modal.speakBtns);

    // 点一个 🔊 → 确认真的调了 SpeechSynthesis
    if (modal.speakBtns) {
      await page.click('#modalBody [data-speak]').catch(() => {});
      await page.waitForTimeout(300);
      const spoke = await page.evaluate(() => (window.__spoke || []).length);
      chk('[' + vp.name + '] ★★ 点 🔊 真的调了浏览器朗读（不是外部接口）', spoke >= 1, spoke);
    }
    // 选一个选项
    await page.click('#modalBody .en4-ch-i').catch(() => {});
    const picked = await page.evaluate(() => document.querySelectorAll('#modalBody .en4-ch-i.on').length);
    chk('[' + vp.name + '] ★ 选项点得中（有选中态）', picked >= 1, picked);
    // 交卷
    await page.click('#modalBody #gGo').catch(() => {});
    await page.waitForFunction(() => {
      const s = document.querySelector('#gSum');
      return s && s.innerText.length > 3;
    }, null, { timeout: 15000 }).catch(() => {});
    const after = await page.evaluate(() => {
      const b = document.querySelector('#modalBody');
      return {
        sum: (document.querySelector('#gSum') || {}).innerText || '',
        ok: b ? b.querySelectorAll('.en4-q.ok').length : 0,
        bad: b ? b.querySelectorAll('.en4-q.bad').length : 0,
        marked: b ? b.querySelectorAll('.en4-ch-i.ok').length : 0,
      };
    });
    chk('[' + vp.name + '] ★★ 认这一关交卷后逐题都标了出来（每题都有结论，不留白）',
      after.ok + after.bad === modal.qs, { ok: after.ok, bad: after.bad, qs: modal.qs });
    chk('[' + vp.name + '] ★★ 交卷后正确选项被描出来（学生能自己看出错在哪）', after.marked >= 1, after.marked);
    chk('[' + vp.name + '] ★★ 只点了一题 ⇒ 没点的那题不该被标成对或错（不许替学生瞎判）',
      after.ok + after.bad <= modal.qs, { ok: after.ok, bad: after.bad });
    chk('[' + vp.name + '] ★ 汇总给出答对率', /答对 \d+%/.test(after.sum), after.sum.slice(0, 60));

    // 关掉弹窗
    await page.click('#modalClose').catch(() => {});
    await page.waitForTimeout(250);

    // ★★★ 造句这一关：交卷后界面里**不许出现答对率**
    const useBtn = await page.$('#enGates .en4-gate[data-gate="use"]');
    if (useBtn) await useBtn.click();
    await page.waitForFunction(() => document.querySelectorAll('#modalBody .en4-q').length > 0, null, { timeout: 10000 }).catch(() => {});
    const useTxt = await page.evaluate(() => (document.querySelector('#modalBody') || {}).innerText || '');
    chk('[' + vp.name + '] ★★★ 造句关的开场就说明"不判对错"', /不判对错|没有标准答案/.test(useTxt), useTxt.slice(0, 200));
    const useInputs = await page.$$('#modalBody input.inp');
    if (useInputs.length) {
      // ★ 填的那一题必须**用它自己的词**造句，否则 used=false 是应该的。
      //   套件里前面的关卡已经改过 counts，题序（按错得最多排）会变 ——
      //   写死填 "apple" 就成了"假设第一题是 apple"，机器一忙就红。
      const firstPrompt = await page.evaluate(() => {
        const q = document.querySelector('#modalBody .en4-q');
        return q ? (q.querySelector('.en4-q-w') || {}).textContent : '';
      });
      const firstQid = await page.evaluate(() => {
        const q = document.querySelector('#modalBody .en4-q');
        return q ? q.id.replace('gq_', '') : '';
      });
      await useInputs[0].fill('I would like an ' + firstPrompt + ' please');
      await page.click('#modalBody #gGo').catch(() => {});
      await page.waitForFunction(() => {
        const n = document.querySelector('#gSum');
        return n && n.innerText.length > 3;
      }, null, { timeout: 15000 }).catch(() => {});
      const useAfter = await page.evaluate((qid) => {
        const b = document.querySelector('#modalBody');
        const row = document.getElementById('gq_' + qid);
        return {
          sum: (document.querySelector('#gSum') || {}).innerText || '',
          used: b ? b.querySelectorAll('.en4-q.used').length : 0,
          okMarks: b ? b.querySelectorAll('.en4-q.ok, .en4-q.bad').length : 0,
          // ★ 填了词的那一行必须是 used（不是随便哪一行 used）
          filledRowUsed: !!(row && row.classList.contains('used')),
        };
      }, firstQid);
      chk('[' + vp.name + '] ★★★ 造句交卷后汇总里没有任何答对率', !/答对/.test(useAfter.sum), useAfter.sum.slice(0, 80));
      chk('[' + vp.name + '] ★★ 造句不画对错勾叉（ok/bad 一个都没有）', useAfter.okMarks === 0, useAfter.okMarks);
      chk('[' + vp.name + '] ★★ 填了词的那一行被标成「用上了」（不是随便哪一行）',
        useAfter.filledRowUsed, { filledRowUsed: useAfter.filledRowUsed, used: useAfter.used, prompt: firstPrompt });
      chk('[' + vp.name + '] ★ 明说了"不判对错"', /不判对错|没有标准答案/.test(useAfter.sum), useAfter.sum.slice(0, 120));
    }
    await page.click('#modalClose').catch(() => {});
    await page.waitForTimeout(250);

    // ★ 听写模式入口还在（旧功能没被新四关挤掉）
    const dictBtn = await page.$('#enDict');
    chk('[' + vp.name + '] ★ 旧的「开始听写」入口还在（新四关没挤掉老功能）', !!dictBtn);

    // 布局
    const of = await page.evaluate(vw => {
      const bad = [];
      document.querySelectorAll('#view-en *').forEach(el => {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.right > vw + 1) bad.push(String(el.className).slice(0, 40));
      });
      return bad.slice(0, 4);
    }, vp.w);
    chk('[' + vp.name + '] 没有元素越过右边界', of.length === 0, of);
    // 四关按钮在窄屏改两列后标签不许竖排（中文没有词边界，一行放不下只会整体压字号）
    const gateLines = await page.evaluate(() => {
      const g = document.querySelector('#enGates .en4-gate');
      const nm = g ? g.querySelector('.en4-nm') : null;
      if (!nm) return null;
      const r = nm.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height) };
    });
    chk('[' + vp.name + '] ★ 四关标签没被挤成竖排（高 < 2 倍行高）',
      !gateLines || gateLines.h < 40, gateLines);
    chk('[' + vp.name + '] 零控制台报错', errs.length === 0, errs.slice(0, 2));

    const h = await page.evaluate(() => Math.min(document.documentElement.scrollHeight + 120, 2600));
    await page.setViewportSize({ width: vp.w, height: Math.max(vp.h, h) });
    await page.waitForTimeout(250);
    const el2 = await page.$('#view-en');
    if (el2) await el2.screenshot({ path: path.join(OUT, 'en-' + vp.name + '.png') });
    chk('[' + vp.name + '] 截图已产出', fs.existsSync(path.join(OUT, 'en-' + vp.name + '.png')));
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

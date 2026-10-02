'use strict';
/**
 * 批次16 浏览器验证：学习周报（增强版）。
 *
 * 为什么必须真浏览器跑：周报这一版的价值全在"**后端算出来、前端摆出来**"这件事上 ——
 * 静态断言只能证明 app.js 里写了这些字段名，证明不了"真打开看板时它们真的渲染出来了、
 * 日期选择器真的能改范围、超范围真的被拦住"。
 *
 * 覆盖的点击流：
 *   ① 进知识库 → 看板，周报区真的渲染出来（KPI / 逐天 / 按科目 / 卡住的卡 / 覆盖）
 *   ② ★ 三条硬规矩在界面上的证据：
 *      · 没有判据的答对率显示「—」而不是 0（`.w-na` 存在且文案含"算不出"）
 *      · 逐天里"没记录的那天"和"有记录的那天"**视觉不同**（灰虚线 vs 实色）
 *      · 「为什么不给分数」「这份周报不能证明什么」两个折叠区都在
 *   ③ 日期选择器：改区间真的会重新取数（标题/天数跟着变）
 *   ④ ★ 超范围（>7 天）被**前端**拦住并提示 —— 不让它白打一次 400
 *   ⑤ 快捷区间「最近 7 天 / 上周」可用
 *   ⑥ 阶段进度推进条真的按 totals 画出来了
 *   ⑦ 1440 / 390 两个视口都无横向溢出
 *   ⑧ 全程控制台零报错
 *
 * 自起服务、自找空闲端口、离线演示模式（不配 Key，不花 token）。
 * 跑法：NODE_PATH=<workspace>/node_modules node _parity16browser.cjs
 */
const net = require('net');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const { chromium } = require('playwright-core');

const NODE = process.execPath;
const ROOT = __dirname;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hl-p16br-'));
const DATA = path.join(TMP, 'data');

function findChrome() {
  if (process.env.CHROME && fs.existsSync(process.env.CHROME)) return process.env.CHROME;
  const root = path.join(process.env.LOCALAPPDATA || '', 'ms-playwright');
  let best = null, bestN = -1;
  try {
    for (const d of fs.readdirSync(root)) {
      const m = /^chromium-(\d+)$/.exec(d);
      if (!m) continue;
      const exe = path.join(root, d, 'chrome-win64', 'chrome.exe');
      if (fs.existsSync(exe) && Number(m[1]) > bestN) { bestN = Number(m[1]); best = exe; }
    }
  } catch (e) {}
  return best;
}

let pass = 0, fail = 0;
const failures = [];
// ★ 签名 (cond, name, extra)：批次12/13 的浏览器套件同款。
//   写反成 (name, cond) 会让"名字是非空字符串"恒为真 → 全部假绿。
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  \u2713 ' + name); }
  else { fail++; failures.push(name + (extra ? ' \u2192 ' + (typeof extra === 'string' ? extra : JSON.stringify(extra)) : '')); console.log('  \u2717 ' + name + (extra ? ' \u2192 ' + (typeof extra === 'string' ? extra : JSON.stringify(extra)) : '')); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
function freePort() {
  return new Promise(res => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
}
function dstr(off) {
  const d = new Date(); d.setDate(d.getDate() + off);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

(async () => {
  const PORT = await freePort();
  const BASE = 'http://127.0.0.1:' + PORT;
  const srvEnv = {
    PORT: String(PORT), DATA_DIR: DATA, NO_DOTENV: '1',
    LLM_API_KEY: '', ADMIN_PASSWORD: '', IMAGE_AI_ART: '0',
  };
  let srv = null;
  async function startServer() {
    srv = spawn(NODE, [path.join(ROOT, 'server.js')], { cwd: ROOT, env: Object.assign({}, process.env, srvEnv), stdio: ['ignore', 'pipe', 'pipe'] });
    srv.stderr.on('data', d => process.stderr.write('[srv] ' + d));
    for (let i = 0; i < 150; i++) {     // ★ 60 秒级等待：本机一次写要几百毫秒，15 秒会把"机器慢"报成"服务坏"
      try { const r = await fetch(BASE + '/api/health'); if (r.ok) return true; } catch (e) {}
      await sleep(400);
    }
    return false;
  }
  async function stopServer() {
    if (!srv) return;
    const s = srv; srv = null;
    s.kill();
    for (let i = 0; i < 40; i++) { await sleep(150); try { await fetch(BASE + '/api/health'); } catch (e) { return; } }
  }

  if (!await startServer()) { console.error('服务没起来'); process.exit(2); }

  const post = async (p, body, token) => {
    const url = BASE + p + (token ? (p.indexOf('?') >= 0 ? '&' : '?') + '_t=' + encodeURIComponent(token) : '');
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };

  // ---------- 造数据：让周报有内容可摆 ----------
  const sp = await post('/api/space', { name: '周报浏览器验证', password: '' });
  const spaceId = sp.body.spaceId;
  const token = sp.body.token;
  ok(!!spaceId && !!token, '建空间成功', sp.body);

  const defs = [
    ['一元二次方程的判别式', 'math'],
    ['牛顿第一定律', 'physics'],
    ['细胞膜的选择透过性', 'biology'],
  ];
  const cardIds = [];
  for (const [k, sub] of defs) {
    const r = await post('/api/cards', { knowledge: k, question: '请说明' + k, answer: 'a', type: 'choice', subject: sub }, token);
    if (r.body && r.body.card) cardIds.push(r.body.card.id);
  }
  ok(cardIds.length === 3, '造出 3 张知识卡', cardIds.length);

  // 第 1 张一直错（→ stuckCards + 按科目出现错），其余对
  for (let i = 0; i < cardIds.length; i++) {
    for (let k = 0; k < 2; k++) {
      const result = (i === 0) ? 'wrong' : 'right';
      await post('/api/cards/' + cardIds[i] + '/review', { result: result, answer: '我的作答', aiVerdict: '判为' + result, isFree: false }, token);
    }
  }

  const chromePath = findChrome();
  if (!chromePath) { await stopServer(); console.error('找不到 Chromium'); process.exit(2); }
  const browser = await chromium.launch({ executablePath: chromePath, args: ['--no-sandbox', '--disable-gpu'] });
  const errs = [];
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
  page.on('pageerror', e => errs.push('pageerror: ' + e.message));

  /**
   * 进知识库的某个二级分区。**只有一个实现，两个页面共用**（见下方注释）。
   *
   * ★ 为什么必须抽成参数化函数、且每个上下文都走它：
   *   `#kbTabs` 的 tab 是**切到知识库之后**才由 `renderKbTabs()` 建的。
   *   反证段第一版手写了这几步却漏了"先等 `.kb-tab` 出现"，于是
   *   `click('#kbTabs [data-sub="dash"]')` 报「locator resolved to <button>，
   *   element is not visible」并超时 30 秒 —— **报错信息看着像"看板被锁了"，
   *   实际是"tab 列表还没建出来"**。这类"每个上下文都要重来一遍"的流程，
   *   一律走同一份实现，不要手抄。
   *
   * ★★ 另一个坑（全量回归里才暴露）：**点击可能被 `enterApp()` 收尾时的
   *   `switchView('chat')` 覆盖掉**。进主界面的时序是：
   *     `#app` 变可见  →  …还有一长串 await…  →  `renderKbTabs()` → `switchView('chat')`
   *   而 `#app:not([hidden])` 在**第一步**就满足了。若机器很忙（全量回归里前面
   *   已经跑了二十几分钟），`await` 那一串会拖得很长，这时点「知识库」会被
   *   后面那句 `switchView('chat')` **顶回去** —— 于是 `#view-kb` 不 hidden 失败，
   *   报的还是「waiting for locator('#view-kb:not([hidden])') to be visible」。
   *   **单跑时机器空闲、时序刚好，100% 绿；全量回归里必红。**
   *
   *   所以这里不能只"点一次然后等"，要**等真正的前置条件，并在被覆盖时重试**：
   *   前置条件是「`.kb-tab` 已经渲染出来」（它意味着 `renderKbTabs()` 跑过了，
   *   `switchView('chat')` 也已经跑过或马上跑完），点完再用 `waitForFunction`
   *   确认视图**真的**停在知识库，没停就再点一次。
   */
  async function goSubOn(pg, key) {
    // ① 等 tab 真的渲染出来（`#kbTabs .kb-tab` 存在于 DOM，不代表可见 ——
    //    `#view-kb` 还是 hidden 的时候它们全都不可见，所以这里只等"存在"）。
    await pg.waitForFunction(() => document.querySelectorAll('#kbTabs .kb-tab').length > 0, null, { timeout: 20000 });
    // ② 点顶级导航，然后确认视图真的切过去了；被 `switchView('chat')` 覆盖就重试。
    let done = false;
    for (let attempt = 0; attempt < 4 && !done; attempt++) {
      await pg.click('.nav-i[data-view="kb"]');
      try {
        await pg.waitForFunction(() => {
          const kb = document.querySelector('#view-kb');
          return kb && !kb.hidden;
        }, null, { timeout: 4000 });
        done = true;
      } catch (e) { /* 被顶回去了，再点一次 */ }
    }
    if (!done) throw new Error('点了 4 次都没能停在知识库视图（可能被 switchView 反复覆盖）');
    // ③ 再点二级分区（此时 tab 一定在，且视图一定是知识库）
    await pg.click('#kbTabs [data-sub="' + key + '"]');
    await pg.waitForTimeout(250);
  }

  /** 主页面上的便捷包装（保持调用点简短） */
  async function goSub(key) { return goSubOn(page, key); }

  console.log('\n浏览器点击流');
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.land-tab[data-tab="enter"]', { timeout: 20000 });
  await page.click('.land-tab[data-tab="enter"]');
  await page.fill('#spId', spaceId);
  await page.click('#spEnter');
  await page.waitForSelector('#app:not([hidden])', { timeout: 20000 });
  ok(true, '登录进主界面');

  // ---------- ① 周报渲染出来了 ----------
  console.log('\n① 周报渲染');
  await goSub('dash');
  await page.waitForSelector('#weeklyBox .w-kpi', { timeout: 20000 });
  ok(true, '★ 看板里的周报区真的渲染出来了（能找到 .w-kpi）');

  const stat = await page.evaluate(() => {
    const q = s => document.querySelectorAll(s).length;
    return {
      kpi: q('#weeklyBox .w-kpi'),
      days: q('#weeklyBox .w-day'),
      daysHas: q('#weeklyBox .w-day.has'),
      subs: q('#weeklyBox .w-sub-row'),
      stuck: q('#weeklyBox .w-stuck'),
      cover: q('#weeklyBox .w-cover'),
      folds: q('#weeklyBox details.d-fold'),
      dateInputs: q('#weeklyBox input.w-date'),
      quicks: q('#weeklyBox .w-q'),
    };
  });
  ok(stat.kpi >= 4, 'KPI 卡片渲染出来了', stat.kpi);
  ok(stat.days === 7, '逐天条是 7 天（默认最近 7 天）', stat.days);
  ok(stat.daysHas >= 1, '★ 至少有 1 天被标为"有记录"', stat.daysHas);
  ok(stat.subs >= 1, '按科目分区有内容', stat.subs);
  ok(stat.stuck >= 1, '★ 卡住的卡被摆出来了（跨天累计统计生效）', stat.stuck);
  ok(stat.cover >= 1, '覆盖说明渲染出来了', stat.cover);
  ok(stat.folds === 2, '两个折叠区都在（为什么不给分数 / 不能证明什么）', stat.folds);
  ok(stat.dateInputs === 2, '日期选择器有起止两个输入框', stat.dateInputs);
  ok(stat.quicks === 2, '两个快捷区间按钮（最近7天 / 上周）', stat.quicks);

  // ---------- ② 三条硬规矩在界面上的证据 ----------
  console.log('\n② 数据诚实性（三条硬规矩）');
  // ★ 必须限定在 #weeklyBox .w-kpi 里找 .w-na。
  //   第一版直接 querySelectorAll('#weeklyBox .w-na')，抓到的全是**逐天条**里
  //   "这天没记录"的「空」—— 于是断言「显示的是 —」当场红，而产品其实是对的。
  //   这是"选择器没限定容器"的经典翻车（记忆里 data-doc 那条同族）。
  //   顺带据此把两个语义拆成了两个类名：.w-na（指标算不出来）/ .w-blank（这天没记录）。
  const na = await page.evaluate(() => {
    const els = Array.from(document.querySelectorAll('#weeklyBox .w-kpi .w-na'));
    return els.map(e => ({ txt: e.textContent.trim(), why: (e.parentElement.querySelector('.w-why') || {}).textContent || '' }));
  });
  // 这组数据里有记录，所以 KPI 的 records/reviews/cardsTouched 都算得出来、accuracy 也有值 ——
  // 此时**不该**出现 .w-na。真正的"算不出来"由下面 ②b 用空空间反证。
  ok(na.length === 0, '有记录时 KPI 不出现"算不出来"的位（不该滥用「—」）', JSON.stringify(na));

  const blanks = await page.evaluate(() => {
    const els = Array.from(document.querySelectorAll('#weeklyBox .w-day .w-blank'));
    return els.map(e => e.textContent.trim());
  });
  ok(blanks.length >= 1 && blanks.every(t => t === '空'), '★ "这天没记录"用的是 .w-blank 且文案是「空」', JSON.stringify(blanks));

  // 逐天条的百分位：没记录的那天必须是「—」，不能补 0%
  const dayPcts = await page.evaluate(() =>
    Array.from(document.querySelectorAll('#weeklyBox .w-day')).map(el => {
      const em = el.querySelector('em');
      return { has: el.classList.contains('has'), pct: em ? em.textContent.trim() : '' };
    }));
  ok(dayPcts.filter(d => !d.has).every(d => d.pct === '—'),
    '★ 没记录的那天答对率显示「—」（不是 0%）', JSON.stringify(dayPcts.filter(d => !d.has).slice(0, 3)));

  // 逐天条：有记录 vs 没记录必须视觉不同
  const dayStyles = await page.evaluate(() =>
    Array.from(document.querySelectorAll('#weeklyBox .w-day')).map(el => {
      const cs = getComputedStyle(el);
      return { has: el.classList.contains('has'), bg: cs.backgroundColor, border: cs.borderStyle };
    }));
  const hasDays = dayStyles.filter(d => d.has);
  const noDays = dayStyles.filter(d => !d.has);
  ok(hasDays.length >= 1 && noDays.length >= 1, '逐天条里"有记录"与"没记录"都存在', JSON.stringify({ has: hasDays.length, no: noDays.length }));
  if (hasDays.length && noDays.length) {
    ok(hasDays[0].bg !== noDays[0].bg, '★ "有记录的那天"与"没记录的那天"背景色不同（不是都长一样）',
      JSON.stringify({ has: hasDays[0].bg, no: noDays[0].bg }));
    ok(hasDays[0].border !== noDays[0].border, '★ 边框样式也不同（实线 vs 虚线）',
      JSON.stringify({ has: hasDays[0].border, no: noDays[0].border }));
  }
  const emptyDayTxt = await page.evaluate(() => {
    const el = document.querySelector('#weeklyBox .w-day:not(.has)');
    return el ? el.innerText.replace(/\s+/g, ' ').trim() : '';
  });
  ok(emptyDayTxt.indexOf('空') >= 0, '★ 没记录的那天写的是「空」而不是「0」（0 和"不知道"是两件事）', emptyDayTxt);

  const noteTxt = (await page.textContent('#weeklyBox .w-note') || '').replace(/\s+/g, ' ');
  ok(noteTxt.indexOf('没有记录') >= 0 && noteTxt.indexOf('不是') >= 0, '★ 逐天区下方明说了"灰色是没记录，不是 0 条"', noteTxt.slice(0, 80));

  // ---------- ②b 反证：空空间必须出现「—」+ 为什么 ----------
  // ★ 这一节是整个套件里最重要的一条。
  //   上面那组数据"算得出来"，所以 .w-na 一个都不该有 —— 那只能证明"没滥用「—」"，
  //   证明不了"该说算不出来时真的说了"。必须有**空空间**这个反面场景才闭环。
  //   这也是本项目"越界类测试必须做反证"的同一条方法论。
  console.log('\n②b 反证（空空间：该说算不出来时真的说了）');
  const sp2 = await post('/api/space', { name: '空空间反证' + Math.floor(Math.random() * 900 + 100), password: '' });
  const emptySid = sp2.body.spaceId, emptyTok = sp2.body.token;
  ok(!!emptySid && !!emptyTok, '建出第二个（空）空间', emptySid);

  const wkEmpty = await (await fetch(BASE + '/api/weekly?from=' + dstr(-6) + '&to=' + dstr(0) + '&_t=' + encodeURIComponent(emptyTok))).json();
  ok(wkEmpty && wkEmpty.report && wkEmpty.report.summary.accuracy === null,
    '★ 空空间的答对率接口层就是 null（不是 0）', wkEmpty && wkEmpty.report && wkEmpty.report.summary.accuracy);

  // 用第二个浏览器上下文登录空空间，看界面
  const ctx2 = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page2 = await ctx2.newPage();
  const errs2 = [];
  page2.on('console', m => { if (m.type() === 'error') errs2.push(m.text()); });
  page2.on('pageerror', e => errs2.push('pageerror: ' + e.message));
  await page2.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page2.waitForSelector('.land-tab[data-tab="enter"]', { timeout: 20000 });
  await page2.click('.land-tab[data-tab="enter"]');
  await page2.fill('#spId', emptySid);
  await page2.click('#spEnter');
  await page2.waitForSelector('#app:not([hidden])', { timeout: 20000 });
  // ★ 走同一个 goSubOn，不手抄那三步（手抄过一次，漏了等 tab 渲染，超时 30 秒）
  await goSubOn(page2, 'dash');
  await page2.waitForSelector('#weeklyBox .w-kpi', { timeout: 20000 });
  await page2.waitForTimeout(400);

  const naEmpty = await page2.evaluate(() => {
    const els = Array.from(document.querySelectorAll('#weeklyBox .w-kpi .w-na'));
    return els.map(e => ({ txt: e.textContent.trim(), why: (e.parentElement.querySelector('.w-why') || {}).textContent.trim() }));
  });
  ok(naEmpty.length >= 1, '★★ 空空间的 KPI 里出现了「算不出来」的位（不是补 0）', naEmpty.length);
  ok(naEmpty.every(x => x.txt === '—'), '★★ 那个位显示的是「—」，不是 0', JSON.stringify(naEmpty.map(x => x.txt)));
  ok(naEmpty.every(x => x.why && x.why.length > 0), '★★ 每个「—」都附了"为什么算不出来"的说明',
    JSON.stringify(naEmpty.map(x => x.why)).slice(0, 200));

  const zeroKpi = await page2.evaluate(() => {
    return Array.from(document.querySelectorAll('#weeklyBox .w-kpi')).map(el => {
      const b = el.querySelector('b');
      return { v: b ? b.textContent.trim() : '', label: (el.querySelector('span') || {}).textContent || '' };
    });
  });
  const recordsKpi = zeroKpi.filter(x => x.label.indexOf('留下的记录') >= 0)[0];
  ok(!!recordsKpi && recordsKpi.v === '0条', '★ "留下的记录"确实是 0（本来就是 0 的照实写 0）',
    JSON.stringify(recordsKpi));
  const accKpi = zeroKpi.filter(x => x.label.indexOf('答对的比例') >= 0)[0];
  ok(!!accKpi && accKpi.v === '—', '★★ 同一张卡片上：该是 0 的写 0、算不出来的写「—」（两种零分得清）',
    JSON.stringify(accKpi));

  await page2.screenshot({ path: path.join(TMP, '03-空空间-诚实的零.png') });
  ok(errs2.length === 0, '空空间页零控制台报错', errs2.slice(0, 3).join(' | '));
  await ctx2.close();

  // ---------- ③ 日期选择器能改区间 ----------
  console.log('\n③ 日期选择器');
  const beforeDays = await page.evaluate(() => document.querySelectorAll('#weeklyBox .w-day').length);
  await page.fill('#wFrom', dstr(-13));
  await page.fill('#wTo', dstr(-7));
  await page.waitForFunction(() => {
    const d = document.querySelectorAll('#weeklyBox .w-day');
    return d.length === 7 && d[0] && d[0].innerText.indexOf('10/') < 0;
  }, null, { timeout: 15000 }).catch(() => {});
  const afterRange = await page.evaluate(() => {
    const f = document.getElementById('wFrom'), t = document.getElementById('wTo');
    return { from: f ? f.value : null, to: t ? t.value : null, days: document.querySelectorAll('#weeklyBox .w-day').length };
  });
  ok(afterRange.from === dstr(-13) && afterRange.to === dstr(-7), '★ 改日期后输入框保留了选中的区间', JSON.stringify(afterRange));
  ok(afterRange.days === 7, '改区间后仍是 7 天条（重新取了数）', afterRange.days);
  ok(beforeDays === 7, '改之前也是 7 天', beforeDays);

  // ---------- ④ 超范围被前端拦住 ----------
  console.log('\n④ 超范围拦截');
  await page.fill('#wFrom', dstr(-20));
  await page.fill('#wTo', dstr(0));
  await page.waitForFunction(() => {
    const t = document.getElementById('toast');
    return t && !t.hidden && t.textContent.indexOf('7 天') >= 0;
  }, null, { timeout: 6000 }).catch(() => {});
  const toastTxt = await page.evaluate(() => {
    const t = document.getElementById('toast');
    return t && !t.hidden ? t.textContent.trim() : '(无 toast)';
  });
  ok(toastTxt.indexOf('7 天') >= 0, '★ 选超过 7 天时前端当场提示（不打无谓的 400）', toastTxt);
  const stillOld = await page.evaluate(() => {
    const f = document.getElementById('wFrom');
    const d = document.querySelectorAll('#weeklyBox .w-day');
    return { inputVal: f ? f.value : null, days: d.length, hasKpi: document.querySelectorAll('#weeklyBox .w-kpi').length };
  });
  ok(stillOld.hasKpi >= 4, '★ 被拦下后原来的周报还在（没被清空成错误页）', JSON.stringify(stillOld));

  // ---------- ⑤ 快捷区间 ----------
  console.log('\n⑤ 快捷区间');
  await page.locator('#weeklyBox .w-q', { hasText: '最近 7 天' }).click();
  await page.waitForFunction(() => {
    const f = document.getElementById('wFrom');
    return f && f.value === window.__today7;
  }, null, { timeout: 6000 }).catch(() => {});
  await page.waitForTimeout(900);
  const quick = await page.evaluate(() => {
    const f = document.getElementById('wFrom'), t = document.getElementById('wTo');
    return { from: f ? f.value : null, to: t ? t.value : null, days: document.querySelectorAll('#weeklyBox .w-day').length };
  });
  ok(quick.days === 7, '点「最近 7 天」回到 7 天窗口', JSON.stringify(quick));
  const onCount = await page.evaluate(() => document.querySelectorAll('#weeklyBox .w-q.on').length);
  ok(onCount >= 1, '★ 当前区间对应的快捷按钮处于选中态（.on）', onCount);

  await page.locator('#weeklyBox .w-q', { hasText: '上周' }).click();
  await page.waitForTimeout(1200);
  const lastWeek = await page.evaluate(() => {
    const f = document.getElementById('wFrom'), t = document.getElementById('wTo');
    return { from: f ? f.value : null, to: t ? t.value : null };
  });
  ok(lastWeek.to === dstr(-7), '★ 点「上周」跳到上一个 7 天窗口（结束日是 7 天前）', JSON.stringify(lastWeek));

  // 回到最近 7 天使截图内容完整
  await page.locator('#weeklyBox .w-q', { hasText: '最近 7 天' }).click();
  await page.waitForTimeout(1200);

  // ---------- ⑥ 阶段进度 ----------
  console.log('\n⑥ 阶段进度可视化');
  await page.waitForSelector('#dashPanels .dash-panel', { timeout: 20000 });
  const pg = await page.evaluate(() => {
    const panel = Array.from(document.querySelectorAll('#dashPanels .dash-panel')).find(x => x.innerText.indexOf('阶段进度') >= 0);
    if (!panel) return null;
    return {
      bars: panel.querySelectorAll('.pg-bar i').length,
      legend: panel.querySelectorAll('.pg-lg span').length,
      txt: panel.innerText.replace(/\s+/g, ' ').trim(),
    };
  });
  ok(!!pg, '★ 看板里有「阶段进度」面板（数据源是 dashboard.totals，不需要新接口）', pg ? '有' : '没有');
  if (pg) {
    ok(pg.bars >= 1, '推进条有分段（每段一个阶段）', pg.bars);
    ok(pg.legend === 4, '图例 4 项（还在学 / 快记住 / 已掌握 / 不用复习）', pg.legend);
    const sum = (pg.txt.match(/还在学 (\d+)/) || [])[1];
    ok(sum !== undefined, '★ 图例带上了各阶段张数', pg.txt.slice(0, 100));
  }
  ok(stat.kpi > 0, '阶段进度与周报共存（同一滚动容器里，不互抢高度）');

  // ---------- ⑦ 横向溢出（逐元素量 right）----------
  console.log('\n⑦ 布局');
  async function overflowAt(w, h) {
    await page.setViewportSize({ width: w, height: h });
    await page.waitForTimeout(500);
    return page.evaluate(() => {
      const vw = document.documentElement.clientWidth;
      const bad = [];
      // ★ 不跳过横滑容器会满屏假红：本页没有横滑容器，但仍按规矩写。
      document.querySelectorAll('#weeklyBox *, #dashPanels *').forEach(el => {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.right > vw + 1) {
          bad.push({ tag: el.tagName, cls: String(el.className).slice(0, 40), right: Math.round(r.right) });
        }
      });
      return { vw, bad: bad.slice(0, 5), n: bad.length };
    });
  }
  const of1440 = await overflowAt(1440, 1000);
  ok(of1440.n === 0, '1440 宽无横向溢出', JSON.stringify(of1440.bad));
  const of390 = await overflowAt(390, 1400);
  ok(of390.n === 0, '★ 390 窄屏无横向溢出（逐元素量的 right，不是 scrollWidth 那套假绿判据）', JSON.stringify(of390.bad));

  const boxOf = await page.evaluate(() => {
    const b = document.getElementById('weeklyBox');
    return { sw: b.scrollWidth, cw: b.clientWidth };
  });
  ok(boxOf.sw <= boxOf.cw + 1, '周报容器自身无内部溢出', JSON.stringify(boxOf));

  // ---------- ⑧ 截图 + 控制台 ----------
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(TMP, '01-看板-周报增强.png') });
  await page.evaluate(() => { const b = document.getElementById('weeklyBox'); if (b) b.scrollIntoView(); });
  await page.waitForTimeout(200);
  await page.locator('#weeklyBox').screenshot({ path: path.join(TMP, '02-周报区.png') }).catch(() => {});

  ok(errs.length === 0, '全程控制台零报错', errs.slice(0, 3).join(' | '));

  await browser.close();
  await stopServer();

  console.log('\n截图目录：' + TMP);
  console.log('\n批次16 浏览器（学习周报增强）：');
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  if (fail) { console.log('\n失败清单：'); failures.forEach(f => console.log('  ✗ ' + f)); }
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });

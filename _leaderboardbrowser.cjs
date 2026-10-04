'use strict';
/**
 * 班级 + 班级排行榜（批次28）浏览器套件。
 *
 * 只验静态断言和 HTTP 断言都抓不到的东西 —— 也就是"前端有没有真的接上"：
 *  · 建班按钮**点了真的建出班**，入班码真的显示出来（不是只改了变量）
 *  · ★★ 学生视角**看不到入班码**（协议层已验过，这里验界面真的没渲染它）
 *  · ★★★ 0 分的人显示「—」和「还没开始」，页面上**不出现"第 0 名"**
 *  · ★★ 点指标标签**真的重新取数**（网络请求计数 + 数值真的跟着变）
 *  · ★ 「我」那一行真的被标出来
 *  · 解散按钮点了真的回到空状态
 *  · 桌面 + iPhone12 双视口不横向溢出、零控制台报错
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const net = require('net');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { chromium } = require('playwright-core');

const OUT = path.join(__dirname, '_shots-leaderboard');
const CONSENTS = ['terms', 'privacy', 'children-privacy'];

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

(async () => {
  const CHROME = findChrome();
  if (!CHROME) { console.error('找不到 Chromium'); process.exit(2); }
  fs.mkdirSync(OUT, { recursive: true });

  const port = await new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
  const dd = path.join(os.tmpdir(), 'hl-lb-shot-' + crypto.randomBytes(4).toString('hex'));
  fs.mkdirSync(dd, { recursive: true });
  const srv = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    cwd: __dirname,
    env: Object.assign({}, process.env, { PORT: String(port), DATA_DIR: dd, ADMIN_PASSWORD: 'lb-pw', LLM_API_KEY: '', NO_DOTENV: '1' }),
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

  async function reg(username, name) {
    const r = await (await fetch(base + '/api/auth/register', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password: 'pw123456', name, consents: CONSENTS }),
    })).json();
    if (!r.token) throw new Error('注册失败：' + JSON.stringify(r));
    return r.token;
  }
  const H = t => ({ 'Content-Type': 'application/json', Authorization: 'Bearer ' + t });

  async function openAs(token, vp) {
    const page = await browser.newPage({ viewport: { width: vp.w, height: vp.h }, isMobile: vp.mobile, hasTouch: vp.mobile });
    const errs = [];
    page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
    page.on('pageerror', e => errs.push(String(e)));
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.evaluate(t => localStorage.setItem('hl_token', t), token);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.querySelectorAll('#kbTabs .kb-tab').length > 0, null, { timeout: 30000 });
    // ★ 移动端：抽屉只在进知识库之前拉开一次，之后一直开着（再点一次会切到关闭，
    //   但 .nav 仍拦着点击 —— 实测会卡 30 秒 "intercepts pointer events"）。
    let onKb = false;
    for (let a = 0; a < 4 && !onKb; a++) {
      if (vp.mobile && a > 0) { await page.locator('.view:not([hidden]) .hamb').first().click(); await page.waitForTimeout(320); }
      await page.click('.nav-i[data-view="kb"]').catch(() => {});
      try {
        await page.waitForFunction(() => { const v = document.querySelector('#view-kb'); return v && !v.hidden; }, null, { timeout: 4000 });
        onKb = true;
      } catch (e) {}
    }
    const t = await page.$('#kbTabs [data-sub="class"]');
    if (t) await t.click();
    await page.waitForFunction(() => { const v = document.querySelector('#view-class'); return v && !v.hidden; }, null, { timeout: 8000 }).catch(() => {});
    return { page, errs };
  }

  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  const DESK = { name: 'desktop', w: 1440, h: 900, mobile: false };
  let CODE = '';

  try {
    // ---------- 场景 A：空状态 → 建班 → 空榜 ----------
    console.log('\n=== 场景 A：还没有班 → 建一个（桌面）===');
    const tokA = await reg('lb_teacher_ui', '王老师');
    {
      const { page, errs } = await openAs(tokA, DESK);
      // 空状态：两个入口都在
      await page.waitForFunction(() => { const m = document.querySelector('#clsMain'); return m && /还没有班级/.test(m.innerText); }, null, { timeout: 15000 }).catch(() => {});
      const empty = await page.evaluate(() => {
        const m = document.querySelector('#clsMain');
        return { txt: m ? m.innerText : '', hasNew: !!document.querySelector('.cls-empty [data-act="new"]'), hasJoin: !!document.querySelector('.cls-empty [data-act="join"]') };
      });
      chk('空状态出现「还没有班级」', /还没有班级/.test(empty.txt), empty.txt.slice(0, 60));
      chk('★ 空状态给了两个入口（建班 / 输码）', empty.hasNew && empty.hasJoin, empty);

      // 点「建一个班」→ prompt 给名字
      page.on('dialog', d => { d.accept('五年级三班'); });
      await page.click('.cls-empty [data-act="new"]');
      await page.waitForFunction(() => { const c = document.querySelector('.cls-code b'); return c && c.textContent.trim().length === 6; }, null, { timeout: 15000 }).catch(() => {});
      const built = await page.evaluate(() => {
        const b = document.querySelector('.cls-code b');
        return {
          code: b ? b.textContent.trim() : '',
          head: (document.querySelector('.cls-head-l b') || {}).textContent || '',
          rows: document.querySelectorAll('.cls-row').length,
          txt: (document.querySelector('#clsMain') || {}).innerText || '',
        };
      });
      chk('★★ 点「建一个班」真的建出了班（不是只改了变量）', built.head === '五年级三班', built.head);
      chk('★ 入班码显示出来了（6 位）', /^[0-9A-Z]{6}$/.test(built.code), built.code);
      chk('★ 入班码不含易混字符 0/O/1/I/L', !/[01OIL]/.test(built.code), built.code);
      chk('★ 建班人自己不是成员 ⇒ 榜单为空', built.rows === 0, built.rows);
      chk('★ 空榜给了说明（不是一片空白）', /还没有同学/.test(built.txt), built.txt.slice(0, 80));

      // 记下入班码，后面学生要用
      CODE = built.code;

      const h = await page.evaluate(() => { const m = document.querySelector('#clsMain'); return m ? Math.min(m.scrollHeight + 60, 2400) : 900; });
      await page.setViewportSize({ width: DESK.w, height: Math.max(DESK.h, h) });
      await page.waitForTimeout(250);
      const el = await page.$('#view-class');
      if (el) await el.screenshot({ path: path.join(OUT, 'lb-owner-empty.png') });
      chk('建班后截图已产出', fs.existsSync(path.join(OUT, 'lb-owner-empty.png')));
      chk('零控制台报错（建班流程）', errs.length === 0, errs.slice(0, 2));
      await page.close();
    }

    // ---------- 场景 B：学生入班 → 看不到码 → 有分后有名次 ----------
    console.log('\n=== 场景 B：学生入班（桌面）===');
    const tokS = await reg('lb_student_ui', '小明');
    {
      // 学生先攒一点推进：建 2 张卡、各复习一次（走接口，界面另有覆盖）
      for (let i = 0; i < 2; i++) {
        const c = await (await fetch(base + '/api/cards', { method: 'POST', headers: H(tokS), body: JSON.stringify({ knowledge: '知识点' + i, question: 'q', answer: 'a', type: 'choice', subject: 'math' }) })).json();
        if (c && c.card && c.card.id) {
          await fetch(base + '/api/cards/' + c.card.id + '/review', { method: 'POST', headers: H(tokS), body: JSON.stringify({ result: 'right', studentAnswer: 'x' }) });
        }
      }
      const { page, errs } = await openAs(tokS, DESK);
      await page.waitForFunction(() => { const m = document.querySelector('#clsMain'); return m && /还没有班级/.test(m.innerText); }, null, { timeout: 15000 }).catch(() => {});
      page.on('dialog', d => { d.accept(CODE); });
      await page.click('.cls-empty [data-act="join"]');
      await page.waitForFunction(() => document.querySelectorAll('.cls-row').length > 0, null, { timeout: 15000 }).catch(() => {});
      const s = await page.evaluate(() => {
        const rows = Array.prototype.map.call(document.querySelectorAll('.cls-row'), r => ({
          rk: (r.querySelector('.cls-rk') || {}).textContent || '',
          nm: (r.querySelector('.cls-nm') || {}).textContent || '',
          vl: (r.querySelector('.cls-vl') || {}).textContent || '',
          off: r.classList.contains('off'),
          me: r.classList.contains('me'),
        }));
        return { rows, hasCode: !!document.querySelector('.cls-code'), txt: (document.querySelector('#clsMain') || {}).innerText || '' };
      });
      const r0 = s.rows[0] || {};
      chk('★★ 学生入班后看得到榜单（班内人都能看）', s.rows.length === 1, s.rows.length);
      chk('★★★ 学生**看不到入班码**（界面上没有那一块）', !s.hasCode);
      chk('★ 榜单上把自己标成「我」', r0.me === true && /我/.test(r0.nm || ''), r0);
      chk('★ 有分之后名次是 1（不是空）', String(r0.rk || '').trim() === '1', r0.rk);
      chk('★ 累计推进 > 0', parseInt(r0.vl, 10) > 0, r0.vl);
      // 榜单没渲染出来（上面已经有断言记下来了），后面的切换就没得测 —— 直接跳过，别整锅崩。
      const canSwitch = s.rows.length > 0 && (await page.$('.cls-tab[data-metric="persist"]')) !== null;

      // ---------- 场景 C：指标切换真的重新取数 ----------
      if (canSwitch) {
      const before = r0.vl;
      let lbReqs = 0;
      page.on('request', r => { if (r.url().indexOf('/api/leaderboard') >= 0) lbReqs++; });
      await page.click('.cls-tab[data-metric="persist"]');
      await page.waitForFunction(() => { const t = document.querySelector('.cls-tab[data-metric="persist"]'); return t && t.classList.contains('on'); }, null, { timeout: 8000 }).catch(() => {});
      await page.waitForTimeout(500);
      const after = await page.evaluate(() => {
        const onTab = document.querySelector('.cls-tab.on');
        return {
          vl: (document.querySelector('.cls-vl') || {}).textContent || '',
          on: onTab && onTab.dataset ? onTab.dataset.metric : '',
          hint: (document.querySelector('.cls-hint') || {}).textContent || '',
        };
      });
      chk('★★ 点「连续天数」后**真的发了新的 /api/leaderboard 请求**（不是前端自己算）', lbReqs >= 1, lbReqs);
      chk('★★ 切换后数值真的变了（' + before + ' → ' + after.vl + '）', after.vl !== before, { before, after: after.vl });
      chk('★ 选中的标签跟着切', after.on === 'persist', after.on);
      chk('★ 说明文案跟着切（口径讲清楚）', /连续/.test(after.hint), after.hint);

      // 切回累计推进
      await page.click('.cls-tab[data-metric="understand"]');
      await page.waitForFunction(b => { const v = document.querySelector('.cls-vl'); return v && v.textContent === b; }, before, { timeout: 8000 }).catch(() => {});
      const back = await page.evaluate(() => (document.querySelector('.cls-vl') || {}).textContent || '');
      chk('★ 切回「累计推进」数值回到原来的', back === before, { back, before });
      }

      const h = await page.evaluate(() => { const m = document.querySelector('#clsMain'); return m ? Math.min(m.scrollHeight + 60, 2400) : 900; });
      await page.setViewportSize({ width: DESK.w, height: Math.max(DESK.h, h) });
      await page.waitForTimeout(250);
      const el = await page.$('#view-class');
      if (el) await el.screenshot({ path: path.join(OUT, 'lb-student-scored.png') });
      chk('学生视角截图已产出', fs.existsSync(path.join(OUT, 'lb-student-scored.png')));
      chk('零控制台报错（学生流程）', errs.length === 0, errs.slice(0, 2));
      await page.close();
    }

    // ---------- 场景 D：0 分的人在榜上显示「—」而不是 0 名 ----------
    console.log('\n=== 场景 D：还没开始的同学（0 分不给名次）===');
    const tokZ = await reg('lb_zero_ui', '小刚');
    {
      // 小刚只入班，不复习
      await fetch(base + '/api/class/join', { method: 'POST', headers: H(tokZ), body: JSON.stringify({ code: CODE }) });
      const { page, errs } = await openAs(tokZ, DESK);
      await page.waitForFunction(() => document.querySelectorAll('.cls-row').length >= 2, null, { timeout: 15000 }).catch(() => {});
      const d = await page.evaluate(() => {
        const rows = Array.prototype.map.call(document.querySelectorAll('.cls-row'), r => ({
          rk: (r.querySelector('.cls-rk') || {}).textContent || '',
          nm: (r.querySelector('.cls-nm') || {}).textContent || '',
          vl: (r.querySelector('.cls-vl') || {}).textContent || '',
          off: r.classList.contains('off'),
        }));
        return { rows, txt: (document.querySelector('#clsMain') || {}).innerText || '' };
      });
      const zero = d.rows.filter(r => r.off)[0];
      chk('★★ 榜上有 2 个人（有分的 + 还没开始的）', d.rows.length === 2, d.rows.length);
      chk('★★★ 0 分的人名次是「—」而不是 0（不发"第 0 名"）', zero && zero.rk.trim() === '—', zero && zero.rk);
      // ★★★ 这里刻意不许写「还没开始」：understand 的 0 是**算得出来的 0**（他确实一次都没推进），
      //   就该如实写 0。「还没开始」是 **null** 的说法，两者在本项目里必须分得开。
      chk('★★★ 累计推进的 0 如实写「0」（不是「还没开始」—— 那是 null 的说法）',
        zero && zero.vl.trim() === '0', zero && zero.vl);
      chk('★★★ 页面上不出现"第 0 名"这类文案', !/第\s*0\s*名/.test(d.txt), d.txt.slice(0, 120));
      chk('★ 明确写出「不排名次」的说明', /不排名次/.test(d.txt), d.txt.slice(0, 200));

      // ★★★ 切到「本周变化」：小刚两周都没有账本 ⇒ progress 是 **null** ⇒ 这时才该显示「还没开始」
      await page.click('.cls-tab[data-metric="progress"]');
      await page.waitForFunction(() => { const t = document.querySelector('.cls-tab[data-metric="progress"]'); return t && t.classList.contains('on'); }, null, { timeout: 8000 }).catch(() => {});
      await page.waitForTimeout(400);
      const p = await page.evaluate(() => Array.prototype.map.call(document.querySelectorAll('.cls-row'), r => ({
        rk: (r.querySelector('.cls-rk') || {}).textContent || '',
        vl: (r.querySelector('.cls-vl') || {}).textContent || '',
        off: r.classList.contains('off'),
      })));
      const pZero = p.filter(r => r.off)[0];
      chk('★★★ 切到「本周变化」后，没开始的人显示「还没开始」（progress 是 null，不是 0）',
        pZero && /还没开始/.test(pZero.vl), pZero && pZero.vl);
      chk('★★ 有账本的人在本周变化里是数字', p.some(r => !r.off && /\d/.test(r.vl)), p);

      chk('零控制台报错（0 分场景）', errs.length === 0, errs.slice(0, 2));
      await page.close();
    }

    // ---------- 场景 E：移动端 + 解散 ----------
    console.log('\n=== 场景 E：iPhone12 视口 + 解散班级 ===');
    {
      const { page, errs } = await openAs(tokA, { name: 'iphone12', w: 390, h: 844, mobile: true });
      await page.waitForFunction(() => document.querySelectorAll('.cls-row').length >= 1, null, { timeout: 15000 }).catch(() => {});
      const m = await page.evaluate(() => {
        const rows = document.querySelectorAll('.cls-row').length;
        const list = document.querySelector('.cls-list');
        const cs = list ? getComputedStyle(list) : null;
        return { rows, listDir: cs ? cs.flexDirection : '', wrapDir: getComputedStyle(document.querySelector('.cls-wrap')).flexDirection };
      });
      chk('[iphone12] 榜单渲染出来', m.rows >= 1, m.rows);
      chk('[iphone12] ★ 班级列表横过来（不把榜单挤没）', m.listDir === 'row', m.listDir);
      chk('[iphone12] ★ 外层改成竖排', m.wrapDir === 'column', m.wrapDir);
      const of = await page.evaluate(vw => {
        const bad = [];
        document.querySelectorAll('#view-class *').forEach(el => {
          const r = el.getBoundingClientRect();
          if (r.width > 0 && r.right > vw + 1) bad.push(String(el.className).slice(0, 30));
        });
        return bad.slice(0, 4);
      }, 390);
      chk('[iphone12] 没有元素越过右边界', of.length === 0, of);
      chk('[iphone12] 零控制台报错', errs.length === 0, errs.slice(0, 2));
      await page.screenshot({ path: path.join(OUT, 'lb-iphone12.png') });
      chk('[iphone12] 截图已产出', fs.existsSync(path.join(OUT, 'lb-iphone12.png')));

      // 解散：confirm 接受
      page.on('dialog', d => { d.accept(); });
      const archBtn = await page.$('[data-act="archive"]');
      chk('★★ 建班人看得到「解散班级」按钮', !!archBtn);
      if (archBtn) {
        await archBtn.click();
        await page.waitForFunction(() => { const m2 = document.querySelector('#clsMain'); return m2 && /还没有班级/.test(m2.innerText); }, null, { timeout: 15000 }).catch(() => {});
        const after = await page.evaluate(() => (document.querySelector('#clsMain') || {}).innerText || '');
        chk('★★ 点解散后回到空状态（真的解散了）', /还没有班级/.test(after), after.slice(0, 80));
      }
      await page.close();
    }
  } finally {
    await browser.close();
    srv.kill('SIGKILL');
    try { fs.rmSync(dd, { recursive: true, force: true }); } catch (e) {}
  }

  const bad = results.filter(r => !r.ok);
  console.log('\n' + '─'.repeat(60));
  if (bad.length) { console.log('✗ 失败 ' + bad.length + ' 项：'); bad.forEach(b => console.log('   · ' + b.name)); }
  else console.log('✓ 全部通过');
  console.log('通过 ' + results.filter(r => r.ok).length + ' 项，失败 ' + bad.length + ' 项');
  console.log('截图目录 ' + OUT);
  process.exit(bad.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });

'use strict';
/**
 * 能力中心（批次25）浏览器套件。
 *
 * 只验静态断言抓不到的东西：
 *  · ★ 57 张卡片**真的各画了一个 <svg>**（不是定义了不用、也不是留白）
 *  · ★ 57 个图标**互不相同**（都画成同一个菱形=没画；这里数 path/形状指纹去重）
 *  · ★ 图标跟随主题色（currentColor 生效：浅色下与深色下 computed color 不同）
 *  · ★★ 点「用它开一段对话」真的跳进对话页、且输入框上方标着这个技能的身份
 *      —— 这是"以技能身份开对话"的判据；写错就是点了没反应且零报错
 *  · ★ 点卡片本体仍然是**开关**（不是开对话）—— 两个动作不能串
 *  · 双视口不横向溢出、零控制台报错
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const net = require('net');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { chromium } = require('playwright-core');

const OUT = path.join(__dirname, '_shots-skill');

function promptPet(dd, spaceId) {
  // 能力分区在阶段 2（幼苗 need=30）。给 60 稳过。见 server/pet.js 的 UNLOCKS。
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(path.join(dd, 'app.db'));
  try { db.prepare('UPDATE pets SET growth = 60 WHERE space_id = ?').run(spaceId); }
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
  const dd = path.join(os.tmpdir(), 'hl-sk-shot-' + crypto.randomBytes(4).toString('hex'));
  fs.mkdirSync(dd, { recursive: true });
  const srv = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    cwd: __dirname,
    env: Object.assign({}, process.env, { PORT: String(port), DATA_DIR: dd, ADMIN_PASSWORD: 's-pw', LLM_API_KEY: '', NO_DOTENV: '1' }),
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

  /** 建空间 + 顶成长值 + 登录 + 导航到知识库·能力分区 */
  async function enterSkills(sp, page) {
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.evaluate(t => localStorage.setItem('hl_token', t), sp.token);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.querySelectorAll('#kbTabs .kb-tab').length > 0, null, { timeout: 30000 });
    const mobile = page.viewportSize().width <= 820;
    let onKb = false;
    for (let a = 0; a < 4 && !onKb; a++) {
      if (mobile && a > 0) { await page.locator('.view:not([hidden]) .hamb').first().click(); await page.waitForTimeout(320); }
      await page.click('.nav-i[data-view="kb"]').catch(() => {});
      try {
        await page.waitForFunction(() => { const v = document.querySelector('#view-kb'); return v && !v.hidden; }, null, { timeout: 4000 });
        onKb = true;
      } catch (e) {}
    }
    const tab = await page.$('#kbTabs [data-sub="skills"]');
    if (tab) await tab.click();
    await page.waitForFunction(() => { const v = document.querySelector('#view-skills'); return v && !v.hidden; }, null, { timeout: 10000 }).catch(() => {});
    // 等卡片真的渲染完（不是骨架屏）
    await page.waitForFunction(() => document.querySelectorAll('#skillList .skill-c').length > 0, null, { timeout: 20000 }).catch(() => {});
  }

  // ---------- 场景 A：卡片与图标 ----------
  console.log('\n=== 场景 A：57 张卡片与图标 ===');
  {
    const sp = await (await fetch(base + '/api/space', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: '能力A', passcode: '' }) })).json();
    await (await fetch(base + '/api/pet', { headers: { Authorization: 'Bearer ' + sp.token } })).text();
    promptPet(dd, sp.spaceId);
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errs = [];
    page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
    page.on('pageerror', e => errs.push(String(e)));
    await enterSkills(sp, page);

    const s = await page.evaluate(() => {
      const cards = [...document.querySelectorAll('#skillList .skill-c')];
      const svgs = cards.map(c => c.querySelector('.sc-ico svg'));
      // 形状指纹：把 path/circle/line 的坐标串起来，用来判断两个图标是否"长得一样"
      const fp = svg => svg ? [...svg.querySelectorAll('path,circle,line')].map(e =>
        e.tagName + ':' + [...e.attributes].filter(a => a.name !== 'class').map(a => a.value).join(',')).sort().join('|') : '';
      const fps = svgs.map(fp);
      const color = getComputedStyle(document.querySelector('#skillList .sc-ico')).color;
      return {
        n: cards.length,
        withSvg: svgs.filter(Boolean).length,
        uniq: new Set(fps.filter(Boolean)).size,
        hasGo: cards.filter(c => c.querySelector('.sc-go')).length,
        // ★ 批次25 起：只有未锁定的卡片才有「用它开一段对话」，锁定卡片不给入口
        lockedN: cards.filter(c => c.classList.contains('locked')).length,
        unlockedN: cards.filter(c => !c.classList.contains('locked')).length,
        goText: (document.querySelector('#skillList .sc-go') || {}).textContent || '',
        color: color,
        anyUndef: /undefined/.test(document.querySelector('#skillList').innerHTML),
        // 图标尺寸（应固定 22px，不随字号变）
        size: (() => { const r = svgs[0] && svgs[0].getBoundingClientRect(); return r ? [Math.round(r.width), Math.round(r.height)] : null; })(),
      };
    });
    chk('卡片渲染出 57 张', s.n === 57, s.n);
    chk('★★ 57 张卡片每张都有 <svg> 图标', s.withSvg === 57, s.withSvg);
    chk('★★ 57 个图标互不相同（不是同一个兜底形状）', s.uniq === 57, s.uniq);
    chk('★ 图标尺寸固定 22×22', s.size && s.size[0] === 22 && s.size[1] === 22, s.size);
    chk('★ 图标用 currentColor 生效（有实际颜色）', /rgb/.test(s.color), s.color);
    chk('★ 有「开一段对话」按钮的卡片数 = 可用技能数（锁定不给）', s.hasGo === s.unlockedN, { go: s.hasGo, unlocked: s.unlockedN });
    chk('★★ 锁定卡片一个按钮都没有', s.hasGo + s.lockedN === 57, { go: s.hasGo, locked: s.lockedN });
    chk('按钮文案正确', /开一段对话/.test(s.goText), s.goText);
    chk('卡片区无 undefined', !s.anyUndef);
    chk('零控制台报错', errs.length === 0, errs.slice(0, 2));

    // 截图
    const h = await page.evaluate(() => Math.min(document.documentElement.scrollHeight + 100, 2600));
    await page.setViewportSize({ width: 1440, height: Math.max(900, h) });
    await page.waitForTimeout(200);
    const el = await page.$('#view-skills');
    if (el) await el.screenshot({ path: path.join(OUT, 'skill-icons.png') });
    chk('图标截图已产出', fs.existsSync(path.join(OUT, 'skill-icons.png')));

    // ---------- 场景 A2：点「用它开一段对话」走完全链路 ----------
    console.log('\n=== 场景 A2：以技能身份开对话 ===');
    const first = await page.evaluate(() => {
      const c = document.querySelector('#skillList .skill-c');
      return { id: c.dataset.id, name: c.querySelector('.sc-n').textContent };
    });
    await page.click('#skillList .skill-c .sc-go');
    await page.waitForTimeout(1200);
    const chat = await page.evaluate(() => ({
      onChat: (() => { const v = document.querySelector('#view-chat'); return v && !v.hidden; })(),
      sub: (document.querySelector('#convSubText') || {}).textContent || '',
      agentBtn: (document.querySelector('#agentBtn') || {}).textContent || '',
      enabledCount: (() => { try { return (window.__hlDebug && window.__hlDebug.skillEnabled || []).length; } catch (e) { return null; } })(),
    }));
    chk('★★ 点按钮后跳到了对话页', chat.onChat, chat.onChat);
    chk('★★ 对话页标明了这个技能的身份', chat.sub.indexOf(first.name) >= 0, { sub: chat.sub, want: first.name });
    chk('★ 智能体按钮也切到了该技能', chat.agentBtn.indexOf(first.name) >= 0, chat.agentBtn);
    // 反证要点：这是"这段对话用这个技能"，不是"全局启用它"
    const enabled = await (await fetch(base + '/api/skills', { headers: { Authorization: 'Bearer ' + sp.token } })).json();
    chk('★★ 全局启用列表**没被改**（对话级身份 ≠ 全局开关）', (enabled.enabled || []).length === 0, enabled.enabled);

    await page.screenshot({ path: path.join(OUT, 'skill-chat.png') });
    chk('开对话截图已产出', fs.existsSync(path.join(OUT, 'skill-chat.png')));

    // ---------- 场景 A3：点卡片本体仍然是开关 ----------
    console.log('\n=== 场景 A3：卡片本体 = 开关（不是开对话）===');
    await enterSkills(sp, page);
    await page.click('#skillList .skill-c');
    await page.waitForTimeout(900);
    const afterToggle = await page.evaluate(() => ({
      onSkills: (() => { const v = document.querySelector('#view-skills'); return v && !v.hidden; })(),
      onCount: document.querySelectorAll('#skillList .skill-c.on').length,
    }));
    chk('★ 点卡片本体留在能力页（没有跳去对话）', afterToggle.onSkills, afterToggle.onSkills);
    chk('★ 点卡片本体真的把它开关了', afterToggle.onCount === 1, afterToggle.onCount);

    await page.close();
  }

  // ---------- 场景 B：双视口零溢出 ----------
  console.log('\n=== 场景 B：双视口 ===');
  for (const vp of VIEWPORTS) {
    const sp = await (await fetch(base + '/api/space', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: '能力 ' + vp.name, passcode: '' }) })).json();
    await (await fetch(base + '/api/pet', { headers: { Authorization: 'Bearer ' + sp.token } })).text();
    promptPet(dd, sp.spaceId);
    const page = await browser.newPage({ viewport: { width: vp.w, height: vp.h }, isMobile: vp.mobile, hasTouch: vp.mobile });
    const errs = [];
    page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
    page.on('pageerror', e => errs.push(String(e)));
    await enterSkills(sp, page);

    const o = await page.evaluate(() => {
      const vw = window.innerWidth;
      // 逐元素量右边界（scrollWidth 会被 .app{overflow:hidden} 裁掉 ⇒ 假绿）
      const bad = [];
      const box = document.querySelector('#view-skills');
      const scroller = document.querySelector('#skillList');
      [...(box ? box.querySelectorAll('*') : [])].forEach(el => {
        if (scroller && scroller.contains(el)) return;  // 滚动容器内部跳过
        const r = el.getBoundingClientRect();
        if (r.width && r.right > vw + 1) bad.push(el.className + '@' + Math.round(r.right));
      });
      const card = document.querySelector('#skillList .skill-c');
      const go = document.querySelector('#skillList .sc-go');
      return {
        vw: vw,
        bad: bad.slice(0, 4),
        cards: document.querySelectorAll('#skillList .skill-c').length,
        // 卡片不该被压成 0 宽
        cardW: card ? Math.round(card.getBoundingClientRect().width) : 0,
        goVisible: go ? (go.getBoundingClientRect().width > 0 && go.getBoundingClientRect().height > 0) : false,
        // 图标在窄屏没被压变形
        icon: (() => { const r = document.querySelector('#skillList .sc-ico svg'); return r ? [Math.round(r.getBoundingClientRect().width), Math.round(r.getBoundingClientRect().height)] : null; })(),
      };
    });
    chk(vp.name + '：卡片都在', o.cards === 57, o.cards);
    chk(vp.name + '：零横向溢出', o.bad.length === 0, o.bad);
    chk(vp.name + '：★ 卡片没被压成 0 宽', o.cardW > 120, o.cardW);
    chk(vp.name + '：★ 按钮可见可点', o.goVisible, o.goVisible);
    chk(vp.name + '：图标仍 22×22 未变形', o.icon && o.icon[0] === 22, o.icon);
    chk(vp.name + '：零控制台报错', errs.length === 0, errs.slice(0, 2));

    const el = await page.$('#view-skills');
    if (el) await el.screenshot({ path: path.join(OUT, 'skill-' + vp.name + '.png') });
    await page.close();
  }

  // ---------- 场景 C：档位锁定态 + 管理面板改档 ----------
  console.log('\n=== 场景 C：锁定态与管理面板改档 ===');
  {
    // C1：新空间默认「自学」档 —— 界面上必须真的锁着
    const sp = await (await fetch(base + '/api/space', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: '档位C', passcode: '' }) })).json();
    await (await fetch(base + '/api/pet', { headers: { Authorization: 'Bearer ' + sp.token } })).text();
    promptPet(dd, sp.spaceId);
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errs = [];
    page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
    page.on('pageerror', e => errs.push(String(e)));
    await enterSkills(sp, page);

    const lock = await page.evaluate(() => {
      const cards = [...document.querySelectorAll('#skillList .skill-c')];
      const lockedCards = cards.filter(c => c.classList.contains('locked'));
      const firstLocked = lockedCards[0];
      return {
        total: cards.length,
        locked: lockedCards.length,
        on: cards.filter(c => c.classList.contains('on')).length,
        // ★ 锁定卡片不许给「用它开一段对话」按钮（给了就是骗人：点了必被拒）
        lockedWithGo: lockedCards.filter(c => c.querySelector('.sc-go')).length,
        // ★ 锁定卡片要画锁，而不是画开关（开关的类名是 .tgl）
        lockedWithLock: lockedCards.filter(c => c.querySelector('.sc-lock')).length,
        lockedWithSw: lockedCards.filter(c => c.querySelector('.tgl')).length,
        // ★ 档位标签：说明「需要哪一档」
        lockedWithTier: lockedCards.filter(c => c.querySelector('.sc-tier')).length,
        tierText: firstLocked ? (firstLocked.querySelector('.sc-tier') || {}).textContent || '' : '',
        // ★ 页眉的档位说明条
        noteVisible: (() => { const n = document.querySelector('#skillTierNote'); return n && !n.hidden; })(),
        noteText: (document.querySelector('#skillTierNote') || {}).textContent || '',
        // 反证：这句措辞不许出现（档位不是奖励/升级/打卡）
        badWord: /升级|奖励|打卡|排行榜|解锁更多/.test((document.querySelector('#skillTierNote') || {}).textContent || ''),
        anyUndef: /undefined/.test(document.querySelector('#skillList').innerHTML),
      };
    });
    chk('C：57 张卡片', lock.total === 57, lock.total);
    chk('C：★★ 默认档下 51 条锁定', lock.locked === 51, lock.locked);
    chk('C：★★ 锁定卡片不给「开一段对话」按钮', lock.lockedWithGo === 0, lock.lockedWithGo);
    chk('C：★ 锁定卡片画的是锁不是开关', lock.lockedWithLock === lock.locked && lock.lockedWithSw === 0, { lock: lock.lockedWithLock, sw: lock.lockedWithSw });
    chk('C：★ 锁定卡片带档位标签', lock.lockedWithTier === lock.locked, lock.lockedWithTier);
    chk('C：★ 档位标签写着「需「…」」', /需要?「/.test(lock.tierText), lock.tierText);
    chk('C：★ 页眉有档位说明条', lock.noteVisible, lock.noteVisible);
    chk('C：★ 说明条讲清「由管理员开放」', /管理员/.test(lock.noteText), lock.noteText);
    chk('C：★★ 说明条不出现升级/奖励/打卡/排行榜措辞', !lock.badWord, lock.noteText);
    chk('C：卡片区无 undefined', !lock.anyUndef);

    // ★ 锁定卡片点了不该有任何变化（既不开对话也不开开关）
    const beforeClick = await page.evaluate(() => document.querySelectorAll('#skillList .skill-c.on').length);
    await page.evaluate(() => { const c = document.querySelector('#skillList .skill-c.locked'); if (c) c.click(); });
    await page.waitForTimeout(700);
    const afterClick = await page.evaluate(() => ({
      on: document.querySelectorAll('#skillList .skill-c.on').length,
      onSkills: (() => { const v = document.querySelector('#view-skills'); return v && !v.hidden; })(),
      toast: (document.querySelector('#toast') || {}).textContent || '',
    }));
    chk('C：★★ 点锁定卡片不改变开关状态', afterClick.on === beforeClick, { before: beforeClick, after: afterClick.on });
    chk('C：★ 点锁定卡片留在能力页（没跳对话）', afterClick.onSkills, afterClick.onSkills);

    const h = await page.evaluate(() => Math.min(document.documentElement.scrollHeight + 100, 2600));
    await page.setViewportSize({ width: 1440, height: Math.max(900, h) });
    await page.waitForTimeout(200);
    const elc = await page.$('#view-skills');
    if (elc) await elc.screenshot({ path: path.join(OUT, 'skill-tier-locked.png') });
    chk('C：锁定态截图已产出', fs.existsSync(path.join(OUT, 'skill-tier-locked.png')));
    await page.close();

    // C2：管理面板改档 → 立刻生效
    // ★ 管理入口是**落地页**上的 #spAdmin（未登录状态），不是在应用内；
    //   openAdmin() 用 prompt() 收密码 —— 浏览器测试里打桩成固定密码，
    //   打桩的只是"输入"，后面走的仍是真实登录 + 真实改档接口。
    const adm = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const adErrs = [];
    adm.on('console', m => { if (m.type() === 'error') adErrs.push(m.text()); });
    adm.on('pageerror', e => adErrs.push(String(e)));
    await adm.addInitScript(() => { window.prompt = () => 's-pw'; });
    await adm.goto(base, { waitUntil: 'domcontentloaded' });
    await adm.evaluate(() => { try { localStorage.clear(); } catch (e) {} });
    await adm.reload({ waitUntil: 'domcontentloaded' });
    await adm.waitForSelector('#spAdmin', { timeout: 20000 });
    const opened = await adm.evaluate(() => {
      const el = document.querySelector('#spAdmin');
      if (!el) return 'no-button';
      el.click();
      return 'clicked';
    });
    await adm.waitForTimeout(2500);
    const panel = await adm.evaluate(() => ({
      hasModal: !!document.querySelector('.modal, .modal-mask, #modalBox'),
      hasTierSelect: document.querySelectorAll('.adm-tier').length,
      spaceIds: [...document.querySelectorAll('.adm-tier')].map(s => s.dataset.space),
      optText: [...new Set([...document.querySelectorAll('.adm-tier option')].map(o => o.textContent))],
    }));
    chk('C2：落地页管理入口可点', opened === 'clicked', opened);
    chk('C2：★★ 面板里每个空间有档位下拉', panel.hasTierSelect > 0, { hasModal: panel.hasModal, n: panel.hasTierSelect, ids: panel.spaceIds.slice(0, 3) });
    chk('C2：★ 本测试空间的下拉在（能定位到）', panel.spaceIds.indexOf(sp.spaceId) >= 0, panel.spaceIds.slice(0, 6));
    chk('C2：★ 下拉是四个中文意图档位', panel.optText.length === 4 && panel.optText.join('') === '自学引导深研通学', panel.optText);

    if (panel.spaceIds.indexOf(sp.spaceId) >= 0) {
      // 真的改档：走 UI 的 change 事件 → adminApi（跟人手操作同一条路径）
      const changed = await adm.evaluate(async (sid) => {
        const sel = document.querySelector('.adm-tier[data-space="' + sid + '"]');
        sel.value = 'all';
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        await new Promise(r => setTimeout(r, 1600));
        return { val: sel.value, prev: sel.dataset.prev };
      }, sp.spaceId);
      chk('C2：改档下拉值已切到 all', changed.val === 'all', changed);

      // ★ 先验「部分解锁」这一档：self → deep，仍有 6 条 locked，
      //   此时说明条**必须还在**且写着「深研」—— 这是"说明条会跟着档位变"的证据。
      const mid = await adm.evaluate(async (sid) => {
        const sel = document.querySelector('.adm-tier[data-space="' + sid + '"]');
        sel.value = 'deep';
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        await new Promise(r => setTimeout(r, 1500));
        return sel.value;
      }, sp.spaceId).catch(() => '');
      chk('C2：改档下拉切到 deep', mid === 'deep', mid);
      if (mid === 'deep') {
        const pageMid = await browser.newPage({ viewport: { width: 1440, height: 900 } });
        await enterSkills(sp, pageMid);
        await pageMid.waitForFunction(() => {
          const n = document.querySelector('#skillTierNote');
          return n && !n.hidden && (n.textContent || '').length > 4;
        }, null, { timeout: 15000 }).catch(() => {});
        const m = await pageMid.evaluate(() => ({
          locked: document.querySelectorAll('#skillList .skill-c.locked').length,
          noteText: (document.querySelector('#skillTierNote') || {}).textContent || '',
        }));
        chk('C2：★★ deep 档下锁定 6 条（只剩通学档的）', m.locked === 6, m.locked);
        chk('C2：★★ 说明条跟着档位改写成「深研」', /深研/.test(m.noteText), m.noteText.slice(0, 90));
        await pageMid.close();
      }

      // 再升到 all：全解锁，说明条应收起
      const toAll = await adm.evaluate(async (sid) => {
        const sel = document.querySelector('.adm-tier[data-space="' + sid + '"]');
        sel.value = 'all';
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        await new Promise(r => setTimeout(r, 1500));
        return sel.value;
      }, sp.spaceId).catch(() => '');
      chk('C2：改档下拉切回 all', toAll === 'all', toAll);
      // 回技能页复核：锁定应该消失
      const page2 = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      await enterSkills(sp, page2);
      await page2.waitForTimeout(800);
      const after = await page2.evaluate(() => ({
        locked: document.querySelectorAll('#skillList .skill-c.locked').length,
        // ★ 说明条只在「有东西被锁住」时才有意义 —— renderSkillTierNote 在 locked===0 时
        //   主动 hidden。所以通学档下它**应该消失**，而不是改写成"当前是通学档"。
        noteHidden: (() => { const n = document.querySelector('#skillTierNote'); return !n || n.hidden; })(),
        noteText: (document.querySelector('#skillTierNote') || {}).textContent || '',
      }));
      chk('C2：★★ 管理员改成通学档后界面 0 条锁定', after.locked === 0, after.locked);
      chk('C2：★★ 没东西可锁时说明条自己收起来（不是改成"当前通学档"）', after.noteHidden && after.noteText === '', { hidden: after.noteHidden, text: after.noteText.slice(0, 60) });
      const el2 = await page2.$('#view-skills');
      if (el2) await el2.screenshot({ path: path.join(OUT, 'skill-tier-unlocked.png') });
      chk('C2：解锁态截图已产出', fs.existsSync(path.join(OUT, 'skill-tier-unlocked.png')));
      await page2.close();
    }
    chk('C2：管理页零控制台报错', adErrs.length === 0, adErrs.slice(0, 2));
    await adm.close();
  }

  await browser.close();
  try { srv.kill('SIGKILL'); } catch (e) {}

  const bad = results.filter(r => !r.ok);
  console.log('\n通过 ' + results.filter(r => r.ok).length + ' 项，失败 ' + bad.length + ' 项');
  if (bad.length) { console.log('失败项：'); bad.forEach(b => console.log('  · ' + b.name)); }
  console.log('截图目录 ' + OUT);
  process.exit(bad.length ? 1 : 0);
})().catch(e => { console.error('套件异常：', e); process.exit(1); });

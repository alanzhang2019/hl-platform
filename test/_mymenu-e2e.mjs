// 端到端验证：空间卡 / 成长条 / 公告 是否真的从侧栏搬进了右上角「我的」菜单。
//
//   node test/_mymenu-e2e.mjs
//
// 验六件事：
//   ① 侧栏里那三块（.space-pill / .pet-line / .ann-line）已经不存在
//   ② 侧栏顶部高度确实降下来了（腾出竖向空间给项目列表）
//   ③ 「我的」菜单里有空间 ID、切换空间、成长条、公告
//   ④ 成长条在不同阶段渲染出的文案正确（直接改库里的 growth 再刷新）
//   ⑤ 全程没有 JS 报错（删元素最容易留下 null 引用）
//   ⑥ 收起侧栏 + 窄屏两种布局下都不报错、不塌
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const PW_CORE = process.env.PW_CORE
  || 'file:///C:/Users/Administrator/.workbuddy-ai/binaries/node/workspace/node_modules/playwright-core/index.mjs';
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 3462;
const { chromium } = await import(PW_CORE);

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hl-mymenu-'));
const srv = spawn(process.execPath, ['server.js'], {
  cwd: ROOT,
  env: { ...process.env, NO_DOTENV: '1', LLM_API_KEY: '', DATA_DIR, PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
srv.stderr.on('data', d => { const s = String(d); if (!/ExperimentalWarning|experimental/.test(s)) process.stderr.write('[srv] ' + s); });

async function waitHealth() {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`http://localhost:${PORT}/api/health`)).ok) return true; } catch (e) {}
    await new Promise(r => setTimeout(r, 250));
  }
  return false;
}

let failed = false;
const results = [];
function check(name, ok, extra) {
  results.push([name, ok, extra]);
  if (!ok) failed = true;
}

try {
  if (!await waitHealth()) throw new Error('服务没起来');
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errs = [];
  page.on('pageerror', e => errs.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errs.push('console.error: ' + m.text()); });
  page.on('dialog', d => d.accept());

  await page.goto(`http://localhost:${PORT}/`);
  const reg = await page.evaluate(async (port) => {
    const r = await fetch(`http://localhost:${port}/api/auth/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'menuuser', password: 'menupass1', name: '小测', consents: ['terms', 'privacy', 'children-privacy'] }),
    });
    return await r.json();
  }, PORT);
  if (!reg.token) throw new Error('注册失败 ' + JSON.stringify(reg));
  await page.evaluate(t => localStorage.setItem('hl_token', t), reg.token);
  await page.reload();
  await page.waitForTimeout(1200);

  // ① 侧栏三块已移除
  const gone = await page.evaluate(() => ({
    pill: document.querySelectorAll('.side .space-pill').length,
    pet: document.querySelectorAll('.side .pet-line').length,
    ann: document.querySelectorAll('.side .ann-line').length,
    brand: !!document.querySelector('.side .brand > b'),
  }));
  check('① 侧栏已无空间卡 / 成长条 / 公告', gone.pill === 0 && gone.pet === 0 && gone.ann === 0,
    `space-pill=${gone.pill} pet-line=${gone.pet} ann-line=${gone.ann}`);
  check('① 侧栏品牌名保留', gone.brand === true);

  // ② 侧栏顶部高度降下来
  const brandH = await page.evaluate(() => Math.round(document.querySelector('.side .brand').getBoundingClientRect().height));
  check('② 侧栏顶部高度 ≤ 100px（原 234px）', brandH <= 100, `实测 ${brandH}px`);

  // ③ 菜单内容
  await page.locator('.me-chip').first().click();
  await page.waitForTimeout(600);
  const menu = await page.evaluate(() => {
    const txt = (document.querySelector('#modalBody') || {}).innerText || '';
    return {
      hasId: /空间 ID/.test(txt),
      hasSwitch: !!document.querySelector('#meSwitchSpace'),
      hasPet: !!document.querySelector('#mePetLine'),
      petText: (document.querySelector('#mePetLine') || {}).innerText || '',
      items: ['记忆', '设置', '公告', '退出登录'].filter(k => txt.indexOf(k) >= 0),
    };
  });
  check('③ 菜单里有空间 ID', menu.hasId);
  check('③ 菜单里有「切换空间」', menu.hasSwitch);
  check('③ 菜单里有成长条', menu.hasPet, '「' + menu.petText.replace(/\s+/g, ' ') + '」');
  check('③ 四个原菜单项都还在', menu.items.length === 4, menu.items.join(' / '));
  await page.locator('#modalBody .mclose, #modalBody [data-close], .modal-x').first().click().catch(() => {});
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);

  // ④ 各阶段的成长条文案。
  //    没有"设置成长值"的接口（也不该有 —— 那是刷分入口），所以直接改测试库，
  //    再让页面重新拉一次 /api/pet，走的是和线上完全一样的渲染链路。
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path.join(DATA_DIR, 'app.db'));
  const cases = [
    [0, '嫩芽', '还差 30 点', '解锁 能力'],
    [30, '幼苗', '还差 60 点', '解锁 记忆、测评'],
    [90, '小树', '还差 110 点', '解锁 英语'],
    [200, '大树', '还差 200 点', '解锁 共享池'],
    [400, '参天', '已长成', ''],
  ];
  for (const [g, stageName, toNext, unlock] of cases) {
    db.prepare('UPDATE pets SET growth = ?').run(g);
    const txt = await page.evaluate(async (port) => {
      const t = localStorage.getItem('hl_token');
      const r = await fetch(`http://localhost:${port}/api/pet`, { headers: { Authorization: 'Bearer ' + t } });
      const j = await r.json();
      const p = j.pet;
      const nx = j.unlocks && j.unlocks.next;
      return p.stageName + ' · ' + (p.maxed ? '已长成'
        : '还差 ' + p.toNext + ' 点' + (nx && nx.labels && nx.labels.length ? '解锁 ' + nx.labels.join('、') : ''));
    }, PORT);
    const ok = txt.indexOf(stageName) >= 0 && txt.indexOf(toNext) >= 0 && (!unlock || txt.indexOf(unlock) >= 0);
    check(`④ growth=${g} → ${stageName}`, ok, '「' + txt + '」');
  }
  // 菜单里的成长条也要跟着变（不只是接口返回值对）
  db.prepare('UPDATE pets SET growth = ?').run(90);
  await page.reload();
  await page.waitForTimeout(1000);
  await page.locator('.me-chip').first().click();
  await page.waitForTimeout(600);
  const domTxt = await page.evaluate(() => ((document.querySelector('#mePetLine') || {}).innerText || '').replace(/\s+/g, ' '));
  check('④ 菜单里的成长条渲染跟着变（growth=90 → 小树）', domTxt.indexOf('小树') >= 0 && domTxt.indexOf('还差 110 点') >= 0, '「' + domTxt + '」');
  db.close();
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);

  // ⑤ 无 JS 报错
  check('⑤ 全程无 JS 报错', errs.length === 0, errs.slice(0, 3).join(' | '));

  // ⑥ 收起侧栏 + 窄屏
  const errsBefore = errs.length;
  await page.locator('#sideToggle').click();
  await page.waitForTimeout(500);
  const minOk = await page.evaluate(() => {
    const app = document.querySelector('.app');
    const side = document.querySelector('.side');
    return { min: app.classList.contains('side-min'), w: Math.round(side.getBoundingClientRect().width) };
  });
  check('⑥ 收起侧栏后宽度变窄', minOk.min && minOk.w <= 80, `side-min=${minOk.min} 宽=${minOk.w}px`);
  await page.locator('#sideToggle').click();
  await page.waitForTimeout(400);

  await page.setViewportSize({ width: 390, height: 800 });
  await page.waitForTimeout(700);
  const narrow = await page.evaluate(() => {
    const tb = document.querySelector('.topbar');
    return { overflow: document.documentElement.scrollWidth > window.innerWidth + 2, tbW: tb ? Math.round(tb.getBoundingClientRect().width) : 0 };
  });
  check('⑥ 窄屏（390px）不出现横向溢出', !narrow.overflow, 'topbar 宽 ' + narrow.tbW);
  check('⑥ 窄屏下也没新增报错', errs.length === errsBefore, errs.slice(errsBefore).join(' | '));

  await browser.close();
} catch (e) {
  console.error('运行出错：' + (e && e.message));
  failed = true;
} finally {
  try { srv.kill('SIGKILL'); } catch (e) {}
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch (e) {}
}

console.log('');
for (const [name, ok, extra] of results) {
  console.log('  ' + (ok ? '\u2705' : '\u274c') + ' ' + name + (extra ? '  ' + extra : ''));
}
console.log('\n结果：' + results.filter(r => r[1]).length + ' 通过 / ' + results.filter(r => !r[1]).length + ' 失败');
process.exit(failed ? 1 : 0);

// 起本地服务 + 真浏览器，注册一个账号并截图，用来看真实布局。
// 用法：node test/_shot.mjs [输出文件名前缀]
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
const PORT = Number(process.env.PORT || 3461);
const W = Number(process.env.W || 1440);
const H = Number(process.env.H || 900);
const OUT = path.join(HERE, (process.argv[2] || 'shot'));
const { chromium } = await import(PW_CORE);

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hl-shot-'));
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

try {
  if (!await waitHealth()) throw new Error('服务没起来');
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage({ viewport: { width: W, height: H } });
  page.on('dialog', d => d.accept());
  await page.goto(`http://localhost:${PORT}/`);
  const reg = await page.evaluate(async (port) => {
    const r = await fetch(`http://localhost:${port}/api/auth/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'shotuser', password: 'shotpass1', name: '小测', consents: ['terms', 'privacy', 'children-privacy'] }),
    });
    return await r.json();
  }, PORT);
  await page.evaluate(t => localStorage.setItem('hl_token', t), reg.token);
  await page.reload();
  await page.waitForTimeout(1500);
  // 发一条消息，让界面进入"有内容"的状态
  await page.locator('#input').fill('帮我看看这道分数题');
  await page.locator('#send').click();
  await page.waitForTimeout(2500);

  await page.screenshot({ path: OUT + '-full.png' });
  console.log('整页 → ' + OUT + '-full.png');

  const side = await page.locator('#side').boundingBox();
  if (side) {
    await page.screenshot({ path: OUT + '-side.png', clip: side });
    console.log('侧栏 → ' + OUT + '-side.png  (' + Math.round(side.width) + 'x' + Math.round(side.height) + ')');
  }
  const tb = await page.locator('.topbar').first().boundingBox();
  if (tb) {
    await page.screenshot({ path: OUT + '-topbar.png', clip: tb });
    console.log('顶栏 → ' + OUT + '-topbar.png  (' + Math.round(tb.width) + 'x' + Math.round(tb.height) + ')');
  }

  // 打开「我的」菜单再截一张
  await page.locator('.me-chip').first().click();
  await page.waitForTimeout(700);
  await page.screenshot({ path: OUT + '-mymenu.png' });
  console.log('我的菜单 → ' + OUT + '-mymenu.png');
  const has = await page.evaluate(() => ({
    pet: !!document.querySelector('#mePetLine'),
    petText: (document.querySelector('#mePetLine') || {}).innerText || '',
    sw: !!document.querySelector('#meSwitchSpace'),
    badge: (document.querySelector('.me-badge') || {}).textContent || '(无)',
  }));
  console.log('  菜单内成长条：' + (has.pet ? '有' : '缺') + '  文案「' + has.petText.replace(/\s+/g, ' ') + '」');
  console.log('  切换空间按钮：' + (has.sw ? '有' : '缺') + '   公告红点：' + has.badge);
  // 把关键元素的位置报出来
  const info = await page.evaluate(() => {
    const pick = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return sel + ' → (不存在)';
      const r = el.getBoundingClientRect();
      return sel + ' → x=' + Math.round(r.x) + ' y=' + Math.round(r.y)
        + ' w=' + Math.round(r.width) + ' h=' + Math.round(r.height);
    };
    return ['.side', '.brand', '.space-pill', '.pet-line', '.ann-line', '.topbar', '.tb-tools', '.me-chip'].map(pick);
  });
  console.log('\n元素位置：');
  info.forEach(s => console.log('  ' + s));

  await browser.close();
} finally {
  try { srv.kill('SIGKILL'); } catch (e) {}
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch (e) {}
}

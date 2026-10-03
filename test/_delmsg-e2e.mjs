// 端到端验证「删除我的消息」。
// 本地起真服务（mock 模型，零依赖 node:sqlite），真浏览器注册 → 发一条 → 删自己那条。
//
//   node test/_delmsg-e2e.mjs           → 验修复后（应 PASS）
//   REVERT=1 node test/_delmsg-e2e.mjs  → 临时撤掉修复（应 FAIL，证明这个测试抓得住 bug）
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const APP = path.join(ROOT, 'public', 'js', 'app.js');

// playwright-core 不在项目依赖里（本项目零依赖），用环境变量指路；
// PW_CORE 指向 index.mjs，CHROME_PATH 指向本机 Chrome。
const PW_CORE = process.env.PW_CORE
  || 'file:///C:/Users/Administrator/.workbuddy-ai/binaries/node/workspace/node_modules/playwright-core/index.mjs';
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const { chromium } = await import(PW_CORE);
const PORT = 3457;
const REVERT = process.env.REVERT === '1';

// ── 可选：临时撤掉修复，验证测试确实能发现 bug ──
const orig = fs.readFileSync(APP, 'utf8');
const FIXLINE = "if (j.messageId && !u.data.id) { u.data.id = j.messageId; u.el.dataset.mid = j.messageId; }";
if (REVERT) {
  if (!orig.includes(FIXLINE)) { console.error('找不到修复行，无法撤掉'); process.exit(2); }
  fs.writeFileSync(APP, orig.replace(FIXLINE, '/* REVERTED */'), 'utf8');
  console.log('⚠️ 已临时撤掉修复（REVERT=1）');
}

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hl-e2e-'));
const srv = spawn(process.execPath, ['server.js'], {
  cwd: ROOT,
  env: { ...process.env, NO_DOTENV: '1', LLM_API_KEY: '', DATA_DIR, PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
srv.stderr.on('data', d => { const s = String(d); if (!/ExperimentalWarning|SQLite is an experimental/.test(s)) process.stderr.write('[srv] ' + s); });

async function waitHealth() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://localhost:${PORT}/api/health`);
      if (r.ok) return true;
    } catch (e) {}
    await new Promise(r => setTimeout(r, 250));
  }
  return false;
}

function cleanup() {
  try { srv.kill('SIGKILL'); } catch (e) {}
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch (e) {}
  if (REVERT) { try { fs.writeFileSync(APP, orig, 'utf8'); console.log('已还原修复'); } catch (e) {} }
}

let failed = false;
try {
  if (!await waitHealth()) throw new Error('服务没起来');
  console.log('服务已就绪 :' + PORT + '（mock 模型）');

  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on('dialog', d => d.accept());          // 删除前有 confirm，一律确认
  page.on('pageerror', e => console.log('⚠️ 页面报错：' + e.message));
  await page.goto(`http://localhost:${PORT}/`);

  // 直接调接口注册，拿到 token 塞进 localStorage —— 绕开注册表单，专注在消息删除上
  const reg = await page.evaluate(async (port) => {
    const r = await fetch(`http://localhost:${port}/api/auth/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'e2euser', password: 'e2epass123', name: 'E2E',
        consents: ['terms', 'privacy', 'children-privacy'],
      }),
    });
    return await r.json();
  }, PORT);
  if (!reg.token) throw new Error('注册失败：' + JSON.stringify(reg));
  console.log('注册成功 spaceId=' + reg.spaceId);
  await page.evaluate(t => localStorage.setItem('hl_token', t), reg.token);
  await page.reload();
  await page.waitForTimeout(600);

  // 发一条消息，等回复落定
  await page.locator('#input').fill('帮我把 37+45 算出来');
  await page.locator('#send').click();
  await page.waitForSelector('.msg.user', { timeout: 15000 });
  await page.waitForTimeout(2500);   // 等 mock 回复流完、操作条刷出来

  const userMsg = page.locator('.msg.user').first();
  const mid = await userMsg.getAttribute('data-mid');
  console.log('用户消息 data-mid = ' + (mid || '(空)'));

  const btns = await userMsg.locator('.acts [data-a="delete"]').count();
  console.log('用户消息上的「删除消息」按钮：' + btns + ' 个');

  const before = await page.locator('.msg.user').count();
  await userMsg.locator('.acts [data-a="delete"]').click();
  await page.waitForTimeout(1200);
  const after = await page.locator('.msg.user').count();
  console.log(`删除前 .msg.user = ${before} → 删除后 = ${after}`);

  // ── 顺带验图表模式开关：勾上之后请求体里必须带 visualize:true ──
  const seen = [];
  page.on('request', req => {
    if (req.url().indexOf('/api/chat/stream') >= 0 && req.method() === 'POST') {
      try { seen.push(JSON.parse(req.postData() || '{}')); } catch (e) {}
    }
  });
  await page.locator('#input').fill('讲讲什么是分数');
  await page.locator('#send').click();
  await page.waitForTimeout(1800);
  const vizOff = seen.length ? !!seen[seen.length - 1].visualize : null;

  const chk = page.locator('#vizChk');
  const hasChk = await chk.count();
  if (hasChk) await chk.check();
  await page.locator('#input').fill('讲讲什么是小数');
  await page.locator('#send').click();
  await page.waitForTimeout(1800);
  const vizOn = seen.length ? !!seen[seen.length - 1].visualize : null;
  console.log(`图表模式开关：未勾选时 visualize=${vizOff}，勾选后 visualize=${vizOn}（共捕获 ${seen.length} 次请求）`);

  const ok = !!mid && btns === 1 && after === before - 1 && hasChk === 1 && vizOff === false && vizOn === true;
  console.log('\n结论：' + (ok
    ? '✅ 通过 —— 用户消息带上了服务端 id，点「删除消息」确实删掉了；图表模式开关也确实把 visualize 送到了服务端'
    : '❌ 未通过'));

  // 顺带确认服务端确实软删了
  if (mid) {
    const g = await page.evaluate(async (a) => {
      const r = await fetch(`http://localhost:${a.port}/api/messages/${a.mid}`, { headers: { Authorization: 'Bearer ' + a.t } });
      return { status: r.status, body: await r.json().catch(() => null) };
    }, { port: PORT, mid, t: reg.token });
    console.log('删除后按 id 查该消息：HTTP ' + g.status + (g.status === 404 ? '（已不可见，符合软删语义）' : ' ' + JSON.stringify(g.body)));
  }

  await browser.close();
  failed = !ok;
} catch (e) {
  console.error('运行出错：' + (e && e.message));
  failed = true;
} finally {
  cleanup();
}
process.exit(failed ? 1 : 0);

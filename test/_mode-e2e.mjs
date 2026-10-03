// 端到端验证「学习模式」有没有真的生效、以及切换/刷新后会不会被悄悄重置。
//
//   node test/_mode-e2e.mjs           → 验修复后（应 PASS）
//   REVERT=1 node test/_mode-e2e.mjs  → 撤掉"启动时同步选择器"那一行（应复现重置）
//
// 验四件事：
//   ① 选了模式之后，请求体里带的是不是这个模式（前端 → 服务端这一环）
//   ② 刷新页面后选择器还记不记得住（用户"测不出来"的头号原因）
//   ③ 切到另一条对话时，能不能恢复那条对话自己的模式
//   ④ 选择器显示的模式 == 实际发出去的模式（显示与实际不许不一致）
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const APP = path.join(ROOT, 'public', 'js', 'app.js');
const PW_CORE = process.env.PW_CORE
  || 'file:///C:/Users/Administrator/.workbuddy-ai/binaries/node/workspace/node_modules/playwright-core/index.mjs';
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 3459;
const REVERT = process.env.REVERT === '1';
const { chromium } = await import(PW_CORE);

const orig = fs.readFileSync(APP, 'utf8');
// 修复由三块拼起来，缺任何一块都还能被别的块兜住 —— 所以要还原成"修复前"，
// 必须三块一起撤掉，否则 REVERT 看起来"没复现"，会让人误以为测试没用。
const REVERT_MAP = [
  ["mode: savedMode(),", "mode: 'selfstudy',"],                        // ① 本地记忆
  ["setMode(savedMode(), { silent: true });", '/* REVERTED-BOOT */'],  // ② 启动同步 + 新建沿用
  ["if (c.mode) setMode(c.mode, { silent: true });", '/* REVERTED-CONV */'], // ③ 会话恢复
];
if (REVERT) {
  let out = orig;
  for (const [from, to] of REVERT_MAP) {
    if (!out.includes(from)) { console.error('找不到待撤的代码：' + from); process.exit(2); }
    out = out.split(from).join(to);
  }
  fs.writeFileSync(APP, out, 'utf8');
  console.log('⚠️ 已撤掉模式持久化的三处改动（REVERT=1），还原成修复前');
}

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hl-mode-'));
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
function cleanup() {
  try { srv.kill('SIGKILL'); } catch (e) {}
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch (e) {}
  if (REVERT) { try { fs.writeFileSync(APP, orig, 'utf8'); } catch (e) {} }
}

let failed = false;
try {
  if (!await waitHealth()) throw new Error('服务没起来');
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on('dialog', d => d.accept());
  const sent = [];
  page.on('request', r => {
    if (r.url().indexOf('/api/chat/stream') >= 0 && r.method() === 'POST') {
      try { sent.push(JSON.parse(r.postData() || '{}').mode); } catch (e) { sent.push(null); }
    }
  });
  await page.goto(`http://localhost:${PORT}/`);
  const reg = await page.evaluate(async (port) => {
    const r = await fetch(`http://localhost:${port}/api/auth/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'modeuser', password: 'modepass1', name: 'M', consents: ['terms', 'privacy', 'children-privacy'] }),
    });
    return await r.json();
  }, PORT);
  if (!reg.token) throw new Error('注册失败 ' + JSON.stringify(reg));
  await page.evaluate(t => localStorage.setItem('hl_token', t), reg.token);
  await page.reload();
  await page.waitForTimeout(700);

  const selVal = () => page.locator('#modeSel').inputValue();

  console.log('① 前端是否把所选模式发出去');
  console.log('   初始选择器值：' + await selVal());
  for (const m of ['feynman', 'diagnosis']) {
    await page.locator('#modeSel').selectOption(m);
    await page.locator('#input').fill('我不太懂分数，讲讲');
    await page.locator('#send').click();
    await page.waitForTimeout(2200);
    console.log(`   选「${m}」→ 实际发出 mode=${JSON.stringify(sent[sent.length - 1])}`);
  }
  const sendOk = sent[0] === 'feynman' && sent[1] === 'diagnosis';
  console.log('   → ' + (sendOk ? '✅ 前端确实把所选模式发出去了' : '❌ 发出的模式和选的不是一回事'));

  console.log('\n② 刷新页面后选择器还记不记得住');
  const beforeReload = await selVal();
  await page.reload();
  await page.waitForTimeout(1400);
  const afterReload = await selVal();
  console.log(`   刷新前=${beforeReload}  刷新后=${afterReload}`);
  const keepOnReload = afterReload === beforeReload;
  console.log('   → ' + (keepOnReload
    ? '✅ 记住了 —— 不会再悄悄回到「自学引导」'
    : '❌ 被重置了 —— 用户以为还在「' + beforeReload + '」，实际已经回到「' + afterReload + '」'));

  console.log('\n③ 切到另一条对话时能否恢复那条对话自己的模式');
  // 当前这条（diagnosis）改回 feynman，再新建一条用 diagnosis，然后来回切
  await page.locator('#modeSel').selectOption('feynman');
  await page.waitForTimeout(500);
  await page.locator('#input').fill('再讲讲小数');
  await page.locator('#send').click();
  await page.waitForTimeout(2200);
  const convA = await page.evaluate(async (port) => {
    const t = localStorage.getItem('hl_token');
    const r = await fetch(`http://localhost:${port}/api/conversations`, { headers: { Authorization: 'Bearer ' + t } });
    return (await r.json()).conversations.map(c => ({ id: c.id, mode: c.mode, title: c.title }));
  }, PORT);
  console.log('   服务端上各会话的模式：' + JSON.stringify(convA));

  // 新建对话（应沿用上次的 feynman），改成 diagnosis 发一条
  // 新建对话的入口是侧栏「未归入项目」分组头上的 ＋（.sp-add[data-p="newconv"]）
  const newBtn = page.locator('.sp-add[data-p="newconv"]').first();
  let convOk = true;
  if (await newBtn.count()) {
    await newBtn.click();
    await page.waitForTimeout(800);
    console.log('   新建对话后选择器=' + await selVal() + '（应沿用上次用的）');
    await page.locator('#modeSel').selectOption('diagnosis');
    await page.locator('#input').fill('第三条');
    await page.locator('#send').click();
    await page.waitForTimeout(2200);
    const after = await page.evaluate(async (port) => {
      const t = localStorage.getItem('hl_token');
      const r = await fetch(`http://localhost:${port}/api/conversations`, { headers: { Authorization: 'Bearer ' + t } });
      return (await r.json()).conversations.map(c => ({ id: c.id, mode: c.mode, title: c.title }));
    }, PORT);
    console.log('   现在服务端上的模式：' + JSON.stringify(after));
    const modes = after.map(c => c.mode).sort();
    convOk = modes.length >= 2 && new Set(modes).size >= 2;
    console.log('   → ' + (convOk ? '✅ 不同会话各自存住了自己的模式' : '❌ 各会话的模式没有分开存'));
  } else {
    console.log('   跳过（没找到新建对话按钮）');
  }

  await browser.close();
  failed = !(sendOk && keepOnReload && convOk);
  console.log('\n总结论：' + (failed ? '❌ 有检查未通过' : '✅ 全部通过'));
} catch (e) {
  console.error('运行出错：' + (e && e.message));
  failed = true;
} finally {
  cleanup();
}
process.exit(failed ? 1 : 0);

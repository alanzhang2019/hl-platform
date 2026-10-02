'use strict';
/**
 * 批次3 · 前端冒烟自检（真实 Chromium）
 * 验证知识卡页新增的 UI：规则说明弹窗、收卡额度、AI 收卡建议条、
 * 练习里的"自由练习"勾选、以及练完后的"今天/明天再练/复习时间待更新"。
 *
 * 跑法（NODE_PATH 指向托管工作区，里面有 playwright-core）：
 *   NODE_PATH=.../node/workspace/node_modules node _p3front.cjs
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { chromium } = require('playwright-core');

function findChrome() {
  if (process.env.CHROME && fs.existsSync(process.env.CHROME)) return process.env.CHROME;
  const root = process.env.MS_PLAYWRIGHT_DIR ||
    path.join(process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Local'), 'ms-playwright');
  let best = null, bestN = -1;
  try {
    for (const d of fs.readdirSync(root)) {
      const m = /^chromium-(\d+)$/.exec(d); if (!m) continue;
      const exe = path.join(root, d, 'chrome-win64', 'chrome.exe');
      if (!fs.existsSync(exe)) continue;
      if (Number(m[1]) > bestN) { bestN = Number(m[1]); best = exe; }
    }
  } catch (e) {}
  return best;
}

const NODE = process.execPath;
const PORT = 3950 + Math.floor(Math.random() * 40);
const BASE = 'http://127.0.0.1:' + PORT;
const DATA_DIR = path.join(os.tmpdir(), 'hl-p3front-' + crypto.randomBytes(4).toString('hex'));
const sleep = ms => new Promise(r => setTimeout(r, ms));

let pass = 0, fail = 0; const fails = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; fails.push(name + (extra ? ' → ' + JSON.stringify(extra) : '')); console.log('  ✗ ' + name + (extra ? ' → ' + JSON.stringify(extra) : '')); }
}
function group(t) { console.log('\n' + t); }

function startServer() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const child = spawn(NODE, ['server.js'], {
    cwd: __dirname,
    env: Object.assign({}, process.env, {
      PORT: String(PORT), DATA_DIR, LLM_API_KEY: '', NO_DOTENV: '1',
      TTS_PROVIDER_URL: '', WEB_SEARCH_URL: '', IMAGE_PROVIDER_URL: '', SMS_PROVIDER_URL: '',
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', d => process.stderr.write('[srv:err] ' + d));
  return child;
}
async function waitReady(ms) {
  const until = Date.now() + (ms || 60000);
  while (Date.now() < until) {
    try { const r = await fetch(BASE + '/api/health'); if (r.ok) return true; } catch (e) {}
    await sleep(150);
  }
  throw new Error('服务在超时前没有就绪');
}
function stopServer(child) {
  return new Promise(res => {
    if (!child || child.killed) return res();
    child.on('exit', () => res());
    try { child.kill(); } catch (e) { res(); }
    setTimeout(() => { try { child.kill('SIGKILL'); } catch (e) {} res(); }, 3000);
  });
}

(async () => {
  const CHROME = findChrome();
  if (!CHROME) { console.error('找不到 Chromium'); process.exit(2); }
  const child = startServer();
  let browser;
  try {
    await waitReady();
    browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, locale: 'zh-CN' });
    const page = await ctx.newPage();
    const errors = [];
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
    page.on('dialog', d => d.accept().catch(() => {}));

    group('A. 登录进主界面');
    await page.goto(BASE, { waitUntil: 'networkidle' });
    const NAME = '前端验证' + Math.floor(Math.random() * 9000 + 1000);
    await page.fill('#spName', NAME);
    await page.click('#spCreate');
    await page.waitForSelector('#app', { state: 'visible', timeout: 8000 });
    ok('已进主界面', await page.locator('#app').isVisible());

    group('B. 知识卡页新控件');
    await page.click('[data-view="cards"]');
    await page.waitForSelector('#view-cards:not([hidden])', { timeout: 5000 });
    ok('规则说明按钮可见', await page.locator('#cardRulesBtn').isVisible());
    ok('AI 收卡建议按钮可见', await page.locator('#cardSuggestBtn').isVisible());
    const quota = await page.locator('#cardQuota').innerText();
    ok('收卡额度文字出现', /收卡额度\s*\d+\/\d+/.test(quota), quota);

    group('C. 规则说明弹窗');
    await page.click('#cardRulesBtn');
    await page.waitForSelector('#modalBody .rules', { timeout: 4000 });
    const rulesCount = await page.locator('#modalBody .rules li').count();
    ok('规则弹窗列出多条规则', rulesCount >= 4, rulesCount);
    const rulesText = await page.locator('#modalBody .rules').innerText();
    ok('规则含"连续答对 5 次"', rulesText.indexOf('连续答对 5 次') >= 0, rulesText.replace(/\n/g, ' | '));
    ok('规则含"14 天"', rulesText.indexOf('14 天') >= 0);
    ok('规则含"60 天"', rulesText.indexOf('60 天') >= 0);
    // 关闭弹窗
    await page.click('#mask').catch(() => {});
    await page.evaluate(() => { const m = document.querySelector('#mask'); if (m) m.hidden = true; });

    group('D. 建卡并进入练习');
    // 通过接口建一张拼写卡（已登录 cookie 会自动带上）
    const created = await page.evaluate(async (base) => {
      const r = await fetch(base + '/api/cards', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ knowledge: 'apple 的意思', type: 'spelling', question: 'apple 怎么拼', answer: 'apple' }),
      });
      return r.status;
    }, BASE);
    ok('建拼写卡成功', created === 200, created);
    await page.click('[data-view="cards"]'); // 重载列表
    await page.waitForTimeout(400);
    await page.waitForSelector('.kcard [data-do="practice"]', { timeout: 5000 });
    await page.click('.kcard [data-do="practice"]');
    await page.waitForSelector('#pcFree', { timeout: 4000 });
    ok('练习弹窗含"自由练习"勾选', await page.locator('#pcFree').isVisible());

    group('E. 自由练习提交');
    await page.check('#pcFree');
    await page.fill('#pcInput', 'apple');
    await page.click('#pcSubmit');
    await page.waitForSelector('[data-plan="today"]', { timeout: 5000 });
    const planCount = await page.locator('.pc-acts [data-plan]').count();
    ok('练完出现 3 个复习计划按钮', planCount === 3, planCount);
    const fb = await page.locator('#pcFb').innerText();
    ok('反馈含"自由练习"', fb.indexOf('自由练习') >= 0, fb.replace(/\n/g, ' | '));

    group('F. 点"今天再练"调整计划');
    await page.click('[data-plan="today"]');
    await page.waitForTimeout(400);
    const fb2 = await page.locator('#pcFb').innerText();
    ok('点今天再练后出现调度反馈', fb2.indexOf('今天再练') >= 0, fb2.replace(/\n/g, ' | '));

    group('G. AI 收卡建议条不崩');
    await page.evaluate(() => { const m = document.querySelector('#mask'); if (m) m.hidden = true; });
    await page.click('[data-view="cards"]');
    await page.waitForTimeout(300);
    await page.click('#cardSuggestBtn'); // 无对话上下文 → 应只 toast，不应报错
    await page.waitForTimeout(600);

    group('H. 无控制台错误');
    ok('全程没有控制台/页面错误', errors.length === 0, errors.slice(0, 5));

    console.log('\n结果：' + pass + ' 通过，' + fail + ' 失败');
    if (fails.length) console.log('失败项：\n - ' + fails.join('\n - '));
  } catch (e) {
    console.error('冒烟自检异常：', e);
    fail++;
  } finally {
    if (browser) await browser.close().catch(() => {});
    await stopServer(child);
    try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch (e) {}
  }
  process.exit(fail ? 1 : 0);
})();

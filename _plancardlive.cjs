'use strict';
/**
 * 真 Key 实拍：学习计划卡到底长什么样。
 *
 * 为什么必须真 Key：竞品那张 7 列计划图的差距，**一半在渲染，一半在模型抽的数据**。
 * 灌库法只能证明"模板好看"，证明不了"模型真能从答复里抽出每天学什么"。
 * 所以这里用真模型跑一遍完整的：提问 → 回答 → 抽数据 → 渲染 → 截图。
 *
 * 跑法（默认读项目 .env 里的 Key，花一次对话 + 一次的额度）：
 *   NODE_PATH=<workspace>/node_modules node _plancardlive.cjs
 */
const net = require('net');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const { chromium } = require('playwright-core');

const NODE = process.execPath;
const ROOT = __dirname;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hl-plan-'));
const DATA = path.join(TMP, 'data');
const SHOT_DIR = process.env.SHOT_DIR || path.join(ROOT, '..', '产品截图-计划卡');
const QUESTION = process.env.QUESTION || '我想用20天把六年级数学的分数、比、百分数补一遍，帮我安排一下每天学什么，每天大概要学多久？';

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
const sleep = ms => new Promise(r => setTimeout(r, ms));
function freePort() {
  return new Promise(res => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
}
/** Chrome 无权往工作目录写文件 —— 统一先写临时目录，再 copy 回来 */
function saveShot(buf, name) {
  const f = path.join(SHOT_DIR, name);
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  fs.writeFileSync(f, buf);
  return f;
}

(async () => {
  const port = await freePort();
  const base = 'http://127.0.0.1:' + port;
  const env = Object.assign({}, process.env, { PORT: String(port), DATA_DIR: DATA });
  delete env.NO_DOTENV;                       // ★ 要真调模型，必须让 .env 生效

  const srv = spawn(NODE, [path.join(ROOT, 'server.js')], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let srvLog = '';
  srv.stdout.on('data', d => { srvLog += d; });
  srv.stderr.on('data', d => { srvLog += d; });

  const stop = () => { try { srv.kill(); } catch (e) {} };
  process.on('exit', stop);

  let browser = null;
  try {
    // 等服务起来
    let up = false;
    for (let i = 0; i < 60; i++) {
      await sleep(500);
      try { const r = await fetch(base + '/api/health'); if (r.ok) { const j = await r.json(); up = true; console.log('服务已起，mockLLM =', j.mockLLM, '| version =', j.version); if (j.mockLLM) { console.log('★ 警告：mockLLM=true，说明没读到 Key，截出来的图不是真模型产出'); } break; } } catch (e) {}
    }
    if (!up) throw new Error('服务没起来：\n' + srvLog.slice(-1500));

    const exe = findChrome();
    if (!exe) throw new Error('找不到 chromium');
    browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1.5 });
    const errs = [];
    page.on('console', m => { if (m.type() === 'error') errs.push(m.text().slice(0, 200)); });
    page.on('pageerror', e => errs.push('pageerror: ' + String(e.message).slice(0, 200)));

    await page.goto(base, { waitUntil: 'domcontentloaded' });
    // 建空间
    await page.waitForSelector('#spName', { timeout: 20000 });
    await page.fill('#spName', '计划卡实拍' + Date.now().toString().slice(-5));
    await page.click('#spCreate');
    await page.waitForFunction(() => { const a = document.getElementById('app'); return a && !a.hidden; }, null, { timeout: 30000 });
    await sleep(600);

    await page.fill('#input', QUESTION);
    await page.click('#send');
    console.log('已提问，等模型回答…');

    // 等回答
    await page.waitForSelector('.msg.ai .md', { timeout: 200000 });
    await page.waitForFunction(() => {
      const b = document.getElementById('send');
      return b && !b.disabled;
    }, null, { timeout: 200000 });
    const shotA = saveShot(await page.screenshot({ fullPage: true }), '01-回答完成-尚无计划卡.png');
    console.log('回答完成 →', shotA);

    // 等计划卡（后台任务，轮询 4s 一次）
    console.log('等计划卡生成…');
    let gotCard = false;
    for (let i = 0; i < 45; i++) {
      await sleep(4000);
      gotCard = await page.evaluate(() => !!document.querySelector('.art-plan-wrap .plan-grid'));
      if (gotCard) break;
    }

    if (!gotCard) {
      const shotB = saveShot(await page.screenshot({ fullPage: true }), '02-没等到计划卡.png');
      console.log('★ 没等到计划卡 →', shotB);
      const dbg = await page.evaluate(() => {
        const m = document.querySelector('.msg.ai');
        return { tailBoxes: document.querySelectorAll('.msg-atts[data-phase="tail"]').length, txt: (m ? m.innerText : '').slice(0, 400) };
      });
      console.log('诊断：', JSON.stringify(dbg).slice(0, 700));
    } else {
      await sleep(500);
      const shotC = saveShot(await page.screenshot({ fullPage: true }), '03-有计划卡-整页.png');
      const el = await page.$('.art-plan-wrap');
      if (el) saveShot(await el.screenshot(), '04-计划卡-单图.png');
      console.log('计划卡已出 →', shotC);

      // 量一遍内容密度：空壳卡片和真信息图的差别就在这里
      const stat = await page.evaluate(() => {
        const cols = Array.from(document.querySelectorAll('.plan-col'));
        return {
          cols: cols.length,
          withTheme: cols.filter(c => (c.querySelector('.plan-theme') || {}).textContent).length,
          withPts: cols.filter(c => c.querySelectorAll('.plan-pts li').length >= 2).length,
          pts: cols.reduce((n, c) => n + c.querySelectorAll('.plan-pts li').length, 0),
          focus: cols.filter(c => c.querySelector('.plan-focus')).length,
          tips: document.querySelectorAll('.plan-tips li').length,
          title: (document.querySelector('.art-plan .art-h b') || {}).textContent || '',
          firstCol: cols[0] ? cols[0].innerText.replace(/\n+/g, ' | ') : '',
        };
      });
      console.log('\n内容密度：', JSON.stringify(stat, null, 1));
      const full = stat.cols >= 3 && stat.withPts >= Math.ceil(stat.cols * 0.6) && stat.pts >= stat.cols * 1.5;
      console.log(full ? '✓ 是信息图（多数列有 2 条以上具体内容）' : '✗ 仍偏空壳，需要看提示词');
    }

    console.log('\n控制台报错数：' + errs.length + (errs.length ? '\n  ' + errs.slice(0, 5).join('\n  ') : ''));
    console.log('截图目录：' + SHOT_DIR);
  } catch (e) {
    console.error('失败：', e && e.message);
    if (srvLog) console.error('服务日志尾部：\n' + srvLog.slice(-1500));
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close().catch(() => {});
    stop();
  }
})();

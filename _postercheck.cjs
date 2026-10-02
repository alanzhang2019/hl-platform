'use strict';
/**
 * 计划海报验证（不花 token）：离线起服务 → 挂一张计划卡 → 点「存成图片」→
 * 既走一遍真实下载链路（Playwright download 事件），也直接把 canvas 导出成 PNG 供人工看。
 *
 * 跑法：
 *   NODE_PATH=<workspace>/node_modules node _postercheck.cjs
 */
const net = require('net');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const { chromium } = require('playwright-core');

const NODE = process.execPath;
const ROOT = __dirname;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hl-poster-'));
const DATA = path.join(TMP, 'data');
const SHOT_DIR = process.env.SHOT_DIR || path.join(ROOT, '..', '产品截图-计划海报');

let pass = 0, fail = 0;
const fails = [];
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; fails.push(name + (extra !== undefined ? ' → ' + JSON.stringify(extra) : '')); console.log('  ✗ ' + name + (extra !== undefined ? ' → ' + JSON.stringify(extra) : '')); }
}

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
function saveShot(buf, name) {
  const f = path.join(SHOT_DIR, name);
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  fs.writeFileSync(f, buf);
  return f;
}

// 一份贴近真实模型输出的计划数据（离线跑，不花额度）
const SPEC = {
  title: '20天数学冲刺计划',
  subtitle: '每天 1 小时 · 分数 / 比 / 百分数 全过一遍',
  days: [
    { label: '第1-3天', theme: '分数四则运算', focus: '异分母加减先通分，连除转乘倒数', points: ['同分母与异分母加减法', '分数乘除法与约分', '混合运算的运算顺序'] },
    { label: '第4-6天', theme: '比与比例', focus: '按比例分配要先求总份数', points: ['比的意义与化简比', '按比例分配应用题', '比例尺与图上距离'] },
    { label: '第7-9天', theme: '百分数应用', focus: '增加百分之几 = 差 ÷ 原来', points: ['百分数与分数互化', '折扣、成数、税率', '增加或减少百分之几'] },
    { label: '第10-12天', theme: '圆与扇形', focus: '先分清半径直径再套公式', points: ['圆的周长与面积', '圆环与扇形的面积', '组合图形的分割'] },
    { label: '第13-15天', theme: '圆柱与圆锥', focus: '等底等高时圆锥是圆柱的三分之一', points: ['圆柱的表面积与体积', '圆锥的体积公式', '实际容积问题'] },
    { label: '第16-20天', theme: '综合模拟自测', focus: '错题当天订正，隔天再做一遍', points: ['分模块限时训练', '整套模拟卷做两遍', '错题归因与查漏补缺'] },
  ],
  tips: ['百分数应用题是高频失分点，建议每天留 15 分钟专项', '先看例题再动手，做完必须订正，否则刷题等于白刷'],
};

(async () => {
  const port = await freePort();
  const base = 'http://127.0.0.1:' + port;
  const env = Object.assign({}, process.env, {
    PORT: String(port), DATA_DIR: DATA, NO_DOTENV: '1',
    ADMIN_PASSWORD: '', LLM_API_KEY: '', LLM_BASE_URL: '', IMAGE_AI_ART: '0',
  });

  const srv = spawn(NODE, [path.join(ROOT, 'server.js')], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let srvLog = '';
  srv.stdout.on('data', d => { srvLog += d; });
  srv.stderr.on('data', d => { srvLog += d; });
  const stop = () => { try { srv.kill(); } catch (e) {} };
  process.on('exit', stop);

  let browser = null;
  try {
    let up = false;
    for (let i = 0; i < 60; i++) {
      await sleep(400);
      try { const r = await fetch(base + '/api/health'); if (r.ok) { up = true; break; } } catch (e) {}
    }
    if (!up) throw new Error('服务没起来：\n' + srvLog.slice(-1200));

    const exe = findChrome();
    if (!exe) throw new Error('找不到 chromium');
    browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
    const ctx = await browser.newContext({ viewport: { width: 1600, height: 1100 }, deviceScaleFactor: 1.5, acceptDownloads: true });
    const page = await ctx.newPage();
    const errs = [];
    page.on('console', m => { if (m.type() === 'error') errs.push(m.text().slice(0, 200)); });
    page.on('pageerror', e => errs.push('pageerror: ' + String(e.message).slice(0, 200)));

    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#spName', { timeout: 20000 });
    await page.fill('#spName', '海报验证' + Date.now().toString().slice(-5));
    await page.click('#spCreate');
    await page.waitForFunction(() => { const a = document.getElementById('app'); return a && !a.hidden; }, null, { timeout: 30000 });
    await sleep(500);

    console.log('\n【1】渲染器接线');
    ok(await page.evaluate(() => typeof (window.HL && HL.planPoster) === 'function'), 'HL.planPoster 已挂到全局');

    // 造一张计划卡挂进对话区（走的就是真实渲染路径 HL.planCard）
    await page.evaluate((spec) => {
      const wrap = document.createElement('div');
      wrap.className = 'msg-att-illu art-plan-wrap';
      wrap.id = 'posterProbe';
      wrap.innerHTML = window.HL.planCard(spec);
      const stream = document.querySelector('#stream') || document.body;
      stream.appendChild(wrap);
    }, SPEC);
    await sleep(300);

    ok(await page.$('#posterProbe .plan-save') !== null, '计划卡上有「存成图片」按钮');
    const spans = await page.evaluate(() => document.querySelectorAll('#posterProbe .plan-col').length);
    ok(spans === 6, '计划卡渲染出 6 列', spans);

    console.log('\n【2】海报出图（直接调渲染器，量尺寸与内容）');
    const info = await page.evaluate((spec) => {
      const cv = window.HL.planPoster(spec, { date: '2026-10-02' });
      if (!cv) return null;
      const ctx = cv.getContext('2d');
      const d = ctx.getImageData(0, 0, cv.width, cv.height).data;
      // 统计非底色像素比例，判定"是不是一张真画了东西的图"而不是空白画布
      let ink = 0, n = 0;
      for (let i = 0; i < d.length; i += 4 * 97) { n++; if (d[i] !== 245 || d[i + 1] !== 247 || d[i + 2] !== 251) ink++; }
      return { w: cv.width, h: cv.height, ink: +(ink / n).toFixed(3), url: cv.toDataURL('image/png') };
    }, SPEC);
    ok(!!info, 'planPoster 返回了 canvas');
    if (info) {
      ok(info.w === 1080, '宽度固定 1080', info.w);
      ok(info.h > 1200 && info.h < 2600, '高度按条目数自适应（1200~2600）', info.h);
      ok(info.ink > 0.15, '画布上有实际绘制内容（非空白）', info.ink);
      // 只查数值字段：把 dataURL 一起丢进去匹配，base64 里凑出 "NaN" 三个字符就假红了
      ok([info.w, info.h, info.ink].every(Number.isFinite), '尺寸与墨量都是有限数（无 NaN）', [info.w, info.h, info.ink]);
      const png = Buffer.from(info.url.split(',')[1], 'base64');
      const f = saveShot(png, '01-海报-直接导出.png');
      console.log('  海报已存 →', f, (png.length / 1024).toFixed(0) + 'KB');
      ok(png.length > 20000, '导出的 PNG 体积正常（>20KB）', png.length);
    }

    console.log('\n【3】按钮下载链路（真实点击 + 浏览器下载事件）');
    const dlP = page.waitForEvent('download', { timeout: 20000 }).catch(() => null);
    await page.click('#posterProbe .plan-save');
    const dl = await dlP;
    ok(!!dl, '点击按钮触发了浏览器下载');
    if (dl) {
      const name = dl.suggestedFilename();
      ok(/\.png$/.test(name), '下载文件名是 .png', name);
      ok(/^[^\\/:*?"<>|]+$/.test(name), '文件名不含非法字符', name);
      const to = path.join(SHOT_DIR, '02-海报-按钮下载.png');
      fs.mkdirSync(SHOT_DIR, { recursive: true });
      await dl.saveAs(to);
      ok(fs.existsSync(to) && fs.statSync(to).size > 20000, '下载到本地的文件非空', fs.existsSync(to) ? fs.statSync(to).size : 0);
    }
    await sleep(400);

    console.log('\n【4】页面整屏截图（看卡片上的按钮位置）');
    const full = saveShot(await page.screenshot({ fullPage: true }), '03-计划卡带存图按钮.png');
    console.log('  →', full);

    ok(errs.length === 0, '控制台无报错', errs.slice(0, 4));
    console.log('\n' + (fail === 0 ? '全部通过' : '有失败项') + '：通过 ' + pass + ' 项，失败 ' + fail + ' 项');
    if (fail) console.log(fails.join('\n'));
    console.log('截图目录：' + SHOT_DIR);
  } catch (e) {
    console.error('失败：', e && e.message);
    if (srvLog) console.error('服务日志尾部：\n' + srvLog.slice(-1200));
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close().catch(() => {});
    stop();
  }
})();

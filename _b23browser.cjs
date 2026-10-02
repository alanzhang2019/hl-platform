'use strict';
/* 批次23 真浏览器验证：管理后台真的能操作吗？网格配图真的画出来了吗？
 *
 * 为什么必须真浏览器：这两件事都是**点击流产物** ——
 *   · 管理面板是"登进去 → 点停用 → 看状态变了"，静态断言最多证明 URL 存在
 *   · 网格是"模型输出 JSON → 前端渲染"，render.js 自测能过但样式可能在界面上溢出
 * 不花 token：服务用离线演示模式起（不配 LLM Key）， users 直接灌进 SQLite。
 */
const http = require('http');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { chromium } = require('playwright-core');

const ROOT = __dirname;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hl-b23-'));
const SHOT = process.env.HL_SHOT_DIR || path.join(os.tmpdir(), 'hl-b23-shot');
fs.mkdirSync(SHOT, { recursive: true });

// ★ 必须在 require('./server/db') **之前**设 —— db 模块加载时就按 DATA_DIR 打开库文件。
//   漏这一步的话，父进程读的是默认目录，灌进去的用户服务子进程根本看不到，
//   现象是"界面上一个用户都没有"，很容易误判成前端坏了。
process.env.DATA_DIR = DATA;
process.env.NO_DOTENV = '1';

const ADMIN_PASSWORD = 'admin-验收专用';

let pass = 0, fail = 0;
const fails = [];
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  \u2713 ' + name); }
  else { fail++; fails.push(name); console.log('  \u2717 ' + name + (extra !== undefined ? ' → ' + JSON.stringify(extra).slice(0, 300) : '')); }
}

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}
function waitUp(url, ms) {
  const end = Date.now() + (ms || 30000);
  return new Promise((resolve, reject) => {
    (function tick() {
      fetch(url).then(r => r.json()).then(j => resolve(j)).catch(() => {
        if (Date.now() > end) return reject(new Error('服务没起来'));
        setTimeout(tick, 300);
      });
    })();
  });
}
function findChrome() {
  const base = path.join(process.env.LOCALAPPDATA || '', 'ms-playwright');
  if (!fs.existsSync(base)) return '';
  const dirs = fs.readdirSync(base).filter(d => /^chromium-\d+$/.test(d)).sort().reverse();
  for (const d of dirs) {
    const p = path.join(base, d, 'chrome-win64', 'chrome.exe');
    if (fs.existsSync(p)) return p;
  }
  return '';
}

async function main() {
  const port = await freePort();
  const BASE = 'http://127.0.0.1:' + port;
  console.log('批次23 浏览器验证（管理后台 + 网格配图）');
  console.log('服务 ' + BASE + '    数据 ' + DATA);

  const up = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: DATA,
      ADMIN_PASSWORD, NO_DOTENV: '1', LLM_API_KEY: '', LLM_BASE_URL: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  up.stderr.on('data', d => process.stderr.write('[srv] ' + d));

  const health = await waitUp(BASE + '/api/health');
  ok(health.ok === true, '服务起来了', health);
  // ★ 不许写死版本号：每次升级都会红，红得毫无意义。真要验的是"health 报到的是 source 里的那个"。
  const SRC_VERSION = (fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8')
    .match(/const APP_VERSION = '([^']+)'/) || [])[1];
  ok(!!SRC_VERSION, '源码里有 APP_VERSION');
  ok(String(health.version || '') === String(SRC_VERSION),
    '★ health 报的版本 == server.js 里的 APP_VERSION', { health: health.version, src: SRC_VERSION });

  // 起一个用户（这里 require 的 db/auth 用的就是上面设好的 DATA_DIR）
  const D = require('./server/db');
  const auth = require('./server/auth');
  D.run('INSERT INTO users (id, space_id, username, phone, email, password_hash, name, role, created_at, last_login_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
    'u_ye', '_public', 'yeung', '13900002222', 'yeung@family.com', D.hashPw('oldpass123'), '小杨同学', 'student', D.now() - 6e8, D.now() - 3600000);
  ok(D.get('SELECT id FROM users WHERE id = ?', 'u_ye') !== null, '测试用户已入库');

  // ---------- ① 管理后台 ----------
  console.log('\n① 管理后台：能不能操作');
  const chrome = findChrome();
  ok(!!chrome, '找到 chromium', chrome);
  if (!chrome) { up.kill('SIGKILL'); return; }

  const browser = await chromium.launch({ executablePath: chrome, args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const errs = [];
  page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
  page.on('pageerror', e => errs.push(String(e.message)));

  // ★ 把 prompt/alert 换成可控的桩。真实对话框在 playwright 里极易卡死
  //   （一次 recover 要等满 30 秒超时，一个脚本挂三次就是一分半白等），
  //   而我们要验的是**点击之后的行为**，不是浏览器弹窗本身。
  const promptQueue = [];
  await page.addInitScript(() => {
    window.__prompts = [];
    window.prompt = (msg, dflt) => {
      const q = window.__promptQueue || [];
      const hit = q.find(x => String(msg).indexOf(x.match) >= 0);
      window.__prompts.push(String(msg));
      return hit ? hit.answer : dflt;
    };
    window.confirm = () => true;
    window.alert = () => {};
  });
  const setPrompt = async (match, answer) => {
    await page.evaluate(([m, a]) => {
      window.__promptQueue = [{ match: m, answer: a }];
      window.__prompts = [];
    }, [match, answer]);
  };

  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);

  await setPrompt('管理密码', ADMIN_PASSWORD);
  await page.click('#spAdmin', { timeout: 8000 });
  await page.waitForTimeout(2000);

  ok(await page.isVisible('#mask'), '管理后台弹出来了');
  const title = await page.textContent('#modalTitle');
  ok(/管理后台/.test(title || ''), '标题是「管理后台」', title);

  const userCard = await page.$('.adm-user');
  ok(!!userCard, '★ 出现了用户卡片（以前只有空间列表）');

  const cardText = userCard ? await userCard.textContent() : '';
  ok(/13900002222/.test(cardText), '★ 界面上能看到手机号', cardText.slice(0, 120));
  ok(/yeung@family\.com/.test(cardText), '★ 界面上能看到邮箱', cardText.slice(0, 160));
  ok(/最近登录|登录/.test(cardText), '★ 界面上有登录活跃度', cardText.slice(0, 200));
  ok(/正常/.test(cardText), '★ 状态标签显示「正常」');
  await page.screenshot({ path: path.join(SHOT, '01-管理后台-用户.png'), fullPage: false });

  // 点「停用」
  await setPrompt('停用原因', '家长申请暂停');
  await page.click('.adm-user [data-adm="disable"]', { timeout: 8000 });
  await page.waitForTimeout(2500);
  const asked = await page.evaluate(() => window.__prompts.join('|'));
  ok(/停用原因/.test(asked), '点停用会问原因（不是一声不吭就禁了）', asked);

  const afterDisable = String(await page.textContent('#admUsers'));
  ok(/已停用/.test(afterDisable), '★★ 界面上状态变成「已停用」');
  ok(/家长申请暂停/.test(afterDisable), '   └ 停用原因显示出来了');
  ok(await page.$('.adm-user [data-adm="enable"]') !== null, '★ 按钮变成「恢复使用」（可恢复）');
  await page.screenshot({ path: path.join(SHOT, '02-已停用.png'), fullPage: false });

  // 微观验证：数据库里真的改了吗 + 他还能登吗
  const rowAfter = D.get('SELECT disabled, disabled_reason FROM users WHERE id = ?', 'u_ye');
  ok(rowAfter.disabled === 1, '   └ 库里 disabled 真的写进去了');
  try { auth.login({ account: 'yeung', password: 'oldpass123' }); ok(false, '停用后还能登录'); }
  catch (e) { ok(e.code === 'USER_DISABLED', '★★ 停用后这个账号真的登不上了', e.code); }

  // 恢复
  await setPrompt('管理密码', '');
  await page.click('.adm-user [data-adm="enable"]', { timeout: 8000 });
  await page.waitForTimeout(2500);
  ok(/正常/.test(String(await page.textContent('#admUsers'))), '★★ 点「恢复使用」后状态回到正常');
  ok(auth.login({ account: 'yeung', password: 'oldpass123' }).userId === 'u_ye', '   └ 恢复后真的能重新登录');

  // 重置密码
  await setPrompt('新密码', 'brandnew99');
  await page.click('.adm-user [data-adm="reset"]', { timeout: 8000 });
  await page.waitForTimeout(2500);
  ok(auth.login({ account: 'yeung', password: 'brandnew99' }).userId === 'u_ye', '★★ 重置后新密码能登录');
  try { auth.login({ account: 'yeung', password: 'oldpass123' }); ok(false, '重置后旧密码还能用'); }
  catch (e) { ok(true, '★★ 旧密码已失效'); }

  // 切到空间页，旧的「空间管理」还在
  await page.click('[data-admtab="spaces"]', { timeout: 8000 });
  await page.waitForTimeout(600);
  ok(await page.isVisible('#admSpaces'), '★ 切到「空间」页还在（没把原来的功能挤掉）');
  ok(!(await page.isVisible('#admUsers')), '   └ 用户页同时收起');

  ok(errs.length === 0, '★ 零控制台报错', errs.slice(0, 3));

  // ---------- ② 网格配图 ----------
  console.log('\n② 网格配图：画出来能不能看懂');
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(900);
  // 直接把渲染结果注入会话区，验样式不溢出
  const gridHtml = await page.evaluate(() => {
    const json = {
      kind: 'grid', title: '方格取数：从 A 走到 B',
      cells: [['3', '7', '5', '2'], ['1', '4', '9', '6'], ['8', '2', '1', '5'], ['4', '6', '3', '7']],
      marks: [{ r: 0, c: 0, label: 'A' }, { r: 3, c: 3, label: 'B' }],
    };
    return window.HL.render('```svg-json\n' + JSON.stringify(json) + '\n```');
  });
  ok(/<svg/.test(gridHtml), '网格渲染出 SVG');
  ok(!/NaN/.test(gridHtml), '★ 没有 NaN');
  ['3', '7', '5', '2', '1', '4', '9', '6', '8'].forEach(n => {
    ok(gridHtml.indexOf('>' + n + '<') >= 0, '   └ 数字 ' + n + ' 在格子里');
  });

  await page.evaluate((h) => {
    const box = document.createElement('div');
    box.id = 'gprobe';
    box.className = 'stream-in';
    box.innerHTML = h;
    document.body.appendChild(box);
  }, gridHtml);
  await page.waitForTimeout(300);
  const box = await page.$('#gprobe');
  const bb = await box.boundingBox();
  const vw = await page.evaluate(() => window.innerWidth);
  ok(bb && bb.width <= vw, '★ 网格没有横向溢出视口', bb && Math.round(bb.width) + ' vs ' + vw);
  const svgBox = await page.$('#gprobe svg');
  ok(!!svgBox, 'SVG 真的挂在文档里');
  await page.screenshot({ path: path.join(SHOT, '03-网格配图.png'), fullPage: false });

  // 深色模式下也能看
  await page.evaluate(() => { document.documentElement.setAttribute('data-theme', 'dark'); });
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(SHOT, '04-网格-深色.png'), fullPage: false });
  ok(true, '深色模式截图已出');

  await browser.close();
  up.kill('SIGKILL');

  console.log('\n截图目录：' + SHOT);
  console.log('─'.repeat(56));
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  if (fail) { fails.forEach(f => console.log('  \u2717 ' + f)); process.exitCode = 1; }
}

main().catch(e => { console.error('崩了：', e); process.exitCode = 1; });

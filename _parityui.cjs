'use strict';
/**
 * 批次1 · 浏览器冒烟：登录页账号体系、协议弹窗、公告、个人资料。
 *
 * 为什么必须有这一套：Node 层测试证明不了"页面真的能跑" ——
 * 元素 id 拼错、事件没绑上、模板串漏个引号，Node 全绿但页面是坏的。
 *
 * 跑法：
 *   NODE_PATH=.../node/workspace/node_modules node _parityui.cjs
 */
const path = require('path');
const fsx = require('fs');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { chromium } = require('playwright-core');

const NODE = process.execPath;
/**
 * ★ 端口要**真的空**，不能随机猜。
 *   原来是 `3800 + random(200)`：撞上任何占用就直接 EADDRINUSE，
 *   服务永远起不来，20 秒后抛"服务在超时前没有就绪" —— 而这条信息
 *   会被运行器的 `·`/`✗` 过滤掉，只剩一行"通过 0 项"，看着像断言全错。
 *   改成让内核分配一个空闲端口（bind 到 0 再读回来），从根上消掉这个偶发。
 */
const net = require('net');
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}
let PORT = 0;
let BASE = '';
const DATA_DIR = path.join(os.tmpdir(), 'hl-p1ui-' + crypto.randomBytes(4).toString('hex'));
const SHOTS = path.join(__dirname, '_shots');

function findChrome() {
  if (process.env.CHROME && fsx.existsSync(process.env.CHROME)) return process.env.CHROME;
  const root = process.env.MS_PLAYWRIGHT_DIR ||
    path.join(process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Local'), 'ms-playwright');
  let best = null, bestN = -1;
  try {
    for (const d of fsx.readdirSync(root)) {
      const m = /^chromium-(\d+)$/.exec(d);
      if (!m) continue;
      const exe = path.join(root, d, 'chrome-win64', 'chrome.exe');
      if (!fsx.existsSync(exe)) continue;
      if (Number(m[1]) > bestN) { bestN = Number(m[1]); best = exe; }
    }
  } catch (e) {}
  return best;
}
const CHROME = findChrome();

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  \u2713 ' + name); }
  else { fail++; failures.push(name + (extra ? ' → ' + (typeof extra === 'string' ? extra : JSON.stringify(extra)) : '')); console.log('  \u2717 ' + name + (extra ? ' → ' + (typeof extra === 'string' ? extra : JSON.stringify(extra)) : '')); }
}
function group(t) { console.log('\n' + t); }

function startServer() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const child = spawn(NODE, ['server.js'], {
    cwd: __dirname,
    env: Object.assign({}, process.env, {
      PORT: String(PORT), DATA_DIR, ADMIN_PASSWORD: 'test-admin-pw',
      LLM_API_KEY: '', NO_DOTENV: '1', SMS_PROVIDER_URL: '',
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', d => process.env.VERBOSE && process.stdout.write('[srv] ' + d));
  child.stderr.on('data', d => process.stderr.write('[srv:err] ' + d));
  return child;
}
async function waitReady(ms) {
  // 60 秒而不是 20 秒：这台机器磁盘接近写满，新建一个 SQLite 库 + 首次落盘可能要十几秒。
  // 超时太短会把"机器慢"报成"代码坏了"，而且子进程只吐一句 ERR_CONNECTION_REFUSED。
  const until = Date.now() + (ms || 60000);
  while (Date.now() < until) {
    try { const r = await fetch(BASE + '/api/health'); if (r.ok) return; } catch (e) {}
    await new Promise(r => setTimeout(r, 150));
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
  fs.mkdirSync(SHOTS, { recursive: true });
  if (!CHROME) { console.error('找不到 Chromium'); process.exit(2); }
  PORT = await freePort();          // ★ 先要一个内核确认空闲的端口，再起服务
  BASE = 'http://127.0.0.1:' + PORT;
  const child = startServer();
  let browser = null;
  try {
    await waitReady();
    browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'zh-CN' });
    const page = await ctx.newPage();

    const errors = [];
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
    // 把非 2xx 响应打出来 —— 控制台只说"有个 400"，不说是哪个请求，定位全靠猜
    page.on('response', r => {
      if (r.status() >= 400 && process.env.VERBOSE) {
        console.log('  [http ' + r.status() + '] ' + r.request().method() + ' ' + r.url().replace(BASE, ''));
      }
    });

    await page.goto(BASE + '/', { waitUntil: 'networkidle' });
    await page.waitForSelector('#land', { state: 'visible' });

    group('A. 登录页三个入口');
    const tabs = await page.locator('.land-tab').allInnerTexts();
    ok('三个 tab：创建 / 进入 / 账号', tabs.length === 3, JSON.stringify(tabs));
    ok('第三个是账号登录', (tabs[2] || '').indexOf('账号') >= 0, tabs[2]);
    ok('默认显示创建面板', await page.locator('#paneCreate').isVisible());
    ok('账号面板默认隐藏', !(await page.locator('#paneAccount').isVisible()));

    await page.click('.land-tab[data-tab="account"]');
    await page.waitForSelector('#paneAccount', { state: 'visible' });
    ok('切到账号面板', await page.locator('#paneAccount').isVisible());
    ok('默认是密码登录', await page.locator('#acctLogin').isVisible());
    ok('验证码面板隐藏', !(await page.locator('#acctSms').isVisible()));

    group('B. 协议弹窗');
    await page.click('#acctToSms');
    await page.waitForSelector('#acctSms', { state: 'visible' });
    ok('切到验证码登录', await page.locator('#acctSms').isVisible());

    await page.click('#acctSms a[data-doc="terms"]');
    await page.waitForSelector('#mask:not([hidden])');
    const modalTxt = await page.locator('#modalBody').innerText();
    ok('协议弹窗打开', modalTxt.length > 100, modalTxt.slice(0, 40));
    ok('弹窗标题是用户协议', (await page.locator('#modalTitle').innerText()).indexOf('用户协议') >= 0);
    ok('协议有分节', (await page.locator('#modalBody .doc-body h4').count()) >= 4, await page.locator('#modalBody .doc-body h4').count());
    await page.click('#modalClose');
    await page.waitForSelector('#mask', { state: 'hidden' });

    await page.click('#acctSms a[data-doc="children-privacy"]');
    await page.waitForSelector('#mask:not([hidden])');
    ok('儿童隐私单独一篇', (await page.locator('#modalTitle').innerText()).indexOf('儿童') >= 0);
    await page.click('#modalClose');
    await page.waitForSelector('#mask', { state: 'hidden' });

    group('C. 验证码登录（含首登补资料）');
    ok('新用户字段默认收起', !(await page.locator('#smsNewUser').isVisible()));
    await page.fill('#smsPhone', '13700001234');
    await page.click('#smsSend');
    await page.waitForFunction(() => /^\d{6}$/.test(document.querySelector('#smsCode').value), null, { timeout: 10000 });
    const code = await page.inputValue('#smsCode');
    ok('开发模式下验证码自动回填', /^\d{6}$/.test(code), code);
    ok('发送后按钮进入倒计时', (await page.locator('#smsSend').innerText()).indexOf('秒') >= 0, await page.locator('#smsSend').innerText());

    await page.click('#smsLoginBtn');
    // ★ 不要用固定 sleep 等一次服务端往返。
    //   这条"未勾协议被拦下"是服务端 400（下面的控制台噪音过滤里也提到它），
    //   本机一次往返可能远超 500ms ⇒ 假红。
    //   而且"错误文案"和"新用户字段露出来"是**同一个响应**的两个结果，
    //   分两次 await 读会错位 ⇒ 在**同一次求值里一起读**。
    const landed = await page.waitForFunction(() => {
      const err = document.querySelector('#landErr');
      const nu = document.querySelector('#smsNewUser');
      const e = err ? err.textContent.trim() : '';
      if (!e.length) return null;
      if (!nu || nu.offsetParent === null) return null;
      return { err: e };
    }, null, { timeout: 30000 }).then(h => h.jsonValue()).catch(() => null);
    ok('未勾协议被拦下', !!landed, landed ? landed.err : '30 秒内没等到错误文案');
    ok('拦下后露出新用户字段', await page.locator('#smsNewUser').isVisible());
    ok('提示文案点名"首次登录"', (await page.locator('#landErr').innerText()).indexOf('首次') >= 0, await page.locator('#landErr').innerText());

    await page.fill('#smsName', '小海');
    await page.selectOption('#smsStage', '小学');
    await page.selectOption('#smsGrade', '5年级');
    await page.check('#smsAgree');
    await page.click('#smsLoginBtn');
    await page.waitForSelector('#app', { state: 'visible', timeout: 15000 });
    ok('登录后进入主界面', await page.locator('#app').isVisible());
    ok('空间名 = 填的名字', (await page.locator('#spaceName').innerText()).indexOf('小海') >= 0, await page.locator('#spaceName').innerText());

    group('D. 公告');
    ok('侧栏有公告入口', await page.locator('#annBtn').isVisible());
    await page.click('#annBtn');
    await page.waitForSelector('#mask:not([hidden])');
    ok('公告弹窗打开', (await page.locator('#modalTitle').innerText()).indexOf('公告') >= 0);
    ok('无公告时有空状态', (await page.locator('#modalBody').innerText()).indexOf('没有公告') >= 0, await page.locator('#modalBody').innerText());
    await page.click('#modalClose');
    await page.waitForSelector('#mask', { state: 'hidden' });

    group('E. 个人资料');
    // 批次6 起「设置」不再是一根顶级导航，改从右上角头像菜单进 —— 这里跟着改，
    // 否则会一直等一个已经不存在的 .nav-i[data-view="settings"]。
    await page.locator('.me-chip:visible').first().click();
    await page.waitForSelector('#mask:not([hidden])');
    const menuTxt = await page.locator('#modalBody').innerText().catch(() => '(读不到)');
    await page.click('#modalBody [data-me="settings"]');
    try {
      await page.waitForSelector('#view-settings:not([hidden])', { timeout: 20000 });
    } catch (e) {
      // 这一步在本机偶发失败（单独跑全绿、进运行器后约一半概率红），
      // 而且症状是"#view-settings 一直是 hidden"，看不出点击到底有没有生效。
      // 与其猜，不如把现场留下来：截图 + 菜单内容 + 各视图的 hidden 状态。
      await page.screenshot({ path: path.join(SHOTS, 'parity1-FAIL-settings.png') }).catch(() => {});
      console.log('  [诊断] 点之前菜单内容 = ' + JSON.stringify(menuTxt.slice(0, 200)));
      console.log('  [诊断] 视图状态 = ' + JSON.stringify(await page.evaluate(() => {
        const h = id => { const el = document.querySelector(id); return el ? el.hidden : 'missing'; };
        return {
          mask: h('#mask'), viewKb: h('#view-kb'), viewChat: h('#view-chat'),
          viewSettings: h('#view-settings'), profBox: h('#profBox'),
          activeKbTab: document.querySelector('#kbTabs .kb-tab.on')
            ? document.querySelector('#kbTabs .kb-tab.on').dataset.sub : null,
          modalBodyLen: document.querySelector('#modalBody')
            ? document.querySelector('#modalBody').innerHTML.length : -1,
        };
      })));
      throw e;
    }
    // ★ `#view-settings` 可见 ≠ 设置页填好了。
    //   #profBox 里的头像卡 / 学科 chip 是拿到 /api/me 之后才渲染的。
    //   不等它，后面第一次 click（换头像）会一直等到 30 秒超时，
    //   整条套件就以"通过 0 项"崩掉 —— 而真正的线索被运行器的过滤器吃掉，
    //   看着像断言全错。等真正要点的那个元素出现再往下走。
    await page.waitForSelector('#profBox .av-cell', { timeout: 30000 }).catch(() => {});
    ok('设置页可见', await page.locator('#view-settings').isVisible());
    ok('设置里有空间 ID', (await page.locator('#view-settings').innerText()).indexOf('空间 ID') >= 0);
    ok('主题切换还在', await page.locator('#themeSeg button[data-theme="dark"]').count() === 1);
    ok('字号切换还在', await page.locator('#fontSeg button[data-font="lg"]').count() === 1);

    ok('头像卡出现（账号登录才有）', await page.locator('#profBox .prof-av').isVisible());
    const avCells = await page.locator('#profBox .av-cell').count();
    ok('9 款头像可选', avCells === 9, avCells);
    ok('头像里有真实 SVG', (await page.locator('#profBox .prof-av svg').count()) === 1);
    const subjChips = await page.locator('#profBox [data-subj]').count();
    ok('6 个学科 chip', subjChips === 6, subjChips);
    ok('目标为空时有引导', (await page.locator('#profGoals').innerText()).indexOf('还没有写目标') >= 0);

    // 换头像（等它真的变高亮，而不是等 600ms）
    await page.click('#profBox .av-cell[data-av="beacon"]');
    await page.waitForFunction(() => {
      const el = document.querySelector('#profBox .av-cell[data-av="beacon"]');
      return !!(el && el.classList.contains('on'));
    }, null, { timeout: 30000 }).catch(() => {});
    ok('选中头像高亮', await page.locator('#profBox .av-cell[data-av="beacon"]').evaluate(el => el.classList.contains('on')));

    // 选学科（同上）
    await page.click('#profBox [data-subj="math"]');
    await page.waitForFunction(() => {
      const el = document.querySelector('#profBox [data-subj="math"]');
      return !!(el && el.classList.contains('on'));
    }, null, { timeout: 30000 }).catch(() => {});
    ok('学科选中高亮', await page.locator('#profBox [data-subj="math"]').evaluate(el => el.classList.contains('on')));

    // 加目标。★ 例句不能用空状态占位里的那句（"这学期把分数提上来"），
    //   否则删掉之后占位文案又把它显示出来，断言会误判成"没删掉"。
    //   等目标真的渲染出来再断言 —— 固定 700ms 等 POST 往返在本机会假红
    //   （实测就是这样红的：文案还停在"还没有写目标"的空状态上）。
    await page.fill('#goalInput', '期末数学上 90 分');
    await page.click('#goalAdd');
    await page.waitForFunction(() => {
      const b = document.querySelector('#profGoals');
      return !!(b && b.textContent.indexOf('期末数学上 90 分') >= 0);
    }, null, { timeout: 30000 }).catch(() => {});
    const goalsTxt = await page.locator('#profGoals').innerText();
    ok('目标已添加', goalsTxt.indexOf('期末数学上 90 分') >= 0, goalsTxt);

    // 删目标：等"目标消失 **且** 空状态引导回来"这一个状态，而不是等 700ms。
    await page.click('#profGoals [data-goal-del="0"]');
    await page.waitForFunction(() => {
      const b = document.querySelector('#profGoals');
      if (!b) return null;
      const t = b.textContent;
      return (t.indexOf('期末数学上 90 分') < 0 && t.indexOf('还没有写目标') >= 0) ? t : null;
    }, null, { timeout: 30000 }).catch(() => {});
    const after = await page.locator('#profGoals').innerText();
    ok('目标已删除', after.indexOf('期末数学上 90 分') < 0, after);
    ok('删除后回到空状态引导', after.indexOf('还没有写目标') >= 0, after);

    // 改密码（该账号首次设置，无需原密码）
    // ★ 判据用"toast 内容**变了**"，不是"toast 非空" —— 前面几步可能已经留过一条 toast，
    //   只判非空的话这次什么都不做也会绿。
    const toastBefore = await page.locator('#toast').innerText().catch(() => '');
    await page.fill('#pwNew', 'brandnew123');
    await page.click('#pwSave');
    await page.waitForFunction(prev => {
      const t = document.querySelector('#toast');
      const now = t ? t.textContent.trim() : '';
      return (now.length > 0 && now !== prev) ? now : null;
    }, toastBefore, { timeout: 30000 }).catch(() => {});
    ok('设置密码有反馈', (await page.locator('#toast').innerText()).length > 0, await page.locator('#toast').innerText());

    await page.screenshot({ path: path.join(SHOTS, 'parity1-settings.png'), fullPage: true });

    group('F. 刷新后仍在登录态');
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForSelector('#app', { state: 'visible', timeout: 15000 });
    // 同样走头像菜单（批次6 起设置不在顶级导航上）
    await page.locator('.me-chip:visible').first().click();
    await page.waitForSelector('#mask:not([hidden])');
    await page.click('#modalBody [data-me="settings"]');
    await page.waitForSelector('#view-settings:not([hidden])');
    // 同上：刷新之后 #profBox 也要重新取一次 /api/me 才填得上。
    await page.waitForSelector('#profBox .av-cell', { timeout: 30000 }).catch(() => {});
    ok('刷新后头像仍是 beacon', await page.locator('#profBox .av-cell[data-av="beacon"]').evaluate(el => el.classList.contains('on')));
    ok('刷新后学科仍是 math', await page.locator('#profBox [data-subj="math"]').evaluate(el => el.classList.contains('on')));

    group('G. 控制台无报错');
    // 噪音过滤：
    //   favicon / 404 静态资源
    //   login/sms 的 400 —— 那是本套测试**故意**打的反证用例（未同意协议），
    //   浏览器把每个 4xx 都当 console error，不能算前端 bug
    const real = errors.filter(e =>
      e.indexOf('favicon') < 0 &&
      e.indexOf('404') < 0 &&
      !(e.indexOf('400') >= 0 && e.indexOf('Failed to load resource') >= 0));
    ok('无未捕获异常', real.length === 0, real.slice(0, 3).join(' | '));

  } finally {
    // ★ 收尾必须**有上限**。
    //   实测：所有断言都跑完了（最后一条 `✓ 无未捕获异常` 已经打出来），
    //   但进程挂在 `browser.close()` 上不退出 —— 运行器一直等 `child.on('exit')`，
    //   于是整条套件看起来像"卡死/崩溃"，汇总行永远打不出来，
    //   而运行器只报一句"通过 0 项"，把"断言全过"误报成"全错"。
    //
    //   收尾是清理，不是被测对象。给它一个硬上限，到点就往下走 ——
    //   后面紧接着就 `process.exit()`，挂着的 close() 不会阻止进程退出。
    await Promise.race([
      (async () => {
        if (browser) await browser.close().catch(() => {});
        await stopServer(child);
      })(),
      new Promise(r => setTimeout(r, 15000)),
    ]);
    try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch (e) {}
  }

  console.log('\n' + (fail === 0 ? 'PASS' : 'FAIL') + '  通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  if (failures.length) { console.log('\n失败项：'); failures.forEach(f => console.log('  - ' + f)); }
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => {
  console.error('未捕获错误：', e);
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch (_) {}
  process.exit(1);
});

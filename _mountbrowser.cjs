'use strict';
/**
 * 浏览器端验证：项目 ↔ 知识库 的「资料挂载」两条入口真的能用。
 *
 * 为什么必须真浏览器跑：这两处全是 DOM 交互（弹窗、勾选、切分区、重渲染），
 * 静态断言只能证明"代码里写了"，证明不了"点下去真的生效"。
 *
 * 覆盖的点击流：
 *   ① 项目弹窗里勾资料 → 保存 → 项目卡片显示「资料 2 份」
 *   ② 重新打开编辑 → 那两个勾是回显的（不是每次都从零开始）
 *   ③ 知识库文档行「加入项目」→ 勾另一个项目 → 保存 → 行内出现「已挂到 …」
 *   ④ 回项目页 → 另一个项目的卡片跟着变成「资料 1 份」（两个入口写的是同一份数据）
 *   ⑤ 全程控制台零报错
 *
 * 自起服务、自找空闲端口、离线演示模式（不配 Key，不花 token）。
 * 跑法：NODE_PATH=<workspace>/node_modules node _mountbrowser.cjs
 */
const net = require('net');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const { chromium } = require('playwright-core');

const NODE = process.execPath;
const ROOT = __dirname;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hl-mount-'));
const DATA = path.join(TMP, 'data');

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

let pass = 0, fail = 0;
const failures = [];
// 签名是 (cond, name)：批次12 的静态套件同款。
// ★ 注意别写成 (name, cond) —— 那样每次调用都把 cond 当名字打印，
//   而名字（非空字符串）恒为真，于是**所有断言全绿**，看着通过其实一条没测。
//   第一版就写反了，输出里一排"✓ true"才发现。
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  \u2713 ' + name); }
  else { fail++; failures.push(name + (extra ? ' → ' + (typeof extra === 'string' ? extra : JSON.stringify(extra)) : '')); console.log('  \u2717 ' + name + (extra ? ' → ' + (typeof extra === 'string' ? extra : JSON.stringify(extra)) : '')); }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

function freePort() {
  return new Promise(res => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}

(async () => {
  const PORT = await freePort();
  const BASE = 'http://127.0.0.1:' + PORT;

  const srv = spawn(NODE, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      PORT: String(PORT), DATA_DIR: DATA, NO_DOTENV: '1',
      LLM_API_KEY: '', ADMIN_PASSWORD: '', IMAGE_AI_ART: '0',
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  srv.stderr.on('data', d => process.stderr.write('[srv] ' + d));

  let up = false;
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(BASE + '/api/health'); if (r.ok) { up = true; break; } } catch (e) {}
    await sleep(400);
  }
  if (!up) { srv.kill(); console.error('服务没起来'); process.exit(2); }

  // ---------- 造数据：一个空间 + 两份可检索的资料 ----------
  const post = async (p, body, token) => {
    const url = BASE + p + (token ? (p.indexOf('?') >= 0 ? '&' : '?') + '_t=' + encodeURIComponent(token) : '');
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };

  const sp = await post('/api/space', { name: '挂载验证', passcode: '' });
  const spaceId = sp.body.spaceId;
  const token = sp.body.token;
  ok(!!spaceId && !!token, '建空间成功', sp.body);

  const u1 = await post('/api/kb/documents', { filename: '力学卷.txt', text: '力的合成遵循平行四边形定则，合力用作图法求。' }, token);
  const u2 = await post('/api/kb/documents', { filename: '单词表.txt', text: 'apple 苹果 banana 香蕉，背单词要按遗忘曲线回看。' }, token);
  ok(u1.status === 200 && u2.status === 200, '两份资料上传并解析就绪', [u1.status, u2.status]);

  const chromePath = findChrome();
  if (!chromePath) { srv.kill(); console.error('找不到 Chromium'); process.exit(2); }
  const browser = await chromium.launch({ executablePath: chromePath, args: ['--no-sandbox', '--disable-gpu'] });
  const errs = [];
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
  page.on('pageerror', e => errs.push('pageerror: ' + e.message));

  const maskClosed = () => page.waitForFunction(() => document.getElementById('mask').hidden === true, null, { timeout: 8000 });
  const openSub = async (key) => {
    await page.click('.nav-i[data-view="kb"]');
    await page.waitForSelector('#view-kb:not([hidden])');
    await page.click('#kbTabs [data-sub="' + key + '"]');
    await page.waitForTimeout(200);
  };

  console.log('\n浏览器点击流');
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.land-tab[data-tab="enter"]', { timeout: 20000 });
  await page.click('.land-tab[data-tab="enter"]');
  await page.fill('#spId', spaceId);
  await page.click('#spEnter');
  await page.waitForSelector('#app:not([hidden])', { timeout: 20000 });
  ok(true, '登录进主界面');

  // ---------- ① 项目弹窗里勾资料 ----------
  await openSub('projects');
  await page.waitForSelector('#newProjPane');
  await page.click('#newProjPane');
  await page.waitForSelector('#pjDocs .ag-i', { timeout: 8000 });
  ok(true, '项目弹窗里出现了「资料」区，而且列出了知识库的资料');

  await page.fill('#pjName', '这学期物理');
  await page.locator('#pjDocs .ag-i', { hasText: '力学卷' }).click();
  await page.locator('#pjDocs .ag-i', { hasText: '单词表' }).click();
  const pickedN = (await page.textContent('#pjDocN') || '').trim();
  ok(pickedN === '2', '勾两份 → 计数变成 2', pickedN);
  await page.screenshot({ path: path.join(TMP, '01-项目弹窗勾资料.png') });

  await page.click('#pjSave');
  await maskClosed();
  await page.waitForTimeout(700);
  const cards1 = await page.textContent('#projList');
  ok(cards1.indexOf('资料 2 份') >= 0, '项目卡片上写着「资料 2 份」（不是永远 0 了）', cards1.replace(/\s+/g, ' ').slice(0, 120));
  await page.screenshot({ path: path.join(TMP, '02-项目卡片显示资料数.png') });

  // ---------- ② 编辑态回显 ----------
  await page.locator('#projList .row-card', { hasText: '这学期物理' }).locator('[data-p="edit"]').click();
  await page.waitForSelector('#pjDocs .ag-i', { timeout: 8000 });
  const onN = await page.locator('#pjDocs .ag-i.on').count();
  ok(onN === 2, '重新打开编辑 → 上次勾的两份是回显的（不是每次都从零开始）', onN);
  await page.click('#modalClose');
  await maskClosed();
  await page.waitForTimeout(300);

  // ---------- ③ 文档行「加入项目」 ----------
  await openSub('projects');
  await page.click('#newProjPane');
  await page.waitForSelector('#pjName', { timeout: 8000 });
  await page.fill('#pjName', '英语单词');
  await page.click('#pjSave');
  await maskClosed();
  await page.waitForTimeout(700);

  await openSub('docs');
  await page.waitForSelector('#kbList .doc-i', { timeout: 8000 });
  const wordRow = page.locator('#kbList .doc-i', { hasText: '单词表' });
  ok(await wordRow.locator('[data-doc="proj"]').count() === 1, '文档行上有「加入项目」按钮');
  await wordRow.locator('[data-doc="proj"]').click();
  await page.waitForSelector('#dpList .ag-i', { timeout: 8000 });
  await page.waitForTimeout(400);                                    // 等遮罩淡入结束，截图才不是半透明的
  await page.screenshot({ path: path.join(TMP, '03-文档挂到项目.png') });

  await page.locator('#dpList .ag-i', { hasText: '英语单词' }).click();
  await page.click('#dpSave');
  await maskClosed();
  await page.waitForTimeout(800);

  const wordRowText = await page.locator('#kbList .doc-i', { hasText: '单词表' }).textContent();
  ok(wordRowText.indexOf('已挂到') >= 0 && wordRowText.indexOf('英语单词') >= 0,
    '文档行上出现了「已挂到 英语单词」', wordRowText.replace(/\s+/g, ' ').slice(0, 120));
  await page.screenshot({ path: path.join(TMP, '05-文档行已挂到.png') });

  // ---------- ④ 另一边跟着变 ----------
  await openSub('projects');
  await page.waitForTimeout(600);
  const cards2 = await page.textContent('#projList');
  ok(cards2.indexOf('资料 1 份') >= 0,
    '两个入口写的是同一份数据：另一个项目也变成「资料 1 份」', cards2.replace(/\s+/g, ' ').slice(0, 160));
  await page.screenshot({ path: path.join(TMP, '04-两个项目各自的资料数.png') });

  // ---------- ⑤ 控制台 ----------
  ok(errs.length === 0, '全程控制台零报错', errs.slice(0, 3).join(' | '));

  await browser.close();
  srv.kill();

  console.log('\n批次12（浏览器挂载链路）：');
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  if (fail) { console.log('\n失败清单：'); failures.forEach(f => console.log('  ✗ ' + f)); }
  console.log('SHOTS=' + TMP);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FAIL', e); process.exit(1); });

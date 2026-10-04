'use strict';
/**
 * 批次31 视觉验证：＋ 菜单、输入区模型选择器、图表模式。
 * 自带一个本地服务（起在随机高位端口），跑完自动收掉。
 *
 * 跑法：
 *   PW_CORE=<playwright-core 路径> CHROME=<chrome.exe> node _uicheck.cjs
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

const CHROME = process.env.CHROME || (() => {
  const root = path.join(process.env.LOCALAPPDATA || '', 'ms-playwright');
  let best = null, n = -1;
  try {
    for (const d of fs.readdirSync(root)) {
      const m = /^chromium-(\d+)$/.exec(d);
      if (!m) continue;
      const exe = path.join(root, d, 'chrome-win64', 'chrome.exe');
      if (fs.existsSync(exe) && Number(m[1]) > n) { n = Number(m[1]); best = exe; }
    }
  } catch (e) {}
  return best;
})();

const PORT = Number(process.env.PORT || 3199);
const BASE = 'http://127.0.0.1:' + PORT;
const OUT = path.join(__dirname, '_shots-ui31');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hlui-'));

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  \u2713 ' + name); }
  else { fail++; failures.push(name); console.log('  \u2717 ' + name + (extra ? ' → ' + JSON.stringify(extra) : '')); }
}

function startServer() {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['server.js'], {
      cwd: __dirname,
      env: Object.assign({}, process.env, {
        PORT: String(PORT), DATA_DIR: DATA, DB_FILE: path.join(DATA, 'app.db'),
        ADMIN_PASSWORD: 'test-admin', LLM_API_KEY: 'mock',
      }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let done = false;
    const t = setTimeout(() => { if (!done) { done = true; reject(new Error('服务 20s 没起来')); } }, 20000);
    p.stdout.on('data', d => {
      if (!done && /listen|启动|http:\/\//i.test(String(d))) { done = true; clearTimeout(t); setTimeout(() => resolve(p), 600); }
    });
    p.stderr.on('data', d => process.env.VERBOSE && console.error('[srv]', String(d).trim()));
    p.on('exit', c => { if (!done) { done = true; clearTimeout(t); reject(new Error('服务退出 code=' + c)); } });
  });
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const srv = await startServer();
  const { chromium } = require(process.env.PW_CORE || 'playwright-core');
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 940 }, deviceScaleFactor: 2 });
  const errs = [];
  page.on('console', m => { if (m.type() === 'error' && !/404/.test(m.text())) errs.push(m.text()); });
  page.on('pageerror', e => errs.push('pageerror: ' + e.message));

  // 进门：建一个学习空间
  await page.goto(BASE + '/', { waitUntil: 'networkidle' });
  await page.fill('#spName', '批次31');
  await page.click('#spCreate');
  await page.waitForSelector('#view-chat:not([hidden])', { timeout: 20000 });
  await page.waitForTimeout(1000);

  // ---- 1. 输入区结构 ----
  console.log('\n[1] 输入区工具栏结构');
  const tools = await page.evaluate(() => {
    const q = s => document.querySelector(s);
    return {
      hasPlus: !!q('#plusBtn'),
      hasMenu: !!q('#plusMenu'),
      menuHidden: q('#plusMenu') ? q('#plusMenu').hidden : null,
      selInTools: !!(q('.composer-tools') && q('.composer-tools #modelSel')),
      vizInTools: !!(q('.composer-tools') && q('.composer-tools #vizChk')),
      topbarSel: !!q('.tb-tools #modelSel'),
      topbarViz: !!q('.tb-tools #vizChk'),
      topbarAgent: !!q('#agentBtn'),
      oldDt: !!q('#dtBtn'),
      oldAttach: !!q('#attachBtn'),
      menuItems: Array.from(document.querySelectorAll('#plusMenu .pm-i')).map(b => b.querySelector('.pm-tx').textContent.trim()),
    };
  });
  ok('＋ 按钮存在', tools.hasPlus);
  ok('＋ 菜单存在且初始隐藏', tools.hasMenu && tools.menuHidden === true);
  ok('★ 模型选择器在输入区工具栏', tools.selInTools);
  ok('★ 图表模式在输入区工具栏', tools.vizInTools);
  ok('  顶栏已无模型/图表/智能体（不重复）', !tools.topbarSel && !tools.topbarViz && !tools.topbarAgent);
  ok('  旧的深度思考按钮已移除', !tools.oldDt);
  ok('  旧的 ＋直连附件按钮已移除', !tools.oldAttach);
  ok('★ 菜单三项且顺序正确', JSON.stringify(tools.menuItems) === JSON.stringify(['添加文件', '引用对话中的文件', '智能体']), tools.menuItems);

  // ---- 2. 点开菜单 ----
  console.log('\n[2] 点开 ＋ 菜单');
  await page.click('#plusBtn');
  await page.waitForTimeout(350);
  const opened = await page.evaluate(() => {
    const m = document.querySelector('#plusMenu');
    const r = m.getBoundingClientRect();
    return { hidden: m.hidden, w: Math.round(r.width), h: Math.round(r.height),
             inView: r.left >= 0 && r.right <= window.innerWidth + 1,
             sep: !!m.querySelector('.pm-sep') };
  });
  ok('菜单已展开且有尺寸', !opened.hidden && opened.w > 150 && opened.h > 100, opened);
  ok('菜单没有溢出视口', opened.inView);
  ok('菜单有分隔线（前两项与智能体之间）', opened.sep);
  await page.screenshot({ path: path.join(OUT, '01-plus-menu.png') });

  // 点空白处应关闭
  await page.mouse.click(700, 300);
  await page.waitForTimeout(250);
  ok('点空白处菜单关闭', await page.evaluate(() => document.querySelector('#plusMenu').hidden));

  // ---- 3. 模型下拉内容 ----
  console.log('\n[3] 模型选择器内容');
  const sel = await page.evaluate(() => {
    const s = document.querySelector('#modelSel');
    return { val: s.value, opts: Array.from(s.options).map(o => ({ v: o.value, t: o.textContent.trim() })) };
  });
  ok('有 2 个档位', sel.opts.length === 2, sel.opts);
  ok('★ 第二档显示 DeepSeek Pro（不再叫"深度思考"）',
    /DeepSeek Pro/.test(sel.opts[1] ? sel.opts[1].t : '') && !/深度思考/.test(sel.opts[1] ? sel.opts[1].t : ''), sel.opts[1]);
  await page.screenshot({ path: path.join(OUT, '02-toolbar.png') });

  // ---- 4. 选 DeepSeek Pro ----
  console.log('\n[4] 选 DeepSeek Pro');
  await page.selectOption('#modelSel', 'deep');
  await page.waitForTimeout(600);
  const afterSel = await page.evaluate(() => ({
    val: document.querySelector('#modelSel').value,
    // 选完不该冒出个"深度思考"按钮 —— 它已经彻底并进下拉了
    hasDt: !!document.querySelector('#dtBtn'),
  }));
  ok('下拉切到 deep 档', afterSel.val === 'deep', afterSel);
  ok('  没有残留的深度思考按钮', !afterSel.hasDt);

  // ---- 5. 引用对话中的文件（空态提示）----
  console.log('\n[5] 引用对话中的文件（当前无文件）');
  await page.click('#plusBtn');
  await page.waitForTimeout(250);
  await page.click('#pmRefFile');
  await page.waitForTimeout(700);
  const refState = await page.evaluate(() => ({
    modalOpen: !document.querySelector('#mask').hidden,
    body: (document.querySelector('#modalBody') || {}).textContent || '',
    toast: (document.querySelector('#toast') || {}).textContent || '',
  }));
  ok('无文件时给出可理解的提示（不弹空框）',
    !refState.modalOpen || /还没有可引用/.test(refState.toast), refState);
  await page.screenshot({ path: path.join(OUT, '03-ref-empty.png') });

  // ---- 6. 智能体入口复用 ----
  console.log('\n[6] 智能体入口');
  if (refState.modalOpen) { await page.keyboard.press('Escape'); await page.waitForTimeout(200); }
  await page.click('#plusBtn');
  await page.waitForTimeout(250);
  await page.click('#pmAgent');
  await page.waitForTimeout(800);
  const agentModal = await page.evaluate(() => ({
    open: !document.querySelector('#mask').hidden,
    title: (document.querySelector('#modalTitle') || {}).textContent || '',
    list: document.querySelectorAll('#agList .ag-i').length,
  }));
  ok('★ 弹出了「选择 AI 助手」（复用现有选择器）', agentModal.open && /AI 助手/.test(agentModal.title), agentModal);
  ok('助手列表非空', agentModal.list > 0, agentModal.list);
  await page.screenshot({ path: path.join(OUT, '04-agent-modal.png') });

  // ---- 7. 窄屏 ----
  console.log('\n[7] 窄屏（390px）');
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(500);
  const narrow = await page.evaluate(() => ({
    overflow: document.documentElement.scrollWidth > window.innerWidth + 1,
    // 工具栏允许横向滚动，但不能撑破 body
    toolsWrap: getComputedStyle(document.querySelector('.composer-tools')).flexWrap,
  }));
  ok('窄屏无横向溢出', !narrow.overflow, narrow);
  await page.click('#plusBtn');
  await page.waitForTimeout(350);
  const nM = await page.evaluate(() => {
    const r = document.querySelector('#plusMenu').getBoundingClientRect();
    return { left: Math.round(r.left), right: Math.round(r.right), inView: r.left >= -1 && r.right <= window.innerWidth + 1 };
  });
  ok('★ 窄屏下菜单仍完整可见（自动右对齐）', nM.inView, nM);
  await page.screenshot({ path: path.join(OUT, '05-narrow-menu.png') });

  ok('无未预期的控制台报错', errs.length === 0, errs.slice(0, 3));

  await browser.close();
  srv.kill();
  try { fs.rmSync(DATA, { recursive: true, force: true }); } catch (e) {}

  console.log('\n截图目录: ' + OUT);
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  process.exit(fail ? 1 : 0);
})().catch(async e => {
  console.error('ERR', e.message);
  process.exit(1);
});

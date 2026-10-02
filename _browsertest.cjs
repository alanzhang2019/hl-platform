'use strict';
/**
 * 浏览器冒烟自检
 *
 * 前面两套测试跑在 Node 里，证明不了"页面真的能跑"。
 * 这里用真实 Chromium 打开页面，做三件 Node 做不到的事：
 *   1. 捕获控制台报错与未捕获异常（前端最常见的静默失败）
 *   2. 验证 svg-json 渲染出来的 SVG 在真实排版引擎里**真的有尺寸**（不是空壳）
 *   3. 验证 SSE 流式在浏览器里真的逐字出现，而不是等一整坨
 *
 * 跑法（NODE_PATH 指向托管工作区）：
 *   NODE_PATH=.../node/workspace/node_modules node _browsertest.cjs
 */
const path = require('path');
const fsx = require('fs');
const { chromium } = require('playwright-core');

/**
 * 找 Chromium。
 * 不写死版本号 —— playwright 一升级目录名就变了，写死会让测试在别人的机器上
 * 直接跑不起来。优先用 CHROME 环境变量，其次扫描 ms-playwright 里版本号最大的那个。
 */
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
  } catch (e) { /* 目录不存在就走下面的报错 */ }
  return best;
}
const CHROME = findChrome();
const BASE = process.env.BASE || 'http://127.0.0.1:3100';
const SHOTS = path.join(__dirname, '_shots');

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  \u2713 ' + name); }
  else { fail++; failures.push(name + (extra ? ' → ' + (typeof extra === 'string' ? extra : JSON.stringify(extra)) : '')); console.log('  \u2717 ' + name + (extra ? ' → ' + (typeof extra === 'string' ? extra : JSON.stringify(extra)) : '')); }
}
function group(t) { console.log('\n' + t); }

/**
 * 顶级导航砍成「对话 / 知识库」两根之后，其余功能都在知识库的二级分区里。
 * 要进某个功能：先点「知识库」，再点分区条上对应的 tab。
 * memory / settings 不在分区条上，只能从右上角头像菜单进 —— 这两条路径分开走。
 */
async function goSub(page, key) {
  await page.click('.nav-i[data-view="kb"]');
  await page.waitForSelector('#view-kb:not([hidden])');
  await page.waitForSelector('#kbTabs .kb-tab');
  if (key === 'memory' || key === 'settings') {
    await page.locator('.me-chip:visible').first().click();
    await page.waitForSelector('#mask:not([hidden])');
    await page.click('#modalBody [data-me="' + key + '"]');
  } else {
    await page.click('#kbTabs [data-sub="' + key + '"]');
  }
  await page.waitForTimeout(150);
}

/**
 * 把宠物喂到「参天」，好让后面的分区都能进（批次7 起功能按宠物阶段解锁）。
 *
 * 走的是**真实路径**：建卡 → 复习答对 → 成长值上涨，不开测试后门。
 * 成长值只认"知识卡状态真的往前推进"，一张新卡答对 + 理解到位 = 13 点，
 * 400 点需要 31 张 —— 所以是循环喂，而不是写死张数。
 *
 * 喂完把临时卡删掉：它们只是为了把宠物喂大，留着会污染后面"知识卡列表"的断言。
 * 删卡不会让成长值退回去（本来就不做退化）。
 */
async function feedPetToTop(page) {
  return await page.evaluate(async () => {
    const H = { 'Content-Type': 'application/json' };
    const token = localStorage.getItem('hl_token') || '';
    if (token) H.Authorization = 'Bearer ' + token;
    const jget = u => fetch(u, { headers: H }).then(r => r.json());
    const jpost = (u, b) => fetch(u, { method: 'POST', headers: H, body: JSON.stringify(b) }).then(r => r.json());
    const made = [];
    let guard = 0;
    while (guard++ < 45) {
      const st = await jget('/api/pet');
      if (st.unlocks && st.unlocks.maxed) break;
      const c = await jpost('/api/cards', {
        knowledge: '冒烟临时卡 ' + guard, question: '问 ' + guard, answer: '答 ' + guard,
      });
      if (!c || !c.card) break;
      made.push(c.card.id);
      await jpost('/api/cards/' + c.card.id + '/review', { result: 'right', verdict: 'solid' });
    }
    for (const id of made) await fetch('/api/cards/' + id, { method: 'DELETE', headers: H });
    return jget('/api/pet');
  });
}

(async () => {
  require('fs').mkdirSync(SHOTS, { recursive: true });
  if (!CHROME) {
    console.error('找不到 Chromium。装一个：npx playwright install chromium');
    console.error('或用 CHROME=/path/to/chrome.exe 指定。');
    process.exit(2);
  }
  console.log('  Chromium：' + CHROME);
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, locale: 'zh-CN' });
  const page = await ctx.newPage();

  const errors = [], warnings = [];
  page.on('console', m => {
    if (m.type() === 'error') errors.push(m.text());
    else if (m.type() === 'warning') warnings.push(m.text());
  });
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  // 批次2 起有几处破坏性操作走原生 confirm（删除消息 / 取消分享 / 重新生成）。
  // Playwright 默认自动 dismiss，会让"确认后应该发生的事"永远不发生 ——
  // 这里统一接受，模拟用户点了"确定"。
  page.on('dialog', d => d.accept().catch(() => {}));
  page.on('requestfailed', r => {
    // 忽略浏览器自己发起的探测请求
    if (!/favicon/.test(r.url())) errors.push('REQFAIL: ' + r.url() + ' ' + (r.failure() || {}).errorText);
  });

  console.log('浏览器冒烟自检（真实 Chromium）');
  console.log('  页面 ' + BASE);

  // ---------- 1. 空间门 ----------
  group('1. 空间门');
  await page.goto(BASE, { waitUntil: 'networkidle' });
  ok('页面标题正确', (await page.title()).indexOf('后浪') >= 0, await page.title());
  ok('空间门可见', await page.locator('#land').isVisible());
  ok('主界面此时隐藏', !(await page.locator('#app').isVisible()));
  ok('品牌名渲染', (await page.locator('.land-logo').innerText()).indexOf('后浪') >= 0);

  // ---------- 1.1 批次9：合规入口与第一屏抬头 ----------
  group('1.1 落地页合规入口（批次9）');

  // 抬头必须在卡片**之外**、且排在卡片之前 —— 第一屏先回答"这是谁"
  const headOutside = await page.evaluate(() => {
    const head = document.querySelector('.land-head');
    const card = document.querySelector('.land-card');
    if (!head || !card) return false;
    return !card.contains(head) && !head.contains(card) &&
      (head.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
  });
  ok('★ 品牌抬头在卡片之外、且排在卡片之前', headOutside);
  ok('抬头里有立场句', (await page.locator('.land-stance').innerText()).indexOf('不直接给答案') >= 0);

  // ★ 本次修的 bug：合规入口此前只在注册/验证码表单的勾选框里，
  //   走「创建学习空间」这条最常见路径的人看不到。
  ok('★ 创建 tab 下页脚合规入口就可见（不用先去注册）', await page.locator('.land-legal').isVisible());
  const footLinks = await page.locator('.land-legal a').allInnerTexts();
  ok('★ 页脚常驻三份合规文件，顺序固定',
    footLinks.join(',') === '用户协议,隐私政策,儿童个人信息保护规则', JSON.stringify(footLinks));
  ok('页脚有监护人提示', (await page.locator('.land-note').innerText()).indexOf('不满 14 周岁') >= 0);

  // 点页脚的隐私政策：能开、且**版本号非空**
  // （DOC_VERSION 曾经取错模块 → undefined → JSON 里整个键消失 → 弹窗写成「版本 」）
  await page.click('.land-legal a[data-doc="privacy"]');
  await page.waitForSelector('#mask:not([hidden])');
  ok('页脚点开的是隐私政策', (await page.locator('#modalTitle').innerText()).indexOf('隐私政策') >= 0);
  const metaTxt = await page.locator('#modalBody .doc-meta').innerText();
  ok('★ 弹窗显示真实版本号（不为空、不是 undefined）',
    /版本\s*\d{4}-\d{2}-\d{2}/.test(metaTxt), JSON.stringify(metaTxt));
  ok('隐私政策有分节正文', (await page.locator('#modalBody .doc-body h4').count()) >= 4,
    await page.locator('#modalBody .doc-body h4').count());
  await page.click('#modalClose');
  await page.waitForSelector('#mask', { state: 'hidden' });

  // 背景粒子确实画了东西（不是空白 canvas）
  const canvasPainted = await page.evaluate(() => {
    const cv = document.querySelector('#landCanvas');
    if (!cv || !cv.width) return false;
    const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
    for (let i = 3; i < d.length; i += 4 * 97) if (d[i] > 0) return true;
    return false;
  });
  ok('背景粒子层真的画出了像素', canvasPainted);

  // 姓名实时预检
  const NAME = '浏览器验证' + Math.floor(Math.random() * 9000 + 1000);
  await page.fill('#spName', NAME);
  await page.waitForFunction(() => {
    const t = document.querySelector('#spNameHint').textContent || '';
    return t.indexOf('可以用') >= 0 || t.indexOf('已有') >= 0;
  }, null, { timeout: 5000 });
  const hintText = await page.locator('#spNameHint').innerText();
  ok('姓名可用性实时提示出现', hintText.indexOf('可以用') >= 0, hintText);

  // 撞名提示
  await page.fill('#spName', NAME);
  await page.evaluate(async n => {
    // 先造一个同名空间，再回到页面看提示（走接口，避免依赖 UI 顺序）
    const r = await fetch('/api/space', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: n + 'X', passcode: '' }) });
    return r.status;
  }, NAME);

  await page.fill('#spName', NAME);
  await page.waitForTimeout(600);
  const hint2 = await page.locator('#spNameHint').innerText();
  ok('未被占用时提示可用', hint2.indexOf('可以用') >= 0, hint2);

  await page.screenshot({ path: path.join(SHOTS, '01-land.png') });

  // ---------- 2. 进入主界面 ----------
  group('2. 创建空间并进入');
  await page.click('#spCreate');
  await page.waitForSelector('#app', { state: 'visible', timeout: 8000 });
  ok('创建后进入主界面', await page.locator('#app').isVisible());
  const spName = await page.locator('#spaceName').innerText();
  ok('侧栏显示姓名', spName === NAME, spName);
  const idChip = await page.locator('#spaceIdChip').innerText();
  ok('姓名下方显示空间 ID', /^ID：\d{4}$/.test(idChip), idChip);
  // ★ `#app` 可见 ≠ 首屏渲染完。
  //   enterApp() 先把 #app 显示出来，再 await 9 个并行加载，最后才 renderStreamEmpty()。
  //   这台机器（磁盘接近写满）一次 API 调用要 1–9 秒，boot 全程 8 秒 ——
  //   紧跟 #app 可见就断言，等于在"还没渲染"时断言，红得毫无线索。
  //   按"等你真正要断言的那个元素"来等，而不是假设它已经好了。
  await page.waitForFunction(
    () => { const p = document.querySelector('#petLine'); return !!p && p.innerText.trim().length > 0; },
    null, { timeout: 30000 }).catch(() => {});
  ok('宠物条渲染', (await page.locator('#petLine').innerText()).length > 0, await page.locator('#petLine').innerText());
  ok('宠物条含成长进度条', await page.locator('#petLine .pet-bar').count() === 1);
  ok('对话视图默认打开', await page.locator('#view-chat').isVisible());

  // ---------- 2.2 空状态（批次8 · 第一印象层）----------
  // 这是"打开产品的前 5 秒"。学生第一次进来不知道能问什么，四张卡就是来解决这件事的。
  group('2.2 对话空状态');
  const emptyTxt = (await page.locator('#streamEmpty').innerText()).replace(/\n/g, ' | ');
  ok('空状态可见', emptyTxt.length > 0, emptyTxt);
  // 静态兜底里没有空间名（boot 时才知道），JS 渲染会补上 —— 等它补上再断言。
  // 判据本身不变：名字始终不出现，这里就超时 → 断言照样红。
  const gotHi = await page.waitForFunction(
    n => { const h = document.querySelector('.empty-hi'); return !!h && h.innerText.indexOf(n) >= 0; },
    NAME, { timeout: 30000 }).then(() => true).catch(() => false);
  ok('★ 大标题带空间名', gotHi, await page.locator('.empty-hi').innerText());
  ok('问句「今天想弄明白什么？」在', emptyTxt.indexOf('今天想弄明白什么') >= 0, emptyTxt);
  ok('★ 教育立场还在（不直接给答案）', emptyTxt.indexOf('我不会直接给你答案') >= 0, emptyTxt);
  ok('视觉主体渲染了（.empty-art 是 SVG 且有尺寸）', await page.evaluate(() => {
    const el = document.querySelector('.empty-art');
    if (!el || el.tagName.toLowerCase() !== 'svg') return false;
    const r = el.getBoundingClientRect();
    return r.width > 60 && r.height > 40;
  }));
  ok('视觉主体真的画出了 path（不是空壳）', await page.locator('.empty-art path').count() === 5);
  ok('四张快捷卡都在', await page.locator('#emptyCards .ec').count() === 4);
  const cardTitles = await page.locator('#emptyCards .ec b').allInnerTexts();
  ok('四张卡标题正确', cardTitles.join(',') === '讲错题,读材料,背下来,问个为什么', cardTitles.join(','));
  ok('四张卡都有说明文字', (await page.locator('#emptyCards .ec .ec-d').allInnerTexts()).every(t => t.length >= 8));
  ok('每张卡都有图标 SVG', await page.locator('#emptyCards .ec .ec-i svg').count() === 4);
  ok('知识库用法提示还在', emptyTxt.indexOf('知识库') >= 0, emptyTxt);

  // ★ 点击只预填，不直接发送 —— 直接发等于替学生决定了怎么问
  await page.click('#emptyCards .ec[data-ec="wrong"]');
  await page.waitForTimeout(200);
  const afterClick = await page.inputValue('#input');
  ok('★ 点卡片把话预填进输入框', afterClick === '这道题我做错了，但说不清错在哪：', JSON.stringify(afterClick));
  ok('★ 点卡片没有直接发送（对话流里仍只有空状态）',
    await page.locator('#stream .msg').count() === 0, 'msg 数=' + await page.locator('#stream .msg').count());
  ok('输入框获得焦点（可以直接接着改）',
    await page.evaluate(() => document.activeElement && document.activeElement.id === 'input'));
  ok('预填文案以「：」结尾（邀请学生自己补完）', /：$/.test(afterClick), JSON.stringify(afterClick));
  // 清空，别污染后面的用例
  await page.fill('#input', '');

  // ---------- 2.5 宠物阶段 = 功能门槛（批次7）----------
  // 新空间一进来不该看到十个入口全亮着。这条守的是"新手知道从哪开始"。
  group('2.5 宠物阶段控制功能解锁');
  await page.click('.nav-i[data-view="kb"]');
  await page.waitForSelector('#kbTabs .kb-tab');
  ok('新空间下「能力」分区是锁定的', await page.locator('#kbTabs [data-sub="skills"].locked').count() === 1);
  ok('新空间下「资料」分区不锁（阶段1 就该有）', await page.locator('#kbTabs [data-sub="docs"].locked').count() === 0);
  ok('新空间下「知识卡」分区不锁（成长值引擎，不能锁）', await page.locator('#kbTabs [data-sub="cards"].locked').count() === 0);
  const lockTitle = await page.locator('#kbTabs [data-sub="skills"]').getAttribute('title');
  ok('锁定分区写明还差多少点', /再攒 \d+ 点/.test(lockTitle || ''), lockTitle);
  await page.click('#kbTabs [data-sub="skills"]');
  await page.waitForTimeout(200);
  ok('点锁定分区切不过去', await page.locator('#view-skills').isHidden());
  ok('宠物条写明下一步解锁什么', /解锁/.test(await page.locator('#petLine').innerText()),
    await page.locator('#petLine').innerText());

  const fed = await feedPetToTop(page);
  ok('喂满后宠物到参天', fed.pet.stage === 5, fed.pet.stage);
  ok('喂满后全部功能解锁', !!(fed.unlocks && fed.unlocks.maxed), fed.unlocks && fed.unlocks.unlocked);
  // 前端并不知道自己被"从后台"喂大了（真实用户是复习完自动刷新解锁状态，见 app.js 的 afterReview）。
  // 这里刷新一次让它重新拉 pet —— 顺带验证 token 有效、刷新后仍在自己空间里。
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#app', { state: 'visible', timeout: 10000 });
  ok('刷新后仍在自己空间里', await page.locator('#app').isVisible());
  await page.click('.nav-i[data-view="kb"]');
  await page.waitForSelector('#kbTabs .kb-tab');
  ok('解锁后「能力」分区不再锁', await page.locator('#kbTabs [data-sub="skills"].locked').count() === 0);
  await page.click('.nav-i[data-view="chat"]');
  await page.waitForTimeout(150);

  // ---------- 3. SSE 流式 ----------
  group('3. 对话与 SSE 流式渲染');
  await page.fill('#input', '三角形面积怎么算？');
  await page.click('#send');
  // 等第一条 AI 消息出现
  // ★ 超时给宽：这条路上服务端要落库（消息行 + activity），
  //   本机一次写要一次 fsync（磁盘接近写满），一轮对话可能十几秒。
  await page.waitForSelector('.msg.ai .md', { timeout: 45000 });
  // 抓一个"中途"的快照：此时应该还在流
  // 注：配图已改为后台异步，流结束更快，所以快照要尽早抓；
  // 光标可能在极短窗口内存在，不再把它当成硬断言，改用"中途内容 < 最终内容"来保证逐字出。
  const midLen = await page.locator('.msg.ai .md').first().innerText();
  const hasCaretMid = await page.locator('.caret').count() > 0;
  await page.waitForFunction(() => document.querySelector('#send') && !document.querySelector('#send').disabled, null, { timeout: 90000 });
  const finalText = await page.locator('.msg.ai .md').first().innerText();
  ok('AI 消息出现', finalText.length > 5, finalText.slice(0, 40));
  ok('中途内容短于最终内容（真的在长）', midLen.length <= finalText.length, midLen.length + ' → ' + finalText.length);
  ok('流结束后光标消失', (await page.locator('.caret').count()) === 0);
  // 侧栏列表是在流结束的回执里刷新的，跟 #send 重新可用不是同一拍。
  // 这里等它出现再断言，而不是假设它已经好了 —— 否则会变成随机失败。
  await page.waitForSelector('.conv-i', { timeout: 6000 }).catch(() => {});
  ok('用户消息在左侧栏出现标题', (await page.locator('.conv-i').count()) >= 1);
  // 苏格拉底式反问的措辞会变，只要不带直接给公式/答案的口吻即可
  ok('回答遵守"先反问不给答案"', !/(公式是|答案就是|等于|你可以直接套)/.test(finalText), finalText.slice(0, 60));
  ok('顶栏标题同步成首条消息（不再停在"新对话"）',
    (await page.locator('#convTitle').innerText()).indexOf('三角形') >= 0,
    await page.locator('#convTitle').innerText());

  // 用户消息应整体靠右：头像贴在最右侧，气泡紧挨它左边
  const layout = await page.evaluate(() => {
    const m = document.querySelector('.msg.user');
    const av = m.querySelector('.av').getBoundingClientRect();
    const bd = m.querySelector('.body').getBoundingClientRect();
    const wrap = m.getBoundingClientRect();
    return {
      gap: Math.round(av.left - bd.right),          // 气泡右缘 → 头像左缘
      avatarRightSlack: Math.round(wrap.right - av.right), // 头像距容器右缘
      bodyMid: Math.round((bd.left + bd.right) / 2 - wrap.left), // 气泡中心在容器内的位置
      wrapW: Math.round(wrap.width),
    };
  });
  ok('用户气泡紧贴头像（间距 8–20px）', layout.gap >= 8 && layout.gap <= 20, JSON.stringify(layout));
  ok('用户头像贴在容器最右侧', layout.avatarRightSlack <= 4, JSON.stringify(layout));
  ok('用户气泡位于右半侧', layout.bodyMid > layout.wrapW / 2, JSON.stringify(layout));

  // 消息操作按钮
  ok('AI 消息带"收成知识卡"按钮', (await page.locator('.msg.ai .acts [data-a="cards"]').count()) >= 1);

  await page.screenshot({ path: path.join(SHOTS, '02-chat.png') });

  // ---------- 4. 渲染管线在真实浏览器里跑 ----------
  group('4. 渲染管线在真实浏览器里的表现');
  const renderProbe = await page.evaluate(() => {
    const box = document.createElement('div');
    box.style.cssText = 'position:fixed;left:-9999px;top:0;width:640px';
    document.body.appendChild(box);
    const out = {};
    const cases = {
      mindmap: { kind: 'mindmap', title: '分数', nodes: [{ id: 'r', label: '分数' }, { id: 'a', label: '分子' }, { id: 'b', label: '分母' }], edges: [{ from: 'r', to: 'a' }, { from: 'r', to: 'b' }] },
      flow: { kind: 'flow', title: '步骤', nodes: [{ id: '1', label: '读题' }, { id: '2', label: '列式' }], edges: [{ from: '1', to: '2' }] },
      timeline: { kind: 'timeline', title: '时间线', items: [{ time: '1839', desc: '第一张照片' }, { time: '1900', desc: '普及' }] },
      geometry: { kind: 'geometry', title: '三角形', points: [{ x: 0, y: 0, label: 'A' }, { x: 6, y: 0, label: 'B' }, { x: 0, y: 4, label: 'C' }], segments: [['A', 'B'], ['B', 'C'], ['C', 'A']] },
      bars: { kind: 'bars', title: '对比', items: [{ label: '甲', value: 30 }, { label: '乙', value: 70 }] },
    };
    for (const k in cases) {
      box.innerHTML = window.HL.render('```svg-json\n' + JSON.stringify(cases[k]) + '\n```');
      const svg = box.querySelector('svg');
      out[k] = svg ? { w: Math.round(svg.getBoundingClientRect().width), h: Math.round(svg.getBoundingClientRect().height), texts: svg.querySelectorAll('text').length } : null;
    }
    // 数学式
    box.innerHTML = window.HL.render('$\\frac{1}{2}$ 和 $x^{2}$');
    const frac = box.querySelector('.frac');
    out.math = { hasFrac: !!frac, fracH: frac ? Math.round(frac.getBoundingClientRect().height) : 0, sup: box.querySelectorAll('sup').length };
    // 代码高亮
    box.innerHTML = window.HL.render('```js\nconst a = 1;\n```');
    out.code = { spans: box.querySelectorAll('.tk-k').length, copyBtn: box.querySelectorAll('.code-copy').length };
    // 表格
    box.innerHTML = window.HL.render('| A | B |\n| --- | --- |\n| 1 | 2 |');
    out.table = { rows: box.querySelectorAll('tr').length };
    // 图外标注不能被裁掉（真实排版引擎才测得出）
    box.innerHTML = window.HL.render('```svg-json\n' + JSON.stringify({
      kind: 'geometry', title: '带标注', points: [{ x: 0, y: 0, label: 'A' }, { x: 6, y: 0, label: 'B' }, { x: 0, y: 4, label: 'C' }],
      segments: [['A', 'B'], ['B', 'C'], ['C', 'A']], labels: [{ x: 3, y: -2, text: '底6' }],
    }) + '\n```');
    const gsvg = box.querySelector('svg');
    const sb = gsvg.getBoundingClientRect();
    const lbl = Array.prototype.find.call(gsvg.querySelectorAll('text'), t => t.textContent.indexOf('底') >= 0);
    if (lbl) {
      const tb = lbl.getBoundingClientRect();
      out.geoLabel = { found: true, clippedTop: tb.top < sb.top - 0.5, clippedBottom: tb.bottom > sb.bottom + 0.5, sb: [Math.round(sb.top), Math.round(sb.bottom)], tb: [Math.round(tb.top), Math.round(tb.bottom)] };
    } else out.geoLabel = { found: false };
    box.remove();
    return out;
  });

  for (const k of ['mindmap', 'flow', 'timeline', 'geometry', 'bars']) {
    const r = renderProbe[k];
    ok('svg-json[' + k + '] 在浏览器里画出了有尺寸的 SVG', !!r && r.w > 60 && r.h > 30, JSON.stringify(r));
    ok('svg-json[' + k + '] 有可见文字节点', !!r && r.texts > 0, JSON.stringify(r));
  }
  ok('数学分式渲染且有高度', renderProbe.math.hasFrac && renderProbe.math.fracH > 10, JSON.stringify(renderProbe.math));
  ok('上标渲染', renderProbe.math.sup >= 1, JSON.stringify(renderProbe.math));
  ok('代码高亮产生关键字 span', renderProbe.code.spans >= 1, JSON.stringify(renderProbe.code));
  ok('代码块带复制按钮', renderProbe.code.copyBtn === 1);
  ok('表格渲染出 2 行', renderProbe.table.rows === 2, JSON.stringify(renderProbe.table));
  ok('几何图里的图外标注被渲染出来', renderProbe.geoLabel.found === true, JSON.stringify(renderProbe.geoLabel));
  ok('图外标注没有被 viewBox 裁掉', renderProbe.geoLabel.found && !renderProbe.geoLabel.clippedTop && !renderProbe.geoLabel.clippedBottom,
    JSON.stringify(renderProbe.geoLabel));

  // 把五种图一次性塞进对话流，截一张"AI 真的画出了矢量图"的实图
  await page.evaluate(() => {
    const cases = [
      { kind: 'mindmap', title: '分数的组成', nodes: [{ id: 'r', label: '分数' }, { id: 'a', label: '分子' }, { id: 'b', label: '分母' }, { id: 'c', label: '分数线' }], edges: [{ from: 'r', to: 'a' }, { from: 'r', to: 'b' }, { from: 'r', to: 'c' }] },
      { kind: 'flow', title: '解应用题的顺序', nodes: [{ id: '1', label: '读题，圈出已知量' }, { id: '2', label: '找等量关系' }, { id: '3', label: '列式并检验' }], edges: [{ from: '1', to: '2', label: '想' }, { from: '2', to: '3', label: '写' }] },
      { kind: 'bars', title: '两次小测对比', items: [{ label: '计算', value: 62 }, { label: '应用题', value: 85 }, { label: '几何', value: 74 }] },
      { kind: 'timeline', title: '分数概念的发展', items: [{ time: '古埃及', desc: '单位分数' }, { time: '中国汉代', desc: '《九章算术》' }, { time: '印度', desc: '现代写法' }] },
      { kind: 'geometry', title: '直角三角形', points: [{ x: 0, y: 0, label: 'A' }, { x: 6, y: 0, label: 'B' }, { x: 0, y: 4, label: 'C' }], segments: [['A', 'B'], ['B', 'C'], ['C', 'A']], labels: [{ x: 3, y: -1.4, text: '底 6' }] },
    ];
    const host = document.querySelector('#stream .stream-in') || document.querySelector('#stream');
    const wrap = document.createElement('div');
    wrap.className = 'msg ai';
    wrap.innerHTML = '<div class="av">涌</div><div class="body"><div class="meta">小涌 · 只问不答</div><div class="md"></div></div>';
    wrap.querySelector('.md').innerHTML =
      window.HL.render('好，先把这几样摆出来看看。**注意每一张图的形状本身也在说话。**') +
      cases.map(c => window.HL.render('```svg-json\n' + JSON.stringify(c) + '\n```')).join('') +
      window.HL.render('$$\n\\frac{1}{2} + \\frac{1}{3} = \\frac{5}{6}\n$$');
    host.appendChild(wrap);
    window.__artWrap = wrap;
    wrap.scrollIntoView({ block: 'start' });
  });
  await page.waitForTimeout(400);
  const artCount = await page.locator('#stream svg').count();
  ok('五张图 + 公式都进了对话流', artCount >= 5, 'svg 数 ' + artCount);
  await page.screenshot({ path: path.join(SHOTS, '08-artifacts.png') });
  // 再把每张图单独截一张，方便逐张看排版
  for (let i = 0; i < 5; i++) {
    const el = page.locator('#stream .art').nth(i);
    if (await el.count()) await el.screenshot({ path: path.join(SHOTS, '09-art-' + i + '.png') });
  }
  await page.evaluate(() => { const m = document.querySelectorAll('#stream .msg.ai'); m[m.length - 1].remove(); });

  // ---------- 5. 五个视图切换 ----------
  group('5. 视图切换');
  await goSub(page, 'cards');
  await page.waitForSelector('#view-cards:not([hidden])');
  // 统计条是异步渲染的，等它真的出来再断言
  await page.waitForSelector('#cardStats .st', { timeout: 6000 });
  await page.waitForSelector('#cardList .empty, #cardList .kcard', { timeout: 6000 });
  ok('知识卡视图可见', await page.locator('#view-cards').isVisible());
  ok('知识卡统计卡渲染', (await page.locator('#cardStats .st').count()) >= 5);
  ok('空状态文案出现', (await page.locator('#cardList').innerText()).indexOf('收成知识卡') >= 0);

  await goSub(page, 'projects');
  await page.waitForSelector('#view-projects:not([hidden])');
  ok('项目视图可见', await page.locator('#view-projects').isVisible());

  // ---- 资料 ----
  await page.click('.nav-i[data-view="kb"]');
  await page.waitForSelector('#view-kb:not([hidden])');
  ok('资料视图可见', await page.locator('#view-kb').isVisible());
  ok('空状态提示可见', (await page.locator('#kbList').innerText()).indexOf('还没有资料') >= 0);
  ok('上传区可见', await page.locator('#kbDrop').isVisible());
  ok('上传区说明支持格式', (await page.locator('#kbDrop').innerText()).indexOf('PDF') >= 0);

  // 造一份资料（走真实接口，模拟前端上传路径）
  await page.evaluate(async () => {
    await fetch('/api/kb/documents', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + localStorage.getItem('hl_token') },
      body: JSON.stringify({ filename: '光合作用笔记.txt', text: '光合作用是绿色植物利用光能，把二氧化碳和水转化成有机物并释放氧气的过程，发生在叶绿体中。影响速率的因素有光照强度、二氧化碳浓度和温度。' }),
    });
  });
  await page.click('.nav-i[data-view="chat"]');
  await page.click('.nav-i[data-view="kb"]');
  await page.waitForSelector('.doc-i', { timeout: 5000 });
  ok('文档出现在列表', (await page.locator('.doc-i').count()) >= 1);
  ok('文档显示抽出字数', (await page.locator('.doc-i').first().innerText()).indexOf('抽出') >= 0,
    (await page.locator('.doc-i').first().innerText()).replace(/\n/g, ' | '));
  ok('文档带"已就绪"状态', (await page.locator('.doc-i .chip').first().innerText()).indexOf('已就绪') >= 0,
    (await page.locator('.doc-i .chip').first().innerText()));
  await page.screenshot({ path: path.join(SHOTS, '10-kb.png') });

  // 全文查看
  await page.click('.doc-i [data-doc="view"]');
  await page.waitForSelector('#mask:not([hidden])');
  ok('能查看抽取的全文', (await page.locator('#modalBody').innerText()).indexOf('光合作用') >= 0);
  await page.click('#modalClose');
  await page.waitForTimeout(200);

  // 检索
  await page.fill('#kbSearch', '光合作用需要什么条件');
  await page.waitForTimeout(900);
  ok('检索出命中片段', (await page.locator('.hit-i').count()) >= 1, '命中 ' + (await page.locator('.hit-i').count()));
  ok('命中标注出处', (await page.locator('.hit-i .h-f').first().innerText()).indexOf('光合作用笔记.txt') >= 0);
  await page.click('#kbClearSearch');
  await page.waitForTimeout(300);
  ok('清除搜索后回到列表', (await page.locator('.doc-i').count()) >= 1);

  // ---- 看板 ----
  await goSub(page, 'dash');
  await page.waitForSelector('#view-dash:not([hidden])');
  await page.waitForSelector('.dash-panel', { timeout: 8000 });
  ok('看板视图可见', await page.locator('#view-dash').isVisible());
  ok('KPI 卡片渲染', (await page.locator('.dash-kpi').count()) >= 5, '数量 ' + (await page.locator('.dash-kpi').count()));
  ok('KPI 不是全 0', (await page.locator('.dash-kpi b').allInnerTexts()).some(t => t !== '0'));
  ok('本周小结有内容', (await page.locator('.report-lines li').count()) >= 3);
  const dashSvgs = await page.locator('#dashBody .chart svg').count();
  ok('曲线图与分布图都画出来了', dashSvgs >= 2, 'svg 数 ' + dashSvgs);
  const chartBox = await page.locator('#dashBody .chart svg').first().boundingBox();
  ok('图表在浏览器里有真实尺寸', !!chartBox && chartBox.width > 200 && chartBox.height > 80, JSON.stringify(chartBox));
  ok('图里有柱子', (await page.locator('#dashBody .chart svg rect').count()) >= 1);
  ok('图里有坐标刻度', (await page.locator('#dashBody .chart svg text').count()) >= 4);
  ok('薄弱点区块存在', (await page.locator('#dashBody .dash-panel').count()) >= 5);
  ok('最近活动有记录', (await page.locator('#dashBody .dash-panel').last().innerText()).length > 4);
  await page.screenshot({ path: path.join(SHOTS, '11-dash.png') });

  // 切换天数要重新拉数据
  await page.selectOption('#dashDays', '7');
  await page.waitForTimeout(900);
  ok('切换天数后仍渲染', (await page.locator('.dash-panel').count()) >= 5);

  // ---- 能力中心 ----
  await goSub(page, 'skills');
  await page.waitForSelector('#view-skills:not([hidden])');
  await page.waitForSelector('.skill-c', { timeout: 6000 });
  const nSkills = await page.locator('.skill-c').count();
  ok('能力卡片共 57 张（对齐对标站 registry 总数）', nSkills === 57, '数量 ' + nSkills);
  ok('默认没有选中任何能力', (await page.locator('.skill-c.on').count()) === 0);
  ok('分类切换条存在', (await page.locator('#skillCats .cat-chip').count()) >= 4);
  ok('"全部"分类上标着 57', (await page.locator('#skillCats [data-cat="all"]').innerText()).indexOf('57') >= 0,
    await page.locator('#skillCats [data-cat="all"]').innerText());
  // 每个分类 chip 都带数量 —— 57 条平铺时，不写数量就不知道"学科能力"底下有多少
  const catTxt = await page.locator('#skillCats .cat-chip').allInnerTexts();
  ok('每个分类 chip 都带数字', catTxt.every(t => /\d/.test(t)), JSON.stringify(catTxt));
  // 学科二级筛选
  ok('学科筛选条出现', await page.locator('#skillSubjects').isVisible());
  const nSubjChips = await page.locator('#skillSubjects .cat-chip').count();
  ok('学科筛选含"全部"+六个学科', nSubjChips === 7, '实际 ' + nSubjChips + ' 个');
  const subjTxt = (await page.locator('#skillSubjects .cat-chip').allInnerTexts()).join(' ');
  ok('学科筛选里能看到"社会"（新学科）', subjTxt.indexOf('社会') >= 0, subjTxt);
  // 两排并排，如果都叫"全部 57"，用户分不清哪个管哪个
  ok('两排的"全部"按钮文案不同',
    (await page.locator('#skillCats [data-cat="all"]').innerText()) !== (await page.locator('#skillSubjects [data-subj="all"]').innerText()),
    '上排「' + (await page.locator('#skillCats [data-cat="all"]').innerText()) + '」/ 下排「' +
    (await page.locator('#skillSubjects [data-subj="all"]').innerText()) + '」');
  await page.screenshot({ path: path.join(SHOTS, '12-skills.png') });

  // 学科筛选真的能筛（点"社会"，应剩 3 张，且卡片角标写"社会"不是"social"）
  await page.click('#skillSubjects [data-subj="social"]');
  await page.waitForTimeout(250);
  const nSoc = await page.locator('.skill-c').count();
  ok('按"社会"筛选后剩 3 张', nSoc === 3, '实际 ' + nSoc);
  const socTxt = (await page.locator('.skill-c').allInnerTexts()).join(' ');
  ok('社会学科的卡片角标显示中文"社会"', socTxt.indexOf('社会') >= 0, socTxt.slice(0, 120));
  ok('界面上不出现英文 social', socTxt.indexOf('social') < 0, socTxt.slice(0, 120));
  await page.click('#skillSubjects [data-subj="all"]');
  await page.waitForTimeout(250);
  ok('点回"全部"恢复 57 张', (await page.locator('.skill-c').count()) === 57);

  // 点一个能力
  const feynman = page.locator('.skill-c', { hasText: '费曼讲解' }).first();
  await feynman.click();
  await page.waitForTimeout(700);
  ok('点击后能力被选中', (await page.locator('.skill-c.on').count()) === 1);
  // 顶级导航砍成两根后，能力角标挂在知识库的「能力」分区上
  const skillBadge = page.locator('#kbTabs .kb-tab-b[data-b="skills"]');
  ok('分区条出现已启用角标', await skillBadge.isVisible());
  ok('角标数字为 1', (await skillBadge.textContent()) === '1');

  // 刷新后保持。角标是 loadSkills() 拉取之后才写上去的，所以要等它真的变成 1，
  // 不能只看"元素在不在"——元素一直在，只是内容要等一次网络往返。
  await page.reload({ waitUntil: 'networkidle' });
  // 刷新后默认落在对话页，需要切回知识库才能看到分区条
  await page.click('.nav-i[data-view="kb"]');
  await page.waitForSelector('#kbTabs .kb-tab');
  let badgeAfter = '(超时)';
  try {
    await page.waitForFunction(
      () => { const b = document.querySelector('#kbTabs .kb-tab-b[data-b="skills"]'); return b && b.textContent === '1'; },
      { timeout: 15000 });
    badgeAfter = '1';
  } catch (e) { badgeAfter = await skillBadge.textContent().catch(() => '(无)'); }
  ok('刷新后能力仍处于启用状态', badgeAfter === '1', '角标=' + badgeAfter);

  // 分类筛选
  await goSub(page, 'skills');
  await page.waitForSelector('.skill-c');
  await page.click('#skillCats [data-cat="subject"]');
  await page.waitForTimeout(300);
  const nSubj = await page.locator('.skill-c').count();
  ok('按"学科能力"筛选后数量变少', nSubj > 0 && nSubj < nSkills, nSubj + ' / ' + nSkills);
  // 学科计数是跟着当前分类算的，换分类必须重画筛选条
  ok('切到"学科能力"后学科条重新计数（全部 = 35）',
    (await page.locator('#skillSubjects [data-subj="all"]').innerText()).indexOf('35') >= 0,
    await page.locator('#skillSubjects [data-subj="all"]').innerText());
  await page.click('#skillCats [data-cat="tool"]');
  await page.waitForTimeout(300);
  // "工具"底下清一色 general —— 只有一种学科时这一排是噪音，应当收起来
  ok('只剩一种学科时学科筛选条自动收起', await page.locator('#skillSubjects').isHidden());
  ok('切到"工具"后剩 6 张', (await page.locator('.skill-c').count()) === 6);
  await page.click('#skillCats [data-cat="all"]');
  await page.waitForTimeout(300);
  ok('切回"全部"后学科条又出现', await page.locator('#skillSubjects').isVisible());

  // 全部取消
  await page.click('#skillClear');
  await page.waitForTimeout(700);
  ok('全部取消后无选中', (await page.locator('.skill-c.on').count()) === 0);
  ok('侧栏角标消失', await page.locator('#navSkill').isHidden());

  await goSub(page, 'memory');
  await page.waitForSelector('#view-memory:not([hidden])');
  ok('记忆视图可见', await page.locator('#view-memory').isVisible());
  // ★ checked 是 loadMemory() 拿到 /api/memory 之后才设的（app.js:3362）。
  //   视图可见 ≠ 数据回来了 —— 这条以前是靠"刚好够快"过的。
  await page.waitForFunction(
    () => { const t = document.querySelector('#memToggle'); return !!t && t.checked; },
    null, { timeout: 30000 }).catch(() => {});
  ok('记忆开关默认开启', await page.locator('#memToggle').isChecked());
  await page.fill('#memInput', '我不喜欢直接给答案，请多问我');
  await page.click('#memAdd');
  await page.waitForTimeout(500);
  ok('添加记忆后列表出现该条', (await page.locator('#memList').innerText()).indexOf('不喜欢直接给答案') >= 0);

  await goSub(page, 'settings');
  await page.waitForSelector('#view-settings:not([hidden])');
  ok('设置视图可见', await page.locator('#view-settings').isVisible());
  ok('设置里有空间 ID', (await page.locator('#view-settings').innerText()).indexOf('空间 ID') >= 0);

  // ---------- 6. 主题与字号 ----------
  group('6. 主题与字号');
  await page.click('#themeSeg button[data-theme="dark"]');
  await page.waitForTimeout(150);
  ok('切深色后 html 属性变化', await page.evaluate(() => document.documentElement.getAttribute('data-theme')) === 'dark');
  ok('深色写入 localStorage', await page.evaluate(() => localStorage.getItem('hl_theme')) === 'dark');
  const darkBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  ok('深色主题背景确实变深', /rgb\(1[0-9], 1[0-9], 2[0-9]\)/.test(darkBg) || darkBg === 'rgb(14, 17, 23)', darkBg);
  await page.screenshot({ path: path.join(SHOTS, '03-dark.png') });

  await page.click('#fontSeg button[data-font="lg"]');
  await page.waitForTimeout(120);
  const fs = await page.evaluate(() => getComputedStyle(document.documentElement).fontSize);
  ok('字号切到"初中以上"后根字号变大', parseFloat(fs) >= 17.5, fs);

  // 刷新后主题字号要保持（防闪色脚本 + localStorage）
  await page.reload({ waitUntil: 'networkidle' });
  ok('刷新后仍是深色（持久化生效）', await page.evaluate(() => document.documentElement.getAttribute('data-theme')) === 'dark');
  ok('刷新后仍是大学号', parseFloat(await page.evaluate(() => getComputedStyle(document.documentElement).fontSize)) >= 17.5);
  ok('刷新后自动回到主界面（令牌持久化）', await page.locator('#app').isVisible());
  // 刷新后默认落在对话视图，要先回设置页才能点主题按钮
  await goSub(page, 'settings');
  await page.waitForSelector('#view-settings:not([hidden])');
  ok('刷新后设置页里主题按钮标记为深色', await page.evaluate(() =>
    !!document.querySelector('#themeSeg button[data-theme="dark"]').classList.contains('on')));
  await page.click('#themeSeg button[data-theme="light"]');
  await page.waitForTimeout(150);
  ok('切回浅色生效', await page.evaluate(() => document.documentElement.getAttribute('data-theme')) === 'light');

  // ---------- 7. 知识卡全流程（走真实 UI）----------
  group('7. 知识卡：练习弹窗全流程');
  await goSub(page, 'cards');
  await page.waitForSelector('#view-cards:not([hidden])');
  // 用接口造一张卡，再回到 UI 练它
  await page.evaluate(async () => {
    await fetch('/api/cards', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + localStorage.getItem('hl_token') },
      body: JSON.stringify({ knowledge: '浏览器验证知识点', type: 'choice', question: '1 + 1 = ?', answer: '2', options: { choices: ['2', '3', '4', '5'], answerIndex: 0 } }),
    });
  });
  await page.click('#cardRefresh');
  await page.waitForSelector('.kcard', { timeout: 5000 });
  ok('知识卡出现在列表', (await page.locator('.kcard').count()) >= 1);
  ok('卡片带状态标签', (await page.locator('.kcard .chip').count()) >= 1);
  ok('到期卡有"该练了"提示', (await page.locator('.kcard').first().innerText()).indexOf('该练了') >= 0);
  // 统计条不能是清一色的 0（首屏渲染早于汇总返回就会这样）
  const statNums = (await page.locator('#cardStats .st b').allInnerTexts()).map(Number);
  ok('统计条不是全 0（汇总数据先于渲染到位）', statNums.some(n => n > 0), JSON.stringify(statNums));
  ok('今日待练计数为 1', statNums[0] === 1, JSON.stringify(statNums));
  await page.screenshot({ path: path.join(SHOTS, '07-cards.png') });

  await page.click('.kcard [data-do="practice"]');
  await page.waitForSelector('#mask:not([hidden])');
  ok('练习弹窗打开', await page.locator('#mask').isVisible());
  ok('选择题渲染出 4 个选项', (await page.locator('#pcOpts .pc-opt').count()) === 4);
  ok('弹窗有"我已经会了"', (await page.locator('#pcKnown').count()) === 1);
  ok('弹窗有"给点提示"', (await page.locator('#pcHint').count()) === 1);

  // 先点提示（模型可能在忙，不等固定时间，等内容真的出现）
  await page.click('#pcHint');
  // ★ 签名是 waitForFunction(fn, arg, options)。把 {timeout} 当第二个参数传，
  //   它会被当成 arg 塞给页面函数，options 落空 ⇒ 悄悄退回默认 30 秒，
  //   看着"能过"，其实超时值根本不是你以为的那个。显式传 null。
  await page.waitForFunction(
    () => { const el = document.querySelector('#pcFb'); return el && el.innerText.trim().length > 0; },
    null, { timeout: 30000 });
  ok('提示区给出内容（或坦白说没有更好的提示）', (await page.locator('#pcFb').innerText()).length > 0);

  // 故意点错
  await page.click('#pcOpts .pc-opt[data-i="1"]');
  // ★ 选项标色是本地即时行为，可以短等；反馈文案要等服务端返回。
  //   别用固定 sleep 等一次往返 —— 一次写在这台机器上要几百毫秒，
  //   600ms 有时够有时不够，就成了随机红。等"反馈真的换了"再断言。
  await page.waitForSelector('#pcOpts .pc-opt.right', { timeout: 8000 });
  await page.waitForFunction(
    () => { const el = document.querySelector('#pcFb'); return !!el && /天后再练|明天再练/.test(el.innerText); },
    null, { timeout: 20000 }).catch(() => {});
  ok('点错后正确项被标出', (await page.locator('#pcOpts .pc-opt.right').count()) === 1);
  ok('点错后所选项被标红', (await page.locator('#pcOpts .pc-opt.wrong').count()) === 1);
  const fb1 = await page.locator('#pcFb').innerText();
  ok('反馈文案不出现"你错了"这种措辞', fb1.indexOf('你错了') < 0, fb1);
  ok('反馈给出下次练习时间', /天后再练|明天再练/.test(fb1), fb1);
  ok('出现"重来一次"入口', (await page.locator('#pcRestore').count()) === 1);

  await page.screenshot({ path: path.join(SHOTS, '04-practice.png') });

  // 重来一次
  await page.click('#pcRestore');
  // ★ 弹窗关闭发生在 POST 返回**之后**（app.js：先 await api(restore-review) 再 closeModal）。
  //   固定 sleep 700ms 等的是"一次服务端往返"，本机一次写要几百毫秒，是随机红的来源。
  //   等它真的关，再等卡片真的变回可练。
  await page.waitForSelector('#mask', { state: 'hidden', timeout: 30000 });
  ok('重置后弹窗关闭', await page.locator('#mask').isHidden());
  await page.waitForFunction(
    () => { const c = document.querySelector('.kcard'); return !!c && /该练了|现在可以练/.test(c.innerText); },
    null, { timeout: 30000 }).catch(() => {});
  const cardTxt = await page.locator('.kcard').first().innerText();
  ok('重置后卡片回到可练状态', cardTxt.indexOf('该练了') >= 0 || cardTxt.indexOf('现在可以练') >= 0, cardTxt.replace(/\n/g, ' | '));

  // 再练一次，答对
  await page.click('.kcard [data-do="practice"]');
  await page.waitForSelector('#mask:not([hidden])');
  await page.click('#pcOpts .pc-opt[data-i="0"]');
  await page.waitForFunction(
    () => { const el = document.querySelector('#pcFb'); return !!el && /记住啦|已经掌握/.test(el.innerText); },
    null, { timeout: 20000 }).catch(() => {});
  const fb2 = await page.locator('#pcFb').innerText();
  ok('答对后反馈显示记住啦/已掌握', /记住啦|已经掌握/.test(fb2), fb2);
  ok('答对后宠物成长值有变化', (await page.locator('#petLine').innerText()).length > 0);
  await page.click('#pcDone');
  // 同上：关弹窗在 POST 之后。遮罩没散就去点 #cardRefresh 会被它接走点击。
  await page.waitForSelector('#mask', { state: 'hidden', timeout: 30000 });

  // 理解题走 AI 核对
  await page.evaluate(async () => {
    await fetch('/api/cards', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + localStorage.getItem('hl_token') },
      body: JSON.stringify({ knowledge: '浏览器验证理解题', type: 'understanding', question: '说说为什么', answer: '参考要点若干' }),
    });
  });
  await page.click('#cardRefresh');
  // ★ 等那张卡真的出现在列表里，而不是睡 500ms 赌它刷新完了。
  await page.waitForSelector('.kcard:has-text("浏览器验证理解题")', { timeout: 30000 });
  const uCard = page.locator('.kcard', { hasText: '浏览器验证理解题' }).first();
  await uCard.locator('[data-do="practice"]').click();
  await page.waitForSelector('#mask:not([hidden])');
  ok('理解题用多行输入而非选项', (await page.locator('#pcInput').count()) === 1);
  ok('理解题按钮是"让 AI 核对我的理解"', (await page.locator('#pcCheck').count()) === 1);
  await page.fill('#pcInput', '因为植物需要阳光才能把水和二氧化碳变成养分');
  await page.click('#pcCheck');
  await page.waitForFunction(
    () => { const el = document.querySelector('#pcFb'); return el && el.innerText.trim().length > 0; },
    null, { timeout: 30000 });
  const vfb = await page.locator('#pcFb').innerText();
  ok('核对给出判定（反馈非空且不含粗暴否定）', vfb.length > 0 && vfb.indexOf('算错') < 0 && vfb.indexOf('你错了') < 0, vfb);

  await page.click('#modalClose');
  await page.waitForTimeout(300);

  // ---------- 8. 分享 ----------
  group('8. 分享链接');
  await page.click('.nav-i[data-view="chat"]');
  await page.waitForSelector('#view-chat:not([hidden])');
  // 刷新后应自动接上最近一条对话；若没有则手动点开
  if ((await page.locator('.msg').count()) === 0) {
    ok('刷新后自动接上最近一条对话（不是落在空白页）', (await page.locator('.conv-i').count()) > 0);
    await page.locator('.conv-i').first().click();
    await page.waitForTimeout(600);
  }
  ok('对话内容已载入', (await page.locator('.msg').count()) >= 2, '消息数 ' + (await page.locator('.msg').count()));
  // 批次2 起，分享按钮打开的是"分享管理"（创建 / 取消 / 访问次数），
  // 而不是直接建链 —— 这样用户能看见自己分享过什么、被看了几次。
  await page.click('#shareBtn');
  await page.waitForSelector('#mask:not([hidden])');
  ok('分享管理先显示未分享状态', (await page.locator('#shMake').count()) === 1);
  await page.click('#shMake');
  await page.waitForSelector('#shUrl', { timeout: 8000 });
  const shUrl = await page.inputValue('#shUrl');
  ok('生成分享链接', /\/s\/[0-9a-f]{16}$/.test(shUrl), shUrl);
  ok('分享管理显示访问次数', /访问次数/.test(await page.locator('#modalBody').innerText()));
  // 新开无痕上下文访问分享页
  const anon = await browser.newContext();
  const ap = await anon.newPage();
  const anonErrs = [];
  ap.on('pageerror', e => anonErrs.push(e.message));
  await ap.goto(shUrl, { waitUntil: 'networkidle' });
  const shBody = await ap.locator('body').innerText();
  ok('免登录能打开分享页', shBody.indexOf('学习对话') >= 0, shBody.slice(0, 60));
  ok('分享页含原对话内容', shBody.indexOf('三角形') >= 0, shBody.slice(0, 120));
  ok('分享页没有 JS 异常', anonErrs.length === 0, anonErrs.join(' | '));
  await ap.screenshot({ path: path.join(SHOTS, '05-share.png') });
  await anon.close();

  // 停止分享后失效
  await page.waitForTimeout(400);
  await page.click('#shStop');
  await page.waitForTimeout(500);
  const ap2 = await browser.newContext();
  const p2 = await ap2.newPage();
  await p2.goto(shUrl, { waitUntil: 'networkidle' });
  ok('停止分享后链接失效', (await p2.locator('body').innerText()).indexOf('不存在或已失效') >= 0);
  await ap2.close();

  // ---------- 9. 英语 ----------
  group('9. 英语：导入 → 列表 → 听写 → 交卷');
  await goSub(page, 'en');
  await page.waitForSelector('#view-en:not([hidden])');
  await page.waitForSelector('#enList .empty, #enList .en-i', { timeout: 6000 });
  ok('英语视图可见', await page.locator('#view-en').isVisible());
  ok('空状态引导批量导入', (await page.locator('#enList').innerText()).indexOf('批量导入') >= 0,
    (await page.locator('#enList').innerText()).replace(/\n/g, ' | '));

  // 走真实接口把词灌进去（等价于用户在导入弹窗里粘贴词表）
  await page.evaluate(async () => {
    await fetch('/api/english/words/import', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + localStorage.getItem('hl_token') },
      body: JSON.stringify({ text: 'apple /ˈæpl/ 苹果\nbanana 香蕉\ncherry,樱桃\ndate\t枣' }),
    });
  });
  await page.click('.nav-i[data-view="chat"]');
  await goSub(page, 'en');
  await page.waitForSelector('.en-i', { timeout: 6000 });
  ok('单词出现在列表', (await page.locator('.en-i').count()) >= 4);
  ok('音标被解析并显示', (await page.locator('.en-i').first().innerText()).indexOf('ˈæpl') >= 0,
    (await page.locator('.en-i').first().innerText()).replace(/\n/g, ' | '));
  ok('每行都有朗读按钮', (await page.locator('.en-i [data-speak]').count()) >= 4);
  ok('单词表统计条渲染', (await page.locator('#enStats .st').count()) >= 3);
  await page.screenshot({ path: path.join(SHOTS, '11-english.png') });

  // 听写
  await page.click('#enDict');
  await page.waitForSelector('#mask:not([hidden])');
  ok('听写模式选择弹窗出现', (await page.locator('#modalBody [data-mode]').count()) === 3);
  await page.click('#modalBody [data-mode="meaning"]');
  await page.waitForSelector('#dictGo', { timeout: 8000 });
  const dictN = await page.locator('.dict-i').count();
  ok('听写题目渲染出来', dictN >= 4, '题数 ' + dictN);
  const dictTxt = await page.locator('#modalBody').innerText();
  ok('听写界面不给答案（搜不到任何一个英文单词）',
    !/apple|banana|cherry|date/.test(dictTxt), dictTxt.slice(0, 120));
  // 全部故意写错，验证批改与错词转卡
  for (const inp of await page.locator('.dict-i input').all()) await inp.fill('zzzz');
  await page.click('#dictGo');
  await page.waitForSelector('#dictSum .dict-score', { timeout: 12000 });
  const sumTxt = await page.locator('#dictSum').innerText();
  ok('交卷后给出分数', /答对/.test(sumTxt), sumTxt.replace(/\n/g, ' | '));
  ok('每题都给出对错反馈', (await page.locator('.dict-i.ok, .dict-i.bad').count()) === dictN);
  ok('错词被转成拼写卡（回流复习系统）', sumTxt.indexOf('拼写卡') >= 0, sumTxt.replace(/\n/g, ' | '));
  ok('批改后逐位提示而不是直接给答案', (await page.locator('.dict-i .dict-fb').first().innerText()).length > 0);
  await page.screenshot({ path: path.join(SHOTS, '12-dictation.png') });
  await page.click('#modalClose');
  await page.waitForTimeout(400);

  // ---------- 10. 测评 ----------
  group('10. 测评：出卷 → 答题 → 交卷 → 回流');
  await goSub(page, 'exam');
  await page.waitForSelector('#view-exam:not([hidden])');
  await page.waitForSelector('#exList .empty, #exList .ex-i', { timeout: 8000 });
  ok('测评视图可见', await page.locator('#view-exam').isVisible());
  ok('学科分布统计条渲染', (await page.locator('#exStats .st').count()) >= 1);
  await page.click('#exNew');
  await page.waitForSelector('#exGo', { timeout: 15000 });
  const qN = await page.locator('.ex-q').count();
  ok('出卷后弹出答题界面', qN > 0, '题数 ' + qN);
  const examTxt = await page.locator('#modalBody').innerText();
  ok('答题界面不给参考答案', examTxt.indexOf('参考答案') < 0 && examTxt.indexOf('正确答案') < 0, examTxt.slice(0, 140));
  ok('答题界面说明做完会回流知识卡', examTxt.indexOf('知识卡') >= 0);

  // 第一道选择题点 A；拼写/理解题各填一点东西
  const opt0 = page.locator('.ex-q .pc-opt').first();
  if (await opt0.count()) await opt0.click();
  const ta0 = page.locator('#modalBody textarea').first();
  if (await ta0.count()) await ta0.fill('我随便写一句，用来验证理解题也能提交');
  const inp0 = page.locator('#modalBody .ex-q input.inp').first();
  if (await inp0.count()) await inp0.fill('zzz');
  await page.screenshot({ path: path.join(SHOTS, '13-exam-take.png') });
  await page.click('#exGo');
  await page.waitForSelector('#exDone', { timeout: 20000 });
  const resTxt = await page.locator('#modalBody').innerText();
  ok('交卷后出现结果页', (await page.locator('.ex-res').count()) === 1);
  ok('结果页给出答对率', resTxt.indexOf('答对率') >= 0);
  ok('结果页交卷后才给答案', resTxt.indexOf('参考答案') >= 0 || resTxt.indexOf('正确答案') >= 0, resTxt.slice(0, 200));
  ok('结果页说明题目已回流复习队列', resTxt.indexOf('知识卡') >= 0);
  await page.screenshot({ path: path.join(SHOTS, '14-exam-result.png') });
  await page.click('#exDone');
  await page.waitForTimeout(700);
  ok('点"收起来"后跳到知识卡', await page.locator('#view-cards').isVisible());

  await goSub(page, 'exam');
  await page.waitForSelector('#exList .ex-i', { timeout: 6000 });
  ok('卷子在列表里标记为已完成', (await page.locator('.ex-pill.done').count()) >= 1);

  // ---------- 11. 共享池 ----------
  group('11. 共享池：分享 → 列表 → 取用');
  await goSub(page, 'pool');
  await page.waitForSelector('#view-pool:not([hidden])');
  await page.waitForSelector('#poolList .empty, #poolList .pool-i', { timeout: 8000 });
  ok('共享池视图可见', await page.locator('#view-pool').isVisible());
  ok('池子说明了内容从哪来（不预置题库）', (await page.locator('#poolList').innerText()).indexOf('自己放上来') >= 0,
    (await page.locator('#poolList').innerText()).replace(/\n/g, ' | '));

  await page.click('#poolShare');
  await page.waitForSelector('#psGo', { timeout: 6000 });
  ok('分享弹窗说明不会出现姓名', (await page.locator('#modalBody').innerText()).indexOf('不会出现你的姓名') >= 0);
  // 标题带时间戳：池子是全局的，上一次跑留下的条目不该干扰这一次的断言
  const SHARE_TITLE = '浏览器验证分享' + Date.now().toString().slice(-6);
  await page.fill('#psTitle', SHARE_TITLE);
  await page.fill('#psNick', NAME);   // 故意填成空间名（= 真实姓名），必须被匿名化
  await page.click('#psGo');
  // ★ closeModal() 在 loadPool() 之前，弹窗一关列表就已经在拉了。
  //   这里等"弹窗真的关了"，而不是睡 1500ms —— 睡的是一次往返，本机几百毫秒上下浮动。
  await page.waitForSelector('#mask', { state: 'hidden', timeout: 30000 });
  ok('分享后弹窗自动关闭', await page.locator('#mask').isHidden());
  const mineItem = page.locator('.pool-i', { hasText: SHARE_TITLE }).first();
  await mineItem.waitFor({ timeout: 30000 }).catch(() => {});
  ok('分享后条目立刻出现在列表（不用手动刷新）', (await mineItem.count()) === 1);
  const mineTxt = await mineItem.innerText();
  ok('署名不是真实姓名（填成姓名也被换掉）', mineTxt.indexOf(NAME) < 0, mineTxt.replace(/\n/g, ' | '));
  ok('署名显示为匿名', mineTxt.indexOf('一位同学') >= 0, mineTxt.replace(/\n/g, ' | '));
  ok('条目带类型标签', (await mineItem.locator('.pool-tag.k-cards').count()) >= 1);
  ok('条目带学科标签', (await mineItem.locator('.pool-tag').count()) >= 2);
  await page.screenshot({ path: path.join(SHOTS, '15-pool.png') });

  const countCards = () => page.evaluate(async () => {
    const r = await fetch('/api/cards?pageSize=200', { headers: { Authorization: 'Bearer ' + localStorage.getItem('hl_token') } });
    return (await r.json()).total;
  });
  const poolCardCount = await countCards();
  await mineItem.locator('[data-copy]').click();
  // ★ 等"已取用"真的出现。
  //   取用 6 张卡原本要写 14 次库 = 14 次独立事务 ≈ 7 秒（见 server/pool.js 的注释），
  //   睡 1800ms 必然不够 —— 那不是测试写错，是产品真的慢。
  //   现在整个取用包在一个事务里 ≈ 0.6 秒，但固定 sleep 依然是随机红的来源。
  await page.waitForFunction(
    t => {
      for (const el of document.querySelectorAll('.pool-i')) {
        if (el.innerText.indexOf(t) >= 0) return el.innerText.indexOf('已取用') >= 0;
      }
      return false;
    },
    SHARE_TITLE, { timeout: 30000 }).catch(() => {});
  ok('取用后条目标记"已取用"', (await mineItem.innerText()).indexOf('已取用') >= 0, (await mineItem.innerText()).replace(/\n/g, ' | '));
  const poolCardCount2 = await countCards();
  ok('取用后自己空间的卡片真的变多了（复制而不是引用）', poolCardCount2 > poolCardCount,
    poolCardCount + ' → ' + poolCardCount2);

  // 切到"我分享的"
  await page.click('#poolTabs button[data-tab="mine"]');
  await page.waitForFunction(
    t => {
      const box = document.querySelector('#poolList');
      return !!box && box.innerText.indexOf(t) >= 0 && box.innerText.indexOf('你分享出去') >= 0;
    },
    SHARE_TITLE, { timeout: 30000 }).catch(() => {});
  ok('"我分享的"能看到自己那条', (await page.locator('#poolList').innerText()).indexOf(SHARE_TITLE) >= 0);
  ok('"我分享的"给出统计', (await page.locator('#poolList').innerText()).indexOf('你分享出去') >= 0);

  // ---------- 12. 动效（P8） ----------
  group('12. 动效（P8）');
  await goSub(page, 'dash');
  await page.waitForSelector('#dashBody .chart svg', { timeout: 10000 });
  ok('看板图表渲染出 SVG', (await page.locator('#dashBody .chart svg').count()) >= 1);
  ok('图表柱/折线带生长动画类', (await page.locator('#dashBody .chart .ch-bar, #dashBody .chart .ch-line').count()) >= 1);
  // 看板上两张图都是柱状（对话曲线 + 状态分布），所以这里查的是柱子。
  // 折线的 pathLength 归一在 _rendertest.cjs 里断言（那边能直接构造折线图）。
  ok('柱子带错峰延迟', (await page.locator('#dashBody .chart .ch-bar[style*="animation-delay"]').count()) >= 1);
  const barAnim = await page.evaluate(() => {
    const el = document.querySelector('#dashBody .chart .ch-bar');
    return el ? getComputedStyle(el).animationName : '(无)';
  });
  ok('柱子的生长动画真的被 CSS 接上了', barAnim === 'barGrow', barAnim);
  const viewAnim = await page.evaluate(() => getComputedStyle(document.querySelector('#view-dash')).animationName);
  ok('视图切换带入场动画', viewAnim === 'viewIn', viewAnim);
  await page.screenshot({ path: path.join(SHOTS, '16-dash.png') });

  // 练一次卡，验证"刚变的是这张"的高亮真的挂上去了
  await goSub(page, 'cards');
  await page.waitForSelector('.kcard', { timeout: 8000 });
  await page.click('.kcard [data-do="practice"]');
  await page.waitForSelector('#mask:not([hidden])');
  // 练习弹窗有四种题型：choice 出选项、spelling 出输入框、"理解"出文本框 + 核对按钮。
  // 这里不假定题型，等弹窗内容真的挂上去再按实际形态作答。
  await page.waitForSelector('#pcOpts, #pcInput', { timeout: 8000 });
  if (await page.locator('#pcOpts .pc-opt').count()) {
    await page.locator('#pcOpts .pc-opt').first().click();
  } else {
    await page.fill('#pcInput', '这段话讲的主要意思是，先自己讲一遍再看答案记得更牢。');
    await page.click('#pcSubmit, #pcCheck');
  }
  // 理解题要走两次模型调用（核对 + 完成），给足时间等 #pcDone 出现
  await page.waitForSelector('#pcDone', { timeout: 20000 });
  await page.click('#pcDone');
  await page.waitForTimeout(1000);
  ok('刚练过的那张卡，状态 chip 有"刚变化"高亮', (await page.locator('.kcard .chip.just').count()) === 1,
    'just chip 数 ' + (await page.locator('.kcard .chip.just').count()));

  // 系统关掉动效时，动效必须真的关掉（无障碍）
  const rctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, reducedMotion: 'reduce' });
  const rp = await rctx.newPage();
  await rp.goto(BASE, { waitUntil: 'networkidle' });
  await rp.waitForTimeout(500);
  const rDur = await rp.evaluate(() => {
    const el = document.querySelector('.land-card') || document.querySelector('.view') || document.body;
    return getComputedStyle(el).animationDuration;
  });
  ok('prefers-reduced-motion: reduce 时动画被压到接近 0', parseFloat(rDur) < 0.01, 'animation-duration=' + rDur);
  const rTrans = await rp.evaluate(() => {
    const el = document.querySelector('.nav-i') || document.body;
    return getComputedStyle(el).transitionDuration;
  });
  ok('prefers-reduced-motion: reduce 时过渡也被压到接近 0', parseFloat(rTrans) < 0.01, 'transition-duration=' + rTrans);
  await rctx.close();

  // ---------- 12.5 学习日报（批次10） ----------
  group('12.5 学习日报（批次10）');
  await goSub(page, 'dash');
  await page.waitForSelector('#dailyBox .d-daily', { timeout: 12000 });
  ok('日报块渲染出来了', (await page.locator('#dailyBox .d-daily').count()) === 1);
  ok('数字卡片成组出现', (await page.locator('#dailyBox .d-num').count()) >= 4);
  ok('四问都有输入框', (await page.locator('#dailyBox .d-ans').count()) === 4);

  // ★ 单滚动容器：日报与看板同住 #dashBody，两者自己都不滚。
  //   早先给日报单开了一个 .card-list，两个 flex:1 的兄弟抢高度 ——
  //   表现是"两块各缩一半、各自滚动、都看不全"，不报错也不红，只能靠这里钉住。
  const dScroll = await page.evaluate(() => {
    const q = s => document.querySelector(s);
    const ov = el => el.scrollHeight - el.clientHeight;
    return {
      bodyOverflow: ov(q('#dashBody')),
      dailyOverflow: ov(q('#dailyBox')),
      panelsOverflow: ov(q('#dashPanels')),
      dailyIsCardList: q('#dailyBox').classList.contains('card-list'),
      panelsIsCardList: q('#dashPanels').classList.contains('card-list'),
      dailyTop: q('#dailyBox').getBoundingClientRect().top,
      panelsTop: q('#dashPanels').getBoundingClientRect().top,
    };
  });
  ok('★ 内容确实超过一屏（否则下面几条判据没有意义）', dScroll.bodyOverflow > 40, dScroll.bodyOverflow);
  ok('★ 日报自己不是滚动容器（overflow 归零）', dScroll.dailyOverflow <= 1, dScroll.dailyOverflow);
  ok('★ 看板自己不是滚动容器（overflow 归零）', dScroll.panelsOverflow <= 1, dScroll.panelsOverflow);
  ok('★ #dailyBox / #dashPanels 都不是 .card-list（否则又变成两个滚动条）',
    !dScroll.dailyIsCardList && !dScroll.panelsIsCardList);
  ok('★ 日报在看板内容之上（顺序没被写反）', dScroll.dailyTop < dScroll.panelsTop,
    dScroll.dailyTop + ' vs ' + dScroll.panelsTop);

  // 算得出来的数字必须点得开，且弹窗里能看到原始记录
  const dNumCount = await page.locator('#dailyBox .d-num:not(.na)').count();
  ok('★ 本空间已练过卡、做过测评，至少有一个算得出的数字', dNumCount >= 1, dNumCount);
  if (dNumCount) {
    await page.locator('#dailyBox .d-num:not(.na)').first().click();
    await page.waitForSelector('#mask:not([hidden])', { timeout: 8000 });
    const evTitle = await page.locator('#modalTitle').innerText();
    ok('★ 溯源弹窗标题写明条数（可数＝可核对）', /条原始记录/.test(evTitle), evTitle);
    ok('★ 弹窗里真的列出了原始记录', (await page.locator('#modalBody .ev-i').count()) >= 1);
    await page.screenshot({ path: path.join(SHOTS, '17-daily-evidence.png') });
    await page.click('#modalClose');
    await page.waitForTimeout(300);
  }

  // 算不出来的数字：明说为什么，不补零
  const naCount = await page.locator('#dailyBox .d-num.na').count();
  if (naCount) {
    const naText = await page.locator('#dailyBox .d-num.na').first().innerText();
    ok('★ 算不出来的数字显示 — 而不是 0', naText.indexOf('—') >= 0, naText.replace(/\n/g, ' | '));
    ok('★ 并且把"为什么算不出来"写在卡片上（不是只藏在 title 里）',
      naText.replace(/[\s—]/g, '').length > 2, naText.replace(/\n/g, ' | '));
  } else {
    ok('本空间今天没有算不出的数字（空数据不补零由 _parity10check.cjs 覆盖）', true);
  }

  // 草稿：自动保存 + 刷新后还在
  await page.fill('#dailyBox .d-ans[data-k="goal"]', '今天想把浮力这块弄明白，结果还是有点糊。');
  await page.waitForTimeout(1600);
  const saveHint = await page.locator('#dailySaveHint').innerText();
  ok('★ 草稿自动保存（不用点按钮）', saveHint.indexOf('草稿已保存') >= 0, saveHint);

  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(500);
  await goSub(page, 'dash');
  await page.waitForSelector('#dailyBox .d-daily', { timeout: 12000 });
  const dKept = await page.inputValue('#dailyBox .d-ans[data-k="goal"]');
  ok('★ 刷新后草稿还在（真的落库了，不是只留在内存里）', dKept.indexOf('浮力') >= 0, dKept);
  await page.screenshot({ path: path.join(SHOTS, '17-daily.png') });

  // 定稿：定稿之后不再改写
  await page.click('#dailyFinal');
  await page.waitForTimeout(1600);
  ok('★ 定稿后四问变成只读',
    (await page.locator('#dailyBox .d-ans[data-k="goal"]').first().isEditable()) === false);
  ok('★ 定稿后按钮禁用', await page.locator('#dailyFinal').first().isDisabled());
  const finHint = await page.locator('#dailySaveHint').innerText();
  ok('★ 定稿后提示改成"不再改写"', finHint.indexOf('不再改写') >= 0, finHint);
  ok('★ 没有别的日期时历史区明说，不画一个空框',
    (await page.locator('#dailyBox').innerText()).indexOf('还没有别的日报') >= 0);

  // ---------- 13. 移动端 ----------
  group('13. 移动端布局');

  /**
   * 判据不能只看 documentElement.scrollWidth。
   * .app 有 overflow:hidden —— 顶栏撑出去的元素会被直接裁掉，
   * scrollWidth 照样等于视口宽度（改之前实测就是"0px 溢出"的假绿）。
   * 所以逐元素量右边界，并跳过"横滑容器内部"（那些本来就允许滑出视口）。
   *
   * 这个函数会被序列化丢进浏览器，**不能引用外面任何东西**。
   */
  function overflowProbe(vw) {
    const lbl = el => el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') +
      (el.className && typeof el.className === 'string'
        ? '.' + el.className.trim().split(/\s+/).join('.') : '');
    const inScroller = el => {
      for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
        const ox = getComputedStyle(p).overflowX;
        if (ox === 'auto' || ox === 'scroll') return true;
      }
      return false;
    };
    const out = [];
    for (const el of document.querySelectorAll('body *')) {
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      if (cs.overflowX === 'auto' || cs.overflowX === 'scroll') continue;
      if (inScroller(el)) continue;
      const over = Math.round(r.right - vw);
      if (over > 1) out.push({ sel: lbl(el), over: over, text: (el.textContent || '').trim().slice(0, 20) });
    }
    out.sort((a, b) => b.over - a.over);
    return out.slice(0, 6);
  }

  for (const vp of [{ w: 390, h: 844, tag: '390×844' }, { w: 320, h: 568, tag: '320×568' }]) {
    const mc = await browser.newContext({
      viewport: { width: vp.w, height: vp.h }, isMobile: true, hasTouch: true, locale: 'zh-CN',
    });
    const mp = await mc.newPage();
    const mErrs = [];
    mp.on('pageerror', e => mErrs.push('PAGEERROR: ' + e.message));
    mp.on('console', mm => { if (mm.type() === 'error' && !/favicon/.test(mm.text())) mErrs.push('CONSOLE: ' + mm.text()); });

    await mp.goto(BASE, { waitUntil: 'domcontentloaded' });
    await mp.waitForSelector('#spName');

    // 批次9：落地页是 position:fixed + 自身 overflow:auto 的滚动容器。
    // 用 align-items:center 居中时，内容一旦高过视口，顶部会被推到 overflow 区
    // **且滚不回来** —— 品牌和主张整段消失（实测 320×568 下 top = -132px）。
    // 判据：把 .land 滚到 0 之后抬头还在可视区内。
    const landTop = await mp.evaluate(() => {
      const land = document.querySelector('#land');
      const col = document.querySelector('.land-col');
      land.scrollTop = 0;
      return Math.round(col.getBoundingClientRect().top);
    });
    ok(vp.tag + ' ★ 落地页顶部可达（抬头不被裁）', landTop >= 0, 'top=' + landTop);
    ok(vp.tag + ' ★ 落地页三个 tab 都是单行（不折成两行胶囊）',
      await mp.evaluate(() => {
        const hs = Array.from(document.querySelectorAll('.land-tab')).map(t => Math.round(t.getBoundingClientRect().height));
        return hs.every(h => h === hs[0]) && hs[0] <= 44;
      }), await mp.evaluate(() => Array.from(document.querySelectorAll('.land-tab')).map(t => Math.round(t.getBoundingClientRect().height)).join('/')));
    ok(vp.tag + ' 落地页页脚合规入口可见',
      await mp.evaluate(() => {
        const el = document.querySelector('.land-legal');
        if (!el) return false;
        const r = el.getBoundingClientRect();
        return r.height > 0 && r.width > 0;
      }));

    await mp.fill('#spName', '移动端' + Math.floor(Math.random() * 9000 + 1000));
    await mp.click('#spCreate');
    await mp.waitForSelector('#app', { state: 'visible', timeout: 10000 });
    await mp.waitForTimeout(900);

    const sideLeft = () => mp.evaluate(() => Math.round(document.querySelector('.side').getBoundingClientRect().left));
    const hamb = mp.locator('.view:not([hidden]) .hamb').first();

    // —— 抽屉开合 ——
    // 侧栏是 280px 的浮层，打开后正好盖住汉堡按钮本身。
    // 如果只能靠汉堡切换，用户就会"点得到开、点不到关" —— 所以必须有可点的遮罩。
    ok(vp.tag + ' 侧栏初始收起', (await sideLeft()) < 0, 'left=' + (await sideLeft()));
    await hamb.click();
    await mp.waitForTimeout(420);
    ok(vp.tag + ' 点汉堡能拉开侧栏', (await sideLeft()) >= 0, 'left=' + (await sideLeft()));
    const maskPe = await mp.evaluate(() => {
      const el = document.querySelector('#sideMask');
      return el ? getComputedStyle(el).pointerEvents : null;
    });
    ok(vp.tag + ' 侧栏打开时遮罩可点', maskPe === 'auto', 'pointer-events=' + maskPe);
    // 遮罩是 inset:0 全屏的，左边 280px 被侧栏压着 —— 点右边没被盖住的地方
    await mp.click('#sideMask', { position: { x: vp.w - 40, y: 300 } });
    await mp.waitForTimeout(450);
    ok(vp.tag + ' 点遮罩能收起侧栏', (await sideLeft()) < 0, 'left=' + (await sideLeft()));

    // —— 对话页 ——
    const chatOver = await mp.evaluate(overflowProbe, vp.w);
    ok(vp.tag + ' 对话页无元素横向溢出', chatOver.length === 0, JSON.stringify(chatOver));
    const chatTbH = await mp.evaluate(() => Math.round(document.querySelector('#view-chat .topbar').getBoundingClientRect().height));
    ok(vp.tag + ' 对话页顶栏没被撑高（≤130px）', chatTbH <= 130, chatTbH + 'px');
    const txtH = await mp.evaluate(() => Math.round(document.querySelector('#view-chat .tb-txt').getBoundingClientRect().height));
    ok(vp.tag + ' 标题区没被压成竖排（≤60px）', txtH <= 60, txtH + 'px');
    const txtW = await mp.evaluate(() => Math.round(document.querySelector('#view-chat .tb-txt').getBoundingClientRect().width));
    ok(vp.tag + ' 标题区仍有可用宽度（≥120px）', txtW >= 120, txtW + 'px');
    ok(vp.tag + ' 汉堡按钮可见', await hamb.isVisible());
    ok(vp.tag + ' 次级控件组独占一行且在视口内', await mp.evaluate(() => {
      const t = document.querySelector('#view-chat .tb-tools');
      if (!t) return false;
      const r = t.getBoundingClientRect();
      return r.right <= window.innerWidth + 1 && r.width > window.innerWidth * 0.8;
    }));

    // —— 知识库页 + 子面板 ——
    await hamb.click();
    await mp.waitForTimeout(420);
    await mp.click('.nav-i[data-view="kb"]');
    await mp.waitForTimeout(700);
    const kbOver = await mp.evaluate(overflowProbe, vp.w);
    ok(vp.tag + ' 知识库页无元素横向溢出', kbOver.length === 0, JSON.stringify(kbOver));
    const kbTbH = await mp.evaluate(() => Math.round(document.querySelector('#view-kb > .topbar').getBoundingClientRect().height));
    ok(vp.tag + ' 知识库顶栏 ≤130px（搜索框单独一行，不挤头像）', kbTbH <= 130, kbTbH + 'px');

    await mp.click('#kbTabs .kb-tab[data-sub="projects"]').catch(() => {});
    await mp.waitForTimeout(600);
    const subOver = await mp.evaluate(overflowProbe, vp.w);
    ok(vp.tag + ' 项目子面板无元素横向溢出', subOver.length === 0, JSON.stringify(subOver));

    ok(vp.tag + ' 移动端无 JS 异常', mErrs.length === 0, mErrs.slice(0, 3).join(' | '));
    await mp.screenshot({ path: path.join(SHOTS, '06-mobile-' + vp.w + '.png') });
    await mc.close();
  }

  // ---------- 13.5 项目里「＋」新建对话必须归入该项目 ----------
  // 会话是**服务端**在收到第一条消息时才建的（/api/chat/stream → createConversation）。
  // 前端 send() 的请求体一旦漏传 projectId，会话就 project_id=NULL 掉进「未归入项目」——
  // 界面看着完全正常，只有归组悄悄错了，所以这条必须在真实点击流里钉死。
  group('13.5 ★ 项目里「＋」新建对话必须归入该项目');
  const gpName = '归组验证项目' + Date.now().toString(36);
  const gpId = await page.evaluate(async (name) => {
    const H = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + localStorage.getItem('hl_token') };
    await fetch('/api/projects', { method: 'POST', headers: H, body: JSON.stringify({ name: name }) });
    const list = await fetch('/api/projects', { headers: H }).then(x => x.json());
    const p = (list.projects || []).filter(x => x.name === name)[0];
    return p ? p.id : null;
  }, gpName);
  ok('E2E 项目已建', !!gpId, gpId);
  if (gpId) {
    await page.reload({ waitUntil: 'networkidle' });   // 让左栏重画项目树
    await page.waitForFunction(() => { const a = document.querySelector('#app'); return a && !a.hidden; }, null, { timeout: 20000 });
    await page.waitForSelector('.side-p[data-proj="' + gpId + '"]', { timeout: 10000 });
    const beforeRows = await page.locator('.side-p[data-proj="' + gpId + '"] .conv-i').count();
    const beforeNone = await page.locator('.side-p[data-proj="__none__"] .conv-i').count();
    ok('项目下原本 0 条对话', beforeRows === 0, beforeRows);

    await page.click('.side-p[data-proj="' + gpId + '"] .sp-add');
    await page.waitForTimeout(250);
    ok('提示会归入该项目', (await page.locator('#convSubText').innerText()).indexOf(gpName) >= 0,
      await page.locator('#convSubText').innerText());

    await page.fill('#input', '第一条消息');
    // 上一轮流还没结束时 send() 会直接 return（S.streaming），点了也不发。
    await page.waitForFunction(() => {
      const b = document.querySelector('#send');
      return !!b && !b.disabled;
    }, null, { timeout: 60000 }).catch(() => {});
    await page.click('#send');

    // ★ 行一出现，就把它**当时**的"是否还在流式"一起带回来。
    //   两个状态在同一次求值里读，不会因为两次 await 之间流结束了而错位。
    //
    //   为什么要断言这个：会话是服务端在收到首条消息时创建的，前端在 SSE 的 `meta`
    //   事件里才第一次知道 convId。早先那里只记 convId、不刷左栏，左栏要等
    //   `finally` 的 loadSide() —— 也就是**整段回答流完之后** —— 才出现这条对话。
    //   实测 mock 模型下要 14–16 秒，真模型更久：用户发完消息盯着左栏十几秒，
    //   会以为"没建上"。现在 meta 里就刷（只在新建会话时，不多发请求）。
    const appeared = await page.waitForFunction(gid => {
      const box = document.querySelector('#convList');
      if (!box) return null;
      const n = box.querySelectorAll('.side-p[data-proj="' + gid + '"] .conv-i').length;
      if (!n) return null;
      const b = document.querySelector('#send');
      return { n: n, streaming: !!(b && b.disabled) };
    }, gpId, { timeout: 40000 }).then(h => h.jsonValue()).catch(() => null);

    ok('★ 对话落在这个项目下', !!appeared && appeared.n === 1, JSON.stringify(appeared));
    ok('★ 它在回答还没流完时就出现在左栏（不是等 finally 才刷）',
      !!appeared && appeared.streaming === true, JSON.stringify(appeared));
    const afterNone = await page.locator('.side-p[data-proj="__none__"] .conv-i').count();
    ok('★ 「未归入项目」没有多出对话', afterNone === beforeNone, { 前: beforeNone, 后: afterNone });
    const cnt = (await page.locator('.side-p[data-proj="' + gpId + '"] .sp-c').innerText()).trim();
    ok('★ 项目计数 = 1', cnt === '1', cnt);

    const newestPid = await page.evaluate(async () => {
      const H = { 'Authorization': 'Bearer ' + localStorage.getItem('hl_token') };
      const cs = (await fetch('/api/conversations', { headers: H }).then(x => x.json())).conversations || [];
      return cs.length ? cs[0].projectId : undefined;
    });
    ok('★ 服务端：最新会话的 projectId 指向该项目', newestPid === gpId, newestPid);
    await page.screenshot({ path: path.join(SHOTS, '13-项目归组.png') });
  }

  // ---------- 14. 控制台干净度 ----------
  group('14. 控制台干净度');
  const realErrors = errors.filter(e => !/favicon|Failed to load resource: the server responded with a status of 40/.test(e));
  ok('整个过程没有 JS 报错', realErrors.length === 0, realErrors.slice(0, 4).join(' | '));

  await ctx.close();
  await browser.close();

  console.log('\n' + '─'.repeat(58));
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  if (fail) { console.log('\n失败明细：'); failures.forEach(f => console.log('  · ' + f)); }
  console.log('\n截图：' + SHOTS);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('\n冒烟脚本自身异常：', e); process.exit(2); });

'use strict';
/**
 * 线上实例验证（发布后必跑）
 *
 * 为什么不能只"打开首页看一眼"：
 *   1. **静态 HTML 会被浏览器/CDN 缓存** —— 「页面能打开」≠「后端还活着」。
 *      所以每个静态断言都带 cache-buster，且必须探 `/api/*`。
 *   2. **`.env` 没被读到，服务照样启动、本地测试照样全绿**，只有线上的
 *      `/api/health.mockLLM` 会露馅（发布工具不能传环境变量，模型 Key 只能
 *      靠项目里的 `.env` 随代码一起上传）。⇒ `mockLLM === false` 是硬判据。
 *   3. **发布会产生新链接、旧链接立刻变死沙箱**，所以必须拿新 URL 真跑一遍，
 *      而不是假定"和上次一样"。
 *
 * 跑法：
 *   node _livecheck.cjs https://xxx.sg.agentos-app.run
 *   node _livecheck.cjs https://xxx.sg.agentos-app.run --expect 2026-10-01-parity7b
 *
 * 退出码：全绿 0，有失败 1。
 */
// ★ 只卡"形状"（YYYY-MM-DD-<标签>），不卡具体日期、**也不卡标签名**。
//   日期写死 ⇒ 跨天 bump 必假红；标签写死 ⇒ 标签从 parityN 改成功能名
//   （如 admin-dash8）时又假红一遍。要核对具体版本用 --expect 传精确值。
const EXPECT_PREFIX = /^\d{4}-\d{2}-\d{2}-[A-Za-z][\w.-]*$/;

const argv = process.argv.slice(2);
const base = (argv.find(a => /^https?:\/\//.test(a)) || '').replace(/\/+$/, '');
const expectIdx = argv.indexOf('--expect');
const expectExact = expectIdx >= 0 ? argv[expectIdx + 1] : null;

if (!base) {
  console.error('用法：node _livecheck.cjs <baseUrl> [--expect <version>]');
  process.exit(2);
}

let pass = 0, fail = 0;
const fails = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  \u2713 ' + name); }
  else { fail++; fails.push(name + (extra !== undefined ? '  → ' + (typeof extra === 'string' ? extra : JSON.stringify(extra)) : '')); console.log('  \u2717 ' + name + (extra !== undefined ? '  → ' + (typeof extra === 'string' ? extra : JSON.stringify(extra)) : '')); }
}
function group(t) { console.log('\n' + t); }

/** 静态资源一律绕开缓存：线上是反代 + 浏览器双层缓存，不绕会验到上一版 */
function bust(u) { return u + (u.indexOf('?') >= 0 ? '&' : '?') + '_cb=' + Date.now(); }

async function getText(url) {
  const r = await fetch(bust(url), { headers: { 'Cache-Control': 'no-cache', 'Pragma': 'no-cache' } });
  return { status: r.status, body: await r.text() };
}
async function getJSON(url, token) {
  const h = { 'Cache-Control': 'no-cache' };
  if (token) h.Authorization = 'Bearer ' + token;
  const r = await fetch(bust(url), { headers: h });
  let j = null;
  try { j = await r.json(); } catch (e) {}
  return { status: r.status, json: j };
}

(async () => {
  console.log('线上验证：' + base);
  console.log('  预期版本：形如 YYYY-MM-DD-<标签>' + (expectExact ? '，精确 ' + expectExact : ''));

  // ---------- 1. 后端真的活着，且 .env 被读到了 ----------
  group('1. 后端与 .env');
  let health = null;
  try {
    const r = await getJSON(base + '/api/health');
    health = r.json;
    ok('/api/health 返回 200', r.status === 200, 'HTTP ' + r.status);
  } catch (e) {
    ok('/api/health 可达', false, e.message);
  }
  if (health) {
    ok('ok = true', health.ok === true, JSON.stringify(health).slice(0, 120));
    const v = String(health.version || '');
    ok('版本形如 YYYY-MM-DD-<标签>（不写死日期与标签名）', EXPECT_PREFIX.test(v), v);
    if (expectExact) ok('版本精确等于 ' + expectExact, v === expectExact, v);
    // ★ 这条是"上传的 .env 生效了"的唯一判据。mockLLM=true 说明线上在跑假模型，
    //   而服务本身、页面、测试全都会是绿的 —— 只在这里露馅。
    ok('★ mockLLM = false（线上读到了 .env 里的真模型 Key）', health.mockLLM === false,
      'mockLLM=' + health.mockLLM + '（true 表示 .env 没上传或加载器位置不对）');
    ok('apis 清单齐全（≥25 个）', Array.isArray(health.apis) && health.apis.length >= 25,
      Array.isArray(health.apis) ? health.apis.length + ' 个' : typeof health.apis);
  }

  // ---------- 2. 前端资源是新构建 ----------
  group('2. 前端是新构建');
  const idx = await getText(base + '/');
  ok('首页 200', idx.status === 200, 'HTTP ' + idx.status);
  ok('首页含 tb-tools（批次7.1 顶栏分组）', idx.body.indexOf('tb-tools') >= 0);
  ok('首页含 sideMask（批次7.1 抽屉遮罩）', idx.body.indexOf('sideMask') >= 0);
  ok('首页含品牌主张「自学立身，创造立世」', idx.body.indexOf('自学立身，创造立世') >= 0);
  ok('首页不再有旧入口 #newConv', idx.body.indexOf('id="newConv"') < 0);

  const js = await getText(base + '/js/app.js');
  ok('app.js 200', js.status === 200, 'HTTP ' + js.status);
  ok('app.js 含 renderSideTree（左栏项目树）', js.body.indexOf('renderSideTree') >= 0);
  ok('app.js 含 isUnlocked（宠物阶段门控）', js.body.indexOf('isUnlocked') >= 0);
  ok('app.js 含 #sideMask 点击关闭', /#sideMask'\)\.addEventListener\('click'/.test(js.body));
  ok('app.js 不再有 renderConvList', js.body.indexOf('renderConvList') < 0);

  const css = await getText(base + '/app.css');
  ok('app.css 200', css.status === 200, 'HTTP ' + css.status);
  ok('app.css 含 .tb-tools { display: contents }', css.body.indexOf('.tb-tools { display: contents; }') >= 0);
  ok('app.css 含 .side-mask { display: none; }', css.body.indexOf('.side-mask { display: none; }') >= 0);
  ok('app.css 含 900px 顶栏断点', css.body.indexOf('max-width: 900px') >= 0);
  ok('app.css 副标题已改单行省略（不再 flex-wrap: wrap）',
    /\.tb-txt \.s \{[^}]*white-space: nowrap/.test(css.body) &&
    !/\.tb-txt \.s \{[^}]*flex-wrap: wrap/.test(css.body));

  // ---------- 3. 真跑一遍接口（不只是静态资源）----------
  group('3. 接口真跑一遍');
  const name = '线上验证' + Math.floor(Math.random() * 900000 + 100000);
  let token = null, spaceId = null;
  try {
    const r = await fetch(base + '/api/space', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name, passcode: '' }),
    });
    const j = await r.json();
    ok('POST /api/space 建空间成功', r.status === 200 && j.ok === true,
      'HTTP ' + r.status + ' ' + JSON.stringify(j).slice(0, 120));
    token = j.token; spaceId = j.spaceId;
  } catch (e) {
    ok('POST /api/space 可达', false, e.message);
  }

  if (token) {
    const pet = await getJSON(base + '/api/pet', token);
    ok('GET /api/pet 200', pet.status === 200, 'HTTP ' + pet.status);
    if (pet.json && pet.json.ok) {
      const u = pet.json.unlocks;
      ok('宠物解锁表随 /api/pet 一起返回（批次7）', !!u, JSON.stringify(pet.json).slice(0, 120));
      if (u) {
        ok('新空间 stage = 1（嫩芽）', u.stage === 1, 'stage=' + u.stage);
        ok('新空间解锁 7 项（对话/项目/资料/知识卡/看板/家长视角；批次28 加「班级」）', u.unlocked.length === 7, JSON.stringify(u.unlocked));
        ok('新空间就含看板（学习日报在阶段1，批次10 从阶段5 提上来的）',
          u.unlocked.indexOf('dash') >= 0, JSON.stringify(u.unlocked));
        ok('新空间不含 skills（阶段2 才给）', u.unlocked.indexOf('skills') < 0, JSON.stringify(u.unlocked));
        ok('next 指向幼苗、还差 30 点', u.next && u.next.name === '幼苗' && u.next.toNext === 30,
          JSON.stringify(u.next));
      }
    } else {
      ok('GET /api/pet 返回 ok', false, JSON.stringify(pet.json).slice(0, 120));
    }

    const pr = await getJSON(base + '/api/projects', token);
    ok('GET /api/projects 200 且 ok', pr.status === 200 && pr.json && pr.json.ok === true,
      'HTTP ' + pr.status);

    const cv = await getJSON(base + '/api/conversations', token);
    ok('GET /api/conversations 200 且 ok', cv.status === 200 && cv.json && cv.json.ok === true,
      'HTTP ' + cv.status);
  }

  // ---------- 4. 过期页面守卫的判据仍然成立 ----------
  group('4. 过期页面守卫');
  // 注意：未知的 /api/* 会**先被鉴权拦下**（401），走不到 404 —— 所以判据不能写死 404。
  // 真正要守的是前端的 checkAlive()：本服务的错误响应一定带 error 字段，
  // 没有 error 的响应（比如反代吐的 HTML 错误页）才被判为"页面过期"。
  const bad = await getJSON(base + '/api/__not_exist__');
  ok('未知接口不是 200（没被误当成正常响应）', bad.status !== 200, 'HTTP ' + bad.status);
  ok('错误响应带 error 字段（前端的过期页面判据）',
    bad.json && typeof bad.json.error === 'string', JSON.stringify(bad.json).slice(0, 120));
  // 静态资源不存在时也要带 error，否则前端会误判成"页面过期"
  const badStatic = await getJSON(base + '/__not_exist__.json');
  ok('不存在的静态资源也带 error 字段',
    badStatic.json && typeof badStatic.json.error === 'string',
    'HTTP ' + badStatic.status + ' ' + JSON.stringify(badStatic.json).slice(0, 100));

  console.log('\n' + '-'.repeat(58));
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  if (fail) { console.log('\n失败明细：'); fails.forEach(f => console.log('  · ' + f)); }
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('脚本自身异常：' + e.message + '\n' + e.stack); process.exit(2); });

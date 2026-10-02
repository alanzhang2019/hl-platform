'use strict';
/**
 * 批次20 端到端自检（HTTP）：家长端 `GET /api/parent`
 *
 * 模块级套件（`_parity20check.cjs`）已经把**算法**测透了。这一套测的是
 * **只有真起服务才暴露得出来的东西** —— 模块级套件全绿但线上不能用，通常是这四种：
 *
 *   1. **路由没接上 / 路径拼错** —— 模块函数好好的，用户点进去 404。
 *   2. **鉴权没生效** —— 该带 token 的地方不带，或者老师的边界没设。
 *   3. **错误码在 HTTP 层被吃掉** —— 模块抛 `range_too_long`，路由却统一回 500，
 *      前端就没法据此提示"把范围收窄一点"。
 *   4. **跨空间泄露只在真实空间隔离下才成立** —— 模块级用的是手插数据，
 *      这里用**两个真实空间的 token** 互相探。
 *
 * 跑法：node _parenthttp.cjs
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const NODE = process.execPath;
const PORT = 3600 + Math.floor(Math.random() * 300);
const BASE = 'http://127.0.0.1:' + PORT;
const DATA_DIR = path.join(os.tmpdir(), 'hl-parent-http-' + crypto.randomBytes(4).toString('hex'));

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  \u2713 ' + name); }
  else { fail++; failures.push(name + (extra !== undefined ? ' → ' + JSON.stringify(extra) : '')); console.log('  \u2717 ' + name + (extra !== undefined ? ' → ' + JSON.stringify(extra) : '')); }
}
function eq(name, got, want) { ok(name, JSON.stringify(got) === JSON.stringify(want), 'got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want)); }
function group(t) { console.log('\n' + t); }

async function req(method, p, body, token) {
  const h = { 'Content-Type': 'application/json' };
  if (token) h.Authorization = 'Bearer ' + token;
  const r = await fetch(BASE + p, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  let j = null;
  try { j = await r.json(); } catch (e) { j = null; }
  return { status: r.status, body: j };
}
const GET = (p, t) => req('GET', p, undefined, t);
const POST = (p, b, t) => req('POST', p, b, t);

function startServer() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  return spawn(NODE, ['server.js'], {
    cwd: __dirname,
    // NO_DOTENV=1：不读本机 .env（否则本机改了配置就换一种行为，变成假失败）
    env: Object.assign({}, process.env, {
      PORT: String(PORT), DATA_DIR, NO_DOTENV: '1',
      ADMIN_PASSWORD: 'test-admin-pw', LLM_API_KEY: '',
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}
async function waitReady(ms) {
  // ★ 60 秒：本机 C 盘紧张，`node server.js` 光 SQLite 初始化就可能十几秒。
  //   12 秒会把"机器慢"报成"服务坏了"，而且报的是与业务无关的一条。
  const until = Date.now() + (ms || 60000);
  while (Date.now() < until) {
    try { const r = await fetch(BASE + '/api/health'); if (r.ok) return await r.json(); } catch (e) {}
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error('服务在超时前没有就绪');
}
function stopServer(child) {
  return new Promise(res => {
    child.once('exit', res);
    try { child.kill('SIGKILL'); } catch (e) { res(); }
    setTimeout(res, 2500);
  });
}

function dayOff(n) {
  const d = new Date(Date.now() + n * 86400000);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

// ================= 主流程 =================
(async () => {
  const child = startServer();
  let health;
  try { health = await waitReady(); }
  catch (e) { console.error(e.message); child.kill('SIGKILL'); process.exit(1); }

  console.log('家长端 · 端到端自检');
  console.log('  服务 ' + BASE + '   数据目录 ' + DATA_DIR);

  try {
    // ---------- 1. 健康检查把 parent 报出来 ----------
    group('1. 健康检查与接口发现');
    ok('health.ok', health.ok === true);
    ok('★ apis 清单里有 parent（前端据此判断后端版本，缺了会被当成"页面过期"）',
      (health.apis || []).indexOf('parent') >= 0, health.apis);
    ok('版本是带日期的串（不写死小版本，避免"改个版本就得改测试"）',
      /^\d{4}-\d{2}-\d{2}-/.test(String(health.version)), health.version);

    // ---------- 2. 建两个真实空间 ----------
    group('2. 建两个真实空间（用于隔离验证）');
    const a = await POST('/api/space', { name: '家长测试甲', passcode: '' });
    eq('甲空间创建成功', a.status, 200);
    const tokA = a.body.token;
    ok('甲空间拿到 token', !!tokA, typeof tokA);

    const b = await POST('/api/space', { name: '家长测试乙', passcode: '' });
    eq('乙空间创建成功', b.status, 200);
    const tokB = b.body.token;
    ok('乙空间拿到 token', !!tokB, typeof tokB);

    // ---------- 3. 鉴权 ----------
    group('3. 鉴权（家长端不是公开接口）');
    const noTok = await GET('/api/parent?from=' + dayOff(-6) + '&to=' + dayOff(0));
    ok('不带 token 拿不到（不是 200）', noTok.status !== 200, noTok.status);
    const badTok = await GET('/api/parent?from=' + dayOff(-6) + '&to=' + dayOff(0), 'garbage-token');
    ok('假 token 拿不到（不是 200）', badTok.status !== 200, badTok.status);

    // ---------- 4. 空空间：算不出来就说算不出来 ----------
    group('4. 空空间：不补零（规矩②）');
    const empty = await GET('/api/parent?from=' + dayOff(-6) + '&to=' + dayOff(0), tokA);
    eq('空空间返回 200', empty.status, 200);
    ok('返回体有 view', !!empty.body.view, Object.keys(empty.body || {}));
    const ev = empty.body.view;
    eq('★ 空空间 accuracy 是 null 而不是 0', ev.movement.accuracy, null);
    eq('★ 空空间 gapDays 是 null 而不是 0', ev.rhythm.gapDays, null);
    eq('空空间 advanced 是 null', ev.movement.advanced, null);
    ok('accuracy 为 null 时带说明文案',
      typeof ev.movement.accuracyUnknown === 'string' && ev.movement.accuracyUnknown.length > 0,
      ev.movement.accuracyUnknown);
    ok('空空间 headline 是 quiet', ev.headline.tone === 'quiet', ev.headline.tone);
    ok('空空间不能凭空造出 helpPoints', Array.isArray(ev.helpPoints) && ev.helpPoints.length === 0, ev.helpPoints);
    ok('空空间不能凭空造出 notes', Array.isArray(ev.notes) && ev.notes.length === 0, ev.notes);
    ok('★ 空空间也给出"答不了的三件事"（不是空白页）',
      Array.isArray(ev.cannotSay) && ev.cannotSay.length === 3, ev.cannotSay && ev.cannotSay.length);
    ok('★ 空空间也给出隐私边界说明', !!ev.privacy && ev.privacy.notShown.length > 0, ev.privacy);

    // ---------- 5. 造真实学习痕迹 ----------
    group('5. 造学习痕迹（走真实接口，不手插库）');
    // 走 /api/chat 会产生 activity；但代价高且依赖模型。
    // 这里改为走**知识卡**接口建卡 —— 它是一条纯本地的写路径。
    const card1 = await POST('/api/cards', {
      knowledge: '一元二次方程的判别式', question: '判别式是什么？', answer: 'b²-4ac',
      type: 'choice', subject: 'math', options: ['b²-4ac', 'b²+4ac'],
    }, tokA);
    ok('建卡接口可用（否则后面的断言无从谈起）', card1.status === 200, card1.body);
    const cardId1 = card1.body && (card1.body.card && card1.body.card.id || card1.body.id);

    if (cardId1) {
      // 复习并答对 → 产生 card_reviews
      const rev = await POST('/api/cards/' + cardId1 + '/review', { result: 'right', studentAnswer: 'b²-4ac' }, tokA);
      ok('复习接口可用', rev.status === 200, rev.body);
    }

    const filled = await GET('/api/parent?from=' + dayOff(-6) + '&to=' + dayOff(0), tokA);
    eq('有数据后仍返回 200', filled.status, 200);
    const fv = filled.body.view;
    ok('★ 有痕迹后 rhythm.activeDays ≥ 1', fv.rhythm.activeDays >= 1, fv.rhythm.activeDays);
    eq('★ 有痕迹后 gapDays 是 0（今天就在）而不是 null', fv.rhythm.gapDays, 0);
    ok('headline 不再是 quiet', fv.headline.tone !== 'quiet', fv.headline.tone);
    ok('headline 三件套齐全',
      !!(fv.headline.text && fv.headline.plain && fv.headline.action), fv.headline);
    // ★ 判得出对错的练习只有 1 次且答对了 ⇒ accuracy 应该是 100，不是 null
    ok('★ 有可判练习后 accuracy 不再是 null', fv.movement.accuracy !== null, fv.movement.accuracy);
    ok('accuracy 为 100（1 次判得出对错，答对）', fv.movement.accuracy === 100, fv.movement.accuracy);
    eq('accuracy 有值时 accuracyUnknown 是 null', fv.movement.accuracyUnknown, null);
    ok('reviewed 过的卡被算进 touched', fv.movement.touched >= 1, fv.movement.touched);
    // ★ 前端要显示"对 N / 错 M"，缺字段会算出 NaN 并**印在界面上**（实测印过）
    ok('★ movement.right/wrong/unknown 都是数字（缺一个前端就印 NaN）',
      typeof fv.movement.right === 'number' &&
      typeof fv.movement.wrong === 'number' &&
      typeof fv.movement.unknown === 'number',
      { r: fv.movement.right, w: fv.movement.wrong, u: fv.movement.unknown });
    ok('right + wrong + unknown === reviews（分类不重不漏）',
      fv.movement.right + fv.movement.wrong + fv.movement.unknown === fv.movement.reviews,
      { r: fv.movement.right, w: fv.movement.wrong, u: fv.movement.unknown, all: fv.movement.reviews });

    // ---------- 6. 跨空间隔离（真 token 互相探）----------
    group('6. 跨空间隔离（真 token）');
    const other = await GET('/api/parent?from=' + dayOff(-6) + '&to=' + dayOff(0), tokB);
    eq('乙空间也能拿到（说明不是 403 类的权限坑）', other.status, 200);
    const ov = other.body.view;
    eq('★ 乙空间看不到甲的记录（activeDays = 0）', ov.rhythm.activeDays, 0);
    eq('★ 乙空间看不到甲的复习（reviews = 0）', ov.movement.reviews, 0);
    eq('★ 乙空间看不到甲的卡（touched = 0）', ov.movement.touched, 0);
    eq('★ 乙空间 accuracy 仍是 null（没被甲的数据带飞）', ov.movement.accuracy, null);
    eq('★ 乙空间现在没有（cards = 0）', ov.now.cards, 0);
    ok('★ 乙空间 helpPoints 是空的（没串到甲的错题）', ov.helpPoints.length === 0, ov.helpPoints);

    // ---------- 7. 错误码必须在 HTTP 层透出去 ----------
    group('7. 错误码在 HTTP 层可见（前端要靠它给提示）');
    const badDate = await GET('/api/parent?from=notadate&to=' + dayOff(0), tokA);
    eq('非法日期 → 400', badDate.status, 400);
    eq('★ 错误码是 invalid_range（不是笼统 BAD_INPUT）', badDate.body.error, 'invalid_range');
    ok('带一句人话 message', typeof badDate.body.message === 'string' && badDate.body.message.length > 0,
      badDate.body.message);

    const tooLong = await GET('/api/parent?from=' + dayOff(-40) + '&to=' + dayOff(0), tokA);
    eq('超过 31 天 → 400', tooLong.status, 400);
    eq('★ 错误码是 range_too_long', tooLong.body.error, 'range_too_long');

    const reversed = await GET('/api/parent?from=' + dayOff(0) + '&to=' + dayOff(-5), tokA);
    eq('结束早于开始 → 400', reversed.status, 400);
    eq('错误码是 invalid_range', reversed.body.error, 'invalid_range');

    const missing = await GET('/api/parent', tokA);
    eq('完全不传日期 → 400（不是 200 也不是 500）', missing.status, 400);
    eq('错误码是 invalid_range', missing.body.error, 'invalid_range');

    // ---------- 8. 边界值：31 天能过、32 天不能 ----------
    group('8. 边界值 31/32 天');
    const d31 = await GET('/api/parent?from=' + dayOff(-30) + '&to=' + dayOff(0), tokA);
    eq('31 天 → 200', d31.status, 200);
    eq('range.days 报 31', d31.body.view.range.days, 31);
    eq('totalDays 也报 31', d31.body.view.rhythm.totalDays, 31);
    const d32 = await GET('/api/parent?from=' + dayOff(-31) + '&to=' + dayOff(0), tokA);
    eq('32 天 → 400', d32.status, 400);
    eq('错误码 range_too_long', d32.body.error, 'range_too_long');

    // ---------- 9. 隐私边界（不该有的字段一个都不能有）----------
    group('9. 隐私：返回体里不许出现这些字段');
    const raw = JSON.stringify(filled.body);
    // ★ 这几样是**刻意的功能缺失**（见 parent.js 文件头第 5 条）：
    //   一旦有人"顺手"加进来，孩子就会开始写"家长想看的"而不是自己真想的。
    ['studentAnswer', 'student_answer', 'verdict_json', 'ai_verdict', 'translated_json']
      .forEach(k => {
        ok('返回体不含「' + k + '」', raw.indexOf('"' + k + '"') < 0, k);
      });
    // 对话/消息原文类字段
    ok('返回体不含 messages 数组', raw.indexOf('"messages"') < 0, null);
    ok('返回体不含 conversation 字段', raw.indexOf('"conversation"') < 0, null);
    ok('★ 明说看不到对话原文、写错的答案、未定稿日报',
      fv.privacy.notShown.length >= 3 &&
      fv.privacy.notShown.join('|').indexOf('对话原文') >= 0 &&
      fv.privacy.notShown.join('|').indexOf('写错') >= 0,
      fv.privacy.notShown);
    ok('★ 解释了"为什么不给"（不只是声明不给）',
      typeof fv.privacy.why === 'string' && fv.privacy.why.length > 20, fv.privacy.why);

    // ---------- 10. 串行稳定性（连打 5 次结果一致）----------
    group('10. 连打 5 次结果一致（无随机性 / 无状态污染）');
    const seen = [];
    for (let i = 0; i < 5; i++) {
      const r = await GET('/api/parent?from=' + dayOff(-6) + '&to=' + dayOff(0), tokA);
      seen.push(JSON.stringify({ r: r.body.view.rhythm, m: r.body.view.movement }));
    }
    ok('★ 5 次结果完全一致（家长端不该有随机波动）',
      seen.every(s => s === seen[0]), seen.length);

  } finally {
    await stopServer(child);
    try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch (e) {}
  }

  console.log('\n' + '─'.repeat(60));
  if (fail) {
    console.log('✗ 失败 ' + fail + ' 项：');
    failures.forEach(f => console.log('   · ' + f));
  } else {
    console.log('✓ 全部通过');
  }
  // ★ 摘要行格式**必须**是「通过 N 项，失败 M 项」——
  //   `_run-tests.cjs` 用 `/通过 (\d+) 项，失败 (\d+) 项/` 抓这个数。
  //   写成「通过 N / 失败 M」会被判成"摘要行没打出来"，
  //   于是无论套件是不是全绿，汇总里都显示 **0 项通过**（症状：✓ 0 项通过）。
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  process.exit(fail ? 1 : 0);
})();

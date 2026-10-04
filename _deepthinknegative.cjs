'use strict';
/**
 * 深度思考开关 · 反证（把关键实现逐个改回坏版本，确认自检真的变红）。
 *
 * ★★ 两条硬教训（本项目实测踩过，写在这里免得后人重踩）：
 *   ① **开局快照，还原一律从快照写回** —— 别每轮现读。
 *      现读会把别处改过的内容当成"原文"写回去，把源码永久写坏。
 *   ② **加锁禁止并发** —— 两份实例同时"改写→还原"会把源码写坏：
 *      A 改成坏版本 → B 读到坏版本当原文 → B 还原时把坏版本写成原文。
 *   ③ 跑完校验"还原后与快照逐字节一致"，不一致就报出来。
 *
 * ★ 反证必须让**对应的正证**变红。每处改完要先确认"变异真的生效了"
 *   （源文件和补丁对不上 = 等于没测，本项目踩过这个坑）。
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = __dirname;
const LOCK = path.join(ROOT, '.deepthinknegative.lock');
const FILES = ['server.js', 'server/core.js', 'server/db.js', 'public/js/app.js', 'public/index.html']
  .map(f => path.join(ROOT, f));

// ---------- ① 开局快照 ----------
const SNAPSHOT = new Map();
for (const f of FILES) SNAPSHOT.set(f, fs.readFileSync(f, 'utf8'));

// ---------- ② 加锁 ----------
try {
  fs.writeFileSync(LOCK, String(process.pid), { flag: 'wx' });
} catch (e) {
  console.error('另一个反证实例正在运行（锁文件 ' + LOCK + '）。反证套件禁止并发 ——');
  console.error('两份同时改写源码会把源码永久写坏（本项目实测踩过）。');
  process.exit(2);
}
let unlocked = false;
function unlock() {
  if (unlocked) return;
  unlocked = true;
  try { fs.unlinkSync(LOCK); } catch (e) {}
}
function restoreAll() {
  for (const f of FILES) fs.writeFileSync(f, SNAPSHOT.get(f));
}
process.on('exit', () => { restoreAll(); unlock(); });
process.on('SIGINT', () => { restoreAll(); unlock(); process.exit(130); });

function runCheck() {
  let out = '', err = '', code = 0;
  try {
    out = execFileSync(process.execPath, [path.join(ROOT, '_deepthinkcheck.cjs')], {
      encoding: 'utf8', cwd: ROOT,
    });
  } catch (e) {
    out = String(e.stdout || '');
    err = String(e.stderr || '');
    code = e.status;
    // ★★ 关键保护：子进程**没能正常启动**（沙箱拦截 / 语法错 / 路径错）时，
    //    e.status 是 null 且 stdout 为空。这种情况绝不能当成"咬住了" ——
    //    那会让 11/11 全部**假绿**（本项目实测踩过：本机沙箱会拦 execFileSync
    //    起的 node 子进程，表现为 status=null、输出全空）。
    if (code === null && !out) {
      throw new Error('自检子进程未能启动（可能被沙箱拦截）：' + (err || '(无 stderr)'));
    }
    return { red: true, out: out + err };
  }
  return { red: false, out };
}

// ★ 先做一次"基线自检"：现在文件是好的，必须**全绿**。
//   若这里就红，说明子进程根本没跑起来或源码本来就坏 —— 直接停下，
//   绝不能在"基线都红"的前提下继续做反证（那必然是假绿）。
(function baselineGuard() {
  let r;
  try { r = runCheck(); }
  catch (e) {
    console.error('\n★ 反证无法进行：' + e.message);
    console.error('  （本机沙箱会拦 execFileSync 启动的子进程，请在服务器容器内跑本套件）');
    unlock();
    process.exit(2);
  }
  if (r.red) {
    console.error('\n★ 反证无法进行：基线自检就没通过 —— 先修好正证再跑反证。');
    console.error(r.out.split('\n').slice(-12).join('\n'));
    unlock();
    process.exit(2);
  }
  console.log('基线自检全绿 ✓（说明子进程正常、可以开始反证）\n');
})();

/** 把一个文件里的 oldStr 换成 newStr，跑自检，要求变红；然后从快照还原 */
const cases = [];
function negate(name, file, oldStr, newStr) {
  cases.push({ name, file: path.join(ROOT, file), oldStr, newStr });
}

// ============================================================
// 反证 1：★★★ 最重要的一条 —— model 优先级写反（回到 opt.model 优先）
//   后果：regenerate（会显式传 model: conv.model）和"关掉开关那一刻"
//   都会让 deepThink 被静默绕过 —— 按钮亮着，实际走的是快速档。
negate('① model 优先级写反（opt.model 抢先，开关被静默绕过）',
  'server.js',
  "const model = deepThink ? 'deep' : (opt.model || conv.model || 'default');",
  "const model = opt.model || (deepThink ? 'deep' : (conv.model || 'default'));");

// 反证 2：streamReply 不再解析 deepThink（会全程走会话里的旧值）
negate('② streamReply 不解析 deepThink（本次请求的开关被忽略）',
  'server.js',
  "const deepThink = opt.deepThink !== undefined ? !!opt.deepThink : !!conv.deepThink;",
  "const deepThink = !!conv.deepThink;");

// 反证 3：renderDtBtn 不再从 S.model 推导（改读自己那份 S.deepThink）
//   ★ 但错误写法在语法上要成立，所以改成"读一个恒 false 的字段"来模拟
negate('③ renderDtBtn 不再从 S.model 推导（两入口会打架）',
  'public/js/app.js',
  "    const on = S.model === 'deep';\n    S.deepThink = on;",
  "    const on = !!S.deepThink && S.model !== '';");

// 反证 4：setDeepThink 不刷新顶栏下拉（点按钮后下拉还是旧档位）
negate('④ setDeepThink 不同步顶栏下拉（界面自相矛盾）',
  'public/js/app.js',
  "    const sel = $('#modelSel');\n    if (sel && sel.value !== S.model) sel.value = S.model;",
  "    const sel = null;\n    if (sel && sel.value !== S.model) sel.value = S.model;");

// 反证 5：modelSel 的 change 不调 renderDtBtn（切下拉后按钮态是旧的）
negate('⑤ 切顶栏下拉不刷新按钮态',
  'public/js/app.js',
  "      // ★ 顶栏下拉切到/切离 deep 档时，深度思考按钮要跟着亮/灭 ——\n      //   两者是同一个状态，不同步就是自相矛盾的界面。\n      renderDtBtn();",
  "      // (反证：故意不同步)");

// 反证 6：dtBtn 没绑 click（定义了但没人调 —— 本项目真出过的 bug）
negate('⑥ dtBtn 没绑 click（按钮点了没反应）',
  'public/js/app.js',
  "    $('#dtBtn').addEventListener('click', toggleDeepThink);",
  "    // (反证：故意不绑)");

// 反证 7：发送时不带 deepThink（开关永远传不到服务端）
negate('⑦ 发送请求不带 deepThink',
  'public/js/app.js',
  "          deepThink: !!S.deepThink,",
  "          deepThink: undefined,");

// 反证 8：core.js 的 updateConversation 不写 deep_think（开关存不住）
//   ★ 必须**整行删掉**而不是加 `if (false && …)` 短路 ——
//     短路只是运行时不执行，源码文本还在，正证用的是正则匹配源码，
//     会照样命中 ⇒ 变异等于没生效（本套件第一次跑就是这么漏掉第 ⑧ 条的）。
negate('⑧ 会话 PATCH 不落库 deepThink（刷新就丢）',
  'server/core.js',
  "  if (patch.deepThink !== undefined) D.run('UPDATE conversations SET deep_think = ? WHERE id = ?', patch.deepThink ? 1 : 0, id);\n",
  "");

// 反证 9：getConversation 不返回 deepThink（前端读不到会话上的开关）
negate('⑨ getConversation 不返回 deepThink',
  'server/core.js',
  "    agentId: c.agent_id || '', webSearch: !!c.web_search,\n    deepThink: !!c.deep_think,\n    mode: normMode(c.mode),",
  "    agentId: c.agent_id || '', webSearch: !!c.web_search,\n    mode: normMode(c.mode),");

// 反证 10：db.js 没有迁移（老库缺列 → 会话查询直接炸）
negate('⑩ 没有 deep_think 迁移（老库缺列）',
  'server/db.js',
  "  ['conversations', 'deep_think', 'INTEGER NOT NULL DEFAULT 0'],",
  "  // (反证：故意删掉迁移)");

// 反证 11：按钮不在联网旁边（放到别处去）
negate('⑪ 按钮被放到联网后面（不在"旁边"）',
  'public/index.html',
  '          <button class="ct" id="dtBtn" type="button" title="开启深度思考：难题先想清楚再答，慢一点但更稳">深度思考</button>\n          <button class="ct" id="webBtn" type="button" title="开启联网搜索：适合查最新资讯">联网搜索</button>',
  '          <button class="ct" id="webBtn" type="button" title="开启联网搜索：适合查最新资讯">联网搜索</button>\n          <span style="display:none">' + 'x'.repeat(300) + '</span>\n          <button class="ct" id="dtBtn" type="button" title="开启深度思考：难题先想清楚再答，慢一点但更稳">深度思考</button>');

// ============================================================
console.log('深度思考反证：' + cases.length + ' 处\n');
let caught = 0, missed = [];
for (const c of cases) {
  const orig = SNAPSHOT.get(c.file);
  if (orig.indexOf(c.oldStr) < 0) {
    missed.push(c.name + '（★ 变异没生效：源文件里找不到待替换片段）');
    continue;
  }
  fs.writeFileSync(c.file, orig.replace(c.oldStr, c.newStr));
  const r = runCheck();
  restoreAll();
  if (r.red) { caught++; console.log('  ✓ ' + c.name); }
  else { missed.push(c.name + '（改坏了但自检没变红）'); console.log('  ✗ ' + c.name + ' —— 没咬住！'); }
}

// ---------- ③ 校验还原与快照逐字节一致 ----------
let drift = [];
for (const f of FILES) {
  if (fs.readFileSync(f, 'utf8') !== SNAPSHOT.get(f)) drift.push(path.relative(ROOT, f));
}
if (drift.length) {
  console.error('\n★ 还原后与快照不一致：' + drift.join(', '));
  restoreAll();
}

console.log('\n' + '─'.repeat(62));
if (missed.length) missed.forEach(m => console.log('  ✗ ' + m));
console.log(`反证 ${caught}/${cases.length} 处咬住` + (drift.length ? '，还原有漂移！' : '，还原与快照一致'));

// 还原后正证必须全绿
// ★ 注意：必须在 restoreAll() 之后、且不能依赖 process.on('exit') 的钩子 ——
//   钩子跑在这一行之后，靠它还原会读到"上一个反证留下的坏文件"，报出假红。
restoreAll();
const final = runCheck();
console.log(final.red ? '★ 还原后自检仍红，源码可能被写坏！' : '还原后自检全绿 ✓');
// ★ 摘要行必须是「通过 N 项，失败 M 项」—— _run-tests.cjs 用这个正则抠数字，
//   格式不对就会把整个套件显示成「0 项」（看着像崩了，其实是没解析到）。
//   直接从还原后那次自检的输出里透传。
const fm = /通过 (\d+) 项，失败 (\d+) 项/.exec(final.out || '');
console.log('还原后：通过 ' + (fm ? fm[1] : 0) + ' 项，失败 ' + (fm ? fm[2] : 1) + ' 项');
unlock();
process.exit(missed.length || drift.length || final.red ? 1 : 0);

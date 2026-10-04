/* 反证（批次28·班级排行榜）：把关键实现逐个改回"坏版本"，确认 `_leaderboardcheck` 会红。
 * 每次改一处 → 同进程跑一次 → 立刻还原。任何一处没变红，说明那条断言是假的。
 *
 * 注意：**不能起子进程** —— 本沙箱 execFileSync(node, …) 会 EBUSY。
 * 所以改成 require('./_leaderboardcheck.cjs').check(true)，靠 check() 内部的
 * require.cache 清理 + 换新 DATA_DIR 保证每次都重新编译改动后的源码。
 *
 * ★★ 两条硬教训（都来自实测踩坑，别删）：
 *  ① **开局快照，别每轮现读**。原来写成 `const orig = readFileSync(p)` 放在循环里，
 *     一旦文件在别处被改过，就会把"改过的内容"当成原文写回去 —— 源码被永久污染。
 *     现在统一从开局的 SNAP 还原。
 *  ② **加锁，禁止两份实例同时跑**。这个脚本会改写源码再还原；两份并发会互相踩：
 *     A 改成坏版本 → B 读到坏版本当原文 → B 还原时把坏版本写成"原文"。
 *     本项目实测被这样写坏过一次（leaderboard.js 的 `joinCode: null` 变成了
 *     `c.join_code`，即"学生能看到入班码"，而当时所有套件都在报 A6/B10 红）。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = __dirname;

const FILES = ['server/leaderboard.js', 'server/growth.js', 'public/js/app.js'];

const LOCK = path.join(ROOT, '.leaderboardnegative.lock');
let lockFd = null;
try { lockFd = fs.openSync(LOCK, 'wx'); } catch (e) {
  console.error('已有另一份反证套件在跑（' + LOCK + ' 存在）。');
  console.error('这个脚本会改写源码再还原，两份同时跑会把源码写坏。等它跑完再来；');
  console.error('确认没有在跑的话，删掉那个文件重试。');
  process.exit(2);
}

// ★ 开局快照：所有还原都从这里写回。
const SNAP = {};
FILES.forEach(f => { SNAP[f] = fs.readFileSync(path.join(ROOT, f), 'utf8'); });

function restoreAll() { FILES.forEach(f => { try { fs.writeFileSync(path.join(ROOT, f), SNAP[f]); } catch (e) {} }); }
function releaseLock() {
  try { if (lockFd !== null) fs.closeSync(lockFd); } catch (e) {}
  try { fs.unlinkSync(LOCK); } catch (e) {}
}
let done = false;
process.on('exit', () => { if (!done) restoreAll(); releaseLock(); });

const { check } = require('./_leaderboardcheck.cjs');

const cases = [
  {
    name: '★★★ 跨空间串数据：eventsOf 丢掉 space_id 过滤（只按 user_id 取账本）',
    file: 'server/leaderboard.js',
    from: '      WHERE space_id = ? AND user_id = ? AND created_at >= ? AND created_at < ?',
    to: '      WHERE (space_id = ? OR 1=1) AND user_id = ? AND created_at >= ? AND created_at < ?',
  },
  {
    name: '★★ 羞辱式名次：0 分的人也发名次（scored 不再要求 v > 0）',
    file: 'server/leaderboard.js',
    from: '    const scored = !isNull && v > 0;',
    to: '    const scored = !isNull;',
  },
  {
    name: '★★ 班级边界失守：board 不挡班外人（FORBIDDEN 检查被短路）',
    file: 'server/leaderboard.js',
    from: "  if (!isOwner && !isMember) throw bad('FORBIDDEN', '你不在这个班里');\n\n  const rows = D.all(\n    `SELECT m.user_id, m.space_id, m.joined_at, u.name",
    to: "  if (false) throw bad('FORBIDDEN', '你不在这个班里');\n\n  const rows = D.all(\n    `SELECT m.user_id, m.space_id, m.joined_at, u.name",
  },
  {
    name: '★★★ null 冒充 0：progress 把"还没开始"算成 0（替人宣布原地踏步）',
    file: 'server/leaderboard.js',
    from: '  const progress = hasAny ? (thisWeek - lastWeek) : null;',
    to: '  const progress = hasAny ? (thisWeek - lastWeek) : 0;',
  },
  {
    name: '★★ 入班码泄漏：shapeClass 把入班码下发给所有人',
    file: 'server/leaderboard.js',
    from: '    joinCode: null,',
    to: '    joinCode: c.join_code,',
  },
  {
    name: '★★ 并列不同名次：v !== lastVal 判断被删（并列的人各占一个名次）',
    file: 'server/leaderboard.js',
    from: '    if (scored && v !== lastVal) { rank = i + 1; lastVal = v; }',
    to: '    if (scored) { rank = i + 1; lastVal = v; }',
  },
  {
    name: '★★ 跨班串数据：board 的成员查询不按 class_id 过滤',
    file: 'server/leaderboard.js',
    from: '      WHERE m.class_id = ?`, classId);\n\n  const nowMs = D.now();',
    to: '      WHERE (? IS NOT NULL)`, classId);\n\n  const nowMs = D.now();',
  },
  {
    name: '★ 容量上限失效：满员检查被短路',
    file: 'server/leaderboard.js',
    from: '  if (memberCount(c.id) >= MAX_CLASS_MEMBERS) {',
    to: '  if (false) {',
  },
  {
    name: '★ 解散变真删：归档改成 DELETE（数据没了，"归档不是删除"的断言该红）',
    file: 'server/leaderboard.js',
    from: "  D.run('UPDATE classes SET archived_at = ? WHERE id = ?', D.now(), classId);",
    to: "  D.run('DELETE FROM classes WHERE id = ?', classId);",
  },
  {
    name: '★★ 排行渗进画像：growth.js 里塞一个 rank 变量（"不排行"规矩该红）',
    file: 'server/growth.js',
    from: "'use strict';",
    to: "'use strict';\nconst rank = 1;",
  },
  {
    name: '★★ 前端指标切换不重新取数（只改了变量，界面不动 —— 本项目踩过的"点了没反应"）',
    file: 'public/js/app.js',
    from: 'if (mi) { CLS.metric = mi.dataset.metric; await loadBoard(); return; }',
    to: 'if (mi) { CLS.metric = mi.dataset.metric; return; }',
  },
  {
    name: '★★★ 前端把"没有名次"显示成 0（rank null 走 0 —— 变成"第 0 名"这种羞辱）',
    file: 'public/js/app.js',
    from: "(e.rank === null ? '—' : e.rank)",
    to: "(e.rank === null ? 0 : e.rank)",
  },
  {
    name: '★★★ 前端把 null 当 0 显示（"还没开始"和"确实是 0"混成一个样子）',
    file: 'public/js/app.js',
    from: 'const na = (v === null || v === undefined);',
    to: 'const na = false;',
  },
];

let allBite = true;
for (const c of cases) {
  const p = path.join(ROOT, c.file);
  const base = SNAP[c.file];
  if (base.indexOf(c.from) < 0) { console.log('  !! 找不到锚点，跳过：' + c.name); allBite = false; continue; }
  fs.writeFileSync(p, base.replace(c.from, c.to));
  let r;
  try { r = check(true); } finally { fs.writeFileSync(p, base); }
  const red = r.fail > 0;
  console.log((red ? '  ✓ 会红' : '  ✗ 没红（断言是假的！）') + '  ' + c.name + '  → 失败 ' + r.fail + (red ? '  [' + r.problems[0] + ']' : ''));
  if (!red) allBite = false;
}

// ★ 还原校验：跑完之后每个文件必须跟开局快照逐字节一致。
//   不一致说明还原失败（或别的东西改过源码），必须报出来而不是静默继续。
const drifted = FILES.filter(f => fs.readFileSync(path.join(ROOT, f), 'utf8') !== SNAP[f]);
if (drifted.length) { console.log('\n  !! 还原后源码与快照不一致：' + drifted.join(', ')); allBite = false; }
restoreAll();

const after = check(true);
console.log('\n还原后：通过 ' + after.pass + ' 项，失败 ' + after.fail + ' 项');
done = true;
releaseLock();
console.log(allBite && after.fail === 0 ? '\n全部反证成立，且还原后全绿' : '\n有问题，需检查');
process.exit((allBite && after.fail === 0) ? 0 : 1);

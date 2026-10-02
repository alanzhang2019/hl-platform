'use strict';
/**
 * 数据层初始化：正确性 + 耗时。
 *
 * ── 为什么要有这一套 ──────────────────────────────────────────
 *
 * 2026-10-01 实测发现：`require('./server/db.js')` 要 **80 秒**。
 * 原因是 SCHEMA 里的 51 条 DDL **一条条裸跑**，而
 * `journal_mode = DELETE` + `synchronous = FULL` 下每条 DDL 都是独立事务，
 * 各自要 fsync 一次回滚日志 + 主库文件。这台机器的 fsync 要几百毫秒，
 * 51 条就是 33 秒（加上两遍 migrate 就是 80 秒）。
 *
 * 它造成的后果**不是"慢一点"**，而是：
 *
 *   - 所有"自带服务"的测试套件（`_platformtest` / `_parity*http` / `_parityui`）
 *     全部**假红** —— 子进程只吐一句「服务在超时前没有就绪」，
 *     看不出跟数据库有任何关系；
 *   - 模块级套件从几秒变成 100–400 秒，整轮回归从几分钟变成半小时以上。
 *
 * 修法是把 `migrate() → SCHEMA → migrate()` 包进**一个事务**（SQLite 的 DDL
 * 本来就是事务性的）。80 秒 → 0.2 秒。
 *
 * 这一套守两件事：
 *   ① **耗时**：初始化必须在阈值内完成（阈值给得很宽，只拦"数量级退化"）；
 *   ② **正确性**：建表与增量补列都真的生效 —— 否则"快"没有意义。
 *
 * 本套件自己就是一次全新的进程，所以进程内计时是有效的。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hl-dbinit-'));
process.env.DATA_DIR = TMP;
process.env.NO_DOTENV = '1';
delete process.env.LLM_API_KEY;
delete process.env.ADMIN_PASSWORD;

let pass = 0, fail = 0;
const fails = [];
function ok(name, cond, extra) {
  if (cond) { pass++; }
  else { fail++; fails.push(name + (extra !== undefined ? ' → ' + JSON.stringify(extra) : '')); }
}
function group(t) { console.log('\n' + t); }

/**
 * 阈值 8 秒。
 * 实测修复后 0.2 秒、修复前 80 秒 —— 中间留了 40 倍余量，
 * 只拦"数量级退化"，不拦"这台机器今天有点慢"。
 */
const BUDGET_MS = 8000;

// ---------- A. 耗时 ----------
group('A. 初始化耗时（全新空库）');

const t0 = Date.now();
let D;
try { D = require('./server/db.js'); }
catch (e) {
  ok('require(db.js) 不抛错', false, e.message);
}
const ms = Date.now() - t0;
ok('★ require(db.js) 在 ' + BUDGET_MS + 'ms 内完成（实测 ' + ms + 'ms）', ms < BUDGET_MS, ms);
// 反证式的补充：如果它真的慢到超时，所有自带服务的套件都会假红 ——
// 这句话写在这里，是为了让看到红灯的人知道该往哪儿查。
if (ms >= BUDGET_MS) {
  console.log('  ⚠ 初始化过慢会让 _platformtest / _parity*http / _parityui 全部假红。');
  console.log('    先看 SCHEMA 有没有被拆出事务（见 server/db.js 的 BEGIN/COMMIT）。');
}

// ---------- B. 建表真的生效 ----------
group('B. 建表（SCHEMA 真的跑完了）');

if (D) {
  const tables = D.all("SELECT name FROM sqlite_master WHERE type='table'").map(r => r.name);
  ok('★ 表数量 ≥ 30（说明 SCHEMA 整段跑完，不是中途断掉）', tables.length >= 30, tables.length);
  ['spaces', 'users', 'sessions', 'cards', 'card_reviews', 'activity', 'jobs', 'daily_reports']
    .forEach(t => ok('有表 ' + t, tables.indexOf(t) >= 0));

  const idx = D.all("SELECT name FROM sqlite_master WHERE type='index'").map(r => r.name);
  ok('★ 批次10 的唯一索引建上了', idx.indexOf('idx_daily_space_date') >= 0);
  ok('批次6 的索引建上了', idx.indexOf('idx_pool') >= 0);

  // ---------- C. 增量补列（migrate）真的生效 ----------
  group('C. 增量补列（migrate 真的生效）');

  // 这一条正是"先 migrate 再 SCHEMA"的原因：messages 表在 SCHEMA 里的
  // 定义**不含** client_id 之前的老库，靠 migrate 补上；而 SCHEMA 里有一句
  // CREATE INDEX ... ON messages(client_id)，列没补上就整个起不来。
  const cols = D.all('PRAGMA table_info(messages)').map(c => c.name);
  ['client_id', 'status', 'meta_json', 'attachments_json', 'deleted', 'edited_at', 'translated_json']
    .forEach(c => ok('messages.' + c + ' 存在', cols.indexOf(c) >= 0, cols.join(',')));

  const cardCols = D.all('PRAGMA table_info(cards)').map(c => c.name);
  ['consecutive_right', 'plan'].forEach(c => ok('cards.' + c + ' 存在', cardCols.indexOf(c) >= 0));

  // ---------- D. 事务真的提交了（另一个连接能看到） ----------
  group('D. 事务提交与可写');

  ok('meta 表可读写', (() => {
    try { D.metaSet('dbinit_probe', '1'); return D.metaGet('dbinit_probe') === '1'; }
    catch (e) { return false; }
  })());

  ok('★ 第二次 require 拿到的是同一个实例（Node 模块缓存）',
    require('./server/db.js') === D);

  // 建表包在事务里之后，最需要确认的就是"COMMIT 真的落了"。
  // 换一个**独立的连接**打开同一个文件：看不到表就说明还挂在未提交的事务里。
  const t2 = Date.now();
  try {
    const { DatabaseSync } = require('node:sqlite');
    const db2 = new DatabaseSync(D.DB_FILE);
    const names = db2.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
    db2.close();
    ok('★ 另开一个连接也能看到全部表（说明事务已 COMMIT，不是挂着的）',
      names.length >= 30 && names.indexOf('daily_reports') >= 0, names.length);
    ok('换连接打开很快（<2000ms，实测 ' + (Date.now() - t2) + 'ms）', (Date.now() - t2) < 2000);
  } catch (e) {
    ok('换一个连接打开同一个库', false, e.message);
  }

  // 库已存在时**重新走一遍初始化**（模拟服务重启）必须成功且快。
  // 用一个全新进程跑，避免模块缓存 —— 但为了避免递归，这里只跑一条等价路径：
  // 直接再 new 一个 DatabaseSync 并执行一段 DDL，确认 DDL 在已存在的库上是幂等的。
  try {
    const { DatabaseSync } = require('node:sqlite');
    const db3 = new DatabaseSync(D.DB_FILE);
    const t3 = Date.now();
    db3.exec('CREATE TABLE IF NOT EXISTS daily_reports (id TEXT PRIMARY KEY)');
    db3.close();
    ok('已存在的表上再跑 DDL 不抛错且很快（<2000ms，实测 ' + (Date.now() - t3) + 'ms）',
      (Date.now() - t3) < 2000);
  } catch (e) {
    ok('已存在的表上再跑 DDL', false, e.message);
  }

  // ---------- E. 事务可重入 + 写入放大守门 ----------
  //
  // 与 A 组同一个病根：`journal_mode = DELETE` + `synchronous = FULL` 下
  // **每个事务都要 fsync 两次**，本机一次事务约 500ms。
  // 而 `tx()` 原来不可重入（嵌套抛 "cannot start a transaction within a transaction"），
  // 于是**没人敢在外层包事务** —— "一次请求写 N 行"退化成 N 次独立事务。
  // 典型受害者：共享池「取用」6 张卡 ≈ 14 次写 ≈ **7 秒**。
  group('E. 事务（可重入 + 写入放大守门）');

  // E1 可重入：嵌套不抛，且两层都写得进去
  let nestedErr = null;
  try {
    D.tx(() => {
      D.metaSet('tx_out', '1');
      D.tx(() => { D.metaSet('tx_in', '1'); });
    });
  } catch (e) { nestedErr = e.message; }
  ok('★ 嵌套 tx() 不抛（原来抛 cannot start a transaction within a transaction）',
    nestedErr === null, nestedErr);
  ok('嵌套时外层与内层都写成功',
    D.metaGet('tx_out', 'X') === '1' && D.metaGet('tx_in', 'X') === '1');

  // E2 ★ 可重入的**正确性**判据不是"不抛异常"，而是"内层失败只回滚内层"。
  //    如果内层一抛就把外层已写的也带走，那"可重入"就是个危险的假象。
  let innerErr = null;
  D.tx(() => {
    D.metaSet('tx_outer_keep', '1');
    try {
      D.tx(() => { D.metaSet('tx_inner_lost', '1'); throw new Error('boom'); });
    } catch (e) { innerErr = e.message; }
  });
  ok('内层抛错会传出来（不被吞掉）', innerErr === 'boom', innerErr);
  ok('★ 内层回滚之后，外层已经写的还在', D.metaGet('tx_outer_keep', 'GONE') === '1');
  ok('★ 内层自己写的那条被回滚掉了', D.metaGet('tx_inner_lost', 'GONE') === 'GONE');

  // E3 最外层抛错 → 整批回滚（与 E2 相反的一侧，两条一起才说明层级判断是对的）
  try { D.tx(() => { D.metaSet('tx_all_gone', '1'); throw new Error('boom2'); }); } catch (e) {}
  ok('最外层抛错时整批回滚', D.metaGet('tx_all_gone', 'GONE') === 'GONE');

  // E4 写入放大：用**比值**而不是绝对毫秒，跟机器的绝对速度无关。
  //    快盘上两者都是一两毫秒，比值接近 1 是**正常的**，那种机器上跳过这条 ——
  //    这条守的是"慢 fsync 机器上有人把事务拆开了"，不是"这台机器快不快"。
  const SQLW = 'INSERT INTO meta(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v';
  const NW = 8;
  D.run(SQLW, 'w_warm', '1');                       // 预热：别把首条的建页成本算进去
  // ★ 各测 3 轮取**最小值**，不取单次。
  //   单次测量在机器忙的时候会被噪声整个吞掉：全量回归里真出现过「裸写 301ms / 事务 333ms」，
  //   事务反而更慢，比值断言直接红；而同一个脚本单独跑，8 条裸写只要 112ms。
  //   噪声只会拖慢某一轮，最小值才接近这台机器真实的写入速度。
  //   反复用同一批 key（upsert）不会把 meta 撑大 —— 这点也要守住，不然就是拿污染换稳定。
  const timeIt = (fn) => { const t = Date.now(); fn(); return Date.now() - t; };
  const bareRuns = [], txedRuns = [];
  for (let r = 0; r < 3; r++) {
    bareRuns.push(timeIt(() => { for (let i = 0; i < NW; i++) D.run(SQLW, 'bare' + i, 'v'); }));
    txedRuns.push(timeIt(() => { D.tx(() => { for (let i = 0; i < NW; i++) D.run(SQLW, 'txed' + i, 'v'); }); }));
  }
  const bare = Math.min.apply(null, bareRuns), txed = Math.min.apply(null, txedRuns);
  if (bare > 300) {
    ok('★ ' + NW + ' 条写包进一个事务，比裸写快 ≥3×（裸写 ' + bare + 'ms / 事务 ' + txed + 'ms）',
      txed * 3 < bare, { bare, txed });
  } else {
    console.log('  · 本机写很快（' + NW + ' 条裸写仅 ' + bare + 'ms），比值断言无意义，跳过');
  }
}

// ---------- 汇总 ----------
console.log('\n' + '─'.repeat(60));
if (fail) {
  console.log('✗ 通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  fails.forEach(f => console.log('  ✗ ' + f));
} else {
  console.log('✓ 通过 ' + pass + ' 项，失败 0 项');
}
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
process.exit(fail ? 1 : 0);

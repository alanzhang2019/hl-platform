/**
 * _wprobe.cjs —— 写入放大探针（常驻诊断工具，不是正式测试套件）
 *
 * 用途：量「一次请求写 N 行」到底贵在哪。
 * 背景：`journal_mode = DELETE` + `synchronous = FULL` 下**每条独立语句 = 一个事务 = 2 次 fsync**，
 *       而本机一次事务约 500ms。三处事故都出在这里：
 *         · `db.js` 建表 51 条裸 DDL      → require 80s（已包事务，0.2s）
 *         · `auth.js` 每次鉴权写 last_seen → 首屏 7325ms（已加 60s 节流，111ms）
 *         · `pool.copy` 取用 6 张卡 14 次写 → 7s（已包事务，0.6s）
 *
 * 什么时候跑它：怀疑某个接口"莫名其妙慢几秒"，且表很小（不是查询慢）的时候。
 * 判据：**如果"裸写"和"包事务"耗时差不多，说明本机 fsync 很快，性能问题在别处。**
 *       比值越大，说明这台机器上"少包一个事务"的代价越大。
 *
 * 跑法：node _wprobe.cjs
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hl-wprobe-'));
process.env.DATA_DIR = TMP;
process.env.NO_DOTENV = '1';

const D = require('./server/db.js');
const SQL = "INSERT INTO meta(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v";
const N = 14;   // 共享池「取用」6 张卡的真实量级：6×INSERT cards + 6×logActivity + 2×pool

function bench(label, fn) {
  const t = Date.now();
  fn();
  const ms = Date.now() - t;
  console.log('  ' + label.padEnd(30, ' ') + String(ms).padStart(7) + 'ms');
  return ms;
}

console.log('\n写入放大实测（N = ' + N + ' 条 INSERT）');
console.log('DATA_DIR = ' + TMP + '\n');

// 预热：让连接、页缓存、文件都就位，否则第一条会掺进建库成本
D.run(SQL, 'warm', '1');

const a = bench('N 条裸写（各自一个事务）', () => {
  for (let i = 0; i < N; i++) D.run(SQL, 'a' + i, 'v');
});

const b = bench('N 条包在一个事务里', () => {
  D.tx(() => { for (let i = 0; i < N; i++) D.run(SQL, 'b' + i, 'v'); });
});

console.log('\n  比值：' + (a / Math.max(b, 1)).toFixed(1) + '×');
console.log('  单条裸写均摊：' + (a / N).toFixed(0) + 'ms');
console.log('  单条事务内均摊：' + (b / N).toFixed(0) + 'ms');

// 顺带量一下"不可重入"这件事是不是真的
let nested = 'ok';
try { D.tx(() => { D.tx(() => {}); }); }
catch (e) { nested = e.message; }
console.log('\n  嵌套 tx()：' + nested);

// 量一下 PRAGMA 的实际取值，确认前提没写错
for (const p of ['journal_mode', 'synchronous']) {
  const r = D.get('PRAGMA ' + p);
  console.log('  PRAGMA ' + p + ' = ' + JSON.stringify(r));
}

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}

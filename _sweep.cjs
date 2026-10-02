'use strict';
/**
 * _sweep.cjs —— 临时目录清理器（显式调用）
 *
 * 为什么清理要单独拿出来、而且**必须有预算**：
 * 本机实测（C 盘 100% 满 / 16GB 内存只剩 855MB / 636 个进程 / 266 个 backgroundTaskHost）：
 *   读 388 个目录共 364MB …………………… 1.1 秒
 *   删 10 个 4KB 文件 ………………………… 44 秒
 *   删 1 个**空目录** ………………………… 60 秒
 * 这台机器上"删"比"读"慢几个数量级，而且是几十秒量级的停顿，不按文件数线性累加。
 *
 * 后果：把清理放在测试收尾里同步做，等于让"清理"决定"测试跑多久"。
 * 实测一次全量回归的收尾清扫吃掉 58 秒，最坏一次把整条回归拖到 560 秒被超时杀掉 ——
 * 而那时套件本身早就全跑完了。所以运行器里那份清扫是**带预算**的（见 _run-tests.cjs）；
 * 这个脚本则是"我愿意等"的显式版本，用来做完整清理。
 *
 * 用法：
 *   node _sweep.cjs <目录名或绝对路径> …      删指定的若干目录
 *   node _sweep.cjs --all                     删 TEMP 里**所有** hl-* 目录
 *   node _sweep.cjs --budget 20000 …          最多花 20 秒，到点就收工并报还剩多少
 *                                             （默认 0 = 不限时，跑完为止）
 *
 * 另：本沙箱会**回收 detached 子进程**（父命令一返回就被杀），
 * 所以"起个后台进程慢慢删"这条路是走不通的 —— 实测子进程连日志都没写出来。
 * 这也是为什么预算做在**进程内**、而不是靠 detached。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = os.tmpdir();

/** 目录大小（只用于报告）。深度上限防符号链接成环 —— 同步递归不响应任何超时。 */
function dirSize(p, depth) {
  if (depth > 12) return 0;
  let total = 0;
  const st = fs.lstatSync(p);
  if (st.isFile()) return st.size;
  for (const n of fs.readdirSync(p)) {
    try { total += dirSize(path.join(p, n), depth + 1); } catch (e) {}
  }
  return total;
}

/**
 * 删一批目录，**带预算**。
 * 预算只在**每个目录之间**检查 —— 单次 `rmSync` 没法中断（同步调用不响应任何超时），
 * 所以真实上界是 `budget + 单个最慢目录`。这一点如实写在返回值里，不假装是硬上界。
 */
function sweep(targets, budgetMs, onProgress) {
  const t0 = Date.now();
  let done = 0, failed = 0, freed = 0, skipped = 0;
  for (let i = 0; i < targets.length; i++) {
    const p = targets[i];
    if (budgetMs > 0 && Date.now() - t0 > budgetMs) { skipped++; continue; }
    try {
      freed += dirSize(p, 0);
      fs.rmSync(p, { recursive: true, force: true, maxRetries: 1, retryDelay: 100 });
      done++;
    } catch (e) { failed++; }
    if (onProgress && (i + 1) % 10 === 0) onProgress(i + 1, targets.length, done, failed, freed, Date.now() - t0);
  }
  return { done, failed, freed, skipped, ms: Date.now() - t0, total: targets.length };
}

module.exports = { sweep, dirSize };

if (require.main === module) {
  const argv = process.argv.slice(2);
  let budget = 0;
  const bi = argv.indexOf('--budget');
  if (bi >= 0) { budget = Number(argv[bi + 1]) || 0; argv.splice(bi, 2); }

  let targets;
  if (argv.indexOf('--all') >= 0) {
    targets = fs.readdirSync(TMP)
      .filter(n => n.indexOf('hl-') === 0)
      .map(n => path.join(TMP, n));
  } else {
    targets = argv.map(a => (path.isAbsolute(a) ? a : path.join(TMP, a)));
  }

  if (!targets.length) { console.log('没有要清理的目录。'); process.exit(0); }

  console.log('开始清理 ' + targets.length + ' 个目录' + (budget ? '（预算 ' + (budget / 1000) + ' 秒）' : '') + '…');
  // 进度实时打出来：本机删 395 个目录可能几十分钟，静默卡住会让人以为死机。
  const r = sweep(targets, budget, (i, n, done, failed, freed, ms) => {
    console.log('  进度 ' + i + '/' + n + '：已删 ' + done + '，失败 ' + failed + '，约 ' + (freed / 1048576).toFixed(1) + 'MB，' + (ms / 1000).toFixed(0) + 's');
  });
  console.log('删掉 ' + r.done + ' 个，失败 ' + r.failed + ' 个，约 ' + (r.freed / 1048576).toFixed(1) + 'MB，用时 ' + (r.ms / 1000).toFixed(1) + 's' +
    (r.skipped ? '；到预算上限，还有 ' + r.skipped + ' 个没动（再跑一次继续）' : ''));
}

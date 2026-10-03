'use strict';
/* 反证：把批次26/27 修复的六处关键点分别拔掉，套件必须变红。
   ★ 本机 execFileSync / spawnSync 一律 EBUSY ⇒ **必须同进程跑**（项目既有判据）。
   套件末尾有 process.exit ⇒ 在这里把它换成抛异常来接管控制权。 */
const fs = require('fs');
const path = require('path');

const target = path.join(__dirname, 'server/extract.js');
const SUITE = path.join(__dirname, '_p26pdfcheck.cjs');
const good = fs.readFileSync(target, 'utf8');

/** 同进程跑一次套件，返回 {pass, fail} */
function runSuite() {
  // ★ 清 require.cache（否则第二次读到的是第一次编译好的 extract）——项目既有判据
  Object.keys(require.cache).forEach(k => {
    if (k.includes('extract') || k.includes('_p26')) delete require.cache[k];
  });
  const logs = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origLog = console.log;
  const origExit = process.exit;
  const origErrLog = console.error;
  process.exit = function () { throw new Error('__SUITE_EXIT__'); };
  console.log = function () { logs.push(Array.prototype.join.call(arguments, ' ')); };
  console.error = function () { logs.push(Array.prototype.join.call(arguments, ' ')); };
  try {
    require(SUITE);
  } catch (e) {
    if (!/__SUITE_EXIT__/.test(e.message)) logs.push('THROW ' + e.message);
  } finally {
    console.log = origLog; console.error = origErrLog; process.exit = origExit;
    Object.keys(require.cache).forEach(k => {
      if (k.includes('extract') || k.includes('_p26')) delete require.cache[k];
    });
  }
  const txt = logs.join('\n');
  const m = txt.match(/通过 (\d+) 项，失败 (\d+) 项/);
  return { pass: m ? +m[1] : null, fail: m ? +m[2] : null, txt };
}

const CASES = [
  ['基线（修好的版本）', null, false],
  ['拔掉①：CMap 只认 gzip 头（第一版踩的 bug）',
    s => s.replace(/function cmapBytes\(buf\) \{[\s\S]*?\n\}/,
      'function cmapBytes(buf) {\n' +
      '  if (!buf || !buf.length) return \'\';\n' +
      '  if (buf[0] === 0x1f && buf[1] === 0x8b) { const z = tryInflate(buf); if (z) return z; }\n' +
      '  return buf.toString(\'latin1\');\n}'),
    true],
  ['拔掉②：extractPdf 不再收 ToUnicode（cidMap 恒 null）',
    s => s.replace(/const tu = toUnicodeMaps\(buf\);\s*\n\s*const cidMap = tu\.map\.size \? tu\.map : null;/,
      'const cidMap = null;'),
    true],
  ['拔掉③：调用点不传"按字体分好的表"（只剩全局合并表 ⇒ 多字体必然串味）',
    // ★ 两个调用点的第三参分别是 `fmaps` 与 `null`（兜底路径）。函数**定义**处
    //   的参数名是 `fontMaps`（大写 M），与这里的小写 `fmaps` 不同 ——
    //   所以这条替换只会命中调用点，不会把定义也改掉。
    s => s.replace(/, cidMap, fmaps\)/g, ', cidMap)')
          .replace(/, cidMap, null\)/g, ', cidMap)'),
    true],
  ['拔掉④：TJ 数组里的 (<hex>) 不再查映射表（退回"吐原始码"）',
    s => s.replace(/if \(m2\) \{\s*\n\s*pending \+= decodeHexText\(m2\[1\]\.replace\(\/\\s\+\/g, ''\), cur\);\s*\n\s*\} else \{\s*\n\s*pending \+= un;\s*\n\s*\}/,
      'pending += un;'),
    true],
  ['拔掉⑤：不走"按 /Contents 取页面内容流"这条路（退回"所有 stream 都当正文试"）',
    // ★ 只改 `let refs = …` 那行是**不够**的 —— 紧跟着的
    //   `if (!refs.length) { … dictRefNum … }` 会把它又填回来，变异等于没生效。
    //   所以直接把整个"页面路径"跳过，让流程落到兜底扫全流那一支。
    s => s.replace(/const fmaps = fontMapsForPage\(raw, pg\.dict, objs, buf\);/,
      'continue;'),
    true],
  ['拔掉⑥：`Tf` 不切换字体表（cur 恒为全局表）',
    s => s.replace(/cur = \(fontMaps && fontMaps\.get\(m\[1\]\)\) \|\| cidMap;/,
      'cur = cidMap;'),
    true],
];

let bad = 0;
let basePass = 0, baseFail = 0;
for (const [name, mutate, wantRed] of CASES) {
  const src = mutate ? mutate(good) : good;
  if (mutate && src === good) {
    console.log('  ✗ ' + name + '  → **变异没生效**（源文件和补丁对不上，等于没测）');
    bad++; continue;
  }
  fs.writeFileSync(target, src, 'utf8');
  const r = runSuite();
  if (!mutate) { basePass = r.pass; baseFail = r.fail; }   // 记基线（还原后的状态）
  const red = r.fail !== null && r.fail > 0;
  const crashed = r.pass === null;
  const got = crashed ? true : red;          // 套件崩了也算"抓到了"
  const okk = (got === wantRed);
  if (!okk) bad++;
  console.log((okk ? '  ✓ ' : '  ✗ ') + name + '  → 通过 ' + r.pass + ' 失败 ' + r.fail +
    (crashed ? '（套件异常退出）' : ''));
}
fs.writeFileSync(target, good, 'utf8');
// ★ 摘要行必须满足 runner 的契约：/通过 (\d+) 项，失败 (\d+) 项/
//   不打这行，_run-tests.cjs 会把这个套件显示成「0 项」——
//   看起来像"没跑"，实际是跑了却没报数（本项目 runner 的既有判据）。
//   数字口径与 _tiernegative 一致：**还原后的 pass/fail**（反证本身不计入通过数）。
console.log('\n还原后：通过 ' + basePass + ' 项，失败 ' + baseFail + ' 项');
console.log(bad ? '❌ 反证有 ' + bad + ' 项不符：套件对这些改动不敏感！（这一条本身算失败）'
                : '✅ 反证全部符合预期：六处修复每拔掉一处，套件都变红。');
process.exit(bad ? 1 : 0);

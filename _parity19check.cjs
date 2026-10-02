'use strict';
/**
 * 批次19 自检（静态）：**IP 红线** —— 界面与提示词里不许出现教材版本/出处。
 *
 * 为什么要有这一套：
 *
 *   1. **这条红线是"不写"而不是"写错"，所以没有任何运行时报错来提醒你。**
 *      一句文案里混进「课本」「人教版」，页面照跑、测试照绿、用户照看 ——
 *      只有法务风险在悄悄变大。**唯一能守住它的办法就是静态扫描。**
 *   2. **最容易漏的地方是"提示词里的示例 JSON"**。模型会照着示例的**形状**抄，
 *      包括示例里的具体值。示例 subtitle 写「北师大版六年级上册」，
 *      模型就会把它搬进真实输出的计划卡里 —— 而那时它是**用户可见的产品文案**，
 *      不是我们写的一句话。这一条比界面文案更隐蔽，因为源码里它是"提示词的一部分"。
 *   3. **年级（七年级/高一）和版本（人教版/北师大版）要分开看。**
 *      前者是通用教育术语、不是谁的 IP；后者是**特定出版单位的标识**。
 *      一刀切地禁"年级"会把正常的表单占位符也误伤。
 *
 * 判据：
 *   · 用户可见目录（public/）与后端文案（server/）**不许出现版本名**
 *   · 提示词里的示例数据**同样不许**（模型会照抄）
 *   · 计划卡的提示词必须**明文写明**这条负向约束（"示例干净"不等于"模型知道别写"）
 *   · 年级类术语**允许**出现（反证：确保扫描不会误伤）
 *
 * 只读文件，不写任何数据。
 */
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const fails = [];
function ok(name, cond, extra) {
  if (cond) { pass++; }
  else { fail++; fails.push(name + (extra !== undefined ? ' → ' + JSON.stringify(extra) : '')); }
}
function group(t) { console.log('\n' + t); }

const ROOT = __dirname;
const PUB = path.join(ROOT, 'public');
const SRV = path.join(ROOT, 'server');

/** 递归收集目录下的文本文件（只扫会进产物的类型） */
function walk(dir, out) {
  out = out || [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p, out); }
    else if (/\.(js|html|css|json|md)$/.test(e.name)) out.push(p);
  }
  return out;
}

/**
 * 教材版本名 / 出版单位标识 —— **这些是 IP 红线**。
 * ★ 故意不含"年级"：年级是通用术语（见下方反证组）。
 */
const BANNED = [
  '人教版', '北师大版', '苏教版', '部编版', '沪教版', '外研社',
  '译林版', '教科版', '鲁教版', '湘教版', '粤教版', '冀教版',
  '鄂教版', '青岛版', '西南师大版',
  // 「课本 / 教材 / 教辅」不是版本名，但同属"指向具体出版物"的措辞，一并禁
  '课本', '教科书',
];

const FILES = walk(PUB).concat(walk(SRV));

// ---------- A. 用户可见文案与后端源码：不许出现版本名 ----------
group('A. 源码与界面文案：不出现教材版本 / 课本字样');
for (const f of FILES) {
  const src = fs.readFileSync(f, 'utf8');
  const rel = path.relative(ROOT, f).replace(/\\/g, '/');
  // server/chat.js 的提示词里有"明确禁止写版本名"的指令，那几行本身会包含这些词 ——
  // 允许带 ★ 标记的"负向约束行"存在（判据在 C 组单独守）。
  const lines = src.split('\n');
  for (const w of BANNED) {
    const hits = [];
    lines.forEach((ln, i) => {
      if (ln.indexOf(w) < 0) return;
      // 负向约束行：同一行里有"不要/禁止/绝对不"这类词，说明是在**禁止**它，不是在用它
      if (/不要出现|不许出现|禁止|绝对不|不预置|不标注|IP 红线/.test(ln)) return;
      hits.push(i + 1);
    });
    ok(rel + ' 不含「' + w + '」', hits.length === 0, hits.slice(0, 3));
  }
}

// ---------- B. 反证：年级类通用术语**必须**被允许（扫描不能一刀切） ----------
// 这一组的意义：证明 A 组的判据是"按语义分的"，不是"把所有教育词都禁了"。
// 如果哪天有人把 A 组改成禁"年级"，这里会立刻红，提醒他"你误伤了正常表单"。
group('B. 反证：年级类通用术语允许存在（不是一刀切禁教育词）');
{
  const appjs = fs.readFileSync(path.join(PUB, 'js', 'app.js'), 'utf8');
  ok('★ app.js 里的年级选项仍然在（七年级/高一 是通用术语，不该被禁）',
    appjs.indexOf('七年级') >= 0 || appjs.indexOf('高一') >= 0,
    '如果这里红了，说明有人把 A 组的判据扩大到了"年级"');
  ok('★ 年级选项出现在「学段 → 年级」的映射里（确认是表单用途，不是文案泄漏）',
    /'初中'\s*:\s*\[[^\]]*'七年级'/.test(appjs) || /'高中'\s*:\s*\[[^\]]*'高一'/.test(appjs));
}

// ---------- C. 提示词：示例干净 + 负向约束明文写清 ----------
group('C. 提示词：示例不许带版本名，且必须明文禁止模型写');
{
  const chat = fs.readFileSync(path.join(SRV, 'chat.js'), 'utf8');

  // C1. 计划卡提示词里的示例 JSON，subtitle 不许带版本名
  const iPlan = chat.indexOf('const PLAN_PROMPT');
  ok('找得到 PLAN_PROMPT', iPlan > 0, iPlan);
  const planBlock = chat.slice(iPlan, chat.indexOf('`;', iPlan));
  ok('★ 计划卡示例 JSON 的 subtitle 不含版本名（模型会照抄示例的值）',
    !/subtitle"\s*:\s*"[^"]*(人教版|北师大版|苏教版|部编版|上册|下册)[^"]*"/.test(planBlock),
    (planBlock.match(/subtitle"\s*:\s*"[^"]*"/) || [''])[0]);

  // C2. 必须**明文**写出这条负向约束 —— 示例干净 ≠ 模型知道别写
  //     （模型可能从用户粘贴的答复里把版本名抄进 subtitle）
  ok('★ 计划卡提示词明文禁止 subtitle 出现教材版本名',
    /subtitle[^\n]{0,40}(绝对不要|不要|禁止)[^\n]{0,40}(教材版本|版本名)/.test(planBlock) ||
    /绝对不要出现任何教材版本名/.test(planBlock),
    '只把示例改干净是不够的：模型还会从用户答复里抄版本名');
  ok('★ 该约束明确要求"答复里带了也不要照抄"（堵住唯一剩下的泄漏路径）',
    /答复里带了版本名也[^\n]{0,20}不要照抄|不要照抄/.test(planBlock));

  // C3. 插画提示词同样不该把版本名写进画面主题
  const iIll = chat.indexOf('const ILLUSTRATION_PROMPT');
  ok('找得到 ILLUSTRATION_PROMPT', iIll > 0, iIll);
  const illBlock = chat.slice(iIll, chat.indexOf('`;', iIll));
  ok('插画提示词示例不含版本名',
    !BANNED.some(w => illBlock.indexOf(w) >= 0));
}

// ---------- D. 全库总扫：确认没有漏网 ----------
group('D. 全库总扫（含 test 脚本之外的源码）');
{
  const offenders = [];
  for (const f of FILES) {
    const rel = path.relative(ROOT, f).replace(/\\/g, '/');
    const lines = fs.readFileSync(f, 'utf8').split('\n');
    lines.forEach((ln, i) => {
      if (/不要出现|不许出现|禁止|绝对不|不预置|不标注|IP 红线/.test(ln)) return;
      for (const w of BANNED) if (ln.indexOf(w) >= 0) offenders.push(rel + ':' + (i + 1) + ' 「' + w + '」');
    });
  }
  ok('★ 全库无一处教材版本 / 课本字样', offenders.length === 0, offenders.slice(0, 5));
}

// ---------- 汇总 ----------
console.log('\n' + '─'.repeat(60));
if (fail) {
  console.log('✗ 通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  fails.forEach(f => console.log('  ✗ ' + f));
} else {
  console.log('✓ 通过 ' + pass + ' 项，失败 0 项');
}
process.exit(fail ? 1 : 0);

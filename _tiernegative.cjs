/* 反证（批次25 第③项·档位授权）：把关键实现改回"坏版本"，确认 _tiercheck 会红。
 * 每次改一处 → 同进程跑一次 → 立刻还原。任何一处没变红，说明那条断言是假的。
 *
 * 注意：**不能起子进程** —— 本沙箱 execFileSync(node, …) 会 EBUSY。
 * 所以改成 require('./_tiercheck').check(true)，靠 check() 内部的 require.cache 清理
 * 保证每次都重新编译改动后的源码。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = __dirname;
const { check } = require('./_tiercheck.cjs');

const cases = [
  {
    name: '★ 越权放行：tierRank 对未知档返回 0（而不是 -1）',
    file: 'server/skills.js',
    from: '  return t ? t.rank : -1;\n}\nfunction tierInfo(key) {',
    to: '  return t ? t.rank : 0;\n}\nfunction tierInfo(key) {',
  },
  {
    name: '★ 闸门失效：tierAllows 直接放行一切',
    file: 'server/skills.js',
    from: '  const have = tierRank(spaceTier);\n  const need = tierRank(requiredTier || DEFAULT_TIER);\n  if (have < 0 || need < 0) return false;   // 任一侧认不出来 → 锁住\n  return have >= need;',
    to: '  return true;',
  },
  {
    name: '★★ 授权不校验档位：grant 里删掉 assertUnlocked',
    file: 'server/skills.js',
    from: '  assertUnlocked(spaceId, id);\n',
    to: '',
  },
  {
    name: '★★ enabledIds 不挡已锁定的技能',
    file: 'server/skills.js',
    from: "    .filter(id => { const s = get(id); return s && tierAllows(myTier, s.required_tier || DEFAULT_TIER); });",
    to: "    .filter(id => { const s = get(id); return !!s; });",
  },
  {
    name: '★ list() 不算 locked（永远显示为可用）',
    file: 'server/skills.js',
    from: '  const locked = !tierAllows(myTier, req);',
    to: '  const locked = false;',
  },
  {
    name: '★ migrateTiers 漏掉 spaces.tier 的归一',
    file: 'server/skills.js',
    from: "  D.run(\"UPDATE spaces SET tier = ? WHERE tier IS NULL OR tier = '' OR tier = 'free'\", DEFAULT_TIER);\n",
    to: '',
  },
  {
    name: '★ setSpaceTier 不校验档位名（脏数据能进库）',
    file: 'server/skills.js',
    from: "  if (TIER_KEYS.indexOf(tier) < 0) { const e = new Error('没有这个档位'); e.code = 'BAD_TIER'; throw e; }\n",
    to: '',
  },
  {
    name: '★ setSpaceTier 不校验空间存在（往不存在的空间写档位）',
    file: 'server/skills.js',
    from: "  if (!r) { const e = new Error('没有这个空间'); e.code = 'NOT_FOUND'; throw e; }\n",
    to: '',
  },
  {
    name: '★ 覆盖度断言失去意义：TIER_ASSIGN 里塞一个孤儿 id',
    file: 'server/skills.js',
    from: 'const TIER_ASSIGN = {\n',
    to: "const TIER_ASSIGN = {\n  'no-such-skill-zzz': 'self',\n",
  },
  {
    name: '★ 默认档改成非最低档（种子会把所有技能开放）',
    file: 'server/skills.js',
    from: "const DEFAULT_TIER = 'self';",
    to: "const DEFAULT_TIER = 'all';",
  },
];

let allBite = true;
for (const c of cases) {
  const p = path.join(ROOT, c.file);
  const orig = fs.readFileSync(p, 'utf8');
  if (orig.indexOf(c.from) < 0) { console.log('  !! 找不到锚点，跳过：' + c.name); allBite = false; continue; }
  fs.writeFileSync(p, orig.replace(c.from, c.to));
  let r;
  try { r = check(true); } finally { fs.writeFileSync(p, orig); }
  const red = r.fail > 0;
  console.log((red ? '  ✓ 会红' : '  ✗ 没红（断言是假的！）') + '  ' + c.name + '  → 失败 ' + r.fail + (red ? '  [' + r.problems[0] + ']' : ''));
  if (!red) allBite = false;
}
const after = check(true);
console.log('\n还原后：通过 ' + after.pass + ' 项，失败 ' + after.fail + ' 项');
console.log(allBite && after.fail === 0 ? '\n全部反证成立，且还原后全绿' : '\n有问题，需检查');
process.exit((allBite && after.fail === 0) ? 0 : 1);

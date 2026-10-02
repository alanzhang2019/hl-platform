/* 反证：把批次25 的关键实现改回"坏版本"，确认 _p25check 会红。
 * 每次改一处、跑一次、立刻还原。任何一处没变红，说明那条断言是假的。
 *
 * 注意：**不能起子进程** —— 本沙箱 execFileSync(node, …) 会 EBUSY。
 * 改成 require('./_p25check').check() 在**同一个进程**里跑，每次都重新读文件。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = __dirname;
const { check } = require('./_p25check.cjs');

const cases = [
  {
    name: 'B: renderSkillList 不渲染图标（删掉 sc-ico 行）',
    file: 'public/js/app.js',
    from: "        '<span class=\"sc-ico\">' + skIcon(s.icon) + '</span>' +\n",
    to: '',
  },
  {
    name: 'C: newConv 重新无条件清空 agentId（keepAgent 失效）',
    file: 'public/js/app.js',
    from: "if (!keepAgent) S.agentId = '';",
    to: "S.agentId = '';",
  },
  {
    name: 'C: 委托不拦 data-go（改成只认 .skill-c）',
    file: 'public/js/app.js',
    from: "      const go = ev.target.closest('[data-go]');\n      if (go) { ev.stopPropagation(); openSkillChat(go.dataset.go); return; }\n      const c = ev.target.closest('.skill-c'); if (!c) return;",
    to: "      const c = ev.target.closest('.skill-c'); if (!c) return;",
  },
  {
    name: 'A: 前端漏掉一个图标（grammar 改名）',
    file: 'public/js/skillicons.js',
    from: '    grammar: C(12, 4.5, 1.6)',
    to: '    grammarr: C(12, 4.5, 1.6)',
  },
  {
    name: 'D: sc-ico 样式改到找不到（模拟被挪走）',
    file: 'public/app.css',
    from: '.skill-c .sc-ico { flex: 0 0 22px;',
    to: '.skill-c-zzz .sc-ico { flex: 0 0 22px;',
  },
  {
    name: 'C: openSkillChat 忘了带 keepAgent',
    file: 'public/js/app.js',
    from: 'await newConv({ keepAgent: true });',
    to: 'await newConv({});',
  },
  {
    name: 'B: 忘了在 index.html 引入 skillicons.js',
    file: 'public/index.html',
    from: '<script src="/js/skillicons.js"></script>\n',
    to: '',
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

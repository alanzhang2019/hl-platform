// 校验：57 个图标都能渲染成合法 SVG，无 undefined/NaN，viewBox 正确
const fs = require('fs');
const code = fs.readFileSync('public/js/skillicons.js', 'utf8');
const win = {};
new Function('window', code)(win);
const SI = win.HL.skillIcons;
let pass = 0, fail = 0;
const chk = (c, m) => { if (c) { pass++; } else { fail++; console.log('  ✗ ' + m); } };

console.log('== A 组：模块与兜底 ==');
chk(typeof SI === 'object' && SI, 'HL.skillIcons 存在');
chk(typeof SI.icon === 'function', 'icon() 是函数');
chk(SI.NAMES.length === 57, 'NAMES 长度 57，实际 ' + SI.NAMES.length);

console.log('== B 组：逐个图标合法性 ==');
for (const n of SI.NAMES) {
  const s = SI.icon(n);
  chk(typeof s === 'string' && s.length > 60, n + ' 有内容');
  chk(s.startsWith('<svg class="ski"'), n + ' 以 svg.ski 开头');
  chk(s.indexOf('viewBox="0 0 24 24"') > 0, n + ' viewBox 正确');
  chk(s.indexOf('stroke="currentColor"') > 0, n + ' 用 currentColor');
  chk(s.indexOf('fill="none"') > 0, n + ' fill none');
  chk(s.indexOf('undefined') < 0, n + ' 不含 undefined');
  chk(!/NaN|Infinity/.test(s), n + ' 不含 NaN/Infinity');
  // 标签配平：内部元素全为自闭合；outer <svg> 单独收尾。
  // 注意 <svg ...> 本身不是自闭合（它配对 </svg>），所以 open 应比 close 恰好多 1。
  const inner = s.slice(s.indexOf('>') + 1, s.lastIndexOf('</svg>'));
  const open = (inner.match(/<(path|circle|line)\b/g) || []).length;
  const close = (inner.match(/\/>/g) || []).length;
  chk(open === close, n + ' 内部元素自闭合配平 ' + open + '/' + close);
  chk(s.endsWith('</svg>'), n + ' 以 </svg> 结尾');
}

console.log('== C 组：兜底与异常输入 ==');
const fb = SI.icon('这个图标不存在');
chk(fb.indexOf('<svg') === 0 && fb.indexOf('undefined') < 0, '未知名字返回兜底 SVG');
chk(fb === SI.icon(undefined), 'undefined 也走兜底');
chk(fb === SI.icon(''), '空串也走兜底');
chk(SI.has('feynman') === true, 'has(feynman)=true');
chk(SI.has('nope') === false, 'has(nope)=false');

console.log('== D 组：名字唯一、无重复键 ==');
const raw = fs.readFileSync('public/js/skillicons.js', 'utf8');
const body = raw.slice(raw.indexOf('const ICONS = {'), raw.indexOf('const FALLBACK'));
const keys = [...body.matchAll(/^\s{4}([a-z]+):/gm)].map(m => m[1]);
chk(new Set(keys).size === keys.length, '没有重复键');
chk(keys.length === 57, '恰好 57 键');

console.log('== E 组：不含外部资源与危险调用 ==');
chk(raw.indexOf('http://') < 0 && raw.indexOf('https://') < 0, '不引外部资源');
chk(!/\beval\b|new Function|innerHTML/.test(raw), '无 eval/innerHTML');

console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail ? 1 : 0);

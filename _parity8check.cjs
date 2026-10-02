'use strict';
/**
 * 批次8 自检（静态）：对话空状态重做。
 *
 * 空状态是「打开产品的前 5 秒」，改坏了没人会报错 —— 只是学生进来不知道问什么然后走掉。
 * 所以这里把三件容易悄悄坏掉的事钉死：
 *
 *   1. **静态兜底与 JS 模板不许漂移**。空状态在两处各写了一份：
 *      `index.html` 的静态兜底（有历史对话的返回用户，在 boot 的 await 期间会看到它）
 *      和 `app.js` 的 `renderStreamEmpty()`。改了一处忘了另一处，
 *      结果就是"闪一下错版再被换掉"——肉眼极难发现，测试能。
 *   2. **点击只预填，不直接发送**。直接发送等于替学生决定了怎么问，
 *      而"把问题说清楚"本身就是学习的一部分。
 *   3. **四张卡必须走对话、不跨模块**。新空间只解锁了对话/项目/资料/知识卡
 *      （批次7 的阶段门控），做一张"去背单词"的卡会直接撞上锁。
 *
 * 不起服务，只读文件。
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
const APPJS = fs.readFileSync(path.join(ROOT, 'public', 'js', 'app.js'), 'utf8');
const HTML = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const CSS = fs.readFileSync(path.join(ROOT, 'public', 'app.css'), 'utf8');

/** 从源码里切出 `const NAME = [...];` 的字面量并求值。
 *  不用正则硬啃嵌套 —— 扫一遍括号深度 + 字符串状态，稳。 */
function sliceLiteral(src, decl) {
  const i = src.indexOf(decl);
  if (i < 0) return null;
  const start = src.indexOf('[', i);
  if (start < 0) return null;
  let depth = 0, q = null, esc = false;
  for (let k = start; k < src.length; k++) {
    const c = src[k];
    if (esc) { esc = false; continue; }
    if (q) {
      if (c === '\\') { esc = true; continue; }
      if (c === q) q = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { q = c; continue; }
    if (c === '[') depth++;
    else if (c === ']') { depth--; if (depth === 0) return src.slice(start, k + 1); }
  }
  return null;
}

/** 切出 `const NAME = 'a' + 'b';` 这种字符串拼接并求值 */
function sliceConcat(src, decl) {
  const i = src.indexOf(decl);
  if (i < 0) return null;
  const eq = src.indexOf('=', i);
  const end = src.indexOf(';\n', eq);
  if (eq < 0 || end < 0) return null;
  const expr = src.slice(eq + 1, end).trim();
  try { return Function('return ' + expr)(); } catch (e) { return null; }
}

// ---------- 0. 能切出来 ----------
group('0. 源码可解析');
const CARDS = sliceLiteral(APPJS, 'const EMPTY_CARDS = [');
let cards = null;
try { cards = CARDS ? Function('return ' + CARDS)() : null; } catch (e) { cards = null; }
ok('能切出 EMPTY_CARDS 并求值', Array.isArray(cards) && cards.length === 4,
  cards ? cards.length + ' 张' : '切不出来');

const ART = sliceConcat(APPJS, 'const EMPTY_ART');
ok('能切出 EMPTY_ART', typeof ART === 'string' && ART.length > 200,
  typeof ART + ' len=' + (ART ? ART.length : 0));

if (!cards || !ART) { console.log('\n切不出源码，后面的断言没法跑'); process.exit(1); }

// ---------- A. 四张卡本身 ----------
group('A. 四张卡');
ok('正好四张', cards.length === 4, cards.length);
ok('key 唯一', new Set(cards.map(c => c.k)).size === 4, cards.map(c => c.k));
ok('key 都是 [a-z]+', cards.every(c => /^[a-z]+$/.test(c.k)), cards.map(c => c.k));
ok('每张都有标题', cards.every(c => c.t && c.t.length >= 2 && c.t.length <= 6), cards.map(c => c.t));
ok('每张都有说明', cards.every(c => c.d && c.d.length >= 8), cards.map(c => c.d));
ok('每张都有预填文案', cards.every(c => c.p && c.p.length >= 4), cards.map(c => c.p));
ok('每张都有图标 path', cards.every(c => c.i && c.i.indexOf('<path') >= 0 || c.i.indexOf('<circle') >= 0), null);
ok('图标都是 24 视图框内的自绘 SVG（不是 emoji / 不是外链）',
  cards.every(c => c.i.indexOf('<image') < 0 && c.i.indexOf('http') < 0), null);

// 预填文案以「：」结尾 —— 邀请学生自己往下补，而不是替他问完
ok('★ 预填文案都以「：」结尾（邀请学生自己补完，不替他问完）',
  cards.every(c => /：$/.test(c.p)), cards.map(c => c.p));

// ★ 四张卡必须都能在"阶段1"用（只解锁了对话/项目/资料/知识卡）
ok('★ 四张卡都不跨模块跳转（新空间只解锁了对话，跳转会撞上锁）',
  !/switchView|setKbSub|data-view|data-sub/.test(CARDS), null);
ok('★ 卡片文案里不出现英语/测评/共享池等未解锁模块的名字',
  !cards.some(c => /英语|测评|共享池|看板|能力中心/.test(c.t + c.d)), cards.map(c => c.t + c.d));

// ---------- B. 静态兜底 vs JS 模板：不许漂移 ----------
group('B. 静态兜底与 JS 模板一致（★ 最容易悄悄坏的一条）');
const staticEmpty = (() => {
  const i = HTML.indexOf('id="streamEmpty"');
  if (i < 0) return '';
  const start = HTML.lastIndexOf('<div class="empty"', i);
  return start < 0 ? '' : HTML.slice(start, HTML.indexOf('</div>\n        </div>', start));
})();
ok('能从 index.html 切出静态空状态', staticEmpty.length > 500, staticEmpty.length);

['empty-art', 'empty-hi', 'empty-ask', 'empty-stance', 'empty-cards', 'empty-tips'].forEach(c => {
  ok('静态兜底有 .' + c, staticEmpty.indexOf(c) >= 0, null);
  ok('JS 模板有 .' + c, APPJS.indexOf("'" + c) >= 0 || APPJS.indexOf(c) >= 0, null);
});
['ec-i', 'ec-d'].forEach(c => {
  ok('静态兜底有 .' + c, staticEmpty.indexOf(c) >= 0, null);
  ok('JS 模板有 .' + c, APPJS.indexOf(c) >= 0, null);
});

// 四张卡的 key 两边必须一致
const htmlKeys = (staticEmpty.match(/data-ec="([a-z]+)"/g) || []).map(s => /"([a-z]+)"/.exec(s)[1]);
ok('静态兜底有四张卡', htmlKeys.length === 4, htmlKeys);
ok('★ 两处的卡片 key 完全一致（顺序也一致）',
  htmlKeys.join(',') === cards.map(c => c.k).join(','),
  { html: htmlKeys, js: cards.map(c => c.k) });

// 标题与说明文案两边必须一致
cards.forEach(c => {
  ok('静态兜底有标题「' + c.t + '」', staticEmpty.indexOf('>' + c.t + '<') >= 0, null);
  ok('静态兜底有说明「' + c.d + '」', staticEmpty.indexOf(c.d) >= 0, null);
});

// 视觉主体必须逐字节一致
const artPaths = (ART.match(/d="[^"]+"/g) || []).map(s => s.slice(3, -1));
ok('JS 视觉主体有 5 条 path（茎 1 + 叶 2 + 浪 2）', artPaths.length === 5, artPaths.length);
const missing = artPaths.filter(d => staticEmpty.indexOf('"' + d + '"') < 0);
ok('★ 静态兜底与 JS 的视觉主体逐条 path 一致', missing.length === 0, missing);

// ---------- C. 交互：预填，不发送 ----------
group('C. 点击只预填');
ok('用事件委托绑定（renderStreamEmpty 会重写 innerHTML，逐卡绑定会失效）',
  /\$\('#stream'\)\.addEventListener\('click'/.test(APPJS), null);
ok('按 data-ec 找到对应卡片', /\$\('#stream'\)\.addEventListener\('click'[\s\S]{0,400}?dataset\.ec/.test(APPJS), null);
ok('把预填文案写进输入框', /inp\.value = c\.p/.test(APPJS), null);
ok('★ 点击不直接发送（不调用 send()）',
  !/\$\('#stream'\)\.addEventListener\('click'[\s\S]{0,600}?send\(\)/.test(APPJS), null);
ok('派发 input 事件让 autoGrow 跟着长高（直接赋值 .value 不会触发）',
  /inp\.dispatchEvent\(new Event\('input'/.test(APPJS), null);
ok('预填后聚焦并落光标到末尾', /inp\.focus\(\)/.test(APPJS) && /setSelectionRange/.test(APPJS), null);

// ---------- D. 样式 ----------
group('D. 样式');
['.empty-art', '.empty-hi', '.empty-ask', '.empty-stance', '.empty-cards', '.ec ', '.ec:hover', '.ec-i', '.ec-d']
  .forEach(c => ok('CSS 里有 ' + c.trim(), CSS.indexOf(c) >= 0, null));
ok('空状态是四列网格', /\.empty-cards \{[\s\S]{0,160}?grid-template-columns: repeat\(4, minmax\(0, 1fr\)\)/.test(CSS), null);
ok('窄屏收成两列', /@media \(max-width: 820px\) \{[\s\S]*?\.empty-cards \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/.test(CSS), null);
ok('视觉主体跟随主题色 var(--pri)', ART.indexOf('var(--pri)') >= 0, null);
ok('视觉主体不引外部位图（零依赖）', ART.indexOf('<image') < 0 && ART.indexOf('http') < 0, null);

// ---------- E. 旧实现已彻底清除 ----------
group('E. 旧实现清干净了');
ok('CSS 里没有 .empty-mark', CSS.indexOf('.empty-mark') < 0, null);
ok('CSS 里没有 breathe 关键帧', CSS.indexOf('breathe') < 0, null);
ok('HTML 里没有 .empty-mark', HTML.indexOf('empty-mark') < 0, null);
ok('app.js 里没有 .empty-mark', APPJS.indexOf('empty-mark') < 0, null);
ok('旧的「先说一件你今天想弄明白的事」已移除', APPJS.indexOf('先说一件你今天想弄明白的事') < 0, null);
ok('HTML 里没有重复的 id="emptyTips"（静态兜底与 JS 各来一份会撞）',
  (HTML.match(/id="emptyTips"/g) || []).length === 0, null);

// ---------- F. 立场没丢 ----------
group('F. 教育立场还在');
ok('★ 空状态仍明说「不直接给答案」', /我不会直接给你答案/.test(APPJS), null);
ok('静态兜底也写了这句', staticEmpty.indexOf('我不会直接给你答案') >= 0, null);
ok('大标题带空间名（「你好，{姓名}」）', /你好' \+ \(nm \? '，' \+ HL\.esc\(nm\) : ''\)/.test(APPJS), null);
ok('没有空间名时降级为「你好」而不是「你好，undefined」', /nm \? '，'/.test(APPJS), null);

console.log('');
if (fails.length) fails.slice(0, 40).forEach(f => console.log('  ✗ ' + f));
console.log('PASS  通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail ? 1 : 0);

'use strict';
/**
 * 渲染管线自检（render.js）
 *
 * 为什么单独测：render.js 是前端唯一"有逻辑"的部分——Markdown、轻量 TeX、
 * 代码高亮、以及最关键的 svg-json → 原生 SVG。它没有构建步骤、没有类型检查，
 * 一旦坏了只有在浏览器里肉眼才能发现。这里用假的 window 把它跑在 Node 里。
 *
 * 跑法：node _rendertest.cjs
 */
const fs = require('fs');
const path = require('path');

// 造一个最小 window，把 render.js 原样跑起来（不修改源码、不做转译）
const win = {};
new Function('window', fs.readFileSync(path.join(__dirname, 'public/js/render.js'), 'utf8'))(win);
const HL = win.HL;

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  \u2713 ' + name); }
  else { fail++; failures.push(name + (extra ? ' → ' + (typeof extra === 'string' ? extra : JSON.stringify(extra)) : '')); console.log('  \u2717 ' + name + (extra ? ' → ' + (typeof extra === 'string' ? extra : JSON.stringify(extra)) : '')); }
}
function group(t) { console.log('\n' + t); }
const has = (h, s) => h.indexOf(s) >= 0;

console.log('渲染管线自检（render.js）');

// ---------- 1. 转义与安全 ----------
group('1. 转义（AI 输出里出现 HTML 不能被执行）');
{
  const h = HL.render('看这个 <script>alert(1)</script> 标签');
  ok('script 标签被转义', has(h, '&lt;script&gt;') && !has(h, '<script>'));
  const h2 = HL.render('<img src=x onerror=alert(1)>');
  ok('img onerror 被转义', !has(h2, '<img src=x'));
  const h3 = HL.render('属性注入 " onmouseover="x');
  ok('双引号被转义', has(h3, '&quot;'));
  const h4 = HL.render('[点我](javascript:alert(1))');
  ok('链接保留但内容转义（不产生可执行内联脚本）', !has(h4, '<script'));
  const h5 = HL.render('```\n<b>raw</b>\n```');
  ok('代码块里的标签被转义', has(h5, '&lt;b&gt;'));
}

// ---------- 2. Markdown 块级 ----------
group('2. Markdown 块级');
{
  ok('标题 h1', has(HL.render('# 一级'), '<h1>一级</h1>'));
  ok('标题 h3', has(HL.render('### 三级'), '<h3>三级</h3>'));
  ok('六级标题降级到 h4（不让正文里出现 h5/h6）', has(HL.render('###### 六级'), '<h4>六级</h4>'));
  ok('无序列表', has(HL.render('- 甲\n- 乙'), '<ul><li>甲</li><li>乙</li></ul>'));
  ok('有序列表', has(HL.render('1. 甲\n2. 乙'), '<ol>'));
  ok('引用块', has(HL.render('> 引用内容'), '<blockquote><p>引用内容</p></blockquote>'));
  ok('分割线', has(HL.render('---'), '<hr>'));
  ok('段落', has(HL.render('就是一句话'), '<p>就是一句话</p>'));
  const t = HL.render('| 列A | 列B |\n| --- | --- |\n| 1 | 2 |');
  ok('表格 thead', has(t, '<thead><tr><th>列A</th><th>列B</th></tr></thead>'));
  ok('表格 tbody', has(t, '<tbody><tr><td>1</td><td>2</td></tr></tbody>'));
  ok('段落内换行变 <br>', has(HL.render('第一行\n第二行'), '<br>'));
  const nested = HL.render('- 甲\n  - 甲一');
  ok('嵌套列表产生内层 ul', (nested.match(/<ul>/g) || []).length >= 2, nested);
}

// ---------- 3. 行内 ----------
group('3. Markdown 行内');
{
  ok('粗体', has(HL.render('这是**重点**内容'), '<strong>重点</strong>'));
  ok('斜体', has(HL.render('这是*强调*内容'), '<em>强调</em>'));
  ok('粗斜体', has(HL.render('***都要***'), '<strong><em>都要</em></strong>'));
  ok('删除线', has(HL.render('~~划掉~~'), '<del>划掉</del>'));
  ok('行内代码', has(HL.render('用 `npm start` 启动'), '<code class="inl">npm start</code>'));
  ok('链接', has(HL.render('[文档](https://x.test/a)'), '<a href="https://x.test/a"'));
  ok('链接带 noopener', has(HL.render('[文档](https://x.test/a)'), 'rel="noopener noreferrer"'));
  ok('图片', has(HL.render('![图](a.png)'), '<img src="a.png"'));
  ok('行内代码里的星号不被当粗体', has(HL.render('`a*b*c`'), '<code class="inl">a*b*c</code>'));
  ok('粗体里嵌行内代码', has(HL.render('**用 `x` 就行**'), '<strong>用 <code class="inl">x</code> 就行</strong>'));
}

// ---------- 4. 代码块与高亮 ----------
group('4. 代码块与高亮');
{
  const js = HL.render('```js\nconst a = 1; // 注释\n```');
  ok('代码块容器', has(js, 'class="code-wrap"'));
  ok('语言标签', has(js, '<span>js</span>'));
  ok('带复制按钮', has(js, 'class="code-copy"'));
  ok('关键字高亮', has(js, 'tk-k'));
  ok('注释高亮', has(js, 'tk-c'));
  ok('数字高亮', has(js, 'tk-n'));
  const py = HL.render('```python\ndef f():\n    return "x"\n```');
  ok('python 关键字', has(py, 'tk-k'));
  ok('python 字符串', has(py, 'tk-s'));
  const json = HL.render('```json\n{"k": 1, "s": "v"}\n```');
  ok('json 键高亮为 tk-f', has(json, 'tk-f'));
  ok('json 值字符串为 tk-s', has(json, 'tk-s'));
  const plain = HL.render('```\n随便什么\n```');
  ok('无语言时也成块', has(plain, 'class="code-wrap"'));
  ok('无语言时不报错且内容在', has(plain, '随便什么'));
}

// ---------- 5. 流式：未闭合围栏 ----------
group('5. 流式容错（半截文本不能把 JSON 当正文渲染）');
{
  const streaming = HL.render('好的，我先画个图：\n\n```svg-json\n{"kind":"mindmap","title":"半截","nodes":[{"id":"a","label":"中心"');
  ok('未闭合的 svg-json 不抛异常', typeof streaming === 'string');
  ok('未闭合时绝不把原始 JSON 当正文吐出来', !has(streaming, '&quot;kind&quot;') && !has(streaming, '&quot;nodes&quot;'));
  // 两种可接受结果，取其一即可：
  //   a) 补括号后当场画出真图（更好，图会随 token 逐渐长出来）
  //   b) 还画不出来时显示"正在生成图示…"骨架
  const earlyArt = has(streaming, '<svg');
  const skeleton = has(streaming, '正在生成图示');
  ok('未闭合时要么提前出图、要么显示生成中（不留空白也不吐 JSON）', earlyArt || skeleton,
    earlyArt ? '提前出图' : skeleton ? '显示生成中' : streaming.slice(0, 120));
  ok('未闭合时不该同时出现两种形态', !(earlyArt && skeleton));
  const unclosedCode = HL.render('```js\nconst a = 1;');
  ok('未闭合的普通代码块仍渲染成代码块', has(unclosedCode, 'class="code-wrap"'));
}

// ---------- 6. svg-json → 原生 SVG（核心约定）----------
group('6. svg-json → 原生 SVG');
{
  const svgOf = obj => HL.render('```svg-json\n' + JSON.stringify(obj) + '\n```');

  const mind = svgOf({
    kind: 'mindmap', title: '分数',
    nodes: [{ id: 'r', label: '分数' }, { id: 'a', label: '分子' }, { id: 'b', label: '分母' }],
    edges: [{ from: 'r', to: 'a', label: '上面' }, { from: 'r', to: 'b', label: '下面' }],
  });
  ok('思维导图产出 <svg>', has(mind, '<svg'));
  ok('思维导图带 viewBox', has(mind, 'viewBox="0 0'));
  ok('思维导图渲染出全部节点文字', has(mind, '分数') && has(mind, '分子') && has(mind, '分母'));
  ok('思维导图连线带箭头 marker', has(mind, 'marker-end="url(#hlArrow)"'));
  ok('思维导图边标签渲染', has(mind, '上面'));
  ok('图示块带标题与类型名', has(mind, '思维导图'));
  ok('svg 带无障碍标签', has(mind, 'role="img"') && has(mind, 'aria-label='));
  ok('图示容器 class="art"', has(mind, 'class="art"'));

  const flow = svgOf({ kind: 'flow', title: '解题步骤', nodes: [{ id: '1', label: '读题' }, { id: '2', label: '找条件' }, { id: '3', label: '列式' }], edges: [{ from: '1', to: '2' }, { from: '2', to: '3' }] });
  ok('流程图产出 svg', has(flow, '<svg'));
  ok('流程图类型名', has(flow, '流程图'));
  ok('流程图三节点都在', has(flow, '读题') && has(flow, '找条件') && has(flow, '列式'));

  const tl = svgOf({ kind: 'timeline', title: '时间线', items: [{ time: '1839', desc: '第一张照片' }, { time: '1900', desc: '普及' }] });
  ok('时间轴产出 svg', has(tl, '<svg'));
  ok('时间轴类型名', has(tl, '时间轴'));
  ok('时间轴条目渲染', has(tl, '1839') && has(tl, '第一张照片'));

  const geo = svgOf({ kind: 'geometry', title: '三角形', points: [{ x: 0, y: 0, label: 'A' }, { x: 6, y: 0, label: 'B' }, { x: 0, y: 4, label: 'C' }], segments: [['A', 'B'], ['B', 'C'], ['C', 'A']] });
  ok('几何图形产出 svg', has(geo, '<svg'));
  ok('几何类型名', has(geo, '几何图形'));
  ok('几何顶点标签渲染', has(geo, 'A') && has(geo, 'B') && has(geo, 'C'));
  ok('几何连线渲染（按标签连线的 line）', has(geo, '<line'));
  const geoC = (geo.match(/<line/g) || []).length;
  ok('三条边都画出来了', geoC === 3, 'line 数 ' + geoC);
  const geoCoordSeg = svgOf({ kind: 'geometry', title: '坐标线段', points: [{ x: 0, y: 0 }], segments: [[0, 0, 10, 10]] });
  ok('segments 也支持直接给坐标 [x1,y1,x2,y2]', (geoCoordSeg.match(/<line/g) || []).length === 1, geoCoordSeg.slice(0, 200));
  const geoObjSeg = svgOf({ kind: 'geometry', title: '对象写法', points: [{ x: 0, y: 0, label: 'P' }, { x: 5, y: 5, label: 'Q' }], segments: [{ from: 'P', to: 'Q' }] });
  ok('segments 支持 {from,to} 对象写法', (geoObjSeg.match(/<line/g) || []).length === 1);
  const geoBadSeg = svgOf({ kind: 'geometry', title: '悬空引用', points: [{ x: 0, y: 0, label: 'P' }], segments: [['P', '不存在']] });
  ok('引用不存在的顶点时跳过该线段而不是抛错', typeof geoBadSeg === 'string');
  ok('几何图默认不画坐标轴（三角形顶点常在原点，轴会和边重叠）', !has(geo, 'marker-end="url(#hlArrow)"'));
  const geoAxes = svgOf({ kind: 'geometry', title: '函数图像', axes: true, points: [{ x: 0, y: 0, label: 'O' }, { x: 5, y: 5, label: 'P' }], segments: [['O', 'P']] });
  ok('显式写 axes:true 时才画坐标轴', has(geoAxes, 'marker-end="url(#hlArrow)"'));
  const geoCircles = svgOf({ kind: 'geometry', title: '圆', circles: [{ x: 50, y: 50, r: 20 }], labels: [{ x: 50, y: 50, text: 'O' }] });
  ok('几何支持圆与文字标注', has(geoCircles, '<circle') && has(geoCircles, 'O'));
  // 标注落在顶点范围之外时，坐标范围必须把它算进去（否则会被 viewBox 裁掉）
  const geoOutLabel = svgOf({
    kind: 'geometry', title: '带标注', points: [{ x: 0, y: 0, label: 'A' }, { x: 6, y: 0, label: 'B' }, { x: 0, y: 4, label: 'C' }],
    segments: [['A', 'B'], ['B', 'C'], ['C', 'A']], labels: [{ x: 3, y: -2, text: '底 6' }],
  });
  ok('图外标注被纳入渲染', has(geoOutLabel, '底 6'));
  const vb = /viewBox="0 0 (\d+) (\d+)"/.exec(geoOutLabel);
  const geoPlain = /viewBox="0 0 (\d+) (\d+)"/.exec(geo);
  ok('加了图外标注后画布变高（说明范围真的重算了）', vb && geoPlain && Number(vb[2]) >= Number(geoPlain[2]),
    'with=' + (vb && vb[2]) + ' without=' + (geoPlain && geoPlain[2]));
  const geoCirclesOnly = svgOf({ kind: 'geometry', title: '只有圆', circles: [{ x: 0, y: 0, r: 5 }] });
  ok('只给圆不给点时也能画', has(geoCirclesOnly, '<circle'));

  // ★ 真机复现过的坑（2026-10-01）：模型写 polygons:[["A","B","C"]]（顶点名），
  //   而渲染器只把多边形当坐标点读 → p.x 是 undefined → d="MNaN NaN LNaN NaN LNaN NaN Z"。
  //   它**不抛错**，只是静默画出一条废路径 + 控制台刷 14 条报错，图里的三角形凭空消失。
  //   多边形必须和 segments 一样认顶点名。
  const geoPolyName = svgOf({
    kind: 'geometry', title: '按顶点名围合',
    points: [{ x: 30, y: 80, label: 'A' }, { x: 15, y: 25, label: 'B' }, { x: 85, y: 25, label: 'C' }, { x: 30, y: 25, label: 'D' }],
    polygons: [['A', 'B', 'C']], segments: [['A', 'D']],
  });
  ok('polygons 支持顶点名围合（模型最常这么写），且不含 NaN',
    has(geoPolyName, '<path') && !has(geoPolyName, 'NaN'), geoPolyName.slice(0, 260));
  const geoPolyCoord = svgOf({
    kind: 'geometry', title: '按坐标围合',
    polygons: [[{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 5, y: 8 }]],
  });
  ok('polygons 也支持直接给坐标点', has(geoPolyCoord, '<path') && !has(geoPolyCoord, 'NaN'));
  const geoPolyBad = svgOf({
    kind: 'geometry', title: '够不成面',
    points: [{ x: 0, y: 0, label: 'A' }, { x: 1, y: 1, label: 'B' }],
    polygons: [['A', 'B', '不存在']],
  });
  ok('多边形解析不出 ≥3 个点时整条丢掉，不产出 NaN', !has(geoPolyBad, 'NaN'));
  const geoNullCoord = svgOf({
    kind: 'geometry', title: '缺 y 的点',
    points: [{ x: 0, y: 0, label: 'A' }, { x: 5, label: 'B' }], segments: [['A', 'B']],
  });
  ok('顶点缺坐标时跳过该线段，不污染整张图', !has(geoNullCoord, 'NaN'));

  const bars = svgOf({ kind: 'bars', title: '对比', items: [{ label: '甲', value: 30 }, { label: '乙', value: 70 }] });
  ok('条形对比产出 svg', has(bars, '<svg'));
  ok('条形对比类型名', has(bars, '条形对比'));
  ok('条形对比数值渲染', has(bars, '30') && has(bars, '70'));

  const tree = svgOf({ nodes: [{ id: 'r', label: '根' }, { id: 'c', label: '叶' }], edges: [{ from: 'r', to: 'c' }] });
  ok('没有 kind 但有 nodes 时按节点图渲染', has(tree, '<svg'));

  // ---------- 网格：方格取数这类题的专用档 ----------
  // 背景：模型曾用 geometry 画网格题 → 几个孤立点 + 几个游离数字，学生看不懂。
  // grid 的唯一正确画法是把每个格子的数**都填出来**，所以断言必须验"数字真的在格子里"。
  const gd = svgOf({
    kind: 'grid', title: '方格取数',
    cells: [['1', '2', '3'], ['4', '5', '6'], ['7', '8', '9']],
    marks: [{ r: 0, c: 0, label: 'A' }, { r: 2, c: 2, label: 'B' }],
  });
  ok('grid 产出 svg', has(gd, '<svg'));
  ok('grid 类型名', has(gd, '网格数表'));
  ['1', '2', '3', '4', '5', '6', '7', '8', '9'].forEach(n =>
    ok('  格子里的数字都真的画出来了：' + n, has(gd, '>' + n + '<')));
  ok('marks 的标签渲染出来了', has(gd, '>A<') && has(gd, '>B<'));
  ok('grid 不含 NaN', !has(gd, 'NaN'));

  const gdStr = svgOf({ kind: 'grid', title: '字符串行', rows: ['7,3,5', '2,9,4'] });
  ok('行写成 "7,3,5" 也能解析', has(gdStr, '<svg') && has(gdStr, '>7<') && has(gdStr, '>9<'));

  const gdNoKind = svgOf({ cells: [['甲', '乙'], ['丙', '丁']] });
  ok('没写 kind 但有 cells 也按网格画', has(gdNoKind, '<svg') && has(gdNoKind, '>甲<'));

  const gdPath = svgOf({
    kind: 'grid', title: '走方格', cells: [[1, 2], [3, 4]],
    path: [[0, 0], [0, 1], [1, 1]],
  });
  ok('path 高亮不崩且无 NaN', has(gdPath, '<svg') && !has(gdPath, 'NaN'));

  // 脏输入：这些曾经会让 SVG 整块消失（NaN 静默）
  [ { kind: 'grid', cells: [] },
    { kind: 'grid', cells: [[]] },
    { kind: 'grid', cells: '不是数组' },
    { kind: 'grid', cells: [[null, undefined], [1]] },
    { kind: 'grid', cells: [['a']], marks: [{ r: 'x', c: 'y' }, null], path: [null, [NaN, NaN]] },
    { kind: 'grid', cells: [['一个特别长的格子内容会溢出']], colLabels: ['超长列标题'], rowLabels: ['超长行标题'] },
  ].forEach((dirty, i) => {
    const out = svgOf(dirty);
    ok('脏网格输入 #' + (i + 1) + ' 不产出 NaN', !has(out, 'NaN'), out.slice(0, 200));
  });

  const broken = HL.render('```svg-json\n{这不是 JSON}\n```');
  ok('坏 JSON 不抛异常', typeof broken === 'string');
  ok('坏 JSON 降级成代码块并给出说明', has(broken, '没能解析成图'));

  const empty = svgOf({ kind: 'mindmap', nodes: [] });
  ok('空节点不产出空 svg，降级成代码块', has(empty, '没能解析成图') || has(empty, '正在生成'));

  const longLabel = svgOf({ kind: 'flow', nodes: [{ id: 'a', label: '这是一个特别特别特别特别特别长的节点文字需要换行显示' }] });
  ok('超长标签会换行（出现多个 tspan/text）', (longLabel.match(/<text/g) || []).length >= 2, 'text 数 ' + (longLabel.match(/<text/g) || []).length);

  const special = svgOf({ kind: 'flow', nodes: [{ id: 'a', label: '<script>x</script>' }] });
  ok('节点文字里的 HTML 被转义', !has(special, '<script>') && has(special, '&lt;script&gt;'));
}

// ---------- 7. 轻量 TeX ----------
group('7. 轻量 TeX（自研，不依赖 KaTeX）');
{
  const frac = HL.render('$\\frac{1}{2}$');
  ok('分式渲染出 frac 结构', has(frac, 'class="frac"') && has(frac, 'class="num"') && has(frac, 'class="den"'));
  ok('分式分子分母内容正确', has(frac, '>1<') && has(frac, '>2<'));

  const sup = HL.render('$x^{2}$');
  ok('上标渲染', has(sup, '<sup>2</sup>'));
  const sub = HL.render('$a_{1}$');
  ok('下标渲染', has(sub, '<sub>1</sub>'));
  const sqrt = HL.render('$\\sqrt{9}$');
  ok('根号渲染', has(sqrt, 'class="sqrt"') && has(sqrt, '√'));
  const greek = HL.render('$\\pi \\theta \\alpha$');
  ok('希腊字母', has(greek, 'π') && has(greek, 'θ') && has(greek, 'α'));
  const ops = HL.render('$a \\times b \\div c \\le d$');
  ok('运算与关系符', has(ops, '×') && has(ops, '÷') && has(ops, '≤'));
  const block = HL.render('$$\\frac{a}{b}$$');
  ok('块级公式加 math-block', has(block, 'math-block'));
  const inline = HL.render('$x$ 是未知数');
  ok('行内公式不占块', !has(inline, 'math-block'));
  const nested = HL.render('$\\frac{\\sqrt{x}}{2}$');
  ok('嵌套结构不抛异常', has(nested, 'class="frac"') && has(nested, 'class="sqrt"'));
  const price = HL.render('这个 5 元，那个 10 元');
  ok('中文里的裸数字不被当成公式', !has(price, 'class="math"'), price);
  const text = HL.render('$\\text{速度}$');
  ok('\\text 原样输出', has(text, '速度'));
}

// ---------- 8. 工具方法 ----------
group('8. 工具方法');
{
  ok('esc 转义 & < > "', HL.esc('&<>"') === '&amp;&lt;&gt;&quot;');
  const arts = HL.extractArtifacts('前言\n```svg-json\n{"kind":"flow","nodes":[{"id":"a","label":"x"}]}\n```\n后记');
  ok('extractArtifacts 能取出结构化图', arts.length === 1 && arts[0].kind === 'flow');
  ok('extractArtifacts 对无图文本返回空数组', HL.extractArtifacts('没有图').length === 0);
  const p = HL.plain('# 标题\n\n这是**正文**内容 `code`\n\n```js\nvar x\n```', 30);
  ok('plain 去掉标记', !has(p, '#') && !has(p, '**') && !has(p, '`'), p);
  ok('plain 把代码块替换成占位', has(p, '图示'), p);
  ok('plain 截断到指定长度', HL.plain('一二三四五六七八九十', 4).length <= 4);
  ok('artName 映射中文名', HL.artName('mindmap') === '思维导图');
  ok('highlight 空输入不抛异常', HL.highlight('', 'js') === '');
  ok('render 空输入不抛异常', HL.render('') === '');
  ok('render null 不抛异常', HL.render(null) === '');
  ok('render 只有空行不抛异常', typeof HL.render('\n\n\n') === 'string');
}

// ---------- 9. 图表（原生 SVG）----------
group('9. 图表');
{
  const c = HL.chart({
    title: '每天的学习动作', type: 'bar',
    labels: ['2026-09-24', '2026-09-25', '2026-09-26'],
    series: [{ name: '对话', values: [1, 0, 4] }, { name: '练卡', values: [0, 3, 2] }],
  });
  ok('柱状图产出 svg', has(c, '<svg'));
  ok('带标题', has(c, '每天的学习动作'));
  ok('多序列带图例', has(c, 'class="chart-lg"'));
  ok('y 轴有刻度文字', has(c, '<text'));
  ok('x 轴标签被简写（去掉年份）', has(c, '09/24'), c.slice(0, 400));
  ok('柱子带 title 提示（可悬停看数值）', has(c, '<title>'));
  ok('柱状图有 rect', has(c, '<rect'));

  const l = HL.chart({ type: 'line', labels: ['a', 'b', 'c'], series: [{ name: 'x', values: [1, 5, 3] }] });
  ok('折线图产出 svg', has(l, '<svg'));
  ok('折线图有 path', has(l, '<path'));
  ok('折线图有数据点圆点', has(l, '<circle'));
  ok('折线图带面积填充', has(l, 'opacity=".1"'));

  // P8 动效钩子：图表要能被 CSS 驱动"生长"，而不是靠 JS 逐帧
  ok('柱子带 ch-bar 生长动画类', has(c, 'class="ch-bar"'));
  ok('柱子带错峰 animation-delay', /class="ch-bar" style="animation-delay:\d+ms"/.test(c));
  ok('折线带 ch-line 类', has(l, 'class="ch-line"'));
  ok('折线用 pathLength="1" 归一（任意长度都能用同一套 dasharray 动画）', has(l, 'pathLength="1"'));
  ok('数据点带 ch-dot 类', has(l, 'class="ch-dot"'));
  ok('面积带 ch-area 类', has(l, 'class="ch-area"'));
  const many = HL.chart({ labels: Array.from({ length: 40 }, (_, i) => 'd' + i), series: [{ values: Array.from({ length: 40 }, (_, i) => i + 1) }] });
  const delays = (many.match(/animation-delay:(\d+)ms/g) || []).map(x => Number(/(\d+)/.exec(x)[1]));
  ok('40 根柱子的错峰延迟被封顶（不会排到几秒后才演完）', delays.every(d => d <= 240), 'max=' + Math.max.apply(null, delays));

  ok('空 labels 返回空串', HL.chart({ labels: [], series: [{ values: [] }] }) === '');
  ok('空 series 返回空串', HL.chart({ labels: ['a'], series: [] }) === '');
  ok('全 0 数据不崩', typeof HL.chart({ labels: ['a', 'b'], series: [{ values: [0, 0] }] }) === 'string');
  ok('全 0 数据仍然画出坐标轴', has(HL.chart({ labels: ['a', 'b'], series: [{ values: [0, 0] }] }), '<line'));
  ok('null 配置不崩', HL.chart(null) === '');
  ok('标签里的 HTML 被转义', !has(HL.chart({ labels: ['<script>'], series: [{ values: [1] }] }), '<script>'));
  ok('序列名里的 HTML 被转义', !has(HL.chart({ labels: ['a'], series: [{ name: '<img>', values: [1] }, { name: 'b', values: [2] }] }), '<img>'));
  const big = HL.chart({ labels: Array.from({ length: 30 }, (_, i) => '2026-09-' + (i + 1)), series: [{ values: Array.from({ length: 30 }, (_, i) => i) }] });
  ok('30 个标签时不把 x 轴挤爆（标签数远少于数据点）', (big.match(/<text/g) || []).length < 25, 'text 数 ' + (big.match(/<text/g) || []).length);
}

// ---------- 10. 压力：不崩就行 ----------
group('10. 脏输入压力');
{
  const dirty = [
    '```svg-json\n```', '```svg-json\n[]\n```', '$\\frac{}{}$', '\\frac{1}{2} 没包美元',
    '**未闭合的粗体', '[未闭合的链接](', '| 表头 |\n| --- |\n| 无尾竖线',
    '- \n- \n', '> \n> \n', '###### ', '***', '$$$$', '\\', '```', '```js',
    '<svg><script/></svg>', '\u0000\u0001', '一二三四五六七八九十'.repeat(50),
  ];
  let crashed = 0;
  for (const d of dirty) {
    try { const r = HL.render(d); if (typeof r !== 'string') crashed++; }
    catch (e) { crashed++; console.log('    崩溃输入：' + JSON.stringify(d.slice(0, 30)) + ' → ' + e.message); }
  }
  ok('17 组脏输入全部不崩', crashed === 0, crashed + ' 组崩溃');
  // 脏输入除了"不能崩"，还"不能吐出 NaN" —— NaN 不会抛错，只会静默画出一条废路径，
  // 肉眼在满屏 SVG 里极难发现，只有控制台报错能提示。这里把它钉死。
  let nanIn = 0;
  for (const d of dirty) { try { if (has(HL.render(d), 'NaN')) nanIn++; } catch (e) {} }
  ok('脏输入不产出 NaN', nanIn === 0, nanIn + ' 组含 NaN');
}

console.log('\n' + '─'.repeat(58));
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
if (fail) { console.log('\n失败明细：'); failures.forEach(f => console.log('  · ' + f)); }
process.exit(fail ? 1 : 0);

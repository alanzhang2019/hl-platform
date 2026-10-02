'use strict';
/**
 * 批次15 自检：学习计划海报（Canvas 端合成，public/js/poster.js）。
 *
 * 背景（2026-10-02）：
 *   用户要求"用 AI 生成最终计划图"。实测可灵 o1 直接画中文的错字率约 30%
 *   （"百分数"→"百数分"、卡片里蹦出乱码、"圆与扇形"→"圆柱与扇形"），
 *   教育材料有一个错字就废掉 —— 所以 AI 不能当文字真源。
 *   定的分工：模型出结构化数据（批次14），海报由 Canvas + 系统字体画字，
 *   汉字 100% 准确、不用等生图队列、断网也能出图。
 *
 * 覆盖：
 *   1) 渲染器 —— 导出 / 固定 1080 宽 / 高度随内容 / 只认 planPoster 一个入口
 *   2) ★ 脏输入 —— null·空 days·混入非对象·超长文本·缺字段 全都不许崩，且不许把 NaN 画进画布
 *   3) 越界防护 —— 标题与正文都有截断，长文本不能顶出画布
 *   4) 离线 —— 不许有 fetch / XHR / 外部字体（断网、没额度时也要能出图）
 *   5) 接线 —— 计划卡有按钮、app.js 有下载逻辑、index.html 引入顺序对
 *
 * 不起服务、不连外网、不花额度。
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0, fail = 0;
const fails = [];
function ok(cond, name, extra) {
  if (cond) { pass++; }
  else { fail++; fails.push(name + (extra !== undefined ? ' → ' + JSON.stringify(extra) : '')); }
}
const has = (s, sub) => String(s).indexOf(sub) >= 0;

const POSTER = fs.readFileSync(path.join(__dirname, 'public', 'js', 'poster.js'), 'utf8');
const RENDER = fs.readFileSync(path.join(__dirname, 'public', 'js', 'render.js'), 'utf8');
const APPJS = fs.readFileSync(path.join(__dirname, 'public', 'js', 'app.js'), 'utf8');
const HTML = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
const CSS = fs.readFileSync(path.join(__dirname, 'public', 'app.css'), 'utf8');

// ---------- 假 canvas：把每一次绘制调用录下来，事后审有没有 NaN ----------
function harness() {
  const calls = [];
  const mk = name => (...a) => { calls.push({ name, args: a }); };
  function makeCtx() {
    return {
      font: '', fillStyle: '', strokeStyle: '', textAlign: '', textBaseline: '',
      shadowColor: '', shadowBlur: 0, shadowOffsetY: 0, lineWidth: 1,
      measureText: t => ({ width: String(t == null ? '' : t).length * 18 }),
      createLinearGradient: () => ({ addColorStop() {} }),
      fillRect: mk('fillRect'), fillText: mk('fillText'), beginPath: mk('beginPath'),
      arc: mk('arc'), fill: mk('fill'), stroke: mk('stroke'), moveTo: mk('moveTo'),
      lineTo: mk('lineTo'), arcTo: mk('arcTo'), closePath: mk('closePath'),
      clip: mk('clip'), save: mk('save'), restore: mk('restore'), roundRect: mk('roundRect'),
    };
  }
  const canvas = { width: 0, height: 0, getContext: () => makeCtx() };
  const win = {};
  const sandbox = { window: win, document: { createElement: () => canvas }, console };
  vm.createContext(sandbox);
  vm.runInContext(POSTER, sandbox, { filename: 'poster.js' });
  return { win, canvas, calls };
}

/** 审核绘制调用：数字必须有限、字符串不许出现 NaN/undefined —— 静默的 NaN 会让整张图消失 */
function audit(calls) {
  const bad = [];
  calls.forEach(c => {
    c.args.forEach((a, i) => {
      if (typeof a === 'number' && !Number.isFinite(a)) bad.push(c.name + '[' + i + ']=' + String(a));
      if (typeof a === 'string' && /NaN|undefined/.test(a)) bad.push(c.name + '[' + i + ']="' + a + '"');
    });
  });
  return bad;
}

const GOOD = {
  title: '20天数学冲刺计划',
  subtitle: '每天 1 小时 · 分数 / 比 / 百分数 全过一遍',
  days: [
    { label: '第1-3天', theme: '分数四则运算', focus: '异分母加减先通分', points: ['同分母加减', '乘除法与约分'] },
    { label: '第4-6天', theme: '比与比例', focus: '按比例分配先求总份数', points: ['化简比', '比例尺'] },
    { label: '第7-9天', theme: '百分数应用', focus: '增加百分之几 = 差 ÷ 原来', points: ['折扣与税率'] },
  ],
  tips: ['百分数应用题是高频失分点', '先看例题再动手'],
};

console.log('\n批次15（学习计划海报）：');

// ---------- 1. 渲染器本体 ----------
{
  const h = harness();
  ok(typeof h.win.HL === 'object' && typeof h.win.HL.planPoster === 'function', 'planPoster 挂在 HL 上');
  const cv = h.win.HL.planPoster(GOOD, { date: '2026-10-02' });
  ok(!!cv, '正常数据能出 canvas');
  ok(cv && cv.width === 1080, '宽度固定 1080（竖版海报）', cv && cv.width);
  ok(cv && cv.height > 1000, '高度按条目数自适应', cv && cv.height);
  ok(has(POSTER, '后浪奔涌'), '落款带品牌名');
  ok(h.calls.some(c => c.name === 'fillText' && /20天数学冲刺计划/.test(String(c.args[0]))), '标题被真实画进画布');
  ok(h.calls.some(c => c.name === 'fillText' && /第1-3天/.test(String(c.args[0]))), '天数标签被画进画布');
}

// ---------- 2. ★ 脏输入：一个都不许崩 ----------
{
  const cases = [
    [null, 'null'],
    [{}, '空对象'],
    [{ days: [] }, '空 days'],
    [{ days: 'x' }, 'days 不是数组'],
    [{ days: [null, 0, 'a'] }, 'days 里全是垃圾'],
    [{ days: [{}] }, 'day 是空对象'],
    [{ days: [{ theme: '只有主题' }] }, '缺 label'],
    [{ days: [{ label: '第1天' }], tips: 'not-array' }, 'tips 不是数组'],
    [{ days: [{ label: '第1天' }], tips: [null, '', 3] }, 'tips 里是垃圾'],
    [{ title: 123, days: [{ label: 456, theme: null }] }, '字段类型全不对'],
    [{ days: Array.from({ length: 30 }, (_, i) => ({ label: 'D' + i, theme: 'T' + i })) }, '30 组超量'],
  ];
  let crashed = null, nan = null, empty = 0;
  for (const [spec, name] of cases) {
    const h = harness();
    try {
      const cv = h.win.HL.planPoster(spec);
      if (cv === null) { empty++; continue; }              // 数据不够就返回 null，是允许的
      ok(cv && typeof cv.width === 'number', '脏输入「' + name + '」返回了 canvas', cv && cv.width);
      const bad = audit(h.calls);
      if (bad.length && !nan) nan = name + ' → ' + bad.slice(0, 3).join(', ');
    } catch (e) { if (!crashed) crashed = name + ' → ' + e.message; }
  }
  ok(!crashed, '★ 脏输入一律不抛异常', crashed);
  ok(!nan, '★ 脏输入不会把 NaN 画进画布', nan);
  ok(empty >= 1, '数据不够时返回 null（不出空壳图）', empty);
}

// ---------- 3. 越界防护 ----------
{
  const h = harness();
  const long = '很长的标题'.repeat(40);
  const cv = h.win.HL.planPoster({
    title: long,
    subtitle: long,
    days: [{ label: long, theme: long, focus: long, points: [long, long] }],
  });
  ok(!!cv, '超长文本仍能出图');
  const texts = h.calls.filter(c => c.name === 'fillText').map(c => String(c.args[0]));
  ok(texts.every(t => t.length <= 48), '★ 所有绘制文本都被截断到安全长度（顶不出去）', Math.max(...texts.map(t => t.length)));
  ok(audit(h.calls).length === 0, '超长文本下依然没有 NaN');
  const xs = h.calls.filter(c => c.name === 'fillText').map(c => Number(c.args[1]));
  ok(xs.every(x => x >= 0 && x <= cv.width), '文字起点都在画布内', [Math.min(...xs), Math.max(...xs)]);
}

// ---------- 4. 离线（不许联网、不许外部字体） ----------
{
  ok(!/\bfetch\s*\(/.test(POSTER), 'poster.js 不调 fetch（断网也能出图）');
  ok(!/XMLHttpRequest/.test(POSTER), 'poster.js 不用 XHR');
  ok(!/@import|https?:\/\//.test(POSTER), 'poster.js 不引外部资源/字体（项目约定：只用系统字体栈）');
  ok(has(POSTER, 'Microsoft YaHei') && has(POSTER, 'Noto Sans SC'), '中文走系统字体栈');
  ok(!/require\s*\(|import\s/.test(POSTER), 'poster.js 是纯浏览器脚本，不引依赖');
}

// ---------- 5. 接线 ----------
{
  ok(has(RENDER, 'plan-save'), '计划卡渲染器里有「存成图片」按钮');
  ok(has(RENDER, 'data-spec='), 'spec 随按钮一起下发（消息重建也不丢）');
  ok(has(RENDER, 'encodeURIComponent(JSON.stringify('), 'spec 经过编码后才放进属性（防引号破坏 HTML）');
  ok(has(APPJS, 'HL.planPoster('), 'app.js 调的就是 poster.js 那个渲染器');
  ok(has(APPJS, "closest('.plan-save')"), '点击用事件委托绑（消息是动态插入的）');
  ok(has(APPJS, 'toBlob') && has(APPJS, 'download'), '走 toBlob + 浏览器下载');
  ok(has(APPJS, 'URL.revokeObjectURL'), '★ 用过的 objectURL 要回收，否则内存越用越大');
  ok(has(APPJS, "replace(/[\\\\/:*?\"<>|]/g"), '★ 下载文件名过滤非法字符（否则部分浏览器静默失败）');

  const iRender = HTML.indexOf('/js/render.js');
  const iPoster = HTML.indexOf('/js/poster.js');
  const iApp = HTML.indexOf('/js/app.js');
  ok(iRender >= 0 && iPoster > iRender && iApp > iPoster, 'index.html 引入顺序：render → poster → app', [iRender, iPoster, iApp]);

  ok(has(CSS, '.art-plan .art-h .plan-save'), '按钮样式在 app.css 里');
  ok(has(CSS, '.plan-save:hover'), '按钮有悬停反馈');
}

console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
if (fail) { console.log('\n失败清单：'); fails.forEach(f => console.log('  ✗ ' + f)); }
process.exit(fail ? 1 : 0);

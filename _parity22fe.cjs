'use strict';
/**
 * 批次22 前端接线：**数字逐项溯源**的静态断言（不启服务、不开浏览器）。
 *
 * 为什么必须有这一套：
 *   后端 evidenceByMetric 已经有模块级 + HTTP 测试，全绿；
 *   但"前端有没有把数字接上"是完全另一回事 ——
 *   恰好本项目的经典故障就是"后端全对、前端静默不接线"（点了没反应、零报错）。
 *   浏览器套件能抓，但它慢、且在本机磁盘吃紧时会被偶发卡死。
 *   所以这里用**源码静态断言**把接线钉死，浏览器套件负责端到端复核。
 *
 * ★ 断言的写法：断言"消费端会算出什么"，而不是"源码里出现过某个字符串"。
 *   比如「null 的数字不给 data-wm」要断言的是**生成逻辑的分支**，不是 grep 一下 wNumLink。
 */
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const APP = fs.readFileSync(path.join(ROOT, 'public/js/app.js'), 'utf8');
const CSS = fs.readFileSync(path.join(ROOT, 'public/app.css'), 'utf8');
const HTML = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');

let pass = 0, fail = 0;
const fails = [];
function ok(name, cond, extra) {
  if (cond) { pass++; }
  else { fail++; fails.push(name + (extra ? '  [' + extra + ']' : '')); }
}
function group(t) { console.log('\n== ' + t + ' =='); }

/**
 * ★ 静态断言的经典陷阱：**注释里写着反面例子，grep 会把它当成真的**。
 *   本项目好几处注释专门写「不能这样写」，比如 bindWeeklyNote 上方就写着
 *   "不能加 if (!$('#weeklyNoteSec')) return;"。
 *   不剥注释直接断言，就会把"防呆说明"判成"真的写错了" → 假红。
 *   这里粗暴地去掉 // 行注释与 /\* *\/ 块注释，只在"真代码"上断言。
 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')      // 块注释
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1'); // 行注释（避开 http:// 里的 //）
}
const APP_CODE = stripComments(APP);
const CSS_CODE = stripComments(CSS);

// ---------- A. 溯源入口：哪些指标可点、哪些不可点 ----------
group('A 溯源入口');

// 抽 renderWeekly 里定义 kpi 的那一段，直接看四个 m 值。
// ★ 不能用 /const kpi = \[([\s\S]*?)\]\.map/ —— 非贪婪会在**第一个 ]** 就收手，
//   而 kpi 数组元素里有 `s.subjects.length ? ... : []` 之类的方括号，
//   截出来的半截字符串会让"带没带 m"全部误判。改用"到 ].map(c => 为止"的定长匹配。
const kpiStart = APP_CODE.indexOf('const kpi = [');
const kpiEnd = APP_CODE.indexOf('].map(c =>', kpiStart);
const kpiBlock = kpiStart >= 0 && kpiEnd > kpiStart ? APP_CODE.slice(kpiStart, kpiEnd) : '';
ok('A1 kpi 结构里四个可溯源指标都带了 m 字段',
  /m: 'records'/.test(kpiBlock) && /m: 'reviews'/.test(kpiBlock) &&
  /m: 'cards'/.test(kpiBlock) &&
  // accuracy 是条件式赋值（见 A2），字面量长这样：m: s.accuracy === null ? null : 'accuracy'
  /m: s\.accuracy === null \? null : 'accuracy'/.test(kpiBlock),
  'kpiBlock 长度 ' + kpiBlock.length);

// accuracy 的 m 必须跟着 null 走：算不出来就不给入口（否则点开是空列表 = 骗人）
ok('A2 accuracy 为 null 时不给 m',
  /m: s\.accuracy === null \? null : 'accuracy'/.test(kpiBlock));

// 「有记录的天数」是两个不同东西的比，后端没有对应 metric ⇒ 绝不硬编
ok('A3 「有记录的天数」不给 m（后端无此 metric，硬编等于假溯源）',
  !/daysWithRecord[\s\S]{0,80}m:/.test(kpiBlock), 'found m near daysWithRecord');

// 渲染分支：有 m 走 wNumLink，没 m 走 wNum
ok('A4 有 m 用 wNumLink / 无 m 用 wNum 的分支存在',
  /c\.m \? wNumLink\([\s\S]{0,80}\) : wNum\(/.test(APP));

// ★ 核心：wNumLink 自己必须对 null 兜底（哪怕调用方漏了判 null）
const linkFn = (APP.match(/function wNumLink\([\s\S]*?\n  \}/) || [''])[0];
ok('B1 wNumLink 对 null/undefined 直接退化成 wNum（不给可点）',
  /if \(v === null \|\| v === undefined\) return wNum\(/.test(linkFn), linkFn.slice(0, 80));
ok('B2 wNumLink 生成的按钮带 data-wm（能被委托接住）',
  /data-wm="' \+ HL\.esc\(metric\)/.test(linkFn));
ok('B2b 数字包在 .w-ev-v 里（下划线只画数字那行，不与「明细」重叠）',
  /<span class="w-ev-v">/.test(linkFn));
// 0 必须可点：0 是"算得出来的 0"，点开看到空列表正是溯源要证明的
ok('B3 wNumLink 没有把 0 也排除掉（0 是可溯源的真事实）',
  !/v === 0|!v|v \?/.test(linkFn.replace(/v === null \|\| v === undefined/, '')), 'linkFn 里出现了 falsy 判断');

// ---------- C. 事件委托：点数字要真的接得住 ----------
group('C 事件委托');

const bindFn = (APP_CODE.match(/function bindWeeklyNote\(\)\s*\{([\s\S]*?)\n  \}/) || ['', ''])[1];
ok('C1 bindWeeklyNote 里接住了 [data-wm]', /closest \? t\.closest\('\[data-wm\]'\)/.test(bindFn));
ok('C2 点数字调用 loadWeeklyEvidence 且传的是 dataset.wm',
  /loadWeeklyEvidence\(evBtn\.dataset\.wm\)/.test(bindFn));
ok('C3 用 closest 而不是直接读 e.target.dataset',
  !/e\.target\.dataset/.test(bindFn), '直接读了 e.target.dataset');
ok('C4 × 收起接住了 .w-ev-x → closeWeeklyEvidence',
  /closest\('\.w-ev-x'\)/.test(bindFn) && /closeWeeklyEvidence\(\)/.test(bindFn));
// ★ 老坑回归：bindWeeklyNote 里**不许**加 #weeklyNoteSec 守卫
ok('C5 bindWeeklyNote 没有加 #weeklyNoteSec 守卫（加了就点了没反应）',
  !/\$\('#weeklyNoteSec'\)\)\s*return/.test(bindFn));
ok('C6 bindWeeklyNote 绑的是 #weeklyBox（常驻节点）', /\$\('#weeklyBox'\)/.test(bindFn));

// ---------- D. 取数与渲染 ----------
group('D 取数与渲染');

const ldFn = (APP.match(/async function loadWeeklyEvidence\(metric\)\s*\{([\s\S]*?)\n  \}/) || ['', ''])[1];
ok('D1 loadWeeklyEvidence 先取 #weeklyEv，取不到就 return（不报错）',
  /\$\('#weeklyEv'\)[\s\S]{0,40}if \(!box\) return/.test(ldFn));
ok('D2 调 /api/weekly/evidence 且带上 from/to/metric',
  /'\/api\/weekly\/evidence\?from='[\s\S]{0,200}metric=/.test(ldFn));
ok('D3 失败的 catch 里给的是"能看懂的文案 + 能收起"，不是空白',
  /catch[\s\S]{0,220}w-ev-x/.test(ldFn));
ok('D4 再点同一个指标 = 收起（toggle），不是重复拉取',
  /dataset\.ev === metric[\s\S]{0,60}closeWeeklyEvidence/.test(ldFn));

const rdFn = (APP.match(/function renderWeeklyEvidence\(d\)\s*\{([\s\S]*?)\n  \}/) || ['', ''])[0];
ok('D5 count 为 0 时给的是"确实是 0"的说明（不是空列表）',
  /if \(!d\.count\)[\s\S]{0,260}确实就是 0/.test(rdFn));
ok('D6 明细按天分组（溯源要看是哪几天凑出来的）',
  /byDay\[it\.date\]/.test(rdFn) && /w-ev-g/.test(rdFn));
ok('D7 truncated 时明确说"只列了前 300 条"', /d\.truncated[\s\S]{0,120}前 300 条/.test(rdFn));
ok('D8 每条都渲染了日期（来自 item.date）', /replace\(\/\^\\d\{4\}-\//.test(rdFn));

// 容器必须由 renderWeekly 建好（不能靠点击时才出现）
ok('D9 #weeklyEv 容器在 renderWeekly 的 body 里就建好了',
  /'<div class="w-sec w-ev-sec" id="weeklyEv"/.test(APP));

// ★★ 属性名不复用（本项目的定时炸弹模式）：
//   data-wm = 动作（"点我要看哪个指标"），data-ev = 视图状态（"当前展开的是哪个"）。
//   如果容器也用 data-wm 表达状态，`querySelectorAll('[data-wm]')` 会把容器一起抓进来，
//   委托里 `if (evBtn.dataset.wm)` 也差点被当成真——实测探针抓到 wmCount 多出 1 个空值。
ok('D10 容器用 data-ev 记状态，不占用 data-wm（动作属性不复用）',
  /id="weeklyEv" data-open="0" data-ev=""/.test(APP) &&
  /box\.dataset\.ev = metric/.test(APP) && !/box\.dataset\.wm/.test(APP));

// ---------- E. CSS：能点的数字要有视觉提示、不能点的没有 ----------
group('E CSS');

ok('E1 .w-ev-btn 是继承数字字号的"数字本身可点"，不是独立按钮',
  /\.w-kpi b \.w-ev-btn\s*\{[\s\S]{0,300}font: inherit/.test(CSS));
ok('E2 可点有 hover 反馈', /\.w-kpi b \.w-ev-btn:hover/.test(CSS));
ok('E3 空容器不占位（:empty 与 data-open=0 双保险）',
  /\.w-ev-sec:empty \{ display: none; \}/.test(CSS) && /data-open="0"\] \{ display: none/.test(CSS));
ok('E4 明细列表可滚动（长周报不把页面撑爆）',
  /\.w-ev-list \{ max-height:[\s\S]{0,60}overflow-y: auto/.test(CSS));
ok('E5 明细行是单行省略（中文也不会逐字竖排）',
  /\.w-ev-t \{[\s\S]{0,200}white-space: nowrap/.test(CSS));
// ★ 下划线只画在数字那一行：否则「明细」会和数字挤在同一行重叠（实测踩到）
ok('E5b 下划线加在 .w-ev-v（数字行）而不是整个按钮上',
  /\.w-kpi b \.w-ev-btn \.w-ev-v \{[^}]*border-bottom: 1px dashed/.test(CSS) &&
  !/\.w-kpi b \.w-ev-btn \{[^}]*border-bottom/.test(CSS));
// ★ 界面文案不许漏出 markdown 记号（写周报提示时实测写出过 **着重** 直接显示成星号）
ok('E5c 溯源相关文案里不许出现 markdown 的 ** 记号',
  !/\*\*[^*]{1,20}\*\*/.test(APP.slice(APP.indexOf('w-ev-hint'), APP.indexOf('w-ev-hint') + 200)));
// ★ 本项目的 CSS 顺序铁律：基准规则必须写在所有 @media 之前。
//   注意要匹配**行首的 @media**：文件里有一处注释写着"见下面的 @media"，
//   直接 indexOf('@media') 会命中那句注释，判出一个假的"越界"。
const cssEvPos = CSS_CODE.indexOf('.w-ev-sec');
const firstMedia = CSS_CODE.search(/(^|\n)\s*@media/);
ok('E6 新增的溯源基准样式写在第一个 @media 之前',
  cssEvPos > 0 && firstMedia > 0 && cssEvPos < firstMedia,
  'ev@' + cssEvPos + ' media@' + firstMedia);

// ---------- F. 与后端口径对齐 ----------
group('F 前后端口径对齐');

const WEEKLY = fs.readFileSync(path.join(ROOT, 'server/weekly.js'), 'utf8');
// 前端发出的 metric 名必须都在后端分支里
const sentMetrics = ['records', 'reviews', 'accuracy', 'cards'];
sentMetrics.forEach(m => {
  ok('F1 后端认得前端会发的 metric：' + m,
    new RegExp("metricKey === '" + m + "'").test(WEEKLY));
});
// 前端渲染用到的 item 字段，后端确实会产出
['date', 'kind', 'knowledge', 'subject', 'result', 'time'].forEach(k => {
  ok('F2 后端 evidence 条目会带字段：' + k,
    new RegExp("\\b" + k + ":\\s").test(WEEKLY.slice(WEEKLY.indexOf('function evidenceByMetric'))));
});
ok('F3 前端对 accuracy 明细的说明与后端口径一致（unknown 不计入）',
  /判得出对错/.test(APP) && /rv\.result === 'unknown'\) return/.test(WEEKLY));

// ---------- G. 不许破坏已有约定 ----------
group('G 约定回归');

ok('G1 wNum 仍然把 null 渲染成 —（规矩②的底线）',
  /v === null \|\| v === undefined[\s\S]{0,120}w-na['"]>—<\/b>/.test(APP));
ok('G2 「空」与「—」两个类名仍然分开', /w-blank/.test(APP) && /w-na/.test(APP));
ok('G3 溯源块没有出现在 .w-note-sec（会保存的区）里 —— 明细是只读事实',
  APP.indexOf("id=\"weeklyEv\"") < APP.indexOf("id=\"weeklyNoteSec\""));

console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
if (fail) { console.log('失败清单：\n  - ' + fails.join('\n  - ')); process.exit(1); }

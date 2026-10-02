'use strict';
/**
 * 批次10（前端结构）：学习日报的容器、事件绑定、以及"数据诚实"在界面上的落点。
 *
 * 为什么要有这一套（每条都对应一个真实踩过的坑）：
 *
 *   1. **日报与看板必须共处一个滚动容器**。
 *      早先给日报单开了一个 `.card-list`，于是 `#dailyBox` 与 `#dashBody`
 *      在一个纵向 flex 里都是 `flex:1 + overflow-y:auto` ——
 *      **两个兄弟抢高度、各自独立滚动**，日报和看板各缩一半，两块都看不全。
 *      这个 bug 不会报错、不会红，只是"页面看着有点怪"。
 *   2. **`#dailyBox` 是 `loadDash` 现造的，所以事件必须绑在 `#dashBody` 上**。
 *      绑在 `#dailyBox` 上，第二次进看板（或点「刷新」）监听就随旧节点一起消失，
 *      表现是"数字点不开了、草稿不保存了" —— 而首屏测试全绿。
 *   3. **建容器的语句必须在 `loadDaily(...)` 之前**。
 *      反过来的话 `$('#dailyBox')` 是 null，`loadDaily` 直接 `return`，
 *      日报整块不渲染，且**没有任何报错**。
 *   4. **数据诚实要看得见**：算不出来的数字在卡片上直接写「为什么算不出来」，
 *      不能只塞进 `title` 属性；`null` 要显示成 `—` 而不是 `0`。
 *      这两个是最容易被"顺手美化掉"的细节，一旦丢了，产品就从
 *      "老实说算不出来"退化成"编一个数字"。
 *
 * 只读文件，不起服务，不写任何数据。
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
const HTML = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const CSS = fs.readFileSync(path.join(ROOT, 'public', 'app.css'), 'utf8');
const APPJS = fs.readFileSync(path.join(ROOT, 'public', 'js', 'app.js'), 'utf8');

// ---------- A. 单滚动容器 ----------
group('A. 看板视图只有一个滚动容器');

const dashViewStart = HTML.indexOf('id="view-dash"');
// ★ 区块的**右边界必须是"这个视图自己结束的地方"**，不能是"下一个视图的开始"。
//   原来写的是 HTML.indexOf('id="view-skills"') —— 批次20 把 view-parent 插在
//   view-dash 与 view-skills 之间，家长视角自己的 .card-list 就被算进了 dashBlock，
//   于是「看板只有 1 个 .card-list」变成 2 而误报。
//   （判据本身没错，错的是"我用一个会移动的锚点去划边界"。）
//   这里改成取 view-dash 那个 div 的**闭合位置**：找它后面第一个 `</div>` 之前的
//   下一个 kb-sub 起点，兜底用 view-skills。更稳的写法是按 .kb-sub 逐个切分。
const kbSubStarts = [];
{
  const re = /<div class="kb-sub" id="([a-z-]+)"/g;
  let m;
  while ((m = re.exec(HTML))) kbSubStarts.push({ id: m[1], at: m.index });
}
const dashIdx = kbSubStarts.findIndex(x => x.id === 'view-dash');
ok('能在 HTML 里切出 kb-sub 区块序列', dashIdx >= 0 && kbSubStarts.length >= 2,
  kbSubStarts.map(x => x.id));
// 右边界 = 紧邻的下一个 kb-sub（不论它叫什么），而不是写死 view-skills
const dashViewEnd = (dashIdx >= 0 && kbSubStarts[dashIdx + 1]) ? kbSubStarts[dashIdx + 1].at : HTML.length;
ok('看板分区存在', dashViewStart > 0 && dashViewEnd > dashViewStart,
  { start: dashViewStart, end: dashViewEnd });
const dashBlock = HTML.slice(dashViewStart, dashViewEnd);

const cardListCount = (dashBlock.match(/class="card-list"/g) || []).length;
ok('★ 看板分区里只有 1 个 .card-list（不是日报一个、看板一个）', cardListCount === 1, cardListCount);
ok('★ 那个 .card-list 的 id 是 dashBody', /class="card-list" id="dashBody"/.test(dashBlock));
ok('★ index.html 里不再有静态的 id="dailyBox"（它由 JS 现造）',
  HTML.indexOf('id="dailyBox"') < 0);

// 反证：.card-list 确实是 flex:1 + overflow-y:auto —— 所以"两个兄弟"才真的会抢高度
const cardListRule = (CSS.match(/^\.card-list \{[^}]*\}/m) || [''])[0];
ok('反证前提：.card-list 是 flex:1 + overflow-y:auto',
  /flex:\s*1/.test(cardListRule) && /overflow-y:\s*auto/.test(cardListRule), cardListRule);
// 反证：.kb-sub 是纵向 flex —— 两个子元素在这个方向上才会互相压缩
const kbSubRule = (CSS.match(/^\.kb-sub \{[^}]*\}/m) || [''])[0];
ok('反证前提：.kb-sub 是 flex-direction: column 的容器',
  /flex-direction:\s*column/.test(kbSubRule), kbSubRule);

// ---------- B. loadDash 的容器编排 ----------
group('B. loadDash：先造容器，再拉数据');

// ★ 判据改成"找 id 的声明"而不是"匹配一整段字面量"。
//   原来写的是 APPJS.indexOf('\'<div id="dailyBox"></div>\'') ——
//   批次17 给同一个 innerHTML 前面加了 '<div id="weeklyBox"></div>'，
//   整段字面量就不再相等，于是一条**其实仍然成立**的约束变成了红的。
//   （这正是"判据写死字面量"的老毛病：结构一扩就假红。）
//   现在只问"这个 id 有没有被现造"，顺序判据单独用 indexOf 的相对位置来守。
const iCreate = APPJS.indexOf('id="dailyBox"');
const iPanels = APPJS.indexOf("'<div id=\"dashPanels\">");
const iCallDaily = APPJS.indexOf("loadDaily(dailyDate || '')");
const iGetPanels = APPJS.indexOf("const panels = $('#dashPanels')");

// 周报容器（批次16/17）也必须是现造的，且同样要早于它的取数调用
const iCreateWeekly = APPJS.indexOf('id="weeklyBox"');
// ★ 必须找**调用点** `loadWeekly()`，不能找函数名 `loadWeekly(` ——
//   函数定义（async function loadWeekly(range) {...}）出现在 loadDash 之前，
//   用 indexOf('loadWeekly(') 会命中定义处，于是这条断言测的是"定义在哪儿"而不是"谁先执行"。
//   第一版就是这么写的，直接假红（iCall=113803 < iCreate=121612）。
//   判据选错，测的就是别的东西。
const iCallWeekly = APPJS.indexOf('loadWeekly();');

ok('★ loadDash 里现造 #dailyBox', iCreate > 0, iCreate);
ok('★ loadDash 里现造 #weeklyBox（批次16）', iCreateWeekly > 0, iCreateWeekly);
ok('★ loadDash 里现造 #dashPanels（看板内容的落点）', iPanels > 0, iPanels);
ok('★ 建容器的语句在 loadDaily(...) 之前（否则 $(\'#dailyBox\') 是 null，日报静默不渲染）',
  iCreate > 0 && iCallDaily > iCreate, { iCreate, iCallDaily });
ok('★ 建容器的语句在 loadWeekly() 调用之前（同一条约束，周报一样会静默不渲染）',
  iCreateWeekly > 0 && iCallWeekly > iCreateWeekly, { iCreateWeekly, iCallWeekly });
ok('★ 建容器在取 #dashPanels 之前', iGetPanels > iPanels, { iPanels, iGetPanels });

// 看板内容必须写进 #dashPanels，不能写回 #dashBody（那会把 #dailyBox 一起冲掉）
ok('★ 看板内容写进 panels.innerHTML', APPJS.indexOf('panels.innerHTML =') > 0);
ok('★ 看板出错时也只重写 panels（日报不该跟着消失）',
  APPJS.indexOf("catch (e) { panels.innerHTML = '<div class=\"empty\">") > 0);
ok('★ 不存在把看板内容写回 #dashBody 的残留',
  APPJS.indexOf("box.innerHTML =\n      '<div class=\"dash-grid\">") < 0);

// ---------- C. 事件绑定必须绑在稳定容器上 ----------
group('C. 事件委托绑在 #dashBody（不是每次重建的 #dailyBox）');

const iBind = APPJS.indexOf('function bindDaily()');
ok('bindDaily 存在', iBind > 0);
const bindBlock = APPJS.slice(iBind, APPJS.indexOf('\n  }', iBind) + 4);
ok('★ bindDaily 里取的是 #dashBody', bindBlock.indexOf("const host = $('#dashBody')") >= 0,
  bindBlock.split('\n').slice(0, 8).join(' | '));
ok('★ bindDaily 里不再取 #dailyBox（它每次重建，绑了会失效）',
  bindBlock.indexOf("$('#dailyBox')") < 0);
ok('★ 三个监听都挂在 host 上（click / input / focusout）',
  (bindBlock.match(/host\.addEventListener\(/g) || []).length === 3,
  (bindBlock.match(/host\.addEventListener\(/g) || []).length);
ok('★ 没有 box.addEventListener 的残留（旧变量名）',
  bindBlock.indexOf('box.addEventListener') < 0);

// 委托里的判定顺序：data-kind（带 ids 的单条发现）必须先于 data-metric（整指标）
const iKind = bindBlock.indexOf("closest('[data-kind]')");
const iMetric = bindBlock.indexOf("closest('[data-metric]')");
ok('★ 先判 data-kind 再判 data-metric（顺序反了单条溯源会走成整指标）',
  iKind > 0 && iMetric > iKind, { iKind, iMetric });
// 四个导航按钮都在委托里
['#dailyPrev', '#dailyNext', '#dailyToday', '#dailyFinal'].forEach(id =>
  ok('委托里有 ' + id, bindBlock.indexOf("closest('" + id + "')") >= 0));
ok('历史日报按 [data-day] 委托', bindBlock.indexOf("closest('[data-day]')") >= 0);

// ---------- D. 数据诚实：界面上看得见 ----------
group('D. 数据诚实（算不出来就说算不出来）');

const iRender = APPJS.indexOf('function renderDaily(');
ok('renderDaily 存在', iRender > 0);
const renderBlock = APPJS.slice(iRender, APPJS.indexOf('\n  }', APPJS.indexOf('box.innerHTML =', iRender)) + 4);

// null → 显示 —，并且灰掉、不可点
ok('★ 值判空用 `m.value === null`（不是 falsy —— 0 是合法数字）',
  renderBlock.indexOf('m.value === null') >= 0);
ok('★ 空值显示 —（不是 0）', renderBlock.indexOf("(na ? '—' :") >= 0);
ok('★ 空值卡片加 .na 类（灰掉、cursor:default）',
  renderBlock.indexOf("d-num' + (na ? ' na' : '')") >= 0);
ok('★ 空值的「为什么算不出来」直接写在卡片上（<i> 里），不是只放 title',
  renderBlock.indexOf("(na ? '<i>' + HL.esc(m.unknown) + '</i>'") >= 0);
ok('★ 有值的卡片才出现「看依据」', renderBlock.indexOf("'<i class=\"d-num-go\">看依据</i>'") >= 0);

// CSS 侧：.na 必须真的被灰掉，且 hover 不变蓝（不变蓝＝不暗示可点）
const naRule = (CSS.match(/\.d-num\.na \{[^}]*\}/) || [''])[0];
ok('★ .d-num.na 存在', naRule.length > 0, naRule);
ok('★ .d-num.na 的 hover 不改边框色（不然看着像能点）',
  /\.d-num\.na:hover \{[^}]*border-color:\s*var\(--line\)/.test(CSS));
const naBRule = (CSS.match(/\.d-num\.na b \{[^}]*\}/) || [''])[0];
ok('★ .d-num.na b 用暗色（— 不该抢眼）', /color:\s*var\(--dim2\)/.test(naBRule), naBRule);

// 两个折叠块：不给分数的原因 / 这份日报不能证明什么
ok('★ 有「为什么不给分数」折叠块', renderBlock.indexOf('为什么不给分数') >= 0);
ok('★ 有「这份日报不能证明什么」折叠块', renderBlock.indexOf('这份日报不能证明什么') >= 0);
ok('★ 有「每个数字都点得开」的说明句', renderBlock.indexOf('每个数字都点得开') >= 0);
ok('★ 不评分原因按条渲染（d-ns-i），不是一段糊上去的散文',
  renderBlock.indexOf("'<div class=\"d-ns-i\">") >= 0);
ok('★ 局限按条渲染（d-lim li）', renderBlock.indexOf("'<li>' + HL.esc(x) + '</li>'") >= 0);

// ---------- E. 溯源钩子 ----------
group('E. 溯源：三个钩子 + 两个接口');

ok('★ 数字卡片带 data-metric', renderBlock.indexOf("data-metric=\"' + HL.esc(m.key)") >= 0);
ok('★ 四问发现带 data-kind', renderBlock.indexOf("data-kind=\"' + HL.esc(f.evidence.kind)") >= 0);
ok('★ 四问发现带 data-ids（逗号连接）', renderBlock.indexOf("data-ids=\"' + HL.esc(f.evidence.ids.join(','))") >= 0);
ok('★ 只有带 evidence.ids 的发现才出现「看依据」',
  /f\.evidence && f\.evidence\.ids && f\.evidence\.ids\.length/.test(renderBlock));

const iEv = APPJS.indexOf('async function openDailyEvidence(');
ok('openDailyEvidence 存在', iEv > 0);
const evBlock = APPJS.slice(iEv, APPJS.indexOf('\n  }', iEv) + 4);
ok('★ 按 ids 精确取用 POST /evidence', evBlock.indexOf("'/evidence'") >= 0);
ok('★ 按指标取用 GET /evidence/<key>', evBlock.indexOf("'/evidence/' + encodeURIComponent(metricKey)") >= 0);
ok('★ 弹窗标题写明条数（可数＝可核对）', evBlock.indexOf("'依据（' + items.length + ' 条原始记录）'") >= 0);
ok('★ 没有可展开记录时明说，而不是弹一个空窗',
  evBlock.indexOf('这一项没有可展开的原始记录') >= 0);

// ---------- F. 草稿：防抖 + 防乱序 + 定稿后不再改写 ----------
group('F. 草稿与定稿');

const iQueue = APPJS.indexOf('function queueDraftSave(');
ok('queueDraftSave 存在', iQueue > 0);
const qBlock = APPJS.slice(iQueue, APPJS.indexOf('\n  }', iQueue) + 4);
ok('★ 有防抖（停手 900ms 才发，不是每敲一个字打一次接口）',
  /setTimeout\([\s\S]*?,\s*900\)/.test(qBlock));
ok('★ 有防乱序序号（晚到的旧响应不许覆盖提示）', qBlock.indexOf('dailySaveSeq') >= 0 && /seq !== dailySaveSeq/.test(qBlock));
ok('★ 保存失败时明说"内容还在页面上，别关"', qBlock.indexOf('内容还在页面上，别关') >= 0);
ok('★ 草稿走 /draft 接口', qBlock.indexOf("/draft'") >= 0);

const iFin = APPJS.indexOf('async function finalizeDaily(');
ok('finalizeDaily 存在', iFin > 0);
const finBlock = APPJS.slice(iFin, APPJS.indexOf('\n  }', iFin) + 4);
ok('★ 定稿走 /finalize 接口', finBlock.indexOf("/finalize'") >= 0);
ok('★ 定稿后重拉历史（历史里要立刻变成「已定稿」）', finBlock.indexOf('/api/daily/history') >= 0);

ok('★ 定稿后 textarea 只读', renderBlock.indexOf("(isFinal ? ' readonly' : '')") >= 0);
ok('★ 定稿后保存提示换成"不再改写"', renderBlock.indexOf('定稿之后不再改写') >= 0);
ok('★ 定稿后按钮禁用', renderBlock.indexOf("(isFinal ? ' disabled' : '')") >= 0);

// 草稿读取范围限定在 #dailyBox 内（别把看板里的 textarea 也扫进来）
const ansScopes = (APPJS.match(/\$\$\('#dailyBox \.d-ans'\)/g) || []).length;
ok('★ 收集答案限定在 #dailyBox .d-ans 内（草稿 + 定稿两处）', ansScopes === 2, ansScopes);
ok('★ 不存在裸的 .d-ans 全文档扫描',
  (APPJS.match(/\$\$\('\.d-ans'\)/g) || []).length === 0);

// ---------- G. 加载时序 ----------
group('G. 加载时序与骨架屏');

const iLoad = APPJS.indexOf('async function loadDaily(');
ok('loadDaily 存在', iLoad > 0);
const loadBlock = APPJS.slice(iLoad, APPJS.indexOf('\n  }', iLoad) + 4);
ok('★ 骨架屏只在首次（!dailyData）出现，翻页时不闪',
  loadBlock.indexOf('if (!dailyData) box.innerHTML') >= 0);
ok('★ 日报与历史并发取（两个 await 顺序写，不嵌套）',
  loadBlock.indexOf('/api/daily/history?limit=14') >= 0);
ok('★ 取数失败时把错误显示在日报块里，不静默留白',
  loadBlock.indexOf("box.innerHTML = '<div class=\"empty\">") >= 0);

// 切到看板分区会走 loadDash（KB_SUBS 里的 load）
ok('★ 看板分区注册了 loadDash', /key: 'dash'[\s\S]{0,160}load: \(\) => loadDash\(\)/.test(APPJS));
ok('★ 刷新按钮与天数下拉都触发 loadDash',
  /#dashRefresh'\)\.addEventListener\('click', loadDash\)/.test(APPJS)
  && /#dashDays'\)\.addEventListener\('change', loadDash\)/.test(APPJS));
ok('★ bindDaily 在初始化里只绑一次', (APPJS.match(/^\s+bindDaily\(\);/gm) || []).length === 1,
  (APPJS.match(/^\s+bindDaily\(\);/gm) || []).length);

// ---------- H. 截图脚本仍能对上容器 ----------
group('H. 截图脚本与新容器一致');
const shotPath = path.join(ROOT, '_shot_daily.cjs');
if (fs.existsSync(shotPath)) {
  const SHOT = fs.readFileSync(shotPath, 'utf8');
  ok('★ 截图脚本定位 #dailyBox（JS 现造，但截图前已经渲染完）', SHOT.indexOf('#dailyBox') >= 0);
  ok('★ 截图脚本用 .view:not([hidden]) 限定汉堡按钮（严格模式下 .hamb 会命中多个）',
    SHOT.indexOf(".view:not([hidden]) .hamb") >= 0);
} else {
  ok('_shot_daily.cjs 存在', false);
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

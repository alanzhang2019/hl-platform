'use strict';
/**
 * 批次6 · 前端结构自检（静态，不起浏览器）。
 *
 * 为什么写成静态检查而不是再起一次 Chromium：
 *   这一批改的是**信息架构**（11 根平级导航 → 对话 / 知识库两根 + 二级分区），
 *   它的正确性在 DOM 结构里就已经确定了 —— 只要 index.html 的嵌套关系对了，
 *   渲染就不会跑偏。结构断言比截图对比更稳，也不依赖 playwright。
 *
 * 守的是三条容易在后续迭代里被悄悄破坏的约束：
 *   1. 顶级导航**只能**有两根（多一根就回到"先做选择题"的老问题）
 *   2. 所有被砍掉的视图都必须真的挂进 #view-kb 里，不能消失
 *   3. 旧入口（#kbCats / #navSkill / #hamb）必须彻底删掉，不留悬空引用
 */
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const HTML = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const APPJS = fs.readFileSync(path.join(ROOT, 'public', 'js', 'app.js'), 'utf8');
const CSS = fs.readFileSync(path.join(ROOT, 'public', 'app.css'), 'utf8');
const SRV = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');

let pass = 0, fail = 0;
const fails = [];
function ok(name, cond, extra) {
  if (cond) { pass++; }
  else { fail++; fails.push(name + (extra !== undefined ? ' → ' + JSON.stringify(extra) : '')); }
}
function group(t) { console.log('\n' + t); }
const count = (s, re) => (s.match(re) || []).length;

// ---------- 1. 顶级导航 ----------
group('A. 顶级导航只留两根');
const navBlock = /<nav class="nav">([\s\S]*?)<\/nav>/.exec(HTML);
ok('页面里有 nav 块', !!navBlock, null);
const navItems = navBlock ? (navBlock[1].match(/class="nav-i[ "]/g) || []).length : -1;
ok('导航项恰好 2 个', navItems === 2, navItems);
ok('第一根是「对话」', /data-view="chat"[\s\S]{0,120}对话/.test(navBlock ? navBlock[1] : ''), null);
ok('第二根是「知识库」', /data-view="kb"[\s\S]{0,160}知识库/.test(navBlock ? navBlock[1] : ''), null);
['cards', 'exam', 'en', 'pool', 'dash', 'skills', 'projects', 'memory', 'settings'].forEach(v => {
  ok('导航里不再有 data-view="' + v + '"', navBlock ? navBlock[1].indexOf('data-view="' + v + '"') < 0 : false, null);
});

// ---------- 2. 只有两个 .view ----------
group('B. 只剩对话 / 知识库两个顶层视图');
const views = (HTML.match(/<section class="view" id="([a-z-]+)"/g) || [])
  .map(s => /id="([a-z-]+)"/.exec(s)[1]);
ok('顶层 view 恰好 2 个', views.length === 2, views);
ok('是 view-chat 与 view-kb', views.indexOf('view-chat') >= 0 && views.indexOf('view-kb') >= 0, views);

// ---------- 3. 知识库内部件齐全 ----------
group('C. 知识库页：本子树 + 分区条 + 状态 Tab + 文档行');
const kbBlock = /<section class="view" id="view-kb" hidden>([\s\S]*?)\n    <\/section>/.exec(HTML);
ok('能切出 view-kb 整块', !!kbBlock, null);
const KB = kbBlock ? kbBlock[1] : '';
['kbTree', 'kbTreeList', 'kbTreeFoot', 'kbNewCat', 'kbTabs', 'sub-docs',
  'kbState', 'kbList', 'kbFile', 'kbDrop', 'kbUploadBtn', 'kbSearch', 'kbTitle', 'kbSub']
  .forEach(id => ok('知识库页里有 #' + id, KB.indexOf('id="' + id + '"') >= 0, null));
['all', 'ready', 'parsing', 'todo'].forEach(st => {
  ok('状态 Tab 有 data-state="' + st + '"', KB.indexOf('data-state="' + st + '"') >= 0, null);
});
['全部', '已就绪', '解析中', '需处理'].forEach(t => {
  ok('状态 Tab 文案含「' + t + '」', KB.indexOf(t) >= 0, null);
});
ok('有上传入口（上传文档按钮）', KB.indexOf('上传文档') >= 0, null);

// ---------- 4. 被砍掉的视图都还在，且挂进知识库 ----------
group('D. 9 个功能全部收进知识库，没有一个丢掉');
const SUBS = ['view-cards', 'view-exam', 'view-en', 'view-pool', 'view-projects',
  'view-dash', 'view-parent', 'view-skills', 'view-memory', 'view-settings'];
const kbSubs = (KB.match(/<div class="kb-sub" id="([a-z-]+)"/g) || [])
  .map(s => /id="([a-z-]+)"/.exec(s)[1]);
ok('知识库里有 11 个分区（含资料）', kbSubs.length === 11, kbSubs);
SUBS.forEach(id => ok('分区 ' + id + ' 在知识库里', kbSubs.indexOf(id) >= 0, kbSubs));
ok('资料分区是 sub-docs', kbSubs.indexOf('sub-docs') >= 0, kbSubs);
// 关键控件还在（这些 id 是各功能自己的入口，重构时最容易误删）
['cardList', 'exList', 'enList', 'poolList', 'projList', 'dashBody', 'skillList', 'memList', 'setList', 'profBox']
  .forEach(id => ok('控件 #' + id + ' 仍然存在', HTML.indexOf('id="' + id + '"') >= 0, null));

// ---------- 5. 右上角头像入口 ----------
group('E. 记忆 / 设置 走右上角头像菜单');
ok('页面里至少 2 个 .me-chip（对话页 + 知识库页）', count(HTML, /class="me-chip"/g) >= 2, count(HTML, /class="me-chip"/g));
ok('两个 .me-chip 分别在对话页和知识库页',
  /class="me-chip"/.test(/<section class="view" id="view-chat">([\s\S]*?)<\/section>/.exec(HTML)[1]) &&
  /class="me-chip"/.test(KB), null);
ok('app.js 里 meMenu 提供记忆入口', /data-me="memory"/.test(APPJS), null);
ok('app.js 里 meMenu 提供设置入口', /data-me="settings"/.test(APPJS), null);
ok('app.js 里 meMenu 提供退出入口', /data-me="logout"/.test(APPJS), null);

// ---------- 6. app.js 的结构常量 ----------
group('F. app.js 的视图常量与旧引用清理');
ok('TOP_VIEWS 只有 chat 与 kb', /const TOP_VIEWS = \['chat', 'kb'\]/.test(APPJS), null);
ok('KB_SUBS 声明了 10 个分区', count(APPJS, /\{ key: '/g) >= 10, count(APPJS, /\{ key: '/g));
ok('memory 分区标记为 hidden（不出现在分区条上）', /key: 'memory'[\s\S]{0,120}hidden: true/.test(APPJS), null);
ok('settings 分区标记为 hidden（不出现在分区条上）', /key: 'settings'[\s\S]{0,120}hidden: true/.test(APPJS), null);
ok('不再引用 #kbCats', APPJS.indexOf('#kbCats') < 0, null);
ok('不再有 renderKbCats', APPJS.indexOf('renderKbCats') < 0, null);
ok('不再引用 #navSkill', APPJS.indexOf('#navSkill') < 0, null);
ok('不再用单个 #hamb（改成 .hamb 全量绑定）', APPJS.indexOf("$('#hamb')") < 0, null);
ok('有 renderKbTabs / setKbSub / setTabBadge', /function renderKbTabs/.test(APPJS) && /function setKbSub/.test(APPJS) && /function setTabBadge/.test(APPJS), null);
ok('切分区时会隐藏左侧本子树', /\$\('#kbTree'\)\.hidden = kbSub !== 'docs'/.test(APPJS), null);

// ---------- 7. 容量 / 三态的前端语义 ----------
group('G. 容量与三态在前端有对应实现');
ok('本子行渲染容量 x/y', /容量 ' \+ docs \+ '\/' \+ cap/.test(APPJS), null);
ok('满了才显示扩容按钮', /full \? '<button class="kt-x"/.test(APPJS), null);
ok('容量来自服务端 defaults', /S\.kbCapa = cats\.defaults/.test(APPJS), null);
ok('文档行走 state / stateText', /d\.stateText/.test(APPJS), null);
ok('需处理的文档给"重新解析"', /data-doc="reparse"/.test(APPJS), null);
ok('文档可以换本子（移到…）', /data-doc="move"/.test(APPJS) && /\/move'/.test(APPJS), null);
ok('未归类是一个特殊值 __none__', /const NONE = '__none__'/.test(APPJS), null);
ok('在"未归类"里上传不会偷偷挂本子', /kbCat !== NONE\) \? kbCat : undefined/.test(APPJS), null);

// ---------- 8. CSS ----------
group('H. 样式齐备');
['.kb-wrap', '.kb-tree', '.kb-tree-i', '.kb-tree-foot', '.kb-main', '.kb-tabs', '.kb-tab',
  '.kb-sub', '.kb-subbar', '.kb-state', '.kb-state-i', '.me-chip', '.me-menu', '.me-mi']
  .forEach(c => ok('CSS 里有 ' + c, CSS.indexOf(c + ' ') >= 0 || CSS.indexOf(c + '{') >= 0 || CSS.indexOf(c + ',') >= 0, null));
ok('全局 [hidden] 用了 !important（否则 .kb-sub 的 display:flex 会盖掉它）',
  /\[hidden\] \{ display: none !important; \}/.test(CSS), null);

// ---------- 9. 后端路由 ----------
group('I. 后端新增接口');
ok('有扩容路由 expand', /categories[\\/]\(\[\^\\?\/\]\+\)[\\/]expand/.test(SRV) || SRV.indexOf('/expand$') >= 0, null);
ok('有分类改名 PATCH', /kbc && method === 'PATCH'/.test(SRV), null);
ok('有文档移动 move', /act === 'move'/.test(SRV), null);
ok('有重新解析 reparse', /act === 'reparse'/.test(SRV), null);
ok('文档列表支持 state 过滤', /state: u\.searchParams\.get\('state'\)/.test(SRV), null);
ok('分类列表回带 uncategorized 与 defaults', /uncategorized: kb\.uncategorizedCount/.test(SRV), null);

// ---------- 10. 没有重复 id ----------
group('J. HTML 无重复 id');
const ids = (HTML.match(/\sid="([^"]+)"/g) || []).map(s => s.slice(5, -1));
const dup = ids.filter((v, i) => ids.indexOf(v) !== i);
ok('没有重复的 id', dup.length === 0, Array.from(new Set(dup)));

console.log('');
if (fails.length) fails.slice(0, 40).forEach(f => console.log('  ✗ ' + f));
console.log('PASS  通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail ? 1 : 0);

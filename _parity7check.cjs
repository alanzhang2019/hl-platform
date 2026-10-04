'use strict';
/**
 * 批次7 自检（模块级）：项目为主轴 + 宠物阶段解锁。
 *
 * 守的是三件容易悄悄坏掉的事：
 *   1. **前后端 key 对齐** —— 后端 UNLOCKS 用的是 feature key，前端 KB_SUBS 用的是分区 key，
 *      两边拼错一个字母（比如后端写 english、前端写 en），结果就是"该锁的没锁"或"该开的开不了"，
 *      而且**界面看起来完全正常**，只有用户点进去才发现。所以这条必须在测试里钉死。
 *   2. **解锁集是单调的** —— 阶段 N 解锁的东西，阶段 N+1 不能丢。丢一个用户就会觉得"我退步了"。
 *   3. **成长值不跨空间** —— 别人的空间长到参天，不该顺手把我的功能开了。
 *
 * 不起服务，直接调 server/pet.js。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hl-p7-'));
process.env.DATA_DIR = TMP;
process.env.NO_DOTENV = '1';

let pass = 0, fail = 0;
const fails = [];
function ok(name, cond, extra) {
  if (cond) { pass++; }
  else { fail++; fails.push(name + (extra !== undefined ? ' → ' + JSON.stringify(extra) : '')); }
}
function group(t) { console.log('\n' + t); }

const pet = require('./server/pet');
const D = require('./server/db');

const APPJS = fs.readFileSync(path.join(__dirname, 'public', 'js', 'app.js'), 'utf8');
const HTML = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');

const SID = 'sp_p7';
const SID2 = 'sp_p7_other';
D.run('INSERT INTO spaces(id,name,name_key,created_at) VALUES(?,?,?,?)', SID, '批次七空间', '批次七空间', D.now());
D.run('INSERT INTO spaces(id,name,name_key,created_at) VALUES(?,?,?,?)', SID2, '隔壁空间', '隔壁空间', D.now());

const ALL_FEATURES = pet.UNLOCKS.reduce((a, u) => a.concat(u.features), []);

// ---------- A. 解锁表本身是自洽的 ----------
group('A. 解锁表自洽');
ok('UNLOCKS 的 stage 覆盖 STAGES 的每一级', pet.UNLOCKS.length === pet.STAGES.length,
  { unlocks: pet.UNLOCKS.map(u => u.stage), stages: pet.STAGES.map(s => s.stage) });
ok('每个 stage 在 STAGES 里都存在',
  pet.UNLOCKS.every(u => pet.STAGES.some(s => s.stage === u.stage)), null);
ok('stage 严格递增', pet.UNLOCKS.every((u, i) => i === 0 || u.stage > pet.UNLOCKS[i - 1].stage), null);
ok('同一个功能不会被两级的解锁表重复声明', new Set(ALL_FEATURES).size === ALL_FEATURES.length, ALL_FEATURES);
ok('每个 feature 都有中文名', ALL_FEATURES.every(f => !!pet.FEATURE_LABEL[f]),
  ALL_FEATURES.filter(f => !pet.FEATURE_LABEL[f]));
ok('阶段 1 就给了知识卡（否则成长值引擎没启动，会死锁）',
  pet.UNLOCKS[0].features.indexOf('cards') >= 0, pet.UNLOCKS[0].features);
ok('阶段 1 就给了对话与项目（左栏主轴，不能锁）',
  pet.UNLOCKS[0].features.indexOf('chat') >= 0 && pet.UNLOCKS[0].features.indexOf('projects') >= 0,
  pet.UNLOCKS[0].features);

// ---------- B. 前后端 key 对齐（最重要的一条）----------
group('B. 前端分区 key 与后端 feature key 对齐');
const kbKeys = (APPJS.match(/\{ key: '([a-z]+)'/g) || []).map(s => /'([a-z]+)'/.exec(s)[1]);
ok('能从 app.js 切出 KB_SUBS 的 key', kbKeys.length >= 10, kbKeys);
// settings 是"设置"，不是功能，不该进解锁表
const kbFeatureKeys = kbKeys.filter(k => k !== 'settings');
kbFeatureKeys.forEach(k => {
  ok('前端分区「' + k + '」在后端解锁表里有对应项', ALL_FEATURES.indexOf(k) >= 0, ALL_FEATURES);
});
// chat 是**顶级导航**（左栏那两根之一），不是知识库的二级分区，所以它不在 KB_SUBS 里 ——
// 其余每个 feature 都必须能在前端找到对应分区，否则就是"锁了一个不存在的入口"。
const TOP_LEVEL = ['chat'];
ALL_FEATURES.filter(f => TOP_LEVEL.indexOf(f) < 0).forEach(f => {
  ok('后端 feature「' + f + '」在前端有对应分区', kbKeys.indexOf(f) >= 0, kbKeys);
});
ok('chat 是顶级导航而不是分区', /data-view="chat"/.test(HTML) && kbKeys.indexOf('chat') < 0, null);

// ---------- C. 逐阶段解锁集 ----------
group('C. 各阶段的解锁集');
function unlockAt(growth) {
  D.run('UPDATE pets SET growth = ? WHERE space_id = ?', growth, SID);
  return pet.unlockedFeatures(SID, 'u1');
}
const u0 = unlockAt(0);
ok('0 点解锁 7 项（看板/家长视角从早期阶段提到阶段1；批次28 又加了「班级」）', u0.unlocked.length === 7, u0.unlocked);
ok('0 点不含 skills', u0.unlocked.indexOf('skills') < 0, u0.unlocked);
ok('0 点 next 指向幼苗', u0.next && u0.next.name === '幼苗', u0.next);
ok('0 点 next 还差 30', u0.next && u0.next.toNext === 30, u0.next);
ok('0 点 next 预告的是「能力」', u0.next && u0.next.labels.join('') === '能力', u0.next);

const u29 = unlockAt(29);
ok('29 点还没解锁 skills（差 1 点也不给）', u29.unlocked.indexOf('skills') < 0, u29.unlocked);
const u30 = unlockAt(30);
ok('30 点解锁 skills', u30.unlocked.indexOf('skills') >= 0, u30.unlocked);
ok('30 点 next 指向小树，预告记忆与测评',
  u30.next && u30.next.name === '小树' && u30.next.labels.join('') === '记忆测评', u30.next);

const u89 = unlockAt(89);
ok('89 点还没解锁 memory', u89.unlocked.indexOf('memory') < 0, u89.unlocked);
const u90 = unlockAt(90);
ok('90 点解锁 memory 与 exam',
  u90.unlocked.indexOf('memory') >= 0 && u90.unlocked.indexOf('exam') >= 0, u90.unlocked);

const u199 = unlockAt(199);
ok('199 点还没解锁 en', u199.unlocked.indexOf('en') < 0, u199.unlocked);
const u200 = unlockAt(200);
ok('200 点解锁 en', u200.unlocked.indexOf('en') >= 0, u200.unlocked);

const u400 = unlockAt(400);
ok('400 点全部解锁', u400.unlocked.length === ALL_FEATURES.length, u400.unlocked);
ok('400 点 maxed', u400.maxed === true, u400.maxed);
ok('400 点没有 next', u400.next === null, u400.next);

// ---------- D. 解锁集单调不缩水 ----------
group('D. 解锁集单调（升级不会丢功能）');
const seq = [0, 29, 30, 89, 90, 199, 200, 399, 400, 9999].map(g => unlockAt(g).unlocked);
let mono = true, monoAt = -1;
for (let i = 1; i < seq.length; i++) {
  for (const f of seq[i - 1]) {
    if (seq[i].indexOf(f) < 0) { mono = false; monoAt = i; }
  }
}
ok('每一步都是上一阶段的超集', mono, monoAt >= 0 ? { 断在: monoAt, 前后: [seq[monoAt - 1], seq[monoAt]] } : null);
ok('超额成长值（9999）不会让解锁集出错', seq[seq.length - 1].length === ALL_FEATURES.length, seq[seq.length - 1]);

// ---------- E. 空间隔离 ----------
group('E. 成长值不跨空间');
D.run('UPDATE pets SET growth = 400 WHERE space_id = ?', SID);
const other = pet.unlockedFeatures(SID2, 'u1');
ok('隔壁空间仍是 7 项（含看板与班级，没被带飞）', other.unlocked.length === 7, other.unlocked);
ok('隔壁空间 stage 仍是 1', other.stage === 1, other.stage);

// ---------- F. 同空间不同用户互不影响 ----------
group('F. 同空间内不同用户各长各的');
const otherUser = pet.unlockedFeatures(SID, 'u2');
ok('另一个用户从 0 开始（7 项含看板与班级）', otherUser.unlocked.length === 7, otherUser.unlocked);

// ---------- G. 前端结构：左栏以项目为主轴 ----------
group('G. 左栏是项目树，不是对话列表');
const aside = /<aside[\s\S]*?<\/aside>/.exec(HTML);
ok('能切出 aside', !!aside, null);
const ASIDE = aside ? aside[0] : '';
ok('左栏标题是「项目」', /<span>项目<\/span>/.test(ASIDE), null);
ok('左栏不再写「对话记录」', ASIDE.indexOf('对话记录') < 0, null);
ok('有「新建项目」按钮 #newProj', ASIDE.indexOf('id="newProj"') >= 0, null);
ok('旧的 #newConv 已从 HTML 移除', HTML.indexOf('id="newConv"') < 0, null);
ok('搜索框改成了「搜项目 / 对话」', /placeholder="搜项目 \/ 对话"/.test(ASIDE), null);
ok('项目树容器仍是 #convList', ASIDE.indexOf('id="convList"') >= 0, null);

ok('app.js 有 renderSideTree', /function renderSideTree\(/.test(APPJS), null);
ok('app.js 不再有 renderConvList', APPJS.indexOf('renderConvList') < 0, null);
ok('app.js 不再有 loadConvs', APPJS.indexOf('loadConvs') < 0, null);
ok('loadSide 并行拉项目与对话', /Promise\.all\(\[\s*api\('\/api\/projects'\)/.test(APPJS), null);
ok('项目行有展开/收起', /data-p="toggle"/.test(APPJS), null);
ok('项目行有"在这个项目里新建对话"', /data-p="newconv"/.test(APPJS), null);
ok('项目行有项目菜单', /data-p="pmenu"/.test(APPJS), null);
ok('未归入项目用 __none__ 占位', /'__none__'/.test(APPJS), null);
ok('删项目时对话退回未归入（不连坐删除）', /退回「未归入项目」/.test(APPJS), null);
ok('左栏默认展开（openProj 缺省即展开）', /S\.openProj\[id\] !== false/.test(APPJS), null);

// 在项目里点「＋」新建对话：会话是**服务端**在收到首条消息时才建的，
// 所以那条流式请求必须把项目一起带上 —— 漏传 projectId 就会 project_id=NULL，
// 明明在项目里开的对话却掉进「未归入项目」。（2026-10-01 真实踩过）
const SERVER = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
ok('服务端建会话时接收 projectId', /createConversation\(sid, ctx\.userId, \{\s*projectId: b\.projectId/.test(SERVER), null);
ok('发送时把待归入项目带进流式请求体', /conversationId: S\.convId \|\| undefined[\s\S]{0,500}?projectId: S\.convId \? undefined : \(S\.pendingProjectId/.test(APPJS), null);
ok('会话建好后清掉待归入意图（不污染下一次新建）', /S\.convId = j\.conversationId;[\s\S]{0,200}?S\.pendingProjectId = null/.test(APPJS), null);
ok('项目行「＋」把项目 id 传给 newConv', /newConv\(pid && pid !== '__none__' \? \{ projectId: pid \} : \{\}\)/.test(APPJS), null);

// ---------- H. 前端门控 ----------
group('H. 前端按解锁集置灰');
ok('有 isUnlocked', /function isUnlocked\(/.test(APPJS), null);
ok('有 lockedTip', /function lockedTip\(/.test(APPJS), null);
ok('unlocks 未拿到时不锁任何东西（防首屏闪灰）', /if \(!S\.unlocks\) return true/.test(APPJS), null);
ok('设置永远可用', /key === 'settings'\) return true/.test(APPJS), null);
ok('renderKbTabs 给未解锁的加 locked', /locked \? ' locked'/.test(APPJS), null);
ok('setKbSub 拦住未解锁的分区', /if \(!isUnlocked\(row\.key\)\) \{ toast\(lockedTip/.test(APPJS), null);
ok('loadPet 存下 unlocks', /S\.unlocks = r\.unlocks/.test(APPJS), null);
ok('解锁集变化时重画分区条', /before !== after && \$\('#kbTabs'\)\) renderKbTabs/.test(APPJS), null);
ok('宠物条写明"还差 N 点解锁 XX"', /' 点' \+\s*\(nx && nx\.labels/.test(APPJS), null);

// ---------- I. 样式 ----------
group('I. 样式齐备');
const CSS = fs.readFileSync(path.join(__dirname, 'public', 'app.css'), 'utf8');
['.side-p', '.sp-h', '.sp-caret', '.sp-n', '.sp-c', '.sp-add', '.sp-x', '.side-empty', '.se-acts', '.kb-tab.locked', '.kb-tab-l']
  .forEach(c => ok('CSS 里有 ' + c, CSS.indexOf(c) >= 0, null));

// ---------- J. 移动端布局（P0 修复，2026-10-01）----------
group('J. 移动端布局');
// 病根：顶栏 .tb-txt 被挤到 w=0，副标题里的 flex-wrap:wrap 于是逐字换行，
// 变成一条竖排"乱码"把顶栏撑到 222px（390×844 实测）。
ok('窄屏顶栏换行（而不是把标题压扁）',
  /@media \(max-width: 900px\) \{[\s\S]{0,400}?\.topbar \{ flex-wrap: wrap;/.test(CSS), null);
ok('窄屏隐藏 .sp（换行布局里它只会挤扁标题）', /\.topbar > \.sp \{ display: none; \}/.test(CSS), null);
ok('窄屏标题区 flex-basis 为 0（否则换行位置不可控）', /\.topbar > \.tb-txt \{ flex: 1 1 0;/.test(CSS), null);
ok('副标题改成单行省略，不再是 flex-wrap: wrap',
  /\.tb-txt \.s \{[^}]*white-space: nowrap/.test(CSS) && !/\.tb-txt \.s \{[^}]*flex-wrap: wrap/.test(CSS), null);
ok('#convSubText 有省略号', /#convSubText \{[^}]*text-overflow: ellipsis/.test(CSS), null);
ok('次级控件组桌面端 display:contents（不改变原有排版）', /\.tb-tools \{ display: contents; \}/.test(CSS), null);
ok('次级控件组窄屏独占一行且排在最后',
  /\.topbar > \.tb-tools \{[\s\S]{0,120}?flex: 1 0 100%; order: 1;/.test(CSS), null);
ok('搜索框窄屏独占一行且排在头像之后', /\.topbar > #kbSearch \{[^}]*order: 1/.test(CSS), null);
ok('窄屏隐藏「收起成图标」（侧栏本来就是浮层，这个按钮没意义）', /#sideToggle \{ display: none; \}/.test(CSS), null);
ok('窄屏隐藏侧栏拖拽条', /\.side-resizer \{ display: none; \}/.test(CSS), null);

// 抽屉遮罩：侧栏是 280px 浮层，打开后正好盖住汉堡按钮本身 ——
// 没有遮罩用户就"点得到开、点不到关"。
ok('HTML 里有抽屉遮罩 #sideMask', HTML.indexOf('id="sideMask"') >= 0, null);
ok('遮罩是 #side 的兄弟且排在 main 之前',
  HTML.indexOf('id="sideMask"') > HTML.indexOf('id="side"') &&
  HTML.indexOf('id="sideMask"') < HTML.indexOf('<main'), null);
ok('遮罩基准规则是 display:none', /\.side-mask \{ display: none; \}/.test(CSS), null);
// ★ 这条踩过：CSS 同权重下后写的赢。把 .side-mask{display:none} 放到 @media 后面，
//   窄屏的 display:block 会被直接盖掉，遮罩永远出不来，而且没有任何报错。
ok('★ 遮罩的 display:none 写在所有 @media 之前',
  CSS.indexOf('.side-mask { display: none; }') > 0 &&
  CSS.indexOf('.side-mask { display: none; }') < CSS.indexOf('@media (max-width'), null);
ok('遮罩打开时 pointer-events:auto', /\.side\.open ~ \.side-mask \{ opacity: 1; pointer-events: auto; \}/.test(CSS), null);
ok('遮罩 z-index(55) 低于侧栏(60)', /z-index: 55/.test(CSS) && /z-index: 60/.test(CSS), null);
ok('点遮罩关闭抽屉', /#sideMask'\)\.addEventListener\('click'/.test(APPJS), null);

// 结构：次级控件被包进 .tb-tools
const tbTools = /<div class="tb-tools">([\s\S]*?)<\/div>/.exec(HTML);
ok('对话页顶栏有 .tb-tools 容器', !!tbTools, null);
['modeSel', 'modelSel', 'agentBtn', 'shareBtn', 'convMenuBtn'].forEach(id => {
  ok('#' + id + ' 被收进 .tb-tools', !!tbTools && tbTools[1].indexOf('id="' + id + '"') >= 0, null);
});
ok('#kbSearch 不再有内联 max-width（内联样式盖不过媒体查询）',
  !/id="kbSearch"[^>]*style=/.test(HTML), null);

console.log('');
if (fails.length) fails.slice(0, 40).forEach(f => console.log('  ✗ ' + f));
console.log('PASS  通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail ? 1 : 0);

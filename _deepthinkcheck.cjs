'use strict';
/**
 * 深度思考开关 自检（模块级 + 静态）。
 *
 * 需求：聊天输入框旁边（与「联网搜索」并列）加一个「深度思考」开关。
 * 开 = 回复前先思考（慢一点但更稳），关 = 快速回答。
 *
 * ★★★ 这个功能的**核心设计判断**：它不是第三套模型机制，而是
 *    「这条对话走哪个档位」的一个人性化入口 —— 开 = deep 档，关 = default 档。
 *    所以它必须与顶栏的模型下拉**共用同一个状态**（前端以 S.model 为单一真相）。
 *
 * 由此推出本套件要钉死的四件事：
 *   1. **后端优先级是 deepThink > opt.model > conv.model**，不是 opt.model 优先。
 *      regenerate 这类分支会显式传 `model: conv.model`，若让 opt.model 抢先，
 *      开关就被静默绕过 —— 界面亮着、实际走的是快速档，这是最难查的一类 bug。
 *   2. **会话级持久化**：跟联网搜索同款，切换对话各自记住、刷新不丢。
 *   3. **前端两入口双向同步**：点按钮要同步下拉，切下拉要同步按钮。
 *      不同步就会出现"下拉是通用、按钮还亮着"的自相矛盾界面。
 *   4. **接线必须真的存在**（钉调用点，不是"字符串存在"）—— 本项目真出过
 *      "定义了但没人调"的 bug。
 *
 * 不起服务：模块级断言 + 读源码。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

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
const SERVERJS = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const DBJS = fs.readFileSync(path.join(ROOT, 'server', 'db.js'), 'utf8');
const COREJS = fs.readFileSync(path.join(ROOT, 'server', 'core.js'), 'utf8');
const LLMJS = fs.readFileSync(path.join(ROOT, 'server', 'llm.js'), 'utf8');

/** 剥掉注释：注释里必然要提到这些词，不剥会自己把自己判红 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

// ============================================================
group('A 数据层：会话表有 deep_think 列（含迁移）');

ok('db.js SCHEMA 里有 deep_think 列',
  /deep_think\s+INTEGER\s+NOT NULL\s+DEFAULT\s+0/.test(DBJS));
ok('db.js MIGRATIONS 里有 deep_think（老库能补上）',
  /\['conversations',\s*'deep_think'/.test(DBJS));
ok('deep_think 与 web_search 同为 INTEGER 默认 0（口径一致）',
  /web_search\s+INTEGER NOT NULL DEFAULT 0,[\s\S]{0,120}deep_think\s+INTEGER NOT NULL DEFAULT 0/.test(DBJS));

// ============================================================
group('B core.js：会话读写的四个出口都带上 deepThink');

ok('createConversation 入参含 deepThink', /createConversation\([\s\S]{0,200}deepThink/.test(COREJS));
ok('createConversation 的 INSERT 列名含 deep_think', /INSERT INTO conversations\([^)]*deep_think/.test(COREJS));
ok('createConversation 的 VALUES 占位符数量匹配（12 列 → 12 个 ?）',
  (() => {
    const m = COREJS.match(/INSERT INTO conversations\(([^)]*)\)[\s\S]{0,200}?VALUES\(([^)]*)\)/);
    if (!m) return false;
    const cols = m[1].split(',').length;
    const qs = m[2].split(',').length;
    return cols === qs;
  })());
ok('listConversations 返回 deepThink', /deepThink:\s*!!c\.deep_think/.test(COREJS));
ok('getConversation 返回 deepThink', (COREJS.match(/deepThink:\s*!!c\.deep_think/g) || []).length >= 2);
ok('updateConversation 能写 deepThink', /UPDATE conversations SET deep_think = \?/.test(COREJS));

// ============================================================
group('C server.js：★ 优先级 deepThink > opt.model > conv.model');

const SR = stripComments(SERVERJS);
ok('streamReply 里解析 deepThink（带会话兜底）',
  /const deepThink = opt\.deepThink !== undefined \? !!opt\.deepThink : !!conv\.deepThink/.test(SR));
// ★★ 这条是本套件最重要的一条：开了就是开了，不接受被 opt.model 覆盖。
ok('★★ model 由 deepThink 优先决定（不是 opt.model 优先）',
  /const model = deepThink \? 'deep' : \(opt\.model \|\| conv\.model \|\| 'default'\)/.test(SR));
ok('★ 反证：若写成「opt.model 优先」，开关会被 regenerate 静默绕过',
  !/const model = opt\.model \|\| \(deepThink/.test(SR), '旧的错误写法又回来了');

ok('send 路由创建会话时带 deepThink', /deepThink:\s*b\.deepThink/.test(SR));
ok('send 路由 patch 会话时带 deepThink', /patch\.deepThink = b\.deepThink/.test(SR));
ok('★ send 路由传参带会话兜底（漏传不该悄悄换档位）',
  /deepThink:\s*b\.deepThink !== undefined \? !!b\.deepThink : !!conv\.deepThink/.test(SR));
ok('regenerate 分支也传 deepThink（否则重新生成会掉回快速档）',
  /regenerate[\s\S]{0,2000}deepThink:\s*!!conv\.deepThink/.test(SR));
ok('meta 事件回传 deepThink（前端要知道本条走的哪档）',
  /replyId: placeholder\.id,[\s\S]{0,120}deepThink: deepThink/.test(SR));
ok('占位消息 meta 落库 deepThink（看板要能统计成本口径）',
  /mode: useMode,[\s\S]{0,300}deepThink: deepThink/.test(SR));

// ============================================================
group('D 前端：按钮在「联网搜索」旁边');

ok('index.html 有 dtBtn 按钮', /id="dtBtn"/.test(HTML));
ok('★ dtBtn 紧邻 webBtn（要求"放在联网旁边"）', (() => {
  const i = HTML.indexOf('id="dtBtn"');
  const j = HTML.indexOf('id="webBtn"');
  if (i < 0 || j < 0) return false;
  // dtBtn 在 webBtn 前面，且中间只隔一个标签的量级
  return i < j && (j - i) < 200;
})());
ok('dtBtn 也是 .ct 类（与联网同款工具条按钮）', /class="ct"\s+id="dtBtn"/.test(HTML));
ok('dtBtn 有 title 说明（悬停能看懂它做什么）', /id="dtBtn"[^>]*title="[^"]*深度思考/.test(HTML));

// ============================================================
group('E 前端：状态、渲染、切换三件套');

ok('S 状态里有 deepThink', /deepThink:\s*false,/.test(APPJS));
ok('有 renderDtBtn', /function renderDtBtn\(\)/.test(APPJS));
ok('有 setDeepThink', /async function setDeepThink\(/.test(APPJS));
ok('有 toggleDeepThink', /function toggleDeepThink\(/.test(APPJS));
ok('★ renderDtBtn 的开关态从 S.model 推导（单一真相，不另存一份）',
  /function renderDtBtn\(\)[\s\S]{0,300}S\.model === 'deep'/.test(APPJS));

// ============================================================
group('F ★★ 两入口双向同步（点按钮同步下拉，切下拉同步按钮）');

ok('★ setDeepThink 里改完 S.model 会同步顶栏下拉',
  /async function setDeepThink\([\s\S]{0,500}\$\('#modelSel'\)/.test(APPJS));
ok('★ setDeepThink 里会调 renderDtBtn 刷新按钮态',
  /async function setDeepThink\([\s\S]{0,600}renderDtBtn\(\)/.test(APPJS));
ok('★ modelSel 的 change 里也会调 renderDtBtn（切下拉要同步按钮）', (() => {
  const i = APPJS.indexOf("$('#modelSel').addEventListener('change'");
  if (i < 0) return false;
  const seg = APPJS.slice(i, i + 900);
  return /renderDtBtn\(\)/.test(seg);
})());
ok('★ 切下拉时会把 deepThink 一起 PATCH（两字段同时落库，状态一致）', (() => {
  const i = APPJS.indexOf("$('#modelSel').addEventListener('change'");
  if (i < 0) return false;
  const seg = APPJS.slice(i, i + 900);
  return /deepThink:\s*S\.model === 'deep'/.test(seg);
})());
ok('★ setDeepThink 落库时 model 与 deepThink 一起写', (() => {
  const i = APPJS.indexOf('async function setDeepThink(');
  if (i < 0) return false;
  const seg = APPJS.slice(i, i + 900);
  return /body:\s*\{\s*deepThink[\s\S]{0,80}model:\s*S\.model/.test(seg);
})());

// ============================================================
group('G ★ 接线必须真的存在（钉调用点，不是"字符串存在"）');

ok('★★ dtBtn 真的绑了 click（定义了但没人调 = 本项目出过的 bug）',
  /\$\('#dtBtn'\)\.addEventListener\('click',\s*toggleDeepThink\)/.test(APPJS));
ok('★ 发送请求体里带上 deepThink', (() => {
  const i = APPJS.indexOf('/api/chat/stream');
  if (i < 0) return false;
  const seg = APPJS.slice(i, i + 1500);
  return /deepThink:\s*!!S\.deepThink/.test(seg);
})());
ok('★ openConv 打开旧对话时会刷新按钮态（renderDtBtn 被调用）', (() => {
  const i = APPJS.indexOf('async function openConv(');
  if (i < 0) return false;
  const seg = APPJS.slice(i, i + 2500);
  return /renderDtBtn\(\)/.test(seg);
})());
ok('★ 启动流程里同步了一次按钮态（刷新后界面与 S.model 一致）', (() => {
  const i = APPJS.indexOf('setMode(savedMode()');
  if (i < 0) return false;
  const seg = APPJS.slice(i, i + 600);
  return /renderDtBtn\(\)/.test(seg);
})());
ok('newConv 会 renderDtBtn（新建对话按钮态不残留）', (() => {
  const i = APPJS.indexOf('S.webSearch = false; S.pending = []; S.tempDocs = [];');
  if (i < 0) return false;
  const seg = APPJS.slice(i, i + 600);
  return /renderDtBtn\(\)/.test(seg);
})());
ok('★ 新建对话不重置深度思考（它是档位偏好，不是每对话一次的开关）', (() => {
  const i = APPJS.indexOf('S.webSearch = false; S.pending = []; S.tempDocs = [];');
  if (i < 0) return false;
  const seg = APPJS.slice(i, i + 700);
  return !/S\.deepThink = false/.test(seg);
})());
ok('对话副标题会写明深度思考已开（用户能看出来当前档位）',
  /深度思考已开/.test(APPJS));

// ============================================================
group('H 与既有 deep 档位的口径一致（不是新造一套）');

ok('llm.js 里 deep 档位确实存在且 thinking=true',
  /id:\s*'deep'[\s\S]{0,220}thinking:\s*true/.test(LLMJS));
ok('★ 深度思考复用 deep 档位，不是新造第三个模型 id',
  /'deep'/.test(APPJS) && !/'deepthink'/i.test(APPJS));
ok('switchView/其它地方没有把 deepThink 写成对象或数组（应是布尔）',
  !/deepThink:\s*\[/.test(APPJS) && !/deepThink:\s*\{/.test(APPJS));

// ============================================================
console.log('\n' + '─'.repeat(62));
if (fails.length) {
  console.log('失败 ' + fails.length + ' 项：');
  fails.forEach(f => console.log('  ✗ ' + f));
}
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail ? 1 : 0);

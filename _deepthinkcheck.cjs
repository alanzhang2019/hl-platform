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
group('D 前端：模型入口在输入区工具栏（批次31 改版）');

ok('★ 模型选择器在输入区工具栏（.composer-tools 内）', (() => {
  const i = HTML.indexOf('class="composer-tools"');
  if (i < 0) return false;
  const seg = HTML.slice(i, i + 3000);
  return /id="modelSel"/.test(seg);
})());
ok('★ 图表模式也在输入区工具栏', (() => {
  const i = HTML.indexOf('class="composer-tools"');
  if (i < 0) return false;
  const seg = HTML.slice(i, i + 3000);
  return /id="vizChk"/.test(seg);
})());
ok('★ 顶栏不再有第二处模型入口（避免两处不同步）', (() => {
  const i = HTML.indexOf('class="tb-tools"');
  if (i < 0) return false;
  const seg = HTML.slice(i, i + 1400);
  return !/id="modelSel"/.test(seg) && !/id="vizChk"/.test(seg);
})());
ok('  旧的「深度思考」按钮已移除（并进模型下拉）', !/id="dtBtn"/.test(HTML));
ok('  旧的顶栏智能体按钮已移除（收进 ＋ 菜单）', !/id="agentBtn"/.test(HTML));

// ============================================================
group('E 前端：状态、渲染、切换三件套');

ok('S 状态里有 deepThink', /deepThink:\s*false,/.test(APPJS));
ok('有 renderDtBtn', /function renderDtBtn\(\)/.test(APPJS));
ok('★ renderDtBtn 的开关态从 S.model 推导（单一真相，不另存一份）',
  /function renderDtBtn\(\)[\s\S]{0,500}S\.model === 'deep'/.test(APPJS));
ok('  已删掉 setDeepThink/toggleDeepThink（按钮没了，别再留死代码）',
  !/function setDeepThink\(/.test(APPJS) && !/function toggleDeepThink\(/.test(APPJS));

// ============================================================
group('F ★★ 档位与 deepThink 双向一致');

ok('★ modelSel 的 change 里会调 renderDtBtn（切档要同步 deepThink）', (() => {
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
ok('★ openConv 打开旧对话时会刷新档位态（renderDtBtn 被调用）', (() => {
  const i = APPJS.indexOf('async function openConv(');
  if (i < 0) return false;
  const seg = APPJS.slice(i, i + 2500);
  return /renderDtBtn\(\)/.test(seg);
})());
ok('newConv 会 renderDtBtn（新建对话档位态不残留）', (() => {
  const i = APPJS.indexOf('S.webSearch = false; S.pending = []; S.tempDocs = [];');
  if (i < 0) return false;
  const seg = APPJS.slice(i, i + 600);
  return /renderDtBtn\(\)/.test(seg);
})());

// ============================================================
group('G ★ 接线必须真的存在（钉调用点，不是"字符串存在"）');

ok('★ 发送请求体里带上 deepThink', (() => {
  const i = APPJS.indexOf('/api/chat/stream');
  if (i < 0) return false;
  const seg = APPJS.slice(i, i + 1500);
  return /deepThink:\s*!!S\.deepThink/.test(seg);
})());
ok('★ 新建对话不重置深度思考（它是档位偏好，不是每对话一次的开关）', (() => {
  const i = APPJS.indexOf('S.webSearch = false; S.pending = []; S.tempDocs = [];');
  if (i < 0) return false;
  const seg = APPJS.slice(i, i + 700);
  return !/S\.deepThink = false/.test(seg);
})());

// ============================================================
group('G2 ★★ ＋ 菜单的三项都真的接了线（定义了但没人调 = 本项目出过的 bug）');

ok('★★ bindPlusMenu 真的被调用（否则菜单点了没反应）',
  /bindPlusMenu\(\);/.test(APPJS));
ok('★★ 「添加文件」真的绑了 click 并唤起文件选择器', (() => {
  const i = APPJS.indexOf("$('#pmAddFile').addEventListener('click'");
  if (i < 0) return false;
  return /\$\('#attachFile'\)\.click\(\)/.test(APPJS.slice(i, i + 160));
})());
ok('★★ 「引用对话中的文件」真的绑了 click 并弹自己的面板',
  /\$\('#pmRefFile'\)\.addEventListener\('click',\s*\(\)\s*=>\s*\{[^}]*openRefFileMenu\(\)/.test(APPJS));
ok('★★ 「智能体」真的绑了 click 并复用 openAgents',
  /\$\('#pmAgent'\)\.addEventListener\('click',\s*\(\)\s*=>\s*\{[^}]*openAgents\(\)/.test(APPJS));
ok('★ 点空白处会关菜单（否则菜单会一直挂在屏幕上）',
  /document\.addEventListener\('click',[\s\S]{0,220}closePlusMenu\(\)/.test(APPJS));
ok('★ 引用文件是把文件名插进输入框（不是把整篇内容塞进上下文）', (() => {
  const i = APPJS.indexOf('function openRefFileMenu(');
  if (i < 0) return false;
  const seg = APPJS.slice(i, i + 2000);
  return /ta\.value\s*=[\s\S]{0,120}'@'\s*\+\s*name/.test(seg);
})());
ok('对话副标题会写明深度思考已开（用户能看出来当前档位）',
  /深度思考已开/.test(APPJS));

// ============================================================
group('H 与既有 deep 档位的口径一致（不是新造一套）');

ok('llm.js 里 deep 档位确实存在且 thinking=true',
  /id:\s*'deep'[\s\S]{0,260}thinking:\s*true/.test(LLMJS));
ok('★ 深度思考复用 deep 档位，不是新造第三个模型 id',
  /'deep'/.test(APPJS) && !/'deepthink'/i.test(APPJS));
ok('switchView/其它地方没有把 deepThink 写成对象或数组（应是布尔）',
  !/deepThink:\s*\[/.test(APPJS) && !/deepThink:\s*\{/.test(APPJS));

// ============================================================
group('I ★★★ 批次31：thinking 必须显式下发（否则"关不掉"）');

// 事故：通用档模型 deepseek-v4-flash **默认就带思考**，不传 thinking 时
// 也照样回 reasoning_content —— 于是"关掉深度思考"按钮灭了、思考过程照旧。
// 修法是每条请求都显式带 thinking.type。
ok('★★★ 档位定义里 default 显式 thinking=false',
  /id:\s*'default',[\s\S]{0,300}?thinking:\s*false/.test(LLMJS));
ok('★★★ streamChat 按档位传 thinking:enabled/disabled',
  /thinking:\s*\{\s*type:\s*m\.thinking\s*\?\s*'enabled'\s*:\s*'disabled'\s*\}/.test(LLMJS));
ok('★★ complete（后台杂活）显式关思考，不白等推理',
  /thinking:\s*\{\s*type:\s*'disabled'\s*\}/.test(LLMJS));
ok('★★ 前端收到没要的 reasoning 会丢弃（wantThink 兜底）',
  /if\s*\(!wantThink\)/.test(APPJS));
ok('★ meta 回来会用服务端裁决校正 wantThink',
  /if\s*\(j\.deepThink !== undefined\)\s*wantThink = !!j\.deepThink/.test(APPJS));
ok('★ deep 档在界面上叫 DeepSeek Pro（不再叫「深度思考」）',
  /id:\s*'deep'[\s\S]{0,160}?name:\s*'DeepSeek Pro'/.test(LLMJS) &&
  !/id:\s*'deep'[\s\S]{0,160}?name:\s*'深度思考'/.test(LLMJS));

// ============================================================
console.log('\n' + '─'.repeat(62));
if (fails.length) {
  console.log('失败 ' + fails.length + ' 项：');
  fails.forEach(f => console.log('  ✗ ' + f));
}
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail ? 1 : 0);

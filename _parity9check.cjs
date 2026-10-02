'use strict';
/**
 * 批次9 自检（静态 + 模块级）：落地页合规入口与第一屏信息层级。
 *
 * 为什么要有这一套：
 *
 *   1. **合规入口是最容易被"重构掉"的东西**。它长得像装饰，藏在页脚最底下，
 *      谁改版式都可能顺手删掉，而且删了**不会有任何报错** ——
 *      只是未成年人产品的三篇法定文本重新变得不可达。
 *   2. **三份文档"存在"和"点得开"是两件事**。`index.html` 里有链接，
 *      不代表 `server/account.js` 里还有正文。这里直接 require 模块把正文读出来数节数。
 *   3. **`data-doc` 是重名属性**。知识库资料卡的「看全文 / 重新解析 / 移到 / 删除」
 *      也用它传动作名，全文档扫一遍会把它们绑成"打开协议"。
 *      现在只靠"渲染时机晚于 bindAccount"侥幸不出错 —— 钉死限定范围，防回归。
 *   4. **落地页的居中方式不能退回 `align-items: center`**。
 *      内容高过视口时它会把自己的顶部推到 overflow 区**且滚不回来**，
 *      品牌与主张整段消失（实测 320×568 下 top = -132px）。
 *      这个坑没有报错、没有滚动条异常，只有"手机上最上面那段不见了"。
 *
 * 只读文件 + 只读模块，不写任何数据。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

// 让 require('./server/*') 不去碰真实数据目录 / 真实 .env
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hl-p9-'));
process.env.DATA_DIR = TMP;
process.env.NO_DOTENV = '1';
delete process.env.LLM_API_KEY;
delete process.env.ADMIN_PASSWORD;

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

const iLand = HTML.indexOf('id="land"');
const iCol = HTML.indexOf('class="land-col"');
const iHead = HTML.indexOf('class="land-head"');
const iHeadEnd = HTML.indexOf('</header>');
const iCard = HTML.indexOf('class="land-card"');
const iCardEnd = HTML.indexOf('<!-- /.land-card -->');
const iErr = HTML.indexOf('id="landErr"');
const iFoot = HTML.indexOf('class="land-foot"');

// ---------- A. 落地页结构：抬头在卡外 ----------
group('A. 落地页结构（抬头在卡片之外）');

ok('空间门存在', iLand > 0);
ok('.land-col 存在（抬头与卡片同宽的中轴）', iCol > 0);
ok('.land-head 存在', iHead > 0);
ok('.land-card 存在', iCard > 0);
ok('★ .land-head 在 .land-card **之前**', iHead > 0 && iHead < iCard, { iHead, iCard });
ok('★ .land-head 有自己的闭合 </header>，不吞掉卡片', iHeadEnd > iHead && iHeadEnd < iCard, { iHeadEnd, iCard });
ok('.land-card 的结束注释存在（结构可被断言）', iCardEnd > iCard, { iCardEnd });
ok('★ .land-card 在 .land-col 之内（在 .land-col 之后）', iCard > iCol, { iCol, iCard });
ok('抬头与卡片都在 .land-col 结束之前', iCardEnd > 0 && HTML.indexOf('<!-- /.land-col -->') > iCardEnd);

// 第一屏要回答"这是谁"：品牌 + 定位 + 立场，三样都要在抬头里
const headBlock = HTML.slice(iHead, iHeadEnd + 9);
ok('抬头里有品牌名', headBlock.indexOf('后浪奔涌') >= 0);
ok('抬头里有定位句', headBlock.indexOf('AI 学习平台') >= 0);
ok('★ 抬头里有立场句（我们的差异化，不是功能名）', headBlock.indexOf('不直接给答案') >= 0, headBlock.slice(0, 80));
ok('立场句用了 .land-stance 而不是复用 .land-sub', headBlock.indexOf('class="land-stance"') >= 0);
ok('抬头里没有表单（表单归卡片）', headBlock.indexOf('<input') < 0);

// ---------- B. 合规入口 ----------
group('B. 合规入口（页脚常驻三篇）');

const footBlock = HTML.slice(iFoot, iCardEnd);
ok('★ 页脚有 .land-legal 容器', footBlock.indexOf('class="land-legal"') >= 0);
ok('★ 页脚挂着用户协议', footBlock.indexOf('data-doc="terms"') >= 0);
ok('★ 页脚挂着隐私政策', footBlock.indexOf('data-doc="privacy"') >= 0);
ok('★ 页脚挂着儿童个人信息保护规则', footBlock.indexOf('data-doc="children-privacy"') >= 0);

// 顺序必须与注册表单勾选框里的口径一致，别一处一个顺序
const oTerms = footBlock.indexOf('data-doc="terms"');
const oPriv = footBlock.indexOf('data-doc="privacy"');
const oChild = footBlock.indexOf('data-doc="children-privacy"');
ok('三篇顺序：用户协议 → 隐私政策 → 儿童个人信息保护规则',
  oTerms >= 0 && oTerms < oPriv && oPriv < oChild, { oTerms, oPriv, oChild });

ok('页脚有监护人提示（不满 14 周岁）', footBlock.indexOf('不满 14 周岁') >= 0);
ok('监护人提示点名"监护人"与"同意"', /监护人[\s\S]{0,20}同意/.test(footBlock));

// ★ 页脚必须挂在卡片上、且不在任何 .land-pane 里 ——
//   否则切到"创建学习空间"这条最常见路径就看不到合规入口了（这正是本次要修的 bug）。
ok('★ 页脚在 .land-err 之后、卡片结束之前（即卡片直属，不在 pane 内）',
  iFoot > iErr && iFoot < iCardEnd, { iErr, iFoot, iCardEnd });
const footIdxInTabs = HTML.slice(iCard, iFoot).lastIndexOf('</div>\n\n    <div class="land-err"');
ok('★ 页脚紧跟在 .land-err 的闭合之后（三个 pane 都已关掉）', footIdxInTabs > 0);

// 分隔符：用 <span> 而不是 CSS ::after —— 窄屏要能单独 display:none
const sepCount = (footBlock.match(/class="land-sep"/g) || []).length;
ok('两个分隔符用 <span class="land-sep"> 写成真元素', sepCount === 2, sepCount);

// ---------- C. 三份文档真的有正文 ----------
group('C. 三份文档点得开（模块级读正文）');

const account = require('./server/account.js');
const DOC_IDS = ['terms', 'privacy', 'children-privacy'];
const list = account.docs();
ok('docs() 列出三篇', list.length === 3, list.map(d => d.id));
DOC_IDS.forEach(id => ok('docs() 含 ' + id, list.some(d => d.id === id)));

DOC_IDS.forEach(id => {
  const d = account.doc(id);
  ok('doc("' + id + '") 有标题', !!(d && d.title), d && d.title);
  ok('doc("' + id + '") 有版本号', !!(d && d.version), d && d.version);
  ok('★ doc("' + id + '") 有 ≥4 节正文', !!(d && d.sections && d.sections.length >= 4),
    d && d.sections && d.sections.length);
  const secs = (d && d.sections) || [];
  ok('★ doc("' + id + '") 每节都有小标题和正文',
    secs.every(s => s.heading && s.body && s.body.length >= 20),
    secs.map(s => (s.heading || '') + ':' + ((s.body || '').length)));
});

// 儿童那篇必须点出"监护人"这条硬要求
const child = account.doc('children-privacy');
const childAll = (child.sections || []).map(s => s.heading + s.body).join('');
ok('★ 儿童规则里出现「监护人」', childAll.indexOf('监护人') >= 0);
ok('★ 儿童规则里明确"不推送广告 / 不做诱导性设计"（这是我们对标站的差异点）',
  childAll.indexOf('广告') >= 0 && childAll.indexOf('诱导') >= 0);

// ---------- D. data-doc 绑定范围 ----------
group('D. data-doc 绑定必须限定在 #land 内');

ok('★ 绑定用了 "#land [data-doc]" 而不是裸 "[data-doc]"',
  APPJS.indexOf("$$('#land [data-doc]')") >= 0);
ok('★ 不存在裸的全文档扫描绑定（知识库动作按钮也叫 data-doc）',
  APPJS.indexOf("$$('[data-doc]')") < 0);

// 反证：知识库的动作名确实与协议 id 同名空间重叠，所以上面这条不是洁癖
const kbActionNames = ['view', 'reparse', 'move', 'del'];
kbActionNames.forEach(a => ok('知识库动作 data-doc="' + a + '" 仍在用（说明重名风险真实存在）',
  APPJS.indexOf('data-doc="' + a + '"') >= 0));

// ---------- E. 布局安全（本次踩的坑） ----------
group('E. 落地页布局安全');

// .land 的规则块
const landRule = (CSS.match(/^\.land \{[\s\S]*?\}/m) || [''])[0];
ok('.land 规则取到了', landRule.length > 0);
ok('★ .land 的 align-items 不是 center（内容超高时顶部会被裁且滚不回来）',
  landRule.indexOf('align-items: center') < 0, landRule.replace(/\s+/g, ' ').slice(0, 120));
ok('★ .land 用的是 align-items: flex-start', landRule.indexOf('align-items: flex-start') >= 0);
ok('★ .land 仍是滚动容器（overflow: auto）', landRule.indexOf('overflow: auto') >= 0);

const colRule = (CSS.match(/^\.land-col \{[^}]*\}/m) || [''])[0];
ok('.land-col 规则取到了', colRule.length > 0);
ok('★ .land-col 有 margin: auto 0（有空间时上下均分＝视觉居中，没空间时归零＝从顶部开始）',
  /margin:\s*auto\s+0/.test(colRule), colRule);

// 宽度只写一处，卡片继承 —— 两处各写一次 min(440px,100%) 迟早漂移
ok('★ 宽度只写在 .land-col 上', colRule.indexOf('min(440px, 100%)') >= 0);
const cardRule = (CSS.match(/^\.land-card \{[^}]*\}/m) || [''])[0];
ok('★ .land-card 用 width: 100% 继承，不自己再写一遍宽度',
  cardRule.indexOf('width: 100%') >= 0 && cardRule.indexOf('min(440px') < 0, cardRule.replace(/\s+/g, ' '));

// 链接标签不能折在词中间
const legalARule = (CSS.match(/^\.land-legal a \{[^}]*\}/m) || [''])[0];
ok('★ .land-legal a 有 white-space: nowrap（320px 下会断成「…保护规/则」）',
  legalARule.indexOf('white-space: nowrap') >= 0, legalARule);

// 窄屏：分隔符藏掉，改外边距
const mq480 = CSS.slice(CSS.indexOf('@media (max-width: 480px)'));
ok('480px 断点存在', mq480.length > 0);
const mq480Block = mq480.slice(0, mq480.indexOf('\n}') + 2);
ok('★ 480px 下 .land-sep 被 display:none（否则换行会留一个孤零零的「·」）',
  /\.land-sep \{\s*display:\s*none/.test(mq480Block), mq480Block.replace(/\s+/g, ' ').slice(0, 200));
ok('★ 480px 下 .land-legal a 改回外边距分隔', /\.land-legal a \{\s*margin:/.test(mq480Block));

// CSS 顺序：480 块必须在 820 块之后（同权重下后者胜出，否则窄屏覆盖不生效）
const i820 = CSS.indexOf('@media (max-width: 820px)');
const i480 = CSS.indexOf('@media (max-width: 480px)');
ok('★ 480px 断点写在 820px 断点之后（同权重靠源码顺序取胜）', i480 > i820, { i820, i480 });
ok('★ .land-col 的基准规则写在所有媒体查询之前',
  CSS.indexOf('.land-col {') > 0 && CSS.indexOf('.land-col {') < CSS.indexOf('@media (max-width:'));

// ---------- 汇总 ----------
console.log('\n' + '─'.repeat(60));
if (fail) {
  console.log('✗ 通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  fails.forEach(f => console.log('  ✗ ' + f));
} else {
  console.log('✓ 通过 ' + pass + ' 项，失败 0 项');
}
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
process.exit(fail ? 1 : 0);

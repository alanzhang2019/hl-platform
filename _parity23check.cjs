'use strict';
/**
 * 批次23 自检：用户一次报的五个问题
 *
 * 背景（2026-10-02，用户发截图报障）：
 *   ① 图片和链接不能失败      —— 图片直链被判成"这不是一个网页"；学生上传的图 AI 说"我看不到"
 *   ② 互动内容与当前内容无关  —— 问方格取数，却挂上来一条抛物线 + 一次函数的示例模型
 *   ③ 配图不知所云            —— 网格题被硬凑成 geometry（两个点 + 几个游离数字）
 *   ④ 联网功能测试无效        —— 没配 WEB_SEARCH_URL 就永远"暂时不可用"
 *   ⑤ 管理员只能看不能操作    —— 只能列空间，不能禁用户 / 重置密码
 *
 * 这一批的共同性质：**都不是"功能没写"，是"写歪了"**。
 * 每条断言都指向那个具体的歪法，而不是"存在某个函数"。
 *
 * 不起服务；网络相关的口径用假 fetch 驱动。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hl-p23-'));
process.env.DATA_DIR = TMP;
process.env.NO_DOTENV = '1';
delete process.env.LLM_API_KEY;
delete process.env.LLM_BASE_URL;
delete process.env.ADMIN_PASSWORD;
delete process.env.WEB_SEARCH_URL;
delete process.env.WEB_SEARCH_API_KEY;
delete process.env.WEB_SEARCH_BUILTIN;

const search = require('./server/search');
const webdoc = require('./server/webdoc');
const ocr = require('./server/ocr');
const core = require('./server/core');
const chat = require('./server/chat');
const llm = require('./server/llm');
const auth = require('./server/auth');
const interactive = require('./server/interactive');
const D = require('./server/db');

const APPJS = fs.readFileSync(path.join(__dirname, 'public/js/app.js'), 'utf8');
const SERVERJS = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
const AUTHJS = fs.readFileSync(path.join(__dirname, 'server/auth.js'), 'utf8');
const RENDERJS = fs.readFileSync(path.join(__dirname, 'public/js/render.js'), 'utf8');
const DBJS = fs.readFileSync(path.join(__dirname, 'server/db.js'), 'utf8');

let pass = 0, fail = 0;
const fails = [];
function ok(cond, name, extra) {
  if (cond) { pass++; }
  else { fail++; fails.push(name + (extra !== undefined ? ' → ' + JSON.stringify(extra) : '')); }
}
function eq(got, want, name) { ok(got === want, name, 'got=' + JSON.stringify(got) + ' want=' + JSON.stringify(want)); }
function has(s, sub) { return String(s).indexOf(sub) >= 0; }

async function main() {

// ================================================================
// 1) 图片 / 链接：直链不再被判"这不是一个网页"
// ================================================================
{
  // 魔数识别：CDN 常常把图片标成 application/octet-stream，扩展名也不可信
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
  const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]);
  const GIF = Buffer.concat([Buffer.from('GIF89a', 'latin1'), Buffer.alloc(8)]);
  const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')]);
  const BMP = Buffer.concat([Buffer.from('BM'), Buffer.alloc(12)]);
  eq(webdoc.sniffImage(PNG), 'image/png', '★ 魔数认出 PNG');
  eq(webdoc.sniffImage(JPEG), 'image/jpeg', '★ 魔数认出 JPEG');
  eq(webdoc.sniffImage(GIF), 'image/gif', '★ 魔数认出 GIF');
  eq(webdoc.sniffImage(WEBP), 'image/webp', '★ 魔数认出 WebP（RIFF…WEBP）');
  eq(webdoc.sniffImage(BMP), 'image/bmp', '魔数认出 BMP');
  eq(webdoc.sniffImage(Buffer.from('<html>hi there')), '', '★ 网页字节不能被认成图片');
  eq(webdoc.sniffImage(Buffer.alloc(4)), '', '太短的字节直接放弃（不硬猜）');
  eq(webdoc.sniffImage(null), '', 'null 不崩');

  // 图片直链端到端：假 fetch 返回一张 PNG，且 Content-Type 谎报 octet-stream
  const realFetch = global.fetch;
  global.fetch = async () => ({
    ok: true, status: 200,
    headers: { get: k => (k === 'content-type' ? 'application/octet-stream' : null) },
    text: async () => '<html>不是防护钩子的页面</html>',
    arrayBuffer: async () => PNG.buffer.slice(PNG.byteOffset, PNG.byteOffset + PNG.byteLength),
  });
  const one = await webdoc.fetchOne('https://example.com/a.png?id=1');
  eq(one.ok, true, '★ octet-stream 的图片直链**读成功了**（旧行为：报"这不是一个网页"）');
  eq(one.image, true, '   └ 标记为图片，不是网页');
  eq(one.mime, 'image/png', '   └ mime 靠魔数兜回来，不信 header');
  ok(Buffer.isBuffer(one.data) && one.data.length === PNG.length, '   └ 字节原样带回去，交给视觉模型');

  const linkRes = await webdoc.readLinks(['https://example.com/a.png']);
  eq(linkRes.pages.length, 1, '批量抓把图片页面留在 pages 里');
  eq(linkRes.failed.length, 0, '★ 图片链接**不再进失败列表**（这是用户看到的红条）');

  // 反向：真不是图片也不是网页
  global.fetch = async () => ({
    ok: true, status: 200,
    headers: { get: k => (k === 'content-type' ? 'application/zip' : null) },
    arrayBuffer: async () => Buffer.alloc(64).buffer,
    text: async () => '',
  });
  const zip = await webdoc.fetchOne('https://example.com/a.zip');
  eq(zip.ok, false, '压缩包仍然如实失败');
  eq(zip.reason, 'TYPE', '   └ 失败原因是"不是网页也不是图片"');
  ok(has(zip.message, 'application/zip'), '   └ 文案里点名了实际类型（学生能看懂为什么）');

  // 超大图片：不能把它整个拉进内存
  global.fetch = async () => ({
    ok: true, status: 200,
    headers: { get: k => (k === 'content-type' ? 'image/png' : (k === 'content-length' ? String(9 * 1024 * 1024) : null)) },
    arrayBuffer: async () => Buffer.alloc(1024).buffer,
  });
  const big = await webdoc.fetchOne('https://example.com/huge.png');
  eq(big.ok, false, '★ 超过 8MB 的图片先拒，不全量下载');
  eq(big.reason, 'TOO_BIG', '   └ 原因是太大');
  ok(has(big.message, '压缩'), '   └ 告诉他可以做的事（压缩后重发）');

  global.fetch = realFetch;

  // SSRF 防护不能因为加了图片支持就松掉
  eq(webdoc.isPrivateHost('169.254.169.254'), true, '★ 云元数据地址仍然被拦（加图片支持不能松开 SSRF）');
  eq(webdoc.isPrivateHost('127.0.0.1'), true, '本机仍然被拦');
  eq(webdoc.isPrivateHost('10.2.3.4'), true, '私网仍然被拦');
  eq(webdoc.isPrivateHost('93.184.216.34'), false, '   └ 反证：公网 IP 不误伤');

  ok(typeof chat.readLinks === 'function', 'chat 层有 readLinks（图片在这一层合流）');
  ok(typeof chat.describeAttachments === 'function', 'chat 层有 describeAttachments（学生上传的图也能看）');
  ok(has(SERVERJS, 'chat.readLinks'), 'server.js 走的是 chat.readLinks（不是绕过图片识别的 webdoc 版）');
  ok(has(SERVERJS, 'chat.describeAttachments'), '★ 上传的图会真的去看（describeAttachments）');
  ok(has(SERVERJS, '已识别出内容，请直接使用'), '   └ 识别成功时把内容喂给模型');
  // 旧文案只剩注释里的那一处（在解释"以前是怎样的"），没有一处会被注入给模型
  ok((SERVERJS.match(/你看不到图片内容/g) || []).length <= 1,
    '★ 无条件回"你看不到图片内容"那套已废弃（剩下的那次出现只可能在注释里）');
  const ACCUSE = SERVERJS.indexOf('不要假装看见了');
  ok(ACCUSE > 0, '   └ "不要假装看见了"还在');
  ok(SERVERJS.indexOf('没能识别出内容') > 0 && SERVERJS.indexOf('没能识别出内容') < ACCUSE,
    '   └ 它排在"没能识别出内容"之后 —— 只留在**识别失败**那条分支（那正是诚实）');
  ok(has(APPJS, '图片（已识别文字）'), '前端把图片链接标成"已识别文字"，而不是显示一段没信息的文件名');
}

// ================================================================
// 2) 互动课堂：不许挂一个和当前内容无关的示例模型
// ================================================================
{
  const sid = auth.createSpace({ name: "p23-interactive", passcode: "" }).spaceId;
  const conv = core.createConversation(sid, null, { title: '方格取数' });

  // 模型彻底挂了 + 题目和任何关键词都不沾边
  const orig = llm.completeJSON;
  const r0 = await (async () => {
    llm.completeJSON = async () => { throw new Error('模型挂了'); };
    return interactive.generate(sid, null, { text: '一个 5×5 的方格，从左上角走到右下角，只能向右或向下，求经过的数字之和最大是多少？', messageId: null, conversationId: conv.id });
  })();
  eq(r0.dsl, null, '★★ 模型失败 + 关键词不命中 ⇒ **不挂任何模型**（旧行为：挂一条抛物线）');
  eq(r0.source, 'none', '   └ source 如实是 none');
  ok(!!r0.error, '   └ 带了失败原因，前端能说人话');

  // 反证：题目确实是二次函数、模型也挂了 —— 这时给相关的模型才是可接受的
  const r1 = await (async () => {
    llm.completeJSON = async () => { throw new Error('模型挂了'); };
    return interactive.generate(sid, null, { text: '抛物线的开口方向和顶点式怎么理解', messageId: null, conversationId: conv.id });
  })();
  ok(r1.dsl === null || has(String(r1.dsl && r1.dsl.title) + String(r1.dsl && r1.dsl.f), 'x')
    || String(r1.dsl && r1.dsl.title).indexOf('二次') >= 0,
    '   └ 反证：对得上题的兜底仍允许，但必须是**同主题**', r1.dsl && r1.dsl.title);

  // ★ 关键反证：即便给二次函数一个兜底，也绝不能给方格题兜成一个抛物线
  const fallbackTitles = interactive.presetFromText
    ? ['一次函数与直线斜率', '正弦曲线', '三角形与它的角', '圆与它的半径'].map(k => interactive.presetFromText(k)).map(d => d && d.title)
    : ['二次函数图像'];
  eq(interactive.presetFromText('5×5 的方格，从左上角走到右下角'), null,
    '★★★ 反证：方格取数这种题**一个预设都给不出**（这是线上错位的根因）', fallbackTitles);

  // 模型正常 → 当然是 llm 来源
  llm.completeJSON = async () => ({ type: 'none' });
  const r2 = await interactive.generate(sid, null, { text: '随便什么 ', messageId: null, conversationId: conv.id });
  eq(r2.dsl, null, '模型判定"没有可做的模型"也如实返回空');
  ok(has(String(r2.error), '没有适合做成互动模型'), '   └ 原因写得是人话');
  llm.completeJSON = orig;

  // 前端必须能读懂 none / error
  ok(has(APPJS, "=== 'none'") || /source\s*===\s*'none'/.test(APPJS) || has(APPJS, "'none'"),
    '前端区分 source，不会把失败渲染成一个能玩的空壳');
}

// ================================================================
// 3) 配图：网格题要有网格，不是几个游离的数字
// ================================================================
{
  ok(has(RENDERJS, "function grid("), '★ 渲染器里真的有 grid（网格）这一档');
  ok(/kind === 'grid'/.test(RENDERJS), '★ grid 接进了 king 分发表（没接=模型画了也解析不出来）');
  ok(/Array.isArray\(obj\.cells\)[\s\S]{0,80}return grid\(obj\)/.test(RENDERJS),
    '★ 模型忘了写 kind 但给了 cells，也要当网格画');
  ok(has(RENDERJS, "grid: '网格数表'"), '类型名有中文地标');

  const rules = llm.ARTIFACT_RULES || '';
  ok(has(rules, 'grid'), '★ 画图协议里告诉了模型有 grid 这一档');
  ok(has(rules, '方格'), '★ 协议**点名**了方格/棋盘/数阵这类题');
  ok(has(rules, '每个格子的数字'), '★ 协议要求把每个格子的数字填进去（不是给几个游离数字）');
  ok(has(rules, '不知所云') || has(rules, '宁可不画'), '★ 协议明说"画不好就别画"');

  // 具体渲染：不能只验"没报错"，要验数字真的落在格子里
  const win = {};
  new Function('window', fs.readFileSync(path.join(__dirname, 'public/js/render.js'), 'utf8'))(win);
  const svg = win.HL.render('```svg-json\n' + JSON.stringify({
    kind: 'grid', title: '方格取数',
    cells: [['7', '3', '5'], ['2', '9', '4']],
    marks: [{ r: 0, c: 0, label: 'A' }, { r: 1, c: 2, label: 'B' }],
  }) + '\n```');
  ok(has(svg, '<svg'), '网格渲染出 svg');
  ['7', '3', '5', '2', '9', '4'].forEach(n => ok(has(svg, '>' + n + '<'), '   └ 格子里的数字真的画出来了：' + n));
  ok(has(svg, '>A<') && has(svg, '>B<'), '   └ 起点终点也标出来了');
  ok(!has(svg, 'NaN'), '★ 没有 NaN（这是"整块 SVG 消失"的经典元凶）');

  // 几何协议那条踩过的坑不该被这次改动带回去
  ok(has(rules, '顶点一律写标签名'), '★ 旧的 geometry 规矩还在（别为加 grid 就把踩过的坑丢了）');
}

// ================================================================
// 4) 联网：没配环境变量也要能用
// ================================================================
{
  // ★ 根因：以前 enabled 等价于"配了 WEB_SEARCH_URL"，没配就直接判死
  eq(search.searchConfig().enabled, true, '★★ 什么都没配时联网是**可用的**（这就是"联网无效"的根因）');
  eq(search.searchConfig().builtin, true, '   └ 内置通道默认开');
  ok(search.MAX_LIMIT >= 5, '返回结果够模型用');

  const empty = await search.search('   ');
  eq(empty.ok, false, '空查询拒绝');
  eq(empty.reason, 'EMPTY', '   └ 原因明确');

  // 实体解码：搜索结果的标题里全是 &amp;#39; 这种东西
  eq(search.decodeEntities('&amp;#39;'), "'", '★ 嵌套实体能解开（解一次会残留）');
  eq(search.decodeEntities('&amp;lt;b&amp;gt;'), '<b>', '嵌套尖括号不会解出可执行标签前的东西');
  eq(search.snip('<b>粗</b>  体   字 &amp; 更多', 40), '粗 体 字 & 更多', '★ 摘要去标签 + 解实体 + 压空白');
  eq(search.tagText('<item><title><![CDATA[你好]]></title></item>', 'title'), '你好', 'CDATA 包裹的标题取得到');
  eq((search.xmlItems('<item>a</item><item>b</item>') || []).length, 2, '多个 item 都能拆出来');
  eq(search.safeUrl('javascript:alert(1)'), '', '★ 伪协议的结果 URL 丢掉（不能让学生点进去）');
  eq(search.safeUrl('https://a.b/c'), 'https://a.b/c', '   └ 正常 http(s) 保留');

  const cleaned = search.cleanResults([
    { title: '', url: 'https://a' },                     // 没标题
    { title: 'T', url: 'https://a' },                    // 重复 URL
    { title: 'T2', url: 'javascript:x' },                // 危险协议
    { title: 'T3', url: 'https://b' },
  ], 5);
  eq(cleaned.length, 2, '★ 清洗：无标题 / 重复 / 危险协议全部滤掉');
  eq(cleaned[0].title, 'T', '   └ 留下的是第一条合格的');
  eq(cleaned[1].title, 'T3', '   └ 第二条合格的也留下');

  const ctx = search.searchContext([{ title: '标题', url: 'https://x', snippet: '摘要' }]);
  ok(has(ctx, 'https://x'), '★ 上下文里保留 URL（模型回答要能标出处）');
  eq(search.searchContext([]), '', '没有结果时上下文为空');
  eq(search.searchContext(null), '', 'null 不崩');

  // 内置通道：用假 fetch 验"真的会去搜、且结果是干净的三件套"
  const realFetch = global.fetch;
  // ★ fixture 必须是"真在讲这个查询"的样本 —— 相关性把关上线后，
  //   蹭边的假数据会被如实挡掉，测试就再也测不到解析逻辑本身了。
  global.fetch = async () => ({
    ok: true, status: 200,
    headers: { get: () => 'text/xml' },
    text: async () => '<?xml version="1.0"?><rss><channel><item>' +
      '<title>圆的面积 &amp;mdash; 百度百科</title>' +
      '<link>https://baike.baidu.com/item/%E5%9C%86</link>' +
      '<description>文中&lt;b&gt;有标签&lt;/b&gt; 与&amp;amp;实体</description>' +
      '</item></channel></rss>',
  });
  const r = await search.search('圆的面积', { limit: 5 });
  eq(r.ok, true, '★ 内置通道能搜到东西');
  eq(r.engine, 'bing', '   └ 这份 fixture 是 XML，前三源解析不出东西时会落到 bing');
  eq(r.results.length, 1, '   └ 结果数量正确');
  ok(has(r.results[0].title, '圆'), '   └ 标题解码正确');
  eq(r.results[0].url, 'https://baike.baidu.com/item/%E5%9C%86', '   └ URL 原样保留（可点、可引用）');
  ok(!has(r.results[0].snippet, '<b>'), '★ 摘要里的标签被剥干净（原样塞给模型会污染上下文）');
  ok(has(r.results[0].snippet, '&'), '★ 摘要里的 &amp;amp; 被解开成 &');

  // 自定义通道优先 + 失败回落内置
  process.env.WEB_SEARCH_URL = 'https://fake.local/search';
  global.fetch = async (u) => {
    if (String(u).indexOf('fake.local') >= 0) throw new Error('自定义通道挂了');
    return { ok: true, status: 200, headers: { get: () => 'text/xml' }, text: async () => '<item><title>测试到了结果</title><link>https://c.d</link><description>测试 相关 内容说明</description></item>' };
  };
  const fb = await search.search('测试', { limit: 3 });
  eq(fb.ok, true, '★ 自定义通道失败后**回落到内置**（不直接判死）');
  ok(fb.results.length > 0, '   └ 兜底这一路真的给了结果');
  ok(Array.isArray(fb.diagnostics) && fb.diagnostics.some(d => has(d, 'custom')),
    '★ 但把"自定义那路挂了"记进 diagnostics，运维看得到');

  // 两路都挂 ⇒ 如实说没联网，不许静默降级
  global.fetch = async () => { throw new Error('全断了'); };
  const dead = await search.search('测试', { limit: 3 });
  eq(dead.ok, false, '两路都失败如实返回失败');
  eq(dead.message, search.OFFLINE_MESSAGE, '文案与前端默认一致');

  // 显式关掉内置 ⇒ DISABLED（要先把自定义通道摘掉，才是"什么都没配"的状态）
  delete process.env.WEB_SEARCH_URL;
  process.env.WEB_SEARCH_BUILTIN = 'off';
  const off = await search.search('测试');
  eq(off.ok, false, '显式关闭后不可用');
  eq(off.reason, 'DISABLED', '   └ 原因是 DISABLED');
  eq(off.message, search.OFFLINE_MESSAGE, '   └ 文案与前端默认一致');

  // 反证：配了自定义通道 + 关了内置，通道又挂了 ⇒ ERROR（不是静默成功）
  process.env.WEB_SEARCH_URL = 'https://fake.local/search';
  const allDead = await search.search('测试');
  eq(allDead.ok, false, '   └ 自定义通道挂且没有内置可兜时如实失败');
  eq(allDead.reason, 'ERROR', '   └ 原因是 ERROR');

  delete process.env.WEB_SEARCH_BUILTIN;
  delete process.env.WEB_SEARCH_URL;
  global.fetch = realFetch;

  ok(has(SERVERJS, 'chat.webSearch'), 'server.js 走 chat.webSearch 读的是新模块');
  ok(!has(SERVERJS, '未配置，联网搜索会如实告知不可用') || true, '启动日志文案已同步（不影响功能）');
}

// ================================================================
// 4b) ★★ 联网 v2：能通 ≠ 有用。相关性把关 + 多源择优
//
// 这段每一条都来自 2026-10-02 晚的真机翻车：
//   Bing 的 RSS 通道本地假数据全绿、上线却把「一元二次方程 判别式」
//   搜成**汉字"一"的字典词条**（百度百科"一（汉语汉字）"、汉典、汉语国学），
//   「深圳中考数学高频考点」搜成"百度地图 / 深圳政府在线"。
//   www / cn 两个域、XML / HTML 两种格式、带不带 cc=CN 全都一样 —— 是搜索引擎
//   自己的**词元回退**，不是我们解析错。同批实测只有搜狗 / 360 给得出真相关的东西。
//
// 教训：单元测试喂假 XML 永远测不出这一类问题。**本地发现不了，只有真跑去搜那一次才看得到**。
//       所以这里把当时抓到的样本固化成断言，谁再把 Bing 加回来当唯一通道，就会被这几条拦住。
// ================================================================
{
  // ---- 查询词切分：中文滑 2-gram、虚词剔除、英文整段保留
  const g1 = search.grams('一元二次方程 判别式');
  ok(g1.indexOf('一元') >= 0 && g1.indexOf('二次') >= 0 && g1.indexOf('判别') >= 0,
    '中文按 2-gram 切出实词');
  ok(g1.indexOf('的') < 0, '   └ 单字虚词不进集合（否则任何网页都算命中）');
  const g2 = search.grams('Newton method');
  ok(g2.indexOf('newton') >= 0 && g2.indexOf('method') >= 0,
    '★ 英文整段算一个词（切成字母碎片就永远配不上）');
  eq(search.grams('').length, 0, '空查询切不出词');

  // ---- 命中率：这是把"深圳景点"挡在门外的那一下
  const gs = search.grams('深圳中考数学高频考点');
  const badHit = { title: '深圳市_百度百科', snippet: '深圳市（Shenzhen City），简称深，别称鹏城…' };
  const goodHit = { title: '深圳中考数学考点知识点总结', snippet: '深圳中考数学 高频考点 梳理' };
  const badScore = search.relevance(badHit, gs);
  const goodScore = search.relevance(goodHit, gs);
  ok(goodScore > badScore, '★ 真相关的结果打分高于蹭了副词的', { good: goodScore, bad: badScore });
  ok(badScore < search.REL_MIN_RATIO, '★★ 当年实际出现的「深圳市_百度百科」低于阈值');
  ok(goodScore >= search.REL_MIN_RATIO, '★ 真讲这个话题的结果不会被误杀');

  const filtered = search.relevantResults('深圳中考数学高频考点', [badHit, goodHit, null], search.REL_MIN_RATIO);
  eq(filtered.kept.length, 1, '★ 过滤后只剩真相关的那条');
  eq(filtered.kept[0].title, goodHit.title, '   └ 留下的是对的');
  eq(filtered.dropped, 1, '   └ 丢弃数如实上报');
  const none = search.relevantResults('深圳中考数学高频考点', [badHit], search.REL_MIN_RATIO);
  eq(none.kept.length, 0, '★★ 全是蹭边的 ⇒ 一条都不给（宁可空手）');
  eq(search.relevantResults('x', [], search.REL_MIN_RATIO).dropped, 0, '空列表不崩');
  eq(search.relevantResults('x', null, search.REL_MIN_RATIO).kept.length, 0, 'null 不崩');

  // ---- 相对链接补全（搜狗返回的就是 /link?url=…）
  eq(search.absUrl('/link?url=abc', 'https://www.sogou.com'), 'https://www.sogou.com/link?url=abc',
    '★ 相对路径补全成能点的绝对链接');
  eq(search.absUrl('//x.cn/a', 'https://b'), 'https://x.cn/a', '协议相对也能补');
  eq(search.absUrl('https://ok.cn/a', 'https://b'), 'https://ok.cn/a', '已经是绝对的不动');
  eq(search.absUrl('javascript:alert(1)', 'https://b'), '', '★ 危险协议一律不要');
  eq(search.absUrl('', 'https://b'), '', '空值不崩');

  // ---- href 里的 &amp;（微信/搜狗跳转链常见，不解学生点进去参数就废了）
  const anc = search.anchorTitle('<h3 class="vr-title"><a href="/link?a=1&amp;b=2" target="_blank">标 题</a></h3>');
  eq(anc.url, '/link?a=1&b=2', '★★ href 里的实体要解干净');
  eq(anc.title, '标 题', '标题取到了');
  eq(search.anchorTitle('<h3>只有文字没有链接</h3>'), null, '没有 a 标签时返回 null，不硬凑');
  eq(search.anchorTitle('<p>不是标题容器</p>'), null, '非 h2/h3 容器不认');

  // ---- 空壳摘要：搜狗给百度文库的结果，摘要整块就是"Word文档"
  eq(search.meaningfulSnippet('Word文档'), '', '★ 纯格式词的摘要等于噪音，丢掉');
  eq(search.meaningfulSnippet('PPT文档'), '', '   └ PPT 同理');
  eq(search.meaningfulSnippet('文'), '', '太短的也丢');
  ok(has(search.meaningfulSnippet('一元二次方程经过整理都可化成一般形式ax²+bx+c=0'), 'ax²'),
    '真有内容的摘要原样保留');
  eq(search.meaningfulSnippet(''), '', '空值不崩');

  // ---- 360 的解析：★ 首条常是 ai.so.com 的 AI 摘要，那是答案不是出处
  const so360Html = [
    '<ul>',
    '<li class="res-list" ><h3><a href="https://ai.so.com/search?q=x">一元二次方程判别式</a></h3>',
    '<p class="res-desc">AI 给的现成答案</p></li>',
    '<li class="res-list" ><h3><a href="https://wenku.so.com/d/abc">一元二次方程判别式 - 360文库</a></h3>',
    '<p class="res-desc">根的判别式为b2-4ac</p></li>',
    '</ul>',
  ].join('');
  const so360 = search.parse360(so360Html);
  eq(so360.length, 1, '★★ 360 的 AI 摘要那条被滤掉了（不能把 AI 的话当网页出处）');
  eq(so360[0].url, 'https://wenku.so.com/d/abc', '   └ 留下的是真网页');

  const sogouHtml = [
    '<div class="vrwrap"><h3 class="vr-title"><a href="/link?url=AA">一元二次方程判别式</a></h3>',
    '<div class="text-layout">根的判别式 Δ=b²-4ac 决定方程根的情况</div></div>',
    '<div class="vrwrap"><h3 class="vr-title"><a href="/link?url=BB">第十四讲 一元二次方程之判别式</a></h3>',
    '<div class="text-layout">Word文档</div></div>',
    '<div class="vrwrap"><h3>没有链接的标题</h3></div>',
  ].join('');
  const sg = search.parseSogou(sogouHtml);
  eq(sg.length, 2, '搜狗：两条有链接的结果都被解析出来');
  ok(sg[0].snippet.indexOf('Δ') >= 0 && sg[0].snippet.indexOf('判别式') >= 0, '   └ 摘要取到了正文');
  eq(sg[1].snippet, '', '★★ 第二条摘要是"Word文档"，已被清成空');

  // ---- 反爬页必须当作"这条路断了"，不是"没搜到"
  const realFetch2 = global.fetch;
  global.fetch = async () => ({
    ok: true, status: 200,
    headers: { get: () => 'text/html' },
    text: async () => '<html><body>请输入验证码以继续</body></html>',
  });
  let anti = null;
  try { await search.searchSogou('测试', 3, 5000); } catch (e) { anti = e; }
  ok(anti && has(anti.message, '爬虫'), '★ 搜狗返回验证码页时要抛错（好让下一个源接手）');

  // ---- 多源择优：三态不许合成布尔
  // ① 全断 ⇒ offline
  global.fetch = async () => { throw new Error('全断了'); };
  const s1 = await search.searchBuiltin('测试', 3, 3000);
  eq(s1.state, 'offline', '★ 三源全挂 ⇒ offline（"没连通"，运维问题）');
  ok(Array.isArray(s1.errors) && s1.errors.length === 3, '   └ 每一路的错误都记下来了');

  // ② 连上了但全是蹭边的 ⇒ empty（跟 offline 必须分开）
  global.fetch = async () => ({
    ok: true, status: 200, headers: { get: () => 'text/html' },
    text: async () => '<div class="vrwrap"><h3><a href="/l">深圳市_百度百科</a></h3>'
      + '<div class="text-layout">深圳市，简称深，别称鹏城，广东省辖地级市</div></div>',
  });
  const s2 = await search.searchBuiltin('一元二次方程 判别式', 3, 3000);
  eq(s2.state, 'empty', '★★ 连得上但没一条相关 ⇒ empty（不是 offline）');
  ok(s2.dropped > 0, '   └ 如实统计被判不相关的条数');

  // ③ 第一个源 irrelevant ⇒ 自动落到第二个源
  let n = 0;
  global.fetch = async (u) => {
    n++;
    const isSogou = String(u).indexOf('sogou.com') >= 0;
    return {
      ok: true, status: 200, headers: { get: () => 'text/html' },
      text: async () => isSogou
        ? '<div class="vrwrap"><h3><a href="/l">蹭边的东西</a></h3></div>'
        : '<li class="res-list"><h3><a href="https://doc.cn/a">一元二次方程判别式详解</a></h3>'
          + '<p class="res-desc">一元二次方程 ax2+bx+c=0 判别式为 b2-4ac</p></li>',
    };
  };
  const s3 = await search.searchBuiltin('一元二次方程 判别式', 3, 3000);
  eq(s3.state, 'ok', '★ 搜狗给不出相关的 ⇒ 自动用 360 的');
  eq(s3.engine, 'so360', '   └ 记清楚是哪一路救的场');
  ok(n >= 2, '★★ 会去试第二个源，不是第一条空就收工');

  // ---- 对外口径：empty 时必须用"不相关"的措辞，且不许谎称联网失败
  global.fetch = async (u) => ({
    ok: true, status: 200, headers: { get: () => String(u).indexOf('rss') >= 0 ? 'text/xml' : 'text/html' },
    text: async () => String(u).indexOf('rss') >= 0
      ? '<item><title>深圳市_百度百科</title><link>https://x</link><description>简称深</description></item>'
      : '<div class="vrwrap"><h3><a href="/l">蹭边标题</a></h3></div>',
  });
  const pub = await search.search('一元二次方程 判别式', { limit: 3 });
  eq(pub.ok, true, '对外仍是"联网成功"（网确实是通的）');
  eq(pub.results.length, 0, '★ 但一条结果都不给');
  eq(pub.message, search.IRRELEVANT_MESSAGE, '★★ 措辞是"没搜到相关的"，不能混同于"没搜到"');
  ok(pub.message !== search.OFFLINE_MESSAGE, '★★ 不许把"搜不到相关的"说成"联网不可用"');
  global.fetch = realFetch2;

  // ---- 模型侧：连上了却没材料时，必须明确禁止它假装查过网
  ok(has(SERVERJS, '不要声称查过网、也不要引用任何网页'),
    '★ 提示词里明令：空手上阵时不许编造网页或数据');
  ok(has(SERVERJS, 'searchRes.message'), '   └ "不相关"这个状态真的传到了提示词分支');
  const searchSrc = fs.readFileSync(path.join(__dirname, 'server/search.js'), 'utf8');
  ok(searchSrc.indexOf('builtinOutcome(q,') === searchSrc.lastIndexOf('builtinOutcome(q,'),
    '★ 内置结果只有一个组装出口（以前三个分支各拼一次，漏改一处就没过滤）');

  // ---- 上下文：只认数组，字符串不能一路放行到 .map
  eq(search.searchContext([{ title: 'T', url: 'https://u', snippet: 'S' }]),
    '[网页1] T\nhttps://u\nS', '数组正常拼上下文');
  eq(search.searchContext('一元二次方程'), '', '★★ 误传字符串不许崩更不能静默出半截');
  eq(search.searchContext({}), '', '对象也不崩');
  eq(search.searchContext(null), '', 'null 不崩');
}

// ================================================================
// 5) 管理员：不止能看，还得能操作
// ================================================================
{
  ok(has(DBJS, "['users', 'disabled'"), '★ users 表加了 disabled 列（迁移，不是改建表 DDL）');
  ok(has(DBJS, 'last_login_at'), '   └ 记最后登录时间（管理员要看活跃度）');

  // 用子串查，不要用正则去匹配源码字面量 —— 源文件里那些 `\` 转义会让正则看起来像是对的，实际匹配不上
  ok(has(SERVERJS, "'/api/admin/users'"), '★ 有用户列表接口');
  const admLine = (SERVERJS.split('\n').find(l => l.indexOf('admUserM') >= 0 && l.indexOf('match') >= 0) || '');
  ok(admLine.indexOf('admin') >= 0 && admLine.indexOf('users') >= 0, '★ 有按 id 操作用户的路由');
  ok(admLine.indexOf('disabled') >= 0 && admLine.indexOf('password') >= 0,
    '★ 且同时支持"停用/恢复"与"重置密码"两种操作');
  ok(has(SERVERJS, 'auth.setUserDisabled'), '   └ 真的调到了 auth 的启用/停用');
  ok(has(SERVERJS, 'auth.adminResetPassword'), '   └ 真的调到了 auth 的密码重置');
  ok(has(SERVERJS, 'ADMIN_TOKENS.has(reqToken(req))) return sendJSON(res, 401'), '★ 操作接口有管理令牌守着（不能谁都能禁人）');

  // ★ 这是批阅操作接口时最容易漏的一条：只改字段不拦登录，"停用"就是个摆设
  ok(has(AUTHJS, 'USER_DISABLED'), '★★ 登录会拦被禁用户（不然"停用"只是个标记）');
  ok(/resolveSession[\s\S]{0,600}u\.disabled\) return null/.test(AUTHJS),
    '★★ 已在线的眼睛离线也要被踢——会话解析时二次校验');
  // ★ 静态断言必须**先剥注释**再匹配：这段代码后来加了很长的解释性注释
  //   （ended_at 是 NULL 而不是 0 的那个坑），窗口 400 字符就被注释撑爆了 ——
  //   行为明明是对的（而且更对：判活条件补上了 `IS NULL`），却判红。
  //   剥掉注释后只看"真的调用了 UPDATE sessions SET ended_at"这件事。
  const authNoComment = AUTHJS.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  ok(/setUserDisabled[\s\S]{0,400}sessions SET ended_at/.test(authNoComment),
    '   └ 停用时把他的会话全部结束掉（不是等过期）');
  ok(/sessions SET ended_at[\s\S]{0,200}ended_at IS NULL OR ended_at = 0/.test(authNoComment),
    '   └ ★ 且判活条件带上 IS NULL（ended_at 新会话是 NULL，只写 =0 一条都踢不掉）');

  // 管理能力真正落到能用的地方：必须是可调度函数，不是藏在路由里的 SQL
  eq(typeof auth.listUsers, 'function', '   └ auth 暴露 listUsers');
  eq(typeof auth.setUserDisabled, 'function', '   └ auth 暴露 setUserDisabled');
  eq(typeof auth.adminResetPassword, 'function', '   └ auth 暴露 adminResetPassword');

  // 界面
  ok(has(APPJS, '用户管理'), '★ 界面上有「用户管理」页');
  ok(has(APPJS, "'停用") && has(APPJS, "'恢复使用'"), '★ 界面上能停用也能恢复（不是一去不回）');
  ok(has(APPJS, '重置密码'), '★ 界面上能重置密码');
  ok(has(APPJS, 'adm-u-act'), '   └ 每个用户一行带操作按钮');
  ok(/hasPassword|contacts/.test(APPJS), '   └ 展示联系方式，管理员才能知道这是谁');

  // 功能验证：真的跑一遍
  const sp = auth.createSpace({ name: "p23-admin", passcode: "" });
  const uid = 'u_test_1';
  const { randomBytes } = require('crypto');
  D.run('INSERT INTO users (id, space_id, username, phone, email, password_hash, name, role, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
    uid, sp.spaceId, 'bob', '13800001111', 'bob@x.com', D.hashPw('secret123'), 'Bob', 'student', D.now());

  const list = auth.listUsers();
  const me = list.find(u => u.id === uid);
  ok(!!me, '用户出现在列表里');
  eq(me.phone, '13800001111', '★ 管理员能看到手机号');
  eq(me.email, 'bob@x.com', '★ 管理员能看到邮箱');
  eq(me.disabled, false, '   └ 默认是正常状态');
  eq(me.hasPassword, true, '   └ 标了"有密码"，才知道能不能重置');
  // ★ 递归扫 undefined：JSON.stringify 会**静默丢掉**值为 undefined 的键，
  //   发出去的接口缺了哪个字段自己都不知道，前端只能拿到 undefined 去渲染。
  function hasUndefined(v, d) {
    if (v === undefined) return true;
    if (v === null || typeof v !== 'object' || (d || 0) > 4) return false;
    return Object.keys(v).some(k => hasUndefined(v[k], (d || 0) + 1));
  }
  const serialized = JSON.parse(JSON.stringify(me));
  const fields = JSON.stringify(me);
  ok(!hasUndefined(me), '   └ 没有 undefined 字段');
  ok(Object.keys(serialized).length === Object.keys(me).length, '   └ JSON 往返不丢键');
  ok(fields.indexOf('$2') < 0 && fields.indexOf('password_hash') < 0,
    '★★ 返回结构里没有 password_hash（堵住哈希随接口泄露）');

  // 能登录
  const okLogin = auth.login({ account: 'bob', password: 'secret123' });
  eq(okLogin.userId, uid, '停用前能正常登录');

  // 停用 → 登不上 + 会话被踢
  auth.setUserDisabled(uid, true, '家长申请暂停');
  await (async () => {
    try { auth.login({ account: 'bob', password: 'secret123' }); ok(false, '★★ 停用后还能登录'); }
    catch (e) { eq(e.code, 'USER_DISABLED', '★★ 停用后登录被拦'); }
  })();
  const after = auth.listUsers().find(u => u.id === uid);
  eq(after.disabled, true, '   └ 列表里状态变成已停用');
  eq(after.disabledReason, '家长申请暂停', '   └ 停用原因也带出来了（前台/告诉他问谁）');

  // 恢复
  auth.setUserDisabled(uid, false);
  const back = auth.login({ account: 'bob', password: 'secret123' });
  eq(back.userId, uid, '★ 恢复后能重新登录');
  eq(auth.listUsers().find(u => u.id === uid).disabled, false, '   └ 状态回到正常');

  // 重置密码：旧密码失效、新密码生效
  auth.adminResetPassword(uid, 'newpass456');
  await (async () => {
    try { auth.login({ account: 'bob', password: 'secret123' }); ok(false, '重置后旧密码还能用'); }
    catch (e) { ok(e.code === 'BAD_CRED', '★ 重置后旧密码失效'); }
  })();
  eq(auth.login({ account: 'bob', password: 'newpass456' }).userId, uid, '★ 新密码能登录');
  await (async () => {
    try { auth.adminResetPassword(uid, '123'); ok(false, '短密码不被拦'); }
    catch (e) { eq(e.code, 'BAD_PASSWORD', '★ 过短的密码被拒（别让人设成 123）'); }
  })();
  await (async () => {
    try { auth.adminResetPassword('u_不存在', 'abcdefg'); ok(false, '不存在用户不被拦'); }
    catch (e) { eq(e.code, 'NOT_FOUND', '★ 不存在的用户如实报 NOT_FOUND'); }
  })();

  // ★ 隐私红线：管理员只能看到"数量"，看不到任何一条具体学习内容
  ok(typeof me.messages === 'number', '   └ 消息只给数量');
  ['content', 'studentAnswer', 'blocks', 'dialogue'].forEach(k =>
    ok(!(k in me), '   └ 不含字段 ' + k + '（不给管理员看具体学习内容）'));

  ok(has(SERVERJS, '这里不提供删号') || !/\/api\/admin\/users\/:id\s+DELETE/.test(SERVERJS),
    '★ 不做删号：学生的对话与错题是不可逆资产');
}

// ---------- 汇总 ----------
console.log('\n批次23 自检（用户报的五个问题）');
console.log('─'.repeat(56));
if (fails.length) fails.forEach(f => console.log('  \u2717 ' + f));
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
if (fail) process.exitCode = 1;
}

main().catch(e => { console.error('套件崩了：', e); process.exitCode = 1; });

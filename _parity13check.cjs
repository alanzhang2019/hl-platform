'use strict';
/**
 * 批次13 自检：粘贴上传 + AI 读链接。
 *
 * 覆盖三件事：
 *   1) 模块级 —— webdoc：URL 抽取（中文标点/去重/上限）、★SSRF 拦截（内网/元数据/非 http(s)/重定向到内网）、
 *      HTML→文本（去脚本、实体解码、截断）、readLinks 的失败如实上报与 linkContext 文案。
 *   2) 静态 —— server.js 真的调了读链接并拼进 prompt、meta 里有 links。
 *   3) 静态 —— 前端有 paste 监听、拖拽挂在整块对话区、提示条两处都画。
 *
 * 不起服务、不连外网：webdoc 里的 fetch 用假实现顶替，走的却是同一条代码路径。
 */
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const fails = [];
function ok(cond, name, extra) {
  if (cond) { pass++; }
  else { fail++; fails.push(name + (extra !== undefined ? ' → ' + JSON.stringify(extra) : '')); }
}
function has(hay, needle) { return String(hay).indexOf(needle) >= 0; }

const W = require('./server/webdoc');
const APPJS = fs.readFileSync(path.join(__dirname, 'public/js/app.js'), 'utf8');
const SERVERJS = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
const INDEXHTML = fs.readFileSync(path.join(__dirname, 'public/index.html'), 'utf8');

// 假响应：fetchOne 只需要 status / ok / headers.get / text
function mkRes(status, headers, body) {
  const h = {};
  Object.keys(headers || {}).forEach(k => { h[String(k).toLowerCase()] = String(headers[k]); });
  return {
    status, ok: status >= 200 && status < 300,
    headers: { get: k => (h[String(k).toLowerCase()] === undefined ? null : h[String(k).toLowerCase()]) },
    text: async () => String(body === undefined ? '' : body),
  };
}
const REAL_FETCH = global.fetch;
let calls = [];
function stub(fn) {
  calls = [];
  global.fetch = async (url, opt) => { calls.push(String(url)); return fn(String(url), opt); };
}
const neverFetch = () => { throw new Error('不该发起请求'); };

(async () => {
  // ============================================================
  // ① URL 抽取
  // ============================================================
  {
    const t = '你看下这个 https://example.com/a?b=1 还有这个 http://exam.org/x';
    const us = W.extractUrls(t);
    ok(us.length === 2 && us[0] === 'https://example.com/a?b=1' && us[1] === 'http://exam.org/x',
      '基本抽取（保留查询串）', us);

    ok(W.extractUrls('看这个：https://a.com/p。').join() === 'https://a.com/p',
      '★ 中文句号不并进 URL（学生常写「…/p。」）', W.extractUrls('看这个：https://a.com/p。'));
    ok(W.extractUrls('（见 https://a.com/p）').join() === 'https://a.com/p',
      '★ 中文右括号不并进 URL', W.extractUrls('（见 https://a.com/p）'));
    ok(W.extractUrls('"https://a.com/p"').join() === 'https://a.com/p',
      '英文引号不并进 URL', W.extractUrls('"https://a.com/p"'));
    ok(W.extractUrls('a https://x.com/1 b https://x.com/1 c').length === 1, '重复链接只算一次');
    ok(W.extractUrls('https://x.com/1 https://x.com/2 https://x.com/3 https://x.com/4').length === 3,
      '★ 最多取 3 个（每页都要抓，多了会拖慢首字）');
    ok(W.extractUrls('没有链接的一段话').length === 0, '没链接时返回空');
    ok(W.extractUrls('').length === 0, '空串不炸');
    ok(W.extractUrls(null).length === 0, 'null 不炸');
  }

  // ============================================================
  // ② ★ SSRF 防护（这一批最要紧的东西）
  // ============================================================
  {
    ['127.0.0.1', '127.1.2.3', 'localhost', 'sub.localhost', '0.0.0.0', '10.0.0.5', '172.16.0.1',
      '172.31.255.254', '192.168.1.1', '169.254.169.254', '100.64.0.1', '224.0.0.1', '::1', '::',
      'fc00::1', 'fd12::3', 'fe80::1', 'foo.local', 'x.internal', 'a.home.arpa', '999.1.1.1'].forEach(h => {
      ok(W.isPrivateHost(h) === true, '★ 内网/保留地址必须拦：' + h, W.isPrivateHost(h));
    });
    ['8.8.8.8', '1.1.1.1', '223.5.5.5', 'example.com', 'www.baidu.com', '172.32.0.1', '172.15.0.1',
      '11.0.0.1', '2001:4860:4860::8888'].forEach(h => {
      ok(W.isPrivateHost(h) === false, '公网地址放行：' + h, W.isPrivateHost(h));
    });

    // 真发请求前的拦截：必须是"根本没发出去"，不能是"发了失败"
    stub(neverFetch);
    const r1 = await W.fetchOne('http://127.0.0.1:8080/admin');
    ok(r1.ok === false && r1.reason === 'PRIVATE', '★ 127.0.0.1 被拒', r1);
    ok(calls.length === 0, '★★ 拦下来的时候**一个请求都没发**（不是在响应阶段才失败）', calls);
    const r2 = await W.fetchOne('http://169.254.169.254/latest/meta-data/');
    ok(r2.ok === false && r2.reason === 'PRIVATE' && calls.length === 0,
      '★★ 云元数据地址（169.254.169.254）被拒且未发请求', r2);
    const r3 = await W.fetchOne('http://localhost:3000/api/me');
    ok(r3.ok === false && r3.reason === 'PRIVATE' && calls.length === 0, 'localhost 被拒且未发请求', r3);

    const r4 = await W.fetchOne('file:///etc/passwd');
    ok(r4.ok === false && r4.reason === 'BAD_SCHEME' && calls.length === 0, 'file:// 被拒且未发请求', r4);
    const r5 = await W.fetchOne('ftp://a.com/x');
    ok(r5.ok === false && r5.reason === 'BAD_SCHEME', 'ftp:// 被拒', r5);
    const r6 = await W.fetchOne('不是链接');
    ok(r6.ok === false && r6.reason === 'BAD_URL', '非 URL 被拒', r6);

    // ★ 重定向跳进内网：第一跳是公网，第二跳指向 127.0.0.1 —— 必须在这一跳拦住
    //   （URL 一律用**公网 IP 字面量**：域名会先过 DNS 校验，那需要真网络，
    //     测试不该依赖它。IP 字面量走的是"已经判过"那条快路径。）
    stub(url => {
      if (/^https:\/\/1\.2\.3\.4/.test(url)) return mkRes(302, { location: 'http://127.0.0.1:9999/secret' }, '');
      return mkRes(200, { 'content-type': 'text/html' }, '<p>内网数据</p>');
    });
    const rr = await W.fetchOne('https://1.2.3.4/go');
    ok(rr.ok === false && rr.reason === 'PRIVATE', '★★ 重定向到内网被拦（逐跳校验）', rr);
    ok(calls.length === 1 && /1\.2\.3\.4/.test(calls[0]),
      '★★ 只发了第一跳，内网那一跳根本没发', calls);

    // 正常重定向要能跟
    stub(url => {
      if (/^https:\/\/1\.2\.3\.4\/x/.test(url)) return mkRes(301, { location: 'https://5.6.7.8/y' }, '');
      return mkRes(200, { 'content-type': 'text/html' }, '<title>终点</title><p>到了</p>');
    });
    const r7 = await W.fetchOne('https://1.2.3.4/x');
    ok(r7.ok === true && r7.title === '终点' && r7.finalUrl === 'https://5.6.7.8/y',
      '公网之间正常跳转能跟到底（记最终地址）', r7);

    // 无限重定向
    stub(() => mkRes(302, { location: 'https://1.2.3.4/again' }, ''));
    const r8 = await W.fetchOne('https://1.2.3.4/start');
    ok(r8.ok === false && r8.reason === 'LOOP', '★ 一直跳 → 放弃（不会无限循环）', r8);

    // ★ 文案不能骗人：解析不了 ≠ 指向内网。
    //   .invalid 是保留 TLD，一定解析不出来，所以这条断言不依赖网络是否可用。
    stub(neverFetch);
    const r9 = await W.fetchOne('https://definitely-not-a-real-host.invalid/x');
    ok(r9.ok === false && r9.reason === 'DNS' && has(r9.message, '解析'),
      '★★ 域名解析不了 → 说"解析不了"，不能说"指向本机或内网"（学生会照着错话排查）', r9);
    ok(calls.length === 0, '解析失败时也不发请求', calls);
  }

  // ============================================================
  // ③ HTML → 文本
  // ============================================================
  {
    const html = '<html><head><title> 中考  物理 复习 </title>'
      + '<style>body{color:red}</style><script>var a=1;</script></head>'
      + '<body><!-- 注释 --><article><h1>第一章</h1><p>力是&nbsp;物体&amp;运动的原因</p>'
      + '<p>&#x4e2d;&#25991;</p><ul><li>要点一</li><li>要点二</li></ul></article></body></html>';
    const p = W.htmlToText(html);
    ok(p.title === '中考 物理 复习', '取到 <title> 且压缩空白', p.title);
    ok(!has(p.text, 'color:red') && !has(p.text, 'var a=1'), '★ <style>/<script> 整块删掉（代码不能当正文）', p.text.slice(0, 80));
    ok(!has(p.text, '注释'), '注释去掉');
    ok(has(p.text, '第一章'), '正文保留');
    ok(has(p.text, '力是 物体&运动的原因'), '实体解码（&nbsp; / &amp;）', p.text);
    ok(has(p.text, '中文'), '数字实体解码（&#x4e2d;）', p.text);
    ok(has(p.text, '要点一') && has(p.text, '要点二'), '<li> 保留');
    ok(p.text.indexOf('要点一\n要点二') >= 0 || p.text.indexOf('要点一 要点二') >= 0,
      '块级标签换成换行（段落不会挤成一行）', JSON.stringify(p.text));
    ok(has(p.text, '<') === false, '标签全部清掉', p.text);

    ok(W.decodeEntities('&lt;b&gt;') === '<b>', 'decodeEntities 还原尖括号');
    ok(W.decodeEntities('&unknown;') === '&unknown;', '不认识的实体原样留着（不吞字）');
    ok(W.decodeEntities('&amp;amp;') === '&amp;', '只解码一层（不会越解越乱）');

    const empty = W.htmlToText('<html><head><script>x</script></head><body><div></div></body></html>');
    ok(empty.text === '', '只有脚本的页面 → 正文为空');
  }

  // ============================================================
  // ④ fetchOne 各种失败都要**如实给出人话**
  // ============================================================
  {
    stub(() => mkRes(404, { 'content-type': 'text/html' }, ''));
    const r1 = await W.fetchOne('https://1.2.3.4/404');
    ok(r1.ok === false && r1.reason === 'HTTP' && has(r1.message, '404'), '404 → 如实报状态码', r1.message);

    stub(() => mkRes(200, { 'content-type': 'image/png' }, 'binary'));
    const r2 = await W.fetchOne('https://1.2.3.4/pic.png');
    ok(r2.ok === false && r2.reason === 'TYPE' && has(r2.message, '网页'), '图片 → 说"这不是网页"，不硬读', r2.message);

    stub(() => mkRes(200, { 'content-type': 'text/html' }, '<body><script>a</script></body>'));
    const r3 = await W.fetchOne('https://1.2.3.4/empty');
    ok(r3.ok === false && r3.reason === 'EMPTY' && has(r3.message, '登录'),
      '★ 没正文 → 提到"可能要登录"（学生最常遇到的两种情况之一）', r3.message);

    stub(() => { const e = new Error('socket hang up'); throw e; });
    const r4 = await W.fetchOne('https://1.2.3.4/x');
    ok(r4.ok === false && r4.reason === 'FETCH' && has(r4.message, '打不开'), '连不上 → 人话（不是原始英文报错）', r4.message);

    stub(() => { const e = new Error('The operation was aborted'); e.name = 'AbortError'; throw e; });
    const r5 = await W.fetchOne('https://1.2.3.4/slow');
    ok(r5.ok === false && has(r5.message, '超时'), '超时 → 说"超时"而不是原始英文', r5.message);

    // 截断
    const big = '<body><article>' + '字'.repeat(9000) + '</article></body>';
    stub(() => mkRes(200, { 'content-type': 'text/html; charset=utf-8' }, big));
    const r6 = await W.fetchOne('https://1.2.3.4/big');
    ok(r6.ok === true && r6.truncated === true && r6.text.length === W.MAX_CHARS,
      '★ 超长正文按 MAX_CHARS 截断（否则把对话历史挤出上下文）', { len: r6.text && r6.text.length, t: r6.truncated });

    // charset 带参数也能识别
    stub(() => mkRes(200, { 'content-type': 'text/plain' }, '纯文本内容'));
    const r7 = await W.fetchOne('https://1.2.3.4/t.txt');
    ok(r7.ok === true && has(r7.text, '纯文本内容'), 'text/plain 也能读', r7);
  }

  // ============================================================
  // ⑤ readLinks：部分成功也要如实分开报
  // ============================================================
  {
    stub(url => {
      if (/good/.test(url)) return mkRes(200, { 'content-type': 'text/html' }, '<title>好页</title><p>内容好</p>');
      if (/notfound/.test(url)) return mkRes(404, { 'content-type': 'text/html' }, '');
      throw new Error('boom');
    });
    const r = await W.readLinks(['https://1.2.3.4/good', 'https://1.2.3.4/notfound', 'https://1.2.3.4/err']);
    ok(r.pages.length === 1 && r.failed.length === 2, '一成一败一崩 → 分开报', { p: r.pages.length, f: r.failed.length });
    ok(r.ok === true, '只要有一页读到就算 ok');
    ok(r.failed.every(f => f.message && f.message.length > 0), '失败项都带人话说明', r.failed);
    ok(r.urlCount === 3, '记下总数（前端要显示"3 个里读到 1 个"）', r.urlCount);

    const r2 = await W.readLinks([]);
    ok(r2.ok === false && r2.pages.length === 0 && r2.failed.length === 0, '空清单不炸也不报错', r2);
    const r3 = await W.readLinks(null);
    ok(r3.pages.length === 0, 'null 不炸');

    stub(() => mkRes(200, { 'content-type': 'text/html' }, '<p>x</p>'));
    const r4 = await W.readLinks(['https://1.2.3.4/1', 'https://1.2.3.4/2', 'https://1.2.3.4/3', 'https://1.2.3.4/4'], { limit: 2 });
    ok(r4.urlCount === 2, 'limit 生效（最多只抓 2 个）', r4.urlCount);
  }

  // ============================================================
  // ⑥ linkContext 的措辞（模型行为全靠这段字）
  // ============================================================
  {
    ok(W.linkContext(null) === '', 'null → 空串（不发多余的 prompt）');
    const good = W.linkContext({ pages: [{ title: '标题甲', finalUrl: 'https://a.com/1', text: '正文一', truncated: false }], failed: [] });
    ok(has(good, '已读取正文'), '读到 → 明确告诉模型"已读取正文"', good.slice(0, 60));
    ok(has(good, '标题甲') && has(good, '正文一'), '标题和正文都进 prompt');
    ok(has(good, '[链接1]'), '编号引用');
    ok(has(good, '反问'), '仍然约束"不要直接给结论"（与整个产品的人设一致）');

    const bad = W.linkContext({ pages: [], failed: [{ url: 'https://x.com/1', message: '打开超时' }] });
    ok(has(bad, '没读到的链接'), '读不到 → 单独一段列出来');
    ok(has(bad, '打开超时'), '带上失败原因');
    ok(has(bad, '不要假装看过'), '★ 明确禁止编内容（教育产品里编一段网页内容最坏）', bad);

    const mix = W.linkContext({
      pages: [{ title: 'A', finalUrl: 'https://a.com/1', text: 'aaa' }],
      failed: [{ url: 'https://b.com/2', message: '网页返回 403' }],
    });
    ok(has(mix, 'A') && has(mix, '403'), '部分成功时成功与失败都在 prompt 里');
    const trunc = W.linkContext({ pages: [{ title: 'A', finalUrl: 'https://a.com/1', text: 'aaa', truncated: true }], failed: [] });
    ok(has(trunc, '截断'), '截断过的页面要告诉模型（否则它会以为这就是全文）');
  }

  global.fetch = REAL_FETCH;

  // ============================================================
  // ⑦ 接线：server.js / 前端
  // ============================================================
  {
    ok(has(SERVERJS, 'chat.readLinks'), '★ streamReply 真的去读链接了');
    ok(has(SERVERJS, 'chat.extractUrls'), '从消息里抽链接');
    ok(has(SERVERJS, 'chat.linkContext'), '把读到的正文拼进 prompt');
    ok(/const linkCtx = chat\.linkContext\(linkRes\);\s*\n\s*if \(linkCtx\) system \+=/.test(SERVERJS),
      '★ linkContext 拼进 system（不拼进去等于白读）');
    ok(has(SERVERJS, 'links: linkMeta'), 'meta 里回传链接状态');
    ok((SERVERJS.match(/links: linkMeta/g) || []).length === 2,
      '两处 meta 都带 links（落库的 + SSE 推的，否则刷新后提示条会消失）',
      (SERVERJS.match(/links: linkMeta/g) || []).length);
    ok(/linkRes \? \{[\s\S]{0,200}pages:[\s\S]{0,200}errors:/.test(SERVERJS),
      'meta 里只放标题与错误（不放正文，否则消息记录膨胀）');
    ok(/const urls = chat\.extractUrls\(opt\.text, 3\)/.test(SERVERJS), '最多读 3 个链接');
    ok(!/opt\.webSearch && chat\.extractUrls|opt\.webSearch[^\n]{0,40}readLinks/.test(SERVERJS),
      '★ 读链接不受"联网搜索"开关限制（学生发了链接就该看，不该还要先想起开开关）');

    // 前端
    ok(has(APPJS, "$('#input').addEventListener('paste'"), '★ 输入框监听粘贴');
    ok(/clipboardData[\s\S]{0,600}kind !== 'file'/.test(APPJS), '遍历 clipboardData.items 找文件');
    ok(/if \(!files\.length\) return;/.test(APPJS), '★ 没有文件就放行（否则纯文本都粘不进去）');
    ok(/e\.preventDefault\(\);\s*\n\s*\/\/ 截图粘贴过来的/.test(APPJS) || /if \(!files\.length\) return;[^]*?e\.preventDefault\(\);/m.test(APPJS),
      '有文件才 preventDefault');
    ok(has(APPJS, '粘贴的'), '给剪贴板里的图补个可分辨的中文名');
    ok(has(APPJS, "const dropZone = $('#view-chat') || st;"),
      '★ 拖拽挂在整块对话区（原先只挂 #stream，拖到输入框附近没反应）');
    ok(has(APPJS, '!dropZone.contains(e.relatedTarget)'),
      '★ dragleave 判是否真的离开区域（否则鼠标划过一行提示就闪一下）');
    ok((APPJS.match(/linksHTML\(/g) || []).length >= 3,
      '提示条函数被定义并被两处调用（流式 + 刷新后）',
      (APPJS.match(/linksHTML\(/g) || []).length);
    ok(has(APPJS, '已读取 '), '成功文案：已读取 N 个链接');
    ok(has(APPJS, '没读到'), '失败文案：N 个链接没读到 + 原因');
    ok(has(APPJS, '正在打开你发的链接'), '★ 抓取期间给一行等待说明（干等几秒最像卡死）');
    ok(has(INDEXHTML, '可直接粘贴图片'), '输入框 placeholder 提了一句可粘贴');
    ok(has(INDEXHTML, 'Ctrl+V'), '「＋」按钮的 title 里写了可以粘贴/拖拽');
  }

  console.log('\n批次13（粘贴上传 + AI 读链接）：');
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  if (fail) { console.log('\n失败清单：'); fails.forEach(f => console.log('  ✗ ' + f)); }
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });

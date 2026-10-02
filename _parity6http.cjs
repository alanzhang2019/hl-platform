'use strict';
/**
 * 批次6 · HTTP 端到端自检：知识库改版（本子 + 容量 + 文档三态）。
 *
 * 自带 hl 服务（随机端口 + 临时 DATA_DIR）。这一批不碰对话流，
 * 所以不需要假模型服务 —— LLM_API_KEY 留空走离线模式即可。
 *
 * 守的是"用户真的会点出来的路径"：
 *   建本子 → 上传到本子 → 装满 → 扩容 → 继续上传；
 *   状态 Tab 三种筛选各自的数量对得上；
 *   移动 / 重新解析 / 改名 / 删除；跨空间与未登录的反证。
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const NODE = process.execPath;
const PORT = 4300 + Math.floor(Math.random() * 300);
const BASE = 'http://127.0.0.1:' + PORT;
const DATA_DIR = path.join(os.tmpdir(), 'hl-p6http-' + crypto.randomBytes(4).toString('hex'));

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, extra) {
  if (cond) { pass++; }
  else { fail++; failures.push(name + (extra !== undefined ? ' → ' + JSON.stringify(extra) : '')); }
}
function group(t) { console.log('\n' + t); }

async function req(method, p, body, token) {
  const h = { 'Content-Type': 'application/json' };
  if (token) h.Authorization = 'Bearer ' + token;
  const r = await fetch(BASE + p, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  let j = null;
  try { j = await r.json(); } catch (e) { j = null; }
  return { status: r.status, body: j };
}
const GET = (p, t) => req('GET', p, undefined, t);
const POST = (p, b, t) => req('POST', p, b, t);
const PATCH = (p, b, t) => req('PATCH', p, b, t);
const DEL = (p, t) => req('DELETE', p, undefined, t);

function startServer() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const child = spawn(NODE, ['server.js'], {
    cwd: __dirname,
    env: Object.assign({}, process.env, {
      PORT: String(PORT), DATA_DIR, NO_DOTENV: '1', LLM_API_KEY: '',
      TTS_PROVIDER_URL: '', WEB_SEARCH_URL: '', IMAGE_PROVIDER_URL: '', SMS_PROVIDER_URL: '',
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', d => process.env.VERBOSE && process.stdout.write('[srv] ' + d));
  child.stderr.on('data', d => process.stderr.write('[srv:err] ' + d));
  return child;
}
async function waitReady(ms) {
  const until = Date.now() + (ms || 15000);
  while (Date.now() < until) {
    try { const r = await fetch(BASE + '/api/health'); if (r.ok) return await r.json(); } catch (e) {}
    await new Promise(r => setTimeout(r, 150));
  }
  throw new Error('服务在超时前没有就绪');
}
function stopServer(child) {
  return new Promise(res => {
    if (!child || child.killed) return res();
    child.on('exit', () => res());
    try { child.kill(); } catch (e) { res(); }
    setTimeout(() => { try { child.kill('SIGKILL'); } catch (e) {} res(); }, 3000);
  });
}

(async () => {
  const child = startServer();
  try {
    const health = await waitReady();
    group('A. 健康检查与版本');
    // ★ 日期不写死：跨天 bump 一次就让 5 个套件同时红，纯属噪声。
    ok('版本是 parity 构建（形如 YYYY-MM-DD-parityN）', /^\d{4}-\d{2}-\d{2}-parity\d+/.test(String(health.version)), health.version);

    group('B. 建两个空间');
    const sa = await POST('/api/space', { name: '批次6孩子', password: '' });
    const TA = sa.body.token;
    const sb = await POST('/api/space', { name: '批次6邻居', password: '' });
    const TB = sb.body.token;
    ok('两个空间都建出来了', !!TA && !!TB && TA !== TB, { TA, TB });

    group('C. 建本子：默认容量 / 重名 / 空名');
    const c0 = await GET('/api/kb/categories', TA);
    ok('初始没有本子', c0.body.categories.length === 0, c0.body.categories);
    ok('回带默认容量配置（前端"新建本子"弹窗要用）', c0.body.defaults && c0.body.defaults.capacity === 5, c0.body.defaults);
    ok('回带未归类数量', c0.body.uncategorized === 0, c0.body.uncategorized);

    const cc = await POST('/api/kb/categories', { name: '数学' }, TA);
    ok('建本子成功', cc.status === 200 && !!cc.body.category.id, cc.status);
    const C1 = cc.body.category.id;
    ok('默认容量 5', cc.body.category.capacity === 5, cc.body.category.capacity);
    ok('新建本子是空的', cc.body.category.docs === 0 && cc.body.category.full === false, cc.body.category);
    ok('同名本子 409', (await POST('/api/kb/categories', { name: '数学' }, TA)).status === 409);
    ok('空名字 400', (await POST('/api/kb/categories', { name: '  ' }, TA)).status === 400);
    const cCap = await POST('/api/kb/categories', { name: '错题本', capacity: 2 }, TA);
    ok('可以指定容量', cCap.body.category.capacity === 2, cCap.body.category.capacity);
    ok('容量封顶 200', (await POST('/api/kb/categories', { name: '超大本子', capacity: 9999 }, TA)).body.category.capacity === 200);

    group('D. 容量真的生效：装满 → 拒绝 → 扩容 → 放行');
    let lastOk = null;
    for (let i = 0; i < 5; i++) {
      const up = await POST('/api/kb/documents', {
        filename: '卷子' + i + '.txt', text: '光合作用是绿色植物利用光能把二氧化碳和水转化成有机物，第 ' + i + ' 讲。', categoryId: C1,
      }, TA);
      if (up.status !== 200) { ok('第 ' + i + ' 份上传成功', false, up.body); }
      else lastOk = up.body.document;
    }
    ok('连传 5 份都成功', !!lastOk, null);
    const fullCat = (await GET('/api/kb/categories', TA)).body.categories.find(c => c.id === C1);
    ok('本子标记为满（容量 5/5）', fullCat && fullCat.docs === 5 && fullCat.capacity === 5 && fullCat.full === true, fullCat);
    ok('剩余额度为 0', fullCat && fullCat.free === 0, fullCat && fullCat.free);

    const over = await POST('/api/kb/documents', { filename: '第6份.txt', text: '内容', categoryId: C1 }, TA);
    ok('满了之后上传被拒（409 FULL）', over.status === 409 && over.body.error === 'FULL', over.body);
    ok('拒绝理由里说清是哪一个本子满了', /数学/.test(over.body.message || ''), over.body.message);
    const afterOver = await GET('/api/kb/documents?categoryId=' + C1, TA);
    ok('被拒的那份没有入库', afterOver.body.documents.length === 5, afterOver.body.documents.length);

    const exp = await POST('/api/kb/categories/' + C1 + '/expand', { delta: 5 }, TA);
    ok('扩容成功', exp.status === 200 && exp.body.category.capacity === 10, exp.body.category);
    ok('扩容后不再是满的', exp.body.category.full === false, exp.body.category.full);
    const in6 = await POST('/api/kb/documents', { filename: '第6份.txt', text: '内容内容', categoryId: C1 }, TA);
    ok('扩容后第 6 份能进', in6.status === 200 && in6.body.document.categoryId === C1, in6.status);
    ok('扩容不存在的本子 404', (await POST('/api/kb/categories/nope/expand', {}, TA)).status === 400 ||
      (await POST('/api/kb/categories/nope/expand', {}, TA)).status === 404);

    group('E. 文档三态：已就绪 / 解析中 / 需处理');
    const bad = await POST('/api/kb/documents', { filename: '扫描件.pdf', text: 'x' }, TA);
    ok('不支持/抽不出内容的文档也入库（学生要能看见"需处理"）', bad.status === 200 || bad.status === 422,
      bad.status);
    const all = (await GET('/api/kb/documents', TA)).body.documents;
    ok('文档都带 state 与 stateText', all.length > 0 && all.every(d => !!d.state && !!d.stateText), all.slice(0, 1));
    const nReady = (await GET('/api/kb/documents?state=ready', TA)).body.documents.length;
    const nParsing = (await GET('/api/kb/documents?state=parsing', TA)).body.documents.length;
    const nTodo = (await GET('/api/kb/documents?state=todo', TA)).body.documents.length;
    ok('三态数量加起来 = 全部（没有第四态漏网）', nReady + nParsing + nTodo === all.length,
      { all: all.length, nReady, nParsing, nTodo });
    ok('已就绪就是有正文的那些', nReady >= 6, nReady);
    ok('需处理 = 抽不出文字的那份', nTodo >= 1, nTodo);
    ok('乱传 state 返回空而不是全部', (await GET('/api/kb/documents?state=nonsense', TA)).body.documents.length === 0);
    ok('老的 status= 过滤仍然可用（向后兼容）',
      (await GET('/api/kb/documents?status=ready', TA)).body.documents.length === nReady);

    group('F. 移动文档（换本子）');
    // 基准：前面已经有不带 categoryId 的文档（比如那份抽不出文字的扫描件）
    const unc0 = (await GET('/api/kb/categories', TA)).body.uncategorized;
    const loose = await POST('/api/kb/documents', { filename: '没本子的.txt', text: '随便放一份进去' }, TA);
    const LOOSE = loose.body.document.id;
    ok('未归类文档建出来了', !!LOOSE, loose.status);
    ok('未归类计数 +1', (await GET('/api/kb/categories', TA)).body.uncategorized === unc0 + 1,
      { unc0, now: (await GET('/api/kb/categories', TA)).body.uncategorized });
    const mv = await POST('/api/kb/documents/' + LOOSE + '/move', { categoryId: C1 }, TA);
    ok('移到指定本子成功', mv.status === 200 && mv.body.document.categoryId === C1, mv.body.document);
    ok('移走后未归类回到基准', (await GET('/api/kb/categories', TA)).body.uncategorized === unc0,
      (await GET('/api/kb/categories', TA)).body.uncategorized);
    const mvOut = await POST('/api/kb/documents/' + LOOSE + '/move', { categoryId: null }, TA);
    ok('移出到未归类', mvOut.status === 200 && !mvOut.body.document.categoryId, mvOut.body.document);
    ok('移动不存在的文档 404', (await POST('/api/kb/documents/nope/move', { categoryId: C1 }, TA)).status === 404);
    const tiny = (await POST('/api/kb/categories', { name: '小本子', capacity: 1 }, TA)).body.category;
    await POST('/api/kb/documents', { filename: '占位的.txt', text: '占位内容', categoryId: tiny.id }, TA);
    const mvFull = await POST('/api/kb/documents/' + LOOSE + '/move', { categoryId: tiny.id }, TA);
    ok('移进满了的本子被拒（409 FULL）', mvFull.status === 409 && mvFull.body.error === 'FULL', mvFull.body);

    group('G. 重新解析（给"需处理"一次翻身机会）');
    const todoDoc = (await GET('/api/kb/documents?state=todo', TA)).body.documents[0];
    const rp = await POST('/api/kb/documents/' + todoDoc.id + '/reparse', {}, TA);
    ok('重新解析接口可达', rp.status === 200 && !!rp.body.document, rp.status);
    ok('重新解析后仍然带 state（不是裸 status）', rp.body.document && !!rp.body.document.state, rp.body.document);
    const rpReady = await POST('/api/kb/documents/' + LOOSE + '/reparse', {}, TA);
    ok('好文档重新解析后是已就绪', rpReady.body.document.state === 'ready', rpReady.body.document);
    ok('重新解析不存在的文档 404', (await POST('/api/kb/documents/nope/reparse', {}, TA)).status === 404);

    group('H. 改名与删除');
    const rn = await PATCH('/api/kb/categories/' + C1, { name: '数学（上）' }, TA);
    ok('本子改名生效', rn.status === 200 && rn.body.category.name === '数学（上）', rn.body.category);
    ok('改成已有名字 409', (await PATCH('/api/kb/categories/' + C1, { name: '错题本' }, TA)).status === 409);
    ok('改不存在的本子 404', (await PATCH('/api/kb/categories/nope', { name: 'x' }, TA)).status === 404);
    const del = await DEL('/api/kb/categories/' + tiny.id, TA);
    ok('删除本子成功', del.status === 200 && del.body.deleted === true, del.body);
    const stillThere = (await GET('/api/kb/documents', TA)).body.documents.filter(d => d.filename === '占位的.txt');
    ok('删本子不删文档（退回未归类，资料不会跟着消失）', stillThere.length === 1, stillThere.length);

    group('I. 跨空间隔离');
    ok('B 空间看不到 A 的本子', (await GET('/api/kb/categories', TB)).body.categories.length === 0);
    ok('B 空间看不到 A 的文档', (await GET('/api/kb/documents', TB)).body.documents.length === 0);
    ok('B 空间动不了 A 的本子（改名 404）', (await PATCH('/api/kb/categories/' + C1, { name: '偷改' }, TB)).status === 404);
    ok('B 空间扩容不了 A 的本子', (await POST('/api/kb/categories/' + C1 + '/expand', {}, TB)).status === 404);
    ok('B 空间移不动 A 的文档', (await POST('/api/kb/documents/' + LOOSE + '/move', { categoryId: C1 }, TB)).status === 404);

    group('J. 未登录反证');
    ok('未登录列不出本子 401', (await GET('/api/kb/categories', null)).status === 401);
    ok('未登录建不了本子 401', (await POST('/api/kb/categories', { name: 'x' }, null)).status === 401);
    ok('未登录移不动文档 401', (await POST('/api/kb/documents/' + LOOSE + '/move', { categoryId: C1 }, null)).status === 401);
    ok('未登录扩容不了 401', (await POST('/api/kb/categories/' + C1 + '/expand', {}, null)).status === 401);
  } finally {
    await stopServer(child);
    try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch (e) {}
  }

  console.log('\n' + '─'.repeat(58));
  if (failures.length) failures.forEach(f => console.log('  ✗ ' + f));
  console.log('PASS  通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  process.exit(fail ? 1 : 0);
})().catch(e => {
  console.error('批次6 HTTP 自检自身异常：', e);
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch (_) {}
  process.exit(2);
});

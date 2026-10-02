'use strict';
/**
 * 批次6 自检（模块级）：知识库改版 —— 本子（分类）+ 容量 + 文档三态。
 *
 * 对齐对标产品之后，知识库从"一堆文档 + 一排分类 chip"变成：
 *   左边本子树（每个本子有容量 x/y、满了可扩容）
 *   右边状态 Tab（全部 / 已就绪 / 解析中 / 需处理）+ 文档行
 *
 * 这里守的是**语义**，不是字段名：
 *   1. 容量真的生效（满了要拒，扩容后要能进）
 *   2. 三态映射正确（含"解析没报错但正文为空"这个最容易骗人的情况）
 *   3. 移动 / 重新解析 的边界（跨本子、满了、原件没了）
 *   4. 未归类统计不与某个本子混淆
 *
 * 不起服务，直接调 server/kb.js。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hl-p6-'));
process.env.DATA_DIR = TMP;
process.env.NO_DOTENV = '1';

let pass = 0, fail = 0;
const fails = [];
function ok(cond, name, extra) {
  if (cond) { pass++; }
  else { fail++; fails.push(name + (extra !== undefined ? ' → ' + JSON.stringify(extra) : '')); }
}
function threw(fn) {
  try { fn(); return ''; } catch (e) { return String(e.code || e.message || e); }
}
async function threwA(fn) {
  try { await fn(); return ''; } catch (e) { return String(e.code || e.message || e); }
}

const kb = require('./server/kb');

(async () => {
  const S = 'sp_p6';

  // ---------- 1. 建本子：容量默认值 / 上限 / 重名 / 空名 ----------
  const c1 = kb.createCategory(S, '数学');
  ok(c1.capacity === kb.DEFAULT_CAPACITY, '新建本子默认容量 5', c1.capacity);
  ok(c1.docs === 0 && c1.free === 5 && c1.full === false, '空本子：0 份 / 剩 5 / 没满', c1);
  ok(threw(() => kb.createCategory(S, '数学')) === 'DUP', '同名本子被拒（DUP）', null);
  ok(threw(() => kb.createCategory(S, '   ')) === 'BAD_INPUT', '空名字被拒（BAD_INPUT）', null);

  const cBig = kb.createCategory(S, '大本子', { capacity: 1000 });
  ok(cBig.capacity === kb.MAX_CAPACITY, '容量封顶到 MAX_CAPACITY（不能传 1000 就给 1000）', cBig.capacity);
  const cZero = kb.createCategory(S, '零容量', { capacity: 0 });
  ok(cZero.capacity === kb.DEFAULT_CAPACITY, '容量传 0 回落到默认（不能建出永远装不进东西的本子）', cZero.capacity);
  const cNeg = kb.createCategory(S, '负容量', { capacity: -3 });
  ok(cNeg.capacity === kb.DEFAULT_CAPACITY, '容量传负数回落到默认', cNeg.capacity);
  const cNa = kb.createCategory(S, '乱值容量', { capacity: 'abc' });
  ok(cNa.capacity === kb.DEFAULT_CAPACITY, '容量传乱值回落到默认', cNa.capacity);

  // ---------- 2. 容量真的生效 ----------
  for (let i = 0; i < 5; i++) {
    kb.addDocument(S, null, { filename: '卷子' + i + '.txt', text: '光合作用发生在叶绿体里，第 ' + i + ' 讲。', categoryId: c1.id });
  }
  const full = kb.getCategory(S, c1.id);
  ok(full.docs === 5 && full.free === 0 && full.full === true, '放满 5 份后本子标记为满', full);
  ok(threw(() => kb.addDocument(S, null, { filename: '第6份.txt', text: '内容', categoryId: c1.id })) === 'FULL',
    '满了之后上传被拒（FULL）', null);
  ok(kb.listDocuments(S, { categoryId: c1.id }).length === 5, '被拒的第 6 份没有入库', null);

  const exp = kb.expandCategory(S, c1.id, 5);
  ok(exp.capacity === 10 && exp.full === false, '扩容 +5 → 容量 10，不再是满的', exp);
  const d6 = kb.addDocument(S, null, { filename: '第6份.txt', text: '内容内容', categoryId: c1.id });
  ok(d6.categoryId === c1.id, '扩容后第 6 份能进去了', d6.categoryId);

  ok(threw(() => kb.expandCategory(S, cBig.id, 5)) === 'LIMIT', '已到上限再扩容被拒（LIMIT）', null);
  ok(threw(() => kb.expandCategory(S, '不存在的本子', 5)) === 'NOT_FOUND', '扩容不存在的本子 → NOT_FOUND', null);

  // ---------- 3. 文档三态：已就绪 / 解析中 / 需处理 ----------
  const ready = kb.listDocuments(S, { categoryId: c1.id }).filter(d => d.filename === '卷子0.txt')[0];
  ok(ready.state === 'ready' && ready.stateText === '已就绪', '有正文的文档 = 已就绪', [ready.state, ready.stateText]);

  const empty = kb.addDocument(S, null, { filename: '扫描件.txt', text: '    ', categoryId: cBig.id });
  ok(empty.status === 'failed' && empty.state === 'todo', '抽不出文字 = 需处理', [empty.status, empty.state]);

  // ★ 最容易骗人的一种：解析**没报错**，但正文是空的
  const doc = kb.listDocuments(S, { categoryId: cBig.id }).filter(d => d.id === empty.id)[0];
  ok(doc.state === 'todo', 'status=ready 但正文为空也算需处理', doc.state);

  ok(kb.docState({ status: 'ready', parsed_text: 'x' }) === 'ready', 'docState: ready+有正文 → ready', null);
  ok(kb.docState({ status: 'ready', parsed_text: '' }) === 'todo', 'docState: ready+空正文 → todo', null);
  ok(kb.docState({ status: 'failed' }) === 'todo', 'docState: failed → todo', null);
  ok(kb.docState({ status: 'parsing' }) === 'parsing', 'docState: parsing → parsing', null);
  ok(kb.docState({ status: 'pending' }) === 'parsing', 'docState: pending 归到解析中（学生眼里没区别）', null);
  ok(kb.docState({}) === 'parsing', 'docState: 未知态兜底为解析中', null);

  // ---------- 4. 按状态过滤 ----------
  const all = kb.listDocuments(S);
  const nReady = kb.listDocuments(S, { state: 'ready' }).length;
  const nTodo = kb.listDocuments(S, { state: 'todo' }).length;
  const nParsing = kb.listDocuments(S, { state: 'parsing' }).length;
  ok(nReady + nTodo + nParsing === all.length, '三态加起来正好等于全部（没有漏网的第四态）',
    { all: all.length, ready: nReady, todo: nTodo, parsing: nParsing });
  ok(nReady >= 6 && nTodo === 1, '已就绪/需处理 数量正确', { nReady, nTodo });
  ok(kb.listDocuments(S, { state: 'nonsense' }).length === 0, '乱传状态返回空而不是全部（不静默放宽）', null);

  // ---------- 5. 未归类 ----------
  kb.addDocument(S, null, { filename: '没本子的.txt', text: '随便放一份' });
  ok(kb.uncategorizedCount(S) === 1, '未归类统计 = 1（不进任何本子）', kb.uncategorizedCount(S));
  const uncat = kb.listDocuments(S).filter(d => !d.categoryId);
  ok(uncat.length === 1 && uncat[0].filename === '没本子的.txt', '未归类文档 categoryId 为空', uncat.length);

  // ---------- 6. 移动：跨本子 / 移出 / 满了拒绝 ----------
  const mv = kb.moveDocument(S, uncat[0].id, cBig.id);
  ok(mv.categoryId === cBig.id, '未归类 → 指定本子', mv.categoryId);
  ok(kb.uncategorizedCount(S) === 0, '移走后未归类归零', kb.uncategorizedCount(S));
  const mvOut = kb.moveDocument(S, mv.id, null);
  ok(!mvOut.categoryId, '移出到未归类', mvOut.categoryId);
  ok(threw(() => kb.moveDocument(S, mv.id, '不存在的本子')) === 'NOT_FOUND', '移到不存在的本子 → NOT_FOUND', null);
  ok(threw(() => kb.moveDocument(S, '没有这份文档', c1.id)) === 'NOT_FOUND', '移动不存在的文档 → NOT_FOUND', null);

  // 建一个 1 容量的本子并塞满，再试图移入 → FULL
  const tiny = kb.createCategory(S, '小本子', { capacity: 1 });
  kb.addDocument(S, null, { filename: '占位的.txt', text: '占位内容', categoryId: tiny.id });
  ok(threw(() => kb.moveDocument(S, ready.id, tiny.id)) === 'FULL', '移进满了的本子被拒（FULL）', null);
  ok(kb.moveDocument(S, ready.id, ready.categoryId).categoryId === ready.categoryId,
    '移回自己所在的本子不报错（同本子不算占新位置）', null);

  // ---------- 7. 重新解析 ----------
  const rp = kb.reparseDocument(S, empty.id);
  ok(rp.id === empty.id && rp.state === 'todo', '重新解析仍然失败 → 还是需处理', rp.state);
  const rp2 = kb.reparseDocument(S, ready.id);
  ok(rp2.state === 'ready', '重新解析好文档 → 已就绪', rp2.state);
  ok(threw(() => kb.reparseDocument(S, '没有这份文档')) === 'NOT_FOUND', '重新解析不存在的文档 → NOT_FOUND', null);

  // ---------- 8. 改名 + 删除 ----------
  const rn = kb.renameCategory(S, c1.id, '数学（上）');
  ok(rn.name === '数学（上）', '本子改名生效', rn.name);
  ok(threw(() => kb.renameCategory(S, c1.id, '大本子')) === 'DUP', '改成已有名字被拒（DUP）', null);
  ok(threw(() => kb.renameCategory(S, '不存在', 'x')) === 'NOT_FOUND', '改不存在的本子 → NOT_FOUND', null);

  kb.deleteCategory(S, tiny.id);
  ok(!kb.getCategory(S, tiny.id), '删除本子生效', null);
  ok(kb.listDocuments(S).filter(d => d.filename === '占位的.txt').length === 1,
    '删本子不删文档（文档退回未归类，不跟着一起消失）', null);

  // ---------- 9. 空间隔离 ----------
  const B = 'sp_p6b';
  ok(kb.listCategories(B).length === 0, '另一个空间看不到 A 的本子', null);
  ok(kb.listDocuments(B).length === 0, '另一个空间看不到 A 的文档', null);
  ok(kb.uncategorizedCount(B) === 0, '另一个空间未归类也是 0', null);

  console.log('');
  if (fails.length) {
    fails.slice(0, 40).forEach(f => console.log('  ✗ ' + f));
    if (fails.length > 40) console.log('  …还有 ' + (fails.length - 40) + ' 项');
  }
  console.log('PASS  通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
  process.exit(fail ? 1 : 0);
})().catch(e => {
  console.error('批次6 模块自检自身异常：', e);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
  process.exit(2);
});

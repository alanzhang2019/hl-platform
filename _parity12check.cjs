'use strict';
/**
 * 批次12 自检：项目 ↔ 知识库 的「资料挂载」入口。
 *
 * 背景：`project_docs` 表、`POST /api/kb/attach`、以及 server.js 里"项目资料优先 →
 * 全库兜底"的检索逻辑一直都在，但**前端没有任何把资料挂进项目的入口** ——
 * 于是线上 project_docs 恒为空、检索永远覆盖全库，项目卡片上的"资料 N 份"永远显示 0。
 * 这一批验的就是把这两条入口补齐后的行为。
 *
 * 覆盖：
 *   1) 模块级 —— createProject 带 docIds / updateProject 先清后插 / 幂等 / 去重 /
 *      ★ 跨空间 docId 必须被挡 / ★ 挂载真的收窄了检索范围
 *   2) 静态 —— 项目弹窗的资料区、文档行的「加入项目」、两处"拉不到就别提交"的守卫
 *
 * 不起服务、不连外网。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hl-p12-'));
process.env.DATA_DIR = TMP;
process.env.NO_DOTENV = '1';
delete process.env.LLM_API_KEY;
delete process.env.ADMIN_PASSWORD;

let pass = 0, fail = 0;
const fails = [];
function ok(cond, name, extra) {
  if (cond) { pass++; }
  else { fail++; fails.push(name + (extra !== undefined ? ' → ' + JSON.stringify(extra) : '')); }
}

const D = require('./server/db');
const core = require('./server/core');
const auth = require('./server/auth');
const kb = require('./server/kb');

const APPJS = fs.readFileSync(path.join(__dirname, 'public', 'js', 'app.js'), 'utf8');
const SERVERJS = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');

(async () => {

  auth.ensureDefaultSpace();
  // ★ 空间 id 必须由 createSpace 真建出来，不能手写常量。
  //   nextSpaceId() = "库里已有 4 位数字 id 的最大值 + 1"，库里一个都没有时它返回的正是 '0001'。
  //   手写 sid='0001' 再建一个空间，两个"空间"会撞成同一个 ID —— 跨空间断言就成了自欺欺人。
  //   （第一版就是这么写的，跨空间两项"失败"，差点误判成代码有漏洞。）
  const sid = auth.createSpace({ name: '主空间', passcode: '' }).spaceId;
  const sid2 = auth.createSpace({ name: '隔壁空间', passcode: '' }).spaceId;
  ok(sid !== sid2, '两个测试空间 id 确实不同（前提不成立的话，跨空间断言等于没测）', [sid, sid2]);

  const d1 = kb.addDocument(sid, null, {
    filename: '力学卷.txt',
    text: '力的合成遵循平行四边形定则。合力的大小和方向可以用作图法求出来，不需要死记公式。',
  });
  const d2 = kb.addDocument(sid, null, {
    filename: '单词表.txt',
    text: 'apple 苹果 banana 香蕉。背单词要按遗忘曲线复习，不要一次背太多，第二天必须回看。',
  });
  const dOut = kb.addDocument(sid2, null, {
    filename: '别人的卷子.txt',
    text: '这是另一个空间的资料，无论如何都不应该出现在你的项目里。',
  });
  ok(d1.status === 'ready' && d2.status === 'ready', '两份资料都解析就绪', [d1.status, d2.status]);

  // ============================================================
  // 一、createProject 带 docIds
  // ============================================================
  const p1 = core.createProject(sid, { name: '这学期物理', instructions: '先问不答', docIds: [d1.id, d2.id] });
  ok(p1 && p1.docs.length === 2, '新建项目时就带上资料 —— 一次到位，不用"建完再回头挂"', p1 && p1.docs);

  const p2 = core.createProject(sid, { name: '空项目' });
  ok(p2 && p2.docs.length === 0, '不传 docIds = 空项目（不是"随便挂点什么"）', p2 && p2.docs);

  // ============================================================
  // 二、updateProject：先清后插
  // ============================================================
  core.updateProject(sid, p1.id, { docIds: [d1.id] });
  ok(core.getProject(sid, p1.id).docs.length === 1, '改成只挂 1 份 → 真的只剩 1 份（先清后插，不是往上累加）');

  core.updateProject(sid, p1.id, { docIds: [d1.id] });
  ok(core.getProject(sid, p1.id).docs.length === 1, '重复提交同一份清单 → 幂等，不会变成 2 份');

  core.updateProject(sid, p1.id, { docIds: [d1.id, d1.id] });
  ok(core.getProject(sid, p1.id).docs.length === 1, '清单里写了重复 id → 去重后只挂一份');

  core.updateProject(sid, p1.id, { name: '物理（改过名）' });
  ok(core.getProject(sid, p1.id).docs.length === 1, '只改名字时不传 docIds → 资料原样保留（没传 ≠ 清空）');

  // ★ 跨空间：project_docs 只有 (project_id, doc_id) 两列，没有 space_id
  core.updateProject(sid, p1.id, { docIds: [d1.id, dOut.id] });
  const afterCross = core.getProject(sid, p1.id);
  ok(afterCross.docs.length === 1 && afterCross.docs[0].id === d1.id,
    '★ 别的空间的 docId 被挡住（不挡就会把别人的文件名显示在自己项目上）', afterCross.docs);
  ok((D.get('SELECT COUNT(*) n FROM project_docs WHERE doc_id = ?', dOut.id) || {}).n === 0,
    '★ 库里也没有留下这行跨空间的挂载');

  core.updateProject(sid, p1.id, { docIds: [d1.id, 'kb_根本没有这个'] });
  ok(core.getProject(sid, p1.id).docs.length === 1, '不存在的 docId 静默忽略，不产生脏行');
  ok((D.get('SELECT COUNT(*) n FROM project_docs WHERE doc_id = ?', 'kb_根本没有这个') || {}).n === 0,
    '脏行确实没进库');

  core.updateProject(sid, p1.id, { docIds: [] });
  ok(core.getProject(sid, p1.id).docs.length === 0, '传空数组 = 摘掉全部挂载');

  core.updateProject(sid, p1.id, { docIds: [d1.id] });
  const shaped = core.getProject(sid, p1.id);
  ok(shaped.docs[0] && shaped.docs[0].filename === '力学卷.txt',
    'listProjects 回传文件名（前端"已挂到…"和项目卡片的"资料 N 份"靠它）', shaped.docs);

  const backRef = kb.getDocument(sid, d1.id, false);
  ok(backRef.projects.length === 1 && backRef.projects[0].name.indexOf('物理') >= 0,
    '反查也通：文档能说出自己挂在哪些项目上', backRef.projects);

  // 隔壁空间挂自己的资料必须成功 —— 别把校验做成"谁都挂不上"
  const pb = core.createProject(sid2, { name: '隔壁的项目', docIds: [dOut.id] });
  ok(pb.docs.length === 1, '本空间的 doc 正常挂得上是（校验只拦外人）', pb.docs);

  // ============================================================
  // 三、挂载真的收窄了检索范围（否则这套入口等于装饰）
  // ============================================================
  const missed = kb.contextFor(sid, 'apple', { docIds: [d1.id] });
  ok(missed.hits.length === 0, '只挂物理卷时问 "apple" → 检不到（范围真的被收窄了）', missed.hits);

  const fell = kb.contextFor(sid, 'apple', {});
  ok(fell.hits.length > 0, '不带 docIds（全库兜底）→ 又找得到了', fell.hits.map(h => h.filename));

  const hit = kb.contextFor(sid, '平行四边形', { docIds: [d1.id] });
  ok(hit.hits.length > 0 && hit.hits[0].filename === '力学卷.txt', '项目内该命中的照常命中', hit.hits);

  // 服务端那段"优先项目 → 没命中退全库"的链路不许被删掉
  ok(/docIds:\s*projDocIds/.test(SERVERJS), '服务端仍在按"项目资料优先"检索');
  ok(/if \(!docCtx\.hits\.length && projDocIds\)/.test(SERVERJS), '项目内没命中才退回全库（兜底还在）');

  // ============================================================
  // 四、前端两处入口（静态断言，真交互由 _browsertest.cjs 覆盖）
  // ============================================================
  ok(APPJS.indexOf('id="pjDocs"') >= 0, '项目弹窗里有「资料」区');
  ok(APPJS.indexOf("body.docIds = $$('#pjDocs .ag-i.on')") >= 0, '保存时把勾选清单一起提交');
  ok(APPJS.indexOf('if (docsOk) body.docIds') >= 0,
    '★ 资料列表没拉到就不提交 docIds（否则空清单会把已挂资料静默清空）');
  ok(/let docs = \[\], docsOk = false;/.test(APPJS), 'docsOk 这个守卫确实存在（不是只写在注释里）');

  ok(APPJS.indexOf('data-doc="proj"') >= 0, '知识库文档行有「加入项目」按钮');
  ok(/if \(act === 'proj'\) \{ if \(doc\) docProjectsModal\(doc\); return; \}/.test(APPJS), '点了会打开挂载弹窗');
  ok(/function docProjectsModal/.test(APPJS), '挂载弹窗函数在位');
  ok(/const add = want\.filter\(x => have\.indexOf\(x\) < 0\)/.test(APPJS), '只提交新增的挂载');
  ok(/const del = have\.filter\(x => want\.indexOf\(x\) < 0\)/.test(APPJS), '只提交取消的挂载');
  ok(/on: true \}/.test(APPJS) && /on: false \}/.test(APPJS), 'attach 的挂 / 摘两个方向都用到');
  ok(/toast\('项目列表没拉到，稍后再试'\); return; \}/.test(APPJS),
    '★ 项目列表拉不到直接退出（否则一点保存就把挂载全摘了）');
  ok(APPJS.indexOf('会优先用这份资料') >= 0,
    '文案说「优先」而不是「限定」—— 服务端确实还会退回全库，说"限定"就是骗人');
  ok(APPJS.indexOf('知识库里还没有资料') >= 0, '知识库为空时给的是指路，不是空白列表');

  console.log('\n批次12（项目 ↔ 知识库 挂载入口）：');
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  if (fail) { console.log('\n失败清单：'); fails.forEach(f => console.log('  ✗ ' + f)); }
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });

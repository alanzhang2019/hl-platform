'use strict';
/**
 * 批次4 自检（模块级）：互动课堂。
 *
 * 覆盖：内容闸门 validateDSL、离线兜底 presetFromText、生成主流程 generate
 *      （mock 走 preset 兜底 + 落库 + 作为消息附件回带 jobId）、失败自愈一次。
 *
 * 不起服务，直接 require 后端模块；LLM 一律现场桩（mock 模式下 completeJSON 返回 null，
 * 我们显式桩成 null / 非法 / 合法来精确控制分支）。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hl-p4-'));
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
const chat = require('./server/chat');
const auth = require('./server/auth');
const interactive = require('./server/interactive');
const llm = require('./server/llm');

// 把 completeJSON 桩成可控：默认 null（模拟离线 → preset 兜底）
llm.completeJSON = async () => null;

(async () => {
  const sid = '0001';
  auth.ensureDefaultSpace();

  // ---------- 1. 内容闸门 validateDSL ----------
  ok(interactive.validateDSL({ type: 'function-plot', title: '二次函数', f: 'x^2', domain: [-5, 5] }).ok === true, '合法函数图像 DSL 通过');
  ok(interactive.validateDSL({ type: 'geometry', title: '三角形', shapes: [{ type: 'triangle', points: [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 1, y: 3 }] }] }).ok === true, '合法几何 DSL 通过');

  ok(interactive.validateDSL(null).ok === false, 'null 被拒');
  ok(interactive.validateDSL({ type: 'unknown', title: 'x' }).ok === false, '未知 type 被拒');
  ok(interactive.validateDSL({ type: 'function-plot', title: '', f: 'x', domain: [-5, 5] }).ok === false, '缺标题被拒');
  ok(interactive.validateDSL({ type: 'function-plot', title: 'x'.repeat(41), f: 'x', domain: [-5, 5] }).ok === false, '标题过长被拒');
  ok(interactive.validateDSL({ type: 'function-plot', title: 'x', f: 'x; drop', domain: [-5, 5] }).ok === false, 'f 含非法字符被拒');
  ok(interactive.validateDSL({ type: 'function-plot', title: 'x', f: 'x', domain: [5, -5] }).ok === false, 'domain 左界大于右界被拒');
  ok(interactive.validateDSL({ type: 'function-plot', title: 'x', f: 'x', domain: [0, 0] }).ok === false, 'domain 左右相等被拒');
  ok(interactive.validateDSL({ type: 'function-plot', title: 'x', f: 'x', domain: [-5] }).ok === false, 'domain 不是二元数组被拒');
  ok(interactive.validateDSL({ type: 'function-plot', title: 'x', f: 'x', domain: [0, 5000] }).ok === false, 'domain 跨度过大被拒');
  ok(interactive.validateDSL({ type: 'geometry', title: 'x', shapes: 'nope' }).ok === false, 'geometry shapes 非数组被拒');
  ok(interactive.validateDSL({ type: 'geometry', title: 'x', shapes: [{ type: 'square', points: [] }] }).ok === false, '不支持的形状被拒');
  ok(interactive.validateDSL({ type: 'geometry', title: 'x', shapes: [{ type: 'triangle', points: [{ x: 0, y: 0 }, { x: 4, y: 0 }] }] }).ok === false, '三角形不是 3 顶点被拒');
  ok(interactive.validateDSL({ type: 'geometry', title: 'x', shapes: [{ type: 'circle', center: { x: 0, y: 0 }, r: 0 }] }).ok === false, '圆半径为 0 被拒');
  ok(interactive.validateDSL({ type: 'function-plot', title: 'x', f: 'x', domain: [-5, 5], params: [{ name: '1a', min: 0, max: 1, value: 0.5 }] }).ok === false, 'param.name 非法被拒');

  // ---------- 2. 离线兜底 presetFromText ----------
  const branches = [
    ['二次 抛物线 顶点', 'function-plot', 'a*x^2'],
    ['三角形 内角 边长 内角和', 'geometry', 'triangle'],
    ['正弦 余弦 周期 波动', 'function-plot', 'sin'],
    ['一次 线性 斜率 直线 k*x', 'function-plot', 'k*x'],
  ];
  for (const [kw, type, hint] of branches) {
    const d = interactive.presetFromText(kw);
    ok(d.type === type, 'preset 命中「' + kw + '」→ ' + type, d.type);
    ok(interactive.validateDSL(d).ok === true, 'preset「' + kw + '」自合法（闸门能过）', d);
  }
  const def = interactive.presetFromText('完全无关的一段话');
  ok(def.type === 'function-plot' && def.title.indexOf('动手') >= 0, '默认兜底给一个可玩的函数图', def.title);
  ok(interactive.validateDSL(def).ok === true, '默认兜底也自合法');

  // ---------- 3. generate（mock：completeJSON=null → preset 兜底 + 落库 + 附件回带 jobId）----------
  const conv = core.createConversation(sid, null, { title: '批次4 模块测试' });
  const um = core.addMessage(sid, conv.id, { role: 'user', content: '二次函数怎么求顶点？' });
  // addMessage 的返回值不带 content，所以显式传原始文本（真实前端就是这么传的）
  const r1 = await interactive.generate(sid, null, { text: '二次函数怎么求顶点？', messageId: um.id, conversationId: conv.id });
  ok(!!r1.jobId, 'generate 返回 jobId');
  ok(r1.source === 'preset', 'mock 下走 preset 兜底', r1.source);
  ok(interactive.validateDSL(r1.dsl).ok === true, 'generate 产出的 DSL 合法', r1.dsl);
  ok(r1.dsl.title === '二次函数图像', '二次关键词命中抛物线 preset', r1.dsl.title);
  ok(r1.usedHeal === false, '首猜即合法时不触发自愈', r1.usedHeal);

  const job1 = interactive.getJob(sid, r1.jobId);
  ok(job1 && job1.status === 'done', '任务落库为 done', job1 && job1.status);
  ok(job1 && job1.result && typeof job1.result === 'object' && job1.result.type === r1.dsl.type, 'job.result 与返回 dsl 一致（未被二次序列化）', job1 && job1.result);

  const byMsg = interactive.getByMessage(sid, um.id);
  ok(byMsg.length === 1, '消息附件里有 1 个互动课堂', byMsg.length);
  ok(byMsg[0].jobId === r1.jobId, '附件回带 jobId（分享时能定位 jobs 表）', byMsg[0]);
  ok(byMsg[0].dsl && byMsg[0].dsl.title === '二次函数图像', '附件里的 dsl 与生成的一致', byMsg[0].dsl && byMsg[0].dsl.title);
  ok(JSON.stringify(byMsg[0].dsl) === JSON.stringify(r1.dsl), '附件里的 dsl 与生成的一致');

  // 不带 messageId 也应成功，只是不挂附件
  const r1b = await interactive.generate(sid, null, { text: '正弦波' });
  ok(r1b.source === 'preset' && r1b.id === r1b.jobId, '无 messageId 时 id===jobId', r1b.id);
  ok(interactive.getByMessage(sid, um.id).length === 1, '无 messageId 不会多挂附件');

  // ---------- 4. 自愈一次：先非法 → 再合法 ----------
  let n = 0;
  llm.completeJSON = async () => {
    n++;
    if (n === 1) return { type: 'function-plot', title: '', f: 'x', domain: [-5, 5] }; // 非法：标题空
    return { type: 'function-plot', title: '修复后的图', f: 'x^2 - 1', domain: [-5, 5] }; // 合法
  };
  const um2 = core.addMessage(sid, conv.id, { role: 'user', content: '随便' });
  const r2 = await interactive.generate(sid, null, { text: '丢一个坏模型', messageId: um2.id, conversationId: conv.id });
  ok(r2.usedHeal === true, '首猜非法触发自愈', r2.usedHeal);
  ok(r2.source === 'llm', '自愈成功后来源标记为 llm', r2.source);
  ok(interactive.validateDSL(r2.dsl).ok === true, '自愈产出的 DSL 合法', r2.dsl);
  ok(r2.dsl.title === '修复后的图', '自愈拿到的是第二次的合法结果', r2.dsl.title);

  // ---------- 5. 自愈失败：两次都非法 → preset 兜底 ----------
  llm.completeJSON = async () => ({ type: 'function-plot', title: '', f: 'x', domain: [-5, 5] });
  const um3 = core.addMessage(sid, conv.id, { role: 'user', content: '坏模型' });
  const r3 = await interactive.generate(sid, null, { text: '模型一直抽风', messageId: um3.id, conversationId: conv.id });
  ok(r3.usedHeal === true, '两次都非法也走了自愈分支', r3.usedHeal);
  ok(r3.source === 'preset', '自愈失败后回 preset 兜底', r3.source);
  ok(interactive.validateDSL(r3.dsl).ok === true, 'preset 兜底一定自合法', r3.dsl);
  ok(!!r3.error, '两次非法记录了错误原因', r3.error);

  // ---------- 6. 跨空间读不到别人的任务（SQL 按 space_id 隔离）----------
  ok(interactive.getJob('0002', r1.jobId) === null, '跨空间读不到别人的互动任务');

  chat.stopWorker();

  console.log('');
  if (fails.length) {
    fails.slice(0, 40).forEach(f => console.log('  ✗ ' + f));
    if (fails.length > 40) console.log('  …还有 ' + (fails.length - 40) + ' 项');
  }
  console.log('PASS  通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
  process.exit(fail ? 1 : 0);
})().catch(e => {
  console.error('批次4 模块自检自身异常：', e);
  process.exit(2);
});

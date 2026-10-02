'use strict';
/**
 * 互动课堂（批次4）
 *
 * 对方用 Pyodide 跑 matplotlib 出图 —— 我们不引 10MB WASM（与零依赖/秒开冲突），
 * 改为：**模型输出受限的几何/函数 DSL（结构化 JSON），前端用原生 SVG + DOM 事件做可交互**。
 * 这是"AI 讲题"和"AI 造教具"的区别：学生能拖点、滑参数、看切线/边长/角度实时变。
 *
 * 设计要点（对齐对方体验，但实现完全自写）：
 *   1. 异步生成 + 轮询：复用 jobs 表（kind='interactive'），前端可断流/关页后回来拿结果。
 *   2. 失败自愈：DSL 校验不过 → 把错误回喂模型重生成一次。
 *   3. 内容闸门：validateDSL 是安全/质量闸门（"互动模型内容校验未通过"）。
 *   4. 离线兜底：没有模型 Key 时 presetFromText 按关键词给一个合法模型，保证不发也能演示。
 *   5. 可分享：复用 shares 表（kind='interactive'），公开页独立渲染。
 */
const D = require('./db');
const chat = require('./chat');
const llm = require('./llm');
const core = require('./core');

const TYPES = ['function-plot', 'geometry'];
const ALLOWED_FUNCS = ['sin', 'cos', 'tan', 'sqrt', 'abs', 'log', 'exp', 'pow', 'min', 'max'];
const MAX_POINTS = 600;

// 表达式字符白名单：数字、变量 x、已知函数名、运算符、括号、小数点、空白。
// 真正的求值在前端做（同一套安全求值器）；后端只做"不允许危险字符"的粗闸。
function tokenOK(s) {
  const str = String(s || '');
  if (!/^[0-9a-zA-Z_+\-*/^().\s,]+$/.test(str)) return false;
  // 括号配平
  let depth = 0;
  for (const ch of str) { if (ch === '(') depth++; else if (ch === ')') { depth--; if (depth < 0) return false; } }
  return depth === 0;
}

function isFiniteNum(v) { return typeof v === 'number' && Number.isFinite(v); }

// ---------- 内容闸门 ----------
function validateDSL(d) {
  if (!d || typeof d !== 'object') return { ok: false, error: 'DSL 必须是对象' };
  if (TYPES.indexOf(d.type) < 0) return { ok: false, error: 'type 必须是 function-plot 或 geometry' };
  if (typeof d.title !== 'string' || !d.title.trim()) return { ok: false, error: 'title 缺失或不是字符串' };
  if (d.title.length > 40) return { ok: false, error: 'title 过长（≤40 字）' };
  if (d.type === 'function-plot') {
    if (typeof d.f !== 'string' || !d.f.trim()) return { ok: false, error: 'f 必须是非空表达式字符串' };
    if (!tokenOK(d.f)) return { ok: false, error: 'f 含有不允许的字符' };
    const dom = d.domain;
    if (!Array.isArray(dom) || dom.length !== 2 || !isFiniteNum(dom[0]) || !isFiniteNum(dom[1])) return { ok: false, error: 'domain 必须是 [min,max] 两个有限数' };
    if (dom[0] >= dom[1]) return { ok: false, error: 'domain 左界必须小于右界' };
    if (Math.abs(dom[1] - dom[0]) > 1000) return { ok: false, error: 'domain 跨度过大' };
    if (d.params) {
      if (!Array.isArray(d.params)) return { ok: false, error: 'params 必须是数组' };
      if (d.params.length > 6) return { ok: false, error: 'params 最多 6 个' };
      for (const p of d.params) {
        if (typeof p.name !== 'string' || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(p.name)) return { ok: false, error: 'param.name 非法' };
        if (!tokenOK(p.name)) return { ok: false, error: 'param.name 含非法字符' };
        if (!isFiniteNum(p.min) || !isFiniteNum(p.max) || !isFiniteNum(p.value)) return { ok: false, error: 'param 数值非法' };
        if (p.min >= p.max) return { ok: false, error: 'param.min 必须小于 max' };
        if (p.value < p.min || p.value > p.max) return { ok: false, error: 'param.value 超出 [min,max]' };
      }
    }
    if (d.point !== undefined) {
      if (!d.point || !isFiniteNum(d.point.x)) return { ok: false, error: 'point.x 必须是有限数' };
    }
    if (d.tangent !== undefined && typeof d.tangent !== 'boolean') return { ok: false, error: 'tangent 必须是布尔' };
  } else { // geometry
    if (!Array.isArray(d.shapes) || !d.shapes.length || d.shapes.length > 4) return { ok: false, error: 'shapes 必须是 1–4 个元素的数组' };
    for (const s of d.shapes) {
      if (s.type !== 'triangle' && s.type !== 'segment' && s.type !== 'circle') return { ok: false, error: '暂只支持 triangle / segment / circle' };
      if (s.type === 'triangle') {
        if (!Array.isArray(s.points) || s.points.length !== 3) return { ok: false, error: 'triangle 需要恰好 3 个顶点' };
      } else if (s.type === 'segment') {
        if (!Array.isArray(s.points) || s.points.length !== 2) return { ok: false, error: 'segment 需要恰好 2 个端点' };
      }
      if (s.points) for (const pt of s.points) if (!pt || !isFiniteNum(pt.x) || !isFiniteNum(pt.y)) return { ok: false, error: '顶点坐标非法' };
      if (s.type === 'circle') {
        if (!s.center || !isFiniteNum(s.center.x) || !isFiniteNum(s.center.y)) return { ok: false, error: 'circle.center 非法' };
        if (!isFiniteNum(s.r) || s.r <= 0 || s.r > 1000) return { ok: false, error: 'circle.r 非法' };
      }
    }
  }
  return { ok: true };
}

// ---------- 离线兜底：按关键词给一个合法模型 ----------
function pt(x, y) { return { x, y }; }
function presetFromText(text) {
  const t = String(text || '').toLowerCase();
  if (/二次|平方|抛物|parabola|quadratic|顶点|开口/.test(t)) {
    return { type: 'function-plot', title: '二次函数图像', f: 'a*x^2 + b*x + c', domain: [-5, 5], params: [{ name: 'a', min: -3, max: 3, value: 1 }, { name: 'b', min: -5, max: 5, value: -2 }, { name: 'c', min: -5, max: 5, value: 0 }], point: { x: 1.5 }, tangent: true };
  }
  if (/三角|内角|angle|triangle|边长|内角和/.test(t)) {
    return { type: 'geometry', title: '三角形与它的角', shapes: [{ type: 'triangle', points: [pt(0, 0), pt(4, 0), pt(1.2, 3)] }], draggable: true, measures: ['side', 'angle'] };
  }
  if (/正弦|余弦|sin|cos|周期|wave|振动|波动/.test(t)) {
    return { type: 'function-plot', title: '正弦曲线', f: 'sin(x)', domain: [-6.3, 6.3], point: { x: 0.6 }, tangent: true };
  }
  if (/一次|线性|斜率|linear|比例|直线|k\*x/.test(t)) {
    return { type: 'function-plot', title: '一次函数与直线斜率', f: 'k*x + b', domain: [-5, 5], params: [{ name: 'k', min: -4, max: 4, value: 2 }, { name: 'b', min: -4, max: 4, value: 1 }], point: { x: 1 }, tangent: true };
  }
  // 默认：一个最简单的可拖点抛物线，保证"能玩"
  return { type: 'function-plot', title: '动手试试：拖一拖这个点', f: 'x^2 - 2*x - 1', domain: [-4, 4], point: { x: 1.2 }, tangent: true };
}

// ---------- 生成（LLM → 校验 → 自愈一次 → preset 兜底）----------
function buildPrompt(text) {
  return `下面是一段学习对话的片段。请判断其中是否出现一个"用图/用模型比用文字解释更清楚"的概念
（例如函数图像、几何图形、参数变化的影响）。如果有，请把它做成一个**可交互的教学模型**，只输出 JSON。

允许两种模型（二选一，不要两种都给）：
1) 函数图像 function-plot：
{
  "type":"function-plot",
  "title":"简短标题(≤40字)",
  "f":"关于 x 的表达式，可用 + - * / ^ 和函数 sin/cos/tan/sqrt/abs/log/exp，例如 x^2-2*x 或 a*x^2+b*x+c",
  "domain":[ -5, 5 ],
  "params":[ {"name":"a","min":-3,"max":3,"value":1} ],   // 可选：让表达式里的字母变成可滑动的参数
  "point":{ "x": 1.5 },                                   // 可选：曲线上一个可拖动的点（y 自动算）
  "tangent": true                                          // 可选：在拖动的点处显示切线
}
2) 几何图形 geometry：
{
  "type":"geometry",
  "title":"简短标题(≤40字)",
  "shapes":[ {"type":"triangle","points":[{"x":0,"y":0},{"x":4,"y":0},{"x":1.2,"y":3}]} ],
  "draggable": true,
  "measures":["side","angle"]
}

硬性要求：
- 只输出一个 JSON 对象，不要解释、不要 markdown 代码块标记、不要多余文字。
- f 里只允许数字、x、参数名、运算符和上述函数名；不能出现其他字母串。
- domain 左界必须小于右界，跨度不超过 1000。
- 若对话里没有适合做成模型的概念，请输出：{"type":"none"}。

对话片段：
${String(text || '').slice(0, 4000)}`;
}

async function generate(spaceId, userId, { text, messageId, conversationId } = {}) {
  const job = chat.createJob(spaceId, userId, 'interactive', { conversationId: conversationId || null, messageId: messageId || null });
  let dsl = null, source = 'preset', usedHeal = false, genErr = null;
  try {
    let raw = await llm.completeJSON({ messages: [{ role: 'user', content: buildPrompt(text) }], model: 'default' });
    if (Array.isArray(raw)) raw = raw[0];
    if (raw && raw.type === 'none') raw = null;
    if (raw) {
      let v = validateDSL(raw);
      if (!v.ok) {
        usedHeal = true;
        const fix = await llm.completeJSON({ messages: [{ role: 'user', content: buildPrompt(text) + '\n\n上一次输出不合法：' + v.error + '。请修正后只输出合法 JSON（或 {"type":"none"}）。' }], model: 'default' });
        if (Array.isArray(fix)) fix = fix[0];
        if (fix && fix.type !== 'none' && validateDSL(fix).ok) { dsl = fix; source = 'llm'; }
        else if (fix && fix.type !== 'none') genErr = '模型两次都未产出合法 DSL';
      } else { dsl = raw; source = 'llm'; }
    }
  } catch (e) { genErr = String(e.message || e); }
  if (!dsl) { dsl = presetFromText(text || ''); source = 'preset'; }
  const fv = validateDSL(dsl);   // preset 必须自合法
  chat.finishJob(job.id, dsl);
  let attachedId = null;
  if (messageId) attachedId = attachToMessage(spaceId, messageId, dsl, job.id);
  return { jobId: job.id, id: attachedId || job.id, dsl, source, validated: !!fv.ok, usedHeal, error: genErr };
}

// ---------- 持久化：作为消息附件（随消息重载自动回来）----------
function attachToMessage(spaceId, messageId, dsl, jobId) {
  const m = D.get('SELECT attachments_json FROM messages WHERE id = ? AND conversation_id IN (SELECT id FROM conversations WHERE space_id = ?)', messageId, spaceId);
  if (!m) return null;
  let list = m.attachments_json ? core.safeJSON(m.attachments_json) : null;
  if (!Array.isArray(list)) list = [];
  const id = D.uid('iv_');
  // 把 jobId 一起存进去：从消息卡片点「分享」时能直接定位到分享目标（jobs 表）
  const att = { id, kind: 'interactive', dsl };
  if (jobId) att.jobId = jobId;
  list.push(att);
  D.run('UPDATE messages SET attachments_json = ? WHERE id = ?', JSON.stringify(list), messageId);
  return id;
}
function getByMessage(spaceId, messageId) {
  const m = D.get('SELECT attachments_json FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE m.id = ? AND c.space_id = ?', messageId, spaceId);
  if (!m || !m.attachments_json) return [];
  const list = core.safeJSON(m.attachments_json);
  return Array.isArray(list) ? list.filter(x => x && x.kind === 'interactive').map(x => ({ id: x.id, jobId: x.jobId || null, dsl: x.dsl })) : [];
}

function getJob(spaceId, id) { return chat.getJob(spaceId, id); }

function share(spaceId, id) {
  // id 即 job.id；公开页按 target_id 读 job.result_json
  return core.createShare(spaceId, 'interactive', id);
}

function shareInfo(spaceId, id) { return core.shareInfo(spaceId, 'interactive', id); }

module.exports = {
  TYPES, MAX_POINTS, validateDSL, presetFromText, generate, attachToMessage, getByMessage, getJob, share, shareInfo,
};

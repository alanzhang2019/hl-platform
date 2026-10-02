'use strict';
/**
 * 模型层：多模型路由 + 流式输出 + 引导式提示词
 *
 * 核心教育主张（写进系统提示词，不是文案）：
 *   【绝不直接给答案】—— 学生卡住时，AI 只做三件事：反问、给脚手架、指出思路的岔口。
 *   这不是"语气温柔"，是硬约束：模型被要求先判断学生已走到哪一步，再决定追问什么。
 */
const LLM_BASE_URL = (process.env.LLM_BASE_URL || 'https://api.deepseek.com/v1').replace(/\/+$/, '');
const LLM_API_KEY = process.env.LLM_API_KEY || '';
const LLM_MODEL = process.env.LLM_MODEL || 'deepseek-chat';

const MOCK = !LLM_API_KEY || LLM_API_KEY === 'mock';

// 模型注册表。id 是前端传的值，model 是上游真实模型名。
const MODELS = [
  {
    id: 'default', name: '通用', displayName: process.env.LLM_MODEL_NAME || 'DeepSeek',
    provider: 'deepseek', color: '#2563EB', model: LLM_MODEL,
    desc: '日常对话与讲解，响应快',
  },
  {
    id: 'deep', name: '深度思考', displayName: '深度思考模式',
    provider: 'deepseek', color: '#7C3AED', model: process.env.LLM_MODEL_DEEP || LLM_MODEL,
    desc: '复杂问题拆解，慢一点但更稳', thinking: true,
  },
];

function resolveModel(id) {
  return MODELS.find(m => m.id === id) || MODELS[0];
}

// ---------- 系统提示词 ----------
const SOCRATIC_CORE = `你是一位面向中小学生的 AI 学习伙伴。你的名字叫「小涌」。

【最重要的一条规则：绝不直接给出答案】
学生把题目发给你时，你**不能**说出最终答案，也不能给出完整的解题步骤。
你要做的是让他自己走到答案那里。具体做法：
1. 先判断他卡在哪一步——是没读懂题、不知道用哪个知识、还是算错了。
2. 一次只问一个问题，或者只给一个提示。
3. 提示要指向"下一步该想什么"，而不是"下一步该写什么"。
4. 他说对了，就确认他"为什么对"；他说错了，指出他思路里那个岔口在哪。
5. 他反复卡住时，把问题拆得更小，而不是把答案给出来。

【什么时候可以给答案】
只有当学生明确说"我已经自己想过了，请直接告诉我"并且连续两次追问都答不上来时，
你可以给出**关键的那一步**（不是完整答案），然后立刻问一个检验性问题确认他真的懂了。

【语气】
像一个耐心但不啰嗦的同伴。不说"你真棒"这类空话，而是具体指出他哪里想得好。
不用感叹号堆砌情绪。`;

const MODE_PROMPTS = {
  selfstudy: `【当前模式：自学引导】
围绕学生自己的目标推进。每一步都要问他"你觉得下一步该做什么"，让他自己规划。
适当时提醒他把学到的东西收成知识卡。`,
  feynman: `【当前模式：费曼学习法】
让学生用自己的话把概念讲给你听。你扮演一个"完全不懂的人"，只问最朴素的问题：
"这个词是什么意思？""为什么是这样不是那样？"
他讲不清楚的地方，就是没真懂的地方——指出来，让他重新讲。`,
  diagnosis: `【当前模式：学情诊断】
通过提问定位他的薄弱点，不要给讲解。每轮问 1-2 个能区分"会/不会"的问题，
根据回答收窄范围。最后给出一段简短的判断：他哪几个点是稳的，哪几个点需要补。`,
};

const ARTIFACT_RULES = `【关于"画图"】
当学生需要一个可视化的东西（知识地图、概念关系图、流程图、几何图形、时间轴、数据对比）时，
你**不要**生成图片。你要输出一个 JSON 代码块，由前端渲染成矢量图（学生可以缩放、可以打印）：

\`\`\`svg-json
{"kind":"mindmap","title":"标题","nodes":[{"id":"a","label":"中心"},{"id":"b","label":"分支"}],"edges":[{"from":"a","to":"b","label":""}]}
\`\`\`

支持的 kind 与字段：
- mindmap / tree：nodes + edges。第一个没有任何入边的节点会自动当根，按层横向排开。
- flow：nodes + edges。纵向一列，箭头依次连接，适合步骤、解题顺序。
- timeline：items:[{time, desc}]。横向时间轴，上下交错。
- geometry：points:[{x, y, label}] 先定义顶点，segments:[["A","B"]] 连线，
  polygons:[["A","B","C"]] 围成面（会自动填浅色）。可选 circles / labels。
  **顶点一律写标签名（["A","B"]），不要重复抄坐标** —— 抄错一个数整张图就歪了。
  坐标用 0-100 的数学坐标系（y 轴向上）。**只有画函数图像时才加 "axes":true**，
  画三角形、四边形这类图形不要加，否则坐标轴会和边重叠。
  交代一条线是"高"时，用 labels 在它旁边标一个"高"字，比只画线更容易看懂。
- bars：items:[{label, value}]。横向条形，适合成绩对比、数量对比。
- grid：**网格 / 数表 / 棋盘**。cells 是二维数组（每行一个数组，或 "7,3,5" 这种字符串）。
  可选 rowLabels / colLabels 做行列标题；marks:[{r,c,label}] 标单个格子；
  path:[[r,c],…] 高亮一条路径。**坐标从 0 开始数**。

规则：
1. 节点文字要短（不超过 12 个字），长了会挤。
2. 不要为了好看而画图——只有图能表达出文字表达不了的关系时才画。
3. 但下面这些**恰恰是文字表达不了的**，讲到就先用 geometry / bars / grid 把图画出来，再讲：
   图形里的量与位置（面积、周长、体积、底与高、平行与垂直、对称轴、展开图、三视图）、
   函数与它的图像、受力与光路、数据对比、**以及一切"格子里的数"**。
   一句话的判断标准：**如果一张图能让"这个量在哪、和谁垂直/平行/相等"一眼看清，就画。**
   只描述"底是 6 厘米、高是 4 厘米"，学生要在脑子里凭空把图搭出来——那是白费力气。
4. 画完图之后，紧接着问一个只有看懂这张图才能回答的问题，让学生自己说出图里的关系。

**选题的红线（踩了就是废图，比不画更糟）**：
- 只要题里出现"方格/表格/棋盘/数阵/杨辉三角/乘法表/矩阵的某格/从左上角走到右下角"，
  必须用 grid，**把每个格子的数字老老实实填进去**。
  用 geometry 画这类题只会得到几个孤立的点和几个不知从哪来的数字 —— 学生完全看不懂。
- 反过来，几何题（三角形、圆、坐标系里的图形）用 geometry，**不要**用 grid 去凑。
- 拿不准画成什么样、或者图画出来也不比文字更清楚时，**宁可不画**。
  一张不知所云的图比没有图更糟：学生会以为自己没看懂，而不是以为图不对。`;

/**
 * 兜底注入的预算：总字数 / 单份字数。
 * 只在"按问题检索一条都没命中"时才用，所以给得比较松也不怕费 token。
 */
const TEMP_DOC_BUDGET = 4000;
const TEMP_DOC_PER_DOC = 1500;

/**
 * 学生这次在对话里上传的资料（粘贴 / 「＋」传来的对话级临时资料）。
 *
 * 为什么必须单独走一段、不能只靠检索：
 *   检索是拿**他问题里的词**去匹配资料里的词。问得泛（"帮我看看这份卷子""这个怎么讲"）
 *   一条都命中不了 —— 那一刻模型手里**完全没有这份资料的痕迹**，
 *   表现就是用户看到的"AI 没读我粘贴的文档"。
 * 所以两件事都要做：
 *   ① 清单**无条件**告诉它有哪些资料（解析失败的也如实说，免得它假装看过或编内容）；
 *   ② 检索零命中时，把资料开头直接给它看，保证问得泛也能读到东西。
 */
function buildTempDocContext(tempDocs, budget) {
  // typeof 检查不能省：库里的正文理论上一定是字符串，但这个函数也会被
  // 测试和别的调用点直接喂脏数据 —— 让 `123.slice()` 抛出去是最难查的那类崩。
  const list = (Array.isArray(tempDocs) ? tempDocs : [])
    .filter(d => d && typeof d.filename === 'string' && d.filename
      && d.status === 'ready' && typeof d.text === 'string' && d.text);
  if (!list.length) return '';
  let left = budget == null ? TEMP_DOC_BUDGET : budget;
  const blocks = [];
  for (const d of list) {
    if (left <= 200) break;
    const take = Math.min(TEMP_DOC_PER_DOC, left, d.text.length);
    blocks.push('《' + d.filename + '》开头：\n' + d.text.slice(0, take) +
      (d.text.length > take ? '\n…（这份还没完，需要后面的内容时让他说清楚是哪一页/哪一题）' : ''));
    left -= take;
  }
  return blocks.join('\n\n');
}

function buildSystemPrompt({ mode, spaceName, grade, projectInstructions, docNames, memories, skillPrompts, docContext, tempDocs }) {
  const parts = [SOCRATIC_CORE];
  if (MODE_PROMPTS[mode]) parts.push(MODE_PROMPTS[mode]);
  // 技能提示词放在方法说明之后、画图协议之前 —— 它是对"怎么讲"的约束，优先级高于画图
  if (skillPrompts && skillPrompts.length) parts.push(skillPrompts.join('\n\n'));
  parts.push(ARTIFACT_RULES);
  const tdocs = (Array.isArray(tempDocs) ? tempDocs : []).filter(d => d && d.filename);
  const ctx = [];
  if (spaceName) ctx.push(`学习者所在的学习空间：${spaceName}`);
  if (grade) ctx.push(`年级：${grade}`);
  if (projectInstructions) ctx.push(`【本项目的学习指令】\n${projectInstructions}`);
  if (docNames && docNames.length) ctx.push(`【本项目可用的资料】\n${docNames.map(d => '- ' + d).join('\n')}\n引用资料时请说明出自哪一份。`);
  if (tdocs.length) {
    const ready = tdocs.filter(d => d.status === 'ready');
    const bad = tdocs.filter(d => d.status !== 'ready');
    const lines = ready.map(d => '- 《' + d.filename + '》（已读出内容）')
      .concat(bad.map(d => '- 《' + d.filename + '》★**没读出内容**（' + (d.error || '解析失败') + '）'));
    let s = '【学生这次在对话里上传的资料】\n' + lines.join('\n') +
      '\n这些是他刚刚亲自传给你的，回答时优先参考，不要让他再传一遍。';
    if (bad.length) {
      s += '\n★ 标了「没读出内容」的那几份，你**看不到里面任何东西** —— 不要假装看过、也不要猜它写了什么，'
        + '直接说明读不出来，并请他把关键段落贴进对话（或者说明是哪本书第几页）。';
    }
    ctx.push(s);
  }
  if (memories && memories.length) ctx.push(`【关于这位学习者的长期记忆】\n${memories.map(m => '- ' + m.content).join('\n')}`);
  if (ctx.length) parts.push('【背景信息】\n' + ctx.join('\n'));
  if (docContext) {
    parts.push(`【从学习者的资料里检索到的相关片段】
下面是系统根据他这次的问题，从他自己的资料里挑出来的片段。规则：
- 如果这些片段能回答他的问题，**用它们**，并说明出自哪一份资料的哪一段。
- 引用之后仍然不要直接把结论给他，用这些片段去**反问**，让他自己读出来。
- 如果这些片段和他问的没关系，直接忽略，不要硬扯。

${docContext}`);
  } else {
    // 检索零命中（多半是他问得太泛）→ 把资料的正文开头直接给他，别让他对着空气问
    const excerpt = buildTempDocContext(tdocs);
    if (excerpt) {
      parts.push(`【他上传资料的正文开头】
他这次的问题没能从资料里检索到相关片段，所以直接把他上传资料的**开头**给你。规则：
- 只依据下面这些内容谈，**不要补出这里没有的题目、数字或结论**。
- 需要后面的内容时，让他说清楚是哪一页、哪一题，再让他把那一段贴出来。
- 仍然不要直接给结论，用这些内容去**反问**，让他自己读出来。

${excerpt}`);
    }
  }
  return parts.join('\n\n');
}

// ---------- 调用 ----------
/**
 * 带 429 重试的 fetch。
 *
 * 为什么要有这一层：知识库的**扫描件识别**是个后台长任务，一本 130 页的书要连续
 * 跑十几分钟，而它和聊天用的是**同一把 Key、同一个账号级配额**。也就是说，
 * 学生在"正在识别资料"的那段时间里提问，是会撞上 429 的。
 * 对用户来说「等两秒自动重发」和「AI 直接报错」是完全不同的体验 —— 所以必须自己扛一下。
 *
 * 只在 429 上重试（其他状态码重试无意义，还可能把真正的错误掩盖成"慢"）。
 * 请求体是同一个字符串，重发是安全的：429 发生在响应开始之前，一个字都还没往外吐。
 */
async function fetchWithRetry(url, opt, tries) {
  const n = Math.max(1, tries || 3);
  let last = null;
  for (let i = 1; i <= n; i++) {
    const res = await fetch(url, opt);
    if (res.status !== 429) return res;
    last = res;
    if (i >= n) break;
    // 上游给了 Retry-After 就听它的（按秒），否则 1.5s / 3s 递增；两者都封顶 8 秒，
    // 免得一次限流把学生的提问卡成"没反应"。
    let wait = Math.min(8000, 1500 * i);
    try {
      const ra = Number(res.headers && res.headers.get && res.headers.get('retry-after'));
      if (Number.isFinite(ra) && ra > 0) wait = Math.min(8000, Math.round(ra * 1000));
    } catch (e) { /* 拿不到头就按默认退避 */ }
    await new Promise(r => setTimeout(r, wait));
  }
  return last;
}

function mockStream(messages) {
  const last = [...messages].reverse().find(m => m.role === 'user');
  const q = (last && last.content) || '';
  const text = `我先不急着给你答案，我们从你手上这一步开始。\n\n你发的题目里，你觉得**最关键的那个条件**是哪一个？先说说你注意到什么。\n\n（离线演示模式，未配置模型 Key；你刚才说的是："${q.slice(0, 40)}"）`;
  return (async function* () {
    for (const ch of text) {
      await new Promise(r => setTimeout(r, 8));
      yield ch;
    }
  })();
}

async function* streamChat({ messages, model }) {
  const m = resolveModel(model);
  if (MOCK) { yield* mockStream(messages); return; }
  const body = { model: m.model, messages, stream: true, temperature: 0.6 };
  const res = await fetchWithRetry(LLM_BASE_URL + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + LLM_API_KEY },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error('模型接口返回 ' + res.status + '：' + t.slice(0, 200));
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      const s = line.trim();
      if (!s.startsWith('data:')) continue;
      const payload = s.slice(5).trim();
      if (payload === '[DONE]') return;
      try {
        const j = JSON.parse(payload);
        const d = j.choices && j.choices[0] && j.choices[0].delta;
        if (d && d.content) yield d.content;
      } catch (e) { /* 忽略非 JSON 行 */ }
    }
  }
}

async function complete({ messages, model, temperature }) {
  const m = resolveModel(model);
  if (MOCK) return '（离线演示模式）';
  const res = await fetchWithRetry(LLM_BASE_URL + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + LLM_API_KEY },
    body: JSON.stringify({ model: m.model, messages, stream: false, temperature: temperature == null ? 0.3 : temperature }),
  });
  if (!res.ok) throw new Error('模型接口返回 ' + res.status);
  const j = await res.json();
  return (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
}

// 让模型输出结构化 JSON（用于知识卡生成、理解核对、标题等）
async function completeJSON({ messages, model }) {
  const text = await complete({ messages, model, temperature: 0.2 });
  return parseJSONLoose(text);
}

function parseJSONLoose(text) {
  if (!text) return null;
  let t = String(text).trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) t = fence[1].trim();
  const start = t.search(/[[{]/);
  if (start > 0) t = t.slice(start);
  try { return JSON.parse(t); } catch (e) {}
  // 截断修复：补上缺失的收尾括号
  const opens = { '{': '}', '[': ']' };
  const stack = [];
  let inStr = false, esc = false;
  for (const ch of t) {
    if (esc) { esc = false; continue; }
    if (ch === '\\') { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (opens[ch]) stack.push(opens[ch]);
    else if (ch === '}' || ch === ']') stack.pop();
  }
  if (stack.length) {
    try { return JSON.parse(t + stack.reverse().join('')); } catch (e) {}
  }
  return null;
}

module.exports = {
  MODELS, resolveModel, buildSystemPrompt, streamChat, complete, completeJSON, parseJSONLoose,
  buildTempDocContext, TEMP_DOC_BUDGET, TEMP_DOC_PER_DOC,
  // 导出是为了能直接验 429 行为，不用真去打接口（扫描件识别会长时间占用同一配额）
  fetchWithRetry,
  isMock: () => MOCK,
  // 画图协议导出是为了测试能锁住"网格题必须用 grid"这类规矩 ——
  // 它写在字符串里，改走样式不会红任何结构断言，只有原文检查拦得住。
  SOCRATIC_CORE, MODE_PROMPTS, ARTIFACT_RULES,
};

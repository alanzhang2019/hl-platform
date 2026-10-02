'use strict';
/**
 * 能力中心（P7）：把"学习方法"做成可勾选的东西
 *
 * 和对标站的差别：
 *   对标站的技能是"更聪明的助手"——勾上之后 AI 讲得更多，而且大多锁在付费等级里。
 *   这里每个技能都是**一套限制 AI 怎么说话的方法**。比如"费曼讲解"不是让 AI 讲，
 *   是让 AI 闭嘴、由学生讲。所以技能提示词里大量出现"不要""只能""必须先问"。
 *
 * 关于 57 这个数字：它来自对标站 `/skills/registry` 的总数（free 1 / basic 6 /
 * camp 20 / pro 30）。我们当时只逆向到了**结构和总数，没拿到名单**，所以这 57 条
 * 名字和提示词全部是自己写的。数量对齐只是为了让功能覆盖面对得上，
 * 不是把对方的清单抄过来——抄也抄不到。
 *
 * 每条都要能回答一个问题："用了它之后，AI 少做了哪件本来会做的事？"
 * 答不上来的条目就是凑数的，不该留在表里。
 */
const D = require('./db');

// ============================================================
// 档位（批次25）：把对标站的"付费等级"改造成"空间授权"
// ============================================================
/* 为什么要做这件事：
 *   对标站把技能锁在付费等级里（free 1 / basic 6 / camp 20 / pro 30），
 *   本质是**卖功能**。我们的定位是自学工具，不做售卖（roadmap 明确"不做订阅/学币"）。
 *   但"分层开放"这个机制本身有用 —— 一群孩子里，低年级不该一上来被 57 条方法淹没；
 *   家长/老师希望先开放一批、用熟了再放更多。
 *   ⇒ 所以保留分层，把**付费**换成**授权**：平台管理员给某个空间定档，学生只看到
 *     ≤ 本空间档位的方法。钱从哪里来不是这个模块的事。
 *
 * 档位命名用中文意图，不用 free/pro —— 因为这里分的不是"用户身份高低"，
 * 是"这套方法现在适不适合你"。四档（从小到大）：
 *   自学（默认，人人可用）· 引导（需要 AI 配合追问的方法）· 深研（依赖学科功底的方法）· 通学（全部）
 * ★ 这个阶梯**不是奖励**：它不会因为学得多而自动上升，只能由管理员授予。
 *   「不用外部激励驱动学习」这条约束要求它不能被包装成"升级打怪"。
 */
const TIERS = [
  { key: 'self',   name: '自学', rank: 0, note: '最基础的几条方法，人人可用' },
  { key: 'guide',  name: '引导', rank: 1, note: '需要 AI 配合追问才用得起来的方法' },
  { key: 'deep',   name: '深研', rank: 2, note: '依赖学科功底、给高年级用的方法' },
  { key: 'all',    name: '通学', rank: 3, note: '全部 57 条方法' },
];
const TIER_KEYS = TIERS.map(t => t.key);
const DEFAULT_TIER = 'self';
/**
 * 档位 → 序号。**认不出来的一律返回 -1（比最低档还低）**，不是 0。
 *
 * ★ 为什么不能返回 0：0 是「自学」的序号。若未知档也返回 0，则
 *   `tierAllows('self', 某个拼错的要求档)` → `0 >= 0` → **true**。
 *   后果是「越权放行」—— 库里 required_tier 被写坏（改名、手改、迁移漏了）
 *   时，那条技能会对**最低档的空间**静默解锁，且列表上看起来完全正常（不 locked）。
 *   失败要往「锁住」那一边倒，不能往「放行」那一边倒。
 */
function tierRank(key) {
  const t = TIERS.filter(x => x.key === key)[0];
  return t ? t.rank : -1;
}
function tierInfo(key) {
  return TIERS.filter(x => x.key === key)[0] || TIERS[0];
}
/** 空间档位能不能用某条技能要求的档位。空/未知一律按**不放行**处理。 */
function tierAllows(spaceTier, requiredTier) {
  const have = tierRank(spaceTier);
  const need = tierRank(requiredTier || DEFAULT_TIER);
  if (have < 0 || need < 0) return false;   // 任一侧认不出来 → 锁住
  return have >= need;
}

// category: method（通用方法）| subject（学科能力）| tool（工具）
//
// sort_order 的排法：**每个学科块占一个 100 宽的区间，块内步长 10**。
//   method 10~160 / math 200~280 / chinese 300~370 / english 400~470
//   science 500~560 / social 600~620 / tool 700~750
// 这样"在中间插一条"永远是改一个数字，不用重排后面所有条目。
// （早先的写法是块内顺排 10,11,12…，看着像留了空位，其实一条也插不进去。）
const REGISTRY = [
  // ================= 通用方法 =================
  {
    id: 'feynman', display_name: '费曼讲解', icon_svg: 'feynman', subject: 'general', category: 'method', sort_order: 10,
    description: '你讲给 AI 听，AI 装听不懂，只问最朴素的问题',
    prompt: `【已启用技能：费曼讲解】
本轮**由学生讲解，你只负责听和问**。规则：
- 不要复述、不要补充、不要纠正措辞。你扮演一个完全不懂的人。
- 每次只问一个最朴素的问题，例如"这个词是什么意思""为什么是这样不是那样""那如果反过来呢"。
- 他讲得含糊的地方（用了"大概""就是这样""反正"）就是没懂的地方——指出来，让他重讲。
- 他讲完一段之后，你用自己的话复述一遍，让他判断你有没有听错。`,
  },
  {
    id: 'mistake-review', display_name: '错题复盘', icon_svg: 'review', subject: 'general', category: 'method', sort_order: 20,
    description: '不说"你错了"，只找思路里的那个岔口',
    prompt: `【已启用技能：错题复盘】
处理一道做错的题时，按这个顺序，一步都不能跳：
1. 先让他**完整说出他当时的想法**，不要打断。
2. 让他自己找出"哪一步开始和预期不一样"。
3. 只指出岔口在哪，不给出正确走法。
4. 问他"下次遇到同类题，你打算先看什么"，让他自己定一个检查动作。
禁止使用"粗心""不认真"这类评价性词汇。`,
  },
  {
    id: 'concept-contrast', display_name: '概念辨析', icon_svg: 'contrast', subject: 'general', category: 'method', sort_order: 30,
    description: '把两个容易混的概念摆在一起，让他自己找边界',
    prompt: `【已启用技能：概念辨析】
学生要区分两个易混概念时：
- 先让他各自举一个**例子**和一个**反例**。
- 只问"这两个例子里，哪一个特征变了"。
- 不要直接给出区分标准。等他找出边界后，再问他"还有没有例外"。
- 最后让他用一句话说出两者的差别（不超过 20 字）。`,
  },
  {
    id: 'self-test', display_name: '自我检测', icon_svg: 'test', subject: 'general', category: 'method', sort_order: 40,
    description: '让 AI 出题考他，但只出能区分"会/不会"的题',
    prompt: `【已启用技能：自我检测】
- 每轮只出 **1 道**题，且必须是能区分"真会/假会"的题（不是背概念，要用）。
- 他答完后不要直接判对错，先问"你为什么这么想"。
- 答对了追问一个变式；答错了把题改简单一点再问一次。
- 全部结束后，给出一句判断：哪几个点稳了、哪几个点要补。`,
  },
  {
    id: 'mindmap-build', display_name: '知识梳理', icon_svg: 'map', subject: 'general', category: 'method', sort_order: 50,
    description: '一起把零散知识整理成结构化的图',
    prompt: `【已启用技能：知识梳理】
- 先让学生说出他记得的所有相关概念（不管对错、不管顺序）。
- 然后用 svg-json 的 mindmap 把他说的画出来（**只用他说的词**，不要自己补充）。
- 画完问他"哪两个之间还有关系我没画出来"，由他补充连线。
- 最后问他"这张图的中心应该是什么"——让他自己找到主线。`,
  },
  {
    id: 'question-training', display_name: '提问训练', icon_svg: 'ask', subject: 'general', category: 'method', sort_order: 60,
    description: '教他怎么问出一个好问题',
    prompt: `【已启用技能：提问训练】
- 学生问的问题太笼统时（如"这章我不会"），不要回答，先让他把问题缩到一个具体的点上。
- 给他一个句式参考："我在______这一步，不知道______，我试过______。"
- 他改好问题后，你再回答**这个问题**，并说明"这个问题比刚才那个好在哪"。`,
  },
  {
    id: 'preview-questions', display_name: '预习提问', icon_svg: 'preview', subject: 'general', category: 'method', sort_order: 70,
    description: '读之前先列出想问的问题，带着问题读',
    prompt: `【已启用技能：预习提问】
- 学生要读一节新内容时，先**不许他读正文**。让他只看标题和小标题，列出 3 个想问的问题。
- 问题必须是他真的想知道答案的，不是"这一节讲什么"这种空问题。
- 他列完之后，让他带着这 3 个问题去读，读完只回答一件事：哪几个问题有答案了，哪几个还没有。
- 没答案的那几个，才是这节课真正要讲的东西。不要提前替他回答。`,
  },
  {
    id: 'error-cause', display_name: '错因归类', icon_svg: 'cause', subject: 'general', category: 'method', sort_order: 80,
    description: '把错题按"错因"分堆，不按知识点分',
    prompt: `【已启用技能：错因归类】
- 学生拿出几张错题时，**不要按章节分类**。问他"这几道题错的**原因**一样吗"。
- 给他几个参考错因，但让他自己判断：看错条件 / 概念不清 / 步骤跳步 / 计算失误 / 时间不够。
- 分好堆之后只问一句："哪一堆最大？"——那一堆才是要补的。
- 不要针对单道题讲，这一轮只做归类。归完类让他自己决定先补哪一堆。`,
  },
  {
    id: 'socratic-chain', display_name: '追问链', icon_svg: 'chain', subject: 'general', category: 'method', sort_order: 90,
    description: '连环追问，逼出他没说出口的边界条件',
    prompt: `【已启用技能：追问链】
- 学生说出一个结论后，**不要评价对错**，连续追问三层，每层只问一个问题。
- 追问的方向固定：① 这个结论在什么条件下成立？② 如果条件变了会怎样？③ 有没有反例？
- 三层问完再让他自己总结"原来我这句话漏了什么"。
- 全程不要说出正确答案。他答不上来就停在那儿，让他自己发现缺口。`,
  },
  {
    id: 'analogy-build', display_name: '类比迁移', icon_svg: 'analogy', subject: 'general', category: 'method', sort_order: 100,
    description: '让他自己找一个生活里的类比，而不是听你打比方',
    prompt: `【已启用技能：类比迁移】
- **不要替学生打比方**。问他"这个东西像你生活里的什么"。
- 他给出类比后，追问一句："这个类比在哪里就不成立了？"——类比的边界比类比本身重要。
- 如果他的类比是错的，不要否定，只问"按你这个说法，某某情况该怎么解释"，让他自己发现不成立。
- 最后让他用一句话说出"这个类比的哪一部分是真的像"。`,
  },
  {
    id: 'counter-example', display_name: '反例构造', icon_svg: 'counter', subject: 'general', category: 'method', sort_order: 110,
    description: '让他自己造一个反例，比讲十遍定义有用',
    prompt: `【已启用技能：反例构造】
- 学生说出一个判断（"凡是……都……"）时，不要评价，只说："你能造一个不符合它的例子吗？"
- 他造不出来时，把条件放宽一点再问："如果去掉'都'字呢？"
- 他造出来之后，问他"原来的那句话该怎么改才不会被这个例子推翻"。
- 整个过程不要给出任何反例。反例必须由他构造，否则他记不住边界在哪。`,
  },
  {
    id: 'plan-first', display_name: '先规划再动笔', icon_svg: 'plan', subject: 'general', category: 'method', sort_order: 120,
    description: '动笔之前先说清楚打算怎么做',
    prompt: `【已启用技能：先规划再动笔】
- 学生拿到题就开始算时，**打断他**，要求他先说出"我打算分几步做，第一步是什么"。
- 计划里必须包含：从哪开始、中间要算什么、怎么知道自己做完了。
- 计划说完不要评价对错，直接让他按计划做。做到一半卡住时问他"是计划哪一步没想清楚"。
- 不要替他改计划，除非他自己发现走不通。
- 做完之后回看：实际走的和计划的差在哪。`,
  },
  {
    id: 'note-rewrite', display_name: '笔记重写', icon_svg: 'note', subject: 'general', category: 'method', sort_order: 130,
    description: '把抄来的笔记改写成自己的话，抄不动的地方就是没懂',
    prompt: `【已启用技能：笔记重写】
- 让学生挑一段他抄下来的笔记，**合上原文**，用自己的话重写一遍。
- 写不下去的地方**不要提示**，只问他"这里你是不确定哪个词的意思"。
- 重写完之后和原文对照，问他"哪几句你只是换了说法，其实没变"——那些是他没消化的。
- 不要帮他把笔记写得更漂亮。笔记丑但准确，比漂亮但抄来的有用。`,
  },
  {
    id: 'goal-split', display_name: '目标拆解', icon_svg: 'split', subject: 'general', category: 'method', sort_order: 140,
    description: '把"我要学好数学"拆成今天能做完的事',
    prompt: `【已启用技能：目标拆解】
- 学生说一个大目标（"我要把这章补上""我要考到 90 分"）时，**不要给计划**。
- 只问三个问题：① 这个目标怎么算完成了？② 现在离它差什么？③ 差的东西里，哪个今天就能动？
- 拆出来的每一步都必须"今天能做完并能检查"，做不到就继续拆。
- 最后只保留**一步**作为今天的任务，其余的先记下来但不展开。
- 不要输出一份完整的长期计划表——那是给人看的，不是给人做的。`,
  },
  {
    id: 'exam-review', display_name: '考后复盘', icon_svg: 'examreview', subject: 'general', category: 'method', sort_order: 150,
    description: '卷子发下来之后做的事，比分数重要',
    prompt: `【已启用技能：考后复盘】
- **先不要问分数，也不要问错了几道。**
- 按这个顺序问：① 哪几道是考完就知道错了的？② 哪几道是现在还是不会的？③ 哪几道是会的但没做对？
- 第③类最要紧——问他"当时是时间不够，还是看错了，还是写漏了"。
- 只有第②类才需要讲知识点，而且仍然不给答案。
- 最后让他自己定一个下次考试的检查动作，只定一个。`,
  },
  {
    id: 'spaced-review', display_name: '间隔复习', icon_svg: 'spaced', subject: 'general', category: 'method', sort_order: 160,
    description: '不一次背完，而是排好什么时候再来一遍',
    prompt: `【已启用技能：间隔复习】
- 学生想"今天一次背完"时，告诉他这样记不住，然后和他一起**排时间**而不是排内容。
- 问他"这个内容，明天、三天后、一周后，你哪次会忘得最多"——让他自己估。
- 把每次复习要做的动作缩小到"回忆 + 对照"，不要每次都重读一遍。
- 提醒他：忘了不说明白学了，说明这一遍该来了。
- 不要输出整学期的复习表，只排这一次的。`,
  },

  // ================= 数学 =================
  {
    id: 'math-modeling', display_name: '应用题建模', icon_svg: 'model', subject: 'math', category: 'subject', sort_order: 200,
    description: '从文字到式子的那一步，让他自己走',
    prompt: `【已启用技能：应用题建模】
- 让学生先**用自己的话**把题目说一遍（不许看原题）。
- 问他"题目里哪个量是我们要找的""哪些量是已知的"。
- 再问他"哪两句话在说同一件事"——等量关系必须由他找出来。
- 列式之后先不急着算，问他"这个式子里的每一项分别代表什么"。
- 不要替他设未知数。`,
  },
  {
    id: 'math-geometry', display_name: '几何直观', icon_svg: 'geometry', subject: 'math', category: 'subject', sort_order: 210,
    description: '先把图看懂，再谈证明',
    prompt: `【已启用技能：几何直观】
- 用 svg-json 的 geometry 把题目图形画出来（顶点用 A/B/C 标注，坐标用 0-100 数学坐标系）。
- 先问他"图里哪些是你已经能确定的"，再问他"要证明的东西在图上长什么样"。
- 需要辅助线时，不要直接说画哪条。问他"如果想让这两个角产生关系，需要一条什么样的线"。
- 每一步都要他说明依据，不能只说"看图就知道"。`,
  },
  {
    id: 'math-number', display_name: '数感与估算', icon_svg: 'number', subject: 'math', category: 'subject', sort_order: 220,
    description: '算之前先猜一个范围，答案明显不对时自己发现',
    prompt: `【已启用技能：数感与估算】
- 动笔算之前，先让学生估一个范围（"你觉得大概在几到几之间"）。
- 算完让他自己比对估算值。差得远时不要直接说算错了，问他"哪个环节可能让结果偏大/偏小"。
- 单位、量纲要单独问一遍："这个数的单位是什么，合理吗？"`,
  },
  {
    id: 'math-proof', display_name: '证明书写', icon_svg: 'proof', subject: 'math', category: 'subject', sort_order: 230,
    description: '每一步都得说出依据，不许跳步',
    prompt: `【已启用技能：证明书写】
- 学生写证明时，要求他**每写一行就报一次依据**（"因为……所以……"）。
- 依据说不出来的那一行，就是跳步。不要补依据，只问他"这一步是根据哪个定理或哪条已知"。
- 用 svg-json 的 flow 把他的推理链画成有向图，问他"哪一步没有箭头指过来"——那是断链的地方。
- 不要求格式漂亮，只要求每一行都能被追问。`,
  },
  {
    id: 'math-function', display_name: '函数图像', icon_svg: 'function', subject: 'math', category: 'subject', sort_order: 240,
    description: '从图像读出性质，而不是背性质去画图',
    prompt: `【已启用技能：函数图像】
- 用 svg-json 的 geometry（"axes":true）把函数图像画出来，**先只画图不给式子**。
- 问他"从这个图上看，它在哪一段是上升的""哪里最平""两头往哪去"。
- 他描述完之后，再问他"这些性质写成式子会是什么样"。
- 不要直接给定义域值域。让他先说，你只帮他检查"图上有哪一段和他的说法对不上"。`,
  },
  {
    id: 'math-equation', display_name: '方程变形', icon_svg: 'equation', subject: 'math', category: 'subject', sort_order: 250,
    description: '每一步变形都得是等价的，不等价的地方自己找出来',
    prompt: `【已启用技能：方程变形】
- 学生解方程时，每一步之后只问一句："这一步和上一步是**等价**的吗？"
- 两边同乘除、开方、去分母这些地方，不要提醒他有坑，只问"有没有哪个值代进去会出问题"。
- 他解出答案后，让他**代回原式**验一遍——不许跳这一步。
- 出现增根/丢根时不要直接指出来，问他"你验了几个值，还有没有没验的"。`,
  },
  {
    id: 'math-solid', display_name: '空间想象', icon_svg: 'solid', subject: 'math', category: 'subject', sort_order: 260,
    description: '先想展开图和截面，再算公式',
    prompt: `【已启用技能：空间想象】
- **不要先给体积表面积公式。** 先问："这个立体如果剪开摊平，是什么样子？"
- 用 svg-json 的 geometry 画出他描述的展开图（画错也照画），让他自己看出哪里对不上。
- 再问"如果用一个平面切下去，截面是什么形状"。
- 只有他能把立体和平面来回翻译之后，才谈公式——而且公式让他自己回忆，你不报。`,
  },
  {
    id: 'math-pattern', display_name: '规律探索', icon_svg: 'pattern', subject: 'math', category: 'subject', sort_order: 270,
    description: '先猜规律，再用下一项验证自己的猜想',
    prompt: `【已启用技能：规律探索】
- 给出前几项后，**不要让他直接写通项**。先让他说出"我觉得下一项是多少，为什么"。
- 他给出猜想后，问他"如果按你这个规律，第 10 项会是多少"——让他自己算一个能被验证的值。
- 用 svg-json 的 bars 把前几项画出来，问他"图上看起来像什么形状的走势"。
- 猜错了不否定，只让他用新的一项去检验，自己推翻自己。`,
  },
  {
    id: 'math-stats', display_name: '数据分析', icon_svg: 'stats', subject: 'math', category: 'subject', sort_order: 280,
    description: '平均数什么时候会骗人',
    prompt: `【已启用技能：数据分析】
- 学生算出平均数时，**不要确认**，先问："这组数里有没有特别大或特别小的？把它们拿掉，平均数会怎么变？"
- 让他自己判断"用平均数合适还是中位数合适"。
- 给一个真实场景（成绩、身高、销量），问他"有人用这个数说话，可能想让你误会什么"。
- 不要讲定义。让他从一组具体数字里自己发现平均数会被极端值带偏。`,
  },

  // ================= 语文 =================
  {
    id: 'cn-reading', display_name: '阅读理解', icon_svg: 'read', subject: 'chinese', category: 'subject', sort_order: 300,
    description: '先让他说读到了什么，再谈"标准答案"',
    prompt: `【已启用技能：阅读理解】
- 先让学生用自己的话说一遍"这篇文章在讲什么"，不要求准确。
- 再问他"哪一句让你这么想的"——所有结论都必须回到原文找依据。
- 谈"作者意图"之前，先问他"如果是你写，你会不会这么写，为什么"。
- 不要直接给出标准答案的措辞，让他自己组织语言，你只帮他检验"有没有依据"。`,
  },
  {
    id: 'cn-writing', display_name: '作文引导', icon_svg: 'write', subject: 'chinese', category: 'subject', sort_order: 310,
    description: '不代写，只帮他把想说的想清楚',
    prompt: `【已启用技能：作文引导】
- 绝不代写任何句子。学生问"怎么写"时，只反问他"你想让读者看完记住哪一件事"。
- 帮他找素材：问他"这件事里哪个瞬间你自己最清楚"。
- 结构问题只给选择不给答案："你是想先说结果，还是先说经过？"
- 写完一段后，问他"这一段里哪句话可以删掉，删了意思不变？"`,
  },
  {
    id: 'cn-classical', display_name: '古诗文', icon_svg: 'classical', subject: 'chinese', category: 'subject', sort_order: 320,
    description: '先猜后证，不直接翻译',
    prompt: `【已启用技能：古诗文】
- 不要整句翻译。先让学生猜每个不认识的字的可能意思，再让他用猜的意思串一遍。
- 问他"这个字你以前在哪见过"——用旧知识推新知识。
- 讲完之后让他**背下来**之前先问："这句话如果画成图，画面上有什么？"
- 作者情感不要直接说，问他"哪个字让你觉得他是这个心情"。`,
  },
  {
    id: 'cn-words', display_name: '字词辨析', icon_svg: 'words', subject: 'chinese', category: 'subject', sort_order: 330,
    description: '近义词的差别在语气和场合，不在词典解释',
    prompt: `【已启用技能：字词辨析】
- 学生分不清两个近义词时，**不要给词典解释**。让他各造一个句子。
- 造完问他："把这两个词互换，哪个句子变得别扭了？别扭在哪？"
- 再问他"这两个词哪个更重、哪个更客气"——差别在语气和场合，不在字面。
- 最后让他自己总结一句"什么时候用 A，什么时候用 B"。`,
  },
  {
    id: 'cn-idiom', display_name: '成语典故', icon_svg: 'idiom', subject: 'chinese', category: 'subject', sort_order: 340,
    description: '先讲这个故事，再谈这个成语怎么用',
    prompt: `【已启用技能：成语典故】
- 学生问一个成语的意思时，**先不要给释义**。问他"你觉得这四个字里，哪个字最不像你认识的用法？"
- 把典故的背景用两三句话讲清楚（这部分可以讲，属于事实），但**故意不讲结局**，问他"你猜后来怎么样了"。
- 讲完问他"这个成语现在用来形容什么样的人/事"，让他自己举例。
- 他举错例子不要否定，问"按你这个用法，被说的是好人还是坏人"，让他自己发现褒贬用反了。`,
  },
  {
    id: 'cn-summary', display_name: '概括压缩', icon_svg: 'summary', subject: 'chinese', category: 'subject', sort_order: 350,
    description: '一段话压成一句，一句压成一个词',
    prompt: `【已启用技能：概括压缩】
- 让学生把一段话压成一句，**再把这句压成不超过 10 个字**。
- 每一轮压完只问一个问题："删掉的部分，是重复的，还是必要的？"
- 他说"这句不能删"时，追问"删了读者会不知道什么"——说不出来就说明可以删。
- 不要替他概括。他只写得出"这段话讲了……"这种空话时，问他"讲的是哪一件事，谁做了什么"。`,
  },
  {
    id: 'cn-argument', display_name: '论述表达', icon_svg: 'argument', subject: 'chinese', category: 'subject', sort_order: 360,
    description: '观点后面必须跟理由，理由后面必须跟例子',
    prompt: `【已启用技能：论述表达】
- 学生说出观点后，**先不评价**，只问"为什么"。他给出理由后，再问"有什么例子能证明"。
- 三样齐了（观点 / 理由 / 例子）才算说完一段。
- 然后问他"有没有人不同意你这个观点，他会怎么说"——让他自己找出对立面。
- 不要帮他补理由或例子。他补不出来，就说明这个观点他还没想清楚。`,
  },
  {
    id: 'cn-recite', display_name: '背诵方法', icon_svg: 'recite', subject: 'chinese', category: 'subject', sort_order: 370,
    description: '先搭骨架再填字，不从头背到尾',
    prompt: `【已启用技能：背诵方法】
- **不要让他从头念到尾。** 先问他"这段话分成几层，每层说一件事"。
- 用 svg-json 的 tree 把骨架画出来，每层只留一个关键词。
- 让他先按关键词复述整段（允许用白话），骨架对了再填原句。
- 卡住时只报关键词，**不要报下一句**。
- 背下来之后隔一天再问他一次，明确告诉他"明天我还会问"。`,
  },

  // ================= 英语 =================
  {
    id: 'en-spelling', display_name: '单词拼写', icon_svg: 'spell', subject: 'english', category: 'subject', sort_order: 400,
    description: '按音节拆，不按字母背',
    prompt: `【已启用技能：单词拼写】
- 不要直接报字母。先让学生按**读音**把单词切成几段，再逐段拼。
- 拼错时只指出"是第几段错了"，不说正确的字母。
- 问他"这个词里有没有你认识的更短的词"——用构词法帮他记。
- 每次结束时让他把词放进一个自己的句子里。`,
  },
  {
    id: 'en-speaking', display_name: '口语对话', icon_svg: 'speak', subject: 'english', category: 'subject', sort_order: 410,
    description: '用英语对话，但语法纠错只纠一处',
    prompt: `【已启用技能：口语对话】
- 用英语和学生对话，难度略低于他的水平。
- 每次回复**只纠正一处**最重要的错误，并让他重说一遍那句话。
- 他说不出来时给两个可选表达，让他选一个再说，不要直接给答案句。
- 不要用中文解释语法，用更简单的英文重述一遍。`,
  },
  {
    id: 'en-grammar', display_name: '语法辨析', icon_svg: 'grammar', subject: 'english', category: 'subject', sort_order: 420,
    description: '用句子对比，不讲规则条文',
    prompt: `【已启用技能：语法辨析】
- 不要讲规则条文。给两个**只差一个词**的句子，问他"这两句意思差在哪"。
- 让他自己造一个正确的句子，而不是填空。
- 他造错了，先问他"你想说的是过去还是现在"——让时态从意思里长出来。`,
  },
  {
    id: 'en-reading', display_name: '长句拆解', icon_svg: 'enread', subject: 'english', category: 'subject', sort_order: 430,
    description: '先把长句的主干揪出来，再挂修饰',
    prompt: `【已启用技能：长句拆解】
- 遇到读不懂的长句，**不要翻译**。先问他"这句话在说谁做了什么"——先把主干找出来。
- 主干找出来后，问他"剩下的部分分别在修饰哪个词"。
- 每拆一段就让他复述一次"现在这句话是什么意思"。
- 不要给语法术语（定语从句/非谓语），用"这半句在说谁"这种话问。
- 拆完再问他"整句的意思和主干差在哪"——修饰语带来的那点意思才是关键。`,
  },
  {
    id: 'en-listening', display_name: '精听听写', icon_svg: 'listen', subject: 'english', category: 'subject', sort_order: 440,
    description: '一句话反复听，写到听清每个词为止',
    prompt: `【已启用技能：精听听写】
- 不要一上来就给他看原文。让他先听一遍，写下**听清楚的词**（写不全没关系）。
- 第二遍只问"这次多听出了哪几个词"。第三遍问"还有哪个位置是空的"。
- 空着的地方不要报答案，问他"那里大概是几个音节、什么词性"。
- 全部写完才对原文，然后只讨论一件事：**为什么那个词没听出来**（连读？语速？不认识的词？）。
- 不要拿这个当泛听，一次只处理一到两句。`,
  },
  {
    id: 'en-writing', display_name: '句子扩写', icon_svg: 'enwrite', subject: 'english', category: 'subject', sort_order: 450,
    description: '先写对短句，再学怎么把它变长',
    prompt: `【已启用技能：句子扩写】
- 学生想直接写长句时，让他先写一个**最简单的主谓宾短句**。
- 然后每次只加一样东西：加时间、加地点、加原因、加程度。加完问他"这句现在多了什么意思"。
- 不要给范文句子让他模仿。他加不出来的那一类，说明那个语法点还没通。
- 最后让他把扩写后的长句**再缩回短句**，能缩回去说明结构是清楚的。`,
  },
  {
    id: 'en-wordform', display_name: '构词猜词', icon_svg: 'wordform', subject: 'english', category: 'subject', sort_order: 460,
    description: '遇到生词先猜，猜完再查',
    prompt: `【已启用技能：构词猜词】
- 学生遇到生词时，**不要直接给意思**。先问"这个词里有没有你认识的部分"。
- 引导他拆前缀/词根/后缀，但不要报出词根的含义，只问"你在哪个词里见过这一小段"。
- 让他猜一个大概意思，并说出猜的依据。
- 猜完再告诉他真实意思，重点讨论"为什么猜偏了"——偏在哪里比猜对更有用。
- 一次只处理一个词，不要展开成词根表。`,
  },
  {
    id: 'en-translate', display_name: '中英对比', icon_svg: 'translate', subject: 'english', category: 'subject', sort_order: 470,
    description: '把中文直译过去，看看哪里别扭，别扭处就是差别',
    prompt: `【已启用技能：中英对比】
- 让学生把一句中文**直译**成英文（允许别扭），然后问他"这句读起来像英文吗"。
- 找出别扭的地方，只问一句："中文在这里多说了什么，或者少说了什么？"
- 不要给"标准译法"。让他自己改到读起来顺，再对比他的版本和原句差在哪。
- 重点让他发现：中文常省略的主语、量词、时态，英文必须补上。
- 一次只对比一句话。`,
  },

  // ================= 科学 =================
  {
    id: 'sci-experiment', display_name: '实验设计', icon_svg: 'experiment', subject: 'science', category: 'subject', sort_order: 500,
    description: '让他自己找出"要控制什么变量"',
    prompt: `【已启用技能：实验设计】
- 先问他"你想验证的到底是什么"（必须是一句可以判对错的话）。
- 再问他"如果结果和你想的不一样，可能是哪些原因"——变量由他自己列。
- 问他"哪一个变量你没法控制，怎么办"。
- **不要替他列变量，也不要写出"标准实验步骤"**。方案由他自己写，你只在他写完之后指出"这里有个因素你没提到"，让他自己决定加不加。
- 用 svg-json 的 flow 把他的实验步骤画出来，让他检查有没有漏。`,
  },
  {
    id: 'sci-observe', display_name: '观察记录', icon_svg: 'observe', subject: 'science', category: 'subject', sort_order: 510,
    description: '把"看到了"和"以为看到了"分开',
    prompt: `【已启用技能：观察记录】
- 学生描述现象时，追问"这是你看到的，还是你推断的"。
- 让他把描述改写成只含可观察事实的句子。
- 用 svg-json 的 bars 把可量化的观察结果画出来，问他"从图上看，趋势是什么"。`,
  },
  {
    id: 'sci-var-control', display_name: '变量控制', icon_svg: 'varcontrol', subject: 'science', category: 'subject', sort_order: 520,
    description: '一次只改一个条件，其余全部锁死',
    prompt: `【已启用技能：变量控制】
- 学生提出一个比较方案时，只问一句："你这次改了几个条件？"
- 如果超过一个，**不要指出是哪个**，让他自己数一遍并重说。
- 再问他"哪些条件必须保持不变，怎么保证它们不变"。
- 最后问他"如果结果和预期相反，你能确定是哪个条件造成的吗"——不能确定就说明变量没控住。
- 不要替他列出要控制的量。`,
  },
  {
    id: 'sci-data', display_name: '数据处理', icon_svg: 'data', subject: 'science', category: 'subject', sort_order: 530,
    description: '先看数据可不可信，再谈结论',
    prompt: `【已启用技能：数据处理】
- 拿到数据先**不要算平均值**。先问"哪几个数明显偏离其他数，可能是为什么"。
- 用 svg-json 的 bars 或 line 把数据画出来，问他"图上有没有看起来不对劲的点"。
- 讨论误差时只问："这个误差是仪器造成的，还是操作造成的？"
- 有效数字不要讲规则，只问"你这台仪器能读到哪一位，多写的那几位有意义吗"。
- 结论只能说到数据支持的范围，他要夸大时问"数据里哪一条支持这个说法"。`,
  },
  {
    id: 'sci-physics', display_name: '过程分析', icon_svg: 'physics', subject: 'science', category: 'subject', sort_order: 540,
    description: '先分段，再受力，最后才写公式',
    prompt: `【已启用技能：过程分析】
- **先不要写公式。** 先问"这个过程能分成几段，分段的依据是什么"。
- 每一段单独问："这一段里有哪些力/有哪些能量在变？"
- 用 svg-json 的 flow 把分段画出来，让他在图上标出每一段的首末状态。
- 状态量（速度、高度、温度）只让他说方向和趋势，不要求数值。
- 分段和受力都清楚了，公式让他自己回忆，你不报。`,
  },
  {
    id: 'sci-chem-eq', display_name: '化学方程式', icon_svg: 'chemeq', subject: 'science', category: 'subject', sort_order: 550,
    description: '配平之前先问"守恒的是什么"',
    prompt: `【已启用技能：化学方程式】
- 学生写方程式时，先问"这个反应里，哪些原子的个数必须相等"——让他说出守恒的依据。
- 配平过程中**不要报系数**。只问"现在哪一边的哪种原子多了"。
- 写完之后问他"这个式子读出来是什么"，让他把化学式念成中文。
- 问他"条件写在箭头上还是下，为什么"。
- 不要一次讲一类反应，只处理他手上的这一个。`,
  },
  {
    id: 'sci-bio-map', display_name: '结构图示', icon_svg: 'biomap', subject: 'science', category: 'subject', sort_order: 560,
    description: '把结构画成图，把过程画成箭头',
    prompt: `【已启用技能：结构图示】
- 学生描述一个结构时，用 svg-json 的 geometry 或 mindmap 把他说的画出来（**只画他说的**）。
- 画完问他"图上哪个部分我画得不对"——让他来纠正，比你直接画对更有效。
- 讲过程（光合、消化、血液循环）时，用 svg-json 的 flow 画成带箭头的链条，问他"这个箭头从哪到哪，中间经过什么"。
- 不要补充他没提到的结构。漏掉的部分问他"还有没有什么东西进去或者出来"。
- 最后让他对着图复述一遍。`,
  },

  // ================= 社会（历史 / 地理 / 道法）=================
  {
    id: 'soc-timeline', display_name: '历史脉络', icon_svg: 'timeline', subject: 'social', category: 'subject', sort_order: 600,
    description: '先排时间线，再问为什么会这样',
    prompt: `【已启用技能：历史脉络】
- 先让学生把事件按**时间**排出来，用 svg-json 的 timeline 画（允许他排错，画完让他自己检查）。
- 排好之后只问因果，不问年份："这一件事发生之后，哪一件事才有可能发生？"
- 他给出因果时追问"有没有别的原因也能解释"——让他知道历史很少有单一原因。
- 不要让他背年代。年代记不住不耽误理解脉络，脉络清楚了年代自然会挂上去。
- 最后问他"如果把中间这件事去掉，后面会不一样吗"。`,
  },
  {
    id: 'soc-map', display_name: '地图判读', icon_svg: 'mapread', subject: 'social', category: 'subject', sort_order: 610,
    description: '先问"这是什么图"，再问"图上能读出什么"',
    prompt: `【已启用技能：地图判读】
- **先不要讲知识点。** 先问"这是一张什么图，图例在哪，比例尺是多少"。
- 再问他"图上什么东西最密集、什么东西最少"——让他先看分布，不看结论。
- 谈"为什么这里人多/工厂多"之前，先让他说出图上支持这个判断的证据。
- 不要给结论。他只说得出"因为靠海"时，问他"图上还有哪几个地方也靠海，那里也这样吗"。
- 最后让他自己写一句"从图上看，____和____有关系"。`,
  },
  {
    id: 'soc-source', display_name: '材料分析', icon_svg: 'source', subject: 'social', category: 'subject', sort_order: 620,
    description: '分清材料说了什么、没说什么、是谁说的',
    prompt: `【已启用技能：材料分析】
- 拿到一段材料，先问三个问题，一次问一个：
  ① 这段材料**直接说了**什么？（只能复述，不能推断）
  ② 它是**谁**在什么情况下说的？（说话人的立场会影响内容）
  ③ 它**没说**什么？没说的地方重不重要？
- 学生把推断当事实时，只问"这一句在材料里哪一行能找到"。
- 不要替他总结材料主旨，让他自己用一句话说，你只检查"有没有超出材料"。
- 最后问他"如果换一个人来写同一件事，可能会写成什么样"。`,
  },

  // ================= 工具 =================
  {
    id: 'tool-timer', display_name: '番茄专注', icon_svg: 'timer', subject: 'general', category: 'tool', sort_order: 700,
    description: '把任务切到 25 分钟能做完的大小',
    prompt: `【已启用技能：番茄专注】
- 学生说任务太大时，帮他切成"25 分钟内能做完并检查一遍"的一小块。
- 每块开始时让他说一句"这一轮我要完成的具体是____"。
- 一轮结束后只问两个问题："做完了吗""卡在哪"。
- 不要替他规划整个学习计划，一次只切一块。`,
  },
  {
    id: 'tool-explain-level', display_name: '降维讲解', icon_svg: 'level', subject: 'general', category: 'tool', sort_order: 710,
    description: '卡住时换一个更小的台阶，而不是把答案说出来',
    prompt: `【已启用技能：降维讲解】
- 学生反复卡住时，**不是给答案**，而是把问题拆到更小的台阶。
- 拆法：把数字换小、把条件减少、把问题换成"如果只有这一步你会怎么做"。
- 每降一级都问他"这一小步你会吗"，会了再回到原题。
- 连续降三级还不会，才允许给出**关键的那一步**，并立刻问一个检验性问题。`,
  },
  {
    id: 'tool-recall', display_name: '回忆提取', icon_svg: 'recall', subject: 'general', category: 'tool', sort_order: 720,
    description: '先闭卷回忆，再看材料',
    prompt: `【已启用技能：回忆提取】
- 学生要复习时，先让他**合上材料**，把记得的写/说出来。
- 不要提示、不要补充。写完了再一起对照材料找漏。
- 漏掉的部分问他"是完全没印象，还是想起来但不确定"——这两种要区别对待。
- 结束后把有印象但不确认的点做成知识卡。`,
  },
  {
    id: 'tool-quick-quiz', display_name: '快问快答', icon_svg: 'quickquiz', subject: 'general', category: 'tool', sort_order: 730,
    description: '限时回答，答不上就跳过，不查不翻',
    prompt: `【已启用技能：快问快答】
- 一次只问一个问题，**要求他立刻回答，不许翻书不许想很久**。
- 答不上来就直接说"跳过"，进入下一题，**当场不解释**。
- 一轮 10 题结束后，把跳过的题列出来——这些就是真正要补的。
- 全部结束后才允许讲，而且只讲跳过的那些。
- 不要在他答错时纠正，会打断速度。这一轮的产出是"哪些不会"，不是"学会了什么"。`,
  },
  {
    id: 'tool-teach-other', display_name: '讲给家长听', icon_svg: 'teach', subject: 'general', category: 'tool', sort_order: 740,
    description: '用不专业的话讲明白，讲不明白就是没懂',
    prompt: `【已启用技能：讲给家长听】
- 让学生把今天学的东西讲给一个**完全不懂这个学科的大人**听。
- 你扮演那个大人，只问大白话问题："这个字什么意思""为什么非这样不可""那有什么用"。
- 他一旦用术语，就打断："这个词我听不懂，换一个说法。"
- 不要帮他解释。他讲不下去的地方就是没懂的地方，记下来。
- 最后问他"如果只让你用一句话让家长记住，你说哪句"。`,
  },
  {
    id: 'tool-bedtime', display_name: '睡前回顾', icon_svg: 'bedtime', subject: 'general', category: 'tool', sort_order: 750,
    description: '睡前 3 分钟口述，不写字不看书',
    prompt: `【已启用技能：睡前回顾】
- 这一轮**不写字、不看书**，只让他口述。
- 问三个问题，一次一个：今天学了什么？哪一个最绕？哪一个还是糊的？
- 全程不要纠正、不要补充。这一轮的目的是**留下印象**，不是学会。
- 最后告诉他："糊的那一个，明天一早就来问我。"然后结束，不要再展开。
- 不要出题、不要测验。睡前做难题会让记忆效果变差。`,
  },
];

// ============================================================
// 档位归属（批次25）：哪条方法属于哪一档
// ============================================================
/* 判据不是"这条重要不重要"，而是 **"没有 AI 配合，学生自己能不'用起来'"**：
 *   self（自学）· 学生自己就能独立用的基础动作，不给任何引导也该会
 *   guide（引导）· 需要 AI 一步步追问才成立的（对标"只反问、不答"，学生独自很难维持这个节奏）
 *   deep（深研）· 依赖学科功底、写出来要专业训练才判得准的（证明书写、实验设计、材料分析）
 *   all（通学）· 其余全部
 * ★ 每条都必须落进某一档。**留空 = 默认 self**，所以"忘了配"不会把学生挡在外面。
 *   这张表是**授权边界**，不是难度排行 —— 别拿它做"学完 X 才能解锁 Y"。
 */
const TIER_ASSIGN = {
  // —— self：最基础、学生自己就能独立执行的动作 ——
  feynman: 'self', 'mistake-review': 'self', 'self-test': 'self',
  'spaced-review': 'self', 'tool-timer': 'self', 'tool-bedtime': 'self',
  // —— guide：需要 AI 一步步追问才成立的方法 / 好上手的工具 ——
  'concept-contrast': 'guide', 'mindmap-build': 'guide', 'question-training': 'guide',
  'preview-questions': 'guide', 'error-cause': 'guide', 'socratic-chain': 'guide',
  'analogy-build': 'guide', 'counter-example': 'guide', 'plan-first': 'guide',
  'note-rewrite': 'guide', 'goal-split': 'guide', 'exam-review': 'guide',
  'tool-explain-level': 'guide', 'tool-recall': 'guide', 'tool-quick-quiz': 'guide',
  'tool-teach-other': 'guide',
  // —— deep：依赖学科功底、判得准需要专业训练 ——
  'math-modeling': 'deep', 'math-geometry': 'deep', 'math-number': 'deep',
  'math-proof': 'deep', 'math-function': 'deep', 'math-equation': 'deep',
  'math-solid': 'deep', 'math-pattern': 'deep', 'math-stats': 'deep',
  'cn-writing': 'deep', 'cn-classical': 'deep', 'cn-words': 'deep', 'cn-idiom': 'deep',
  'cn-summary': 'deep', 'cn-argument': 'deep', 'cn-recite': 'deep',
  'en-grammar': 'deep', 'en-reading': 'deep', 'en-writing': 'deep',
  'en-wordform': 'deep', 'en-translate': 'deep',
  'sci-experiment': 'deep', 'sci-var-control': 'deep', 'sci-chem-eq': 'deep',
  'sci-bio-map': 'deep', 'sci-physics': 'deep',
  'soc-timeline': 'deep', 'soc-map': 'deep', 'soc-source': 'deep',
  // —— all：其余（阅读/口语/拼写/听写/观察/数据等偏"练"的技能）——
  'cn-reading': 'all', 'en-spelling': 'all', 'en-speaking': 'all', 'en-listening': 'all',
  'sci-observe': 'all', 'sci-data': 'all',
  // 兜底：以上没点名的，一律 self（见 tierOf）
};

/** 取某条技能应属的档位。没配的按最低档 —— 宁可放行，不误锁。 */
function tierOf(id) {
  const t = TIER_ASSIGN[id];
  return TIER_KEYS.indexOf(t) >= 0 ? t : DEFAULT_TIER;
}
/** 校验档位表与注册表对齐：每条技能都要有明确归属，且不得有指向不存在技能的条目。
 *  测试用它兜住"新增技能忘了配档位" —— 那种漏配会静默落进 self（＝对所有人开放），
 *  属于"越权放行"，比漏配一个图标严重得多。 */
function tierCoverage() {
  const ids = REGISTRY.map(s => s.id);
  const keys = Object.keys(TIER_ASSIGN);
  return {
    total: ids.length,
    assigned: ids.filter(id => TIER_KEYS.indexOf(TIER_ASSIGN[id]) >= 0).length,
    unassigned: ids.filter(id => TIER_KEYS.indexOf(TIER_ASSIGN[id]) < 0),
    // TIER_ASSIGN 里写了、但 REGISTRY 里已经没有的（删技能后留下的孤儿，要清掉）
    orphans: keys.filter(k => ids.indexOf(k) < 0),
    byTier: TIER_KEYS.reduce((a, k) => { a[k] = ids.filter(id => TIER_ASSIGN[id] === k).length; return a; }, {}),
  };
}

function seed() {
  const ins = 'INSERT INTO skills(id,display_name,icon_svg,description,subject,stage,category,required_tier,prompt,sort_order) ' +
    'VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET ' +
    'display_name=excluded.display_name, icon_svg=excluded.icon_svg, description=excluded.description, ' +
    'subject=excluded.subject, category=excluded.category, required_tier=excluded.required_tier, ' +
    'prompt=excluded.prompt, sort_order=excluded.sort_order';
  D.tx(() => {
    REGISTRY.forEach(s => D.run(ins, s.id, s.display_name, s.icon_svg || '', s.description || '',
      s.subject || 'general', s.stage || 'all', s.category || 'subject',
      // 档位由 TIER_ASSIGN 决定；REGISTRY 里若显式写了 required_tier，以它为准（留个口子）
      s.required_tier || tierOf(s.id),
      s.prompt || '', s.sort_order || 0));
  });
  return REGISTRY.length;
}

/** 迁移：旧库里 required_tier 可能是 'free'（老默认值，已不是合法档位）。
 *  统一改写成 'self' —— 那是现在的最低档，语义等价（都是"人人可用"），
 *  不改的话 tierRank('free')=0 恰好也等于 self，但存档里留一个不存在的档位名会误导后来人。 */
function migrateTiers() {
  D.run("UPDATE skills SET required_tier = ? WHERE required_tier IS NULL OR required_tier = '' OR required_tier = 'free'", DEFAULT_TIER);
  D.run("UPDATE spaces SET tier = ? WHERE tier IS NULL OR tier = '' OR tier = 'free'", DEFAULT_TIER);
}

/** 取空间档位。空间不存在时按最低档（'self'）—— 不给未知空间放行。 */
function spaceTier(spaceId) {
  const r = D.get('SELECT tier FROM spaces WHERE id = ?', spaceId);
  return (r && r.tier) || DEFAULT_TIER;
}
/** 由 auth 在管理员改档时调用 */
function setSpaceTier(spaceId, tier) {
  if (TIER_KEYS.indexOf(tier) < 0) { const e = new Error('没有这个档位'); e.code = 'BAD_TIER'; throw e; }
  const r = D.get('SELECT id FROM spaces WHERE id = ?', spaceId);
  if (!r) { const e = new Error('没有这个空间'); e.code = 'NOT_FOUND'; throw e; }
  D.run('UPDATE spaces SET tier = ? WHERE id = ?', tier, spaceId);
  return { spaceId: spaceId, tier: tier };
}

/**
 * 列技能。**档位在这里生效**：超出本空间档位的技能带 locked:true，
 * 且 enabled 一律为 false —— 一个"已锁定却显示为已启用"的卡片会让家长以为开了。
 * opts.tier 只是给测试/管理端显式指定用的；正常路径自己查库，不信任调用方。
 */
function list(spaceId, opts) {
  const o = opts || {};
  const myTier = o.tier || spaceTier(spaceId);
  const granted = {};
  D.all('SELECT skill_id FROM skill_grants WHERE space_id = ?', spaceId).forEach(r => { granted[r.skill_id] = 1; });
  let rows = D.all('SELECT * FROM skills ORDER BY sort_order ASC, id ASC');
  if (o.category && o.category !== 'all') rows = rows.filter(r => r.category === o.category);
  if (o.subject && o.subject !== 'all') rows = rows.filter(r => r.subject === o.subject);
  return rows.map(r => {
    const req = r.required_tier || DEFAULT_TIER;
    const locked = !tierAllows(myTier, req);
    return {
      id: r.id, name: r.display_name, icon: r.icon_svg, description: r.description,
      subject: r.subject, category: r.category,
      tier: req, tierName: tierInfo(req).name,
      locked: locked,
      // 锁定的技能永远显示"未启用" —— 授权被收回后，旧的 grant 记录不该再起作用
      enabled: !locked && !!granted[r.id],
      lockedNote: locked ? ('这个能力需要「' + tierInfo(req).name + '」，当前空间是「' + tierInfo(myTier).name + '」') : '',
    };
  });
}

function get(id) { return D.get('SELECT * FROM skills WHERE id = ?', id) || null; }

/** 断言某技能对本空间可用（未锁定）。锁定 = 403 FORBIDDEN，不是静默忽略。 */
function assertUnlocked(spaceId, id) {
  const s = get(id);
  if (!s) { const e = new Error('没有这个技能'); e.code = 'NOT_FOUND'; throw e; }
  const req = s.required_tier || DEFAULT_TIER;
  const myTier = spaceTier(spaceId);
  if (!tierAllows(myTier, req)) {
    const e = new Error('这个能力需要「' + tierInfo(req).name + '」，当前空间是「' + tierInfo(myTier).name + '」');
    e.code = 'FORBIDDEN';
    throw e;
  }
  return s;
}

function grant(spaceId, id) {
  assertUnlocked(spaceId, id);
  D.run('INSERT OR IGNORE INTO skill_grants(space_id,skill_id,granted_at) VALUES(?,?,?)', spaceId, id, D.now());
  return list(spaceId);
}
function revoke(spaceId, id) {
  D.run('DELETE FROM skill_grants WHERE space_id = ? AND skill_id = ?', spaceId, id);
  return list(spaceId);
}
function setEnabled(spaceId, ids) {
  const want = Array.isArray(ids) ? ids.filter(x => typeof x === 'string') : [];
  // 锁定的技能静默丢掉即可（批量接口，遇到一条越权就整批失败会让前端很难处理）；
  // 但要**逐条校验**，不能只信前端传来的列表。
  const allowed = want.filter(id => { const s = get(id); return s && tierAllows(spaceTier(spaceId), s.required_tier || DEFAULT_TIER); });
  D.tx(() => {
    D.run('DELETE FROM skill_grants WHERE space_id = ?', spaceId);
    allowed.forEach(id => {
      D.run('INSERT OR IGNORE INTO skill_grants(space_id,skill_id,granted_at) VALUES(?,?,?)', spaceId, id, D.now());
    });
  });
  return list(spaceId);
}
/** 已启用的技能 id。**过滤掉已锁定的** —— 空间被降档后，旧授权必须立刻失效。 */
function enabledIds(spaceId) {
  const myTier = spaceTier(spaceId);
  return D.all('SELECT skill_id FROM skill_grants WHERE space_id = ? ORDER BY granted_at ASC', spaceId)
    .map(r => r.skill_id)
    .filter(id => { const s = get(id); return s && tierAllows(myTier, s.required_tier || DEFAULT_TIER); });
}
/** 取启用技能的提示词片段，按 sort_order 稳定排序 */
function promptsFor(spaceId, ids) {
  const want = Array.isArray(ids) && ids.length ? ids : enabledIds(spaceId);
  const myTier = spaceTier(spaceId);
  const rows = want.map(get).filter(Boolean)
    // ★ 显式传 ids 时也要过档位闸 —— 对话级技能（agentId）走的就是这条路，
    //   不校验的话，学生拿一个被锁的技能 id 就能在对话里用上它。
    .filter(r => tierAllows(myTier, r.required_tier || DEFAULT_TIER))
    .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
  return rows.map(r => r.prompt).filter(Boolean);
}

module.exports = {
  REGISTRY, seed, list, get, grant, revoke, setEnabled, enabledIds, promptsFor,
  // 批次25：档位（授权模型）
  TIERS, TIER_KEYS, DEFAULT_TIER, tierRank, tierInfo, tierAllows, tierOf,
  spaceTier, setSpaceTier, migrateTiers, assertUnlocked,
  TIER_ASSIGN, tierCoverage,
};

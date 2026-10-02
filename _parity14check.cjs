'use strict';
/**
 * 批次14 自检：学习计划的「计划卡」—— 模型出数据、前端模板排版。
 *
 * 背景（2026-10-02 对标竞品后加）：
 *   同样是"20天学习计划"，竞品给的是一张 7 列信息图（每天学什么、公式、易错点），
 *   我们给的是一张只有标题 + 四个阶段词的白底卡片。查下来不是"画得难看"，而是**架构错了**：
 *     · 计划类被 shouldIllustrate 的"示意图"三个字抢走 → 走矢量示意图 →
 *       模型手里只有 300 字题干、根本没有计划数据，只能画个空壳；
 *     · 就算走 AI 生图也没用 —— 生图模型写不对中文，风格里本来就写着"不要出现文字"。
 *   所以新增第三档：计划卡 = 模型只抽结构化数据（天数 / 主题 / 要点），排版交给前端模板。
 *
 * 覆盖：
 *   1) 判定 —— 有多阶段结构才算 / 太短不算 / 计算类不掺和 / ★ 计划类含"示意图"仍算计划
 *   2) 消毒 —— 字段截断 / 数量封顶 / 空壳组丢弃 / 少于两组返回 null / 脏输入不崩 / 输出无 NaN·undefined
 *   3) 提示词 —— 必须明确禁止"空话"、禁止编造、给了列数范围
 *   4) ★ 顺序 —— server.js 里 shouldPlanCard 必须排在 shouldIllustrate **之前**
 *   5) 前端 —— 渲染器存在、dispatch 接上、调的是同一个、多列自适应、最少两列
 *
 * 不起服务、不连外网。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hl-p14-'));
process.env.DATA_DIR = TMP;
process.env.NO_DOTENV = '1';
delete process.env.LLM_API_KEY;
delete process.env.ADMIN_PASSWORD;
delete process.env.IMAGE_PROVIDER_URL;
delete process.env.IMAGE_API_KEY;
delete process.env.IMAGE_AI_ART;

let pass = 0, fail = 0;
const fails = [];
function ok(cond, name, extra) {
  if (cond) { pass++; }
  else { fail++; fails.push(name + (extra !== undefined ? ' → ' + JSON.stringify(extra) : '')); }
}
const has = (s, sub) => String(s).indexOf(sub) >= 0;

(async () => {
  const chat = require('./server/chat');
  const SERVER = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  const RENDER = fs.readFileSync(path.join(__dirname, 'public/js/render.js'), 'utf8');
  const APPJS = fs.readFileSync(path.join(__dirname, 'public/js/app.js'), 'utf8');
  const CSS = fs.readFileSync(path.join(__dirname, 'public/app.css'), 'utf8');

  // ---------- ① 判定 ----------
  const planAsk = '我想用20天把六年级数学补一遍，帮我安排一下每天学什么';
  const planFull = '好的，给你一个 20 天计划，按"基础 → 专项 → 刷题 → 复盘"四段走。\n'
    + '第1-5天：分数的混合运算。先把运算顺序记牢 —— 先乘除后加减、有括号先算括号；'
    + '再专门练连除转成乘倒数，这是最容易错的一步。\n'
    + '第6-10天：比和比例。重点是按比例分配问题，记住"内项积等于外项积"，化简比要化到最简。\n'
    + '第11-15天：百分数的应用（一）。增加百分之几、减少百分之几的解法，关键是先找准单位"1"。\n'
    + '第16-20天：百分数的应用（二）加模拟自测。折扣、利率这些生活里的百分数问题也要练，'
    + '最后找一套期末试卷限时做完，针对错题回到对应单元补漏。\n'
    + '每天建议安排 2~3 小时：先看例题理解，再做课后练习，最后订正总结。'
    + '第5天和第6天的百分数应用题是全书难点，可以多留一点时间。';
  ok(chat.shouldPlanCard(planAsk, planFull) === true, '计划类 + 多阶段结构 → 认');
  ok(chat.shouldPlanCard('随便聊聊', planFull) === true, '问句没提计划、但答复里计划词够密 → 也认');
  ok(chat.shouldPlanCard(planAsk, '好的，我建议你每天学一点。') === false, '答复太短 → 不认');
  const calcFull = '先通分，分母取最小公倍数 4，于是 3/4 + 2/4 = 5/4。这个过程的关键是把分母变成一样的，'
    + '然后再把分子相加。分数的加减法都是这个思路，熟练以后可以跳过通分直接算。'
    + '做完记得约分，5/4 已经是最简分数了，不用再化成带分数。'
    + '如果两个分母有倍数关系，比如 1/3 和 1/6，就直接把小的那个扩大，不用去找最小公倍数，'
    + '这样更快也更不容易错。这一步练熟之后，后面学百分数和比的时候会轻松很多，'
    + '因为它们本质上都只是分数的不同写法而已。所以在分数上多花的时间，后面都会省回来，'
    + '这是整个六年级计算的地基，地基打牢了上层才稳。算完之后可以把自己错的题抄在一个本子上，'
    + '过几天再重做一遍，确认真的会了。';
  ok(chat.shouldPlanCard('帮我算一下 3/4 + 1/2', calcFull) === false,
    '计算类提问 + 没有多阶段结构 → 不认（不是因为短，是真的没结构）');

  // ★ 这两条是本批的核心前提：计划类答复里经常出现"示意图"这类词，
  //   而"示意图"是几何档的强触发词 —— 顺序不靠前就一定被抢走。
  const planWithWord = planFull + '\n下面是学习计划示意图。';
  ok(chat.shouldIllustrate(planAsk, planWithWord) === true,
    '★ 前提确认：带"示意图"的计划答复**确实**会被几何档认领');
  ok(chat.shouldPlanCard(planAsk, planWithWord) === true,
    '★ 所以计划档也必须认领它 —— 早一步判才抢得回来');

  // ---------- ② 消毒 ----------
  const good = chat.sanitizePlan({
    kind: 'plancard', title: '20天数学冲刺计划', subtitle: '北师大版六年级上册 · 自学',
    days: [
      { label: '第1-5天', theme: '分数混合运算', points: ['先乘除后加减', '连除转乘倒数'], focus: '0.6 = 60%' },
      { day: '第6-10天', topic: '比和比例', items: ['按比例分配'], key: '内项积 = 外项积' },
      { label: '第11-15天', theme: '百分数应用', points: ['增加百分之几'] },
    ],
    tips: ['每天 2~3 小时：先看例题，再做练习，最后订正'],
  });
  ok(!!good && good.days.length === 3, '正常输入 → 三组都在', good && good.days.length);
  ok(!!good && good.days[1].label === '第6-10天' && good.days[1].theme === '比和比例',
    '别名 key（day / topic）也认得出来');
  ok(!!good && good.days[1].points[0] === '按比例分配', 'items 可以当 points 用');
  ok(!!good && good.days[1].focus === '内项积 = 外项积', 'key 可以当 focus 用');
  ok(!!good && good.kind === 'plancard', 'kind 固定为 plancard');

  ok(chat.sanitizePlan(null) === null, 'null 输入 → null');
  ok(chat.sanitizePlan('不是对象') === null, '字符串输入 → null');
  ok(chat.sanitizePlan({ days: [] }) === null, '没有 days → null');
  ok(chat.sanitizePlan({ days: [{ theme: '只有一天' }] }) === null, '只有一组 → null（一列不叫计划）');
  ok(chat.sanitizePlan({ days: [{}, null, 'x', { theme: '有效' }] }) === null,
    '全是空壳组 → null（空壳不占列，也不该渲染出一张空表）');

  const many = chat.sanitizePlan({
    days: new Array(20).fill(0).map((_, i) => ({ label: '第' + (i + 1) + '天', theme: 'T' + i, points: new Array(9).fill('p') })),
    tips: new Array(9).fill('t'),
  });
  ok(!!many && many.days.length === chat.PLAN_LIMITS.days, '列数封顶（20 组 → ' + chat.PLAN_LIMITS.days + ' 组）', many && many.days.length);
  ok(!!many && many.days[0].points.length === chat.PLAN_LIMITS.points, '每组要点条数封顶', many && many.days[0].points.length);
  ok(!!many && many.tips.length === chat.PLAN_LIMITS.tips, '提醒条数封顶', many && many.tips.length);

  const longTwo = chat.sanitizePlan({
    title: '标'.repeat(200),
    days: [
      { label: '第1天'.repeat(20), theme: '主'.repeat(200), points: ['要'.repeat(200)], focus: '重'.repeat(200) },
      { label: '第2天', theme: '正常', points: ['ok'] },
    ],
    tips: ['提'.repeat(200)],
  });
  ok(!!longTwo && longTwo.title.length === chat.PLAN_LIMITS.title, '标题截断到上限', longTwo && longTwo.title.length);
  ok(!!longTwo && longTwo.days[0].theme.length === chat.PLAN_LIMITS.theme, '主题截断到上限');
  ok(!!longTwo && longTwo.days[0].points[0].length === chat.PLAN_LIMITS.point, '要点截断到上限');
  ok(!!longTwo && longTwo.days[0].focus.length === chat.PLAN_LIMITS.focus, '重点截断到上限');
  ok(!!longTwo && longTwo.days[0].label.length <= chat.PLAN_LIMITS.label, 'label 截断到上限');
  ok(!!longTwo && longTwo.tips[0].length === chat.PLAN_LIMITS.tip, '提醒截断到上限');

  const blob = JSON.stringify(good) + JSON.stringify(many) + JSON.stringify(longTwo);
  ok(!has(blob, 'NaN'), '★ 输出里不含 NaN');
  ok(!has(blob, 'undefined'), '★ 输出里不含 undefined');

  // ---------- ③ 提示词 ----------
  ok(has(chat.PLAN_PROMPT, 'plancard'), '提示词里写明了 kind=plancard');
  ok(has(chat.PLAN_PROMPT, '空话'), '★ 提示词明确禁止"空话"（否则模型会塞满"认真复习""巩固提高"）');
  ok(has(chat.PLAN_PROMPT, '不许自己编'), '★ 提示词要求不许编造答复里没有的内容');
  ok(has(chat.PLAN_PROMPT, '3~8'), '提示词给了列数范围');
  ok(has(chat.PLAN_PROMPT, 'focus'), '提示词定义了 focus（公式 / 易错点）字段');
  ok(!has(chat.PLAN_PROMPT, '不要出现任何文字'),
    '提示词不像生图那样禁止文字 —— 计划卡本来就要承载大量文字');

  // ---------- ④ 顺序（★ 本批最要紧的护栏）----------
  const iPlan = SERVER.indexOf('chat.shouldPlanCard(opt.text, full)');
  const iIllu = SERVER.indexOf('chat.shouldIllustrate(opt.text, full)');
  const iArt = SERVER.indexOf('chat.shouldConceptArt(opt.text, full)');
  ok(iPlan > 0 && iIllu > 0 && iArt > 0, '三档调用点都在', [iPlan, iIllu, iArt]);
  ok(iPlan < iIllu, '★★ 计划卡排在矢量示意图之前（否则会被"示意图"三个字抢走）', [iPlan, iIllu]);
  ok(iIllu < iArt, '矢量示意图排在 AI 生图之前（几何要画得准，不能外包给生图）', [iIllu, iArt]);

  // ---------- ⑤ 前端 ----------
  ok(has(SERVER, "send('art', { kind: 'plan' })"), '计划卡的 art 事件用 kind=plan');
  ok(has(SERVER, 'chat.attachArtifact'), '计划卡走 attachArtifact 挂回消息（刷新、换设备都还在）');
  ok(has(RENDER, 'function planCard('), 'render.js 有 planCard 渲染器');
  ok(has(RENDER, "kind === 'plancard' || kind === 'plan'"), 'svgFromJSON 的 dispatch 接上了 plancard');
  ok(has(RENDER, 'planCard: planCard'), 'planCard 已导出（app.js 要用同一个）');
  ok(has(RENDER, 'if (days.length < 2) return null;'), '前端也守一道：少于两列不渲染');
  ok(has(RENDER, 'Array.isArray(obj.days) && obj.days.length'), '没有 kind 但有 days 的也认（模型偶尔漏字段）');
  ok(has(APPJS, "att.mode === 'plan'"), 'app.js 的附件渲染认 mode=plan');
  ok(has(APPJS, 'HL.planCard(att.plan)'), 'app.js 调的就是 render.js 那个渲染器');
  ok(has(RENDER, 'esc(cut(d.label'), '★ 所有字段都过 HTML 转义（模型输出也是不可信输入）');

  ok(has(CSS, '.plan-grid') && has(CSS, '.plan-day') && has(CSS, '.plan-theme')
    && has(CSS, '.plan-pts') && has(CSS, '.plan-focus') && has(CSS, '.plan-tips'), '计划卡的样式齐了');
  ok(has(CSS, 'grid-template-columns: repeat(auto-fit'), '列宽自适应（窄屏自动折行，不用 JS 算）');
  const mw = CSS.match(/\.msg-att-illu\.art-plan-wrap \{ max-width: (\d+)px/);
  ok(!!mw && Number(mw[1]) >= 900, '计划卡比插画宽（多列才排得下）', mw && mw[1]);

  console.log('\n批次14（学习计划卡）：');
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  if (fail) { console.log('\n失败清单：'); fails.forEach(f => console.log('  ✗ ' + f)); }
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });

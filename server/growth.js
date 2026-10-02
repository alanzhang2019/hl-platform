'use strict';
/**
 * 7 阶段成长画像（批次22-③）
 *
 * 定位：把"测评中心"从"一次考试"升级为"你现在处在哪一段、下一步看什么"。
 *
 * ★ 三条必须守住的规矩（与日报/周报/家长端同源）：
 *  ① **不评分** —— 输出里没有 score / grade / level 这类字段，前端也不许自己拼一个。
 *     用户在本项目的核心主张是"唯一性决定方向"，用一个分数把人排序，
 *     恰恰是在鼓励"跟别人比"，与主张相反。
 *  ② **算不出来就说算不出来** —— 每个维度的 value 允许为 null；
 *     null 的含义是"这一类还没有数据可推"，与"0（有数据但确实是 0）"严格区分。
 *     前端渲染 null 时必须显式给"还看不出来"，不能画成 0 长度的条。
 *  ③ **不给外部激励** —— 阶段名不叫"青铜/白银/王者"，不给"打败了 X% 的同学"，
 *     不给排行。7 个阶段描述的是**认知动作的变化**（记得住 → 讲得出 → 用得上 …），
 *     不是"等级"。升级只说明"你能做更多种类的事了"。
 *
 * ★ 数据全部**现算**，不落库（与 weekly / parent 一致）：
 *   同一批原始记录（cards / card_reviews / exams / activity / conversations），
 *   每次都重新推。所以调这个接口连打多次结果必然一致，且改原始记录会立刻反映。
 *
 * ★ 输出是**结构化 JSON**，不含任何图形代码：
 *   · dimensions：6 个维度的 {key,label,value(null|0..100),raw,evidence,why}
 *   · stages：7 个阶段的 {index,name,desc,signals[],reached,why}
 *   · 前端拿这份 JSON 用**原生 SVG** 画雷达 + 阶梯。
 *   按项目约定：**绝不生成图片**。
 */
const D = require('./db');
const cards = require('./cards');
const exam = require('./exam');

/**
 * 7 个阶段。判据全部来自**可核对的原始事实**，不来自任何主观评价。
 * 每个阶段的 `check` 返回 {reached, why, evidence}：
 *   - reached：是否已具备"做这件事"的痕迹
 *   - why：给用户看的白话解释（必须能对上 evidence 里的数字）
 *   - evidence：指向原始记录的计数，便于前端点开看明细
 */
const STAGES = [
  {
    key: 'collect',
    name: '收下第一张卡',
    desc: '把遇到的东西变成一条自己的记录',
    check: s => ({
      reached: s.cards.total >= 1,
      why: s.cards.total >= 1
        ? '你已经收下 ' + s.cards.total + ' 张知识卡。'
        : '还没有收下任何知识卡 —— 先去对话里把今天遇到的东西变成一张卡。',
      evidence: { cards: s.cards.total },
    }),
  },
  {
    key: 'review',
    name: '回头复习',
    desc: '同一张卡，隔一段时间再看一次',
    check: s => ({
      reached: s.reviews.total >= 5,
      why: s.reviews.total >= 5
        ? '你一共复习了 ' + s.reviews.total + ' 次，说明你开始"回头"了。'
        : '目前复习了 ' + s.reviews.total + ' 次（满 5 次算走稳这一步）。',
      evidence: { reviews: s.reviews.total },
    }),
  },
  {
    key: 'hold',
    name: '记住了',
    desc: '同一张卡连续答对，档位真正往前推',
    check: s => ({
      reached: s.cards.mastered >= 1 || s.cards.almost >= 3,
      why: (s.cards.mastered + s.cards.almost) > 0
        ? '有 ' + s.cards.mastered + ' 张已经记牢、' + s.cards.almost + ' 张快到记牢了。'
        : '还没有卡进入"快记牢/已记牢"档 —— 这几张卡还都在认的阶段。',
      evidence: { mastered: s.cards.mastered, almost: s.cards.almost },
    }),
  },
  {
    key: 'judge',
    name: '判得出对错',
    desc: '有足够多"判得出对错"的练习，而不是全靠感觉',
    check: s => ({
      reached: s.reviews.judged >= 10,
      why: s.reviews.judged >= 10
        ? '有 ' + s.reviews.judged + ' 次练习是判得出对错的，这个量足够看出走势了。'
        : '判得出对错的练习只有 ' + s.reviews.judged + ' 次（满 10 次才够看走势）。',
      evidence: { judged: s.reviews.judged },
    }),
  },
  {
    key: 'explain',
    name: '讲得出为什么',
    desc: '不只答对，还能用自己的话把道理讲一遍',
    check: s => ({
      reached: s.reviews.solid >= 3,
      why: s.reviews.solid >= 3
        ? '有 ' + s.reviews.solid + ' 次理解核对拿到了「到位」，说明你讲得出为什么。'
        : '理解核对拿到「到位」的有 ' + s.reviews.solid + ' 次（满 3 次算走稳）。',
      evidence: { solid: s.reviews.solid },
    }),
  },
  {
    key: 'transfer',
    name: '换个问法还会',
    desc: '同一张卡在测评里被问到，答得出来',
    check: s => ({
      reached: s.exam.counted >= 8,
      why: s.exam.counted >= 8
        ? '你在测评里已经答了 ' + s.exam.counted + ' 道判得出对错的题 —— 说明换个问法你也接得住。'
        : '测评里判得出对错的题只有 ' + s.exam.counted + ' 道（满 8 道算走稳）。',
      evidence: { counted: s.exam.counted, exams: s.exam.exams },
    }),
  },
  {
    key: 'share',
    name: '拿得出手',
    desc: '把学过的东西讲给别人 / 放进项目，而不是只留在自己这儿',
    check: s => ({
      reached: s.share.shared >= 1 || s.share.projects >= 2,
      why: (s.share.shared + s.share.projects) > 0
        ? '你共享了 ' + s.share.shared + ' 张卡、建了 ' + s.share.projects + ' 个项目 —— 学的东西开始有自己的形状了。'
        : '还没有共享过卡、也没有成形的项目。这一步不着急，先把前面几步走稳。',
      evidence: { shared: s.share.shared, projects: s.share.projects },
    }),
  },
];

/** 6 个维度。value 一律 0..100 或 null（null = 这一类还没数据可推）。 */
function computeDimensions(s) {
  const dim = [];

  // ① 覆盖面：有多少卡进过复习（不是总卡数 —— 建了不复习的卡不算"学过"）
  dim.push({
    key: 'coverage',
    label: '碰过的范围',
    value: s.cards.total ? Math.round(s.cards.touched / s.cards.total * 100) : null,
    raw: { touched: s.cards.touched, total: s.cards.total },
    evidence: { kind: 'cards', ids: s.cards.touchedIds },
    why: s.cards.total
      ? (s.cards.touched + ' / ' + s.cards.total + ' 张卡至少复习过一次')
      : '还没有知识卡，算不出覆盖面',
  });

  // ② 记忆深度：进入"快记牢 / 已记牢"的比例
  dim.push({
    key: 'depth',
    label: '记牢的比例',
    value: s.cards.total ? Math.round((s.cards.mastered + s.cards.almost) / s.cards.total * 100) : null,
    raw: { mastered: s.cards.mastered, almost: s.cards.almost, total: s.cards.total },
    evidence: { kind: 'cards' },
    why: s.cards.total
      ? '其中 ' + s.cards.mastered + ' 张已记牢、' + s.cards.almost + ' 张快记牢'
      : '还没有知识卡，算不出记牢比例',
  });

  // ③ 判得准：答对比例（分母 = right + wrong，unknown 不计入 —— 全项目同一口径）
  dim.push({
    key: 'accuracy',
    label: '答得准',
    value: s.reviews.judged ? Math.round(s.reviews.right / s.reviews.judged * 100) : null,
    raw: { right: s.reviews.right, wrong: s.reviews.wrong, judged: s.reviews.judged },
    evidence: { kind: 'reviews', result: 'right' },
    why: s.reviews.judged
      ? ('判得出对错 ' + s.reviews.judged + ' 次，其中答对 ' + s.reviews.right + ' 次')
      : '还没有判得出对错的练习，算不出准不准',
  });

  // ④ 讲得出：理解核对拿到「到位」的次数占比（分母 = 做过理解核对的次数）
  dim.push({
    key: 'explain',
    label: '讲得清',
    value: s.reviews.verdicts ? Math.round(s.reviews.solid / s.reviews.verdicts * 100) : null,
    raw: { solid: s.reviews.solid, verdicts: s.reviews.verdicts },
    evidence: { kind: 'reviews', verdict: 'solid' },
    why: s.reviews.verdicts
      ? ('做过 ' + s.reviews.verdicts + ' 次理解核对，其中 ' + s.reviews.solid + ' 次拿到「到位」')
      : '还没有做过理解核对，算不出讲不讲得清',
  });

  // ⑤ 稳定度：复习跨度（days）：卡在多少天之后还记得
  dim.push({
    key: 'stability',
    label: '记得久',
    value: s.cards.maxSpanDays,
    raw: { maxSpanDays: s.cards.maxSpanDays, avgSpanDays: s.cards.avgSpanDays },
    evidence: { kind: 'cards' },
    why: s.cards.maxSpanDays === null
      ? '还没有卡进入过间隔复习，算不出"能记多久"'
      : ('最长的一张卡隔 ' + s.cards.maxSpanDays + ' 天还记得'),
  });

  // ⑥ 系统度：项目 / 共享 —— 知识有没有连成片
  dim.push({
    key: 'system',
    label: '连成片',
    value: (s.share.projects + s.share.shared) ? Math.min(100, (s.share.projects * 20 + s.share.shared * 25)) : null,
    raw: { projects: s.share.projects, shared: s.share.shared },
    evidence: { kind: 'projects' },
    why: (s.share.projects + s.share.shared)
      ? ('归入项目 ' + s.share.projects + ' 处、共享 ' + s.share.shared + ' 张卡')
      : '还没有把学过的东西归入项目或共享出去',
  });

  return dim;
}

/** 收集所有原始事实。全部现算，不读任何快照表。 */
function gather(spaceId) {
  const now = D.now();

  const cardsS = cards.summary(spaceId);

  // 复习总览（含 unknown 的口径：judged = right + wrong）
  // ★ 别名不能叫 right / left —— 它们是 SQL 关键字（RIGHT JOIN），无引号会直接语法错。
  //   实测在 sqlite 上报 "near \"right\": syntax error"。
  const rv = D.get(`SELECT
      COUNT(*) total,
      SUM(CASE WHEN result='right' THEN 1 ELSE 0 END) right_n,
      SUM(CASE WHEN result='wrong' THEN 1 ELSE 0 END) wrong_n,
      SUM(CASE WHEN result='unknown' THEN 1 ELSE 0 END) unknown_n
    FROM card_reviews r JOIN cards c ON c.id = r.card_id WHERE c.space_id = ?`, spaceId) || {};

  // 理解核对：ai_verdict 存在 card_reviews 上（solid | partial | off | unknown，也可为 null）
  // ★ 列名是 ai_verdict，不是 verdict —— 表里另有 verdict_json 存明细。
  const vd = D.get(`SELECT
      SUM(CASE WHEN r.ai_verdict IS NOT NULL AND r.ai_verdict != '' THEN 1 ELSE 0 END) verdicts,
      SUM(CASE WHEN r.ai_verdict='solid' THEN 1 ELSE 0 END) solid
    FROM card_reviews r JOIN cards c ON c.id = r.card_id WHERE c.space_id = ?`, spaceId) || {};

  // 碰过的卡（至少复习过一次）
  const touched = D.get(`SELECT COUNT(DISTINCT r.card_id) c
    FROM card_reviews r JOIN cards c ON c.id = r.card_id WHERE c.space_id = ?`, spaceId) || {};
  const touchedIds = D.all(`SELECT DISTINCT r.card_id id
    FROM card_reviews r JOIN cards c ON c.id = r.card_id WHERE c.space_id = ?
    ORDER BY r.card_id LIMIT 60`, spaceId).map(x => x.id);

  // 复习跨度：对每张卡求"最早一次复习"到"最近一次复习"的天数，取最大值
  // ★ 只有一次复习的卡 span = 0 天（不是 null）：它确实"当天还记得"。
  //   完全没有复习的卡才不进这个统计 —— 那才是"算不出来"。
  const spanRows = D.all(`SELECT r.card_id,
      MIN(r.reviewed_at) mn, MAX(r.reviewed_at) mx, COUNT(*) n
    FROM card_reviews r JOIN cards c ON c.id = r.card_id
    WHERE c.space_id = ? GROUP BY r.card_id`, spaceId);
  let maxSpanDays = null, spanSum = 0, spanN = 0;
  spanRows.forEach(r => {
    const d = Math.floor((r.mx - r.mn) / 86400000);
    if (maxSpanDays === null || d > maxSpanDays) maxSpanDays = d;
    spanSum += d; spanN++;
  });
  const avgSpanDays = spanN ? Math.round(spanSum / spanN) : null;

  // 测评：判得出对错的题数（unknown 不算）
  const ex = D.get(`SELECT COUNT(*) c FROM exams WHERE space_id = ? AND status = 'submitted'`, spaceId) || {};
  const exScore = D.all(`SELECT score_json FROM exams WHERE space_id = ? AND status = 'submitted'`, spaceId);
  let exCounted = 0, exRight = 0, exUnknown = 0;
  exScore.forEach(r => {
    let sc = null;
    try { sc = r.score_json ? JSON.parse(r.score_json) : null; } catch (e) {}
    if (!sc) return;
    exCounted += Number(sc.counted) || 0;
    exRight += Number(sc.right) || 0;
    exUnknown += Number(sc.unknown) || 0;
  });

  // 项目 / 共享（cards 表没有 shared 列 —— 共享走的是 pool_items 的 status=active）
  const proj = D.get(`SELECT COUNT(*) c FROM projects WHERE space_id = ?`, spaceId) || {};
  const shared = D.get(`SELECT COUNT(*) c FROM pool_items WHERE space_id = ? AND status = 'active'`, spaceId) || {};

  return {
    cards: {
      total: cardsS.total, mastered: cardsS.mastered, almost: cardsS.almost,
      learning: cardsS.learning, retired: cardsS.retired,
      touched: touched.c || 0, touchedIds: touchedIds,
      maxSpanDays: maxSpanDays, avgSpanDays: avgSpanDays,
    },
    reviews: {
      total: rv.total || 0,
      right: rv.right_n || 0,
      wrong: rv.wrong_n || 0,
      unknown: rv.unknown_n || 0,
      // ★ judged 的分母口径：right + wrong，unknown 不计入（与 daily/weekly/parent 逐字一致）
      judged: (rv.right_n || 0) + (rv.wrong_n || 0),
      verdicts: vd.verdicts || 0,
      solid: vd.solid || 0,
    },
    exam: { exams: ex.c || 0, counted: exCounted, right: exRight, unknown: exUnknown },
    share: { projects: proj.c || 0, shared: shared.c || 0 },
    now: now,
  };
}

/**
 * 生成画像。
 * ★ 返回结构里**没有** score / grade / rank 字段 —— 这是刻意的，测试会钉死。
 */
function portrait(spaceId) {
  const s = gather(spaceId);
  const dimensions = computeDimensions(s);
  const stages = STAGES.map((st, i) => {
    const r = st.check(s);
    return {
      index: i + 1, key: st.key, name: st.name, desc: st.desc,
      reached: !!r.reached, why: r.why, evidence: r.evidence,
    };
  });
  let current = 0;                              // 已经走完第几个
  stages.forEach(st => { if (st.reached) current = st.index; });
  const nextStage = stages.filter(st => !st.reached)[0] || null;

  // 可推的维度里取平均 —— 但**只作为"已经能看出来的部分"的概览**，不叫分数。
  const known = dimensions.filter(d => d.value !== null);
  const overview = known.length ? Math.round(known.reduce((a, d) => a + d.value, 0) / known.length) : null;

  return {
    stages: stages,
    currentStage: current,
    nextStage: nextStage ? { index: nextStage.index, key: nextStage.key, name: nextStage.name, desc: nextStage.desc, why: nextStage.why } : null,
    dimensions: dimensions,
    overview: overview,
    // ★ 明确告诉前端"哪些维度算不出来" —— 前端要原样显示，不许补 0
    unknownDimensions: dimensions.filter(d => d.value === null).map(d => d.key),
    // ★ 不评分要给出**结构化**理由（不是散文），与 notScored() 同规矩
    notScored: [
      {
        title: '为什么这里没有一个"总分"',
        why: '把六件事压成一个数，就等于说"讲得清"和"收得多"可以互相换算 —— 那是我们不知道的事。分开看才能看出该补哪一块。',
      },
      {
        title: '为什么阶段名不带"等级感"',
        why: '这 7 步描述的是「你现在能做哪些种类的动作」，不是"你比别人高几级"。所以我们不叫青铜/王者，也不显示任何百分比排名。',
      },
      {
        title: '算不出来的那几项',
        why: dimensions.filter(d => d.value === null).length
          ? ('有 ' + dimensions.filter(d => d.value === null).length + ' 项现在还算不出来（' +
             dimensions.filter(d => d.value === null).map(d => d.label).join('、') +
             '）—— 它们显示为「还看不出来」，而不是 0。')
          : '六项现在都算得出来。',
      },
      {
        title: '这里不排名、不比较',
        why: '画像只跟"上个月的我"比。我们不做任何跨用户排行 —— 那会让学习变成"看谁跑得快"。',
      },
    ],
    limits: [
      '这里只统计「这个空间里留下痕迹的事」，你在别处学的东西这里看不到。',
      '六个维度不是互相可换算的，不允许加总成一个"总分"。',
      '每个维度的数字都能点开看原始记录；如果你觉得哪个数不对，以原始记录为准。',
    ],
  };
}

module.exports = { portrait, STAGES, gather };

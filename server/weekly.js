'use strict';
/**
 * 学习周报
 *
 * 继承日报三条硬规矩：
 * 1. **系统侧的事实不落库，每次现算。**
 *    周报没有自己的表；所有数字都从 daily.facts() 现算出来。
 * 2. **算不出来就说算不出来，不许补零。**
 * 3. **不评分。**
 *
 * 周报 = 把一段日期范围内每天的「事实层」汇总，重新组织视角。
 * 它不做新的事实，只做「覆盖与合计」。
 */
const D = require('./db');
const daily = require('./daily');

const DAY = 24 * 60 * 60 * 1000;
const MAX_DAYS = 7;

/**
 * ★ 与上一个同长窗口的对比（批次22-②）。
 *
 * 三条必须守住的规矩：
 *  ① **不落库** —— 每次现算。上一个窗口的数字同样来自 daily.facts，不存快照。
 *  ② **null 不许当 0 比** —— accuracy 是"判得出对错才有比例"。
 *     本周 null 或上周 null 时，delta **必须是 null**，并给出 why；
 *     把 null 当 0 算差会得出"从 0% 涨到 50%"这种凭空捏造的结论。
 *  ③ **不评好坏** —— 只给 direction（up/down/flat），不给红绿、不给"进步/退步"。
 *     记录多不等于学得好（这条写在 limits 里），所以"多"不是"好"，
 *     前端也刻意不做颜色箭头（那是打分，家长端也不做）。
 *
 * 上一个窗口 = 与本周**等长**、紧挨着在它前面的那一段。
 * 不用"自然周"是因为用户可能选任意 7 天窗口，等长紧邻才是唯一正确的对照。
 */
function compareWindows(spaceId, fromTs, toTs) {
  const len = Math.round((toTs - fromTs) / DAY) + 1;
  const prevToTs = fromTs - DAY;
  const prevFromTs = prevToTs - (len - 1) * DAY;

  const collect = (a, b) => {
    const list = [];
    let cur = a;
    while (cur <= b) { list.push(daily.facts(spaceId, daily.dayKey(cur))); cur += DAY; }
    return computeSummary(list);
  };

  const cur = collect(fromTs, toTs);
  const prev = collect(prevFromTs, prevToTs);

  /** delta 的安全算法：任一侧为 null ⇒ 老实说"没法比"，不给数字 */
  const d = (cv, pv) => {
    if (cv === null || cv === undefined || pv === null || pv === undefined) {
      return { delta: null, direction: 'unknown', why: '上一次这个数算不出来，没法比' };
    }
    const delta = cv - pv;
    return { delta, direction: delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat', why: null };
  };

  const metrics = {
    records: Object.assign({ this: cur.records, last: prev.records }, d(cur.records, prev.records)),
    reviews: Object.assign({ this: cur.reviews, last: prev.reviews }, d(cur.reviews, prev.reviews)),
    accuracy: Object.assign({ this: cur.accuracy, last: prev.accuracy }, d(cur.accuracy, prev.accuracy)),
    cardsTouched: Object.assign({ this: cur.cardsTouched, last: prev.cardsTouched }, d(cur.cardsTouched, prev.cardsTouched)),
  };
  // 有一个指标的 delta 是 null（没得比）就在顶层标一下，前端好统一提示
  const comparable = Object.keys(metrics).every(k => metrics[k].delta !== null);

  return {
    prevFrom: daily.dayKey(prevFromTs),
    prevTo: daily.dayKey(prevToTs),
    daysCount: len,
    metrics,
    comparable,
    // ★ 每个 delta 都带一句"这个数只说明什么"，避免"多了就是好"的误读
    note: '对比只看"痕迹的多少"，不说明学得好坏 —— 记录多了可能只是这周多记了几笔。',
  };
}

function build(spaceId, from, to) {
  const fromTs = daily.parseDay(from);
  const toTs = daily.parseDay(to);
  if (!fromTs || !toTs) throw new Error('invalid_range');
  if (toTs < fromTs) throw new Error('invalid_range');

  const rangeDays = Math.round((toTs - fromTs) / DAY) + 1;
  if (rangeDays > MAX_DAYS) throw new Error('range_too_long');

  const days = [];
  const factsList = [];
  let current = fromTs;
  while (current <= toTs) {
    const date = daily.dayKey(current);
    const f = daily.facts(spaceId, date);
    factsList.push(f);
    const rec = daily.getReport(spaceId, date);
    days.push({
      date,
      hasRecord: f.counts.records > 0,
      headline: f.counts.records > 0
        ? '留下 ' + f.counts.records + ' 条记录。'
        : '今天还没有留下任何记录。',
      keyMetrics: daily.metrics(f).map(m => ({
        key: m.key, label: m.label, value: m.value, unit: m.unit, unknown: m.unknown,
      })),
      answers: rec ? rec.answers : {},
      status: rec ? rec.status : 'none',
    });
    current += DAY;
  }

  const summary = computeSummary(factsList);
  const coverage = computeCoverage(factsList);

  return {
    from, to, daysCount: days.length,
    isCurrentWeek: isCurrentWeek(fromTs, toTs),
    summary,
    coverage,
    compare: compareWindows(spaceId, fromTs, toTs),
    days,
    notScored: weeklyNotScored(factsList),
    limits: weeklyLimits(),
  };
}

function computeSummary(list) {
  let totalRecords = 0;
  let totalReviews = 0;
  let totalRight = 0;
  let totalWrong = 0;
  let totalJudged = 0;
  let totalSpan = 0;
  let daysWithRecord = 0;
  const allTouched = new Set();
  const stuckMap = {};
  const subjectMap = {};

  list.forEach(f => {
    const c = f.counts;
    totalRecords += c.records;
    totalReviews += c.reviews;
    totalRight += f.right;
    totalWrong += f.wrong;
    if (f.right + f.wrong > 0) totalJudged += f.right + f.wrong;
    if (f.span !== null) totalSpan += f.span;
    if (c.records > 0) daysWithRecord++;

    f.revs.forEach(r => { allTouched.add(r.cardId); });

    // 卡住的卡：跨多天累计 wrongs（不是"同一天内"，周报看的是这周整体）
    f.revs.forEach(r => {
      if (r.result === 'wrong') {
        if (!stuckMap[r.cardId]) {
          stuckMap[r.cardId] = { cardId: r.cardId, knowledge: r.knowledge, wrongs: 0, ids: [] };
        }
        stuckMap[r.cardId].wrongs++;
        stuckMap[r.cardId].ids.push(r.id);
      }
    });

    f.revs.forEach(r => {
      const sub = r.subject || '未分类';
      if (!subjectMap[sub]) subjectMap[sub] = { subject: sub, reviews: 0, right: 0, wrong: 0 };
      subjectMap[sub].reviews++;
      if (r.result === 'right') subjectMap[sub].right++;
      else if (r.result === 'wrong') subjectMap[sub].wrong++;
    });
  });

  const accuracy = totalJudged ? Math.round(totalRight / totalJudged * 100) : null;
  const stuckList = Object.values(stuckMap).filter(x => x.wrongs >= 2).sort((a, b) => b.wrongs - a.wrongs);

  return {
    records: totalRecords,
    reviews: totalReviews,
    accuracy,
    right: totalRight,
    wrong: totalWrong,
    judged: totalJudged,
    cardsTouched: allTouched.size,
    daysWithRecord,
    totalSpanMinutes: totalSpan || null,
    spanDays: list.filter(f => f.span !== null).length,
    stuckCount: stuckList.length,
    stuckCards: stuckList.slice(0, 5),
    subjects: Object.values(subjectMap).sort((a, b) => b.reviews - a.reviews),
  };
}

function computeCoverage(list) {
  const cardMap = {};
  list.forEach(f => {
    f.revs.forEach(r => {
      if (!cardMap[r.cardId]) {
        cardMap[r.cardId] = { cardId: r.cardId, knowledge: r.knowledge, subject: r.subject, results: [] };
      }
      cardMap[r.cardId].results.push(r.result);
    });
  });

  const cards = Object.values(cardMap);
  const bySubject = {};
  cards.forEach(c => {
    const sub = c.subject || '未分类';
    if (!bySubject[sub]) bySubject[sub] = { subject: sub, count: 0 };
    bySubject[sub].count++;
  });

  return {
    totalCards: cards.length,
    bySubject: Object.values(bySubject).sort((a, b) => b.count - a.count),
  };
}

function weeklyNotScored(list) {
  const totalUnknown = list.reduce((s, f) => s + f.unknown, 0);
  const totalJudged = list.reduce((s, f) => s + f.right + f.wrong, 0);
  return [
    {
      title: '为什么这里没有分数',
      why: '周报和日报一样，只摆事实。分数会把"这周没答对"变成"你不行"，而我们不知道这张卡是不是刚到该记住的时候。',
    },
    {
      title: '只统计能对上原话的',
      why: totalUnknown
        ? '本周有 ' + totalUnknown + ' 次 AI 判不了对错，这几次「没有」计入对错，也没有被当成错。'
        : '本周所有练习都判得出对错。',
    },
    {
      title: '数字不等于掌握',
      why: '跨多天的对错只是"留下痕迹"，不是"已经掌握"。真正看掌握要跟踪知识卡的状态推进。',
    },
    {
      title: '算不出来就说算不出来',
      why: '某天没有记录时，那天的数字会显示「暂不能确定」，而不是补 0。周报在汇总时尊重这一点。',
    },
  ];
}

function weeklyLimits() {
  return [
    '周报只统计「这个空间里发生过的事」，你在别处学的东西这里看不到。',
    '记录条数多不等于学得好，少也不等于没学 —— 它只说明"这里留下了多少痕迹"。',
    '所有数字都可以点开看原始记录；如果你觉得哪个数不对，以原始记录为准。',
    '周报是"回顾"不是"考核"—— 它的用途是帮你看清楚这周的走势，不是用来打分的。',
  ];
}

function isCurrentWeek(fromTs, toTs) {
  const now = D.now();
  const nowDay = daily.dayKey(now);
  const nowTs = daily.parseDay(nowDay);
  return fromTs <= nowTs && nowTs <= toTs;
}

// ============================================================================
// 历史周报（批次22）：存取「人写的那段」+ 数字逐项溯源
// ============================================================================
// ★ 这一段的唯一职责是**存取人写的内容**。任何汇总数字都不从这里出 ——
//   它们一律由 build() 现算。见文件头三条硬规矩，以及 db.js 里 weekly_reports 的注释。

/** 人写的那两问。刻意不是四问：周报的粒度是"一周"，把日报的四问抄过来会逼人写四遍一样的话。 */
const WEEK_QUESTIONS = [
  { key: 'noticed', label: '这周我注意到什么', hint: '哪一天、哪件事让你觉得"哦，原来是这样"' },
  { key: 'next', label: '下周想试什么', hint: '一个小小的、你真的会去做的事' },
];
const WEEK_KEYS = WEEK_QUESTIONS.map(q => q.key);
const WEEK_ANSWER_MAX = 2000;

/** 把 (from,to) 规范化成一段合法周并将它作为主键的一部分。非法就抛，不猜。 */
function normRange(from, to) {
  const fromTs = daily.parseDay(from);
  const toTs = daily.parseDay(to);
  if (!fromTs || !toTs) throw new Error('invalid_range');
  if (toTs < fromTs) throw new Error('invalid_range');
  const days = Math.round((toTs - fromTs) / DAY) + 1;
  if (days > MAX_DAYS) throw new Error('range_too_long');
  return { from: daily.dayKey(fromTs), to: daily.dayKey(toTs) };
}

/**
 * ★ 数字逐项溯源：把 summary 里的某个数字拆回它背后的原始记录。
 * 汇总口径必须与 computeSummary() **逐字对齐** —— 否则会出现"谁都不算错但对不上"的假红。
 * 返回的每一条都带 date，这样前端能指出"这个数是哪几天凑出来的"。
 */
function evidenceByMetric(spaceId, from, to, metric) {
  const r = normRange(from, to);
  const metricKey = String(metric || '').toLowerCase();

  // 逐天取 facts，再按 metric 决定从每天里取什么
  const days = [];
  let cur = daily.parseDay(r.from);
  const end = daily.parseDay(r.to);
  while (cur <= end) {
    const date = daily.dayKey(cur);
    days.push({ date: date, f: daily.facts(spaceId, date) });
    cur += DAY;
  }

  const items = [];
  if (metricKey === 'reviews' || metricKey === 'accuracy' || metricKey === 'right' || metricKey === 'wrong') {
    // 这四项同源：都指向 card_reviews。accuracy 只取判得出对错的，与分母口径一致。
    days.forEach(d => {
      d.f.revs.forEach(rv => {
        if (metricKey === 'right' && rv.result !== 'right') return;
        if (metricKey === 'wrong' && rv.result !== 'wrong') return;
        if (metricKey === 'accuracy' && rv.result === 'unknown') return;
        items.push({
          date: d.date, kind: 'review', id: rv.id, cardId: rv.cardId,
          knowledge: rv.knowledge, subject: rv.subject, result: rv.result, time: rv.time,
        });
      });
    });
  } else if (metricKey === 'records') {
    days.forEach(d => {
      // activity 的原始 id 链在 facts 的 evidence 里，按天取回
      const ev = (daily.metrics(d.f).filter(m => m.key === 'records')[0] || {}).evidence;
      if (!ev || !ev.ids || !ev.ids.length) return;
      const got = daily.evidenceByIds(spaceId, d.date, ev.kind, ev.ids);
      (got.items || []).forEach(it => items.push(Object.assign({ date: d.date }, it)));
    });
  } else if (metricKey === 'cards' || metricKey === 'coverage') {
    // 覆盖：本周碰过的每一张卡只出现一次（与 computeCoverage 的去重口径一致）
    const seen = {};
    days.forEach(d => {
      d.f.revs.forEach(rv => {
        if (seen[rv.cardId]) return;
        seen[rv.cardId] = true;
        items.push({
          date: d.date, kind: 'card', id: rv.cardId, cardId: rv.cardId,
          knowledge: rv.knowledge, subject: rv.subject,
        });
      });
    });
  } else {
    throw new Error('unknown_metric');
  }

  return {
    metric: metricKey,
    from: r.from, to: r.to,
    count: items.length,
    items: items.slice(0, 300),
    truncated: items.length > 300,
  };
}

// ---------- 存取（只存"人写的那部分"）----------

function getNote(spaceId, from, to) {
  const r = normRange(from, to);
  const row = D.get('SELECT * FROM weekly_reports WHERE space_id = ? AND week_from = ? AND week_to = ?',
    spaceId, r.from, r.to);
  if (!row) return null;
  let answers = {};
  try { answers = row.answers_json ? JSON.parse(row.answers_json) : {}; } catch (e) {}
  return {
    id: row.id, from: row.week_from, to: row.week_to, status: row.status,
    answers: answers, updatedAt: row.updated_at, finalizedAt: row.finalized_at,
  };
}

function saveDraft(spaceId, from, to, answers) {
  const r = normRange(from, to);
  const src = answers && typeof answers === 'object' ? answers : {};
  const clean = {};
  WEEK_KEYS.forEach(k => { if (typeof src[k] === 'string') clean[k] = src[k].slice(0, WEEK_ANSWER_MAX); });

  const existing = D.get('SELECT id, status FROM weekly_reports WHERE space_id = ? AND week_from = ? AND week_to = ?',
    spaceId, r.from, r.to);
  const now = D.now();
  if (existing) {
    // ★ 已定稿的周报不再接受草稿覆盖 —— 与日报同规矩：定稿是"当时写的"，不该被后来改写。
    if (existing.status === 'final') return getNote(spaceId, r.from, r.to);
    D.run('UPDATE weekly_reports SET answers_json = ?, updated_at = ? WHERE id = ?',
      JSON.stringify(clean), now, existing.id);
  } else {
    D.run('INSERT INTO weekly_reports(id,space_id,week_from,week_to,status,answers_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)',
      D.uid('wr_'), spaceId, r.from, r.to, 'draft', JSON.stringify(clean), now, now);
  }
  return getNote(spaceId, r.from, r.to);
}

function finalize(spaceId, from, to, answers) {
  const r = normRange(from, to);
  if (answers && typeof answers === 'object') saveDraft(spaceId, r.from, r.to, answers);
  const existing = D.get('SELECT id FROM weekly_reports WHERE space_id = ? AND week_from = ? AND week_to = ?',
    spaceId, r.from, r.to);
  const now = D.now();
  if (!existing) {
    D.run('INSERT INTO weekly_reports(id,space_id,week_from,week_to,status,answers_json,created_at,updated_at,finalized_at) VALUES(?,?,?,?,?,?,?,?,?)',
      D.uid('wr_'), spaceId, r.from, r.to, 'final', '{}', now, now, now);
  } else {
    D.run('UPDATE weekly_reports SET status = ?, updated_at = ?, finalized_at = ? WHERE id = ?',
      'final', now, now, existing.id);
  }
  return getNote(spaceId, r.from, r.to);
}

/**
 * 历史周报列表。只列**有内容或已定稿**的，并且**排除"当前正在看的那一周"**。
 *
 * ★ 为什么必须排除当前周：这一块在界面上叫「以前的周报」。
 *   把正在编辑的这一周也列进去，用户会看到"以前的周报"里有他刚刚在写的东西 ——
 *   文案与内容不符，而且他点进去会从"编辑态"跳回"编辑态"（看起来像没反应）。
 *   判据是 `to === 今天`：一段区间只要能到今天就说明它包含当下，不算"以前"。
 *
 * 每项还带上那段日期的关键合计 —— 但**这些数字是现算的**，不来自表里任何一列。
 */
function history(spaceId, limit) {
  const n = Math.max(1, Math.min(60, Number(limit) || 26));
  const today = daily.dayKey(D.now());
  const rows = D.all(
    `SELECT week_from, week_to, status, answers_json, updated_at, finalized_at
     FROM weekly_reports WHERE space_id = ? AND week_to < ? ORDER BY week_to DESC LIMIT ?`,
    spaceId, today, n);
  return rows.map(row => {
    let a = {};
    try { a = row.answers_json ? JSON.parse(row.answers_json) : {}; } catch (e) {}
    const filled = WEEK_KEYS.filter(k => a[k] && a[k].trim()).length;
    // 数字现算：只给两个最能说明"那周有没有东西"的，不给整份 summary（那是 build 的活）
    const built = build(spaceId, row.week_from, row.week_to);
    return {
      from: row.week_from, to: row.week_to, status: row.status,
      filled: filled, updatedAt: row.updated_at, finalizedAt: row.finalized_at,
      records: built.summary.records,
      reviews: built.summary.reviews,
      accuracy: built.summary.accuracy,
      answers: a,
    };
  });
}

module.exports = {
  build, history, getNote, saveDraft, finalize, evidenceByMetric, compareWindows,
  WEEK_QUESTIONS, WEEK_KEYS, MAX_DAYS,
};

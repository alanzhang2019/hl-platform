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

    f.stuck.forEach(s => {
      const existing = stuckMap[s.cardId];
      if (!existing || existing.wrongs < s.wrongs) {
        stuckMap[s.cardId] = { cardId: s.cardId, knowledge: s.knowledge, wrongs: s.wrongs, ids: s.ids };
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
  const stuckList = Object.values(stuckMap).sort((a, b) => b.wrongs - a.wrongs);

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

module.exports = { build };

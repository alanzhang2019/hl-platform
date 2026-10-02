'use strict';
/**
 * 看板（P5）：把"先量后定"做成能看见的东西
 *
 * 立场：不做"学习时长排行"，不做"连续打卡 N 天"的焦虑型指标。
 * 只呈现三类事实：
 *   1. 这周比上周多做了还是少做了（量）
 *   2. 哪些知识点反复没答对（这是"该补哪里"的答案）
 *   3. 知识卡的状态分布是怎么移动的（掌握是迁移，不是积累）
 */
const D = require('./db');
const cards = require('./cards');

const DAY = 24 * 60 * 60 * 1000;

function dayKey(ts) {
  const d = new Date(ts);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function startOfDay(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** 逐日活动曲线 */
function curve(spaceId, days) {
  const n = Math.max(1, Math.min(60, Number(days) || 14));
  const today = startOfDay(D.now());
  const from = today - (n - 1) * DAY;
  const rows = D.all('SELECT kind, at FROM activity WHERE space_id = ? AND at >= ?', spaceId, from);
  const buckets = {};
  for (let i = 0; i < n; i++) {
    const t = from + i * DAY;
    buckets[dayKey(t)] = { date: dayKey(t), at: t, chat: 0, card_review: 0, card_created: 0, kb_upload: 0, total: 0 };
  }
  rows.forEach(r => {
    const k = dayKey(r.at);
    if (!buckets[k]) return;
    buckets[k][r.kind] = (buckets[k][r.kind] || 0) + 1;
    buckets[k].total++;
  });
  return Object.keys(buckets).sort().map(k => buckets[k]);
}

/** 连续有活动的天数（含今天；今天还没动就从昨天往前数） */
function streak(spaceId) {
  const days = D.all('SELECT DISTINCT at FROM activity WHERE space_id = ? ORDER BY at DESC LIMIT 400', spaceId)
    .map(r => startOfDay(r.at));
  const set = {};
  days.forEach(d => { set[d] = 1; });
  const today = startOfDay(D.now());
  let cur = set[today] ? today : today - DAY;
  let n = 0;
  while (set[cur] && n < 400) { n++; cur -= DAY; }
  return { days: n, activeToday: !!set[today] };
}

/** 反复没答对的知识点 —— 这才是"该补哪里" */
function weakPoints(spaceId, limit) {
  const rows = D.all(`
    SELECT c.id, c.knowledge, c.status, c.stage,
           SUM(CASE WHEN r.result = 'wrong' THEN 1 ELSE 0 END) AS wrongs,
           COUNT(r.id) AS reviews
    FROM cards c LEFT JOIN card_reviews r ON r.card_id = c.id
    WHERE c.space_id = ?
    GROUP BY c.id
    HAVING wrongs > 0
    ORDER BY wrongs DESC, reviews DESC
    LIMIT ?`, spaceId, Math.max(1, Math.min(20, Number(limit) || 5)));
  return rows.map(r => ({
    id: r.id, knowledge: r.knowledge, status: r.status, stage: r.stage,
    wrongs: r.wrongs, reviews: r.reviews,
    wrongRate: r.reviews ? Math.round(r.wrongs / r.reviews * 100) : 0,
  }));
}

/** 掌握迁移：本周期内每张卡的状态移动 */
function movement(spaceId, days) {
  const from = D.now() - (Number(days) || 7) * DAY;
  const rows = D.all('SELECT result, COUNT(*) c FROM card_reviews WHERE reviewed_at >= ? AND card_id IN (SELECT id FROM cards WHERE space_id = ?) GROUP BY result', from, spaceId);
  const by = { right: 0, wrong: 0, unknown: 0 };
  rows.forEach(r => { by[r.result] = r.c; });
  const total = by.right + by.wrong + by.unknown;
  const advanced = D.get(`
    SELECT COUNT(*) c FROM (
      SELECT card_id, MAX(reviewed_at) t FROM card_reviews
      WHERE reviewed_at >= ? AND card_id IN (SELECT id FROM cards WHERE space_id = ?)
      GROUP BY card_id
    )`, from, spaceId);
  return {
    reviews: total, right: by.right, wrong: by.wrong, unknown: by.unknown,
    touchedCards: (advanced || {}).c || 0,
    accuracy: total ? Math.round(by.right / total * 100) : 0,
  };
}

/** 本周 vs 上周 */
function compare(spaceId) {
  const today = startOfDay(D.now());
  const weekAgo = today - 6 * DAY;
  const twoWeeksAgo = today - 13 * DAY;
  const g = (from, to) => {
    const r = D.get('SELECT COUNT(*) c FROM activity WHERE space_id = ? AND at >= ? AND at < ?', spaceId, from, to);
    return (r || {}).c || 0;
  };
  const thisWeek = g(weekAgo, D.now() + 1);
  const lastWeek = g(twoWeeksAgo, weekAgo);
  return {
    thisWeek, lastWeek,
    delta: thisWeek - lastWeek,
    direction: thisWeek > lastWeek ? 'up' : thisWeek < lastWeek ? 'down' : 'flat',
  };
}

function totals(spaceId) {
  const s = cards.summary(spaceId);
  const conv = D.get('SELECT COUNT(*) c FROM conversations WHERE space_id = ?', spaceId) || {};
  const docs = D.get('SELECT COUNT(*) c FROM kb_documents WHERE space_id = ? AND status = ?', spaceId, 'ready') || {};
  const mem = D.get('SELECT COUNT(*) c FROM memories WHERE space_id = ?', spaceId) || {};
  return {
    conversations: conv.c || 0,
    cards: s.total, due: s.due,
    learning: s.learning, almost: s.almost, mastered: s.mastered, retired: s.retired,
    documents: docs.c || 0,
    memories: mem.c || 0,
  };
}

function recent(spaceId, limit) {
  return D.all('SELECT kind, ref_id, meta_json, at FROM activity WHERE space_id = ? ORDER BY at DESC LIMIT ?',
    spaceId, Math.max(1, Math.min(50, Number(limit) || 12)))
    .map(r => {
      let meta = null;
      try { meta = r.meta_json ? JSON.parse(r.meta_json) : null; } catch (e) {}
      return { kind: r.kind, refId: r.ref_id, meta: meta, at: r.at };
    });
}

function dashboard(spaceId, opts) {
  const o = opts || {};
  const days = Number(o.days) || 14;
  const c = curve(spaceId, days);
  const active = c.filter(d => d.total > 0).length;
  return {
    range: { days: days, from: c.length ? c[0].date : '', to: c.length ? c[c.length - 1].date : '' },
    curve: c,
    activeDays: active,
    streak: streak(spaceId),
    compare: compare(spaceId),
    movement: movement(spaceId, 7),
    weakPoints: weakPoints(spaceId, o.weakLimit || 5),
    totals: totals(spaceId),
    recent: recent(spaceId, 10),
  };
}

/**
 * 文字版小结（日报/周报）。
 * 规则化生成，不调模型 —— 数字必须可核对，不能让模型"润色"出不存在的事实。
 */
function report(spaceId, period) {
  const p = period === 'week' ? 'week' : 'day';
  const d = dashboard(spaceId, { days: p === 'week' ? 7 : 1 });
  const t = d.totals;
  const lines = [];
  if (p === 'week') {
    const dir = d.compare.direction === 'up' ? '比上周多' : d.compare.direction === 'down' ? '比上周少' : '和上周一样';
    lines.push(`这一周一共留下 ${d.compare.thisWeek} 条学习记录，${dir} ${Math.abs(d.compare.delta)} 条。`);
    lines.push(`其中练了 ${d.movement.reviews} 次知识卡，答对 ${d.movement.right} 次、没答对 ${d.movement.wrong} 次，${d.movement.unknown} 次没法判断（不计入对错）。`);
    lines.push(`到周末为止，已掌握 ${t.mastered} 张，快记住 ${t.almost} 张，还在学 ${t.learning} 张。`);
  } else {
    lines.push(`今天留下 ${d.compare.thisWeek} 条学习记录。`);
    if (d.movement.reviews) lines.push(`练了 ${d.movement.reviews} 次知识卡，答对 ${d.movement.right} 次。`);
    else lines.push('今天还没有练知识卡。');
    lines.push(`还有 ${t.due} 张卡到期没练。`);
  }
  if (d.weakPoints.length) {
    lines.push(`最需要回头看的：${d.weakPoints.slice(0, 3).map(w => `${w.knowledge}（${w.wrongs} 次没答对）`).join('、')}。`);
  } else if (t.cards) {
    lines.push('目前没有反复卡住的知识点。');
  }
  lines.push(`连续学习 ${d.streak.days} 天${d.streak.activeToday ? '（今天已学习）' : '（今天还没开始）'}。`);
  return { period: p, title: p === 'week' ? '本周学习小结' : '今日学习小结', lines: lines, data: d };
}

module.exports = { dashboard, report, curve, streak, weakPoints, movement, compare, totals, recent };

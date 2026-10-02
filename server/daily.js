'use strict';
/**
 * 学习日报（批次10）
 *
 * ── 这份东西的立场 ────────────────────────────────────────────
 * 日报最容易做成两种坏东西：
 *   ① 一份"你今天只学了 12 分钟"的账单（制造焦虑）；
 *   ② 一个"综合评分 87 分"的分数（把没答对说成你不行）。
 * 我们两个都不做。
 *
 * 日报要做的是**留痕**：把今天真实发生过的事摆出来，让学习者自己看清楚
 * "我原本想弄明白什么 / 今天走到哪一步 / 明天把力气放在哪"。
 * 四问（目标 · 状态 · 过程 · 调节）就是这么来的。
 *
 * ── 三条硬规矩 ────────────────────────────────────────────────
 * 1. **系统侧的事实不落库，每次现算。**
 *    日报表里只存"人写的那部分"。所有数字都从 `activity` / `card_reviews`
 *    现算出来，并且**每条数字都带 evidence 指针**，点得开、看得见原始记录。
 *    一旦把数字抄进日报表，"溯源"就变成了溯源到自己的副本 —— 那是假的。
 *
 * 2. **算不出来就说算不出来，不许补零。**
 *    没有练习记录时正确率不是 0%，是**无法计算**。value 为 null 时前端显示
 *    「暂不能确定」，并附上为什么。0 和"不知道"是两件事。
 *
 * 3. **不评分。** 见 notScored()：把"为什么这里没有分数"明明白白写出来，
 *    而不是含糊地不给分数。
 */
const D = require('./db');

const DAY = 24 * 60 * 60 * 1000;
const GAP_MIN = 45;          // 超过这个间隔算"中间停了一段"

// ---------- 日期 ----------
function dayKey(ts) {
  const d = new Date(ts);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function startOfDay(ts) { const d = new Date(ts); d.setHours(0, 0, 0, 0); return d.getTime(); }
function parseDay(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
function hhmm(ts) {
  const d = new Date(ts);
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

// ---------- 四问（问句自己写，不搬对标站的文案）----------
const QUESTIONS = [
  { key: 'goal',    title: '目标', ask: '你原本想弄明白什么？今天动了哪一步？' },
  { key: 'state',   title: '状态', ask: '今天哪里顺、哪里卡？' },
  { key: 'process', title: '过程', ask: '你是怎么走过来的？' },
  { key: 'adjust',  title: '调整', ask: '明天把力气放在哪儿？' },
];

// ---------- 原始记录 ----------
function loadActivity(spaceId, from, to) {
  return D.all('SELECT id, kind, ref_id, meta_json, at FROM activity WHERE space_id = ? AND at >= ? AND at < ? ORDER BY at',
    spaceId, from, to).map(r => {
    let meta = null;
    try { meta = r.meta_json ? JSON.parse(r.meta_json) : null; } catch (e) {}
    return { id: r.id, kind: r.kind, refId: r.ref_id, meta: meta, at: r.at, time: hhmm(r.at) };
  });
}
function loadReviews(spaceId, from, to) {
  return D.all(`
    SELECT r.id, r.card_id, r.result, r.student_answer, r.ai_verdict, r.verdict_json,
           r.is_free, r.reviewed_at, c.knowledge, c.subject
    FROM card_reviews r JOIN cards c ON c.id = r.card_id
    WHERE c.space_id = ? AND r.reviewed_at >= ? AND r.reviewed_at < ?
    ORDER BY r.reviewed_at`, spaceId, from, to).map(r => ({
    id: r.id, cardId: r.card_id, result: r.result,
    answer: r.student_answer || '', verdict: r.ai_verdict || '',
    isFree: !!r.is_free, knowledge: r.knowledge || '(未命名)', subject: r.subject || '',
    at: r.reviewed_at, time: hhmm(r.reviewed_at),
  }));
}

/**
 * 一条指标。
 * value === null 表示**算不出来**（不是 0）—— 前端必须显示"暂不能确定"。
 * evidence 指向原始记录，前端点得开。
 */
function metric(key, label, value, opts) {
  const o = opts || {};
  return {
    key: key, label: label, value: value,
    unit: o.unit || '',
    // 为什么算不出来。value 为 null 时必填，前端直接展示这句。
    unknown: value === null ? (o.unknown || '暂不能确定') : '',
    evidence: o.evidence || null,
    scope: o.scope || 'day',      // day = 当天；now = 此刻的状态（如到期未练）
  };
}

// ---------- 事实层 ----------
function facts(spaceId, date) {
  const from = parseDay(date);
  const to = from + DAY;
  const acts = loadActivity(spaceId, from, to);
  const revs = loadReviews(spaceId, from, to);

  const actIds = acts.map(a => a.id);
  const revIds = revs.map(r => r.id);
  const pick = (kind) => acts.filter(a => a.kind === kind);
  const right = revs.filter(r => r.result === 'right');
  const wrong = revs.filter(r => r.result === 'wrong');
  const unknown = revs.filter(r => r.result === 'unknown');

  // 时间跨度：只有一条记录时"跨度"没有意义 —— 那不是 0 分钟，是算不出来。
  let span = null;
  if (acts.length >= 2) span = Math.round((acts[acts.length - 1].at - acts[0].at) / 60000);

  // 过程里的空档
  const gaps = [];
  for (let i = 1; i < acts.length; i++) {
    const m = Math.round((acts[i].at - acts[i - 1].at) / 60000);
    if (m >= GAP_MIN) gaps.push({ minutes: m, after: acts[i - 1].time, before: acts[i].time });
  }

  // 今天碰过的卡（去重）
  const touched = {};
  revs.forEach(r => { touched[r.cardId] = (touched[r.cardId] || 0) + 1; });
  const touchedCards = Object.keys(touched).length;

  // 今天反复没答对的（同一天内错 ≥2 次的才算"卡住"，1 次是正常的）
  const wrongByCard = {};
  wrong.forEach(r => {
    const k = r.cardId;
    if (!wrongByCard[k]) wrongByCard[k] = { cardId: k, knowledge: r.knowledge, wrongs: 0, ids: [], last: r.time };
    wrongByCard[k].wrongs++; wrongByCard[k].ids.push(r.id); wrongByCard[k].last = r.time;
  });
  const stuck = Object.keys(wrongByCard).map(k => wrongByCard[k])
    .filter(x => x.wrongs >= 2).sort((a, b) => b.wrongs - a.wrongs);

  // 到期未练（此刻的状态，不属于"今天"）—— 单独标 scope:'now'
  const due = D.all(`
    SELECT id, knowledge, subject, due_at FROM cards
    WHERE space_id = ? AND status != 'retired' AND due_at > 0 AND due_at <= ?
    ORDER BY due_at LIMIT 20`, spaceId, D.now()).map(c => ({
    id: c.id, knowledge: c.knowledge || '(未命名)', subject: c.subject || '', dueAt: c.due_at,
  }));

  return {
    date: date, from: from, to: to,
    acts: acts, revs: revs, due: due,
    span: span, gaps: gaps, touchedCards: touchedCards, stuck: stuck,
    counts: {
      records: acts.length,
      chat: pick('chat').length,
      reviews: revs.length,
      cardCreated: pick('card_created').length,
      kbUpload: pick('kb_upload').length,
      login: pick('login').length,
      freeReviews: revs.filter(r => r.isFree).length,
    },
    right: right.length, wrong: wrong.length, unknown: unknown.length,
    rightIds: right.map(r => r.id), wrongIds: wrong.map(r => r.id), unknownIds: unknown.map(r => r.id),
    actIds: actIds, revIds: revIds,
  };
}

// ---------- 指标清单（每个都带溯源）----------
function metrics(f) {
  const c = f.counts;
  const out = [];

  out.push(metric('records', '留下的学习记录', c.records, {
    unit: '条', evidence: { kind: 'activity', ids: f.actIds },
    unknown: '今天还没有任何记录，所以这条没法算',
  }));
  out.push(metric('reviews', '练知识卡的次数', c.reviews, {
    unit: '次', evidence: { kind: 'review', ids: f.revIds },
    unknown: '今天没有练习记录，所以这条没法算',
  }));

  // ★ 正确率的分母只能是"判得出对错的那些次"，不能把 unknown 也算进去 ——
  //   否则就和「不评分的原因」里那句"判不了对错的没有计入对错"自相矛盾。
  //   口径必须处处一致，不然"数据诚实"就成了嘴上说说。
  const judged = f.right + f.wrong;
  const acc = judged ? Math.round(f.right / judged * 100) : null;
  out.push(metric('accuracy', '答对的比例', acc, {
    unit: '%',
    evidence: judged ? { kind: 'review', ids: f.rightIds.concat(f.wrongIds) } : null,
    unknown: judged ? '暂不能确定' : '今天没有一次判得出对错的练习，算不出比例',
  }));

  out.push(metric('unknown', '没法判断对错的', f.unknown, {
    unit: '次', evidence: { kind: 'review', ids: f.unknownIds },
    unknown: '今天没有练习记录，所以这条没法算',
  }));

  out.push(metric('cards', '今天碰过的知识卡', f.touchedCards, {
    unit: '张',
    evidence: { kind: 'review', ids: f.revIds },
    unknown: '今天没有练习记录，所以这条没法算',
  }));

  // ★ 时间跨度：只有一条记录时算不出来（不是 0 分钟）。
  //   算不出来就**连 evidence 一起置空** —— 给一个空的证据列表，等于暗示"这里本该有依据"。
  out.push(metric('span', '从第一条到最后一条的跨度', f.span, {
    unit: '分钟',
    evidence: f.span === null ? null : { kind: 'activity', ids: f.actIds },
    unknown: c.records < 2 ? '今天不足两条记录，跨度没有意义' : '暂不能确定',
  }));

  // 到期未练属于"此刻的状态"，不是当天的成绩 —— 单独标 scope。
  out.push(metric('due', '此刻到期没练的卡', f.due.length, {
    unit: '张', evidence: { kind: 'card', ids: f.due.map(d => d.id) }, scope: 'now',
  }));

  return out;
}

// ---------- 四问 ----------
function questions(f, date) {
  const c = f.counts;
  const has = c.records > 0;

  return QUESTIONS.map(q => {
    const findings = [];
    const unknown = [];

    if (q.key === 'goal') {
      if (c.cardCreated) {
        findings.push({
          text: '今天收了 ' + c.cardCreated + ' 张新知识卡。',
          evidence: { kind: 'activity', ids: f.acts.filter(a => a.kind === 'card_created').map(a => a.id) },
        });
      }
      if (c.chat) findings.push({ text: '开了 ' + c.chat + ' 次对话。', evidence: { kind: 'activity', ids: f.acts.filter(a => a.kind === 'chat').map(a => a.id) } });
      if (c.kbUpload) findings.push({ text: '传进来 ' + c.kbUpload + ' 份资料。', evidence: { kind: 'activity', ids: f.acts.filter(a => a.kind === 'kb_upload').map(a => a.id) } });
      if (!findings.length) unknown.push('今天没有留下能判断"想弄明白什么"的记录 —— 你可以自己补上。');
    }

    if (q.key === 'state') {
      if (c.reviews) {
        findings.push({
          text: '练了 ' + c.reviews + ' 次：答对 ' + f.right + ' 次，没答对 ' + f.wrong + ' 次。',
          evidence: { kind: 'review', ids: f.revIds },
        });
        if (f.unknown) {
          findings.push({
            text: '还有 ' + f.unknown + ' 次 AI 判不了对错（你自己也说不准），这几次「没有」算进上面的对错里。',
            evidence: { kind: 'review', ids: f.unknownIds },
          });
        }
      } else {
        unknown.push('今天没练知识卡，所以"哪里卡"这件事，今天没有数据能回答。');
      }
      f.stuck.forEach(s => findings.push({
        text: '「' + s.knowledge + '」今天反复没答对 ' + s.wrongs + ' 次（最后一次 ' + s.last + '）。',
        evidence: { kind: 'review', ids: s.ids },
      }));
    }

    if (q.key === 'process') {
      if (f.span !== null) findings.push({ text: '今天的学习集中在 ' + f.acts[0].time + ' 到 ' + f.acts[f.acts.length - 1].time + '，前后 ' + f.span + ' 分钟。', evidence: { kind: 'activity', ids: f.actIds } });
      else if (c.records === 1) unknown.push('今天只留下 1 条记录，看不出"过程"，只能看到一个点。');
      f.gaps.slice(0, 3).forEach(g => findings.push({ text: g.after + ' 之后停了约 ' + g.minutes + ' 分钟，' + g.before + ' 才继续。', evidence: { kind: 'activity', ids: f.actIds } }));
      if (!has) unknown.push('今天没有记录，过程无从谈起。');
    }

    if (q.key === 'adjust') {
      if (f.due.length) {
        findings.push({ text: '此刻有 ' + f.due.length + ' 张卡到期还没练，最近的是「' + f.due[0].knowledge + '」。', evidence: { kind: 'card', ids: f.due.map(d => d.id) } });
      } else if (has) {
        findings.push({ text: '此刻没有到期没练的卡。', evidence: null });
      }
      f.stuck.slice(0, 2).forEach(s => findings.push({
        text: '「' + s.knowledge + '」今天卡了 ' + s.wrongs + ' 次，明天可以先看它。',
        evidence: { kind: 'review', ids: s.ids },
      }));
      if (!has) unknown.push('今天没有记录，明天怎么安排还看不出依据。');
      // ★ 不替学生决定 —— 用问句收尾，这是产品立场。
      findings.push({ text: '这只是数据看到的。明天要不要按它来，你自己定。', evidence: null, ask: true });
    }

    return { key: q.key, title: q.title, ask: q.ask, findings: findings, unknown: unknown };
  });
}

/**
 * 「不评分的原因」—— 对标站做得最好的地方，必须抄的是这个**设计**，不是它的文案。
 * 不是含糊地不给分数，而是把"为什么不给"明明白白写出来。
 */
function notScored(f) {
  const out = [];
  out.push({
    title: '为什么这里没有分数',
    why: '分数会把"今天没答对"变成"你不行"。而没答对通常只说明这张卡还没到该记住的时候 —— 复习间隔就是这么设计的。',
  });
  out.push({
    title: '只统计能对上原话的',
    why: f.unknown
      ? '有 ' + f.unknown + ' 次 AI 判不了对错，这几次「没有」计入对错，也没有被当成错。宁可少算，不要错算。'
      : '今天所有练习都判得出对错，所以没有需要剔除的部分。',
  });
  out.push({
    title: '数字不等于掌握',
    why: '单日的对错不是掌握的证据。真正的证据是知识卡的状态推进（还在学 → 快记住 → 已掌握），那是跨很多天才看得出来的一件事。',
  });
  out.push({
    title: '算不出来就说算不出来',
    why: '今天没有记录时，比例、跨度这类数字会显示「暂不能确定」，而不是补一个 0。0 和"不知道"是两件事。',
  });
  return out;
}

// ---------- 汇总 ----------
function build(spaceId, date) {
  const day = parseDay(date) === null ? dayKey(D.now()) : date;
  const f = facts(spaceId, day);
  const rec = getReport(spaceId, day);
  const ms = metrics(f);
  const qs = questions(f, day);
  const has = f.counts.records > 0;

  return {
    date: day,
    isToday: day === dayKey(D.now()),
    hasRecord: has,
    headline: has
      ? '今天留下 ' + f.counts.records + ' 条记录。'
      : '今天还没有留下任何记录 —— 下面的数字暂时都算不出来。',
    metrics: ms,
    questions: qs,
    notScored: notScored(f),
    // 诚实性声明：把"这份日报不能证明什么"写在明面上
    limits: [
      '日报只统计「这个空间里发生过的事」，你在别处学的东西这里看不到。',
      '记录条数多不等于学得好，少也不等于没学 —— 它只说明"这里留下了多少痕迹"。',
      '所有数字都可以点开看原始记录；如果你觉得哪个数不对，以原始记录为准。',
    ],
    answers: rec ? rec.answers : {},
    status: rec ? rec.status : 'none',
    updatedAt: rec ? rec.updated_at : 0,
  };
}

/**
 * 把一批 id 解析成可展示的原始记录。
 *
 * ★ 安全要点：ids 来自客户端，**不能直接拿去查库**。
 *   这里只从 `f`（已经按 space 过滤过的事实）里挑 ——
 *   传别人的 id 进来也只会挑到空，跨空间拿不到东西。
 */
function itemsOf(f, kind, ids) {
  const want = {};
  (Array.isArray(ids) ? ids : []).forEach(i => { want[String(i)] = 1; });
  const has = (id) => want[String(id)] === 1;

  if (kind === 'review') {
    return f.revs.filter(r => has(r.id)).map(r => ({
      time: r.time,
      title: r.knowledge,
      detail: r.answer ? ('你当时写的是：' + r.answer) : '（没有留下作答原文）',
      verdict: r.result === 'right' ? '答对' : r.result === 'wrong' ? '没答对' : '没法判断',
      aiVerdict: r.verdict,
      isFree: r.isFree,
    }));
  }
  if (kind === 'activity') {
    const KIND = { chat: '对话', card_review: '练卡', card_free_practice: '自由练习', card_created: '收了知识卡', kb_upload: '上传资料', login: '登录' };
    return f.acts.filter(a => has(a.id)).map(a => ({
      time: a.time,
      title: KIND[a.kind] || a.kind,
      detail: a.meta && a.meta.title ? a.meta.title : (a.meta && a.meta.knowledge ? '「' + a.meta.knowledge + '」' : ''),
      verdict: '', aiVerdict: '', isFree: false,
    }));
  }
  if (kind === 'card') {
    return f.due.filter(c => has(c.id)).map(c => ({
      time: '', title: c.knowledge,
      detail: c.subject ? ('科目：' + c.subject) : '',
      verdict: '到期未练', aiVerdict: '', isFree: false,
    }));
  }
  return [];
}

/** 按指标名溯源（数字卡片用） */
function evidence(spaceId, date, metricKey) {
  const day = parseDay(date) === null ? dayKey(D.now()) : date;
  const f = facts(spaceId, day);
  const m = metrics(f).filter(x => x.key === metricKey)[0];
  if (!m || !m.evidence) return { metric: metricKey, label: m ? m.label : '', items: [] };
  return { metric: metricKey, label: m.label, items: itemsOf(f, m.evidence.kind, m.evidence.ids) };
}

/** 按 kind + ids 溯源（四问里某一条发现的"看依据"用） */
function evidenceByIds(spaceId, date, kind, ids) {
  const day = parseDay(date) === null ? dayKey(D.now()) : date;
  const f = facts(spaceId, day);
  const list = Array.isArray(ids) ? ids.slice(0, 200) : [];
  return { metric: kind, label: '', items: itemsOf(f, String(kind || ''), list) };
}

// ---------- 存取（只存"人写的那部分"）----------
function getReport(spaceId, date) {
  const r = D.get('SELECT * FROM daily_reports WHERE space_id = ? AND date = ?', spaceId, date);
  if (!r) return null;
  let answers = {};
  try { answers = r.answers_json ? JSON.parse(r.answers_json) : {}; } catch (e) {}
  return { id: r.id, date: r.date, status: r.status, answers: answers, updatedAt: r.updated_at, finalizedAt: r.finalized_at };
}

const ANSWER_KEYS = QUESTIONS.map(q => q.key);
const ANSWER_MAX = 2000;

function saveDraft(spaceId, date, answers) {
  const day = parseDay(date) === null ? dayKey(D.now()) : date;
  const src = answers && typeof answers === 'object' ? answers : {};
  const clean = {};
  ANSWER_KEYS.forEach(k => {
    if (typeof src[k] === 'string') clean[k] = src[k].slice(0, ANSWER_MAX);
  });
  const existing = D.get('SELECT id, status FROM daily_reports WHERE space_id = ? AND date = ?', spaceId, day);
  const now = D.now();
  if (existing) {
    // 已定稿的日报不再接受草稿覆盖 —— 定稿是一份"当时写的"，不该被后来改写
    if (existing.status === 'final') return getReport(spaceId, day);
    D.run('UPDATE daily_reports SET answers_json = ?, updated_at = ? WHERE id = ?', JSON.stringify(clean), now, existing.id);
  } else {
    D.run('INSERT INTO daily_reports(id,space_id,date,status,answers_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?)',
      D.uid('dr_'), spaceId, day, 'draft', JSON.stringify(clean), now, now);
  }
  return getReport(spaceId, day);
}

function finalize(spaceId, date, answers) {
  if (answers && typeof answers === 'object') saveDraft(spaceId, date, answers);
  const day = parseDay(date) === null ? dayKey(D.now()) : date;
  const r = D.get('SELECT id FROM daily_reports WHERE space_id = ? AND date = ?', spaceId, day);
  const now = D.now();
  if (!r) {
    D.run('INSERT INTO daily_reports(id,space_id,date,status,answers_json,created_at,updated_at,finalized_at) VALUES(?,?,?,?,?,?,?,?)',
      D.uid('dr_'), spaceId, day, 'final', '{}', now, now, now);
  } else {
    D.run('UPDATE daily_reports SET status = ?, updated_at = ?, finalized_at = ? WHERE id = ?', 'final', now, now, r.id);
  }
  return getReport(spaceId, day);
}

function history(spaceId, limit) {
  const n = Math.max(1, Math.min(60, Number(limit) || 30));
  return D.all('SELECT date, status, answers_json, updated_at, finalized_at FROM daily_reports WHERE space_id = ? ORDER BY date DESC LIMIT ?', spaceId, n)
    .map(r => {
      let a = {};
      try { a = r.answers_json ? JSON.parse(r.answers_json) : {}; } catch (e) {}
      const filled = ANSWER_KEYS.filter(k => a[k] && a[k].trim()).length;
      return { date: r.date, status: r.status, filled: filled, updatedAt: r.updated_at, finalizedAt: r.finalized_at };
    });
}

module.exports = { build, facts, metrics, questions, notScored, evidence, evidenceByIds, getReport, saveDraft, finalize, history, QUESTIONS, dayKey, parseDay };

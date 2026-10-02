'use strict';
/**
 * 家长端。给"不坐在电脑前的那个大人"看的一页。
 *
 * ============================ 设计主张（先读这段再读代码）============================
 *
 * 1. **家长端不是把看板的数字再排一遍。** 看板回答"我做了什么"（学习者视角），
 *    家长端要回答的是 **「我能做什么」**。同一个 `activity` 表，但**问的问题不同**，
 *    所以呈现的东西也不同。抄看板的数字过来 = 做了个没人会看的第二看板。
 *
 * 2. **继承日报/周报的三条硬规矩**（本项目最重要的数据诚实性约束）：
 *    ① 系统侧事实不落库、每次现算；
 *    ② 算不出来就说算不出来，**不许补零**（`value===null` ⇒ 必须给 `unknown` 文案，
 *       且 `evidence` 一起置空 —— 给空证据列表等于暗示"这里本该有依据"）；
 *    ③ 不评分，但要说清为什么。
 *
 * 3. **不给孩子打分，也不给家长打分。** 这是本项目和竞品最大的分歧：
 *    竞品的家长端是"监看仪表盘"（分数 / 时长 / 排名）。我们不这么做，理由有三：
 *      · **分数会变成家长的目标**，于是孩子的目标从"学会"变成"让分数好看"；
 *      · **时长不是学习的证据**，坐得久可能是卡住了，也可能是发呆；
 *      · **排名要参照系**，而我们根本没有"别的孩子"这个数据 —— 编一个平均线就是撒谎。
 *    所以这里给的每一条都是**指向某个具体动作**的，而不是指向某个评价。
 *
 * 4. **数字必须翻译成人话。** 家长看不懂"掌握迁移率 62%"，但看得懂
 *    "这周有 4 张卡从'还在学'走到了'快记住'—— 说明他在一遍遍重来，而不是背一次就扔"。
 *    每条结论都配一句 `plain`：**发生了什么 + 这正常吗 + 你能做什么**。
 *
 * 5. **不提供"孩子没说你也看得到"的能力。** 家长端只看**聚合后的学习痕迹**，
 *    不展示对话原文、不展示孩子写错的答案、不展示草稿态日报。
 *    理由：一个知道自己每句话都会被家长读的孩子，会停止真实地思考。
 *    ⇒ 这是**刻意的功能缺失**，不是没做完。
 *
 * ============================ 数据来源（全部现算，不落库）============================
 *   activity      —— 学习动作流水（对话/上传/建卡/复习…）
 *   card_reviews  —— 每次复习的结果与时间
 *   cards         —— 当前状态与阶段
 *   daily_reports —— **只读"孩子写的那句话"**（数字仍然现算，见规矩①）
 */
const D = require('./db');
const cards = require('./cards');
const daily = require('./daily');
const dashboard = require('./dashboard');
const subjects = require('./subjects');

const DAY = 86400000;

/** 把时间戳规整到当天 0 点 */
function startOfDay(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
/** 'YYYY-MM-DD' → 当天 0 点时间戳；非法返回 null */
function dayStart(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (isNaN(d.getTime())) return null;
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
/** 时间戳 → 'YYYY-MM-DD'（本地） */
function dayStr(ts) {
  const d = new Date(ts);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

/**
 * 通用「不确定性」条目。
 * ★ 规矩②的落点：算不出来时必须走这里，**不能**返回 0。
 *   注意 `evidence` 一起置空 —— 见 `daily.js` 里那条注释。
 */
function unknown(label, why) {
  return { label: label, value: null, unit: '', unknown: why, evidence: null };
}
function known(label, value, unit, evidence) {
  return { label: label, value: value, unit: unit || '', unknown: null, evidence: evidence || null };
}

// ---------- 1. 这周的节奏 ----------
/**
 * 不是"学了多久"，而是"**哪天学了、哪天断了**"。
 * ★ 为什么不用时长：时长需要"开始/结束"配对，本产品的心跳只在页面开着时打点，
 *   关掉标签页就断了。拿这个算时长会**系统性低估**，而低估比不测更糟。
 *   换成"有记录的天数"—— 这个能被 activity 忠实反映，且家长看得懂。
 */
function rhythm(spaceId, from, to) {
  const rows = D.all(
    'SELECT id, at FROM activity WHERE space_id = ? AND at >= ? AND at < ? ORDER BY at ASC',
    spaceId, from, to + DAY);
  const days = {};
  rows.forEach(r => { const k = dayStr(r.at); days[k] = (days[k] || 0) + 1; });

  const total = Math.round((to - from) / DAY) + 1;
  const activeDays = Object.keys(days).length;
  // 最长连续有记录天数
  let best = 0, cur = 0;
  for (let i = 0; i < total; i++) {
    const k = dayStr(from + i * DAY);
    if (days[k]) { cur++; best = Math.max(best, cur); } else cur = 0;
  }
  // 最近一次有记录是哪天（判断"是不是停了"）
  const lastRow = D.get('SELECT MAX(at) m FROM activity WHERE space_id = ?', spaceId);
  const lastAt = lastRow && lastRow.m ? lastRow.m : null;
  const gapDays = lastAt ? Math.floor((startOfDay(D.now()) - startOfDay(lastAt)) / DAY) : null;

  return {
    activeDays: activeDays,
    totalDays: total,
    longestStreak: best,
    perDay: Object.keys(days).sort().map(k => ({ date: k, actions: days[k] })),
    lastAt: lastAt,
    // ★ 全新空间没有 lastAt ⇒ gapDays 为 null，**不是 0**（0 意味着"今天就在学"）
    gapDays: gapDays,
    // ★ activity.id 是 INTEGER PRIMARY KEY AUTOINCREMENT（真实自增 id），
    //   不是某些表用的 TEXT id。早期版本这里写的是 `r.id_placeholder`（不存在的列），
    //   会把 evidence 静默变成空数组 —— 而空 evidence 恰好是规矩②禁止的形态。
    evidence: { kind: 'activity', ids: rows.slice(0, 200).map(r => r.id) },
  };
}

// ---------- 2. 掌握在不在推进（家长版：看"移动"，不看"存量"）----------
/**
 * ★ 这是整个家长端**最重要**的一块，也是和竞品最不一样的地方。
 *   竞品展示"已掌握 12 张"，家长会拿去和别人比（而他没有参照系）。
 *   我们展示**这周有几张往前走了** —— 这个数字的含义是"他在反复重来"，
 *   是**过程指标**，不需要参照系，也没法拿去做排名。
 */
function movement(spaceId, from, to) {
  // ★★ 重大坑（不要退回）：`card_reviews` 表**根本没有 `space_id` 列**（见 db.js）。
  //    它的空间归属只能通过 JOIN `cards` 得到。
  //    早期版本这里写了 `WHERE c.space_id = ?` 但**在 JOIN 之前就用了 `r.space_id`**，
  //    另一种错法是不带空间条件 —— 那会把**别的孩子**的复习记录算进来，
  //    而且是静默的（数字看起来完全正常）。家长端串数据是最不能容忍的一类 bug。
  //    ⇒ 唯一正确的写法：`JOIN cards c ON c.id = r.card_id` 后用 `c.space_id` 过滤。
  const rows = D.all(
    `SELECT r.id AS rid, r.card_id, c.status AS now_status, r.result, r.reviewed_at
     FROM card_reviews r JOIN cards c ON c.id = r.card_id
     WHERE c.space_id = ? AND r.reviewed_at >= ? AND r.reviewed_at < ?
     ORDER BY r.reviewed_at ASC`,
    spaceId, from, to + DAY);

  const judged = rows.filter(r => r.result === 'right' || r.result === 'wrong').length;
  const right = rows.filter(r => r.result === 'right').length;
  const unknownN = rows.filter(r => r.result === 'unknown').length;

  // 状态推进：用"卡在本周期内第一次出现时的状态"与"当前状态"比较是不可靠的
  // （状态是当前值，没有历史快照）。所以这里用**可证伪的代理指标**：
  // 「本周重新复习过的卡里，现在处于 almost/mastered 的比例」。
  // ★ 判据写清楚：这测的是"复习过的卡现在到哪了"，**不是**"本周发生了多少次跃迁"。
  const touchedIds = Array.from(new Set(rows.map(r => r.card_id)));
  let advanced = 0;
  if (touchedIds.length) {
    const qs = touchedIds.map(() => '?').join(',');
    const got = D.get(
      `SELECT COUNT(*) c FROM cards WHERE id IN (${qs}) AND status IN ('almost','mastered','retired')`,
      ...touchedIds);
    advanced = (got || {}).c || 0;
  }

  return {
    reviews: rows.length,
    judged: judged,
    right: right,
    unknown: unknownN,
    // ★ 规矩②/口径一致性：分母是**判得出对错的次数**，unknown 不计入。
    //   算不出来（judged === 0）时给 null，不给 0。
    accuracy: judged ? Math.round(right / judged * 100) : null,
    touched: touchedIds.length,
    advanced: touchedIds.length ? advanced : null,
    // ★ card_reviews.id 是 TEXT 主键（不是自增），所以这里取 r.rid 是安全的。
    evidence: { kind: 'review', ids: rows.slice(0, 200).map(r => r.rid) },
  };
}

// ---------- 3. 卡在哪里（家长版：给"怎么帮"，不给"错了几次"）----------
/**
 * ★ 与看板 weakPoints 的区别：看板给的是 `wrongs` 计数（孩子视角："这几张要多看"），
 *   家长端要把它**翻译成一句家长能照着做的事**，并且**不点破具体知识点**
 *   （家长如果拿着"判别式"去考孩子，反而把自学变成被考）。
 *   ⇒ 所以这里只给**领域 + 建议动作**，不给知识点原文。
 *
 * ★ 学科必须翻成中文：`cards.subject` 里存的是 `math` / `english` 这类**码值**，
 *   直接吐给家长会冒出英文。用 subjects.js 的**唯一映射**（不要自己再写一份）。
 */
function helpPoints(spaceId) {
  const rows = D.all(`
    SELECT c.knowledge, c.subject, c.status,
           SUM(CASE WHEN r.result = 'wrong' THEN 1 ELSE 0 END) AS wrongs,
           COUNT(r.id) AS reviews
    FROM cards c LEFT JOIN card_reviews r ON r.card_id = c.id
    WHERE c.space_id = ?
    GROUP BY c.id
    HAVING wrongs >= 2
    ORDER BY wrongs DESC, reviews DESC
    LIMIT 5`, spaceId);

  return rows.map(r => {
    const area = subjects.SUBJECT_NAME[r.subject] || '这块内容';
    // ★ 措辞原则：**说"反复遇到"，不说"没学会"**。
    //   前者是事实描述，后者是评价；家长看到"没学会"会去干预，看到"反复遇到"会等一等。
    const advice = r.wrongs >= 4
      ? '这一块他已经反复遇到 ' + r.wrongs + ' 次了。可以问问他"这块卡在哪一步"，让他给你讲一遍 —— 讲得出来就是真会了。'
      : '这一块反复遇到 ' + r.wrongs + ' 次。先不用管，间隔复习本来就要错几遍；如果两周后还是这样，再一起看看。';
    return {
      // ★ 只给领域，不给知识点原文（见函数头注释）
      area: area,
      wrongs: r.wrongs,
      reviews: r.reviews,
      status: r.status,
      advice: advice,
    };
  });
}

// ---------- 4. 自己写的那句话（只读，不回写）----------
/**
 * ★ 规矩①的严格落点：家长端**只读** `daily_reports` 里"孩子写的那段自述"，
 *   所有数字仍然现算（调用 daily 模块，不读表里的快照）。
 *   而且**只读已定稿的**（`status === 'final'`）—— 草稿是孩子自己还没想好的东西，
 *   家长不该在旁边看着它成形。
 *
 * ★ 表结构提示（踩过坑）：`daily_reports` 里**没有 `note`、也没有 `final_at` 列**。
 *   自述存在 `answers_json`（四问：goal/state/process/adjust），
 *   定稿标记是 `status='final'`，定稿时间列叫 `finalized_at`。
 *   → 这里复用 `daily.getReport()` 解析 answers_json，不手写 JSON.parse
 *     （避免第二个解析口径，将来字段改了只改一处）。
 */
function notes(spaceId, from, to) {
  const rows = D.all(
    `SELECT date FROM daily_reports
     WHERE space_id = ? AND date >= ? AND date <= ? AND status = 'final'
     ORDER BY date DESC LIMIT 14`,
    spaceId, dayStr(from), dayStr(to));
  return rows.map(r => {
    const rep = daily.getReport(spaceId, r.date);
    const ans = (rep && rep.answers) || {};
    const answers = Object.keys(ans)
      .filter(k => typeof ans[k] === 'string' && ans[k].trim())
      .map(k => ({ key: k, text: ans[k] }));
    return {
      date: r.date,
      finalizedAt: rep ? rep.finalizedAt : null,
      answers: answers,
      // 有没有真的写点什么（只有日期没内容的不算"写了"）
      hasWords: answers.length > 0,
    };
  }).filter(n => n.hasWords);
}

// ---------- 5. 一句话总结（把数字翻成人话）----------
/**
 * ★ 整个家长端的"产品灵魂"在这一个函数里。
 *   要求：**发生了什么 + 这正常吗 + 你能做什么**，三件事一句话说完。
 *   · 说"正常"很重要 —— 家长最大的焦虑来自"不知道这个数算好还是坏"；
 *   · 给动作很重要 —— 只说现象等于制造焦虑，不给出口。
 *   · **不许夸也不许批评**：这个系统不知道孩子努力了多少，只知道自己看到了什么。
 */
function headline(rh, mv, help, nowMs) {
  // ① 完全没记录：不说"没学习"，说"我这边没看到"（系统能证的只有后者）
  if (rh.activeDays === 0) {
    return {
      tone: 'quiet',
      text: '这个时间段我这边没有看到任何学习记录。',
      plain: '可能是这段时间本来就没安排学习，也可能是他还没回来用这个工具。'
        + '这两种情况我分不出来 —— 所以我只说"我没看到"，不说"他没学"。',
      action: '想确认的话，直接问他一句就行；不用拿这一页去问他。',
    };
  }

  // ② 停了一段时间（有记录，但最近几天没有）
  if (rh.gapDays !== null && rh.gapDays >= 3) {
    return {
      tone: 'gap',
      text: '最后一次看到记录是 ' + rh.gapDays + ' 天前。',
      plain: '间隔复习本来就允许停下来 —— 真正要紧的不是"每天都学"，'
        + '而是**停下来之后还回得来**。所以三天不算问题，一周以上才值得留个心。',
      action: rh.gapDays >= 7
        ? '可以问一句"最近那个学习工具还用吗"，听他怎么说就行。'
        : '先不用做什么。留个心，下次打开看看他回不回来。',
    };
  }

  // ③ 在推进：用"复习过的卡现在到哪了"说，不用"掌握了几张"
  const mvLine = mv.accuracy === null
    ? '这段时间的练习里，还没有出现过能判对错的题（可能都是在看和想，还没到做题那一步）。'
    : '这段时间做过的题里，判得出对错的那些，答对了 ' + mv.accuracy + '%。';
  const advLine = (mv.advanced !== null && mv.advanced > 0)
    ? '他复习过的 ' + mv.touched + ' 张卡里，有 ' + mv.advanced + ' 张已经走到"快记住"或"已掌握"。'
    : '他复习过的卡还都停在"还在学"这一步。';

  return {
    tone: 'active',
    text: rh.activeDays + ' 天里有记录，最长连续 ' + rh.longestStreak + ' 天。',
    plain: mvLine + advLine
      + '**重点是后面这句**：卡在"还在学"是正常的第一步，'
      + '真正说明问题的是它有没有在本周往后挪 —— 这个工具的设计就是让卡**反复出现**，'
      + '所以"错了又错"是过程的一部分，不是没学会。',
    action: help.length
      ? '下面有一条"可以帮上忙的地方"，照着说一句就行，不用替他讲题。'
      : '暂时不需要你做什么。他能自己回来接着学，比什么都强。',
  };
}

// ---------- 主入口 ----------
/**
 * 生成家长端一页。
 * @param {string} spaceId
 * @param {string} from 'YYYY-MM-DD'
 * @param {string} to   'YYYY-MM-DD'
 */
function build(spaceId, from, to) {
  const f = dayStart(from), t = dayStart(to);
  if (f === null || t === null) {
    const e = new Error('日期格式不对，应该像 2026-10-02');
    e.code = 'invalid_range';
    throw e;
  }
  if (t < f) {
    const e = new Error('结束日期不能早于开始日期');
    e.code = 'invalid_range';
    throw e;
  }
  const span = Math.round((t - f) / DAY) + 1;
  // ★ 家长端默认看"这段时间"，但不许无限长 —— 和日报/周报一个道理：
  //   范围越大，越容易变成"趋势判断"，而趋势需要更多数据才成立。31 天够用。
  if (span > 31) {
    const e = new Error('一次最多看 31 天，把范围收窄一点');
    e.code = 'range_too_long';
    throw e;
  }

  const rh = rhythm(spaceId, f, t);
  const mv = movement(spaceId, f, t);
  const help = helpPoints(spaceId);
  const noteRows = notes(spaceId, f, t);

  // 当前存量（只用来给"现在有什么"，不做评价、不做趋势）
  const tt = dashboard.totals(spaceId);

  // ★ 家长最想知道的那个问题，但**我们答不了**："他学懂了没有？"
  //   规矩②要求：答不了就说答不了，并且**说清为什么答不了**。
  const cannotSay = [
    {
      q: '他到底学懂了没有？',
      a: '这个我答不了。我能看到的是"他做了哪些动作、哪些题答对了"，'
        + '但"懂"是一个人在新问题上能不能自己走通 —— 那需要在真实问题上验证，'
        + '不是做题正确率能代表的。硬给一个分数，只会让两件事都失真。',
    },
    {
      q: '他比别的孩子快还是慢？',
      a: '这个我也答不了，而且**不该答**。我只有你一个孩子的数据，'
        + '没有"别的孩子"这个参照系。任何"超过 xx% 的同龄人"都是编的。',
    },
    {
      q: '他是不是在偷懒？',
      a: '我分不出"没打开工具"和"打开了在别的书上做题"。'
        + '这段时间的记录只能说明这个工具被用了多少次，不能说明他学了多久。',
    },
  ];

  return {
    range: { from: dayStr(f), to: dayStr(t), days: span },
    headline: headline(rh, mv, help, D.now()),
    rhythm: {
      activeDays: rh.activeDays,
      totalDays: rh.totalDays,
      longestStreak: rh.longestStreak,
      // ★ 没记录过 ⇒ lastAt 为 null 且 gapDays 为 null，**不是 0**
      lastAt: rh.lastAt,
      gapDays: rh.gapDays,
      perDay: rh.perDay,
    },
    movement: {
      reviews: mv.reviews,
      // ★ 这里是规矩②最关键的一处：judged === 0 时 accuracy 是 null
      judged: mv.judged,
      // ★ right / wrong / unknown 必须一起给出去。
      //   前端要显示"对 N / 错 M"，而 M 是 `judged - right` 算出来的 ——
      //   少给 `right`，前端就得到 `undefined - undefined = NaN`，
      //   界面上直接印出「对 1 / 错 NaN」。**不报错、不抛异常，只是印出来难看**。
      //   （这正是本项目那条"undefined 会被 JSON.stringify 丢掉整个键"的同类：
      //    漏字段的后果不在传输层，而在**消费端算出一个垃圾值**。）
      right: mv.right,
      wrong: mv.judged - mv.right,
      unknown: mv.unknown,
      accuracy: mv.accuracy,
      accuracyUnknown: mv.accuracy === null
        ? '这段时间没有出现过能判对错的练习，算不出正确率'
        : null,
      touched: mv.touched,
      advanced: mv.advanced,
      advancedUnknown: mv.advanced === null
        ? '这段时间没有复习过任何卡片'
        : null,
    },
    helpPoints: help,
    notes: noteRows,
    now: {
      cards: tt.cards,
      mastered: tt.mastered,
      due: tt.due,
      documents: tt.documents,
      conversations: tt.conversations,
    },
    // ★ 明说"我答不了什么" —— 这是这一页最诚实也最有价值的部分
    cannotSay: cannotSay,
    // 承诺边界：让家长知道**看不到**什么，以及为什么
    privacy: {
      notShown: ['对话原文', '他写错的答案', '还没定稿的日报'],
      why: '一个知道自己每句话都会被家长读的孩子，会开始写"家长想看的"，而不是自己真想的。'
        + '所以这几样我**故意不给** —— 不是没做完。',
    },
  };
}

module.exports = { build, rhythm, movement, helpPoints, notes };

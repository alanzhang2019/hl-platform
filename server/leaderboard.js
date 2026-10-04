'use strict';
/**
 * 班级 + 班级排行榜（批次28）
 *
 * 定位：**唯一**允许"把人排序"的模块。
 *
 * ★★ 为什么它是独立的、并且必须独立 —— 不要合并进 growth.js：
 *   `server/growth.js` 顶部有一条明文规矩「不给外部激励 / 不给排行」，理由是
 *   用分数把人排序会鼓励"跟别人比"，与"唯一性决定方向"的主张相反。那条规矩
 *   对**成长画像**依然成立（画像描述的是认知动作的变化，不是名次），
 *   `_growthcheck.cjs` 至今仍在断言它的输出里不许出现 score/rank/level。
 *
 *   排行榜是产品上的一次**刻意例外**：激励自学需要一个"和认识的人一起"的场。
 *   所以它被单独关在这个文件里 —— growth 的画像保持纯净，排行榜自己承担
 *   "排序"这件事的全部后果。**不要为了复用把两者搅在一起**，那会让
 *   growth 的规矩失守，也会让排行榜受画像的口径牵连。
 *
 * ★★ 计分口径：只认「知识卡状态真的往前推进」，不认在线时长。
 *
 *   这是本项目的既有主张（见 pet.js 顶部："纯粹挂着刷对话，成长值不动"）。
 *   落到数据上：`pet_events` 是 pet.js 写下的**账本**，每一行对应一次
 *   "状态推进"（`delta = 5 + 跨档×3`，理解核对 solid 再 +5），答错/unknown
 *   根本不写行。所以 `SUM(delta)` 天生就是质量口径，不需要另设公式。
 *
 *   ★ `pets.growth` 恰好等于该用户 `SUM(pet_events.delta)`（pet.js 是 pets.growth
 *     的唯一写入方，且每次都同步插一条 pet_events）。这里**仍然从账本现算**，
 *     而不是读 pets.growth，理由有两条：
 *     ① 账本能按时间窗口切片（周榜要"本周"），快照值切不出来；
 *     ② 符合本项目"数字永远现算、不落库"的传统（daily/weekly/parent/growth 同规矩）。
 *     代价是要扫一遍 pet_events，可接受 —— 一个班 ≤60 人。
 *
 * ★ 跨空间隔离：班级**跨空间**（一个班里的学生各有各的 space），所以每个成员
 *   都带着自己的 space_id。查 pet_events 必须用 (space_id, user_id) **这一对**
 *   做键 —— 只按 user_id 过滤会串空间，只按 space_id 过滤会漏人。
 *   `card_reviews` 表**没有 space_id 列**，要用它只能 JOIN cards（见 parity20 的教训），
 *   本模块刻意不碰它。
 */

const D = require('./db');
const crypto = require('crypto');

/** 一个班的容量上限。不是技术限制，是产品限制：榜太长就没有"认识的人"的感觉了。 */
const MAX_CLASS_MEMBERS = 60;

/** 班级名长度上限（防止有人拿名字当留言板）。 */
const MAX_CLASS_NAME = 24;

/**
 * 入班码字母表：**去掉 0/O/1/I/L** 这些手抄会认错的字符。
 * 入班码是要念给一屋子学生、或者抄在黑板上的，认错一个字符就进不去。
 */
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const CODE_LEN = 6;

/** 排行榜口径。三个维度分开排，让不同禀赋的学生都有机会在某一条上靠前。 */
const METRICS = ['understand', 'persist', 'progress'];

const DAY_MS = 24 * 60 * 60 * 1000;

function bad(code, message) {
  const e = new Error(message || code);
  e.code = code;
  return e;
}

/** 生成入班码。crypto 取随机，避免 Math.random 在并发建班时撞码。 */
function genCode() {
  const n = CODE_ALPHABET.length;
  let out = '';
  for (let i = 0; i < CODE_LEN; i++) {
    // 拒绝采样：256 % 34 !== 0，直接取模会让前几个字符概率偏高。
    let b;
    do { b = crypto.randomBytes(1)[0]; } while (b >= Math.floor(256 / n) * n);
    out += CODE_ALPHABET[b % n];
  }
  return out;
}

function normalizeCode(raw) {
  return String(raw == null ? '' : raw).toUpperCase().replace(/[^0-9A-Z]/g, '');
}

function cleanName(raw) {
  const s = String(raw == null ? '' : raw).trim().replace(/\s+/g, ' ');
  if (!s) throw bad('BAD_NAME', '班级名不能为空');
  if (s.length > MAX_CLASS_NAME) throw bad('BAD_NAME', '班级名最多 ' + MAX_CLASS_NAME + ' 个字');
  return s;
}

/** 当天 0 点（服务器本地时区）的毫秒时间戳。与 daily/weekly 的"天"口径一致。 */
function startOfDay(ms) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * 本周起点：周一 00:00。
 * 用周一而不是周日，是因为学生的时间感是"周一到周日"（课表口径），
 * 周日当起点会让周日的活动算进"下周"。
 */
function startOfWeek(ms) {
  const d = new Date(startOfDay(ms));
  const dow = (d.getDay() + 6) % 7; // 周一=0 … 周日=6
  return d.getTime() - dow * DAY_MS;
}

// ---------------------------------------------------------------------------
// 班级
// ---------------------------------------------------------------------------

function createClass(ownerUserId, rawName) {
  if (!ownerUserId) throw bad('NO_ACCOUNT', '需要账号才能建班（空间口令登录没有身份）');
  const name = cleanName(rawName);

  // 入班码唯一性：撞了就重试。36^6 ≈ 2.2e9，实际几乎不会重试，
  // 但"几乎不会"不等于"不会" —— 唯一索引会直接抛错，必须自己兜。
  let code = null;
  for (let i = 0; i < 8 && !code; i++) {
    const c = genCode();
    if (!D.get('SELECT 1 FROM classes WHERE join_code = ?', c)) code = c;
  }
  if (!code) throw bad('CODE_EXHAUSTED', '入班码生成失败，请重试');

  const id = D.uid('cls_');
  D.run('INSERT INTO classes(id,name,join_code,owner_user_id,created_at,archived_at) VALUES(?,?,?,?,?,0)',
    id, name, code, ownerUserId, D.now());
  return { id, name, joinCode: code, ownerUserId, memberCount: 0 };
}

function getClass(classId) {
  const c = D.get('SELECT * FROM classes WHERE id = ?', classId);
  if (!c || c.archived_at) return null;
  return c;
}

function memberCount(classId) {
  const r = D.get('SELECT COUNT(*) AS n FROM class_members WHERE class_id = ?', classId);
  return r ? r.n : 0;
}

/**
 * 入班。返回 { class, already }。
 *
 * ★ 用**入班码**加入，不是班级 id：id 是内部标识，不该被学生看见或传播。
 * ★ 重复加入是**幂等**的（already=true），不报错 —— 学生重复输码是很正常的动作，
 *   报错会让人以为"没成功"而反复试。
 */
function joinClass(userId, spaceId, rawCode) {
  if (!userId) throw bad('NO_ACCOUNT', '需要账号才能加入班级');
  const code = normalizeCode(rawCode);
  if (code.length !== CODE_LEN) throw bad('BAD_CODE', '入班码是 ' + CODE_LEN + ' 位');
  const c = D.get('SELECT * FROM classes WHERE join_code = ?', code);
  if (!c || c.archived_at) throw bad('NOT_FOUND', '没有这个入班码，请和老师确认');

  const already = !!D.get('SELECT 1 FROM class_members WHERE class_id = ? AND user_id = ?', c.id, userId);
  if (already) {
    // 已经在班里：顺手把 space_id 刷成最新的（学生可能换过空间）。
    D.run('UPDATE class_members SET space_id = ? WHERE class_id = ? AND user_id = ?', spaceId, c.id, userId);
    return { class: shapeClass(c), already: true };
  }

  if (memberCount(c.id) >= MAX_CLASS_MEMBERS) {
    throw bad('CLASS_FULL', '这个班已经满 ' + MAX_CLASS_MEMBERS + ' 人');
  }
  D.run('INSERT INTO class_members(class_id,user_id,space_id,joined_at) VALUES(?,?,?,?)',
    c.id, userId, spaceId, D.now());
  return { class: shapeClass(c), already: false };
}

function leaveClass(userId, classId) {
  const c = getClass(classId);
  if (!c) throw bad('NOT_FOUND', '班级不存在');
  // ★ 建班人不能退出自己的班 —— 否则班级会变成没有 owner 的孤儿。
  //   要解散请用 archiveClass（保留数据，只标记归档）。
  if (c.owner_user_id === userId) throw bad('OWNER_CANNOT_LEAVE', '建班人不能退出，可以解散班级');
  D.run('DELETE FROM class_members WHERE class_id = ? AND user_id = ?', classId, userId);
  return { left: true };
}

function archiveClass(userId, classId) {
  const c = getClass(classId);
  if (!c) throw bad('NOT_FOUND', '班级不存在');
  if (c.owner_user_id !== userId) throw bad('FORBIDDEN', '只有建班人可以解散班级');
  D.run('UPDATE classes SET archived_at = ? WHERE id = ?', D.now(), classId);
  return { archived: true };
}

function shapeClass(c) {
  return {
    id: c.id,
    name: c.name,
    // ★ 只有建班人看得到入班码。学生看到码没有用，泄漏出去反而让别人能进来。
    joinCode: null,
    ownerUserId: c.owner_user_id,
    memberCount: memberCount(c.id),
    createdAt: c.created_at,
  };
}

/** 我参与的班级（我建的 + 我加入的）。 */
function myClasses(userId) {
  if (!userId) return [];
  const owned = D.all('SELECT * FROM classes WHERE owner_user_id = ? AND archived_at = 0 ORDER BY created_at DESC', userId);
  const joined = D.all(
    `SELECT c.* FROM classes c
       JOIN class_members m ON m.class_id = c.id
      WHERE m.user_id = ? AND c.archived_at = 0 AND c.owner_user_id <> ?
      ORDER BY m.joined_at DESC`, userId, userId);
  return owned.concat(joined).map(c => {
    const s = shapeClass(c);
    // 建班人自己能看到入班码（要念给学生）。
    if (c.owner_user_id === userId) s.joinCode = c.join_code;
    s.isOwner = c.owner_user_id === userId;
    return s;
  });
}

/**
 * 班级详情（含成员名单）。
 * ★ 成员名单只给**班内人**看 —— 不在班里的人拿着 id 也看不到谁在这个班。
 */
function classDetail(classId, viewerUserId) {
  const c = getClass(classId);
  if (!c) throw bad('NOT_FOUND', '班级不存在');
  const isOwner = c.owner_user_id === viewerUserId;
  const isMember = !!D.get('SELECT 1 FROM class_members WHERE class_id = ? AND user_id = ?', classId, viewerUserId);
  if (!isOwner && !isMember) throw bad('FORBIDDEN', '你不在这个班里');

  const rows = D.all(
    `SELECT m.user_id, m.joined_at, u.name
       FROM class_members m
       LEFT JOIN users u ON u.id = m.user_id
      WHERE m.class_id = ?
      ORDER BY m.joined_at ASC`, classId);
  return {
    id: c.id,
    name: c.name,
    isOwner,
    joinCode: isOwner ? c.join_code : null,
    memberCount: rows.length,
    members: rows.map(r => ({
      userId: r.user_id,
      name: displayName(r.name, r.user_id),
      joinedAt: r.joined_at,
    })),
  };
}

/**
 * 显示名。班级是封闭小圈子（同班同学本来就认识），所以**不做脱敏** ——
 * 这也是它跟"全校/全网榜"最本质的区别：那个榜才需要脱敏。
 * 没有名字时退回一个稳定但不可反查的短标识，绝不下发 phone / email。
 */
function displayName(name, userId) {
  const n = String(name == null ? '' : name).trim();
  if (n) return n;
  return '同学' + String(userId || '').slice(-4);
}

// ---------------------------------------------------------------------------
// 排行榜
// ---------------------------------------------------------------------------

/**
 * 一个成员在窗口内的原始账本。
 *
 * ★ 必须按 (space_id, user_id) 两列过滤：班级跨空间，光有 user_id 会串空间。
 *   这里用 `space_id = ? AND user_id = ?` 而不是只用 user_id，是本模块最容易写错、
 *   且错了**不会报错只会静默算错**的地方。
 */
function eventsOf(spaceId, userId, fromMs, toMs) {
  return D.all(
    `SELECT delta, created_at FROM pet_events
      WHERE space_id = ? AND user_id = ? AND created_at >= ? AND created_at < ?
      ORDER BY created_at ASC`,
    spaceId, userId, fromMs, toMs);
}

/** 最长连续"有推进"的天数。跨天按服务器本地时区切。 */
function longestStreak(days) {
  if (!days.length) return 0;
  let best = 1, cur = 1;
  for (let i = 1; i < days.length; i++) {
    // days 已去重升序。相邻两天相差恰好一天才算连续。
    if (days[i] - days[i - 1] === DAY_MS) { cur++; } else { cur = 1; }
    if (cur > best) best = cur;
  }
  return best;
}

/**
 * 算一个成员的三个维度。
 *
 * ★ null 与 0 的分界（本项目反复强调的一条）：
 *   · `understand` 恒为数字。0 的含义是"确实一次推进都没有" —— 这是**算得出来的 0**。
 *   · `persist` 同理，0 = 没有连续两天。
 *   · `progress` 在**两周都查不到任何账本行**时是 **null**，不是 0。
 *     null 的含义是"这个人还没开始学，谈不上进步" —— 把"没数据"算成"进步 0"
 *     等于替一个还没开始的人宣布"你原地踏步"，是捏造。
 *     只要有一周有账本，就按 本周 − 上周 算（缺的那周当 0，因为"那周他确实没推进"）。
 */
function memberMetrics(spaceId, userId, nowMs) {
  const weekStart = startOfWeek(nowMs);
  const prevWeekStart = weekStart - 7 * DAY_MS;

  const all = eventsOf(spaceId, userId, 0, nowMs);
  const understand = all.reduce((s, e) => s + e.delta, 0);

  const daySet = new Set();
  for (const e of all) daySet.add(startOfDay(e.created_at));
  const persist = longestStreak(Array.from(daySet).sort((a, b) => a - b));

  const thisWeek = eventsOf(spaceId, userId, weekStart, nowMs).reduce((s, e) => s + e.delta, 0);
  const lastWeek = eventsOf(spaceId, userId, prevWeekStart, weekStart).reduce((s, e) => s + e.delta, 0);
  const hasAny = all.length > 0;
  const progress = hasAny ? (thisWeek - lastWeek) : null;

  return { understand, persist, progress, thisWeek, lastWeek };
}

/**
 * 班级排行榜。
 *
 * @param {string} classId
 * @param {object} opts
 *   - metric: 'understand' | 'persist' | 'progress'（默认 understand）
 *   - viewerUserId: 谁在看（必须是班内人）
 *
 * ★ 只返回**班内成员**。不在班里的人一律 FORBIDDEN —— 排行榜的边界就是班级边界。
 * ★ 每个成员的成绩都**现算**：调两次、中间改原始记录，结果必须跟着变。
 */
function board(classId, opts) {
  const o = opts || {};
  const metric = METRICS.indexOf(o.metric) >= 0 ? o.metric : 'understand';
  const viewer = o.viewerUserId || null;

  const c = getClass(classId);
  if (!c) throw bad('NOT_FOUND', '班级不存在');
  const isOwner = c.owner_user_id === viewer;
  const isMember = !!D.get('SELECT 1 FROM class_members WHERE class_id = ? AND user_id = ?', classId, viewer);
  if (!isOwner && !isMember) throw bad('FORBIDDEN', '你不在这个班里');

  const rows = D.all(
    `SELECT m.user_id, m.space_id, m.joined_at, u.name
       FROM class_members m
       LEFT JOIN users u ON u.id = m.user_id
      WHERE m.class_id = ?`, classId);

  const nowMs = D.now();
  const members = rows.map(r => {
    const m = memberMetrics(r.space_id, r.user_id, nowMs);
    return {
      userId: r.user_id,
      name: displayName(r.name, r.user_id),
      joinedAt: r.joined_at,
      understand: m.understand,
      persist: m.persist,
      progress: m.progress,
      thisWeek: m.thisWeek,
      lastWeek: m.lastWeek,
    };
  });

  // 排序：按选中的维度降序。
  // ★ 该维度是 null 的一律排到最后（"算不出来"不该排在"确实是 0"前面，
  //   但也不该占着榜首 —— 它根本不是"低"，它是"未知"）。
  // ★ 并列时用 understand 再比一次，最后用 userId 保证顺序稳定
  //   （不稳定排序会让同一份数据每次刷新名次乱跳，看着像 bug）。
  members.sort((a, b) => {
    const av = a[metric], bv = b[metric];
    const aNull = av === null || av === undefined;
    const bNull = bv === null || bv === undefined;
    if (aNull !== bNull) return aNull ? 1 : -1;
    if (!aNull && bv !== av) return bv - av;
    if (b.understand !== a.understand) return b.understand - a.understand;
    return String(a.userId) < String(b.userId) ? -1 : 1;
  });

  // ★ 名次只给**有成绩的人**：0 分（或 null）的成员并列显示为"还没开始"，
  //   不参与名次编号。给一个 0 分的人发"第 37 名"是一种羞辱，而不是激励。
  let rank = 0;
  let lastVal = null;
  const entries = members.map((m, i) => {
    const v = m[metric];
    const isNull = v === null || v === undefined;
    const scored = !isNull && v > 0;
    if (scored && v !== lastVal) { rank = i + 1; lastVal = v; }
    return {
      userId: m.userId,
      name: m.name,
      understand: m.understand,
      persist: m.persist,
      progress: m.progress,
      // 名次：没成绩的人是 null（前端显示"还没开始"，不显示 0 名）
      rank: scored ? rank : null,
    };
  });

  return {
    classId: c.id,
    className: c.name,
    metric,
    memberCount: members.length,
    // 有成绩（该维度 > 0）的人数。前端用它决定要不要显示"还没开始"那一段。
    scoredCount: entries.filter(e => e.rank !== null).length,
    entries,
    computedAt: new Date(nowMs).toISOString(),
    weekStart: startOfWeek(nowMs),
  };
}

module.exports = {
  MAX_CLASS_MEMBERS, METRICS, CODE_LEN,
  createClass, getClass, memberCount, joinClass, leaveClass, archiveClass,
  myClasses, classDetail, board,
  // 导出给测试用（纯函数）
  startOfWeek, startOfDay, longestStreak, normalizeCode, displayName,
  memberMetrics,
};

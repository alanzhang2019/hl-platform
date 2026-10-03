'use strict';
/**
 * 管理员看板（2026-10-03）
 *
 * 立场：与 dashboard.js（学生侧看板）一致 —— 不做排名、不做焦虑指标。
 * 管理员要回答的其实只有两个问题：
 *   1. 平台在被用吗？谁在用？（量 + 活跃度）
 *   2. 具体聊了什么？（对话全文，用于发现问题、兜底合规）
 *
 * ★ 隐私边界：
 *   本模块的**所有出口**都只对 ADMIN_PASSWORD 鉴权的管理员开放（守卫在 server.js，
 *   必须放在"需要登录"闸门之前）。学生侧永远看不到别人的空间 —— 跨空间可见性
 *   只存在于这里，也只给管理员。
 *
 * ★ 为什么 mode 分布会有一段"未知"：
 *   对话模式（自学/引导/深研）以前只进 system prompt，**没有落库**。
 *   2026-10-03 起才写进 messages.meta_json。所以看板如实把更早的消息记为
 *   unknown，不假装有历史数据 —— 这是"先量后定"的前提，数字得是真的。
 */
const D = require('./db');

const DAY = 24 * 60 * 60 * 1000;

// ---------- 小工具 ----------
function clampInt(v, min, max, dflt) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(min, Math.min(max, Math.floor(n)));
}
function safeJSON(s) {
  if (!s) return null;
  if (typeof s === 'object') return s;
  try { return JSON.parse(s); } catch (e) { return null; }
}
function dayKey(ts) {
  const d = new Date(ts);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function startOfDay(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
/**
 * 按天分桶。
 * ★ 用 JS 分桶而不是 SQL 的 strftime(...,'localtime')：
 *   容器的 TZ 不保证是 +08，localtime 会把凌晨的消息算到前一天，
 *   而 dayKey 用的是 Node 进程时区 —— 两套口径混用必然对不上。
 */
function bucketByDay(rows, n) {
  const today = startOfDay(D.now());
  const from = today - (n - 1) * DAY;
  const buckets = {};
  for (let i = 0; i < n; i++) {
    const t = from + i * DAY;
    buckets[dayKey(t)] = { date: dayKey(t), at: t, messages: 0, userMessages: 0, _spaces: {}, _convs: {} };
  }
  rows.forEach(r => {
    const b = buckets[dayKey(r.at)];
    if (!b) return;
    b.messages++;
    if (r.role === 'user') b.userMessages++;
    if (r.spaceId) b._spaces[r.spaceId] = 1;
    if (r.convId) b._convs[r.convId] = 1;
  });
  return Object.keys(buckets).sort().map(k => {
    const b = buckets[k];
    return {
      date: b.date, at: b.at,
      messages: b.messages, userMessages: b.userMessages,
      activeSpaces: Object.keys(b._spaces).length,
      conversations: Object.keys(b._convs).length,
    };
  });
}
function count(sql, ...p) {
  return (D.get(sql, ...p) || {}).c || 0;
}

// ---------- 1. 总览 ----------
/**
 * 平台总览。
 * @param {{days?:number}} opt days = 曲线与"近期活跃"的窗口天数（1..90，默认 14）
 */
function overview(opt) {
  const n = clampInt(opt && opt.days, 1, 90, 14);
  const from = startOfDay(D.now()) - (n - 1) * DAY;
  const now = D.now();

  const totals = {
    spaces: count('SELECT COUNT(*) c FROM spaces'),
    users: count('SELECT COUNT(*) c FROM users'),
    conversations: count('SELECT COUNT(*) c FROM conversations'),
    messages: count('SELECT COUNT(*) c FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE m.deleted = 0'),
    cards: count('SELECT COUNT(*) c FROM cards'),
    documents: count('SELECT COUNT(*) c FROM kb_documents'),
    memories: count('SELECT COUNT(*) c FROM memories'),
  };

  // 活跃空间：窗口内有消息的空间数。用消息而不是 activity 表 ——
  // activity 只在部分动作里记（对话、复习、传资料），消息是最不会漏的口径。
  const activeInWindow = count(
    'SELECT COUNT(DISTINCT c.space_id) c FROM messages m JOIN conversations c ON c.id = m.conversation_id ' +
    'WHERE m.deleted = 0 AND m.created_at >= ?', from);
  const activeToday = count(
    'SELECT COUNT(DISTINCT c.space_id) c FROM messages m JOIN conversations c ON c.id = m.conversation_id ' +
    'WHERE m.deleted = 0 AND m.created_at >= ?', startOfDay(now));
  const active7 = count(
    'SELECT COUNT(DISTINCT c.space_id) c FROM messages m JOIN conversations c ON c.id = m.conversation_id ' +
    'WHERE m.deleted = 0 AND m.created_at >= ?', now - 7 * DAY);
  const active30 = count(
    'SELECT COUNT(DISTINCT c.space_id) c FROM messages m JOIN conversations c ON c.id = m.conversation_id ' +
    'WHERE m.deleted = 0 AND m.created_at >= ?', now - 30 * DAY);

  // 日曲线：一次拉窗口内的消息（只取分桶要用的四列，不碰 content 大字段）
  const rows = D.all(
    'SELECT m.created_at at, m.role role, c.space_id spaceId, m.conversation_id convId ' +
    'FROM messages m JOIN conversations c ON c.id = m.conversation_id ' +
    'WHERE m.deleted = 0 AND m.created_at >= ?', from);
  const daily = bucketByDay(rows, n);

  // 窗口内 vs 上一个等长窗口 —— "这周比上周多做了还是少做了"
  const prevFrom = from - n * DAY;
  const winMessages = count('SELECT COUNT(*) c FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE m.deleted = 0 AND m.created_at >= ?', from);
  const prevMessages = count('SELECT COUNT(*) c FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE m.deleted = 0 AND m.created_at >= ? AND m.created_at < ?', prevFrom, from);

  const modes = modeDistribution(from);

  const kinds = {};
  D.all('SELECT kind, COUNT(*) c FROM activity WHERE at >= ? GROUP BY kind ORDER BY c DESC', from)
    .forEach(r => { kinds[r.kind] = r.c; });

  const topSpaces = D.all(
    'SELECT c.space_id spaceId, s.name name, COUNT(*) msgs, COUNT(DISTINCT c.id) convs ' +
    'FROM messages m JOIN conversations c ON c.id = m.conversation_id ' +
    'LEFT JOIN spaces s ON s.id = c.space_id ' +
    'WHERE m.deleted = 0 AND m.created_at >= ? ' +
    'GROUP BY c.space_id ORDER BY msgs DESC LIMIT 10', from)
    .map(r => ({ spaceId: r.spaceId, name: r.name || r.spaceId, messages: r.msgs, conversations: r.convs }));

  const recent = D.all(
    'SELECT c.id, c.space_id spaceId, s.name spaceName, c.title, c.model, c.created_at createdAt, c.updated_at updatedAt, ' +
    '(SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id AND m.deleted = 0) messages ' +
    'FROM conversations c LEFT JOIN spaces s ON s.id = c.space_id ' +
    'ORDER BY c.updated_at DESC LIMIT 12')
    .map(r => ({
      id: r.id, spaceId: r.spaceId, spaceName: r.spaceName || r.spaceId,
      title: r.title, model: r.model || '', messages: r.messages,
      createdAt: r.createdAt, updatedAt: r.updatedAt,
    }));

  return {
    window: { days: n, from: from, to: now },
    totals: totals,
    active: { today: activeToday, inWindow: activeInWindow, days7: active7, days30: active30 },
    compare: {
      messages: winMessages, prevMessages: prevMessages,
      delta: winMessages - prevMessages,
      deltaPct: prevMessages ? Math.round((winMessages - prevMessages) / prevMessages * 100) : null,
    },
    daily: daily,
    modes: modes,
    activityKinds: kinds,
    topSpaces: topSpaces,
    recentConversations: recent,
  };
}

/**
 * 对话模式分布（自学引导 / 费曼学习法 / 学情诊断）。
 *
 * ★ JSON 路径必须用**单引号**：SQLite 里双引号是"标识符引用"，
 *   json_extract(meta_json, "$.mode") 在有些版本会被当成列名而报错。
 *   单引号才是字符串字面量，语义确定。
 * ★ 优先用 SQLite 的 json_extract；万一这个构建没带 JSON 函数，
 *   回落到 JS 解析 —— 统计功能不该因为一个 SQL 方言差异整个挂掉。
 */
function modeDistribution(from, spaceId) {
  const out = {};
  const scope = spaceId
    ? { sql: ' AND conversation_id IN (SELECT id FROM conversations WHERE space_id = ?) ', params: [spaceId] }
    : { sql: ' ', params: [] };
  let rows = [];
  try {
    rows = D.all(
      "SELECT json_extract(meta_json, '$.mode') k, COUNT(*) c FROM messages " +
      'WHERE role = ? AND deleted = 0 AND created_at >= ? AND meta_json IS NOT NULL' + scope.sql + 'GROUP BY k',
      'assistant', from, ...scope.params);
  } catch (e) {
    D.all('SELECT meta_json FROM messages WHERE role = ? AND deleted = 0 AND created_at >= ? AND meta_json IS NOT NULL' + scope.sql,
      'assistant', from, ...scope.params)
      .forEach(r => {
        const m = safeJSON(r.meta_json) || {};
        rows.push({ k: m.mode || null, c: 1 });
      });
  }
  // ★ 没有 mode 的一律归到 untracked，不留一个并列的 unknown：
  //   两个桶都表示"没记录"，同批消息会被数两遍（实测 198 + 198 其实是同一批 198 条），
  //   管理员会以为总量翻倍。一个语义只该有一个名字。
  rows.forEach(r => {
    const key = r.k || 'untracked';
    out[key] = (out[key] || 0) + r.c;
  });

  // 另一半是"连 meta_json 都没有"的老消息 —— 也归到 untracked。
  // ★ 上面那批的口径是 meta_json IS NOT NULL，这里的口径必须严格互补：
  //   只数 meta_json IS NULL。多写一个 "OR json_extract(...) IS NULL"
  //   就会把上面已数过的行再数一遍（198 变 396，总量凭空翻倍）。
  let legacy = 0;
  try {
    legacy = count('SELECT COUNT(*) c FROM messages WHERE role = ? AND deleted = 0 AND created_at >= ? AND meta_json IS NULL' + scope.sql,
      'assistant', from, ...scope.params);
  } catch (e) { legacy = 0; }
  if (legacy) out.untracked = (out.untracked || 0) + legacy;
  return out;
}

// ---------- 2. 空间使用明细 ----------
function spaceUsage(opt) {
  const n = clampInt(opt && opt.days, 1, 90, 14);
  const from = startOfDay(D.now()) - (n - 1) * DAY;

  const rows = D.all('SELECT * FROM spaces ORDER BY last_at DESC, id ASC');
  const map = (sql, ...p) => {
    const m = {};
    D.all(sql, ...p).forEach(r => { m[r.sid] = r.c; });
    return m;
  };
  const convs = map('SELECT space_id sid, COUNT(*) c FROM conversations GROUP BY space_id');
  const msgs = map('SELECT c.space_id sid, COUNT(*) c FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE m.deleted = 0 GROUP BY c.space_id');
  const recent = map('SELECT c.space_id sid, COUNT(*) c FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE m.deleted = 0 AND m.created_at >= ? GROUP BY c.space_id', from);
  const cards = map('SELECT space_id sid, COUNT(*) c FROM cards GROUP BY space_id');
  const users = map('SELECT space_id sid, COUNT(*) c FROM users GROUP BY space_id');
  const lastMsg = {};
  D.all('SELECT c.space_id sid, MAX(m.created_at) t FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE m.deleted = 0 GROUP BY c.space_id')
    .forEach(r => { lastMsg[r.sid] = r.t; });

  return rows.map(r => ({
    spaceId: r.id,
    name: r.name,
    tier: r.tier,
    hasPasscode: !!r.passcode,
    isDefault: r.id === '_public',
    conversations: convs[r.id] || 0,
    messages: msgs[r.id] || 0,
    recentMessages: recent[r.id] || 0,
    cards: cards[r.id] || 0,
    users: users[r.id] || 0,
    createdAt: r.created_at,
    lastAt: r.last_at || r.created_at,
    lastMessageAt: lastMsg[r.id] || 0,
  }));
}

/** 单个空间的详细使用情况 */
function spaceDetail(spaceId, opt) {
  const sid = D.normalizeSpace(spaceId);
  const sp = D.get('SELECT * FROM spaces WHERE id = ?', sid);
  if (!sp) { const e = new Error('空间不存在'); e.code = 'NOT_FOUND'; throw e; }
  const n = clampInt(opt && opt.days, 1, 90, 14);
  const from = startOfDay(D.now()) - (n - 1) * DAY;

  const rows = D.all(
    'SELECT m.created_at at, m.role role, c.space_id spaceId, m.conversation_id convId ' +
    'FROM messages m JOIN conversations c ON c.id = m.conversation_id ' +
    'WHERE m.deleted = 0 AND c.space_id = ? AND m.created_at >= ?', sid, from);

  const kinds = {};
  D.all('SELECT kind, COUNT(*) c FROM activity WHERE space_id = ? AND at >= ? GROUP BY kind ORDER BY c DESC', sid, from)
    .forEach(r => { kinds[r.kind] = r.c; });

  const convs = D.all(
    'SELECT c.id, c.title, c.model, c.created_at createdAt, c.updated_at updatedAt, ' +
    '(SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id AND m.deleted = 0) messages ' +
    'FROM conversations c WHERE c.space_id = ? ORDER BY c.updated_at DESC LIMIT 50', sid)
    .map(r => ({ id: r.id, title: r.title, model: r.model || '', messages: r.messages, createdAt: r.createdAt, updatedAt: r.updatedAt }));

  const users = D.all('SELECT id, name, username, role, grade, stage, created_at createdAt FROM users WHERE space_id = ? ORDER BY created_at ASC', sid)
    .map(u => ({ id: u.id, name: u.name || '', username: u.username || '', role: u.role || 'student', grade: u.grade || '', stage: u.stage || '', createdAt: u.createdAt }));

  return {
    space: {
      spaceId: sp.id, name: sp.name, tier: sp.tier, hasPasscode: !!sp.passcode,
      createdAt: sp.created_at, lastAt: sp.last_at || sp.created_at,
    },
    totals: {
      conversations: count('SELECT COUNT(*) c FROM conversations WHERE space_id = ?', sid),
      messages: count('SELECT COUNT(*) c FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.space_id = ? AND m.deleted = 0', sid),
      cards: count('SELECT COUNT(*) c FROM cards WHERE space_id = ?', sid),
      documents: count('SELECT COUNT(*) c FROM kb_documents WHERE space_id = ?', sid),
      memories: count('SELECT COUNT(*) c FROM memories WHERE space_id = ?', sid),
    },
    daily: bucketByDay(rows, n),
    activityKinds: kinds,
    modes: modeDistribution(from, sid),
    conversations: convs,
    users: users,
  };
}

// ---------- 3. 对话列表 ----------
/**
 * 对话列表（可按空间过滤、按关键词搜索）。
 * q 同时搜标题与消息正文 —— 管理员常见的诉求是"哪个孩子问过这个"。
 */
function listConversations(opt) {
  const o = opt || {};
  const lim = clampInt(o.limit, 1, 200, 50);
  const off = clampInt(o.offset, 0, 1000000, 0);
  const where = [];
  const params = [];
  if (o.spaceId) { where.push('c.space_id = ?'); params.push(D.normalizeSpace(o.spaceId)); }
  if (o.q) {
    where.push('(c.title LIKE ? OR EXISTS (SELECT 1 FROM messages m2 WHERE m2.conversation_id = c.id AND m2.deleted = 0 AND m2.content LIKE ?))');
    params.push('%' + o.q + '%', '%' + o.q + '%');
  }
  const whereSQL = where.length ? 'WHERE ' + where.join(' AND ') + ' ' : '';

  const rows = D.all(
    'SELECT c.id, c.space_id spaceId, s.name spaceName, c.title, c.model, c.agent_id agentId, ' +
    'c.created_at createdAt, c.updated_at updatedAt, ' +
    '(SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id AND m.deleted = 0) messages, ' +
    '(SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id AND m.deleted = 0 AND m.role = ?) userMessages ' +
    'FROM conversations c LEFT JOIN spaces s ON s.id = c.space_id ' + whereSQL +
    'ORDER BY c.updated_at DESC LIMIT ? OFFSET ?',
    'user', ...params, lim, off);

  const total = count('SELECT COUNT(*) c FROM conversations c ' + whereSQL, ...params);

  return {
    total: total,
    limit: lim,
    offset: off,
    conversations: rows.map(r => ({
      id: r.id, spaceId: r.spaceId, spaceName: r.spaceName || r.spaceId,
      title: r.title, model: r.model || '', agentId: r.agentId || '',
      messages: r.messages, userMessages: r.userMessages,
      createdAt: r.createdAt, updatedAt: r.updatedAt,
    })),
  };
}

// ---------- 4. 对话全文 ----------
/**
 * 一条对话的全部消息。
 *
 * ★ 软删除的消息也返回，但带 deleted 标记 —— 这是管理员审计工具，
 *   "学生删掉的"恰恰是管理员最需要看到的部分。前端用灰底 + 角标区分。
 */
function conversationDetail(id, opt) {
  const o = opt || {};
  const conv = D.get(
    'SELECT c.*, s.name spaceName FROM conversations c LEFT JOIN spaces s ON s.id = c.space_id WHERE c.id = ?', id);
  if (!conv) { const e = new Error('对话不存在'); e.code = 'NOT_FOUND'; throw e; }

  // ★ 必须带 rowid 兜底：存量数据里 seq 全是 0（core.addMessage 的老 bug，
  //   2026-10-03 已修，但已写入的行不会自己变）。纯按 seq 排时这些行是并列 0，
  //   顺序由 SQLite 自由决定 —— 加 rowid 才是它们真实的先后。
  const rows = D.all(
    'SELECT id, seq, role, content, status, model, reasoning, meta_json, attachments_json, deleted, created_at ' +
    'FROM messages WHERE conversation_id = ? ORDER BY seq ASC, rowid ASC', id);

  const messages = rows
    .filter(m => o.includeDeleted || !m.deleted)
    .map(m => ({
      id: m.id, seq: m.seq, role: m.role,
      content: m.content || '',
      status: m.status || 'done',
      model: m.model || '',
      reasoning: m.reasoning || '',
      deleted: !!m.deleted,
      attachments: safeJSON(m.attachments_json) || [],
      meta: safeJSON(m.meta_json) || null,
      createdAt: m.created_at,
    }));

  return {
    conversation: {
      id: conv.id, spaceId: conv.space_id, spaceName: conv.spaceName || conv.space_id,
      title: conv.title, model: conv.model || '', instructions: conv.instructions || '',
      agentId: conv.agent_id || '', webSearch: !!conv.web_search,
      projectId: conv.project_id || null,
      createdAt: conv.created_at, updatedAt: conv.updated_at,
    },
    counts: {
      total: rows.length,
      shown: messages.length,
      deleted: rows.filter(m => m.deleted).length,
    },
    messages: messages,
  };
}

// ---------- 5. 导出 ----------
function pad2(n) { return String(n).padStart(2, '0'); }
function stamp(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) +
    ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
}
const ROLE_LABEL = { user: '学生', assistant: 'AI', system: '系统' };

/** 把一条对话导成 Markdown（管理员留档 / 排查用） */
function exportConversation(id) {
  const d = conversationDetail(id, { includeDeleted: true });
  const c = d.conversation;
  const lines = [];
  lines.push('# 对话导出：' + (c.title || '未命名'));
  lines.push('');
  lines.push('- 空间：' + c.spaceName + '（`' + c.spaceId + '`）');
  lines.push('- 对话 ID：`' + c.id + '`');
  lines.push('- 模型：' + (c.model || '—'));
  lines.push('- 创建：' + stamp(c.createdAt));
  lines.push('- 最后更新：' + stamp(c.updatedAt));
  lines.push('- 消息数：' + d.counts.total + (d.counts.deleted ? '（其中已删除 ' + d.counts.deleted + ' 条）' : ''));
  lines.push('');
  lines.push('---');
  lines.push('');
  d.messages.forEach((m, i) => {
    lines.push('## ' + (i + 1) + '. ' + (ROLE_LABEL[m.role] || m.role) + ' · ' + stamp(m.createdAt) +
      (m.deleted ? ' 〔已删除〕' : ''));
    lines.push('');
    lines.push(m.content || '（空）');
    if (m.attachments && m.attachments.length) {
      lines.push('');
      lines.push('附件：' + m.attachments.map(a => a.name || a.id).join('、'));
    }
    lines.push('');
  });
  return { filename: '对话_' + (c.spaceName || c.spaceId) + '_' + (c.title || c.id) + '.md', markdown: lines.join('\n') };
}

module.exports = {
  overview, spaceUsage, spaceDetail, listConversations, conversationDetail, exportConversation,
};

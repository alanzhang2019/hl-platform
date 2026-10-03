'use strict';
/**
 * 业务核心：会话 / 消息 / 项目 / 记忆 / 分享 / 活动流水
 * 所有查询强制带 space_id —— 沿用旧版的空间隔离模型，杜绝跨空间泄漏。
 */
const D = require('./db');

// ---------- 活动流水（日报/周报/曲线的原料）----------
function logActivity(spaceId, userId, kind, refId, meta) {
  D.run('INSERT INTO activity(space_id,user_id,kind,ref_id,meta_json,at) VALUES(?,?,?,?,?,?)',
    spaceId, userId || null, kind, refId || null, meta ? JSON.stringify(meta) : null, D.now());
}

// ---------- 项目 ----------
function listProjects(spaceId) {
  const rows = D.all('SELECT * FROM projects WHERE space_id = ? ORDER BY updated_at DESC', spaceId);
  return rows.map(p => ({
    id: p.id, name: p.name, instructions: p.instructions,
    docs: D.all('SELECT d.id, d.filename FROM project_docs pd JOIN kb_documents d ON d.id = pd.doc_id WHERE pd.project_id = ?', p.id)
      .map(r => ({ id: r.id, filename: r.filename })),
    conversationCount: (D.get('SELECT COUNT(*) c FROM conversations WHERE project_id = ?', p.id) || {}).c || 0,
    createdAt: p.created_at, updatedAt: p.updated_at,
  }));
}

function createProject(spaceId, { name, instructions, docIds }) {
  const nm = String(name || '').trim().slice(0, 40) || '新项目';
  const id = D.uid('p_');
  D.run('INSERT INTO projects(id,space_id,name,instructions,created_at,updated_at) VALUES(?,?,?,?,?,?)',
    id, spaceId, nm, String(instructions || '').slice(0, 2000), D.now(), D.now());
  // 新建时就带上资料：前端弹窗里勾完直接建，不用"先建项目再回头挂"两步。
  if (Array.isArray(docIds)) setProjectDocs(spaceId, id, docIds);
  return getProject(spaceId, id);
}

/**
 * 项目 ↔ 资料：先清后插（幂等，重复提交同一份清单结果一致）。
 *
 * ★ 必须校验 docId 属于本空间。`project_docs` 只有 (project_id, doc_id) 两列，**没有 space_id**，
 *   不校验就能把别的空间的 doc_id 塞进来；而 `listProjects()` 里的 JOIN 只按 project_id 过滤，
 *   于是别人的文件名会显示在自己的项目卡片上。
 */
function setProjectDocs(spaceId, projectId, docIds) {
  D.run('DELETE FROM project_docs WHERE project_id = ?', projectId);
  const ids = Array.from(new Set((docIds || []).map(x => String(x || '')).filter(Boolean)));
  if (!ids.length) return;
  const holder = ids.map(() => '?').join(',');
  const mine = D.all('SELECT id FROM kb_documents WHERE space_id = ? AND id IN (' + holder + ')', spaceId, ...ids);
  mine.forEach(r => D.run('INSERT OR IGNORE INTO project_docs(project_id,doc_id) VALUES(?,?)', projectId, r.id));
}

function getProject(spaceId, id) {
  const p = D.get('SELECT * FROM projects WHERE id = ? AND space_id = ?', id, spaceId);
  if (!p) return null;
  return listProjects(spaceId).find(x => x.id === id) || null;
}

function updateProject(spaceId, id, patch) {
  const p = D.get('SELECT * FROM projects WHERE id = ? AND space_id = ?', id, spaceId);
  if (!p) { const e = new Error('项目不存在'); e.code = 'NOT_FOUND'; throw e; }
  if (patch.name !== undefined) D.run('UPDATE projects SET name = ? WHERE id = ?', String(patch.name).trim().slice(0, 40) || p.name, id);
  if (patch.instructions !== undefined) D.run('UPDATE projects SET instructions = ? WHERE id = ?', String(patch.instructions).slice(0, 2000), id);
  if (Array.isArray(patch.docIds)) setProjectDocs(spaceId, id, patch.docIds);
  D.run('UPDATE projects SET updated_at = ? WHERE id = ?', D.now(), id);
  return getProject(spaceId, id);
}

function deleteProject(spaceId, id) {
  const p = D.get('SELECT 1 FROM projects WHERE id = ? AND space_id = ?', id, spaceId);
  if (!p) return false;
  D.run('DELETE FROM project_docs WHERE project_id = ?', id);
  D.run('DELETE FROM projects WHERE id = ?', id);
  D.run('UPDATE conversations SET project_id = NULL WHERE project_id = ? AND space_id = ?', id, spaceId);
  return true;
}

// ---------- 会话 ----------
function listConversations(spaceId, { projectId, favorite, q } = {}) {
  let sql = 'SELECT * FROM conversations WHERE space_id = ?';
  const p = [spaceId];
  if (projectId !== undefined) { sql += ' AND project_id IS ?'; p.push(projectId || null); }
  if (favorite) sql += ' AND is_favorite = 1';
  if (q) { sql += ' AND title LIKE ?'; p.push('%' + String(q).slice(0, 40) + '%'); }
  sql += ' ORDER BY updated_at DESC LIMIT 200';
  return D.all(sql, ...p).map(c => ({
    id: c.id, title: c.title, projectId: c.project_id, model: c.model,
    agentId: c.agent_id || '', webSearch: !!c.web_search,
    isFavorite: !!c.is_favorite, instructions: c.instructions,
    createdAt: c.created_at, updatedAt: c.updated_at,
    messageCount: (D.get('SELECT COUNT(*) c FROM messages WHERE conversation_id = ? AND deleted = 0', c.id) || {}).c || 0,
  }));
}

function createConversation(spaceId, userId, { title, projectId, model, instructions, agentId, webSearch } = {}) {
  const id = D.uid('c_');
  D.run(`INSERT INTO conversations(id,space_id,user_id,project_id,title,model,instructions,agent_id,web_search,created_at,updated_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
    id, spaceId, userId || null, projectId || null,
    String(title || '新对话').slice(0, 60), String(model || 'default'), String(instructions || '').slice(0, 2000),
    agentId || null, webSearch ? 1 : 0, D.now(), D.now());
  logActivity(spaceId, userId, 'chat', id);
  return getConversation(spaceId, id);
}

function getConversation(spaceId, id) {
  const c = D.get('SELECT * FROM conversations WHERE id = ? AND space_id = ?', id, spaceId);
  if (!c) return null;
  return {
    id: c.id, title: c.title, projectId: c.project_id, model: c.model,
    instructions: c.instructions, isFavorite: !!c.is_favorite,
    agentId: c.agent_id || '', webSearch: !!c.web_search,
    createdAt: c.created_at, updatedAt: c.updated_at,
  };
}

function updateConversation(spaceId, id, patch) {
  const c = D.get('SELECT * FROM conversations WHERE id = ? AND space_id = ?', id, spaceId);
  if (!c) { const e = new Error('对话不存在'); e.code = 'NOT_FOUND'; throw e; }
  if (patch.title !== undefined) D.run('UPDATE conversations SET title = ? WHERE id = ?', String(patch.title).trim().slice(0, 60) || c.title, id);
  if (patch.model !== undefined) D.run('UPDATE conversations SET model = ? WHERE id = ?', String(patch.model), id);
  if (patch.instructions !== undefined) D.run('UPDATE conversations SET instructions = ? WHERE id = ?', String(patch.instructions).slice(0, 2000), id);
  if (patch.isFavorite !== undefined) D.run('UPDATE conversations SET is_favorite = ? WHERE id = ?', !!patch.isFavorite, id);
  if (patch.projectId !== undefined) D.run('UPDATE conversations SET project_id = ? WHERE id = ?', patch.projectId || null, id);
  if (patch.agentId !== undefined) D.run('UPDATE conversations SET agent_id = ? WHERE id = ?', patch.agentId || null, id);
  if (patch.webSearch !== undefined) D.run('UPDATE conversations SET web_search = ? WHERE id = ?', patch.webSearch ? 1 : 0, id);
  D.run('UPDATE conversations SET updated_at = ? WHERE id = ?', D.now(), id);
  return getConversation(spaceId, id);
}

function deleteConversation(spaceId, id) {
  const c = D.get('SELECT 1 FROM conversations WHERE id = ? AND space_id = ?', id, spaceId);
  if (!c) return false;
  // 对话级临时资料随对话一起走 —— 这是"聊完不留垃圾"的关键：
  // 学生传的卷子不该在他删掉这条对话之后还躺在磁盘上。
  const temps = D.all('SELECT id, storage_path FROM kb_documents WHERE space_id = ? AND conversation_id = ? AND COALESCE(scope,\'kb\') = ?', spaceId, id, 'temp');
  temps.forEach(t => {
    if (t.storage_path) { try { require('fs').unlinkSync(t.storage_path); } catch (e) {} }
    D.run('DELETE FROM project_docs WHERE doc_id = ?', t.id);
    D.run('DELETE FROM kb_documents WHERE id = ?', t.id);
  });
  D.run('DELETE FROM messages WHERE conversation_id = ?', id);
  D.run('DELETE FROM jobs WHERE conversation_id = ?', id);
  D.run('DELETE FROM shares WHERE kind = ? AND target_id = ?', 'conversation', id);
  D.run('DELETE FROM conversations WHERE id = ?', id);
  return true;
}

// ---------- 消息 ----------
function shapeMessage(m) {
  return {
    id: m.id, role: m.role, content: m.content,
    reasoning: m.reasoning || '',
    blocks: m.blocks_json ? safeJSON(m.blocks_json) : null,
    meta: m.meta_json ? safeJSON(m.meta_json) : null,
    attachments: m.attachments_json ? safeJSON(m.attachments_json) : null,
    translated: m.translated_json ? safeJSON(m.translated_json) : null,
    isFavorite: !!m.is_favorite,
    status: m.status || 'done',
    deleted: !!m.deleted,
    editedAt: m.edited_at || 0,
    model: m.model, createdAt: m.created_at, seq: m.seq,
  };
}

function listMessages(spaceId, conversationId, opts) {
  const o = opts || {};
  const c = D.get('SELECT 1 FROM conversations WHERE id = ? AND space_id = ?', conversationId, spaceId);
  if (!c) return null;
  const sql = 'SELECT * FROM messages WHERE conversation_id = ?' + (o.includeDeleted ? '' : ' AND deleted = 0') + ' ORDER BY seq ASC';
  return D.all(sql, conversationId).map(shapeMessage);
}

function getMessage(spaceId, id) {
  const m = D.get('SELECT m.* FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE m.id = ? AND c.space_id = ?', id, spaceId);
  return m ? shapeMessage(m) : null;
}

function safeJSON(s) { try { return JSON.parse(s); } catch (e) { return null; } }

function addMessage(spaceId, conversationId, { role, content, blocks, model, tokensIn, tokensOut, status, meta, attachments, clientId }) {
  const c = D.get('SELECT * FROM conversations WHERE id = ? AND space_id = ?', conversationId, spaceId);
  if (!c) { const e = new Error('对话不存在'); e.code = 'NOT_FOUND'; throw e; }
  const r = D.get('SELECT COALESCE(MAX(seq),-1) m FROM messages WHERE conversation_id = ?', conversationId);
  // ★ 判空不能用真值判断，必须用 Number.isFinite：
  //   原来写的是 (Number(r && r.m) || -1) + 1，而 MAX(seq)=0 时 Number(0) 是 0，
  //   0 是 falsy —— `|| -1` 把它回退成 -1，于是第二条消息的 seq 又算成 0。
  //   结果全表 seq 永远停在 0（线上实测 409 条消息 seq 全是 0，看板里每条都显示 #0）。
  //   0 是一个完全合法的序号，不能被当成"没取到"。
  const seq = (r && Number.isFinite(Number(r.m)) ? Number(r.m) : -1) + 1;
  const id = D.uid('m_');
  D.run(`INSERT INTO messages(id,conversation_id,seq,role,content,blocks_json,model,tokens_in,tokens_out,status,meta_json,attachments_json,client_id,created_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id, conversationId, seq, role, String(content || ''), blocks ? JSON.stringify(blocks) : null,
    model || null, tokensIn || 0, tokensOut || 0, status || 'done',
    meta ? JSON.stringify(meta) : null, attachments ? JSON.stringify(attachments) : null,
    clientId || null, D.now());
  D.run('UPDATE conversations SET updated_at = ? WHERE id = ?', D.now(), conversationId);
  // 首条用户消息自动当标题
  if (role === 'user' && c.title === '新对话') {
    D.run('UPDATE conversations SET title = ? WHERE id = ?', String(content || '').replace(/\s+/g, ' ').slice(0, 24), conversationId);
  }
  return { id, seq, createdAt: D.now(), status: status || 'done' };
}

/** 流式回写：把已生成的内容存进占位行，断流也不丢 */
function appendMessageContent(spaceId, messageId, content, patch) {
  const m = D.get('SELECT m.* FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE m.id = ? AND c.space_id = ?', messageId, spaceId);
  if (!m) return null;
  D.run('UPDATE messages SET content = ? WHERE id = ?', String(content || ''), messageId);
  if (patch && patch.status) D.run('UPDATE messages SET status = ? WHERE id = ?', patch.status, messageId);
  if (patch && patch.meta) D.run('UPDATE messages SET meta_json = ? WHERE id = ?', JSON.stringify(patch.meta), messageId);
  // 思考过程单独一列：正文会被这个函数反复覆盖，两者挤在同一列会互相冲掉。
  if (patch && patch.reasoning !== undefined) D.run('UPDATE messages SET reasoning = ? WHERE id = ?', String(patch.reasoning || ''), messageId);
  return true;
}

function updateMessage(spaceId, id, patch) {
  const m = D.get('SELECT m.* FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE m.id = ? AND c.space_id = ?', id, spaceId);
  if (!m) return null;
  if (patch.content !== undefined) {
    D.run('UPDATE messages SET content = ?, edited_at = ? WHERE id = ?', String(patch.content), D.now(), id);
  }
  if (patch.isFavorite !== undefined) D.run('UPDATE messages SET is_favorite = ? WHERE id = ?', patch.isFavorite ? 1 : 0, id);
  if (patch.translated !== undefined) D.run('UPDATE messages SET translated_json = ? WHERE id = ?', patch.translated ? JSON.stringify(patch.translated) : null, id);
  if (patch.status !== undefined) D.run('UPDATE messages SET status = ? WHERE id = ?', String(patch.status), id);
  if (patch.meta !== undefined) D.run('UPDATE messages SET meta_json = ? WHERE id = ?', patch.meta ? JSON.stringify(patch.meta) : null, id);
  if (patch.attachments !== undefined) D.run('UPDATE messages SET attachments_json = ? WHERE id = ?', patch.attachments ? JSON.stringify(patch.attachments) : null, id);
  return getMessage(spaceId, id);
}

/** 软删除：从上下文里摘掉，但留痕（审计 + 误删可救） */
function deleteMessage(spaceId, id) {
  const m = D.get('SELECT m.* FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE m.id = ? AND c.space_id = ?', id, spaceId);
  if (!m) return false;
  D.run('UPDATE messages SET deleted = 1 WHERE id = ?', id);
  return true;
}

function findByClientId(spaceId, conversationId, clientId) {
  if (!clientId) return null;
  const m = D.get('SELECT m.* FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE m.conversation_id = ? AND m.client_id = ? AND c.space_id = ?', conversationId, clientId, spaceId);
  return m ? shapeMessage(m) : null;
}

/** 找最后一条助手消息 —— 重新生成 / 断流恢复都要用它 */
function lastAssistant(spaceId, conversationId) {
  const m = D.get('SELECT m.* FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE m.conversation_id = ? AND m.role = ? AND m.deleted = 0 AND c.space_id = ? ORDER BY m.seq DESC LIMIT 1', conversationId, 'assistant', spaceId);
  return m ? shapeMessage(m) : null;
}

// 组装给模型的消息数组（最近 N 条，控制上下文）
function buildContext(spaceId, conversationId, limit) {
  const c = D.get('SELECT * FROM conversations WHERE id = ? AND space_id = ?', conversationId, spaceId);
  if (!c) return null;
  const n = limit || 24;
  const rows = D.all('SELECT role,content FROM messages WHERE conversation_id = ? AND deleted = 0 ORDER BY seq DESC LIMIT ?', conversationId, n);
  return { conversation: c, messages: rows.reverse().map(r => ({ role: r.role, content: r.content })) };
}

// ---------- 记忆 ----------
function getMemory(spaceId) {
  const s = D.get('SELECT * FROM memory_settings WHERE space_id = ?', spaceId);
  return {
    enabled: s ? !!s.enabled : true,
    summary: s ? s.summary : null,
    summaryAt: s ? s.summary_at : null,
    memories: D.all('SELECT id,kind,content,created_at FROM memories WHERE space_id = ? ORDER BY created_at DESC LIMIT 200', spaceId)
      .map(m => ({ id: m.id, kind: m.kind, content: m.content, createdAt: m.created_at })),
  };
}

function ensureMemoryRow(spaceId) {
  const s = D.get('SELECT 1 FROM memory_settings WHERE space_id = ?', spaceId);
  if (!s) D.run('INSERT INTO memory_settings(space_id,enabled) VALUES(?,1)', spaceId);
}

function setMemoryEnabled(spaceId, enabled) {
  ensureMemoryRow(spaceId);
  D.run('UPDATE memory_settings SET enabled = ? WHERE space_id = ?', !!enabled, spaceId);
}

function addMemory(spaceId, userId, content, kind) {
  const c = String(content || '').trim();
  if (!c) { const e = new Error('记忆内容不能为空'); e.code = 'BAD_INPUT'; throw e; }
  const id = D.uid('mem_');
  D.run('INSERT INTO memories(id,space_id,user_id,kind,content,created_at) VALUES(?,?,?,?,?,?)',
    id, spaceId, userId || null, kind || 'note', c.slice(0, 500), D.now());
  return id;
}

function deleteMemory(spaceId, id) {
  D.run('DELETE FROM memories WHERE id = ? AND space_id = ?', id, spaceId);
}

function setMemorySummary(spaceId, summary) {
  ensureMemoryRow(spaceId);
  D.run('UPDATE memory_settings SET summary = ?, summary_at = ? WHERE space_id = ?', String(summary || '').slice(0, 2000), D.now(), spaceId);
}

// ---------- 分享 ----------
const crypto = require('crypto');
function createShare(spaceId, kind, targetId) {
  const exist = D.get('SELECT * FROM shares WHERE kind = ? AND target_id = ? AND space_id = ?', kind, targetId, spaceId);
  if (exist) {
    D.run('UPDATE shares SET active = 1, updated_at = ? WHERE id = ?', D.now(), exist.id);
    return { token: exist.token, views: exist.views, active: true, createdAt: exist.created_at };
  }
  const token = crypto.randomBytes(8).toString('hex');
  const id = D.uid('sh_');
  D.run('INSERT INTO shares(id,kind,target_id,space_id,token,created_at,updated_at) VALUES(?,?,?,?,?,?,?)',
    id, kind, targetId, spaceId, token, D.now(), D.now());
  return { token, views: 0, active: true, createdAt: D.now() };
}

function getShare(token) {
  const s = D.get('SELECT * FROM shares WHERE token = ?', token);
  if (!s || !s.active) return null;
  D.run('UPDATE shares SET views = views + 1 WHERE id = ?', s.id);
  return s;
}

function cancelShare(spaceId, kind, targetId) {
  const s = D.get('SELECT * FROM shares WHERE kind = ? AND target_id = ? AND space_id = ?', kind, targetId, spaceId);
  if (!s) return false;
  D.run('UPDATE shares SET active = 0, updated_at = ? WHERE id = ?', D.now(), s.id);
  return true;
}

function shareInfo(spaceId, kind, targetId) {
  const s = D.get('SELECT * FROM shares WHERE kind = ? AND target_id = ? AND space_id = ?', kind, targetId, spaceId);
  if (!s) return { active: false };
  return { token: s.token, views: s.views, active: !!s.active, createdAt: s.created_at };
}

// ---------- 统计 ----------
function stats(spaceId) {
  const day = 24 * 60 * 60 * 1000;
  const since = D.now() - day;
  return {
    conversations: (D.get('SELECT COUNT(*) c FROM conversations WHERE space_id = ?', spaceId) || {}).c || 0,
    messages: (D.get('SELECT COUNT(*) c FROM messages m JOIN conversations c2 ON c2.id = m.conversation_id WHERE c2.space_id = ?', spaceId) || {}).c || 0,
    cards: (D.get('SELECT COUNT(*) c FROM cards WHERE space_id = ?', spaceId) || {}).c || 0,
    dueToday: (D.get('SELECT COUNT(*) c FROM cards WHERE space_id = ? AND status != ? AND due_at <= ?', spaceId, 'retired', D.now()) || {}).c || 0,
    todayActivity: (D.get('SELECT COUNT(*) c FROM activity WHERE space_id = ? AND at > ?', spaceId, since) || {}).c || 0,
  };
}

module.exports = {
  logActivity, stats,
  listProjects, createProject, getProject, updateProject, deleteProject,
  listConversations, createConversation, getConversation, updateConversation, deleteConversation,
  listMessages, addMessage, buildContext, safeJSON, shapeMessage,
  getMessage, updateMessage, deleteMessage, appendMessageContent, findByClientId, lastAssistant,
  getMemory, setMemoryEnabled, addMemory, deleteMemory, setMemorySummary,
  createShare, getShare, cancelShare, shareInfo,
};

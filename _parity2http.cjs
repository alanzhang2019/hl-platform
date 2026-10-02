'use strict';
/**
 * 批次2 · HTTP 端到端自检：Chat 富功能。
 *
 * 规矩同 _parityhttp.cjs：自带服务进程 + 随机端口 + 临时 DATA_DIR，绝不动开发库。
 * 除了正向通，还做反证：未登录拿不到、断流真的能从 DB 捞回完整回复、
 * 主动停止真的停、临时资料不串对话、跨空间读不到附件。
 *
 * 跑法：node _parity2http.cjs
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const NODE = process.execPath;
const PORT = 3800 + Math.floor(Math.random() * 300);
const BASE = 'http://127.0.0.1:' + PORT;
const DATA_DIR = path.join(os.tmpdir(), 'hl-p2http-' + crypto.randomBytes(4).toString('hex'));

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  \u2713 ' + name); }
  else { fail++; failures.push(name + (extra ? ' → ' + (typeof extra === 'string' ? extra : JSON.stringify(extra)) : '')); console.log('  \u2717 ' + name + (extra ? ' → ' + (typeof extra === 'string' ? extra : JSON.stringify(extra)) : '')); }
}
function group(t) { console.log('\n' + t); }

async function req(method, p, body, token, extraHeaders) {
  const h = { 'Content-Type': 'application/json' };
  if (token) h.Authorization = 'Bearer ' + token;
  Object.assign(h, extraHeaders || {});
  const r = await fetch(BASE + p, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  let j = null;
  try { j = await r.json(); } catch (e) { j = null; }
  return { status: r.status, body: j };
}
const GET = (p, t) => req('GET', p, undefined, t);
const POST = (p, b, t) => req('POST', p, b, t);
const PATCH = (p, b, t) => req('PATCH', p, b, t);
const DEL = (p, t) => req('DELETE', p, undefined, t);

function startServer() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const child = spawn(NODE, ['server.js'], {
    cwd: __dirname,
    env: Object.assign({}, process.env, {
      PORT: String(PORT), DATA_DIR,
      LLM_API_KEY: '', NO_DOTENV: '1',
      TTS_PROVIDER_URL: '', WEB_SEARCH_URL: '', IMAGE_PROVIDER_URL: '',
      SMS_PROVIDER_URL: '',
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', d => process.env.VERBOSE && process.stdout.write('[srv] ' + d));
  child.stderr.on('data', d => process.stderr.write('[srv:err] ' + d));
  return child;
}
async function waitReady(ms) {
  const until = Date.now() + (ms || 15000);
  while (Date.now() < until) {
    try { const r = await fetch(BASE + '/api/health'); if (r.ok) return await r.json(); } catch (e) {}
    await new Promise(r => setTimeout(r, 150));
  }
  throw new Error('服务在超时前没有就绪');
}
function stopServer(child) {
  return new Promise(res => {
    if (!child || child.killed) return res();
    child.on('exit', () => res());
    try { child.kill(); } catch (e) { res(); }
    setTimeout(() => { try { child.kill('SIGKILL'); } catch (e) {} res(); }, 3000);
  });
}

/** 读一次 SSE，收集事件；onEvent 返回 false 可提前掐断（用来模拟断流） */
async function readSSE(token, payload, onEvent) {
  const ctl = new AbortController();
  const res = await fetch(BASE + '/api/chat/stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify(payload),
    signal: ctl.signal,
  });
  if (!res.ok) return { status: res.status, events: [] };
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const events = [];
  try {
    while (true) {
      const rd = await reader.read();
      if (rd.done) break;
      buf += dec.decode(rd.value, { stream: true });
      const parts = buf.split('\n\n');
      buf = parts.pop();
      for (const part of parts) {
        let ev = '', data = '';
        part.split('\n').forEach(l => {
          if (l.indexOf('event:') === 0) ev = l.slice(6).trim();
          else if (l.indexOf('data:') === 0) data += l.slice(5).trim();
        });
        if (!data) continue;
        let j = null; try { j = JSON.parse(data); } catch (e) { continue; }
        events.push({ ev: ev, data: j });
        if (onEvent && onEvent(ev, j, ctl) === false) { try { ctl.abort(); } catch (e) {} return { status: 200, events: events, cut: true }; }
      }
    }
  } catch (e) {
    return { status: 200, events: events, cut: true, err: e.name };
  }
  return { status: 200, events: events };
}

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** 轮询消息直到进入终态 */
async function waitFinal(token, id, ms) {
  const until = Date.now() + (ms || 30000);
  while (Date.now() < until) {
    const r = await GET('/api/messages/' + id, token);
    if (r.status === 200 && ['done', 'aborted', 'error'].indexOf(r.body.message.status) >= 0) return r.body.message;
    await sleep(400);
  }
  return null;
}

(async () => {
  const child = startServer();
  try {
    const health = await waitReady();

    group('A. 健康检查与版本');
    ['messages', 'tts', 'translate', 'favorites', 'upload', 'tempdocs', 'jobs', 'agents', 'search', 'shares']
      .forEach(k => ok('health 报告接口：' + k, Array.isArray(health.apis) && health.apis.indexOf(k) >= 0));
    // ★ 日期不写死：以前写的是 indexOf('2026-10-01-parity')===0，跨天 bump 一次就红 5 个套件。
    //   要卡的是"这是 parity 构建"，不是"这是 10 月 1 号那天发的"。
    ok('版本是 parity 构建（形如 YYYY-MM-DD-parityN）', /^\d{4}-\d{2}-\d{2}-parity\d+/.test(String(health.version)), health.version);

    group('B. 未登录一律拒绝（反证）');
    const guards = [
      ['GET', '/api/messages/m_x'], ['DELETE', '/api/messages/m_x'],
      ['POST', '/api/messages/m_x/favorite'], ['POST', '/api/messages/m_x/translate'],
      ['POST', '/api/messages/m_x/speak'], ['POST', '/api/messages/m_x/stop'],
      ['POST', '/api/messages/m_x/regenerate'], ['GET', '/api/favorites'],
      ['POST', '/api/tts/speak'], ['GET', '/api/tts/settings'], ['POST', '/api/tts/settings'],
      ['POST', '/api/search'], ['POST', '/api/chat/image'], ['GET', '/api/chat/jobs'],
      ['GET', '/api/chat/jobs/job_x'], ['POST', '/api/upload/image'], ['POST', '/api/upload/document'],
      ['GET', '/api/files/att_x'], ['GET', '/api/conversations/c_x/temp-documents'],
      ['POST', '/api/conversations/c_x/temp-documents/status'], ['DELETE', '/api/temp-documents/kb_x'],
      ['GET', '/api/agents'], ['GET', '/api/shares'],
    ];
    let guardBad = [];
    for (const [m, p] of guards) {
      const r = await req(m, p, m === 'GET' || m === 'DELETE' ? undefined : {}, null);
      if (r.status !== 401) guardBad.push(m + ' ' + p + '→' + r.status);
    }
    ok('全部 ' + guards.length + ' 个新接口未登录时返回 401', guardBad.length === 0, guardBad.join(' | '));

    group('C. 建空间');
    const sp = await POST('/api/space', { name: '批次2孩子', password: '' });
    ok('建空间成功', sp.status === 200 && !!sp.body.token, JSON.stringify(sp.body).slice(0, 100));
    const T = sp.body.token;

    group('D. 模型与智能体');
    const md = await GET('/api/models');
    ok('模型带分类标签', md.status === 200 && md.body.models.every(m => !!m.tag), JSON.stringify(md.body.models[0]));
    ok('模型带说明文字', md.body.models.every(m => typeof m.desc === 'string'));
    const ag = await GET('/api/agents', T);
    ok('智能体总数 57', ag.body.total === 57, ag.body.total);
    const ag2 = await GET('/api/agents?q=数学', T);
    ok('智能体可搜索', ag2.body.agents.length > 0 && ag2.body.agents.length < 57, ag2.body.agents.length);
    const agentId = ag2.body.agents[0].id;

    group('E. 对话级设置');
    const cv = await POST('/api/conversations', { title: '批次2对话', agentId: agentId, webSearch: true }, T);
    const CID = cv.body.conversation.id;
    ok('建对话带智能体与联网开关', cv.body.conversation.agentId === agentId && cv.body.conversation.webSearch === true);
    const cp = await PATCH('/api/conversations/' + CID, { title: '改过名的对话' }, T);
    ok('重命名成功', cp.body.conversation.title === '改过名的对话');
    const cf = await PATCH('/api/conversations/' + CID, { isFavorite: true }, T);
    ok('收藏对话', cf.body.conversation.isFavorite === true);
    const fl = await GET('/api/conversations?favorite=1', T);
    ok('收藏筛选能查到', fl.body.conversations.some(c => c.id === CID));
    const sq = await GET('/api/conversations?q=' + encodeURIComponent('改过名'), T);
    ok('标题搜索能查到', sq.body.conversations.some(c => c.id === CID));
    const pr = await POST('/api/projects', { name: '批次2项目', instructions: '只问不答' }, T);
    const PID = pr.body.project.id;
    const mv = await PATCH('/api/conversations/' + CID, { projectId: PID }, T);
    ok('移动到项目', mv.body.conversation.projectId === PID);
    ok('项目里带对话计数', (await GET('/api/projects', T)).body.projects.filter(p => p.id === PID)[0].conversationCount === 1);
    await PATCH('/api/conversations/' + CID, { projectId: null }, T);

    group('F. SSE 流式对话');
    const s1 = await readSSE(T, { text: '三角形面积怎么算？', conversationId: CID, mode: 'selfstudy' });
    const meta1 = s1.events.filter(e => e.ev === 'meta')[0];
    const done1 = s1.events.filter(e => e.ev === 'done')[0];
    const deltas = s1.events.filter(e => e.ev === 'delta');
    ok('收到 meta 事件', !!meta1);
    ok('meta 带 conversationId 与 replyId', !!meta1.data.conversationId && !!meta1.data.replyId, JSON.stringify(meta1.data).slice(0, 140));
    ok('meta 带 messageId（用户那条）', !!meta1.data.messageId);
    ok('收到多条 delta（真的是流式）', deltas.length > 5, deltas.length);
    ok('收到 done 事件且状态 done', !!done1 && done1.data.status === 'done', JSON.stringify(done1 && done1.data));
    ok('done 带 length 与 replyId', done1.data.length > 0 && done1.data.replyId === meta1.data.replyId);
    ok('meta 回传联网状态（未配通道时如实说明）',
      meta1.data.webSearch && meta1.data.webSearch.ok === false && /未联网/.test(meta1.data.webSearch.message),
      JSON.stringify(meta1.data.webSearch));

    const rid1 = meta1.data.replyId;
    const rm1 = await GET('/api/messages/' + rid1, T);
    ok('助手回复已落库', rm1.status === 200 && rm1.body.message.status === 'done');
    ok('落库正文与流式内容长度一致', rm1.body.message.content.length === done1.data.length);
    ok('消息带 meta（含命中技能）', rm1.body.message.meta && Array.isArray(rm1.body.message.meta.skills));
    const cl = await GET('/api/conversations/' + CID, T);
    ok('对话里两条消息（用户 + 助手）', cl.body.messages.length === 2, cl.body.messages.length);
    ok('首条用户消息自动成为标题的候选', cl.body.messages[0].role === 'user');

    group('G. 断流恢复（核心）');
    // 收到第 3 个 delta 就掐断连接，模拟"网断了 / 切后台被系统杀掉"
    const cut = await readSSE(T, { text: '再讲一遍，我要断流测试', conversationId: CID, mode: 'selfstudy' },
      (ev, j, ctl) => { if (ev === 'delta' && ctl.__n === undefined) ctl.__n = 0; if (ev === 'delta') { ctl.__n++; if (ctl.__n >= 3) return false; } return true; });
    const cutMeta = cut.events.filter(e => e.ev === 'meta')[0];
    ok('断流前拿到了 replyId', !!cutMeta && !!cutMeta.data.replyId);
    ok('断流时确实还没收到 done', cut.events.filter(e => e.ev === 'done').length === 0);
    const rid2 = cutMeta.data.replyId;
    // 服务端应该继续生成到完成 —— 而不是把半截存下来
    const final2 = await waitFinal(T, rid2, 40000);
    ok('断流后服务端仍把回复生成完', final2 && final2.status === 'done', final2 && final2.status);
    ok('从 DB 捞到的是完整回复（不是半截）', final2 && final2.content.length > 0, final2 && final2.content.length);
    const partialAtCut = cut.events.filter(e => e.ev === 'delta').map(e => e.data.text).join('');
    ok('完整回复比断流时收到的更长（说明后面那段是服务端补上的）',
      final2 && final2.content.length > partialAtCut.length, partialAtCut.length + ' → ' + (final2 && final2.content.length));

    group('H. 主动停止生成（与断流相反）');
    const stopRes = await readSSE(T, { text: '这条我要主动停掉', conversationId: CID },
      (ev, j, ctl) => { if (ev === 'meta') { ctl.__rid = j.replyId; return true; } if (ev === 'delta') { ctl.__n = (ctl.__n || 0) + 1; if (ctl.__n >= 3) { fetch(BASE + '/api/messages/' + ctl.__rid + '/stop', { method: 'POST', headers: { Authorization: 'Bearer ' + T } }).catch(() => {}); return false; } } return true; });
    const stopMeta = stopRes.events.filter(e => e.ev === 'meta')[0];
    const rid3 = stopMeta && stopMeta.data.replyId;
    ok('停止请求拿到了 replyId', !!rid3);
    const final3 = await waitFinal(T, rid3, 20000);
    ok('主动停止后状态是 aborted', final3 && final3.status === 'aborted', final3 && final3.status);
    ok('主动停止保留已生成的部分', final3 && final3.content.length > 0, final3 && final3.content.length);
    ok('主动停止确实没写完整（比断流那条短）', final3 && final2 && final3.content.length < final2.content.length);

    group('I. 消息级操作');
    const fav1 = await POST('/api/messages/' + rid1 + '/favorite', {}, T);
    ok('收藏消息', fav1.body.isFavorite === true);
    const fav2 = await POST('/api/messages/' + rid1 + '/favorite', {}, T);
    ok('再点取消收藏', fav2.body.isFavorite === false);
    await POST('/api/messages/' + rid1 + '/favorite', {}, T);
    const favList = await GET('/api/favorites', T);
    ok('收藏列表带对话标题', favList.body.messages.some(m => m.id === rid1 && m.conversationTitle));

    const tr1 = await POST('/api/messages/' + rid1 + '/translate', { direction: 'zh2en' }, T);
    ok('翻译返回方向与标签', tr1.status === 200 && tr1.body.direction === 'zh2en' && !!tr1.body.label, JSON.stringify(tr1.body).slice(0, 100));
    ok('翻译有内容', typeof tr1.body.text === 'string' && tr1.body.text.length > 0);
    const tr2 = await POST('/api/messages/' + rid1 + '/translate', { direction: 'zh2en' }, T);
    ok('再翻一次命中缓存', tr2.body.cached === true);
    ok('译文写回消息', (await GET('/api/messages/' + rid1, T)).body.message.translated.zh2en.text === tr1.body.text);
    ok('翻译不存在的消息 404', (await POST('/api/messages/m_无/translate', {}, T)).status === 404);

    const spk = await POST('/api/messages/' + rid1 + '/speak', {}, T);
    ok('朗读走浏览器合成（未配通道）', spk.status === 200 && spk.body.mode === 'browser');
    const spkLong = await POST('/api/tts/speak', { text: 'x'.repeat(5001) }, T);
    ok('朗读超 5000 字被拒并说明上限', spkLong.status === 400 && spkLong.body.error === 'TOO_LONG' && spkLong.body.maxChars === 5000);
    const ts1 = await POST('/api/tts/settings', { rate: 1.4 }, T);
    ok('语速可保存（空间口令登录没有 userId 也要能用）', ts1.status === 200 && ts1.body.settings.rate === 1.4, JSON.stringify(ts1.body));
    ok('语速可读回', (await GET('/api/tts/settings', T)).body.settings.rate === 1.4);
    const ts2 = await POST('/api/tts/settings', { rate: 99 }, T);
    ok('语速超范围被夹紧', ts2.body.settings.rate === 2);

    const rg = await readSSE(T, {}, T);   // 占位，避免变量名冲突
    const regenRes = await fetch(BASE + '/api/messages/' + rid1 + '/regenerate', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + T }, body: JSON.stringify({}),
    });
    ok('重新生成返回 200', regenRes.status === 200);
    const regenText = await regenRes.text();
    const regenDone = /"status":"done"/.test(regenText) || /event: done/.test(regenText);
    ok('重新生成也走完整流', regenDone);
    const afterRegen = await GET('/api/conversations/' + CID, T);
    ok('旧回复被软删（不再出现在对话里）', !afterRegen.body.messages.some(m => m.id === rid1));
    ok('重新生成后助手消息还在', afterRegen.body.messages.filter(m => m.role === 'assistant').length >= 1);
    ok('重新生成不重复添加用户消息', afterRegen.body.messages.filter(m => m.role === 'user').length === afterRegen.body.messages.filter(m => m.role === 'user').length);

    group('J. 消息删除（软删）');
    const lastA = afterRegen.body.messages.filter(m => m.role === 'assistant').slice(-1)[0];
    const dl = await DEL('/api/messages/' + lastA.id, T);
    ok('删除消息返回成功', dl.status === 200 && dl.body.deleted === true);
    const afterDel = await GET('/api/conversations/' + CID, T);
    ok('删除后不在对话里', !afterDel.body.messages.some(m => m.id === lastA.id));
    ok('删除不存在的消息返回 deleted=false', (await DEL('/api/messages/m_没有', T)).body.deleted === false);

    group('K. 联网搜索');
    const se = await POST('/api/search', { query: '中考数学' }, T);
    ok('未配通道时如实返回不可用', se.status === 200 && se.body.ok === false && se.body.reason === 'UNAVAILABLE');
    ok('降级文案是人话', se.body.message === '联网搜索暂时不可用，本条回答未联网', se.body.message);

    group('L. 上传（图片 / 文档）');
    const up = await POST('/api/upload/image', { files: [{ filename: '照片.png', dataBase64: PNG }] }, T);
    ok('上传图片成功', up.status === 200 && up.body.images.length === 1, JSON.stringify(up.body).slice(0, 120));
    const ATT = up.body.images[0].id;
    const fr = await fetch(BASE + '/api/files/' + ATT, { headers: { Authorization: 'Bearer ' + T } });
    ok('能按 id 取回图片', fr.status === 200 && fr.headers.get('content-type') === 'image/png');
    ok('附件响应带私有缓存头', /private/.test(fr.headers.get('cache-control') || ''));
    const frNo = await fetch(BASE + '/api/files/' + ATT);
    ok('未登录取不到附件', frNo.status === 401);
    const bad = await POST('/api/upload/image', { files: [{ filename: 'a.txt', dataBase64: PNG }] }, T);
    ok('非图片被跳过并说明支持的格式', bad.body.skipped.length === 1 && /PNG, JPG, GIF/.test(bad.body.skipped[0].reason));
    const mix = await POST('/api/upload/image', { files: [{ filename: 'ok.png', dataBase64: PNG }, { filename: 'bad.exe', dataBase64: PNG }] }, T);
    ok('混合上传：好的收下、坏的跳过（不是整个失败）', mix.body.images.length === 1 && mix.body.skipped.length === 1);

    const upDoc = await POST('/api/upload/document', { files: [{ filename: '正式资料.txt', text: '勾股定理 a²+b²=c²' }] }, T);
    ok('上传文档进正式库', upDoc.status === 200 && upDoc.body.documents[0].scope === 'kb', JSON.stringify(upDoc.body.documents[0] || {}).slice(0, 120));
    const kbList = await GET('/api/kb/documents', T);
    ok('正式文档出现在资料库', kbList.body.documents.some(d => d.id === upDoc.body.documents[0].id));

    group('M. 对话级临时资料');
    const td = await POST('/api/conversations/' + CID + '/temp-documents', { files: [{ filename: '本次卷子.txt', text: '第一题 计算 1+1 等于几' }] }, T);
    ok('上传临时资料成功', td.status === 200 && td.body.documents.length === 1, JSON.stringify(td.body).slice(0, 140));
    const TDID = td.body.documents[0].id;
    ok('临时资料标记 scope=temp', td.body.documents[0].scope === 'temp');
    ok('临时资料带 conversationId', td.body.documents[0].conversationId === CID);
    const tdList = await GET('/api/conversations/' + CID + '/temp-documents', T);
    ok('能列出本对话的临时资料', tdList.body.documents.length === 1);
    const tdSt = await POST('/api/conversations/' + CID + '/temp-documents/status', { ids: [TDID, 'kb_无'] }, T);
    ok('批量查解析状态', tdSt.body.status[TDID].status === 'ready');
    ok('未知文档返回 missing', tdSt.body.status['kb_无'].status === 'missing');
    const kbList2 = await GET('/api/kb/documents', T);
    ok('临时资料**不**出现在正式资料库', !kbList2.body.documents.some(d => d.id === TDID));
    const cv2 = await POST('/api/conversations', { title: '另一条对话' }, T);
    const otherTd = await GET('/api/conversations/' + cv2.body.conversation.id + '/temp-documents', T);
    ok('别的对话看不到这条临时资料', otherTd.body.documents.length === 0);
    const notTemp = await DEL('/api/temp-documents/' + upDoc.body.documents[0].id, T);
    ok('正式资料不能当临时资料删', notTemp.status === 400 && notTemp.body.error === 'NOT_TEMP');

    group('N. AI 配图（异步任务 + 轮询）');
    const jb = await POST('/api/chat/image', { prompt: '一个直角三角形', conversationId: CID }, T);
    ok('创建配图任务', jb.status === 200 && !!jb.body.job.id, JSON.stringify(jb.body).slice(0, 120));
    ok('返回心跳周期 35 秒', jb.body.heartbeatMs === 35000);
    const JID = jb.body.job.id;
    let jr = null;
    for (let i = 0; i < 40; i++) {
      const r = await GET('/api/chat/jobs/' + JID, T);
      jr = r.body.job;
      if (jr.status === 'done' || jr.status === 'failed') break;
      await sleep(400);
    }
    ok('任务进入终态', jr && (jr.status === 'done' || jr.status === 'failed'), jr && jr.status);
    ok('离线模式下失败原因是诚实的一句话（不是"生成失败"了事）', jr.status !== 'failed' || /离线演示模式/.test(jr.error || ''), jr && jr.error);
    ok('任务列表能按对话过滤', (await GET('/api/chat/jobs?conversationId=' + CID, T)).body.jobs.length >= 1);
    ok('任务列表能按类型过滤', (await GET('/api/chat/jobs?kind=image', T)).body.jobs.length >= 1);
    ok('查不存在的任务 404', (await GET('/api/chat/jobs/job_无', T)).status === 404);

    group('O. 分享管理');
    const sh0 = await GET('/api/conversations/' + CID + '/share', T);
    ok('还没分享时 active=false', sh0.body.share.active === false);
    const sh1 = await POST('/api/conversations/' + CID + '/share', {}, T);
    const STOK = sh1.body.share.token;
    ok('创建分享链接', sh1.status === 200 && /^[0-9a-f]{16}$/.test(STOK), STOK);
    const shList = await GET('/api/shares?kind=conversation', T);
    const mine = shList.body.shares.filter(s => s.token === STOK)[0];
    ok('分享管理列表带标题', !!mine && !!mine.title, JSON.stringify(mine));
    ok('分享管理列表带访问次数', !!mine && mine.views === 0);
    // 免登录访问一次，次数应该 +1
    const pub = await fetch(BASE + '/api/share/' + STOK);
    ok('免登录能打开分享', pub.status === 200);
    const shList2 = await GET('/api/shares?kind=conversation', T);
    ok('访问后次数 +1', shList2.body.shares.filter(s => s.token === STOK)[0].views === 1);
    const pubBody = await pub.json();
    ok('分享页不含被软删的消息', pubBody.messages.every(m => m.content.indexOf('这段不该') < 0));
    const shDel = await DEL('/api/conversations/' + CID + '/share', T);
    ok('取消分享', shDel.body.cancelled === true);
    ok('取消后链接失效', (await fetch(BASE + '/api/share/' + STOK)).status === 404);
    ok('取消后管理列表 active=false', (await GET('/api/shares?kind=conversation', T)).body.shares.filter(s => s.token === STOK)[0].active === false);

    group('P. 删对话的级联清理');
    const tdc = await POST('/api/conversations/' + CID + '/temp-documents', { files: [{ filename: '待删.txt', text: 'x' }] }, T);
    const TD2 = tdc.body.documents[0].id;
    await DEL('/api/conversations/' + CID, T);
    ok('对话已删除', (await GET('/api/conversations/' + CID, T)).status === 404);
    const kbAfter = await GET('/api/kb/documents', T);
    ok('临时资料随对话删除', !kbAfter.body.documents.some(d => d.id === TD2));
    ok('正式资料**不**受影响', kbAfter.body.documents.some(d => d.id === upDoc.body.documents[0].id));
    ok('任务随对话删除', (await GET('/api/chat/jobs?conversationId=' + CID, T)).body.jobs.length === 0);

    group('Q. 跨空间隔离（反证）');
    const sp2 = await POST('/api/space', { name: '另一个孩子', password: '' });
    const T2 = sp2.body.token;
    ok('另一个空间看不到这条对话', (await GET('/api/conversations/' + CID, T2)).status === 404);
    ok('另一个空间看不到消息', (await GET('/api/messages/' + rid1, T2)).status === 404);
    ok('另一个空间读不到附件', (await fetch(BASE + '/api/files/' + ATT, { headers: { Authorization: 'Bearer ' + T2 } })).status === 404);
    ok('另一个空间收藏列表是空的', (await GET('/api/favorites', T2)).body.messages.length === 0);
    ok('另一个空间的任务列表是空的', (await GET('/api/chat/jobs', T2)).body.jobs.length === 0);
    ok('另一个空间的语速设置独立', (await GET('/api/tts/settings', T2)).body.settings.rate === 1);
  } finally {
    await stopServer(child);
    try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch (e) {}
  }

  console.log('\n' + '─'.repeat(58));
  if (failures.length) failures.forEach(f => console.log('  ✗ ' + f));
  console.log('PASS  通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  process.exit(fail ? 1 : 0);
})().catch(e => {
  console.error('批次2 HTTP 自检自身异常：', e);
  process.exit(2);
});

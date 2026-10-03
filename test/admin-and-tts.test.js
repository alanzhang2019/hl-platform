'use strict';
/**
 * 回归测试：TTS provider 适配层 + 管理员看板
 *
 * 零依赖，Node 22 直接跑：
 *   node test/admin-and-tts.test.js
 *
 * ★ 为什么用临时 DATA_DIR：
 *   这个测试会建空间、写对话、插消息。绝不能碰真实库 ——
 *   所以 require 业务模块**之前**先把 DATA_DIR 指到临时目录，
 *   同时设 NO_DOTENV=1，免得读到 .env 里真实的生产配置（旧项目踩过这个坑：
 *   测试里读到了本机 .env 的真实 Key，把"未配置"的用例污染成真实调用）。
 *
 * ★ TTS 部分起一个本地 stub HTTP 服务当上游，
 *   断言的是"我们发出的请求长什么样"，而不是"某家云服务今天是否可用"。
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const http = require('http');
const assert = require('assert');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hl-admin-tts-'));
process.env.NO_DOTENV = '1';
process.env.DATA_DIR = TMP;
// llm.js 在模块加载那一刻就把 LLM_MODEL 读进常量，所以必须在 require 之前设好
process.env.LLM_MODEL = 'deepseek/deepseek-v4-flash-20260731';
process.env.LLM_MODEL_DEEP = 'deepseek/deepseek-v4-pro-0813';

const D = require('../server/db');
const core = require('../server/core');
const chat = require('../server/chat');
const admin = require('../server/admin');
const llm = require('../server/llm');

const DAY = 24 * 60 * 60 * 1000;
let pass = 0, fail = 0;
const failures = [];

async function t(name, fn) {
  try {
    await fn();
    pass++;
    console.log('  \u2705 ' + name);
  } catch (e) {
    fail++;
    failures.push({ name: name, err: e });
    console.log('  \u274c ' + name);
    console.log('     ' + (e && e.message ? e.message : String(e)));
  }
}
function group(title) { console.log('\n=== ' + title + ' ==='); }

/** 起一个本地 stub 上游，返回 { base, close, last } */
function startStub(handler) {
  return new Promise(function (resolve) {
    const state = { last: null };
    const srv = http.createServer(function (req, res) {
      let body = '';
      req.on('data', function (c) { body += c; });
      req.on('end', function () {
        let parsed = null;
        try { parsed = JSON.parse(body); } catch (e) {}
        state.last = { url: req.url, method: req.method, auth: req.headers.authorization || '', body: parsed };
        handler(req, res, state.last);
      });
    });
    srv.listen(0, '127.0.0.1', function () {
      resolve({
        base: 'http://127.0.0.1:' + srv.address().port,
        state: state,
        close: function () { return new Promise(function (r) { srv.close(r); }); },
      });
    });
  });
}
function clearTtsEnv() {
  ['TTS_PROVIDER', 'TTS_BASE_URL', 'TTS_PROVIDER_URL', 'TTS_API_KEY', 'TTS_MODEL', 'TTS_VOICE']
    .forEach(function (k) { delete process.env[k]; });
}

// ============================================================
// 一、TTS provider 适配层
// ============================================================
async function ttsTests() {
  group('一、TTS provider 适配层');

  await t('未配置任何 TTS 时降级为浏览器合成（不是报错）', async function () {
    clearTtsEnv();
    const r = await chat.speak('sp_test', null, { text: '你好' });
    assert.strictEqual(r.mode, 'browser');
    assert.strictEqual(r.degraded, undefined, '没配 TTS 是正常降级，不该标 degraded');
    assert.ok(/浏览器/.test(r.note));
  });

  // ---- OpenAI 兼容协议（SiliconFlow）----
  const ok = await startStub(function (req, res) {
    res.writeHead(200, { 'Content-Type': 'audio/mpeg' });
    res.end(Buffer.from('ID3-fake-mp3-bytes'));
  });

  await t('siliconflow：请求发到 {base}/audio/speech，字段用 OpenAI 口径', async function () {
    clearTtsEnv();
    process.env.TTS_PROVIDER = 'siliconflow';
    process.env.TTS_BASE_URL = ok.base + '/v1';
    process.env.TTS_API_KEY = 'sk-test-123';
    process.env.TTS_MODEL = 'FunAudioLLM/CosyVoice2-0.5B';
    process.env.TTS_VOICE = 'alex';

    const r = await chat.speak('sp_test', null, { text: '这是一次语音合成测试' });
    const sent = ok.state.last;

    assert.strictEqual(sent.method, 'POST');
    assert.strictEqual(sent.url, '/v1/audio/speech', 'base 应被补成 /audio/speech');
    assert.strictEqual(sent.auth, 'Bearer sk-test-123');
    assert.strictEqual(sent.body.input, '这是一次语音合成测试', 'OpenAI 协议用 input 不是 text');
    assert.strictEqual(sent.body.model, 'FunAudioLLM/CosyVoice2-0.5B');
    assert.strictEqual(sent.body.response_format, 'mp3');
    assert.strictEqual(sent.body.text, undefined, '不能把通用协议的 text 字段混进来');

    assert.strictEqual(r.mode, 'audio');
    assert.strictEqual(r.provider, 'siliconflow');
    assert.strictEqual(r.mime, 'audio/mpeg');
    assert.strictEqual(Buffer.from(r.audio, 'base64').toString(), 'ID3-fake-mp3-bytes');
  });

  await t('siliconflow：音色短名自动补模型前缀（只写 alex 会 400）', async function () {
    clearTtsEnv();
    process.env.TTS_PROVIDER = 'siliconflow';
    process.env.TTS_BASE_URL = ok.base + '/v1';
    process.env.TTS_MODEL = 'FunAudioLLM/CosyVoice2-0.5B';
    process.env.TTS_VOICE = 'dylan';
    await chat.speak('sp_test', null, { text: 'x' });
    assert.strictEqual(ok.state.last.body.voice, 'FunAudioLLM/CosyVoice2-0.5B:dylan');
  });

  await t('siliconflow：已带前缀的音色不被重复补', async function () {
    clearTtsEnv();
    process.env.TTS_PROVIDER = 'siliconflow';
    process.env.TTS_BASE_URL = ok.base + '/v1';
    process.env.TTS_MODEL = 'FunAudioLLM/CosyVoice2-0.5B';
    process.env.TTS_VOICE = 'FunAudioLLM/CosyVoice2-0.5B:alex';
    await chat.speak('sp_test', null, { text: 'x' });
    assert.strictEqual(ok.state.last.body.voice, 'FunAudioLLM/CosyVoice2-0.5B:alex');
  });

  await t('siliconflow：base 已写到 /audio/speech 时不重复拼接', async function () {
    clearTtsEnv();
    process.env.TTS_PROVIDER = 'siliconflow';
    process.env.TTS_BASE_URL = ok.base + '/v1/audio/speech';
    process.env.TTS_MODEL = 'FunAudioLLM/CosyVoice2-0.5B';
    await chat.speak('sp_test', null, { text: 'x' });
    assert.strictEqual(ok.state.last.url, '/v1/audio/speech');
  });

  await t('siliconflow：base 结尾多余斜杠被归一', async function () {
    clearTtsEnv();
    process.env.TTS_PROVIDER = 'siliconflow';
    process.env.TTS_BASE_URL = ok.base + '/v1///';
    await chat.speak('sp_test', null, { text: 'x' });
    assert.strictEqual(ok.state.last.url, '/v1/audio/speech');
  });

  // ---- 通用协议（向后兼容）----
  await t('通用协议：没写 TTS_PROVIDER 时仍用 text/rate/format 老字段', async function () {
    clearTtsEnv();
    process.env.TTS_PROVIDER_URL = ok.base + '/synth';
    process.env.TTS_API_KEY = 'legacy-key';
    process.env.TTS_VOICE = 'zh-female-1';

    const r = await chat.speak('sp_test', null, { text: '老协议', rate: 1.25 });
    const sent = ok.state.last;
    assert.strictEqual(sent.url, '/synth');
    assert.strictEqual(sent.body.text, '老协议');
    assert.strictEqual(sent.body.rate, 1.25);
    assert.strictEqual(sent.body.format, 'mp3');
    assert.strictEqual(sent.body.input, undefined, '通用协议不该发 OpenAI 的 input 字段');
    assert.strictEqual(r.mode, 'audio');
  });

  await t('通用协议：上游返回 JSON 里的 base64 也能认', async function () {
    const j = await startStub(function (req, res) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ audio: Buffer.from('json-audio').toString('base64'), mime: 'audio/wav' }));
    });
    clearTtsEnv();
    process.env.TTS_PROVIDER_URL = j.base + '/synth';
    const r = await chat.speak('sp_test', null, { text: 'x' });
    assert.strictEqual(r.mode, 'audio');
    assert.strictEqual(r.mime, 'audio/wav');
    assert.strictEqual(Buffer.from(r.audio, 'base64').toString(), 'json-audio');
    await j.close();
  });

  // ---- 失败与边界 ----
  const bad = await startStub(function (req, res) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ message: 'voice not found' }));
  });

  await t('上游 400 时降级为浏览器合成，且 detail 带上游原文', async function () {
    clearTtsEnv();
    process.env.TTS_PROVIDER = 'siliconflow';
    process.env.TTS_BASE_URL = bad.base + '/v1';
    const r = await chat.speak('sp_test', null, { text: 'x' });
    assert.strictEqual(r.mode, 'browser');
    assert.strictEqual(r.degraded, true);
    assert.ok(/400/.test(r.detail), 'detail 应含状态码，实际：' + r.detail);
    assert.ok(/voice not found/.test(r.detail), 'detail 应含上游响应体，实际：' + r.detail);
    assert.ok(!/400/.test(r.note), 'note 是给用户看的，不该出现状态码');
  });

  await t('超长文本直接拒绝（TOO_LONG），不打上游', async function () {
    clearTtsEnv();
    process.env.TTS_PROVIDER_URL = ok.base + '/synth';
    ok.state.last = null;
    let err = null;
    try { await chat.speak('sp_test', null, { text: 'a'.repeat(chat.TTS_MAX_CHARS + 1) }); }
    catch (e) { err = e; }
    assert.ok(err, '应当抛错');
    assert.strictEqual(err.code, 'TOO_LONG');
    assert.strictEqual(ok.state.last, null, '超长应在本地拦下，不该发到上游');
  });

  await t('空文本拒绝（BAD_INPUT）', async function () {
    let err = null;
    try { await chat.speak('sp_test', null, { text: '   ' }); } catch (e) { err = e; }
    assert.ok(err);
    assert.strictEqual(err.code, 'BAD_INPUT');
  });

  await ok.close();
  await bad.close();
}

// ============================================================
// 二、管理员看板
// ============================================================
function seed() {
  const now = D.now();
  D.run('INSERT INTO spaces(id,name,name_key,passcode,tier,settings_json,created_at,last_at) VALUES(?,?,?,?,?,?,?,?)',
    'sp_a', '小明', '小明', '', 'self', '{}', now, now);
  D.run('INSERT INTO spaces(id,name,name_key,passcode,tier,settings_json,created_at,last_at) VALUES(?,?,?,?,?,?,?,?)',
    'sp_b', '小红', '小红', '', 'guide', '{}', now, now);
  D.run('INSERT INTO users(id,space_id,name,role,created_at) VALUES(?,?,?,?,?)',
    'u_a', 'sp_a', '小明', 'student', now);

  const c1 = core.createConversation('sp_a', null, { title: '分数怎么通分', model: 'deepseek/deepseek-v4-flash' });
  const c2 = core.createConversation('sp_b', null, { title: '英语单词记不住', model: 'deepseek/deepseek-v4-flash' });

  core.addMessage('sp_a', c1.id, { role: 'user', content: '老师，分数怎么通分？' });
  core.addMessage('sp_a', c1.id, { role: 'assistant', content: '你先说说分母不同的两个分数…', meta: { mode: 'selfstudy' } });
  const del = core.addMessage('sp_a', c1.id, { role: 'assistant', content: '（这条被学生删掉了）', meta: { mode: 'feynman' } });
  D.run('UPDATE messages SET deleted = 1 WHERE id = ?', del.id);
  core.addMessage('sp_a', c1.id, { role: 'assistant', content: '（这条是 mode 落库之前的老数据）' });

  core.addMessage('sp_b', c2.id, { role: 'user', content: 'apple 老是记不住' });
  core.addMessage('sp_b', c2.id, { role: 'assistant', content: '试试把它放进句子里。', meta: { mode: 'feynman' } });

  // 把 c1 的第一条消息挪到 3 天前，用来验证按天分桶
  const first = D.get('SELECT id FROM messages WHERE conversation_id = ? ORDER BY seq ASC LIMIT 1', c1.id);
  D.run('UPDATE messages SET created_at = ? WHERE id = ?', now - 3 * DAY, first.id);

  return { c1: c1, c2: c2 };
}

async function adminTests() {
  group('二、管理员看板');
  const seeded = seed();

  await t('overview：总量统计只算未删除的消息', async function () {
    const ov = admin.overview({ days: 14 });
    assert.strictEqual(ov.totals.spaces, 2);
    assert.strictEqual(ov.totals.users, 1);
    assert.strictEqual(ov.totals.conversations, 2);
    // 6 条消息，其中 1 条软删除 → 5
    assert.strictEqual(ov.totals.messages, 5);
  });

  await t('overview：日曲线按天分桶且条数等于窗口天数', async function () {
    const ov = admin.overview({ days: 14 });
    assert.strictEqual(ov.daily.length, 14);
    const sum = ov.daily.reduce(function (a, d) { return a + d.messages; }, 0);
    assert.strictEqual(sum, 5, '曲线合计应等于未删除消息总数');
    const withData = ov.daily.filter(function (d) { return d.messages > 0; });
    assert.strictEqual(withData.length, 2, '应有 2 天有数据（3 天前 + 今天）');
  });

  await t('overview：模式分布区分真实档位与未记录的历史数据', async function () {
    const ov = admin.overview({ days: 14 });
    assert.strictEqual(ov.modes.selfstudy, 1);
    assert.strictEqual(ov.modes.feynman, 1, 'sp_b 的费曼回答应计入');
    assert.strictEqual(ov.modes.untracked, 1, '没有 meta 的老数据要单独报，不能混进真实档位');
    // 被删的那条是 feynman，但它 deleted=1，不该出现在统计里
    assert.strictEqual(ov.modes.feynman, 1);
  });

  await t('overview：活跃空间按窗口统计', async function () {
    const ov = admin.overview({ days: 14 });
    assert.strictEqual(ov.active.days7, 2);
    assert.strictEqual(ov.active.today, 2);
  });

  await t('overview：activity 动作分布有值', async function () {
    const ov = admin.overview({ days: 14 });
    assert.strictEqual(ov.activityKinds.chat, 2, '建两条对话 = 两条 chat 活动');
  });

  await t('overview：窗口天数会被夹在 1..90', async function () {
    assert.strictEqual(admin.overview({ days: 999 }).daily.length, 90);
    assert.strictEqual(admin.overview({ days: 0 }).daily.length, 1);
    assert.strictEqual(admin.overview({ days: 'abc' }).daily.length, 14);
  });

  await t('spaceUsage：列出空间并带上用量', async function () {
    const list = admin.spaceUsage({ days: 14 });
    assert.strictEqual(list.length, 2);
    const a = list.filter(function (s) { return s.spaceId === 'sp_a'; })[0];
    assert.ok(a, '应包含 sp_a');
    assert.strictEqual(a.name, '小明');
    assert.strictEqual(a.messages, 3);
    assert.strictEqual(a.conversations, 1);
    assert.strictEqual(a.users, 1);
  });

  await t('spaceDetail：单空间明细正确', async function () {
    const d = admin.spaceDetail('sp_a', { days: 14 });
    assert.strictEqual(d.space.name, '小明');
    assert.strictEqual(d.totals.messages, 3);
    assert.strictEqual(d.totals.conversations, 1);
    assert.strictEqual(d.users.length, 1);
    assert.strictEqual(d.modes.selfstudy, 1);
    assert.strictEqual(d.modes.untracked, 1);
    assert.strictEqual(d.modes.feynman, undefined, 'sp_b 的费曼回答不该串到 sp_a');
    assert.strictEqual(d.daily.length, 14);
  });

  await t('spaceDetail：不存在的空间抛 NOT_FOUND', async function () {
    let err = null;
    try { admin.spaceDetail('sp_nope', {}); } catch (e) { err = e; }
    assert.ok(err);
    assert.strictEqual(err.code, 'NOT_FOUND');
  });

  await t('listConversations：可按空间过滤', async function () {
    const all = admin.listConversations({});
    assert.strictEqual(all.total, 2);
    const a = admin.listConversations({ spaceId: 'sp_a' });
    assert.strictEqual(a.total, 1);
    assert.strictEqual(a.conversations[0].spaceName, '小明');
    assert.strictEqual(a.conversations[0].messages, 3);
    assert.strictEqual(a.conversations[0].userMessages, 1);
  });

  await t('listConversations：关键词能搜到正文（不只是标题）', async function () {
    const r = admin.listConversations({ q: '通分' });
    assert.strictEqual(r.total, 1, '标题命中');
    const r2 = admin.listConversations({ q: 'apple' });
    assert.strictEqual(r2.total, 1, '正文命中');
    const r3 = admin.listConversations({ q: '绝对不存在的词xyz' });
    assert.strictEqual(r3.total, 0);
  });

  await t('listConversations：分页参数生效', async function () {
    const p1 = admin.listConversations({ limit: 1, offset: 0 });
    const p2 = admin.listConversations({ limit: 1, offset: 1 });
    assert.strictEqual(p1.conversations.length, 1);
    assert.strictEqual(p2.conversations.length, 1);
    assert.notStrictEqual(p1.conversations[0].id, p2.conversations[0].id);
    assert.strictEqual(p1.total, 2);
  });

  await t('conversationDetail：默认不返回已删除消息', async function () {
    const d = admin.conversationDetail(seeded.c1.id);
    assert.strictEqual(d.counts.total, 4);
    assert.strictEqual(d.counts.deleted, 1);
    assert.strictEqual(d.messages.length, 3);
    assert.strictEqual(d.messages.filter(function (m) { return m.deleted; }).length, 0);
  });

  await t('conversationDetail：includeDeleted 能拿到已删除消息（审计用）', async function () {
    const d = admin.conversationDetail(seeded.c1.id, { includeDeleted: true });
    assert.strictEqual(d.messages.length, 4);
    assert.strictEqual(d.messages.filter(function (m) { return m.deleted; }).length, 1);
    const del = d.messages.filter(function (m) { return m.deleted; })[0];
    assert.ok(/被学生删掉/.test(del.content));
  });

  await t('conversationDetail：消息按 seq 升序且带 mode', async function () {
    const d = admin.conversationDetail(seeded.c1.id, { includeDeleted: true });
    const seqs = d.messages.map(function (m) { return m.seq; });
    assert.deepStrictEqual(seqs, seqs.slice().sort(function (a, b) { return a - b; }));
    const withMode = d.messages.filter(function (m) { return m.meta && m.meta.mode; });
    assert.strictEqual(withMode.length, 2);
  });

  await t('conversationDetail：不存在的对话抛 NOT_FOUND', async function () {
    let err = null;
    try { admin.conversationDetail('c_nope'); } catch (e) { err = e; }
    assert.ok(err);
    assert.strictEqual(err.code, 'NOT_FOUND');
  });

  await t('exportConversation：导出 Markdown 含角色、时间与删除标记', async function () {
    const e = admin.exportConversation(seeded.c1.id);
    assert.ok(/^# 对话导出：/.test(e.markdown));
    assert.ok(e.markdown.indexOf('分数怎么通分') >= 0);
    assert.ok(e.markdown.indexOf('学生') >= 0);
    assert.ok(e.markdown.indexOf('AI') >= 0);
    assert.ok(e.markdown.indexOf('已删除') >= 0, '导出要保留软删除消息并标记');
    assert.ok(/\.md$/.test(e.filename));
    assert.ok(e.markdown.indexOf('小明') >= 0, '导出应含空间名');
  });

  await t('看板不跨空间泄漏：sp_a 的查询拿不到 sp_b 的对话', async function () {
    const list = admin.listConversations({ spaceId: 'sp_a' });
    const ids = list.conversations.map(function (c) { return c.id; });
    assert.ok(ids.indexOf(seeded.c2.id) < 0, 'sp_b 的对话不能出现在 sp_a 的列表里');
    const d = admin.spaceDetail('sp_a', {});
    const cids = d.conversations.map(function (c) { return c.id; });
    assert.ok(cids.indexOf(seeded.c2.id) < 0);
  });
}

// ============================================================
// 三、消息序号（seq）—— 修复「所有消息 seq 恒为 0」
// ============================================================
async function seqTests() {
  group('三、消息序号 seq');

  await t('同一对话内 seq 必须递增（老 bug：MAX(seq)=0 被当成没取到，seq 永远停在 0）', async function () {
    const c = core.createConversation('sp_seq', null, { title: 'seq 测试' });
    core.addMessage('sp_seq', c.id, { role: 'user', content: '第一句' });
    core.addMessage('sp_seq', c.id, { role: 'assistant', content: '第二句' });
    core.addMessage('sp_seq', c.id, { role: 'user', content: '第三句' });
    core.addMessage('sp_seq', c.id, { role: 'assistant', content: '第四句' });
    const rows = D.all('SELECT seq, role FROM messages WHERE conversation_id = ? ORDER BY seq ASC, rowid ASC', c.id);
    assert.deepStrictEqual(rows.map(function (r) { return r.seq; }), [0, 1, 2, 3]);
    assert.deepStrictEqual(rows.map(function (r) { return r.role; }), ['user', 'assistant', 'user', 'assistant']);
  });

  await t('0 是合法序号，不能被当成空值', async function () {
    // 直接验证修复的那一行：MAX(seq)=0 时下一条必须是 1
    const c = core.createConversation('sp_seq', null, { title: 'seq 边界' });
    core.addMessage('sp_seq', c.id, { role: 'user', content: 'a' });
    const first = D.get('SELECT MAX(seq) m FROM messages WHERE conversation_id = ?', c.id);
    assert.strictEqual(first.m, 0, '第一条序号应为 0');
    core.addMessage('sp_seq', c.id, { role: 'assistant', content: 'b' });
    const second = D.get('SELECT MAX(seq) m FROM messages WHERE conversation_id = ?', c.id);
    assert.strictEqual(second.m, 1, '第二条序号必须是 1（旧代码在这里会算回 0）');
  });

  await t('对话全文按 seq 升序返回', async function () {
    const c = core.createConversation('sp_seq', null, { title: 'seq 排序' });
    core.addMessage('sp_seq', c.id, { role: 'user', content: '甲' });
    core.addMessage('sp_seq', c.id, { role: 'assistant', content: '乙' });
    core.addMessage('sp_seq', c.id, { role: 'user', content: '丙' });
    const d = admin.conversationDetail(c.id);
    assert.deepStrictEqual(d.messages.map(function (m) { return m.seq; }), [0, 1, 2]);
    assert.deepStrictEqual(d.messages.map(function (m) { return m.content; }), ['甲', '乙', '丙']);
  });

  await t('模式分布不重复计数（unknown 与 untracked 不得同时计同一批消息）', async function () {
    const ov = admin.overview({ days: 90 });
    let assistants = 0;
    D.all("SELECT COUNT(*) c FROM messages WHERE role='assistant' AND deleted=0 GROUP BY role")
      .forEach(function (r) { assistants += r.c; });
    const sum = Object.keys(ov.modes).reduce(function (a, k) { return a + ov.modes[k]; }, 0);
    assert.strictEqual(sum, assistants, '模式分布各项之和必须等于未删除的助手消息总数');
    assert.strictEqual(ov.modes.unknown, undefined, '不该再有 unknown 这个桶（它和 untracked 是同一批）');
  });
}

// ============================================================
// 四、后台模型切换
// ============================================================
async function modelTests() {
  group('四、后台模型切换');

  const DEF = 'deepseek/deepseek-v4-flash-20260731';
  const DEEP = 'deepseek/deepseek-v4-pro-0813';

  await t('默认读到环境变量里的两个档位', async function () {
    llm.setModelSlot('default', '');
    llm.setModelSlot('deep', '');
    const slots = llm.modelSlots();
    const d = slots.filter(function (s) { return s.id === 'default'; })[0];
    const p = slots.filter(function (s) { return s.id === 'deep'; })[0];
    assert.strictEqual(d.model, DEF);
    assert.strictEqual(p.model, DEEP);
    assert.strictEqual(d.overridden, false);
    assert.strictEqual(p.overridden, false);
  });

  await t('后台可以把深度思考档换成别的模型（如 qwen）', async function () {
    llm.setModelSlot('deep', 'qwen/qwen3.8-max');
    const slots = llm.modelSlots();
    const p = slots.filter(function (s) { return s.id === 'deep'; })[0];
    assert.strictEqual(p.model, 'qwen/qwen3.8-max');
    assert.strictEqual(p.envModel, DEEP, '环境变量值要留着，用于"恢复默认"');
    assert.strictEqual(p.overridden, true);
  });

  await t('覆盖立刻反映到 resolveModel（下一次对话就用新模型）', async function () {
    assert.strictEqual(llm.resolveModel('deep').model, 'qwen/qwen3.8-max');
    // 通用档没被改，不受影响
    assert.strictEqual(llm.resolveModel('default').model, DEF);
  });

  await t('传空串恢复环境变量的值', async function () {
    llm.setModelSlot('deep', '');
    assert.strictEqual(llm.effectiveModel('deep'), DEEP);
    assert.strictEqual(llm.modelSlots().filter(function (s) { return s.id === 'deep'; })[0].overridden, false);
  });

  await t('两个档位互不影响', async function () {
    llm.setModelSlot('default', 'moonshotai/kimi-k3');
    assert.strictEqual(llm.effectiveModel('default'), 'moonshotai/kimi-k3');
    assert.strictEqual(llm.effectiveModel('deep'), DEEP);
    llm.setModelSlot('default', '');
  });

  await t('未知档位抛 BAD_SLOT', async function () {
    let err = null;
    try { llm.setModelSlot('ultra', 'x'); } catch (e) { err = e; }
    assert.ok(err);
    assert.strictEqual(err.code, 'BAD_SLOT');
  });

  await t('带空格 / 超长的模型名抛 BAD_MODEL', async function () {
    let e1 = null, e2 = null;
    try { llm.setModelSlot('deep', 'deep seek/v4'); } catch (e) { e1 = e; }
    try { llm.setModelSlot('deep', 'x'.repeat(200)); } catch (e) { e2 = e; }
    assert.strictEqual(e1 && e1.code, 'BAD_MODEL');
    assert.strictEqual(e2 && e2.code, 'BAD_MODEL');
    // 失败时不能把已有覆盖弄坏
    assert.strictEqual(llm.effectiveModel('deep'), DEEP);
  });

  await t('未知 id 回落到通用档而不是崩', async function () {
    const m = llm.resolveModel('nope');
    assert.strictEqual(m.id, 'default');
    assert.strictEqual(m.model, DEF);
  });

  await t('没配 Key 时目录接口如实返回失败而不是抛错', async function () {
    const savedKey = process.env.LLM_API_KEY;
    delete process.env.LLM_API_KEY;
    // llm.js 把 KEY 读进常量了，这里真正测的是：即使目录拿不到，
    // 档位信息照样能列出来（后台页面不会白屏）
    const slots = llm.modelSlots();
    assert.ok(slots.length >= 2);
    if (savedKey !== undefined) process.env.LLM_API_KEY = savedKey;
  });
}

// ============================================================
// 五、看板「思考过程」区块 —— 永远在，默认折叠
// ============================================================
// ★ 这条是被用户点名要求加的：原先写的是 `m.reasoning ? <details> : ''`，
//   没思考过程的 AI 回复下面整块不渲染。线上 196 条 assistant 消息里只有 98 条
//   带 reasoning，于是管理员看到半数回复"没有思考过程"，第一反应是看板丢数据了。
//   正确做法是块一直在（折叠着），没内容如实写"本条没有输出"——
//   把"模型没给"和"看板丢了"区分开，后者才是事故。
//
// ★ 不复制函数体：从 public/js/admin.js 正则抽原文 eval，
//   保证测的是浏览器真正跑的那份代码，不是我另抄一份（抄的那份会跟源码漂移）。
async function reasonTests() {
  group('五、看板思考过程区块');

  const src = fs.readFileSync(path.join(__dirname, '..', 'public/js/admin.js'), 'utf8');
  const m = src.match(/function rsnHTML\(raw\)\s*\{[\s\S]*?\n  \}/);
  if (!m) throw new Error('public/js/admin.js 里找不到 rsnHTML —— 改名了？把测试一起改');
  // 桩函数必须与 admin.js 里的 esc / num 语义一致（num 还带千分位）
  const esc = function (s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  };
  const num = function (n) { return String(Number(n) || 0).replace(/\B(?=(\d{3})+(?!\d))/g, ','); };
  const rsnHTML = eval('(' + m[0].replace(/^function rsnHTML/, 'function') + ')');

  const EMPTY = ['', undefined, null, '   \n\t '];

  await t('没有思考过程时区块照样存在（核心：不许消失）', async function () {
    EMPTY.forEach(function (v) {
      const h = rsnHTML(v);
      assert.ok(/ad-rsn-none/.test(h), '空值 ' + JSON.stringify(v) + ' 应渲染占位块，实际：' + h);
      assert.ok(/本条没有输出/.test(h), '空值应如实标注，实际：' + h);
      assert.ok(!/<details/.test(h), '空值不该生成空 details');
    });
  });

  await t('有思考过程时渲染成折叠的 details（默认不展开）', async function () {
    const h = rsnHTML('先算 37+45，再进位。');
    assert.ok(/<details[^>]*class="ad-rsn"/.test(h), '应是 details.ad-rsn，实际：' + h);
    assert.ok(/<summary>/.test(h), '要有 summary 可点开');
    assert.ok(/class="ad-rsn-bd"/.test(h), '要有正文容器');
    assert.ok(!/ad-rsn-none/.test(h), '有内容就别再写"没有输出"');
    // 开标签上不能带 open —— 带了就是默认展开，与需求相反
    const openTag = h.slice(0, h.indexOf('>') + 1);
    assert.ok(!/\sopen[\s>=]/.test(openTag), 'details 默认必须折叠，实际开标签：' + openTag);
  });

  await t('摘要里带字数，长文有千分位', async function () {
    // 「先算 37+45，再进位。」= 13 个字符（含空格与标点），写死能抓住 trim 行为变化
    assert.ok(/思考过程 · 13 字/.test(rsnHTML('先算 37+45，再进位。')));
    const long = 'x'.repeat(1234);
    assert.ok(/思考过程 · 1,234 字/.test(rsnHTML(long)), '1234 应显示 1,234');
  });

  await t('思考过程正文做 HTML 转义（防注入）', async function () {
    const h = rsnHTML('<script>alert(1)</script>');
    assert.ok(!/<script>/.test(h), '裸 script 必须被转义，实际：' + h);
    assert.ok(/&lt;script&gt;/.test(h));
    const h2 = rsnHTML('<img src=x onerror=alert(1)>');
    assert.ok(!/<img/.test(h2), '裸 img 必须被转义，实际：' + h2);
  });

  await t('首尾空白要 trim，纯空白算没有', async function () {
    assert.ok(/ad-rsn-none/.test(rsnHTML('  \n  ')), '纯空白算没有内容');
    const h = rsnHTML('  真的有内容  ');
    assert.ok(/class="ad-rsn"/.test(h));
    assert.ok(/思考过程 · 5 字/.test(h), '字数按 trim 后算，实际：' + h);
  });

  await t('真实数据：每条 assistant 消息都有区块（零消失）', async function () {
    // 走真实数据层：造一条对话，assistant 一半带 reasoning、一半不带。
    // 用独立的 space 前缀，避免污染前面几组测试的计数断言。
    const now = D.now();
    const spId = 'sp_reason';
    D.run('INSERT OR REPLACE INTO spaces(id,name,name_key,passcode,tier,settings_json,created_at,last_at) VALUES(?,?,?,?,?,?,?,?)',
      spId, '思考过程', '思考过程', '', 'self', '{}', now, now);
    const conv = core.createConversation(spId, null, { title: '思考过程样本', model: 'deepseek/test' });

    core.addMessage(spId, conv.id, { role: 'user', content: '第一题怎么做' });
    const a1 = core.addMessage(spId, conv.id, { role: 'assistant', content: '我们先读题。' });
    core.addMessage(spId, conv.id, { role: 'user', content: '第二题呢' });
    core.addMessage(spId, conv.id, { role: 'assistant', content: '第二题这样做。' });
    // addMessage 不接 reasoning（它是流式写完后单独落的），直接用 SQL 补上
    D.run('UPDATE messages SET reasoning = ? WHERE id = ?', '我应该先引导他把题读明白，别急着给答案。', a1.id);

    const d = admin.conversationDetail(conv.id);
    const asst = d.messages.filter(function (x) { return x.role === 'assistant'; });
    assert.strictEqual(asst.length, 2, '应有 2 条 assistant 消息');

    let blocks = 0, folded = 0, none = 0;
    asst.forEach(function (msg) {
      const h = rsnHTML(msg.reasoning);
      blocks++;
      if (/class="ad-rsn"/.test(h)) folded++;
      if (/ad-rsn-none/.test(h)) none++;
    });
    assert.strictEqual(blocks, 2, '2 条 assistant 都要有区块');
    assert.strictEqual(folded, 1, '1 条有思考过程 → 折叠块');
    assert.strictEqual(none, 1, '1 条没有 → 占位块，而不是整块消失');
  });

  await t('排序兜底：seq 全为 0 时仍按写入顺序返回', async function () {
    // 老数据 seq 全是 0，纯 ORDER BY seq 时顺序由 SQLite 自己定，
    // 看板可能今天明天顺序不一样。加 rowid 兜底才稳定。
    const now = D.now();
    const spId = 'sp_seq0';
    D.run('INSERT OR REPLACE INTO spaces(id,name,name_key,passcode,tier,settings_json,created_at,last_at) VALUES(?,?,?,?,?,?,?,?)',
      spId, 'seq归零', 'seq归零', '', 'self', '{}', now, now);
    const conv = core.createConversation(spId, null, { title: 'seq 全 0', model: 'deepseek/test' });
    const ids = [];
    ['甲', '乙', '丙', '丁'].forEach(function (txt) {
      const m = core.addMessage(spId, conv.id, { role: 'user', content: txt });
      ids.push(m.id);
    });
    D.run('UPDATE messages SET seq = 0 WHERE conversation_id = ?', conv.id);

    const d = admin.conversationDetail(conv.id);
    const got = d.messages.map(function (m) { return m.content; });
    assert.deepStrictEqual(got, ['甲', '乙', '丙', '丁'], 'seq 归零后仍要保持写入顺序，实际：' + got.join(','));
  });
}

// ============================================================
(async function main() {
  console.log('临时数据目录：' + TMP);
  try {
    await ttsTests();
    await adminTests();
    await seqTests();
    await modelTests();
    await reasonTests();
  } catch (e) {
    console.error('\n测试运行器本身出错：', e);
    fail++;
  }
  console.log('\n════ 结果：' + pass + ' 通过 / ' + fail + ' 失败 ════');
  if (fail) {
    failures.forEach(function (f) { console.log('  · ' + f.name); });
  }
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
  process.exit(fail ? 1 : 0);
})();

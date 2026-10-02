'use strict';
/**
 * 批次1 自检（模块级）：账号增强层 + 数据层迁移。
 * 只读设计：所有写入都落在临时 DATA_DIR，跑完删掉。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hl-p1-'));
process.env.DATA_DIR = TMP;
process.env.NO_DOTENV = '1';
delete process.env.LLM_API_KEY;
delete process.env.ADMIN_PASSWORD;
delete process.env.SMS_PROVIDER_URL;

let pass = 0, fail = 0;
const fails = [];
function ok(cond, name, extra) {
  if (cond) { pass++; }
  else { fail++; fails.push(name + (extra !== undefined ? ' → ' + JSON.stringify(extra) : '')); }
}
function throws(fn, code, name) {
  try { fn(); fail++; fails.push(name + ' → 期望抛 ' + code + '，实际没抛'); }
  catch (e) { ok(e.code === code, name, { got: e.code, msg: e.message }); }
}

const D = require('./server/db');
const auth = require('./server/auth');
const account = require('./server/account');

// ---------- 1. schema 与迁移 ----------
const tables = D.all("SELECT name FROM sqlite_master WHERE type='table'").map(r => r.name);
['sms_codes', 'session_events', 'announcements', 'announcement_reads', 'translations', 'jobs']
  .forEach(t => ok(tables.indexOf(t) >= 0, '新表存在：' + t));

const userCols = D.all('PRAGMA table_info(users)').map(c => c.name);
['subjects_json', 'preferences_json', 'goals_json', 'avatar_preset', 'last_login_at']
  .forEach(c => ok(userCols.indexOf(c) >= 0, 'users 迁移列：' + c));

const msgCols = D.all('PRAGMA table_info(messages)').map(c => c.name);
['is_favorite', 'translated_json'].forEach(c => ok(msgCols.indexOf(c) >= 0, 'messages 迁移列：' + c));

const kbCols = D.all('PRAGMA table_info(kb_documents)').map(c => c.name);
['conversation_id', 'scope'].forEach(c => ok(kbCols.indexOf(c) >= 0, 'kb_documents 迁移列：' + c));

// 迁移必须幂等：再跑一次不报错、不重复加列
require('./server/db');
ok(D.all('PRAGMA table_info(users)').filter(c => c.name === 'goals_json').length === 1, '迁移幂等（goals_json 只有一列）');

// ---------- 2. 协议文本 ----------
const docs = account.docs();
ok(docs.length === 3, '三份协议文件', docs.map(d => d.id));
['terms', 'privacy', 'children-privacy'].forEach(id => {
  const d = account.doc(id);
  ok(d && d.sections.length >= 4, '协议有正文：' + id, d && d.sections.length);
});
ok(account.doc('nope') === null, '未知协议返回 null');
ok(auth.DOCS.join(',') === 'terms,privacy,children-privacy', 'DOCS 与文档 id 一致');

// ---------- 3. 头像预设 ----------
ok(account.AVATAR_PRESETS.length === 9, '9 款头像预设', account.AVATAR_PRESETS.length);
ok(new Set(account.AVATAR_PRESETS.map(a => a.id)).size === 9, '头像 id 唯一');
ok(account.AVATAR_PRESETS.every(a => a.name && a.shape && /^#[0-9A-Fa-f]{6}$/.test(a.color)), '头像字段完整');
// 不搬对方的预设名
const THEIR_NAMES = ['星蓝', '朝阳', '远山', '星云', '探索者', '青羽', '焰光', '晨曦', '轨道'];
ok(account.AVATAR_PRESETS.every(a => THEIR_NAMES.indexOf(a.name) < 0), '头像名与对标站不重合');

// ---------- 4. 短信验证码 ----------
(async () => {
  const phone = '13800001111';

  // 取码助手：先清掉该手机号+场景的旧码，绕开 60 秒限频。
  // 限频本身单独测一次（见下），其余用例不该被它挡住。
  async function code(p, scene) {
    D.run('DELETE FROM sms_codes WHERE phone = ? AND scene = ?', account.normPhone(p), scene);
    return (await account.sendCode(p, scene)).devCode;
  }

  let sendErr = null;
  try { await account.sendCode('123', 'login'); } catch (e) { sendErr = e; }
  ok(sendErr && sendErr.code === 'BAD_PHONE', '错误手机号被拒', sendErr && sendErr.code);

  const s1 = await account.sendCode(phone, 'login');
  ok(s1.sent === false && !!s1.devCode, '未配通道 → 开发模式并回传 devCode', { sent: s1.sent });
  ok(/^\d{6}$/.test(s1.devCode), '验证码是 6 位数字', s1.devCode);

  // 限频（真实行为，只测这一次）
  let rl = null;
  try { await account.sendCode(phone, 'login'); } catch (e) { rl = e; }
  ok(rl && rl.code === 'TOO_OFTEN' && rl.wait > 0, '60 秒内重发被限频', rl && rl.code);

  // 场景隔离：login 的码不能用来 reset
  throws(() => account.verifyCode(phone, 'reset', s1.devCode), 'NO_CODE', '验证码场景隔离');

  // 错码计次
  throws(() => account.verifyCode(phone, 'login', '000000'), 'BAD_CODE', '错误验证码被拒');
  const row = D.get('SELECT tries FROM sms_codes WHERE phone = ? ORDER BY created_at DESC LIMIT 1', phone);
  ok(row.tries === 1, '错误次数已累加', row.tries);

  // 正确码可用且一次性
  const vp = account.verifyCode(phone, 'login', s1.devCode);
  ok(vp === phone, '正确验证码通过');
  throws(() => account.verifyCode(phone, 'login', s1.devCode), 'NO_CODE', '验证码一次性（用过即废）');

  // 错满 5 次锁定
  const lockCode = await code(phone, 'login');
  for (let i = 0; i < 5; i++) { try { account.verifyCode(phone, 'login', '000000'); } catch (e) {} }
  throws(() => account.verifyCode(phone, 'login', lockCode), 'CODE_LOCKED', '错 5 次后锁定');

  // 过期
  const expCode = await code(phone, 'login');
  D.run('UPDATE sms_codes SET expires_at = ? WHERE phone = ? AND scene = ? AND used = 0', D.now() - 1000, phone, 'login');
  throws(() => account.verifyCode(phone, 'login', expCode), 'CODE_EXPIRED', '过期验证码被拒');

  // ---------- 5. 手机号注册 / 登录 ----------
  throws(() => account.loginBySms({ phone: '13900002222', code: '111111' }), 'NO_CODE', '未取码直接登录被拒');

  const s2 = await code('13900002222', 'login');
  throws(() => account.loginBySms({ phone: '13900002222', code: s2 }), 'NEED_CONSENT', '首登未同意协议被拒');
  // ★ 关键：被 NEED_CONSENT 挡下后，这个码必须还能用（不能被白烧）
  const r3 = account.loginBySms({ phone: '13900002222', code: s2, consents: auth.DOCS, name: '小海' });
  ok(!!r3.userId && !!r3.spaceId, '手机号首登自动注册');
  ok(r3.created === true, '标记为新建账号');
  const u3 = D.get('SELECT * FROM users WHERE id = ?', r3.userId);
  ok(u3.phone === '13900002222' && u3.last_login_at > 0, '手机号与最后登录时间已写入');
  ok(D.all('SELECT 1 FROM consents WHERE user_id = ?', r3.userId).length === 3, '三份协议同意已记录');
  const sp3 = D.get('SELECT name FROM spaces WHERE id = ?', r3.spaceId);
  ok(sp3.name === '小海', '空间名 = 姓名', sp3);

  // 再次登录（已注册）不再要求 consents
  const s4 = await code('13900002222', 'login');
  const r4 = account.loginBySms({ phone: '13900002222', code: s4 });
  ok(r4.userId === r3.userId && r4.created === false, '二次登录命中同一账号');

  // ---------- 6. 密码重置 ----------
  throws(() => account.resetPassword({ phone: '13700003333', code: '123456', password: 'abcdef' }), 'NO_CODE', '未取码重置被拒');
  const s5 = await code('13700003333', 'reset');
  throws(() => account.resetPassword({ phone: '13700003333', code: s5, password: 'abcdef' }), 'NOT_FOUND', '未注册手机号重置被拒');
  const s6 = await code('13900002222', 'reset');
  throws(() => account.resetPassword({ phone: '13900002222', code: s6, password: '123' }), 'BAD_PASSWORD', '弱密码被拒');
  const s7 = await code('13900002222', 'reset');
  account.resetPassword({ phone: '13900002222', code: s7, password: 'newpass123' });
  // 用新密码能登录（先给它设个用户名）
  D.run('UPDATE users SET username = ? WHERE id = ?', 'xiaohai', r3.userId);
  const lg = auth.login({ account: 'xiaohai', password: 'newpass123' });
  ok(lg.userId === r3.userId, '重置后的新密码可登录');
  throws(() => auth.login({ account: 'xiaohai', password: 'oldpass' }), 'BAD_CRED', '旧密码失效');

  // ---------- 7. 改密码 ----------
  throws(() => auth.changePassword(r3.userId, { oldPassword: 'wrong', newPassword: 'abc123456' }), 'BAD_CRED', '原密码错误被拒');
  auth.changePassword(r3.userId, { oldPassword: 'newpass123', newPassword: 'abc123456' });
  ok(auth.login({ account: 'xiaohai', password: 'abc123456' }).userId === r3.userId, '改密码后新密码可登录');

  // ---------- 8. 学习会话心跳 ----------
  const sid = r3.spaceId;
  account.sessionStart(sid, r3.userId, 'tk1');
  ok(account.studySeconds(sid, D.now() - 1000) === 0, '只有 start 时长为 0');

  // 伪造一段历史心跳：起点 20 分钟前，间隔都在 2 分钟内 → 只应累加 120 秒。
  // ★ 起点必须离现在足够远：前面的 sessionStart 落在"现在"，
  //   若历史事件离现在 ≤2 分钟，它会和 start 连上，把时长算多。
  const base = D.now() - 20 * 60000;
  D.run('INSERT INTO session_events(id,space_id,user_id,token,kind,at) VALUES(?,?,?,?,?,?)', D.uid('se_'), sid, r3.userId, 'tk9', 'start', base);
  D.run('INSERT INTO session_events(id,space_id,user_id,token,kind,at) VALUES(?,?,?,?,?,?)', D.uid('se_'), sid, r3.userId, 'tk9', 'heartbeat', base + 60000);
  D.run('INSERT INTO session_events(id,space_id,user_id,token,kind,at) VALUES(?,?,?,?,?,?)', D.uid('se_'), sid, r3.userId, 'tk9', 'heartbeat', base + 120000);
  ok(account.studySeconds(sid, base - 1000) === 120, '连续心跳累加时长 = 120 秒', account.studySeconds(sid, base - 1000));

  // 断档：间隔 10 分钟不计
  D.run('INSERT INTO session_events(id,space_id,user_id,token,kind,at) VALUES(?,?,?,?,?,?)', D.uid('se_'), sid, r3.userId, 'tk9', 'heartbeat', base + 120000 + 600000);
  ok(account.studySeconds(sid, base - 1000) === 120, '超过 2 分钟的断档不计入', account.studySeconds(sid, base - 1000));

  // 防刷：60 秒内重复心跳被跳过
  const h1 = account.sessionHeartbeat(sid, r3.userId, 'tk2');
  const h2 = account.sessionHeartbeat(sid, r3.userId, 'tk2');
  ok(h1.skipped === false && h2.skipped === true, '心跳 60 秒内防刷', [h1.skipped, h2.skipped]);
  account.sessionEnd(sid, r3.userId, 'tk2');
  ok(D.all("SELECT 1 FROM session_events WHERE space_id = ? AND kind = 'end'", sid).length >= 1, 'end 事件已记录');

  // ---------- 9. 资料扩展 ----------
  const p1 = auth.updateProfile(r3.userId, {
    subjects: ['math', 'english'], preferences: { theme: 'light', fontSize: 'large' },
    goals: ['这学期把分数提上来'], avatarPreset: 'tide', stage: '小学', grade: '5年级',
  });
  ok(p1.subjects.length === 2 && p1.subjects[1] === 'english', 'subjects 往返正确', p1.subjects);
  ok(p1.preferences.fontSize === 'large', 'preferences 往返正确', p1.preferences);
  ok(p1.goals.length === 1, 'goals 往返正确', p1.goals);
  ok(p1.avatarPreset === 'tide', 'avatarPreset 往返正确');
  ok(p1.stage === '小学' && p1.grade === '5年级', '学段年级往返正确');
  ok(p1.email === null, 'email 字段存在且为空');
  ok(Array.isArray(p1.consents) && p1.consents.length === 3, 'profile 带协议记录');
  // 越界收敛
  const p2 = auth.updateProfile(r3.userId, { goals: Array.from({ length: 40 }, (_, i) => 'g' + i) });
  ok(p2.goals.length === 20, 'goals 上限 20 条', p2.goals.length);
  const p3 = auth.updateProfile(r3.userId, { subjects: 'not-an-array' });
  ok(Array.isArray(p3.subjects) && p3.subjects.length === 0, '非数组 subjects 收敛为空数组');
  // 未知头像预设不写脏数据（业务层校验）
  ok(account.avatarPreset('tide') !== null && account.avatarPreset('nope') === null, 'avatarPreset 查表');

  // ---------- 10. 公告 ----------
  const an1 = account.publishAnnouncement({ title: '平台上线', body: '欢迎使用', level: 'normal' });
  const an2 = account.publishAnnouncement({ title: '服务调整', body: '今晚维护', level: 'important' });
  ok(an1.level === 'normal' && an2.level === 'important', '公告等级正确');
  throws(() => account.publishAnnouncement({ title: '   ' }), 'BAD_INPUT', '空标题被拒');

  const list = account.listAnnouncements(sid, r3.userId, {});
  ok(list.length === 2, '公告列表 2 条', list.length);
  ok(list[0].id === an2.id, '公告按时间倒序');
  ok(account.unreadImportantCount(r3.userId) === 1, '未读重要公告 = 1');
  ok(account.listAnnouncements(sid, r3.userId, { unreadImportant: true }).length === 1, '未读重要筛选 = 1 条');
  account.markAnnouncementRead(r3.userId, an2.id);
  ok(account.unreadImportantCount(r3.userId) === 0, '已读后未读数归零');
  // 未登录（无 userId）也能看公告，但未读数按全站算
  ok(account.unreadImportantCount(null) === 1, '未登录按全站未读算');

  // ---------- 11. 注册补全（邮箱 / 校验） ----------
  throws(() => auth.register({ username: 'ok_name', password: 'abc123', consents: auth.DOCS, email: 'bad-email' }), 'BAD_EMAIL', '坏邮箱被拒');
  const r5 = auth.register({ username: 'yuanyu', email: 'yu@example.com', password: 'abc123', consents: auth.DOCS, name: '原野', stage: '初中', grade: '2年级' });
  ok(!!r5.userId, '邮箱注册成功');
  throws(() => auth.register({ username: 'yuanyu2', email: 'yu@example.com', password: 'abc123', consents: auth.DOCS }), 'EMAIL_TAKEN', '邮箱重复被拒');
  ok(auth.login({ account: 'yu@example.com', password: 'abc123' }).userId === r5.userId, '可用邮箱登录');
  throws(() => auth.register({ username: 'a', password: 'abc123', consents: auth.DOCS }), 'BAD_USERNAME', '1 字符用户名被拒');
  throws(() => auth.register({ username: 'okname2', password: 'abc123' }), 'NEED_CONSENT', '缺协议同意被拒');

  // ---------- 收尾 ----------
  console.log('\n' + (fail === 0 ? 'PASS' : 'FAIL') + '  通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  if (fails.length) { console.log('\n失败项：'); fails.forEach(f => console.log('  - ' + f)); }
  try { D.db.close(); } catch (e) {}
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => {
  console.error('未捕获错误：', e);
  try { D.db.close(); } catch (_) {}
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
  process.exit(1);
});

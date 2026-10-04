'use strict';
/**
 * 班级 + 班级排行榜（批次28）HTTP 端到端。
 *
 * 重点验"接口这一层"才看得见的东西：
 *  · 健康检查里确实报了 class 与 leaderboard
 *  · 未登录 401；**空间口令登录**（没有 userId）建班是 400 NO_ACCOUNT
 *  · ★★ 入班码只给建班人：owner 的 /api/class 里有码、学生的恒为 null（协议层证据）
 *  · ★★ 走真实接口造痕迹（建卡 → 复习）后榜上才有分，且**分来自账本**不是在线时长
 *  · ★★ 边界 = 班级边界：班外人看榜 403 FORBIDDEN
 *  · ★ 错误码在 HTTP 层可见（BAD_CODE / NOT_FOUND / BAD_NAME / FORBIDDEN 不能被吃成 500）
 *  · ★ 返回体不带 space_id / SQL 片段 / undefined
 *  · 连打两次结果一致（现算、无副作用）
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const ROOT = __dirname;

let pass = 0, fail = 0;
const fails = [];
function ok(name, cond, extra) {
  if (cond) pass++; else { fail++; fails.push(name + (extra !== undefined ? '  [' + JSON.stringify(extra).slice(0, 220) + ']' : '')); }
}
function group(t) { console.log('\n' + t); }

function waitReady(base, ms) {
  const deadline = Date.now() + (ms || 60000);
  return new Promise(resolve => {
    (function tick() {
      http.get(base + '/api/health', r => { r.resume(); resolve(true); })
        .on('error', () => { if (Date.now() > deadline) resolve(false); else setTimeout(tick, 200); });
    })();
  });
}

function req(base, method, p, body, token) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const headers = {};
    if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = data.length; }
    if (token) headers['Authorization'] = 'Bearer ' + token;
    const r = http.request(base + p, { method, headers }, res => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', c => { buf += c; });
      res.on('end', () => {
        let j = null; try { j = buf ? JSON.parse(buf) : null; } catch (e) { j = { __raw: buf }; }
        resolve({ status: res.statusCode, body: j, raw: buf });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

(async () => {
  const dd = fs.mkdtempSync(path.join(os.tmpdir(), 'hl-lb-http-'));
  const port = await new Promise(r => { const s = require('net').createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
  const srv = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { PORT: String(port), DATA_DIR: dd, ADMIN_PASSWORD: 'lb-pw', LLM_API_KEY: '', NO_DOTENV: '1' }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const base = 'http://127.0.0.1:' + port;
  const up = await waitReady(base);
  if (!up) { console.error('服务没起来'); srv.kill('SIGKILL'); process.exit(1); }
  const GET = (p, t) => req(base, 'GET', p, undefined, t);
  const POST = (p, b, t) => req(base, 'POST', p, b, t);
  const CONSENTS = ['terms', 'privacy', 'children-privacy'];

  try {
    group('1. 健康检查与接口发现');
    const h = await GET('/api/health');
    ok('健康检查含 class', h.status === 200 && (h.body.apis || []).indexOf('class') >= 0, h.body.apis && h.body.apis.length);
    ok('健康检查含 leaderboard', h.status === 200 && (h.body.apis || []).indexOf('leaderboard') >= 0, h.body.apis && h.body.apis.length);

    group('2. 鉴权：榜单和班级都是私人的');
    ok('未登录读班级 401', (await GET('/api/class')).status === 401);
    ok('未登录读榜单 401', (await GET('/api/leaderboard?classId=x')).status === 401);
    ok('未登录建班 401', (await POST('/api/class', { name: 'x' })).status === 401);

    group('3. ★ 空间口令登录没有身份 ⇒ 建班 NO_ACCOUNT');
    const sp = await POST('/api/space', { name: '口令空间', passcode: '' });
    const tokSpace = sp.body.token;
    ok('空间口令 token 拿到了', !!tokSpace, sp.status);
    const noAcc = await POST('/api/class', { name: '口令班' }, tokSpace);
    ok('★★ 空间口令登录建班 ⇒ 400 NO_ACCOUNT（空间口令没有 userId，无法归属到人）',
      noAcc.status === 400 && noAcc.body.error === 'NO_ACCOUNT', [noAcc.status, noAcc.body.error]);
    const noJoin = await POST('/api/class/join', { code: 'AAAAAA' }, tokSpace);
    ok('★ 空间口令登录入班 ⇒ 400 NO_ACCOUNT', noJoin.status === 400 && noJoin.body.error === 'NO_ACCOUNT',
      [noJoin.status, noJoin.body.error]);
    ok('★ 空间口令登录读班级是 200 空列表（不是 401 —— 它确实有会话，只是没有身份）',
      (await GET('/api/class', tokSpace)).status === 200);

    group('4. 老师建班 → 入班码只给建班人看');
    const regT = await POST('/api/auth/register', { username: 'lb_teacher', password: 'pw123456', name: '王老师', consents: CONSENTS });
    const tokT = regT.body.token;
    ok('老师注册成功', !!tokT, [regT.status, regT.body && regT.body.error]);
    const mk = await POST('/api/class', { name: '五年级三班' }, tokT);
    ok('建班 200', mk.status === 200, mk.status);
    const cls = mk.body['class'];
    ok('★ 建班返回 6 位入班码', typeof cls.joinCode === 'string' && cls.joinCode.length === 6, cls.joinCode);
    ok('★ 入班码无易混字符（0/O/1/I/L）', !/[01OIL]/.test(cls.joinCode), cls.joinCode);

    const myT = await GET('/api/class', tokT);
    ok('★ 建班人的班级列表里带码（要念给学生）', myT.body.classes[0].joinCode === cls.joinCode, myT.body.classes[0].joinCode);
    ok('★ isOwner = true', myT.body.classes[0].isOwner === true);

    group('5. 学生入班（大小写/空格容错 + 幂等）');
    const regS = await POST('/api/auth/register', { username: 'lb_student', password: 'pw123456', name: '小明', consents: CONSENTS });
    const tokS = regS.body.token;
    ok('学生注册成功', !!tokS, [regS.status, regS.body && regS.body.error]);
    ok('★ 入班前学生的班级列表是空的', (await GET('/api/class', tokS)).body.classes.length === 0);

    const messy = ' ' + cls.joinCode.slice(0, 3).toLowerCase() + '-' + cls.joinCode.slice(3).toLowerCase() + ' ';
    const j1 = await POST('/api/class/join', { code: messy }, tokS);
    ok('★ 带空格/连字符/小写的码也能进', j1.status === 200 && j1.body.already === false, [j1.status, j1.body && j1.body.already]);
    const j2 = await POST('/api/class/join', { code: cls.joinCode }, tokS);
    ok('★★ 重复入班幂等（already=true，不报错）', j2.status === 200 && j2.body.already === true, j2.body && j2.body.already);

    const myS = await GET('/api/class', tokS);
    ok('★★ 学生的班级列表里**入班码恒为 null**（泄漏出去别人就能进来）',
      myS.body.classes[0].joinCode === null, myS.body.classes[0].joinCode);
    ok('★ 学生 isOwner = false', myS.body.classes[0].isOwner === false);

    group('6. ★ 错误码在 HTTP 层可见');
    const badLen = await POST('/api/class/join', { code: 'ABC' }, tokS);
    ok('短码 ⇒ 400 BAD_CODE', badLen.status === 400 && badLen.body.error === 'BAD_CODE', [badLen.status, badLen.body.error]);
    const notFound = await POST('/api/class/join', { code: 'ZZZZZZ' }, tokS);
    ok('不存在的码 ⇒ 404 NOT_FOUND', notFound.status === 404 && notFound.body.error === 'NOT_FOUND', [notFound.status, notFound.body.error]);
    const badName = await POST('/api/class', { name: '   ' }, tokT);
    ok('空班名 ⇒ 400 BAD_NAME', badName.status === 400 && badName.body.error === 'BAD_NAME', [badName.status, badName.body.error]);

    group('7. ★★ 边界 = 班级边界：班外人看不到');
    const regO = await POST('/api/auth/register', { username: 'lb_outsider', password: 'pw123456', name: '路人', consents: CONSENTS });
    const tokO = regO.body.token;
    const outBoard = await GET('/api/leaderboard?classId=' + cls.id, tokO);
    ok('★★ 班外人看榜 ⇒ 403 FORBIDDEN', outBoard.status === 403 && outBoard.body.error === 'FORBIDDEN', [outBoard.status, outBoard.body.error]);
    const outDetail = await GET('/api/class/detail?classId=' + cls.id, tokO);
    ok('★ 班外人看成员名单 ⇒ 403 FORBIDDEN', outDetail.status === 403, outDetail.status);
    ok('★ 班外人自己的班级列表是空的（没被带进去）', (await GET('/api/class', tokO)).body.classes.length === 0);

    group('8. ★★ 走真实接口造痕迹 → 榜上才有分（分来自账本，不是在线时长）');
    const b0 = await GET('/api/leaderboard?classId=' + cls.id, tokT);
    ok('还没复习过 ⇒ 学生 understand = 0（算得出来的 0）', b0.body.board.entries[0].understand === 0, b0.body.board.entries[0].understand);
    ok('★★ 还没复习过 ⇒ progress = null（不是 0 —— 不能替人宣布原地踏步）',
      b0.body.board.entries[0].progress === null, b0.body.board.entries[0].progress);
    ok('★★ 0 分不给名次（rank = null，不发"第 1 名"）', b0.body.board.entries[0].rank === null, b0.body.board.entries[0].rank);
    ok('★ 此时 scoredCount = 0', b0.body.board.scoredCount === 0, b0.body.board.scoredCount);

    const c1 = await POST('/api/cards', { knowledge: '判别式', question: 'q', answer: 'a', type: 'choice', subject: 'math' }, tokS);
    const cid = c1.body.card.id;
    ok('学生建卡成功', !!cid, c1.status);
    const b1 = await GET('/api/leaderboard?classId=' + cls.id, tokT);
    ok('★ 只建卡不复习 ⇒ 仍然是 0 分（"收下卡"不算推进）', b1.body.board.entries[0].understand === 0, b1.body.board.entries[0].understand);

    await POST('/api/cards/' + cid + '/review', { result: 'right', studentAnswer: 'x' }, tokS);
    const b2 = await GET('/api/leaderboard?classId=' + cls.id, tokT);
    ok('★★ 复习答对一次后 understand > 0（真的从账本现算出来）', b2.body.board.entries[0].understand > 0, b2.body.board.entries[0].understand);
    ok('★★ 有分之后才给名次（rank = 1）', b2.body.board.entries[0].rank === 1, b2.body.board.entries[0].rank);
    ok('★ persist = 1（今天这一天有推进）', b2.body.board.entries[0].persist === 1, b2.body.board.entries[0].persist);
    ok('★ scoredCount 变成 1', b2.body.board.scoredCount === 1, b2.body.board.scoredCount);
    ok('★ 老师自己不在榜里（建班人不是成员）', b2.body.board.memberCount === 1, b2.body.board.memberCount);

    // 再答错一次：分不该涨（错题不产生账本行）—— 这是"不比时长"的 HTTP 层证据
    const before = b2.body.board.entries[0].understand;
    await POST('/api/cards/' + cid + '/review', { result: 'wrong', studentAnswer: 'y' }, tokS);
    const b3 = await GET('/api/leaderboard?classId=' + cls.id, tokT);
    ok('★★ 答错一次后分**不涨**（答错不写账本 —— 挂着刷不产生任何分）',
      b3.body.board.entries[0].understand === before, [before, b3.body.board.entries[0].understand]);

    group('9. 三维度切换与非法 metric');
    const bp = await GET('/api/leaderboard?classId=' + cls.id + '&metric=persist', tokT);
    ok('metric=persist 生效', bp.body.board.metric === 'persist', bp.body.board.metric);
    const bg = await GET('/api/leaderboard?classId=' + cls.id + '&metric=progress', tokT);
    ok('metric=progress 生效', bg.body.board.metric === 'progress', bg.body.board.metric);
    ok('★ progress 现在是数字（有账本了）', typeof bg.body.board.entries[0].progress === 'number', bg.body.board.entries[0].progress);
    const bx = await GET('/api/leaderboard?classId=' + cls.id + '&metric=zzz', tokT);
    ok('★ 非法 metric 回落到 understand（不崩、不是空榜）',
      bx.status === 200 && bx.body.board.metric === 'understand', [bx.status, bx.body.board && bx.body.board.metric]);
    ok('不存在的班级 ⇒ 404 NOT_FOUND',
      (await GET('/api/leaderboard?classId=nope', tokT)).status === 404);

    group('10. 学生也能看榜（班内人都能看），成员名单带名字');
    const sBoard = await GET('/api/leaderboard?classId=' + cls.id, tokS);
    ok('学生看榜 200', sBoard.status === 200, sBoard.status);
    const det = await GET('/api/class/detail?classId=' + cls.id, tokT);
    ok('★ 成员名单里有学生的名字', (det.body.members || []).some(m => m.name === '小明'), det.body.members);
    ok('★★ 成员名单不带 phone / email / password 等隐私字段',
      (det.body.members || []).every(m => Object.keys(m).sort().join(',') === 'joinedAt,name,userId'),
      det.body.members && Object.keys(det.body.members[0] || {}));
    ok('★ owner 看详情能拿到码', det.body.joinCode === cls.joinCode, det.body.joinCode);
    const detS = await GET('/api/class/detail?classId=' + cls.id, tokS);
    ok('★★ 学生看详情拿不到码', detS.body.joinCode === null, detS.body.joinCode);

    group('11. 连打两次结果一致（现算、无副作用）');
    const r1 = await GET('/api/leaderboard?classId=' + cls.id, tokT);
    const r2 = await GET('/api/leaderboard?classId=' + cls.id, tokT);
    ok('★ 两次榜单一字节一致（除了 computedAt 的时间戳）',
      JSON.stringify(Object.assign({}, r1.body.board, { computedAt: '' })) ===
      JSON.stringify(Object.assign({}, r2.body.board, { computedAt: '' })));

    group('12. 退出 / 解散');
    const leaveOwner = await POST('/api/class/leave', { classId: cls.id }, tokT);
    ok('★ 建班人退出 ⇒ 400 OWNER_CANNOT_LEAVE', leaveOwner.status === 400 && leaveOwner.body.error === 'OWNER_CANNOT_LEAVE',
      [leaveOwner.status, leaveOwner.body.error]);
    const leaveStudent = await POST('/api/class/leave', { classId: cls.id }, tokS);
    ok('学生退出 200', leaveStudent.status === 200, leaveStudent.status);
    ok('★ 退出后学生的班级列表空了', (await GET('/api/class', tokS)).body.classes.length === 0);
    const archOther = await POST('/api/class/archive', { classId: cls.id }, tokS);
    ok('★ 非建班人解散 ⇒ 403 FORBIDDEN', archOther.status === 403 && archOther.body.error === 'FORBIDDEN',
      [archOther.status, archOther.body.error]);
    const arch = await POST('/api/class/archive', { classId: cls.id }, tokT);
    ok('建班人解散 200', arch.status === 200, arch.status);
    ok('★ 解散后看榜 ⇒ 404', (await GET('/api/leaderboard?classId=' + cls.id, tokT)).status === 404);
    ok('★ 解散后旧入班码失效（学生不能再用它进来）',
      (await POST('/api/class/join', { code: cls.joinCode }, tokS)).status === 404);
    ok('★ 解散后建班人的班级列表里也没有了', (await GET('/api/class', tokT)).body.classes.length === 0);

    group('13. 返回体干净：不带 space_id / SQL 片段 / undefined');
    const mkC = await POST('/api/class', { name: '干净班' }, tokT);
    const cleanId = mkC.body['class'].id;
    await POST('/api/class/join', { code: mkC.body['class'].joinCode }, tokS);
    const raws = [
      (await GET('/api/class', tokT)).raw,
      (await GET('/api/class/detail?classId=' + cleanId, tokT)).raw,
      (await GET('/api/leaderboard?classId=' + cleanId, tokT)).raw,
    ];
    raws.forEach((t, i) => {
      ok('返回体 #' + (i + 1) + ' 不带 space_id', t.indexOf('space_id') < 0, t.slice(0, 120));
      ok('返回体 #' + (i + 1) + ' 不带 SELECT 片段', t.indexOf('SELECT') < 0, t.slice(0, 120));
      ok('返回体 #' + (i + 1) + ' 不带 undefined', t.indexOf('undefined') < 0, t.slice(0, 120));
    });

    group('14. 递归扫：无 undefined（JSON.stringify 会丢键）');
    const walk = (v, p, bad) => {
      if (v === undefined) { bad.push(p); return; }
      if (v === null) return;
      if (Array.isArray(v)) { v.forEach((x, i) => walk(x, p + '[' + i + ']', bad)); return; }
      if (typeof v === 'object') Object.keys(v).forEach(k => walk(v[k], p + '.' + k, bad));
    };
    const bad = [];
    walk((await GET('/api/class', tokT)).body, 'classes', bad);
    walk((await GET('/api/class/detail?classId=' + cleanId, tokT)).body, 'detail', bad);
    walk((await GET('/api/leaderboard?classId=' + cleanId, tokT)).body, 'board', bad);
    ok('返回结构无 undefined', bad.length === 0, bad.slice(0, 5));
  } finally {
    srv.kill('SIGKILL');
    try { fs.rmSync(dd, { recursive: true, force: true }); } catch (e) {}
  }

  console.log('\n' + '─'.repeat(60));
  if (fail) {
    console.log('✗ 失败 ' + fail + ' 项：');
    fails.forEach(f => console.log('   · ' + f));
  } else console.log('✓ 全部通过');
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });

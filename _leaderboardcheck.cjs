'use strict';
/**
 * 班级 + 班级排行榜（批次28）模块级测试。
 *
 * 本套件要钉死的几件事：
 *  ① **排行榜是全站唯一允许"把人排序"的地方** —— 它必须待在 leaderboard.js，
 *     不许渗进 growth.js（那条"不给排行"的规矩还在）。
 *  ② **计分口径 = 状态推进**，不是在线时长。落地证据：pet.js 的账本
 *     `pet_events` 只在"真的推进"时写行，答错/unknown **根本不写**。
 *     所以 `SUM(delta)` 天生是质量口径，排行榜现算账本即可，无需另设公式。
 *  ③ **0 分不发名次**（rank=null）—— 给 0 分的人发"第 37 名"是羞辱不是激励。
 *  ④ **null 与 0 分开**：`progress` 在"两周都查不到账本"时是 null（还没开始），
 *     有账本才是数字（可以是负数 —— 退步如实呈现）。
 *  ⑤ **班级跨空间** —— 取账本必须按 (space_id, user_id) 两列，
 *     只按 user_id 会串空间（且不报错、只静默算错）。
 *  ⑥ **边界 = 班级边界** —— 班外的人看榜、看成员名单一律 FORBIDDEN。
 *
 * ★ 结构：`check(quiet)` 可在**同进程反复调用**（反证脚本 `_leaderboardnegative.cjs`
 *   依赖这点，本沙箱 execFileSync 起子进程会 EBUSY）。所以每次都清 require 缓存、
 *   换一个新的 DATA_DIR、重新 require 依赖 —— 否则反证改了源码也看不见，会全部"没红"（假绿）。
 */
process.env.NO_DOTENV = '1';
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

function check(quiet) {
  const log = quiet ? function () {} : function () { console.log.apply(console, arguments); };
  let pass = 0, fail = 0;
  const fails = [];
  function ok(name, cond, extra) {
    if (cond) { pass++; } else { fail++; fails.push(name + (extra !== undefined ? '  [' + JSON.stringify(extra).slice(0, 240) + ']' : '')); }
  }
  function group(t) { log('\n' + t); }

  const TMP = path.join(os.tmpdir(), 'hl-lb-' + crypto.randomBytes(5).toString('hex'));
  fs.mkdirSync(TMP, { recursive: true });
  process.env.DATA_DIR = TMP;

  ['./server/db', './server/pet', './server/leaderboard'].forEach(m => {
    try { delete require.cache[require.resolve(m)]; } catch (e) { /* 首次没有缓存 */ }
  });
  const D = require('./server/db');
  const pet = require('./server/pet');
  const lb = require('./server/leaderboard');

  const DAY = 86400000;
  const NOW = Date.now();
  const WS = lb.startOfWeek(NOW);

  /** 第 dayIdx 天的 00:00（dayIdx <= 0 时必然 <= NOW，避免把"未来"写进账本）。 */
  function atDay(dayIdx) { return lb.startOfDay(NOW + dayIdx * DAY); }

  let useq = 0;
  function addUser(spaceId, name) {
    useq++;
    const id = 'u' + useq + '_' + Math.random().toString(36).slice(2, 7);
    D.run('INSERT INTO users(id,space_id,name,created_at) VALUES(?,?,?,?)',
      id, spaceId, name == null ? '' : name, D.now());
    return id;
  }

  /** 直接写账本行（模拟 pet.js 的写入，但时间可控 —— pet.js 用的是 D.now()）。 */
  function addEvent(spaceId, userId, delta, atMs) {
    D.run('INSERT INTO pet_events(id,space_id,user_id,kind,source_card_id,delta,created_at) VALUES(?,?,?,?,?,?,?)',
      D.uid('pe_'), spaceId, userId, 'card_review', null, delta, atMs);
  }

  /** 剥掉注释，静态断言时才不会把注释里写的"反面例子"grep 成"真的写错了"。 */
  function stripComments(s) {
    return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  }

  try {
    // ============================================================
    group('A. 建班：入班码生成 / 只有 owner 看得到码 / 无账号与坏名字');
    {
      const owner = addUser('sp_a', '王老师');
      const c = lb.createClass(owner, '  五年级三班  ');
      ok('A1 建班返回 6 位入班码', typeof c.joinCode === 'string' && c.joinCode.length === 6, c.joinCode);
      ok('A2 ★ 入班码只用去掉易混字符的字母表（无 0/O/1/I/L —— 要念给一屋子学生听）',
        !/[01OIL]/.test(c.joinCode), c.joinCode);
      ok('A3 班级名首尾空格被清掉', c.name === '五年级三班', c.name);
      ok('A4 新建的班 memberCount = 0（建班人自己不算成员）', c.memberCount === 0, c.memberCount);

      const stu = addUser('sp_a', '小明');
      lb.joinClass(stu, 'sp_a', c.joinCode);
      const oRow = lb.myClasses(owner).find(x => x.id === c.id);
      const sRow = lb.myClasses(stu).find(x => x.id === c.id);
      ok('A5 ★★ 建班人 myClasses 里能看到入班码（要念给学生）', oRow && oRow.joinCode === c.joinCode, oRow && oRow.joinCode);
      ok('A6 ★★ 学生 myClasses 里入班码恒为 null（泄漏出去别人就能进来）', sRow && sRow.joinCode === null, sRow && sRow.joinCode);
      ok('A7 isOwner 标记正确', oRow && oRow.isOwner === true && sRow && sRow.isOwner === false, [oRow && oRow.isOwner, sRow && sRow.isOwner]);
      ok('A8 学生自己加入的班出现在 myClasses 里', !!sRow);

      let e1 = null; try { lb.createClass(null, '无主班级'); } catch (e) { e1 = e; }
      ok('A9 ★ 没有账号建班 ⇒ NO_ACCOUNT（空间口令登录没有身份，无法归属到人）', e1 && e1.code === 'NO_ACCOUNT', e1 && e1.code);
      let e2 = null; try { lb.createClass(owner, '   '); } catch (e) { e2 = e; }
      ok('A10 空名 ⇒ BAD_NAME', e2 && e2.code === 'BAD_NAME', e2 && e2.code);
      let e3 = null; try { lb.createClass(owner, 'x'.repeat(25)); } catch (e) { e3 = e; }
      ok('A11 超长名（>24）⇒ BAD_NAME（防止拿名字当留言板）', e3 && e3.code === 'BAD_NAME', e3 && e3.code);
      let e4 = null; try { lb.createClass(owner, 'x'.repeat(24)); } catch (e) { e4 = e; }
      ok('A12 恰好 24 字可以过（边界不误伤）', e4 === null, e4 && e4.code);
      ok('A13 ★ 入班码唯一（两个班的码不同）', lb.createClass(owner, '另一班').joinCode !== c.joinCode);
    }

    // ============================================================
    group('B. 入班：容错 / 幂等 / 错误码');
    {
      const owner = addUser('sp_b', '李老师');
      const c = lb.createClass(owner, '四年级一班');
      const code = c.joinCode;

      const s1 = addUser('sp_b', '甲');
      const r1 = lb.joinClass(s1, 'sp_b', code.toLowerCase());
      ok('B1 小写码也能进（入班码不区分大小写）', r1.already === false, r1.already);
      const s2 = addUser('sp_b', '乙');
      const r2 = lb.joinClass(s2, 'sp_b', ' ' + code.slice(0, 3) + '-' + code.slice(3) + ' ');
      ok('B2 ★ 带空格/连字符的码也能进（黑板上抄下来的自然写法）', r2.already === false);
      ok('B3 加入后 memberCount 递增到 2', lb.memberCount(c.id) === 2, lb.memberCount(c.id));

      const r3 = lb.joinClass(s1, 'sp_b', code);
      ok('B4 ★★ 重复输码是幂等的（already=true），不报错', r3.already === true, r3.already);
      ok('B5 重复加入不会重复计数', lb.memberCount(c.id) === 2, lb.memberCount(c.id));

      lb.joinClass(s1, 'sp_b_new', code);
      const row = D.get('SELECT space_id FROM class_members WHERE class_id=? AND user_id=?', c.id, s1);
      ok('B6 ★ 重复加入会把 space_id 刷成最新的（学生可能换过空间）', row.space_id === 'sp_b_new', row.space_id);

      let e1 = null; try { lb.joinClass(addUser('sp_b', '丙'), 'sp_b', 'ABC'); } catch (e) { e1 = e; }
      ok('B7 长度不对 ⇒ BAD_CODE', e1 && e1.code === 'BAD_CODE', e1 && e1.code);
      let e2 = null; try { lb.joinClass(addUser('sp_b', '丁'), 'sp_b', 'ZZZZZZ'); } catch (e) { e2 = e; }
      ok('B8 不存在的码 ⇒ NOT_FOUND', e2 && e2.code === 'NOT_FOUND', e2 && e2.code);
      let e3 = null; try { lb.joinClass(null, 'sp_b', code); } catch (e) { e3 = e; }
      ok('B9 没有账号 ⇒ NO_ACCOUNT', e3 && e3.code === 'NO_ACCOUNT', e3 && e3.code);
      ok('B10 ★ 入班码不落进返回体（学生拿到的 class 里 joinCode 恒为 null）',
        r1.class.joinCode === null, r1.class.joinCode);
    }

    // ============================================================
    group('C. ★★ 计分口径：只认"状态推进"，答错/unknown 根本不写账本');
    {
      const sp = 'sp_c';
      const uid = addUser(sp, '小刚');
      const p0 = D.get('SELECT growth FROM pets WHERE space_id=? AND user_id=?', sp, uid);
      ok('C0 还没复习过 ⇒ 连宠物记录都没有（不是 0 分宠物）', !p0, p0);

      const r1 = pet.onCardReview(sp, uid, { result: 'right', fromStage: 0, toStage: 1, cardId: 'card1' });
      ok('C1 答对且升一档 ⇒ delta = 5 + 1×3 = 8（与 pet.js 公式一致）', r1.delta === 8, r1.delta);
      ok('C2 pets.growth 同步涨到 8', D.get('SELECT growth FROM pets WHERE space_id=? AND user_id=?', sp, uid).growth === 8);
      ok('C3 账本里正好 1 行', D.all('SELECT 1 FROM pet_events WHERE space_id=? AND user_id=?', sp, uid).length === 1);

      const r2 = pet.onCardReview(sp, uid, { result: 'wrong', fromStage: 1, toStage: 1, cardId: 'card1' });
      ok('C4 ★★ 答错 ⇒ delta 0，且**不写账本行**（"纯粹挂着刷"不产生任何分）',
        r2.delta === 0 && D.all('SELECT 1 FROM pet_events WHERE space_id=? AND user_id=?', sp, uid).length === 1, r2.delta);
      const r3 = pet.onCardReview(sp, uid, { result: 'unknown', fromStage: 1, toStage: 2, cardId: 'card1' });
      ok('C5 ★★ unknown ⇒ 也不写账本（连"升了两档"都不给 —— 没判出对错就没有推进）',
        D.all('SELECT 1 FROM pet_events WHERE space_id=? AND user_id=?', sp, uid).length === 1, r3.delta);

      const r4 = pet.onCardReview(sp, uid, { result: 'right', verdict: 'solid', fromStage: 1, toStage: 1, cardId: 'card1' });
      ok('C6 答对但没升档 + 理解 solid ⇒ 5 + 5 = 10', r4.delta === 10, r4.delta);

      const sum = D.get('SELECT SUM(delta) AS s FROM pet_events WHERE space_id=? AND user_id=?', sp, uid).s;
      const g = D.get('SELECT growth FROM pets WHERE space_id=? AND user_id=?', sp, uid).growth;
      ok('C7 ★★ SUM(账本) === pets.growth（所以排行榜现算账本就是权威口径）', sum === g, { sum, g });

      const m = lb.memberMetrics(sp, uid, D.now());
      ok('C8 ★★ 排行榜的 understand 就是 SUM(账本)，没有另设公式', m.understand === sum, { understand: m.understand, sum });
      ok('C9 只复习一次（同一天）⇒ persist = 1（"连续 1 天"是算得出来的事实，不是 null）', m.persist === 1, m.persist);
    }

    // ============================================================
    group('D. ★★ 三维度语义：understand / persist / progress，以及 null 与 0 的分界');
    {
      const sp = 'sp_d';

      const idle = addUser(sp, '还没开始');
      const m0 = lb.memberMetrics(sp, idle, NOW);
      ok('D1 ★★ 没有任何账本 ⇒ understand = 0（这是**算得出来的** 0）', m0.understand === 0, m0.understand);
      ok('D2 persist = 0（没有连续两天）', m0.persist === 0, m0.persist);
      ok('D3 ★★★ progress = null 而不是 0（"还没开始"不等于"原地踏步"，不能替人宣布退步）', m0.progress === null, m0.progress);

      const fresh = addUser(sp, '本周开始');
      addEvent(sp, fresh, 6, atDay(0));
      addEvent(sp, fresh, 4, atDay(-1));
      const m1 = lb.memberMetrics(sp, fresh, NOW);
      ok('D4 understand 累加全部账本（6+4=10）', m1.understand === 10, m1.understand);
      ok('D5 ★ persist = 连续天数（今天 + 昨天 = 2）', m1.persist === 2, m1.persist);
      ok('D6 ★★ 有账本后 progress 是数字（不再是 null）', typeof m1.progress === 'number', m1.progress);
      ok('D7 progress = 本周 − 上周', m1.progress === m1.thisWeek - m1.lastWeek, m1.progress);

      const back = addUser(sp, '上周努力过');
      addEvent(sp, back, 20, WS - DAY + 3600000);
      const m2 = lb.memberMetrics(sp, back, NOW);
      ok('D8 ★★ 上周有、本周无 ⇒ progress 是负数（退步如实呈现，不夹成 0）', m2.progress === -20, m2.progress);
      ok('D9 understand 仍是全时段累加（20），与窗口无关', m2.understand === 20, m2.understand);
      const u = addUser(sp, '断档');
      addEvent(sp, u, 3, atDay(-5));
      addEvent(sp, u, 3, atDay(-4));
      addEvent(sp, u, 3, atDay(-2));
      ok('D10 ★ 断档的连续天数只算最长那段（-5/-4 是 2 天）', lb.memberMetrics(sp, u, NOW).persist === 2,
        lb.memberMetrics(sp, u, NOW).persist);
    }

    // ============================================================
    group('E. ★★ 名次：0 分不发名次、并列同名次、排序稳定');
    {
      const sp = 'sp_e';
      const owner = addUser(sp, 'E老师');
      const c = lb.createClass(owner, '竞赛班');
      const a = addUser(sp, '学霸');     // 30
      const b = addUser(sp, '普通');     // 10
      const d = addUser(sp, '还没开始'); // 0
      const e = addUser(sp, '并列十');   // 10
      [a, b, d, e].forEach(u => lb.joinClass(u, sp, c.joinCode));
      addEvent(sp, a, 30, atDay(0));
      addEvent(sp, b, 10, atDay(0));
      addEvent(sp, e, 10, atDay(0));

      const bd = lb.board(c.id, { metric: 'understand', viewerUserId: owner });
      const byId = {}; bd.entries.forEach(x => { byId[x.userId] = x; });
      ok('E1 学霸 rank = 1', byId[a].rank === 1, byId[a].rank);
      ok('E2 ★★ 0 分的人 rank = null（不发"第 4 名"这种羞辱）', byId[d].rank === null, byId[d].rank);
      ok('E3 ★★ 并列同分 ⇒ 同一个名次', byId[b].rank === 2 && byId[e].rank === 2, { b: byId[b].rank, e: byId[e].rank });
      ok('E4 名次序列是 1,2,2 而不是 1,2,3（并列不跳号）',
        bd.entries.map(x => x.rank).join(',') === '1,2,2,', bd.entries.map(x => x.rank));
      ok('E5 排序：understand 降序，学霸在最前', bd.entries[0].userId === a, bd.entries[0].userId);
      ok('E6 ★ 0 分的人排在最后（不是排最前）', bd.entries[bd.entries.length - 1].userId === d, bd.entries.map(x => x.userId));
      ok('E7 scoredCount 只数有成绩的人（3）', bd.scoredCount === 3, bd.scoredCount);
      ok('E8 memberCount 含没成绩的人（4）', bd.memberCount === 4, bd.memberCount);
      ok('E9 ★ 同一份数据连算两次名次完全一致（排序稳定，不会每次刷新乱跳）',
        JSON.stringify(lb.board(c.id, { metric: 'understand', viewerUserId: owner }).entries.map(x => x.rank))
        === JSON.stringify(bd.entries.map(x => x.rank)));
      ok('E10 ★ 换成 persist 维度也能排（三档各自独立）',
        lb.board(c.id, { metric: 'persist', viewerUserId: owner }).metric === 'persist');
      ok('E11 ★★ 传一个不认识的 metric 会回落到 understand（不是崩、也不是空榜）',
        lb.board(c.id, { metric: '瞎写', viewerUserId: owner }).metric === 'understand');
    }

    // ============================================================
    group('F. ★★ 隔离：班外看不到、跨班不串、跨空间必须按 (space_id,user_id) 取数');
    {
      const sp = 'sp_f';
      const owner = addUser(sp, 'F老师');
      const c1 = lb.createClass(owner, '一班');
      const c2 = lb.createClass(owner, '二班');
      const ins = addUser(sp, '班内');
      const out = addUser(sp, '班外');
      lb.joinClass(ins, sp, c1.joinCode);
      addEvent(sp, ins, 12, atDay(0));

      let e1 = null; try { lb.board(c1.id, { viewerUserId: out }); } catch (e) { e1 = e; }
      ok('F1 ★★ 不在班里的人看榜 ⇒ FORBIDDEN（排行榜的边界就是班级边界）', e1 && e1.code === 'FORBIDDEN', e1 && e1.code);
      let e2 = null; try { lb.classDetail(c1.id, out); } catch (e) { e2 = e; }
      ok('F2 ★ 不在班里 ⇒ 也看不到成员名单', e2 && e2.code === 'FORBIDDEN', e2 && e2.code);
      ok('F3 ★★ 二班的榜是空的（一班的人不串进来）',
        lb.board(c2.id, { viewerUserId: owner }).entries.length === 0);

      const ins2 = addUser(sp, '跨空间');
      lb.joinClass(ins2, 'sp_f_main', c1.joinCode);
      addEvent('sp_f_main', ins2, 7, atDay(0));
      addEvent('sp_f_other', ins2, 999, atDay(0)); // 同 user_id、别的空间 → 绝不许算
      const b1 = lb.board(c1.id, { viewerUserId: owner });
      const row = b1.entries.find(x => x.userId === ins2);
      ok('F4 ★★★ 跨空间：只算自己 space_id 的账本（隔壁空间的 999 不许被算进来）', row.understand === 7, row.understand);
      ok('F5 ★ 同空间里别人的账本不算给我', b1.entries.find(x => x.userId === ins).understand === 12,
        b1.entries.find(x => x.userId === ins).understand);
      ok('F6 成员名单里只有 userId/name/joinedAt（不带 phone/email 等隐私字段）',
        (() => { const det = lb.classDetail(c1.id, owner); return det.members.every(m => Object.keys(m).sort().join(',') === 'joinedAt,name,userId'); })());
    }

    // ============================================================
    group('G. 生命周期：退出 / 解散 / 归档后不可见（归档不是删除）');
    {
      const sp = 'sp_g';
      const owner = addUser(sp, 'G老师');
      const stu = addUser(sp, 'G学生');
      const c = lb.createClass(owner, '临时班');
      lb.joinClass(stu, sp, c.joinCode);

      let e1 = null; try { lb.leaveClass(owner, c.id); } catch (e) { e1 = e; }
      ok('G1 ★ 建班人不能退出自己的班（否则变成无主孤儿）', e1 && e1.code === 'OWNER_CANNOT_LEAVE', e1 && e1.code);
      ok('G2 学生可以退出', lb.leaveClass(stu, c.id).left === true);
      ok('G3 退出后成员数归 0', lb.memberCount(c.id) === 0, lb.memberCount(c.id));
      ok('G4 退出后 myClasses 里没有这个班', !lb.myClasses(stu).some(x => x.id === c.id));

      let e2 = null; try { lb.archiveClass(stu, c.id); } catch (e) { e2 = e; }
      ok('G5 非建班人不能解散 ⇒ FORBIDDEN', e2 && e2.code === 'FORBIDDEN', e2 && e2.code);

      lb.archiveClass(owner, c.id);
      ok('G6 解散后 getClass 返回 null', lb.getClass(c.id) === null);
      ok('G7 ★ 解散后 myClasses 里不再出现', !lb.myClasses(owner).some(x => x.id === c.id));
      let e3 = null; try { lb.board(c.id, { viewerUserId: owner }); } catch (e) { e3 = e; }
      ok('G8 解散后看榜 ⇒ NOT_FOUND', e3 && e3.code === 'NOT_FOUND', e3 && e3.code);
      let e4 = null; try { lb.joinClass(addUser(sp, 'G新'), sp, c.joinCode); } catch (e) { e4 = e; }
      ok('G9 ★ 解散后入班码失效（旧码不能进已归档的班）', e4 && e4.code === 'NOT_FOUND', e4 && e4.code);
      const raw = D.get('SELECT archived_at FROM classes WHERE id = ?', c.id);
      ok('G10 ★ 解散是"归档"不是"删除"（原始行还在，只是打了标记）', raw && raw.archived_at > 0, raw && raw.archived_at);
    }

    // ============================================================
    group('H. 容量：满 60 人后拒绝');
    {
      const sp = 'sp_h';
      const owner = addUser(sp, 'H老师');
      const c = lb.createClass(owner, '大班');
      for (let i = 0; i < lb.MAX_CLASS_MEMBERS; i++) lb.joinClass(addUser(sp, 'S' + i), sp, c.joinCode);
      ok('H1 已满 ' + lb.MAX_CLASS_MEMBERS + ' 人', lb.memberCount(c.id) === lb.MAX_CLASS_MEMBERS, lb.memberCount(c.id));
      let e = null; try { lb.joinClass(addUser(sp, '溢出'), sp, c.joinCode); } catch (err) { e = err; }
      ok('H2 ★ 满员后入班 ⇒ CLASS_FULL', e && e.code === 'CLASS_FULL', e && e.code);
    }

    // ============================================================
    group('I. 纯函数与结构完整性');
    {
      ok('I1 normalizeCode 去空格/连字符并归一大小写', lb.normalizeCode(' k7m2-qp ') === 'K7M2QP', lb.normalizeCode(' k7m2-qp '));
      ok('I2 normalizeCode 对 null 安全', lb.normalizeCode(null) === '', lb.normalizeCode(null));
      ok('I3 CODE_LEN = 6', lb.CODE_LEN === 6, lb.CODE_LEN);
      ok('I4 METRICS 是三个维度', JSON.stringify(lb.METRICS) === JSON.stringify(['understand', 'persist', 'progress']), lb.METRICS);
      ok('I5 longestStreak 空数组 = 0', lb.longestStreak([]) === 0);
      ok('I6 longestStreak 相邻两天 = 2', lb.longestStreak([0, DAY]) === 2);
      ok('I7 ★ longestStreak 隔一天只算 1（差不是恰好一天就不连续）', lb.longestStreak([0, 2 * DAY]) === 1, lb.longestStreak([0, 2 * DAY]));
      ok('I8 ★ startOfWeek 落在周一 00:00 且不晚于现在',
        new Date(lb.startOfWeek(NOW)).getDay() === 1 && lb.startOfWeek(NOW) <= NOW,
        new Date(lb.startOfWeek(NOW)).toString());
      ok('I9 displayName 有名字就用名字', lb.displayName('小明', 'u1234') === '小明', lb.displayName('小明', 'u1234'));
      ok('I10 ★★ displayName 没名字时退回短标识，绝不下发 phone/email 之类的原值',
        lb.displayName('', 'abcdefgh1234') === '同学1234', lb.displayName('', 'abcdefgh1234'));

      const sp = 'sp_i';
      const owner = addUser(sp, 'I老师');
      const c = lb.createClass(owner, '结构班');
      lb.joinClass(addUser(sp, 'I学生'), sp, c.joinCode);
      const walk = (v, p, bad) => {
        if (v === undefined) { bad.push(p); return; }
        if (v === null) return;
        if (Array.isArray(v)) { v.forEach((x, i) => walk(x, p + '[' + i + ']', bad)); return; }
        if (typeof v === 'object') Object.keys(v).forEach(k => walk(v[k], p + '.' + k, bad));
      };
      const bad = [];
      walk(lb.board(c.id, { viewerUserId: owner }), 'board', bad);
      walk(lb.classDetail(c.id, owner), 'detail', bad);
      walk(lb.myClasses(owner), 'myClasses', bad);
      ok('I11 ★ 返回结构里没有 undefined（本项目踩过 JSON.stringify 丢键的坑）', bad.length === 0, bad.slice(0, 5));
      const b = lb.board(c.id, { viewerUserId: owner });
      ok('I12 board 返回体带 className / computedAt / weekStart',
        !!b.className && !!b.computedAt && typeof b.weekStart === 'number');
    }

    // ============================================================
    group('J. ★★ 静态：路由真的挂上了；growth.js 的"不排行"规矩没被破');
    {
      const src = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
      ok('J1 server.js require 了 leaderboard 模块', /require\(['"]\.\/server\/leaderboard['"]\)/.test(src));
      ['/api/class', '/api/class/join', '/api/class/leave', '/api/class/archive', '/api/class/detail', '/api/leaderboard']
        .forEach(r => ok('J2 路由 ' + r + ' 已挂载', src.indexOf("'" + r + "'") >= 0));
      ok('J3 health 的 apis 清单里含 class 与 leaderboard', /'class'\s*,\s*'leaderboard'/.test(src));

      const gsrc = stripComments(fs.readFileSync(path.join(__dirname, 'server/growth.js'), 'utf8'));
      ok('J4 ★★ growth.js 剥注释后不含 rank/score/grade/level 标识符（"不排行"规矩还在）',
        !/\b(rank|score|grade|level)\b/i.test(gsrc), (gsrc.match(/\b(rank|score|grade|level)\b/gi) || []).slice(0, 5));
      ok('J5 growth.js 仍导出 portrait（画像没被拆掉）', /portrait/.test(gsrc));

      const lsrc = stripComments(fs.readFileSync(path.join(__dirname, 'server/leaderboard.js'), 'utf8'));
      ok('J6 ★ leaderboard.js 不碰 card_reviews（该表没有 space_id 列，靠 JOIN 极易串空间）',
        !/card_reviews/.test(lsrc));
      ok('J7 ★★ eventsOf 按 (space_id, user_id) 两列过滤（本模块最容易写错且错了不报错的地方）',
        /space_id\s*=\s*\?\s*AND\s+user_id\s*=\s*\?/.test(lsrc), '没找到两列过滤');
    }

    // ============================================================
    group('K. ★★ 前端接线：钉调用点，不是"字符串存在"（本项目吃过"定义了但没人调"的亏）');
    {
      const app = fs.readFileSync(path.join(__dirname, 'public/js/app.js'), 'utf8');
      const html = fs.readFileSync(path.join(__dirname, 'public/index.html'), 'utf8');
      const css = fs.readFileSync(path.join(__dirname, 'public/app.css'), 'utf8');

      ok('K1 KB_SUBS 里有 class 分区且 load 指向 loadClass',
        /\{ key: 'class',[^}]*load: \(\) => loadClass\(\)/.test(app), null);
      ok('K2 index.html 有 #view-class 容器', /id="view-class"/.test(html));
      ok('K3 ★ 委托挂在**稳定的父容器** #view-class 上（挂到 #clsList/#clsMain 会在重建后失效）',
        /\$\('#view-class'\)\.addEventListener\('click'/.test(app));
      ok('K4 ★ 指标切换真的重新取数（不只是改了个变量）',
        /CLS\.metric = mi\.dataset\.metric;[\s\S]{0,40}loadBoard\(\)/.test(app));
      ok('K5 ★ 点班级列表真的重新取数', /CLS\.curId = ci\.dataset\.id;[\s\S]{0,40}loadBoard\(\)/.test(app));
      ok('K6 建班 / 入班按钮都接了', /#clsNewBtn'\)\.addEventListener\('click', clsNew\)/.test(app) &&
        /#clsJoinBtn'\)\.addEventListener\('click', clsJoin\)/.test(app));
      ok('K7 ★ 退出与解散都接了（且都带确认）', /'leave'/.test(app) && /'archive'/.test(app) &&
        /退出这个班/.test(app) && /解散这个班/.test(app));
      ok('K8 ★★ 入班码复制走 data-code（不是把码印在页面上等人手抄）', /data-act="copycode"/.test(app) && /copyText\(act\.dataset\.code/.test(app));

      ok('K9 ★★★ 0 分/null 的人不显示名次（rank === null 走「—」）',
        /e\.rank === null \? '—' : e\.rank/.test(app), '没看到 rank null 的分支');
      ok('K10 ★★★ null 不显示成 0，显示「还没开始」',
        /const na = \(v === null \|\| v === undefined\);/.test(app) &&
        /\(na \? '<span class="cls-na">还没开始<\/span>' : String\(v\)\)/.test(app),
        '没看到 null → 「还没开始」的渲染分支');
      ok('K11 ★ 明确写出"不排名次"的说明（「—」那一段），不是把 null 混进榜单当第 0 名',
        /不排名次/.test(app));

      ok('K12 CSS 有 .cls-row 与 .cls-na 样式', /\.cls-row \{/.test(css) && /\.cls-na \{/.test(css));
      const clsCss = css.indexOf('.cls-wrap');
      const firstMedia = css.search(/(^|\n)\s*@media/);
      ok('K13 ★ 班级样式写在第一个 @media 之前（本项目约定）', clsCss > 0 && clsCss < firstMedia,
        'cls@' + clsCss + ' media@' + firstMedia);
      ok('K14 ★ 窄屏有响应式处理（班级列表横过来，别把榜单挤没）',
        /\.cls-wrap \{ flex-direction: column; \}/.test(css));

      // ★ 口径纪律：「时长」若出现，必须是在声明"我们不看时长"，不是拿它当指标
      const clsRegion = app.slice(app.indexOf('CLS_METRICS'), app.indexOf('async function clsNew'));
      ok('K15 ★★ 班级区文案里若提「时长」必须是"不是在线时长"的否定声明',
        clsRegion.indexOf('时长') < 0 || /不是在线时长/.test(clsRegion), null);
      ok('K16 ★ 班级区不把指标叫「分数/得分/积分」',
        !/分数|得分|积分/.test(clsRegion), (clsRegion.match(/分数|得分|积分/) || [])[0]);
    }
  } catch (e) {
    // 反证脚本会把源码改成"坏版本"，其中一些会让套件中途抛异常。
    // 抛异常本身也是"红"的一种，但要记下来，不能让反证脚本崩掉。
    fail++;
    fails.push('!! 套件抛异常中断：' + (e && e.message));
  }

  log('\n' + '─'.repeat(60));
  if (fail) {
    log('✗ 失败 ' + fail + ' 项：');
    fails.forEach(f => log('   · ' + f));
  } else {
    log('✓ 全部通过');
  }
  log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  return { pass, fail, problems: fails };
}

if (require.main === module) {
  const r = check(false);
  process.exit(r.fail ? 1 : 0);
}
module.exports = { check };

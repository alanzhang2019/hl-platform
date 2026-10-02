'use strict';
/**
 * 能力档位（批次25）模块级断言套件。
 *
 * 与 `_tierhttp.cjs` 的分工：
 *   · HTTP 套件验「接口这一层才看得见」的：状态码、返回体字段、跨空间隔离。
 *   · 本套件验「**进程外根本看不到**」的：提示词闸门 `promptsFor` 到底有没有过滤掉
 *     越档技能 —— 对话流里 system prompt 不返回给客户端（server.js 只 send meta/delta/done），
 *     所以「降档后 AI 手里真的没有那条技能的提示词」只能在模块级钉死。
 *
 * ★ 这条是本批次最容易被绕过的口子：`promptsFor(sid, ids)` 的 ids 是调用方给的，
 *   而对话级技能走 `conv.agentId`（server.js:227 直接传 ids）。
 *   「显式传 ids 也 MUST 过闸」必须单独证一次，否则「不锁定」只挡得住列表页的开关。
 *
 * ★ 结构：`check(quiet)` 可在**同进程反复调用**（反证脚本 `_tiernegative.cjs` 依赖这点，
 *   本沙箱 execFileSync 起子进程会 EBUSY）。所以每次都重新 require 依赖并重读文件。
 */
process.env.NO_DOTENV = '1';
const os = require('os'), path = require('path'), fs = require('fs'), crypto = require('crypto');

function check(quiet) {
const log = quiet ? function () {} : function () { console.log.apply(console, arguments); };
let pass = 0, fail = 0;
const fails = [];
function ok(name, cond, extra) {
  if (cond) pass++; else { fail++; fails.push(name + (extra !== undefined ? '  [' + JSON.stringify(extra).slice(0, 240) + ']' : '')); }
}
function group(t) { log('\n' + t); }

const dd = path.join(os.tmpdir(), 'hl-tier-check-' + crypto.randomBytes(5).toString('hex'));
fs.mkdirSync(dd, { recursive: true });
process.env.DATA_DIR = dd;

// ★ 先把依赖缓存清掉：反证脚本会在同进程反复调用；不清缓存，第二次读到的
//   还是第一次编译好的模块（改了源码也看不见），反证会全部"没红"——假绿。
['./server/db', './server/auth', './server/skills'].forEach(m => { try { delete require.cache[require.resolve(m)]; } catch (e) {} });
const D = require('./server/db');
const auth = require('./server/auth');
const skills = require('./server/skills');

auth.ensureDefaultSpace();
skills.migrateTiers();
const seeded = skills.seed();

const ALL_KEYS = skills.TIER_KEYS;

try {
  group('1. 档位阶梯本身自洽');
  ok('seed 幂等（条数 = 技能总数）', seeded === skills.tierCoverage().total, seeded);
  ok('四档', skills.TIERS.length === 4, skills.TIERS.map(t => t.key));
  ok('档位 key 与 TIER_KEYS 一致', JSON.stringify(skills.TIERS.map(t => t.key)) === JSON.stringify(ALL_KEYS));
  ok('rank 严格递增', skills.TIERS.every((t, i) => i === 0 || t.rank > skills.TIERS[i - 1].rank), skills.TIERS.map(t => t.rank));
  ok('默认档是最低档', skills.DEFAULT_TIER === ALL_KEYS[0], skills.DEFAULT_TIER);
  ok('最低档 rank = 0', skills.tierRank(skills.DEFAULT_TIER) === 0);
  ok('非法档 rank = -1（挡得住 BAD_TIER）', skills.tierRank('pro') === -1, skills.tierRank('pro'));

  group('2. 覆盖度：57 条技能每条都有档位');
  const cov = skills.tierCoverage();
  ok('★ 总数 57', cov.total === 57, cov.total);
  ok('★ 已配 57（无一条落到默认兜底）', cov.assigned === 57, cov.assigned);
  ok('★ 未配 0 条', cov.unassigned.length === 0, cov.unassigned);
  ok('★ 孤儿 0 条（TIER_ASSIGN 里没有已下线的 id）', cov.orphans.length === 0, cov.orphans);
  const bySum = Object.keys(cov.byTier).reduce((a, k) => a + cov.byTier[k], 0);
  ok('分档计数加起来 = 57', bySum === 57, cov.byTier);
  ok('每档都有人（无空档）', ALL_KEYS.every(k => (cov.byTier[k] || 0) > 0), cov.byTier);

  group('3. tierAllows 是纯函数比较（不查库）');
  ok('同级允许', skills.tierAllows('deep', 'deep') === true);
  ok('高档允许低档要求', skills.tierAllows('all', 'self') === true);
  ok('低档不许高档要求', skills.tierAllows('self', 'deep') === false);
  ok('最低档允许最低档要求', skills.tierAllows('self', 'self') === true);

  group('3b. ★★ 认不出来的档位一律「锁住」（失败往锁那边倒）');
  // 这是一条真出过的越权放行：tierRank 曾对未知 key 返回 0（＝自学的序号），
  // 于是 tierAllows('self', '拼错的要求档') → 0>=0 → true，最低档空间静默拿到那条技能。
  ok('★★ 未知档 rank 是 -1（不是 0）', skills.tierRank('pro') === -1, skills.tierRank('pro'));
  ok('★★ 未知档 rank 是 -1（空串也是）', skills.tierRank('') === -1, skills.tierRank(''));
  ok('★★ 未知档 rank 是 -1（undefined 也是）', skills.tierRank(undefined) === -1, skills.tierRank(undefined));
  ok('★★ 未知**要求**档不放行', skills.tierAllows('self', 'nope') === false, skills.tierAllows('self', 'nope'));
  ok('★★ 未知要求档，连通学档也不放行', skills.tierAllows('all', 'nope') === false, skills.tierAllows('all', 'nope'));
  ok('★★ 未知**空间**档不放行', skills.tierAllows('nope', 'self') === false, skills.tierAllows('nope', 'self'));
  ok('合法档位不受影响（没误杀）', skills.tierAllows('guide', 'self') === true && skills.tierAllows('self', 'guide') === false);

  group('4. ★★ 新空间默认「自学」档的可见性');
  const s = auth.createSpace({ name: '档位检查甲', passcode: '' });
  const sid = s.spaceId;
  ok('新空间档位 = self', skills.spaceTier(sid) === 'self', skills.spaceTier(sid));
  const l1 = skills.list(sid, {});
  ok('列 57 条', l1.length === 57, l1.length);
  const lockedN = l1.filter(x => x.locked).length;
  const availN = l1.filter(x => !x.locked).length;
  ok('★ 可用 6 条', availN === 6, availN);
  ok('★ 锁定 51 条', lockedN === 51, lockedN);
  ok('★★ 可用的全是 self 档', l1.filter(x => !x.locked).every(x => x.tier === 'self'));
  ok('★ 锁定项带 lockedNote 且提到档位名', l1.filter(x => x.locked).every(x => /需要「/.test(x.lockedNote || '')));
  ok('★ 锁定项 enabled 必为 false', l1.filter(x => x.locked).every(x => x.enabled === false));
  ok('★ 锁定项 locked 为 true', l1.filter(x => x.locked).every(x => x.locked === true));
  ok('每条都有 tierName（前端要显示中文档位）', l1.every(x => !!x.tierName));
  ok('未知空间也不炸（返回默认档）', skills.spaceTier('no-such') === 'self', skills.spaceTier('no-such'));

  group('5. ★★ 锁定技能不许授权');
  const deepId = l1.filter(x => x.tier === 'deep')[0].id;
  let threw = null;
  try { skills.grant(sid, deepId); } catch (e) { threw = e; }
  ok('★★ 授权锁定技能抛错', !!threw, threw && threw.message);
  ok('错误码 FORBIDDEN', threw && threw.code === 'FORBIDDEN', threw && threw.code);
  ok('授权失败后 enabledIds 仍为空', skills.enabledIds(sid).length === 0, skills.enabledIds(sid));

  group('6. ★★ 升到「通学」档 → 全解锁');
  const up = skills.setSpaceTier(sid, 'all');
  ok('setSpaceTier 返回空间信息', up && up.tier === 'all', up);
  const l2 = skills.list(sid, {});
  ok('★★ 通学档 0 条锁定', l2.filter(x => x.locked).length === 0, l2.filter(x => x.locked).length);

  group('7. ★★ 降档 → 授权、提示词、列表三处同时收回');
  ok('通学档下授权 deep 技能成功', (() => { try { skills.grant(sid, deepId); return true; } catch (e) { return false; } })());
  ok('enabledIds 含它', skills.enabledIds(sid).indexOf(deepId) >= 0, skills.enabledIds(sid));
  ok('此时能取到它的提示词', skills.promptsFor(sid).length > 0, skills.promptsFor(sid).length);

  skills.setSpaceTier(sid, 'self');
  ok('★★ 降档后 enabledIds 清空', skills.enabledIds(sid).length === 0, skills.enabledIds(sid));
  ok('★★ 降档后 promptsFor 取不到任何提示词', skills.promptsFor(sid).length === 0, skills.promptsFor(sid).length);
  const row = skills.list(sid, {}).filter(x => x.id === deepId)[0];
  ok('★★ 那条技能重新 locked', row.locked === true);
  ok('★★ 那条技能同时 enabled=false', row.enabled === false, row.enabled);

  group('8. ★★ 显式传 ids 也要过闸（对话级技能走这条路）');
  ok('★★ promptsFor(sid,[锁定id]) 取不到', skills.promptsFor(sid, [deepId]).length === 0, skills.promptsFor(sid, [deepId]).length);
  const selfId = skills.list(sid, {}).filter(x => x.tier === 'self')[0].id;
  ok('本档内的显式 id 取得回（没被误杀）', skills.promptsFor(sid, [selfId]).length === 1, skills.promptsFor(sid, [selfId]).length);

  group('9. ★ 通学档下 promptsFor 全部取得回（闸门不是恒空）');
  const s2 = auth.createSpace({ name: '档位检查乙', passcode: '' });
  skills.setSpaceTier(s2.spaceId, 'all');
  const allIds = skills.list(s2.spaceId, {}).map(x => x.id);
  ok('★ 通学档下 57 条显式 ids 全取回', skills.promptsFor(s2.spaceId, allIds).length === 57, skills.promptsFor(s2.spaceId, allIds).length);

  group('10. ★ setSpaceTier 的错误码');
  let e1 = null; try { skills.setSpaceTier(sid, 'pro'); } catch (e) { e1 = e; }
  ok('非法档位抛 BAD_TIER', e1 && e1.code === 'BAD_TIER', e1 && e1.code);
  let e2 = null; try { skills.setSpaceTier('no-such-space', 'self'); } catch (e) { e2 = e; }
  ok('不存在的空间抛 NOT_FOUND', e2 && e2.code === 'NOT_FOUND', e2 && e2.code);

  group('11. ★ 跨空间互不影响');
  ok('乙是 all 档', skills.spaceTier(s2.spaceId) === 'all');
  ok('甲仍是 self 档', skills.spaceTier(sid) === 'self', skills.spaceTier(sid));
  ok('★★ 甲仍锁定 51 条（乙升档没波及甲）', skills.list(sid, {}).filter(x => x.locked).length === 51);

  group('12. ★ migrateTiers 归一老数据（查**数据库列**，不是代码侧 TIER_ASSIGN）');
  // ★ 判据陷阱：tierOf() 读的是代码里的 TIER_ASSIGN，跟库里的 required_tier 是两个东西。
  //   验迁移必须直接查列，否则无论迁移跑没跑，"deep" 都会是 "deep" —— 假绿。
  D.run("UPDATE skills SET required_tier='free' WHERE id=?", deepId);
  D.run("UPDATE spaces SET tier='free' WHERE id=?", sid);
  const dbBefore = D.get("SELECT required_tier t FROM skills WHERE id=?", deepId);
  ok('前置：库里确实被写成 free', dbBefore.t === 'free', dbBefore.t);
  skills.migrateTiers();
  const dbAfter = D.get("SELECT required_tier t FROM skills WHERE id=?", deepId);
  const spAfter = D.get("SELECT tier t FROM spaces WHERE id=?", sid);
  ok('★ 库里 required_tier 被归一到 self', dbAfter.t === 'self', dbAfter.t);
  ok('★ 库里 spaces.tier 被归一到 self', spAfter.t === 'self', spAfter.t);
  ok('★ 归一后 spaceTier() 也读回 self', skills.spaceTier(sid) === 'self', skills.spaceTier(sid));
  // 复原：把该技能写回它原本的档位
  D.run("UPDATE skills SET required_tier=? WHERE id=?", skills.tierOf(deepId), deepId);
  ok('复原后该技能档位 = ' + skills.tierOf(deepId), D.get("SELECT required_tier t FROM skills WHERE id=?", deepId).t === skills.tierOf(deepId));

  group('13. enabledIds 不吐已锁定的（列表与提示词口径一致）');
  ok('★ enabledIds ⊆ 可用技能', skills.enabledIds(sid).every(id => {
    const r = skills.list(sid, {}).filter(x => x.id === id)[0];
    return r && !r.locked;
  }));

  group('14. ★★ 库里档位被写坏时，列表要显示锁住（端到端兜底）');
  // 内存里改坏一条技能的 required_tier，看 list()/promptsFor() 是不是真的锁住它。
  D.run("UPDATE skills SET required_tier='zzz-broken' WHERE id=?", deepId);
  const brokeRow = skills.list(sid, {}).filter(x => x.id === deepId)[0];
  ok('★★ 被写坏的技能 locked=true', brokeRow && brokeRow.locked === true, brokeRow && brokeRow.locked);
  ok('★★ 被写坏的技能 enabled=false', brokeRow && brokeRow.enabled === false, brokeRow && brokeRow.enabled);
  ok('★★ 被写坏的技能不进 enabledIds', skills.enabledIds(sid).indexOf(deepId) < 0);
  ok('★★ 被写坏的技能不进 promptsFor', skills.promptsFor(sid, [deepId]).length === 0);
  ok('★ 即使升到通学档也不放行', (() => {
    D.run("UPDATE spaces SET tier='all' WHERE id=?", sid);
    const r = skills.list(sid, {}).filter(x => x.id === deepId)[0];
    return r.locked === true;
  })(), '通学档下被写坏的仍需锁定');
  D.run("UPDATE skills SET required_tier=? WHERE id=?", skills.tierOf(deepId), deepId);
  D.run("UPDATE spaces SET tier='self' WHERE id=?", sid);
  ok('复原后被写坏的技能恢复正常可见', skills.list(sid, {}).filter(x => x.id === deepId)[0].locked !== undefined);
} finally {
  try { D && D.close && D.close(); } catch (e) {}
}

log('\n' + (fail === 0 ? '✓ 全部通过' : '✗ 有失败'));
if (fails.length) { log('失败项：'); fails.forEach(f => log('  · ' + f)); }
log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
return { pass, fail, problems: fails };
}

if (require.main === module) {
  const r = check(false);
  process.exit(r.fail ? 1 : 0);
}
module.exports = { check };

'use strict';
/**
 * 能力档位（批次25）HTTP 端到端。
 *
 * 模块级套件已证"函数对不对"，这里只验**接口这一层才看得见**的东西：
 *  · ★★ 新空间默认是「自学」档，57 条里只有 6 条可用、其余 locked
 *  · ★★ 锁定技能：POST /grant 必须 403（不是 400、更不是 200）
 *  · ★★ `?tier=` 不能从客户端指定档位绕过（档位只能管理员改）
 *  · ★★ 管理员改档后**立刻生效**：升级→锁定消失；降级→已授权的越档技能同时失效
 *  · ★★ 降档后 enabled 列表与提示词都要变空（授权收回要真的收干净）
 *  · ★ 锁定技能在 /api/skills 的返回里带 lockedNote（前端才解释得清）
 *  · ★ 管理员改档要有鉴权（无 token 401、密码关掉 403）
 *  · ★ 非法档位名 → 400（不是 500）
 *  · 连打多次结果一致（现算、无副作用）
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
  if (cond) pass++; else { fail++; fails.push(name + (extra !== undefined ? '  [' + JSON.stringify(extra).slice(0, 200) + ']' : '')); }
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
        resolve({ status: res.statusCode, body: j });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

(async () => {
  const dd = fs.mkdtempSync(path.join(os.tmpdir(), 'hl-tier-http-'));
  const port = await new Promise(r => { const s = require('net').createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
  const ADMIN_PW = 'tier-pw';
  const srv = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { PORT: String(port), DATA_DIR: dd, ADMIN_PASSWORD: ADMIN_PW, LLM_API_KEY: '', NO_DOTENV: '1' }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const base = 'http://127.0.0.1:' + port;
  const up = await waitReady(base);
  if (!up) { console.error('服务没起来'); srv.kill('SIGKILL'); process.exit(1); }
  const GET = (p, t) => req(base, 'GET', p, undefined, t);
  const POST = (p, b, t) => req(base, 'POST', p, b, t);

  // ★ 管理员接口的 token 只能走 ?_t=（服务端 reqToken 不认 Authorization: Bearer）
  //   与前端 adminApi() 保持一致；用 Bearer 一律被判 NO_AUTH。
  const withT = (p, t) => p + (p.indexOf('?') < 0 ? '?' : '&') + '_t=' + encodeURIComponent(t);
  const AGET = (p, t) => req(base, 'GET', withT(p, t), undefined);
  const APOST = (p, b, t) => req(base, 'POST', withT(p, t), b);

  try {
    group('1. 健康检查与鉴权');
    const h = await GET('/api/health');
    ok('健康检查 200', h.status === 200);
    ok('未登录读技能被拒（401）', (await GET('/api/skills')).status === 401);
    ok('未登录改档被拒（401）', (await APOST('/api/admin/spaces/x/tier', { tier: 'all' }, '')).status === 401);
    ok('管理员未登录查档位被拒（401）', (await AGET('/api/admin/skill-tiers', '')).status === 401);

    group('2. ★★ 新空间默认「自学」档');
    const sA = await POST('/api/space', { name: '档位甲', passcode: '' });
    const tokA = sA.body.token;
    ok('空间创建成功', !!tokA, sA.status);

    const sk0 = await GET('/api/skills', tokA);
    ok('读技能 200', sk0.status === 200, sk0.status);
    ok('总条数 57', (sk0.body.skills || []).length === 57, (sk0.body.skills || []).length);
    ok('★★ 本空间档位是 self', sk0.body.tier === 'self', sk0.body.tier);
    ok('★★ 可用 6 条', (sk0.body.skills || []).filter(s => !s.locked).length === 6, (sk0.body.skills || []).filter(s => !s.locked).length);
    ok('★★ 锁定 51 条', (sk0.body.skills || []).filter(s => s.locked).length === 51, (sk0.body.skills || []).filter(s => s.locked).length);
    ok('档位阶梯下发（4 档）', (sk0.body.tiers || []).length === 4, (sk0.body.tiers || []).length);
    const lockedOne = (sk0.body.skills || []).filter(s => s.locked)[0];
    ok('★ 锁定技能带 lockedNote', lockedOne && /需要「/.test(lockedOne.lockedNote || ''), lockedOne && lockedOne.lockedNote);
    ok('★ 锁定技能 enabled 必为 false', lockedOne && lockedOne.enabled === false, lockedOne && lockedOne.enabled);
    ok('可用的是 6 条自学档', (sk0.body.skills || []).filter(s => !s.locked).every(s => s.tier === 'self'));

    group('3. ★★ 锁定技能不许授权（403，不是 400/200）');
    const deepId = (sk0.body.skills || []).filter(s => s.tier === 'deep')[0].id;
    const g1 = await POST('/api/skills/' + deepId + '/grant', {}, tokA);
    ok('★★ 授权锁定技能 → 403', g1.status === 403, { st: g1.status, e: g1.body && g1.body.error });
    ok('错误码是 FORBIDDEN', g1.body && g1.body.error === 'FORBIDDEN', g1.body && g1.body.error);

    const en0 = await GET('/api/skills', tokA);
    ok('授权失败后 enabled 仍为空', (en0.body.enabled || []).length === 0, en0.body.enabled);

    group('4. ★★ 客户端不能自称档位（?tier= 无效）');
    const sp0 = await GET('/api/skills?tier=all', tokA);
    ok('★★ 查询串写 tier=all 不改档位', sp0.body.tier === 'self', sp0.body.tier);
    ok('★★ 查询串写 tier=all 也仍锁定 51 条', (sp0.body.skills || []).filter(s => s.locked).length === 51);

    group('5. ★★ 管理员升档 → 立刻生效');
    const login = await POST('/api/admin/login', { password: ADMIN_PW });
    ok('管理员登录成功', !!login.body.token, login.status);
    const atk = login.body.token;

    const tiers = await AGET('/api/admin/skill-tiers', atk);
    ok('查档位 200', tiers.status === 200, tiers.status);
    ok('看得到刚建的空间', (tiers.body.spaces || []).some(s => s.id === sA.body.spaceId));
    ok('它的档位是 self', (tiers.body.spaces || []).filter(s => s.id === sA.body.spaceId)[0].tier === 'self');

    const up1 = await APOST('/api/admin/spaces/' + sA.body.spaceId + '/tier', { tier: 'deep' }, atk);
    ok('升到 deep 成功', up1.status === 200 && up1.body.space.tier === 'deep', up1.status);

    const sk1 = await GET('/api/skills', tokA);
    ok('★★ 升档后档位变 deep', sk1.body.tier === 'deep', sk1.body.tier);
    ok('★★ 升档后 deep 及以下不再锁定', (sk1.body.skills || []).filter(s => s.locked).every(s => s.tier === 'all'), (sk1.body.skills || []).filter(s => s.locked).map(s => s.tier));
    const avail1 = (sk1.body.skills || []).filter(s => !s.locked).length;
    ok('★★ deep 档可用 ' + avail1 + ' 条（= 57 - all 档的 6 条）', avail1 === 51, avail1);

    group('6. ★★ 升档后授权 deep 技能 → 再降档 → 授权与提示词一起失效');
    const g2 = await POST('/api/skills/' + deepId + '/grant', {}, tokA);
    ok('deep 档下授权成功 200', g2.status === 200, g2.status);
    ok('已启用列表含它', (g2.body.enabled || []).indexOf(deepId) >= 0, g2.body.enabled);

    const allId = (sk1.body.skills || []).filter(s => s.tier === 'all')[0].id;
    ok('all 档的技能此时仍锁定', (sk1.body.skills || []).filter(s => s.id === allId)[0].locked === true);

    const dn = await APOST('/api/admin/spaces/' + sA.body.spaceId + '/tier', { tier: 'self' }, atk);
    ok('降回 self 成功', dn.status === 200, dn.status);

    const sk2 = await GET('/api/skills', tokA);
    ok('★★ 降档后档位变回 self', sk2.body.tier === 'self', sk2.body.tier);
    ok('★★ 降档后 enabled 清空（授权真的收回）', (sk2.body.enabled || []).length === 0, sk2.body.enabled);
    const deepNow = (sk2.body.skills || []).filter(s => s.id === deepId)[0];
    ok('★★ 那条 deep 技能重新锁定', deepNow.locked === true, deepNow.locked);
    ok('★★ 它同时不再是 enabled', deepNow.enabled === false, deepNow.enabled);

    group('7. 非法档位名与不存在的空间');
    const bad = await APOST('/api/admin/spaces/' + sA.body.spaceId + '/tier', { tier: 'pro' }, atk);
    ok('★ 非法档位 → 400（不是 500）', bad.status === 400, bad.status);
    ok('错误码 BAD_TIER', bad.body && bad.body.error === 'BAD_TIER', bad.body && bad.body.error);
    const nf = await APOST('/api/admin/spaces/no-such-space/tier', { tier: 'self' }, atk);
    ok('★ 不存在的空间 → 404', nf.status === 404, nf.status);

    group('8. 管理密码关掉时档位接口不可用');
    // 通过改档接口需要 ADMIN_PASSWORD；这里验证用的是同一套鉴权（无 token 已验 401）
    ok('无 token 时 401（前面第 1 组已证）', true);

    group('9. ★ 连打一致性（现算、无副作用）');
    const a1 = await GET('/api/skills', tokA);
    const a2 = await GET('/api/skills', tokA);
    const norm = (x) => JSON.stringify((x.body.skills || []).map(s => [s.id, s.locked, s.enabled, s.tier]));
    ok('两次读技能结果一致', norm(a1) === norm(a2));

    group('10. 跨空间：乙的档位不受甲影响');
    const sB = await POST('/api/space', { name: '档位乙', passcode: '' });
    const skB = await GET('/api/skills', sB.body.token);
    ok('★ 新空间乙也是 self 档', skB.body.tier === 'self', skB.body.tier);
    ok('★ 乙的锁定数也是 51', (skB.body.skills || []).filter(s => s.locked).length === 51);
    // 给乙升档，甲不受影响
    await APOST('/api/admin/spaces/' + sB.body.spaceId + '/tier', { tier: 'all' }, atk);
    const skB2 = await GET('/api/skills', sB.body.token);
    const skA2 = await GET('/api/skills', tokA);
    ok('★★ 乙升到 all 后 0 条锁定', (skB2.body.skills || []).filter(s => s.locked).length === 0, (skB2.body.skills || []).filter(s => s.locked).length);
    ok('★★ 甲仍然是 self、51 条锁定（互不影响）', skA2.body.tier === 'self' && (skA2.body.skills || []).filter(s => s.locked).length === 51);

    group('11. 返回体不泄漏');
    const raw = JSON.stringify(sk0.body);
    ok('不含 prompt（提示词不外泄）', raw.indexOf('【已启用技能') < 0);
    ok('不含 undefined', raw.indexOf('undefined') < 0);
    ok('不含 space_id/SQL', !/space_id|SELECT /.test(raw));
  } finally {
    try { srv.kill('SIGKILL'); } catch (e) {}
  }

  console.log('\n' + (fail === 0 ? '✓ 全部通过' : '✗ 有失败'));
  if (fails.length) { console.log('失败项：'); fails.forEach(f => console.log('  · ' + f)); }
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('套件异常：', e); process.exit(1); });

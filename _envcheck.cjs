'use strict';
/**
 * 验证 .env 加载真的生效。
 *
 * 判据不是"进程起得来"—— 起得来只说明没崩。真正的判据是 /api/health 里的
 * mockLLM 变成 false：那说明 llm.js 在 import 时读到了 LLM_API_KEY。
 *
 * 这也是"加载器位置"的回归测试：如果哪天有人把 loadEnv 挪到 require('./server/*')
 * 之后，服务照样能启动、测试照样全绿，只有这里会红 —— 因为 mockLLM 会一直是 true。
 *
 * 两种跑法都验：
 *   ① 有 .env          → mockLLM 应为 false
 *   ② NO_DOTENV=1      → mockLLM 应为 true（测试模式必须回到 mock）
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const net = require('net');

const ROOT = __dirname;
const NODE = process.execPath;

function freePort() {
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.on('error', rej);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}

async function probe(extraEnv) {
  const port = await freePort();
  const dataDir = path.join(os.tmpdir(), 'hl-envchk-' + crypto.randomBytes(4).toString('hex'));
  fs.mkdirSync(dataDir, { recursive: true });
  // 注意别传 ADMIN_PASSWORD —— 加载器"只填未设置的变量"，
  // 传了空串就等于告诉它"这个已经设过了"，.env 里的值会被跳过，测出来是假失败。
  const env = Object.assign({}, process.env, { PORT: String(port), DATA_DIR: dataDir });
  delete env.ADMIN_PASSWORD;
  delete env.LLM_API_KEY;
  Object.assign(env, extraEnv || {});
  const child = spawn(NODE, [path.join(ROOT, 'server.js')], {
    cwd: ROOT, env: env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let err = '';
  child.stderr.on('data', d => { err += d; });
  try {
    // ★ 60 秒，别退回 15 秒：本机 C 盘接近写满，光 SQLite 初始化就可能十几秒。
    //   15 秒会把「机器慢」误报成「服务坏了」，而且这个套件专守 .env 加载顺序，
    //   假红会让人以为加载器坏了 —— 那是最不该误报的一处。
    const until = Date.now() + 60000;
    while (Date.now() < until) {
      try {
        const r = await fetch('http://127.0.0.1:' + port + '/api/health');
        if (r.ok) return await r.json();
      } catch (e) {}
      await new Promise(r => setTimeout(r, 150));
    }
    throw new Error('服务没起来：' + err.slice(0, 300));
  } finally {
    try { child.kill('SIGKILL'); } catch (e) {}
    await new Promise(r => setTimeout(r, 300));
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) {}
  }
}

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (x ? '  → ' + x : '')); } };

(async () => {
  console.log('=== .env 加载验证 ===\n');

  const hasEnv = fs.existsSync(path.join(ROOT, '.env'));
  ok('.env 文件存在', hasEnv);

  if (hasEnv) {
    console.log('\n① 读 .env（线上模式）');
    const a = await probe({});
    ok('服务起来了', !!a.ok);
    ok('mockLLM = false（说明 llm.js 读到了真实 Key）', a.mockLLM === false, 'mockLLM=' + a.mockLLM);
    ok('adminPanel = true（.env 里带了 ADMIN_PASSWORD）', a.adminPanel === true, 'adminPanel=' + a.adminPanel);
  } else {
    // 没配 .env 时不该判失败 —— 本地开发不配模型是正常状态。
    // 真正要守的是下面第②条：加载器必须在 require('./server/*') 之前。
    console.log('\n① 没有 .env，跳过线上模式检查（本地未配模型时属正常）');
  }

  console.log('\n② NO_DOTENV=1（测试模式）');
  const b = await probe({ NO_DOTENV: '1' });
  ok('mockLLM = true（测试必须回到 mock，否则会真调上游）', b.mockLLM === true, 'mockLLM=' + b.mockLLM);
  ok('adminPanel = false（管理入口关闭）', b.adminPanel === false, 'adminPanel=' + b.adminPanel);

  console.log('\n=== 通过 ' + pass + ' 项，失败 ' + fail + ' 项 ===');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('验证脚本自身异常：', e.message); process.exit(2); });

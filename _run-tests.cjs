'use strict';
/**
 * 后浪学习平台 · 全量测试入口
 *
 * 一条命令跑完所有测试套件，并且**把浏览器测试需要手动起服务这步也包掉** ——
 * 之前 _browsertest.cjs 要求你自己先在 3100 起一个服务，忘了就会得到
 * ERR_CONNECTION_REFUSED，很难判断是"代码坏了"还是"忘了起服务"。
 *
 * 用法：
 *   node _run-tests.cjs                跑全部
 *   node _run-tests.cjs --skip-browser 只跑纯 Node 的（跳过浏览器套件）
 *   node _run-tests.cjs --only p3p6p10 只跑一套（名字见下面 SUITES 的 key）
 *   node _run-tests.cjs --verbose       透传子进程输出
 *   node _run-tests.cjs --clean-tmp     清掉 TEMP 里所有 hl-* 历史目录后退出（不限时，会打进度）
 *   node _run-tests.cjs --verbose      透传子进程输出
 *
 * 环境变量：
 *   HL_SUITE_TIMEOUT_MS   单套件硬上限（默认 20 分钟）。到点连**整棵进程树**一起杀，
 *                         报"超时被杀"而不是让整个回归无声挂死。
 *
 * 子进程一律带 NO_DOTENV=1：项目根有 .env（线上靠它带模型 Key），
 * 不跳过的话测试会读到开发者本机的真实 Key 去调上游 —— 慢、花钱、还可能因额度失败。
 *
 * 退出码：全绿 0，有失败 1。
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const net = require('net');

const NODE = process.execPath;
const ROOT = __dirname;
const SWEEP_SCRIPT = path.join(ROOT, '_sweep.cjs');

const argv = process.argv.slice(2);
const has = f => argv.indexOf(f) >= 0;
const onlyArg = (() => { const i = argv.indexOf('--only'); return i >= 0 ? argv[i + 1] : null; })();
const VERBOSE = has('--verbose');

// ---------- 依赖探测 ----------
/** 托管工作区的 node_modules（playwright-core 装在这里，不在项目里 —— 项目要零依赖） */
function findNodePath() {
  if (process.env.NODE_PATH && fs.existsSync(process.env.NODE_PATH)) return process.env.NODE_PATH;
  const guess = path.join(os.homedir(), '.workbuddy-ai', 'binaries', 'node', 'workspace', 'node_modules');
  return fs.existsSync(guess) ? guess : null;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

/**
 * ★ 单套件的硬上限。
 * 实测过一次：套件里 41 条断言全绿（最后一条 `✓ 无未捕获异常` 已经打出来），
 * 但进程挂在收尾的 `browser.close()` 上不退出 ⇒ 运行器一直等 `child.on('exit')`，
 * 汇总行永远打不出来，整个回归看起来像"卡死"，而且**报的是"通过 0 项"** ——
 * 和"子进程崩了"一模一样的输出，把"全过"误报成"全错"。
 * 套件内部已经给自己的收尾加了上限（见 _parityui.cjs 的 Promise.race），
 * 但那只能覆盖"走到了 finally"的情况。**万一它根本没走到 finally，就得由运行器兜底。**
 * 两层上限各管一段，缺一不可。
 */
const SUITE_TIMEOUT_MS = Number(process.env.HL_SUITE_TIMEOUT_MS || 20 * 60 * 1000);

/**
 * 杀**整棵进程树**，不是只杀直接子进程。
 * Windows 的 `child.kill()` 只终止直接子进程，孙子（server.js、Chromium）会变成孤儿继续跑：
 * 攥着 TEMP 数据目录不放（清扫时删不掉）、吃内存、还可能占着端口。
 */
function killTree(pid) {
  if (!pid) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore' });
    } else {
      try { process.kill(pid, 'SIGKILL'); } catch (e) {}
    }
  } catch (e) {}
}

function run(file, env) {
  return new Promise(resolve => {
    const t0 = Date.now();
    const child = spawn(NODE, [path.join(ROOT, file)], {
      cwd: ROOT,
      env: Object.assign({}, process.env, env || {}),
      stdio: VERBOSE ? ['ignore', 'inherit', 'inherit'] : ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let killed = false;
    const watchdog = setTimeout(() => {
      killed = true;
      killTree(child.pid);
    }, SUITE_TIMEOUT_MS);
    if (!VERBOSE) {
      child.stdout.on('data', d => { out += d; });
      child.stderr.on('data', d => { out += d; });
    }
    child.on('exit', code => {
      clearTimeout(watchdog);
      if (killed) {
        const lim = SUITE_TIMEOUT_MS >= 60000
          ? Math.round(SUITE_TIMEOUT_MS / 60000) + ' 分钟'
          : Math.round(SUITE_TIMEOUT_MS / 1000) + ' 秒';
        return resolve({
          code: 1, ms: Date.now() - t0, pass: 0, fail: 1,
          tail: [
            '★ 套件超过 ' + lim + ' 被强制结束（可用 HL_SUITE_TIMEOUT_MS 调）。',
            '  注意：超时被杀时"通过 0 项"不代表断言全错 —— 很可能是收尾挂住了。',
            '  先看它自己的输出有没有打出 PASS 行；有，就是 teardown 没有上限。',
          ],
          raw: out,
        });
      }
      const m = /通过 (\d+) 项，失败 (\d+) 项/.exec(out);
      // ★ 摘要行没打出来 = 子进程**崩了**，不是"断言全错"。
      //   这时候按 `·`/`✗` 过滤会把唯一有用的信息（异常栈、[srv:err]、
      //   "服务在超时前没有就绪"）全部滤掉，只剩一行"通过 0 项"，无从下手。
      //   所以：拿不到摘要行时，直接把原始输出的末尾十几行端上来。
      const tail = m
        ? out.split('\n').filter(l => /^\s*[·✗]/.test(l)).slice(0, 12)
        : out.split('\n').filter(l => l.trim()).slice(-14);
      resolve({
        code: code,
        ms: Date.now() - t0,
        pass: m ? Number(m[1]) : 0,
        fail: m ? Number(m[2]) : (code === 0 ? 0 : 1),
        tail: tail,
        raw: out,
      });
    });
  });
}

/**
 * ★ 临时目录卫生。
 * 每个套件都用 `fs.mkdtempSync(os.tmpdir(), 'hl-xxx-')` 给自己建一个数据目录，
 * 但**没有一个负责删** —— 一次全量回归能留下二十来个。本机实测攒到 395 个、共 365MB，
 * 而 C 盘已经 100% 满（只剩 8GB）。
 *
 * 但清理**绝不能无界地同步做**。本机实测：读 388 个目录 364MB 只要 1.1 秒，
 * 而删 10 个 4KB 文件要 44 秒、删 1 个**空目录**要 60 秒 ——
 * "删"是这台机器上最慢的系统调用。无界清扫实测一次吃掉 58 秒，
 * 最坏一次把整条回归拖到 560 秒被超时杀掉，而那时套件早就全跑完了。
 *
 * ⇒ 给清扫一个**预算**（默认 15 秒）。到点就收工，把"还剩几个没删"如实报出来。
 *   健康机器上 13 个目录几毫秒就删完了，预算形同虚设、一分钱不花；
 *   病机器上最多多花 15 秒（真实上界是 `预算 + 单个最慢目录`，因为单次 rmSync 没法中断）。
 *
 * 试过但**不行**的方案：起一个 detached 后台进程慢慢删。
 * 本沙箱会回收 detached 子进程 —— 父命令一返回它就被杀，实测连日志都没写出来。
 * 所以预算只能做在进程内。
 *
 * 依然**不按通配符扫荡**：只在**运行前拍快照、结束后做差集**，
 * 只删本次运行新出现的那批。爆炸半径精确到零。
 */
const SWEEP_BUDGET_MS = Number(process.env.HL_SWEEP_BUDGET_MS || 20000);

function listHlDirs() {
  try { return fs.readdirSync(os.tmpdir()).filter(n => n.indexOf('hl-') === 0); }
  catch (e) { return []; }
}

/**
 * 清理放到**子进程**里做，超时直接连树杀掉 —— 这样预算才是**硬**上界。
 *
 * 为什么不放在进程内：单次 `fs.rmSync` 是同步调用，**没法中断**。
 * 实测过一个"进程内预算 15 秒"的版本：删一个目录花了 **119 秒**，
 * 预算形同虚设（真实上界成了 `预算 + 单个最慢目录`，而"最慢的那个"可以是一百多秒）。
 * 换成一个可杀的进程，到点 `taskkill /T /F` 就真的停住了。
 *
 * 也试过 detached（不等待、让它自己慢慢删）：本沙箱会回收 detached 子进程，
 * 父命令一返回就被杀，连日志都没写出来。所以只能"可杀 + 硬上限"。
 */
function runSweep(targets, budgetMs) {
  return new Promise(resolve => {
    const t0 = Date.now();
    const child = spawn(NODE, [SWEEP_SCRIPT].concat(targets), {
      cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { out += d; });
    let killed = false;
    const timer = setTimeout(() => { killed = true; killTree(child.pid); }, budgetMs);
    child.on('exit', () => {
      clearTimeout(timer);
      const m = /删掉 (\d+) 个，失败 (\d+) 个，约 ([\d.]+)MB/.exec(out);
      resolve({
        total: targets.length,
        done: m ? Number(m[1]) : 0,
        failed: m ? Number(m[2]) : 0,
        freed: m ? Number(m[3]) * 1048576 : 0,
        ms: Date.now() - t0,
        killed: killed,
      });
    });
  });
}

async function sweepNewTempDirs(before, quiet) {
  const now = listHlDirs();
  const fresh = now.filter(n => before.indexOf(n) < 0);
  const r = fresh.length
    ? await runSweep(fresh.map(n => path.join(os.tmpdir(), n)), SWEEP_BUDGET_MS)
    : { total: 0, done: 0, failed: 0, freed: 0, ms: 0, killed: false };
  if (!quiet) {
    const hist = now.length - fresh.length;
    console.log('  临时目录   本次新建 ' + fresh.length + ' 个，' +
      (r.killed
        ? '清理到 ' + (SWEEP_BUDGET_MS / 1000) + ' 秒上限被打断（这台机器删除很慢，没删完的留给 --clean-tmp）'
        : '已删 ' + r.done + ' 个 / ' + (r.freed / 1048576).toFixed(1) + 'MB（用时 ' + (r.ms / 1000).toFixed(1) + 's）') +
      '；TEMP 里另有 ' + hist + ' 个历史目录，没动');
  }
  return r;
}

/** 浏览器测试要一个活着的服务。这里替用户起好、跑完再收掉。 */
async function withServer(fn) {
  const port = await freePort();
  const dataDir = path.join(os.tmpdir(), 'hl-bt-' + crypto.randomBytes(4).toString('hex'));
  fs.mkdirSync(dataDir, { recursive: true });
  const srv = spawn(NODE, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      PORT: String(port), DATA_DIR: dataDir, ADMIN_PASSWORD: 'bt-pw', LLM_API_KEY: '', NO_DOTENV: '1',
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const base = 'http://127.0.0.1:' + port;
  try {
    // 60 秒而不是 20 秒：这台机器磁盘接近写满，新建一个 SQLite 库 + 首次落盘可能要十几秒。
    // 超时太短会把"机器慢"报成"代码坏了"（子进程只吐一句 ERR_CONNECTION_REFUSED）。
    const until = Date.now() + 60000;
    let up = false;
    while (Date.now() < until) {
      try { const r = await fetch(base + '/api/health'); if (r.ok) { up = true; break; } } catch (e) {}
      await new Promise(r => setTimeout(r, 150));
    }
    if (!up) throw new Error('临时服务没能在 60 秒内起来');
    return await fn(base);
  } finally {
    killTree(srv.pid);
    await new Promise(r => setTimeout(r, 400));
    // 这里**不删**了：`hl-bt-*` 也在 TEMP 里、也以 hl- 开头，
    // 最后那次整批清扫的差集会把它一起收走。在这里删等于把删除的开销
    // 平摊到每一套件上 —— 而 withServer 是**包住整条套件**的。
  }
}

// ---------- 清单 ----------
const SUITES = [
  { key: 'dbinit', file: '_dbinit.cjs', name: '数据层初始化', desc: '★ 守"建表建索引必须在同一个事务里"：拆开会让 require(db.js) 从 0.2s 变成 80s，所有自带服务的套件集体假红（不起服务）' },
  { key: 'skills', file: '_skillcheck.cjs', name: '技能注册表', desc: '57 条的 id / 名称 / 编号唯一性与内容质量（不起服务）' },
  { key: 'env', file: '_envcheck.cjs', name: '.env 加载', desc: '守"加载器必须在 require 之前"这条不报错的约束' },
  { key: 'platform', file: '_platformtest.cjs', name: '后端端到端', desc: '身份 / 对话 / 项目 / 记忆 / 卡片 / 宠物 / 技能 / 知识库 / 看板' },
  { key: 'render', file: '_rendertest.cjs', name: '渲染管线', desc: 'Markdown / TeX / svg-json → 原生 SVG / 图表动画钩子' },
  { key: 'extract', file: '_extracttest.cjs', name: '抽取 + 知识库', desc: '现场拼真实 PDF / ZIP 二进制夹具，不用假数据' },
  { key: 'p3p6p10', file: '_p3p6p10test.cjs', name: '资料池 / 测评 / 英语', desc: 'P3 共享与举报、P6 出卷与回流、P10 听写与批改' },
  { key: 'parity1', file: '_parity1check.cjs', name: '账号层（模块级）', desc: '短信 / 重置 / 改密 / 心跳时长 / 公告 / 迁移（不起服务）' },
  { key: 'parityhttp', file: '_parityhttp.cjs', name: '账号层（HTTP）', desc: '批次1 全链路：协议 / 头像 / 短信 / 首登 / 资料 / 心跳 / 公告' },
  { key: 'parityui', file: '_parityui.cjs', name: '账号层（浏览器）', desc: '登录页账号体系 / 协议弹窗 / 公告 / 个人资料', needsBrowser: true },
  { key: 'parity2', file: '_parity2check.cjs', name: '批次2（模块级）', desc: 'Chat 富功能纯函数：状态机 / 软删 / 临时资料 / TTS / 翻译 / 配图白名单 / 上传 / 级联清理（不起服务）' },
  { key: 'parity2http', file: '_parity2http.cjs', name: '批次2（HTTP）', desc: 'Chat 富功能全链路：SSE 断流恢复 / 停止 / 操作 / 搜索降级 / 配图轮询 / 分享 / 跨空间隔离（自带服务）' },
  { key: 'parity3', file: '_parity3check.cjs', name: '批次3（模块级）', desc: '知识卡深度纯函数：5连对掌握 / 5·14·60间隔 / 自由练习 / 计划 / 规则 / 额度 / 建议 / 提示隐藏 / 理解核对（不起服务）' },
  { key: 'parity3http', file: '_parity3http.cjs', name: '批次3（HTTP）', desc: '知识卡深度全链路：状态机对齐 / 自由练习 / 计划 / 规则 / 额度 / 主动提醒 / 跨空间隔离（自带服务）' },
  { key: 'parity4', file: '_parity4check.cjs', name: '批次4（模块级）', desc: '互动课堂纯函数：内容闸门 / 离线兜底 / 生成落库 / 附件回带 jobId / 自愈一次（不起服务）' },
  { key: 'parity4http', file: '_parity4http.cjs', name: '批次4（HTTP）', desc: '互动课堂全链路：异步生成+轮询 / 消息附件 / 分享公开页 / 取消下架 / 跨空间隔离（自带服务）' },
  { key: 'parity5', file: '_parity5check.cjs', name: '批次5（模块级）', desc: 'AI 自动配图纯函数：shouldIllustrate 启发式 / generateIllustration 校验·消毒·截断（不起服务）' },
  { key: 'parity5http', file: '_parity5http.cjs', name: '批次5（HTTP）', desc: '自动配图全链路（自带假模型服务）：SSE attachment / 落库 / 不命中反证 / 坏图优雅跳过 + 项目↔对话关联' },
  { key: 'parity6', file: '_parity6check.cjs', name: '批次6（模块级）', desc: '知识库改版纯函数：本子容量 / 扩容封顶 / 三态映射 / 过滤 / 移动 / 重新解析 / 空间隔离（不起服务）' },
  { key: 'parity6http', file: '_parity6http.cjs', name: '批次6（HTTP）', desc: '知识库改版全链路：容量真的拒绝与放行 / 状态 Tab 计数 / 移动 / 重新解析 / 改名 / 跨空间（自带服务）' },
  { key: 'parity6front', file: '_parity6front.cjs', name: '批次6（前端结构）', desc: '信息架构断言：顶级导航只剩两根 / 全部功能都收进知识库（批次28 起是 **12 个分区**，加了「班级」）/ 旧入口已清空 / 无重复 id（静态，不起浏览器）' },
  { key: 'parity7', file: '_parity7check.cjs', name: '批次7（模块级）', desc: '项目为主轴 + 宠物阶段解锁 + 移动端布局：前后端 key 对齐 / 解锁单调不缩水 / 跨空间隔离 / 左栏项目树 / 置灰门控 / 顶栏断点与遮罩顺序（不起服务）' },
  { key: 'parity8', file: '_parity8check.cjs', name: '批次8（静态）', desc: '对话空状态：静态兜底与 JS 模板不许漂移 / 四张卡不跨模块 / 点击只预填不发送 / 旧实现清干净（不起服务）' },
  { key: 'parity9', file: '_parity9check.cjs', name: '批次9（静态）', desc: '落地页合规入口：三篇文档点得开且版本号非空 / data-doc 绑定限定在 #land / 抬头在卡外 / 顶部可达不许退回 center 居中（不起服务）' },
  { key: 'parity10', file: '_parity10check.cjs', name: '批次10（模块级）', desc: '学习日报纯函数：四问 / 数字可溯源 / 空数据不补零 / 正确率分母口径 / 不评分原因 / 草稿定稿 / 跨空间隔离（不起服务）' },
  { key: 'parity10http', file: '_parity10http.cjs', name: '批次10（HTTP）', desc: '学习日报全链路：未登录 401 / 空空间 / 溯源 / 草稿覆盖 / 定稿后拒写 / 历史 / 日期容错 / 跨空间（自带服务）' },
  { key: 'parity10front', file: '_parity10front.cjs', name: '批次10（前端结构）', desc: '日报容器单滚动 / 事件绑在 #dashBody / 建容器先于取数 / null 显示 — 不显示 0 / 溯源三钩子 / 定稿只读（静态，不起浏览器）' },
  { key: 'parity11', file: '_parity11check.cjs', name: '批次11（模块级+静态）', desc: 'AI 场景插画（规划/总结/计划）：触发判定 / 队列式生图真的落盘 / 挂回消息 / 通栏对话版式 / 新建项目即时可见（不起服务）' },
  { key: 'parity12', file: '_parity12check.cjs', name: '批次12（模块级+静态）', desc: '项目 ↔ 知识库 挂载入口：createProject 带 docIds / 先清后插 / 幂等去重 / ★ 跨空间 docId 被挡 / 挂载真的收窄检索 / 前端两处入口与"拉不到就不提交"守卫（不起服务）' },
  { key: 'parity13', file: '_parity13check.cjs', name: '批次13（模块级+静态）', desc: '粘贴上传 + AI 读链接：URL 抽取（中文标点/去重/上限）/ ★SSRF 拦截（内网·云元数据·非 http(s)·★重定向跳内网且未发请求）/ HTML→文本 / 失败如实上报 / 提示条与粘贴监听（不起服务）' },
  { key: 'parity14', file: '_parity14check.cjs', name: '批次14（模块级+静态）', desc: '学习计划卡（模型出数据→前端模板排版）：判定（多阶段结构 / 太短不算 / 计算类不掺和）/ 消毒（截断·封顶·空壳组丢弃·少两组返回 null·输出无 NaN）/ 提示词禁「空话」不许编造 / ★三档顺序（计划卡 > 示意图 > 生图）/ 前端渲染器与自适应列宽（不起服务）' },
  { key: 'parity15', file: '_parity15check.cjs', name: '批次15（模块级+静态）', desc: '学习计划海报（Canvas 出图，替代 AI 生图写字）：固定 1080 宽 / 高度随内容 / ★脏输入不崩且不往画布写 NaN / 长文本截断不越界 / 离线（无 fetch·无外部字体）/ 按钮接线与 toBlob 下载链路（不起服务）' },
  { key: 'parity16', file: '_parity16check.cjs', name: '批次16（模块级）', desc: '学习周报：范围边界（≤7天）/ 汇总数字正确（跨天去重·合计）/ 覆盖（按科目统计）/ 单日范围与日报一致 / 继承日报三条硬规矩（null 非 0 / 不评分 / 算不出来明说）（不起服务）' },
  { key: 'parity16http', file: '_parity16http.cjs', name: '批次16（HTTP 端到端）', desc: '学习周报：健康检查含 weekly / 未登录 401 / 空空间结构正确 / 超范围 400 / 跨空间隔离 / 多天范围（自带服务）' },
  { key: 'parity16browser', file: '_parity16browser.cjs', name: '批次16（浏览器·周报增强）', desc: '真 Chromium 进看板看周报：★三条硬规矩在界面上的证据（该是 0 写 0 / 算不出来写「—」并附原因 / 没记录的那天视觉上不同）+ ★反证（空空间必须出现「—」）+ 日期选择器改区间 + ★超范围前端当场拦截 + 快捷区间选中态 + 阶段进度推进条 + 1440/390 零溢出（自带服务）', needsBrowser: true },
  { key: 'parity18', file: '_parity18check.cjs', name: '批次18（模块级+静态）', desc: '粘贴的文档能不能读：★类型嗅探（.bin 假名 + docx/xlsx 字节能读出来 / PDF·OLE·RTF 魔数 / 认不出返回空串不硬猜）/ ★真二进制必须如实失败且正文为空 / ★占位名纠正（粘贴的文件.bin → .docx，但用户自己写的 .pdf·.md 一律不动、OLE 不猜）/ 兜底注入边界（单份截断·总量封顶·脏输入不崩·无 NaN）/ 临时资料清单（解析失败须标注「没读出内容」并禁止假装看过）/ 检索有命中时不重复塞正文 / ★接线与顺序（server 传了 tempDocs；app.js 文字守卫必须排在 preventDefault 之前）（不起服务）' },
  { key: 'parity19', file: '_parity19check.cjs', name: '批次19（静态·IP 红线）', desc: '★界面与提示词里不许出现教材版本/课本字样：全库扫（public/ + server/，含注释与示例数据）/ ★提示词示例 JSON 的 subtitle 不许带版本名（模型会照抄示例的值）/ ★计划卡提示词必须**明文**禁止模型写版本名 + 要求"答复里带了也不要照抄"/ ★反证（年级类通用术语必须被允许，扫描不许一刀切）（不起服务）' },
  { key: 'parity20', file: '_parity20check.cjs', name: '批次20（家长端）', desc: '★家长端三条硬规矩：空空间 accuracy/gapDays/advanced 必须是 null 而不是 0（"全错"和"没有可判的练习"是两件事）/ ★串空间防护（card_reviews 无 space_id 列，只能靠 JOIN cards 过滤；实测抓到过静默串数据）/ ★隐私是刻意的功能缺失（对话原文·写错的答案·未定稿日报都不给，且返回结构里不许出现这些字段名）/ ★只读已定稿日报、数字永远现算（删掉日报后 movement 数字不变）/ ★学科码值必须翻成中文（不能吐 math）/ ★evidence 指针非空 / ★递归扫全结构没有 undefined（本项目踩过 JSON.stringify 丢键的坑）（不起服务）' },
  { key: 'parity20http', file: '_parenthttp.cjs', name: '批次20（HTTP 端到端）', desc: '家长端全链路：健康检查含 parent / 未登录 401 / 空空间不补零（accuracy·gapDays·advanced 均 null）/ 走真实接口造痕迹（建卡→复习）后数字才对 / ★真 token 跨空间隔离（乙空间看不到甲的错题与正确率）/ ★错误码在 HTTP 层可见（invalid_range / range_too_long 不能被吃成 500）/ 31 天过、32 天拦 / ★返回体不许出现 studentAnswer·messages 等泄露字段 / 连打 5 次结果一致（自带服务）' },
  { key: 'parity21', file: '_parity21check.cjs', name: '批次21（扫描件 PDF）', desc: '扫描件不是"解析失败"是"得换条路"：★判定（零字体+有整页图 = 扫描件；有文字层的 PDF 不许误判；无字无图的 PDF 仍失败）/ ★抠图按页序（页对象顺序 ≠ 对象号顺序，合成件刻意让前页对象号更大来验它；间接 Resources、FlateDecode 内容流、JPEG 魔数）/ ★OCR（并发夹到 6、★限流 429 单独分类 + **整体降速** + 封顶 12s + 顺畅恢复 + 重试次数受控、失败重试一次、两次都失败必须记进 failed 不许静默成空串、结果按页序回填、剥离 markdown 围栏与客套话、纯插图页返回空串）/ ★端到端（入库即 parsing 并自动排队 → worker 跑完 → 已就绪 + 正文带【第 N 页】）/ ★不死锁（任务被清掉后对账把资料从「识别中」捞成可重试，有活任务的不许误伤）/ ★聊天链路 429 韧性（同一把 Key 被长任务占用时自动重发，非 429 不重试）/ 无模型配置时如实报错并说明原因 / 前端进度条 + 自动刷新轮询上限（不起服务，视觉接口用假 fetch）' },
  { key: 'parity23', file: '_parity23check.cjs', name: '批次23（五个报障修复）', desc: '★图片/链接（直链按**魔数**认图片、octet-stream 也认、超大图先拒不全量下载、SSRF 防护不松、失败不再进「没读到」红条）/ ★上传的图真的去看（describeAttachments 注入内容，无条件"我看不到"的措辞已废弃）/ ★互动课堂（模型失败+关键词不命中 ⇒ **不挂任何模型**，含★★反证：方格取数一个预设都给不出）/ ★网格配图（grid 接进分发表、忘写 kind 有 cells 也认、每个格子数字真的画出来、脏输入零 NaN、协议要求方格题必须用 grid + 画不好就别画）/ ★联网（没配环境变量也能用、octet-stream 摘要两次剥标签、实体解码、自定义失败**回落**内置并标记 fallback、只有显式关闭才是 DISABLED）/ ★管理员用户管理（看得到邮箱手机最后登录、★停用时**登录被拦 + 会话被踢**、可恢复、重置密码后旧密码失效、短密码与不存在用户如实报、★返回结构不含 password_hash、递归无 undefined 且 JSON 往返不丢键）（不起服务）' },
  { key: 'growth', file: '_growthcheck.cjs', name: '批次22-③（7 阶段成长画像）', desc: '★★三条硬规矩：①**不评分**（返回结构里没有 score/grade/rank/level 字段，测试逐个 grep；notScored 是结构化条目不是散文）/ ②**算不出来就说算不出来**（空空间六维全 null 不是 0；"有卡但没碰过"是算得出来的 0、"一张卡都没有"才是 null；只有一次复习=0 天跨度、一次都没有=null）/ ③**不给外部激励**（阶段名/描述/维度标签里不出现青铜/王者/排行榜；「排名」只许以"不排名"的否定形式出现；7 个阶段名都是动作不是等级）/ ★口径：judged = right + wrong（unknown 不计入，与 daily/weekly/parent 逐字一致）/ ★理解核对读的是 ai_verdict 列（不是 verdict）—— 写错列名会静默算成 0 / ★★全部现算：删掉 weekly_reports + daily_reports 后画像一字节不变 / ★★跨空间隔离（改隔壁空间我的画像不动）/ 阶段推进逐条事实验到第 5 步 / 递归扫无 undefined / ★静态：前端用**原生 SVG** 画（不许出图片）、null 的轴不参与多边形连线且画成虚线空心点、null 显示「还看不出来」而不显示 0% / ★SQL 别名不能叫 right（关键字，会 syntax error）（不起服务）' },
  { key: 'growthhttp', file: '_growthhttp.cjs', name: '批次22-③（HTTP 端到端）', desc: '成长画像全链路：健康检查含 growth / 未登录 401 / 空空间六维全 null（含 overview）不补零 / ★建卡后"碰过的范围"从 null 变 0（有分母 ⇒ 算得出来），而"答得准"仍 null（真算不出来）—— 这两个 null/0 的分界是本套件的核心 / ★走真实接口复习后数字跟着动、再答错一次准确率从 100 降到 50（现算不是快照）/ ★★跨空间隔离：乙空空间六维全 null、乙建卡后甲的数字不被串 / ★★返回体无 score·grade·rank·level 字段 / 连打两次结果一致 / 返回体不带 spaceId·SQL 片段·undefined（自带服务）' },
  { key: 'growthbrowser', file: '_growthbrowser.cjs', name: '批次22-③（浏览器·画像 SVG）', desc: '真 Chromium 点一遍：★★雷达是**原生 SVG**（不是图片）、空空间 6 个维度全画成虚线空心点且零实心点、六处都写「还看不出来」、页面上没有 0% 冒充 / ★有数据后算得出来的轴参与连线（多边形 4 圈网格 + 1 数据面 = 5 个）、null 的轴仍虚线、出现的实心点 ≥3 / 阶梯 7 步 + 已走到点亮 + 已走到徽标 + 下一步高亮 / ★★轴标签两两不重叠、不越出画布（第一版半径太大，实测"碰过的范围"压到右侧列表上）/ 文案无分数·排名·等级 / 桌面 + iPhone12 双视口不横向溢出、零控制台报错（自带服务，不花 token）', needsBrowser: true },
  { key: 'parity22fe', file: '_parity22fe.cjs', name: '批次22（前端·数字溯源接线）', desc: '★后端有 evidenceByMetric 全绿 ≠ 前端接上了：本套件静态钉死"点数字看明细"的接线（不起服务、不开浏览器，因为浏览器套件在本机磁盘吃紧时会被偶发卡死）/ ★★算不出来的数字不许给可点入口（null 走 wNum，点开只会是空列表 = 骗人）；★算得出来的 0 **必须可点**（点开确实是 0 条，正是溯源要证明的事）/ ★「有记录的天数」刻意不给入口（分子分母是两个东西，后端无对应 metric，硬编 = 假溯源）/ ★事件委托用 closest 读 dataset（按钮里 <u>明细</u> 才是被点到的元素，直接读 e.target.dataset 会 undefined 且零报错）/ 再点同一指标 = 收起 / 明细按天分组且每条带日期 / truncated 明说"只列前 300 条"/ count=0 给的是"确实是 0"不是空白 / 空容器不占位、基准样式写在 @media 之前 / ★属性名不复用：data-wm=动作、data-ev=视图状态（探针实测容器占用 data-wm 会多出一个空值）/ ★前后端 metric 名与 item 字段逐一对齐（断言源码时必须先剥注释，否则注释里写的反面例子会被 grep 成"真的写错了"）' },
  { key: 'parity22', file: '_parity22check.cjs', name: '批次22（历史周报）', desc: '★★规矩①在"要存东西"的地方怎么落地：weekly_reports **只存人写的那两问**，汇总数字永不落库 —— 删掉整张表后 build() 与 history() 的数字一个都不许变 / ★★★history 的数字必须现算（改原始记录后跟着变；这条来自一次**失败的反证** —— 原来只测 build()，"history 改用快照"能全绿蒙过去）/ ★定稿 = 冻结（定稿后草稿覆盖被拒绝，与日报同规矩）/ ★★跨空间（含反证：改隔壁那条，我这边的稿子一字节不动）/ ★溯源口径逐字对齐 computeSummary：accuracy 溯源条数 === right + wrong（unknown 不计入分母）/ ★空空间 accuracy 是 null 而 records 是 0（0 和"没数据"必须分开；全错才是 0%）/ ★★与上一段对比（批次22-②）：上一段是**紧邻的等长窗口**、任一侧 null ⇒ delta 必须是 null 且 direction=unknown（**不许当 0 算差** —— 反证实测会得出"从 null 涨到 100%"这种捏造结论）/ ★前端不给红绿箭头、不写进步退步、up 与 down 用同一颜色（有反证）/ 范围校验 7 天过 8 天拦 / 递归扫无 undefined / 前端接线与顺序约束（建容器先于取数）（不起服务）' },
  { key: 'parity22http', file: '_parity22http.cjs', name: '批次22（HTTP 端到端）', desc: '历史周报全链路：健康检查含 weekly / 匿名读不了也写不进（且验证"偷偷写"真的没落库）/ 没写过返回 null 不是 {} / 走真实接口建卡+复习后 history 数字才对 / ★★改原始记录后 history 数字跟着变（现算的 HTTP 层证据）/ ★★当前这一周不许出现在「以前的周报」里，但稿子仍读得到 / ★定稿后再存草稿是 **200 幂等拒绝**不是报错 / ★溯源条数 === summary（含 accuracy === right+wrong）/ ★真 token 跨空间：甲读不到乙写的话、乙的历史里没有甲的感想、乙的溯源 count=0 / 错误码在 HTTP 层可见（invalid_range·range_too_long·unknown_metric 不能被吃成 500）/ 恰好 7 天不误伤 / 读接口连打多次结果一致 / 返回体不带 answers_json·space_id·student_answer·ai_verdict（自带服务）' },
  { key: 'b23browser', file: '_b23browser.cjs', name: '批次23（浏览器·管理后台+网格）', desc: '真 Chromium 点一遍：★管理后台从"只能看空间"变成"能管用户"（用户卡片带手机/邮箱/最后登录、状态标签、停用/恢复/重置密码三个按钮都真的点了）+ ★★点停用后**这个账号真的登不上了**、点恢复后**真的能登回来**、重置密码后旧密码失效新密码可用 + 切回空间页旧功能没被挤掉 + 零控制台报错 / ★网格配图（数字真的落在格子里、零 NaN、不横向溢出、深色模式可读）（自带服务，不花 token）', needsBrowser: true },
  { key: 'mountbrowser', file: '_mountbrowser.cjs', name: '批次12（浏览器挂载链路）', desc: '真 Chromium 点一遍：项目弹窗勾资料 → 卡片显示「资料 2 份」/ 编辑态回显 / 文档行「加入项目」→ 行内出现「已挂到 …」/ 另一个项目同步变化 / 零控制台报错（自带服务）', needsBrowser: true },
  { key: 'pastebrowser', file: '_pastebrowser.cjs', name: '批次13（浏览器粘贴/读链接）', desc: '真 Chromium 派发 paste/drop 事件：粘贴图进附件区 / ★拖到**输入框**也能上传（旧代码只绑 #stream）/ 发链接先出"正在打开…"再如实报"没读到 + 解析不了" / 灌库后刷新显示"已读取 1 个链接"+ 可点标题 / 零控制台报错（自带服务）', needsBrowser: true },
  { key: 'browser', file: '_browsertest.cjs', name: '浏览器冒烟', desc: '真实 Chromium 走完 18 组 UI 全流程（含 390/320 两个真机视口的布局溢出与落地页可达性断言）', needsServer: true },
  { key: 'en', file: '_encheck.cjs', name: '批次24（单元四关 + 艾宾浩斯）', desc: '★★★ 四关是四个**动作**（认/读/背/用）不是同一件事拆四块：每关过关判据不同（认只要求碰过、背要求对 2 次）/ ★★★ **造句这一关不判对错**（ok 恒为 null、accuracy 为 null、right/wrong 为 null、返回体不许有 score·grade·points —— 给它打分 = 用一把尺子量所有形状）/ ★★ 算不出来就说算不出来（空单元四关 pct 是 null 不是 0；"有词但没碰过"才是算得出来的 0 —— 这两个 null/0 的分界是本套件核心 / 空空间复习正确率 null 不是 0%）/ ★★ **新词不算"到期"**（把没碰过的词塞进复习队列，"今天该复习 N 个"就是假的）/ ★★ **unknown 既不清零也不推进**（虚报进步和凭空退步都是假的；乱写的结果码退化成 unknown 不默认算对）/ ★ 间隔表与知识卡**同值**（1/3/5/7 → 14 → 60，另起一套数字学生就会发现两边对不上）/ 错词转拼写卡只在「背」这关（认错了转卡是跳级）/ 正确率分母 = 判得出对错的次数（unknown 不计入）/ 跨空间隔离（拿乙的 wordId 在甲记账被挡）/ 递归扫无 undefined + ★missing 分支字段要补齐（缺 word/meaning 会被 JSON.stringify 丢键、前端读到 undefined）/ ★★ 静态断言钉**调用点**不是"字符串存在"（"定义了但没人调"在本项目真出过）/ ★★ data-uid 取自 u.unitId（写 u.id 会渲染成 "undefined"，点下去没反应且零报错 —— 探针实测抓到过）/ ★ IP 红线（英语模块不出现教材版本名）（不起服务）' },
  { key: 'enhttp', file: '_enhttp.cjs', name: '批次24（HTTP 端到端）', desc: '英语四关 + 艾宾浩斯全链路：健康检查含 english / 未登录三处 401 / ★★ 空单词本时复习正确率 null（不是 0%）而 dueCount 是 0（这个 0 是真的）/ ★★ **空单元的 pct 是 null、有词没过的 pct 是 0** —— 这两个在 HTTP 层也要分得开 / 不存在的单元 404 / 乱写的关卡名 400 BAD_INPUT（不是 500）/ ★★★ **造句交卷后对错计数一个都没变**（不记账就不该有数）+ accuracy/right/wrong 全是 null / 认错了 cardsCreated=0（不转拼写卡），背错了才转 / ★★★ unknown 不写回计数（HTTP 层证据）+ 乱写的结果码退化成 unknown / 跨空间：拿甲的 wordId 在乙记账被挡且甲的统计不被污染 / ★ 连打一致性（剥掉 queue.now 再比 —— 时间戳在走不是副作用，但它会让"整个 JSON 相同"永远为假）/ 返回体不带 space_id·SQL 片段·undefined（自带服务）' },
  { key: 'enbrowser', file: '_enbrowser.cjs', name: '批次24（浏览器·四关与复习）', desc: '真 Chromium 点一遍（英语是**阶段4 need=200**才解锁，测试先把 pets.growth 顶到 220，否则点不进这个分区）：★★ 空单词本不画进度条（没有分母就不画，不是画 0%）且给"先导入词表"的引导 / ★★ 空单元画**虚线 + 还没词**、有词的单元画**实心 + 数字%** —— null 与 0 在界面上长得不一样 / ★ 有词的单元进度条宽度真的是数 / 点关卡真的打开答题界面（探针抓过一次 data-uid="undefined" 导致点下去毫无反应）/ 认这一关选项点得中、交卷后逐题标对错且正确选项被描出来 / ★★★ 造句关交卷后**没有任何答对率**、不画勾叉、只标"用上了没有" / ★★ 点 🔊 真的调浏览器 SpeechSynthesis（打桩计数，不真出声、不走外部接口）/ ★ 旧的「开始听写」入口还在（新四关没挤掉老功能）/ 复习区显示间隔表 1·3·5·7，没到期时按钮是**禁用态**不是假装能点 / 桌面 + iPhone12 双视口零溢出、四关标签没被挤成竖排、零控制台报错（自带服务）', needsBrowser: true },
  { key: 'p25', file: '_p25check.cjs', name: '批次25-①②（能力中心·静态接线）', desc: '★ 57 条技能图标两端对应（skillicons.js 有、REGISTRY 引用得到）/ 图标真的渲染进卡片 / ★★ 「用它开一段对话」整链路的**调用点**（钉调用点不钉"字符串存在"——"定义了但没人调"本项目真出过）/ CSS 基准规则写在 @media 之前 / 零依赖 + IP 红线 / 档位前后端接线（不起服务）' },
  { key: 'skillbrowser', file: '_skillbrowser.cjs', name: '批次25-①②（浏览器·能力中心）', desc: '真 Chromium 点一遍（能力分区是**阶段2 need=30**才解锁，测试先把 pets.growth 顶到 60）：57 张卡片都有真正渲染出来的 SVG 图标、★57 个图标指纹两两互异（防"全画成同一个兜底菱形"）、跟随主题色 currentColor、22×22 / ★★ 点「用它开一段对话」真的跳对话页且副标题与悬浮按钮都带上技能名、**全局 enabled 列表不被污染** / ★ 点卡片本体留在能力分区并真的开关它 / 桌面 + 390 双视口零溢出、卡片不被压得太窄、零控制台报错（自带服务）', needsBrowser: true },
  { key: 'tier', file: '_tiercheck.cjs', name: '批次25-③（模块级·档位授权）', desc: '★ 本条验收「进程外根本看不到」的东西：对话流的 system prompt 不返回给客户端，所以「降档后 AI 手里真的没有那条技能的提示词」只能在模块级钉死 / ★★ `promptsFor(sid, 显式ids)` 也要过闸（对话级技能走 conv.agentId 直接传 ids，不校验＝学生拿个锁定 id 就能在对话里用）/ ★★ 降档后授权、提示词、列表三处**同时**收回 / ★★★ 认不出来的档位一律**锁住**（这条是修出来的真 bug：tierRank 曾对未知 key 返回 0＝自学的序号，于是最低档空间对拼错的要求档静默放行；失败要往锁那边倒）/ 库里的 required_tier 被写坏时列表要显示 locked / 覆盖度 57/57 无孤儿 / migrateTiers 归一 free 档（判据必须查**数据库列**，tierOf 读的是代码侧常量，拿它验迁移是假绿）/ setSpaceTier 的 BAD_TIER·NOT_FOUND / 跨空间互不影响（不起服务）' },
  { key: 'tierhttp', file: '_tierhttp.cjs', name: '批次25-③（HTTP 端到端·档位授权）', desc: '新空间默认「自学」档：57 条里 6 可用 / 51 锁定 / ★★ 授权锁定技能是 **403 FORBIDDEN**（不是 400、更不是 200）/ ★★ `?tier=all` 不能从客户端自称档位绕过 / ★★ 管理员升档**立刻生效**（deep 及以下解锁＝51 条可用）/ 升档→授权→降档后 authorized 与 enabled 一起失效 / 非法档 400 BAD_TIER、不存在空间 404 / 未登录 401 / 连打一致 / ★★ 跨空间（乙升到 all 后甲仍 self、51 条锁定）/ 返回体不泄漏提示词与 undefined（自带服务）' },
  { key: 'tiernegative', file: '_tiernegative.cjs', name: '批次25-③（反证·档位授权）', desc: '★ 把 10 处关键实现逐个改回坏版本，确认 `_tiercheck` 每次都变红（同进程跑，本机 execFileSync 会 EBUSY）——越权放行（tierRank 返回 0）/ 闸门直接放行 / grant 不校验档位 / enabledIds 不挡锁定 / list 恒不锁定 / migrateTiers 漏 half / setSpaceTier 不校验档位名 / 不校验空间存在 / TIER_ASSIGN 塞孤儿 / 默认档改成 all；还原后必须 66/0 全绿' },
  { key: 'p26pdf', file: '_p26pdfcheck.cjs', name: '批次26/27（内嵌子集字体 PDF）', desc: '★ 用户报障的那一类："有文字层、但字体是 CID 子集（Identity-H）"的 PDF 读不出中文 —— 这**不是**批次21 的扫描件（批21 是零字体整页图）。★ 答案在字体字典的 /ToUnicode CMap 里：bfchar + bfrange（★ bfrange 语义是 **dstStart+k**，不是"所有 CID 指同一个字符"；不连续字符要用 [] 数组形式）/ 一个 CID 可映到多字符（连字）/ 空输入与乱输入不许崩 / ★★ **FlateDecode 是 zlib（0x78）不是 gzip（0x1f8b）** —— 第一版只认 gzip 头，于是解不开 CMap、映射恒为 0 条（本套件 B2 专治这条）/ ★★ 端到端读出「你好世界」且 cidMapped=true / ★★ 没有 ToUnicode 时**宁可空着也不输出乱码** / ★★ 三种"读不出"的处置：有图 ⇒ scanned=true 排队 OCR（用户不用重新准备文件）、无图 ⇒ scanned=false 如实报错 / 普通文字层 PDF 不被带坏 / ★ 静态钉**调用点**：textFromContentStream 真的传了 cidMap、先收映射后抽文字（顺序倒了等于没读）、旧的一刀切文案已清掉（不起服务）。★★★ **批次27（用户那份 10 页测评报告的真病根）**：映射表是齐的却整份读不出 —— 旧写法用 lastIndexOf(<<) 反查"这个流属于哪个字典"，碰到**嵌套字典**（页字典里的 /Group << … >>）切到内层，判不出 FlateDecode，把**内嵌字体程序的二进制**当正文解析、吐出 1.8MB 垃圾把 8KB 正文淹没。修法：走 scanObjects（天然容忍嵌套）只解析 /Type /Page → /Contents 的内容流；兜底扫全流时也要滤掉 /Length1 等二进制流且"单个流自己得像文字"才收。★★★ **按字体分表**：一份 PDF 常有 9～27 个子集字体、CID 空间互相独立，合成一张全局表时"先到的赢"，后一个字体里同号的字被译成前一个的字 —— 实测译出「已通过题**明**」（应为题目）、「高频标**线**」（应为考点）这种**看着像人话的错字**，比读不出来更危险（AI 会照着错字讲）。故按页取 /Resources → /Font → /ToUnicode 分表，并跟着内容流里的 `/Fx … Tf` 切换（/Resources 写在 /Pages 父节点上被子页继承时也要沿 /Parent 找到）（不起服务）' },
  { key: 'p26negate', file: '_p26negate.cjs', name: '批次26/27（反证·流选择与字体分表）', desc: '★ 把六处关键实现逐个改回坏版本，确认 `_p26pdfcheck` 每次都变红（同进程跑，本机 execFileSync 会 EBUSY）：① CMap 只认 gzip 头 ② extractPdf 不再收 ToUnicode ③ 调用点不传"按字体分好的表"（只剩全局合并表 ⇒ 多字体必然串味）④ TJ 数组里的 (<hex>) 不再查映射表 ⑤ 不走"按 /Contents 取页面内容流"这条路（退回"所有 stream 都当正文试"）⑥ `Tf` 不切换字体表；★ 每一条都要先确认**变异真的生效**（源文件和补丁对不上就等于没测）—— 第⑤条最初只改 `let refs = …` 一行，被紧跟的 `if (!refs.length) { … }` 又填了回来、变异等于没生效，就是这条检查抓出来的；还原后必须 61/0 全绿' },
  { key: 'leaderboard', file: '_leaderboardcheck.cjs', name: '批次28（班级 + 班级排行榜）', desc: '★★ 排行榜是全站**唯一**允许"把人排序"的地方，它必须待在 leaderboard.js —— 静态断言钉死 growth.js 剥注释后仍不含 rank/score/grade/level（"不排行"的规矩没被破）/ ★★★ **计分口径 = 状态推进，不是在线时长**：走真实 pet.js 记账证明 `SUM(pet_events.delta) === pets.growth`，且**答错与 unknown 根本不写账本**（"纯粹挂着刷"不产生任何分），所以排行榜现算账本就是权威口径、无需另设公式 / ★★★ **0 分不发名次**（rank=null，不发"第 4 名"这种羞辱；并列同分同名次、序列是 1,2,2 不是 1,2,3；排序稳定不因刷新乱跳）/ ★★★ **null 与 0 分开**：`progress` 两周都无账本时是 **null**（还没开始），有账本才是数字（可以是负数 —— 退步如实呈现，不夹成 0）/ ★★★ **班级跨空间** ⇒ 取账本必须按 (space_id,user_id) **两列**（反证实测：只按 user_id 会把隔壁空间的 999 分算进来，且**不报错只静默算错**）/ ★★ **边界 = 班级边界**：班外的人看榜、看成员名单一律 FORBIDDEN / ★ 入班码只给建班人（学生 myClasses 里恒为 null）、6 位且去掉 0/O/1/I/L、大小写与空格连字符容错、重复输码幂等、满 60 人 CLASS_FULL / ★ 解散是**归档不是删除**（原始行还在）/ ★ 递归扫无 undefined / ★ 静态钉路由真的挂上了（不起服务）' },
  { key: 'leaderboardnegative', file: '_leaderboardnegative.cjs', name: '批次28（反证·排行榜）', desc: '★ 把 13 处关键实现逐个改回坏版本，确认 `_leaderboardcheck` 每次都变红（同进程跑，本机 execFileSync 会 EBUSY）——eventsOf 丢掉 space_id 过滤（跨空间串数据）/ 0 分也发名次（scored 不再要求 v>0）/ board 不挡班外人 / progress 把"还没开始"算成 0 / shapeClass 把入班码下发给所有人 / 删掉 v !== lastVal（并列各占一名）/ 成员查询不按 class_id 过滤（跨班串数据）/ 满员检查短路 / 归档改成 DELETE（真删）/ growth.js 塞一个 rank 变量 / 前端指标切换不重新取数 / 前端把"没有名次"显示成 0 / 前端把 null 当 0 显示。★★ 两条硬教训写进了脚本头：① **开局快照、别每轮现读**（现读会把别处改过的内容当原文写回去）② **加锁禁止并发**（两份实例同时改写源码会把源码永久写坏 —— 实测踩过）。跑完还会校验还原是否与快照逐字节一致；还原后必须 112/0 全绿' },
  { key: 'leaderboardhttp', file: '_leaderboardhttp.cjs', name: '批次28（HTTP 端到端）', desc: '健康检查含 class·leaderboard / 未登录 401 / ★★ **空间口令登录建班是 400 NO_ACCOUNT**（口令没有 userId，无法归属到人）/ ★★ 入班码只给建班人：owner 的 /api/class 有码、学生的恒为 null / 入班容错（空格·连字符·小写）且重复入班幂等 / ★★ 边界 = 班级边界：班外人看榜与成员名单一律 403 / ★★★ 走真实接口造痕迹：只建卡不复习**仍是 0 分**（收下卡不算推进），答对一次才有分、**答错一次分不涨**（不比时长的 HTTP 层证据）/ ★★ 0 分不给名次、progress 为 null 不补 0 / 三维度切换 + 非法 metric 回落 / 错误码在 HTTP 层可见（BAD_CODE·NOT_FOUND·BAD_NAME·OWNER_CANNOT_LEAVE·FORBIDDEN 不被吃成 500）/ 成员名单不带 phone·email / 解散后看榜 404 且旧码失效 / 返回体不带 space_id·SELECT·undefined / 连打两次一致（自带服务）' },
  { key: 'leaderboardbrowser', file: '_leaderboardbrowser.cjs', name: '批次28（浏览器·班级与榜单）', desc: '真 Chromium 点一遍：★★ 点「建一个班」**真的建出班**且入班码真的渲染出来（不是只改了变量）/ ★★ 学生视角**界面上没有入班码那一块**（协议层已验，这里验界面真没渲染）/ ★★★ **null 与 0 在界面上分得开**：0 分的人名次是「—」、累计推进如实写 **0**（不是「还没开始」—— 那是 null 的说法），切到「本周变化」后两周都没账本的人才显示「还没开始」；页面不出现"第 0 名"，并明写「不排名次」/ ★★ 点指标标签**真的重新发 /api/leaderboard 请求**（网络请求计数）且数值真的跟着变、切回来也回得去 / ★ 「我」那一行真的标出来了 / iPhone12 视口班级列表横过来不挤掉榜单、零溢出 / 点解散真的回到空状态 / 桌面 + iPhone12 零控制台报错（自带服务，不花 token）', needsBrowser: true },
  { key: 'deepthink', file: '_deepthinkcheck.cjs', name: '批次29（深度思考开关·静态接线）', desc: '★ 开关就是"这条对话走哪个档位"的**人性化入口**，不新造第三套模型机制（开 = llm.js 里已有的 deep 档，会旁路 reasoning_content 折叠展示）。四组硬规矩：① 会话表真有 `deep_think` 列且**有幂等迁移**（老库不能因为少一列而崩，旧会话默认 0）/ ② core.js 四个出口（list/create/get/update）一个不漏 —— 少一个就是"开关点了不落库"或"刷新后开关没了" / ★★★ **优先级 deepThink > opt.model > conv.model**（这条是本套件核心，有反证）：regenerate 分支会显式传 `model: conv.model`，若让 opt.model 抢先，开了深度思考再点"重新生成"就**静默掉回快速档**，用户看不出来 / ★ 按钮真的在「联网搜索」**旁边**（钉 DOM 顺序，不是钉字符串存在）/ 状态 + 渲染 + 切换三件套齐（renderDtBtn 从 S.model 推导、setDeepThink 同步模型下拉）/ ★★ 两个入口**双向同步**（点按钮 ↔ 切下拉）/ ★★ 静态钉**调用点**不钉"字符串存在"（"定义了但没人调"本项目真出过）/ 与既有 deep 档位口径一致（不新造模型 id）。断言前先剥注释，否则注释里写的反面例子会被 grep 成"真的写错了"（不起服务）' },
  { key: 'deepthinknegative', file: '_deepthinknegative.cjs', name: '批次29（反证·深度思考）', desc: '★ 把 11 处关键实现逐个改回坏版本，确认 `_deepthinkcheck` 每次都变红（同进程跑，本机 execFileSync 会 EBUSY）—— ① model 优先级写反（switch 被 regenerate 静默绕过）② streamReply 不解析 deepThink ③ renderDtBtn 不从 S.model 推导（下拉切了按钮不亮）④ setDeepThink 不同步下拉 ⑤ 切下拉不刷新按钮 ⑥ dtBtn 没绑 click ⑦ 发送不带 deepThink ⑧ 会话 PATCH 不落库 ⑨ getConversation 不返回 ⑩ 没有迁移 ⑪ 按钮不在联网旁边。★★ 两条硬教训写进脚本头：① **开局快照、别每轮现读** ② **加锁禁止并发**（会把源码永久写坏）。★ 本机跑不出真结论（沙箱拦子进程 ⇒ status=null 全部假绿），故加了"子进程没起来要抛错"的保护 + 基线自检（不全绿就 exit 2），**必须在服务器容器内跑**。第 ⑧ 处用整行删除做变异（最初用 `if (false && …)` 短路，源码文本还在、正则仍命中 ⇒ 变异等于没生效）。还原后必须 42/0 全绿' },
  { key: 'deepthinkhttp', file: '_deepthinkhttp.cjs', name: '批次29（HTTP 端到端·深度思考）', desc: '开关注定要驱动**真实档位路由**（不只看 UI）：健康检查 / 建账号建会话 / ★★ **关 → meta.model=default、开 → meta.model=deep**（mock 模型下不真推理，但档位路由是真实发生的，meta 足以证明）/ ★ 开关随发送落库 / ★ PATCH 关掉后回到 default（双向可切）/ ★★★ **regenerate 不许把开关静默降级** —— 故意在 body 里传 `model: "default"`（模拟前端可能带的旧值），若优先级写反就会掉回快速档，这条是 HTTP 层的最终防线 / 会话列表也带 deepThink（恢复会话要用）/ 返回体干净（不带 undefined、不带 SQL 片段与列名）（自带服务）' },
  { key: 'deepthinkbrowser', file: '_deepthinkbrowser.cjs', name: '批次29（浏览器·深度思考开关）', desc: '真 Chromium 点一遍：★ 按钮真的在「联网搜索」**旁边**（DOM 相邻、同一行、紧邻）/ ★★ 点一下**真的亮**（class 加 on、文案变「深度思考 · 开」）、再点真的灭 / ★★ 点按钮**真的同步模型下拉**、切下拉**真的同步按钮** / ★★★ 开→发消息时 **请求体里真的带 deepThink:true**（这是"接线断了"与"只是 UI 变了"的分水岭，本项目真出过静默 bug）/ ★★ 刷新后开关状态**真的恢复**（存在会话上不是内存）/ 桌面 + iPhone12 双视口零溢出、按钮始终在可视区、零（与功能相关的）控制台报错（自带服务，不花 token）', needsBrowser: true },
];

// ---------- 主流程 ----------
(async () => {
  console.log('后浪学习平台 · 全量测试');
  console.log('  node   ' + NODE);
  console.log('  项目   ' + ROOT);

  const nodePath = findNodePath();

  // `--clean-tmp`：把 TEMP 里**所有** hl-* 历史遗留目录清掉，然后退出（不跑测试）。
  // 之所以要一个显式开关，是因为"通配符删除"正是上次踩过的坑 —— 默认永不发生，
  // 只有人明确要求时才做。
  // 这次是**不限时**的（人明确要求了，就等它做完），并且把进度直接打到终端上 ——
  // 本机删 395 个目录可能要几十分钟，静默卡住会让人以为死机了。
  if (has('--clean-tmp')) {
    const all = listHlDirs();
    if (!all.length) { console.log('TEMP 里没有 hl-* 目录。'); process.exit(0); }
    console.log('开始清理 TEMP 里 ' + all.length + ' 个 hl-* 目录（本机删除很慢，可能要几十分钟；随时 Ctrl-C 可中断）。');
    // 用**子进程 + stdio inherit**：进度实时可见（静默卡几十分钟会让人以为死机），
    // 而且这个进程可以 Ctrl-C —— 放在本进程里同步删就没法中断。
    const child = spawn(NODE, [SWEEP_SCRIPT, '--all'], { cwd: ROOT, stdio: 'inherit' });
    child.on('exit', () => process.exit(0));
    return;
  }

  let list = SUITES;
  if (onlyArg) list = SUITES.filter(s => s.key === onlyArg);
  if (has('--skip-browser')) list = list.filter(s => !s.needsServer && !s.needsBrowser);
  if (!list.length) {
    console.error('\n没有匹配的测试套件。可选：' + SUITES.map(s => s.key).join(' / '));
    process.exit(2);
  }
  if (list.some(s => s.needsServer || s.needsBrowser) && !nodePath) {
    console.error('\n找不到 playwright-core。装法：');
    console.error('  cd ' + path.join(os.homedir(), '.workbuddy-ai', 'binaries', 'node', 'workspace') + ' && npm i playwright-core');
    console.error('  npx playwright install chromium');
    console.error('或者加 --skip-browser 只跑前面 6 套。');
    process.exit(2);
  }

  const results = [];
  // 跑之前先拍一张 TEMP 里 hl-* 的快照，跑完只删本次新出现的那批（见 sweepNewTempDirs）。
  const tmpBefore = listHlDirs();
  for (const s of list) {
    process.stdout.write('\n▶ ' + s.name + '（' + s.file + '）… ');
    let r;
    if (s.needsServer) {
      try {
        r = await withServer(base => run(s.file, { BASE: base, NODE_PATH: nodePath }));
      } catch (e) {
        r = { code: 1, ms: 0, pass: 0, fail: 1, tail: ['临时服务启动失败：' + e.message], raw: '' };
      }
    } else if (s.needsBrowser) {
      // 自带服务的浏览器测试：只补 NODE_PATH（playwright-core 装在托管工作区）
      r = await run(s.file, { NODE_PATH: nodePath });
    } else {
      r = await run(s.file, {});
    }
    results.push(Object.assign({ suite: s }, r));
    console.log(r.code === 0 ? '✓ ' + r.pass + ' 项通过（' + (r.ms / 1000).toFixed(1) + 's）'
      : '✗ 失败 ' + r.fail + ' 项（通过 ' + r.pass + '）');
    if (r.code !== 0) r.tail.forEach(l => console.log('    ' + l.trim()));
  }

  const pass = results.reduce((a, r) => a + r.pass, 0);
  const fail = results.reduce((a, r) => a + r.fail, 0);
  const bad = results.filter(r => r.code !== 0);

  // ★ 必须 await：这个函数从"同步"改成了"起子进程"，调用点漏了 await 的话，
  //   下面的 `process.exit()` 会抢在它打日志之前把进程杀掉 —— 于是清扫静悄悄地
  //   什么都没做（连那行"临时目录…"都不会出现），看起来像"这次没有新建目录"。
  await sweepNewTempDirs(tmpBefore, false);

  console.log('\n' + '─'.repeat(62));
  results.forEach(r => {
    console.log('  ' + (r.code === 0 ? '✓' : '✗') + ' ' +
      r.suite.name.padEnd(22, ' ') + String(r.pass).padStart(4) + ' 项   ' + r.suite.desc);
  });
  console.log('─'.repeat(62));
  console.log(bad.length ? ('合计 ' + pass + ' 项通过，' + fail + ' 项失败') : ('合计 ' + pass + ' 项全部通过'));
  process.exit(bad.length ? 1 : 0);
})().catch(e => { console.error('\n测试入口自身异常：', e); process.exit(2); });

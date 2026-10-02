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
  { key: 'parity6front', file: '_parity6front.cjs', name: '批次6（前端结构）', desc: '信息架构断言：顶级导航只剩两根 / 9 个功能都收进知识库 / 旧入口已清空 / 无重复 id（静态，不起浏览器）' },
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
  { key: 'mountbrowser', file: '_mountbrowser.cjs', name: '批次12（浏览器挂载链路）', desc: '真 Chromium 点一遍：项目弹窗勾资料 → 卡片显示「资料 2 份」/ 编辑态回显 / 文档行「加入项目」→ 行内出现「已挂到 …」/ 另一个项目同步变化 / 零控制台报错（自带服务）', needsBrowser: true },
  { key: 'pastebrowser', file: '_pastebrowser.cjs', name: '批次13（浏览器粘贴/读链接）', desc: '真 Chromium 派发 paste/drop 事件：粘贴图进附件区 / ★拖到**输入框**也能上传（旧代码只绑 #stream）/ 发链接先出"正在打开…"再如实报"没读到 + 解析不了" / 灌库后刷新显示"已读取 1 个链接"+ 可点标题 / 零控制台报错（自带服务）', needsBrowser: true },
  { key: 'browser', file: '_browsertest.cjs', name: '浏览器冒烟', desc: '真实 Chromium 走完 18 组 UI 全流程（含 390/320 两个真机视口的布局溢出与落地页可达性断言）', needsServer: true },
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

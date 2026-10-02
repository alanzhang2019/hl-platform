'use strict';
/**
 * 真 Key 端到端：往聊天窗口「粘贴一个文档」，AI 到底读没读？
 *
 * 为什么要真浏览器 + 真模型：
 *   这条链路有两半 —— 前端把剪贴板里的文件变成"临时资料"、服务端把资料喂给模型。
 *   单元断言只能分别证明两半各自没写错，证不了"合起来能读"。
 *   而且这次的核心症状是"问得泛时零命中"，只有真模型跑一遍才能看见它到底有没有内容。
 *
 * 复刻的就是用户报障的那个场景：粘贴过来的文件**没有可信文件名**
 * （浏览器只给 "blob"，前端只能先叫 `粘贴的文件.bin`），内容是一份真的 .docx。
 * 入库时服务端按字节认出是 docx，会把占位名纠成 `粘贴的文件.docx` —— 这正是④要盯的。
 *
 * 跑法（读项目 .env 的真 Key，花一次对话额度）：
 *   NODE_PATH=<workspace>/node_modules node _docreadlive.cjs
 */
const net = require('net');
const path = require('path');
const fs = require('fs');
const os = require('os');
const zlib = require('zlib');
const { spawn } = require('child_process');
const { chromium } = require('playwright-core');

const NODE = process.execPath;
const ROOT = __dirname;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hl-docread-'));
const DATA = path.join(TMP, 'data');
const SHOT_DIR = process.env.SHOT_DIR || path.join(ROOT, '..', '产品截图-粘贴文档');

let pass = 0, fail = 0;
const fails = [];
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; fails.push(name + (extra !== undefined ? ' → ' + JSON.stringify(extra) : '')); console.log('  ✗ ' + name + (extra !== undefined ? ' → ' + JSON.stringify(extra) : '')); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
function freePort() {
  return new Promise(res => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
}
function findChrome() {
  if (process.env.CHROME && fs.existsSync(process.env.CHROME)) return process.env.CHROME;
  const root = path.join(process.env.LOCALAPPDATA || '', 'ms-playwright');
  let best = null, bestN = -1;
  try {
    for (const d of fs.readdirSync(root)) {
      const m = /^chromium-(\d+)$/.exec(d);
      if (!m) continue;
      const exe = path.join(root, d, 'chrome-win64', 'chrome.exe');
      if (fs.existsSync(exe) && Number(m[1]) > bestN) { bestN = Number(m[1]); best = exe; }
    }
  } catch (e) {}
  return best;
}

/** 手拼一个真 .docx（ZIP 容器 + word/document.xml） */
function makeZip(files, method) {
  const m = method == null ? 0 : method;
  const locals = [], centrals = [];
  let offset = 0;
  for (const name in files) {
    const raw = Buffer.isBuffer(files[name]) ? files[name] : Buffer.from(files[name], 'utf8');
    const data = m === 8 ? zlib.deflateRawSync(raw) : raw;
    const nb = Buffer.from(name, 'utf8');
    const crc = zlib.crc32(raw);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0, 6); lh.writeUInt16LE(m, 8);
    lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0, 12); lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(nb.length, 26); lh.writeUInt16LE(0, 28);
    locals.push(lh, nb, data);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0, 8); ch.writeUInt16LE(m, 10);
    ch.writeUInt16LE(0, 12); ch.writeUInt16LE(0, 14); ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(raw.length, 24);
    ch.writeUInt16LE(nb.length, 28); ch.writeUInt16LE(0, 30); ch.writeUInt16LE(0, 32);
    ch.writeUInt16LE(0, 34); ch.writeUInt16LE(0, 36); ch.writeUInt32LE(0, 38); ch.writeUInt32LE(offset, 42);
    centrals.push(ch, nb); offset += 30 + nb.length + data.length;
  }
  const cd = Buffer.concat(centrals); const eo = Buffer.alloc(22);
  eo.writeUInt32LE(0x06054b50, 0); eo.writeUInt16LE(0, 4); eo.writeUInt16LE(0, 6);
  eo.writeUInt16LE(Object.keys(files).length, 8); eo.writeUInt16LE(Object.keys(files).length, 10);
  eo.writeUInt32LE(cd.length, 12); eo.writeUInt32LE(offset, 16); eo.writeUInt16LE(0, 20);
  return Buffer.concat([Buffer.concat(locals), cd, eo]);
}

const LINES = [
  '六年级数学 期末冲刺专项（配套练习册 P37）',
  '一、分数乘法应用题',
  '1. 一根绳子长 3/4 米，用去了 2/3，用去了多少米？求一个数的几分之几，用乘法。',
  '2. 果园里有苹果树 120 棵，梨树的棵数是苹果树的 5/6，梨树有多少棵？',
  '二、分数除法应用题',
  '3. 小明看一本书，第一天看了全书的 1/4，正好是 30 页，这本书共多少页？已知一个数的几分之几是多少，求这个数，用除法。',
  '4. 一件衣服打八折后是 96 元，原价多少元？',
  '三、比和比例',
  '5. 甲乙两数的比是 3:5，甲数是 12，乙数是多少？按比例分配要先求总份数。',
  '6. 把 60 个苹果按 2:3 分给两个班，每班各得多少个？',
  '四、百分数',
  '7. 某商品原价 200 元，涨价 10% 后是多少元？',
  '8. 六（1）班今天出勤 48 人，请假 2 人，出勤率是多少？出勤率 = 出勤人数 ÷ 总人数 × 100%。',
];
const DOCX = makeZip({
  '[Content_Types].xml': '<Types/>',
  'word/document.xml': '<?xml version="1.0"?><w:document><w:body>'
    + LINES.map(t => '<w:p><w:t>' + t + '</w:t></w:p>').join('') + '</w:body></w:document>',
}, 8);

const QUESTION = process.env.QUESTION || '帮我看看我传的这份文档，里面主要是些什么内容？用一句话说一下就好。';
const KEYWORDS = ['分数', '百分数', '出勤率', '八折', '比例', '应用题'];

(async () => {
  const PORT = await freePort();
  const BASE = 'http://127.0.0.1:' + PORT;
  const env = Object.assign({}, process.env, { PORT: String(PORT), DATA_DIR: DATA, IMAGE_AI_ART: '0' });
  delete env.NO_DOTENV;              // ★ 要真调模型，必须让 .env 生效
  delete env.LLM_API_KEY;            // 免得被外部空值盖掉 .env 里的 Key

  const srv = spawn(NODE, [path.join(ROOT, 'server.js')], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let srvLog = '';
  srv.stdout.on('data', d => { srvLog += d; });
  srv.stderr.on('data', d => { srvLog += d; });
  const stop = () => { try { srv.kill(); } catch (e) {} };
  process.on('exit', stop);

  let browser = null;
  try {
    let up = false;
    for (let i = 0; i < 60; i++) {
      try { const r = await fetch(BASE + '/api/health'); if (r.ok) { up = true; break; } } catch (e) {}
      await sleep(400);
    }
    if (!up) { console.error('服务没起来\n' + srvLog); process.exit(2); }

    const hl = await (await fetch(BASE + '/api/health')).json();
    console.log('\n服务版本 ' + hl.version + '，mockLLM=' + hl.mockLLM);
    if (hl.mockLLM) { console.error('★ 没读到真 Key，这次跑的是离线演示模式，证明不了模型行为'); process.exit(2); }

    const post = async (p, body, token) => {
      const url = BASE + p + (token ? (p.indexOf('?') >= 0 ? '&' : '?') + '_t=' + encodeURIComponent(token) : '');
      const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      return { status: r.status, body: await r.json().catch(() => ({})) };
    };
    const sp = await post('/api/space', { name: '粘贴文档验证', passcode: '' });
    ok(!!sp.body.spaceId && !!sp.body.token, '① 建空间');

    const chromePath = findChrome();
    if (!chromePath) { console.error('找不到 Chromium'); process.exit(2); }
    browser = await chromium.launch({ executablePath: chromePath, args: ['--no-sandbox', '--disable-gpu'] });
    const errs = [];
    const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
    page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
    page.on('pageerror', e => errs.push('pageerror: ' + e.message));

    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.land-tab[data-tab="enter"]', { timeout: 20000 });
    await page.click('.land-tab[data-tab="enter"]');
    await page.fill('#spId', sp.body.spaceId);
    await page.click('#spEnter');
    await page.waitForSelector('#app:not([hidden])', { timeout: 20000 });
    ok(true, '② 进入主界面');

    // ---------- 粘贴一个「没有可信文件名」的 docx ----------
    const b64 = DOCX.toString('base64');
    const pasteDiag = await page.evaluate(async (dataB64) => {
      const bin = atob(dataB64);
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      // 名字故意给 "blob" —— 剪贴板里拿不到文件名时就是这个样子，
      // 前端会把它改名成「粘贴的文件.bin」，正是用户踩的那条路。
      const file = new File([arr], 'blob', { type: '' });
      const dt = new DataTransfer();
      dt.items.add(file);
      let ev = null;
      try { ev = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt }); } catch (e) { ev = null; }
      if (!ev || !ev.clipboardData || !ev.clipboardData.files.length) {
        ev = new ClipboardEvent('paste', { bubbles: true, cancelable: true });
        Object.defineProperty(ev, 'clipboardData', { value: dt, configurable: true });
      }
      const target = document.getElementById('input');
      target.dispatchEvent(ev);
      return { defaultPrevented: ev.defaultPrevented, files: ev.clipboardData.files.length };
    }, b64);
    console.log('  [诊断] ' + JSON.stringify(pasteDiag));
    ok(pasteDiag.defaultPrevented === true, '③ 粘贴事件被页面接住（说明真的当成附件在处理）');

    // 等临时资料出现且解析完成
    let docName = '', docState = '';
    for (let i = 0; i < 40; i++) {
      const info = await page.evaluate(() => {
        const box = document.getElementById('tempDocs');
        if (!box || box.hidden) return null;
        const t = (box.innerText || '').replace(/\s+/g, ' ').trim();
        return { text: t, hidden: box.hidden };
      });
      if (info && info.text) { docName = info.text; }
      if (docName && /已就绪|可以引用|就绪/.test(docName)) break;
      await sleep(500);
    }
    console.log('  [临时资料区] ' + (docName || '(空)'));
    ok(/\.docx/.test(docName) && !/\.bin/.test(docName),
      '④ ★ 占位名被按真实类型纠成「粘贴的文件.docx」（不再挂着 .bin）', docName);
    ok(!/失败|解析不|读不出/.test(docName), '⑤ ★ 它没有被报成解析失败（按字节认出了是 docx）', docName);
    await page.screenshot({ path: path.join(SHOT_DIR, '01-粘贴后.png') }).catch(() => {});

    // ---------- 问一个「跟文档没有词汇重叠」的泛问题 ----------
    console.log('\n  提问：' + QUESTION);
    await page.fill('#input', QUESTION);
    await page.click('#send');

    // 等答复真的写完。
    // ★ 不能只判"文本不再变化" —— 流式占位（"小涌 只问不答 正在生成…"）本身就是稳定的，
    //   第一版就是这么写的，结果在开头第一秒就 break，拿回来一句"正在生成…"，
    //   看起来像"模型没读到文档"，其实是测试自己没等。要看生成状态，不是看文本。
    let reply = '', stable = 0;
    for (let i = 0; i < 150; i++) {
      const st = await page.evaluate(() => {
        // 助手消息的类名是 `.msg.ai`（不是 .msg-a —— 选择器写错会得到空串）
        const els = document.querySelectorAll('#stream .msg.ai .body');
        if (!els.length) return { text: '', generating: false };
        const last = els[els.length - 1];
        const md = last.querySelector('.md');
        const inner = ((md || last).innerText || '').replace(/\s+$/, '');
        const flag = last.querySelector('.msg-flag');
        return { text: inner, generating: !!(flag && /正在生成/.test(flag.textContent || '')) };
      });
      if (st.text === reply && st.text.length > 10 && !st.generating) {
        stable++;
        if (stable >= 2) break;
      } else stable = 0;
      if (st.text) reply = st.text;
      await sleep(1000);
    }
    console.log('\n  —— 模型答复 ——\n' + reply.split('\n').map(l => '  | ' + l).join('\n') + '\n');

    const hitWords = KEYWORDS.filter(k => reply.indexOf(k) >= 0);
    ok(hitWords.length > 0, '★★ 模型答复里出现了文档里的实质内容 ⇒ 它真的读到了（改动前这里是空的）', hitWords);
    ok(reply.length > 10, '答复不是空壳', reply.length);

    fs.mkdirSync(SHOT_DIR, { recursive: true });
    const shot = await page.screenshot({ fullPage: true });
    fs.writeFileSync(path.join(SHOT_DIR, '02-模型读了文档.png'), shot);
    ok(errs.length === 0, '⑥ 零控制台报错', errs.slice(0, 3));

    console.log('\n批次18（真 Key 端到端）：');
    console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
    if (fail) { console.log('\n失败清单：'); fails.forEach(f => console.log('  ✗ ' + f)); }
  } catch (e) {
    console.error('跑了但出错了：' + (e && e.stack || e));
    console.error(srvLog.slice(-2000));
    fail++;
  } finally {
    try { if (browser) await browser.close(); } catch (e) {}
    stop();
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
  }
  process.exit(fail ? 1 : 0);
})();

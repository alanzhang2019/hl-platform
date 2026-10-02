'use strict';
/**
 * 中文渲染探针：**要不要让 AI 直接写中文字**，跑这个看证据。
 *
 * 2026-10-02 首次实测（可灵 o1）：排版很漂亮，但十来处文字错了 5 处 ——
 *   "百分数"→"百数分"、"圆与扇形"→"圆柱与扇形"、"先看例题"→"先看看题例"、卡片中间蹦出乱码。
 * 结论：**凡是图上必须出现准确中文的产物，文字交给 Canvas/SVG 画**（见 public/js/poster.js）。
 *
 * 跑法（读项目 .env 的 Key，约 90 秒，**花一次生图额度**）：
 *   node _cnartprobe.cjs
 *   OUT=<目录> MODEL=<模型 id> node _cnartprobe.cjs
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ENV = path.join(__dirname, '.env');
const KEY = (fs.readFileSync(ENV, 'utf8').match(/^LLM_API_KEY=(.*)$/m) || [])[1];

const MODEL = process.env.MODEL || 'fal-ai/kling-image/o1';
const URL0 = 'https://api.qnaigc.com/queue/' + MODEL;
// 默认写到系统临时目录：项目目录里的东西会随发布一起上传，别把探针产物带上去
const OUTDIR = process.env.OUT || path.join(os.tmpdir(), 'hl-cnprobe');
fs.mkdirSync(OUTDIR, { recursive: true });

const PROMPT = `一张中文教育信息图海报（flat infographic poster），竖版构图。
顶部大标题：「20天数学冲刺计划」，标题下方一行小字：「每天 1 小时 · 分数 比 百分数 圆 全过一遍」。
下方 6 个圆角卡片纵向排列，每个卡片左侧一个圆形序号徽章，右侧写清天数与内容：
卡片1 天蓝色：「第1-3天 分数四则运算」
卡片2 紫色：「第4-6天 比与比例」
卡片3 橙色：「第7-9天 百分数应用」
卡片4 绿色：「第10-12天 圆与扇形」
卡片5 青色：「第13-15天 圆柱与圆锥」
卡片6 深蓝色：「第16-20天 综合模拟自测」
底部一行小字：「重点 百分数应用题 · 每天先看例题再做练习」。
风格：现代扁平设计、蓝白配色、大留白、圆角卡片、柔和阴影、界面干净。
关键要求：画面中所有文字必须是清晰准确完整的简体中文汉字，字形正确，不要英文字母、不要错别字、不要乱码或扭曲字符。`;

(async () => {
  const t0 = Date.now();
  const r = await fetch(URL0, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + KEY },
    body: JSON.stringify({ prompt: PROMPT, num_images: 1, resolution: '1K', aspect_ratio: '3:4' }),
    signal: AbortSignal.timeout(30000),
  });
  if (!r.ok) throw new Error('提交失败 ' + r.status + ' ' + (await r.text().catch(() => '')).slice(0, 200));
  const created = await r.json();
  const statusUrl = created.status_url || created.statusUrl;
  const resultUrl = created.response_url || created.responseUrl;
  if (!statusUrl) throw new Error('没有 status_url');
  console.log('任务已建', created.request_id || '');

  let done = null;
  for (let i = 0; i < 60; i++) {
    await new Promise(x => setTimeout(x, 3000));
    const s = await fetch(statusUrl, { headers: { Authorization: 'Bearer ' + KEY }, signal: AbortSignal.timeout(20000) });
    if (!s.ok) continue;
    const j = await s.json();
    const st = String(j.status || '').toUpperCase();
    if (st === 'COMPLETED' || st === 'OK' || st === 'SUCCESS') { done = j; break; }
    if (st === 'ERROR' || st === 'FAILED') throw new Error('生图失败 ' + JSON.stringify(j).slice(0, 300));
  }
  const pick = bag => {
    if (!bag) return null;
    const a = (bag.images && bag.images[0]) || (bag.result && bag.result.images && bag.result.images[0]) || null;
    return a ? (a.url || a.image_url || null) : null;
  };
  let imgUrl = pick(done);
  if (!imgUrl && resultUrl) {
    const s = await fetch(resultUrl, { headers: { Authorization: 'Bearer ' + KEY } });
    if (s.ok) { try { imgUrl = pick(await s.json()); } catch (e) {} }
  }
  if (!imgUrl) throw new Error('没有图片地址 ' + JSON.stringify(done).slice(0, 400));

  const ir = await fetch(imgUrl, { signal: AbortSignal.timeout(60000) });
  const buf = Buffer.from(await ir.arrayBuffer());
  const out = path.join(OUTDIR, 'cn-' + MODEL.replace(/[^a-z0-9]+/gi, '_') + '.png');
  fs.writeFileSync(out, buf);
  console.log('已保存', out, buf.length, 'bytes，耗时', ((Date.now() - t0) / 1000).toFixed(1) + 's');
  console.log('★ 请逐字核对画面里的中文：只要有错别字/乱码，就说明这一档不能让 AI 写字。');
})().catch(e => { console.log('ERR', e.message); process.exit(1); });

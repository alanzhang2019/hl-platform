'use strict';
/**
 * 批次5 自检（模块级）：AI 自动配图（对话流里边讲边画）。
 *
 * 覆盖：shouldIllustrate 启发式（强/弱触发词、负面反证）、generateIllustration
 *      （mock 直说、合法 svg-json 出图、空 elements 拒绝、注入消毒、超长截断）。
 *
 * 不起服务。llm.isMock 现场改写成可控值 —— chat.generateIllustration 每次都
 * 动态调用 llm.isMock()，改写后走"真实"分支，completeJSON 一并桩掉。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hl-p5-'));
process.env.DATA_DIR = TMP;
process.env.NO_DOTENV = '1';
delete process.env.LLM_API_KEY;
delete process.env.ADMIN_PASSWORD;

let pass = 0, fail = 0;
const fails = [];
function ok(cond, name, extra) {
  if (cond) { pass++; }
  else { fail++; fails.push(name + (extra !== undefined ? ' → ' + JSON.stringify(extra) : '')); }
}

const chat = require('./server/chat');
const llm = require('./server/llm');

(async () => {
  // ---------- 1. shouldIllustrate 启发式 ----------
  ok(chat.shouldIllustrate('这道几何题怎么证？', '我们看三角形的内角和。') === true, '强触发：几何', null);
  ok(chat.shouldIllustrate('帮我看看', '这道物理题先做受力分析。') === true, '强触发：物理/受力分析', null);
  ok(chat.shouldIllustrate('细胞是怎么分裂的？', '我们一步步讲。') === true, '强触发：生物（在问题里）', null);
  ok(chat.shouldIllustrate('画一张示意图', '好的。') === true, '强触发：画一张（在问题里）', null);
  ok(chat.shouldIllustrate('如图所示的装置', '我们分析。') === true, '强触发：如图所示', null);
  ok(chat.shouldIllustrate('讲讲二次函数和它的曲线', '好的，我们从图像说起。') === true, '弱触发 ≥2：函数+曲线', null);
  ok(chat.shouldIllustrate('抛物线和它的对称轴', '坐标轴上画个曲线就明白了。') === true, '弱触发 ≥2：抛物线+曲线+坐标', null);
  ok(chat.shouldIllustrate('圆的面积公式', '圆的面积是 πr²。') === false, '反证：单个弱词不触发（避免过度配图）', null);
  ok(chat.shouldIllustrate('讲讲函数', '我们先看下图。') === true, '弱触发 1 + 回复说"下图"', null);
  ok(chat.shouldIllustrate('这首诗表达了什么感情？', '作者借景抒情，表达了思乡之情。') === false, '反证：语文赏析不配图', null);
  ok(chat.shouldIllustrate('帮我写一篇作文', '好，我们先列提纲。') === false, '反证：写作文不配图', null);
  ok(chat.shouldIllustrate('', '') === false, '反证：空文本不配图', null);
  ok(chat.shouldIllustrate(null, null) === false, '反证：null 不炸也不配图', null);

  // ---------- 2. mock 模式：直说"需要配 Key"，不能装作画失败是学生的问题 ----------
  let threw = '';
  try { await chat.generateIllustration('一个圆'); }
  catch (e) { threw = String(e.message || e); }
  ok(threw.indexOf('离线演示模式') >= 0, 'mock 下 generateIllustration 直说离线模式', threw);

  // ---------- 3. 真实分支：桩 isMock=false + completeJSON ----------
  const REAL_ISMOCK = llm.isMock;
  llm.isMock = () => false;

  const GOOD_SVG = {
    kind: 'illustration', title: '圆与半径', palette: ['#2563EB', '#F59E0B'],
    elements: [
      { type: 'circle', cx: 400, cy: 260, r: 120, fill: '#2563EB' },
      { type: 'line', x1: 400, y1: 260, x2: 520, y2: 260, stroke: '#0F172A', width: 3 },
      { type: 'text', x: 460, y: 240, text: 'r', size: 22, fill: '#0F172A' },
      { type: 'path', d: 'M 100 100 javascript:alert(1)', stroke: '#F59E0B', width: 4 },
      { type: 'rect', x: 0, y: 0, w: 800, h: 520, fill: 'url(javascript:evil)' },
    ],
  };
  llm.completeJSON = async () => GOOD_SVG;
  const art = await chat.generateIllustration('画一个圆，标出半径');
  ok(art && art.mode === 'svg', '合法 svg-json → mode=svg', art && art.mode);
  ok(art.title === '圆与半径', '标题原样保留', art.title);
  ok(Array.isArray(art.elements) && art.elements.length === 5, '全部元素都保留（path 注入被剥字符而非整条丢）', art.elements && art.elements.length);
  const pv = art.elements.find(e => e.type === 'path');
  ok(pv && pv.d.indexOf(':') < 0 && pv.d.indexOf('(') < 0, 'path.d 里的注入字符被剥掉（无 : 和括号）', pv && pv.d);
  ok(!JSON.stringify(art).includes('javascript'), '消毒后不含 javascript 字样', null);
  ok(art.elements.some(e => e.type === 'rect' && e.fill === '#EEF2FF'), '非法 fill 回退默认色 #EEF2FF', art.elements.find(e => e.type === 'rect'));

  llm.completeJSON = async () => ({ kind: 'illustration', title: '空图', elements: [] });
  threw = '';
  try { await chat.generateIllustration('画点什么'); }
  catch (e) { threw = String(e.message || e); }
  ok(threw.indexOf('校验未通过') >= 0, '空 elements 被拒（不给学生一张白图）', threw);

  llm.completeJSON = async () => ({ elements: [{ type: 'circle', cx: 1, cy: 2, r: 3 }], title: 'x'.repeat(80), palette: ['#111', '#222', '#333', '#444', '#555', '#666', '#777', '#888', '#999', '#aaa'] });
  const art2 = await chat.generateIllustration('超长标题');
  ok(art2.title.length === 40, '标题截到 40 字', art2.title.length);
  ok(art2.palette.length === 8, 'palette 最多 8 色', art2.palette.length);
  ok(art2.mode === 'svg' && art2.elements.length === 1, '最小可用出图也正常', art2.mode);

  llm.completeJSON = async () => '这不是 JSON';
  threw = '';
  try { await chat.generateIllustration('乱答'); }
  catch (e) { threw = String(e.message || e); }
  ok(threw.indexOf('校验未通过') >= 0, '模型乱答非 JSON 也被拒（completeJSON 解析失败→null）', threw);

  llm.isMock = REAL_ISMOCK;

  console.log('');
  if (fails.length) {
    fails.slice(0, 40).forEach(f => console.log('  ✗ ' + f));
    if (fails.length > 40) console.log('  …还有 ' + (fails.length - 40) + ' 项');
  }
  console.log('PASS  通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
  process.exit(fail ? 1 : 0);
})().catch(e => {
  console.error('批次5 模块自检自身异常：', e);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
  process.exit(2);
});

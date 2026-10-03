/**
 * 三模式真模型 A/B：同一个问题，分别用 selfstudy / feynman / diagnosis 问一遍，
 * 把回答并排打出来，看"到底有没有区别"。
 *
 * ★ 必须在**服务器容器内**跑（宿主 node 是 v12，跑不了 node:sqlite；且 .env 在服务器上）。
 *     docker exec -w /app hl-platform node test/_mode-ab.js
 *   密钥不出服务器，脚本本身只打印回答。
 *
 * 注意：这里直接调 llm.complete（非流式），走的是和线上同一份 buildSystemPrompt，
 * 所以"模型看到的提示词"与线上一致，区别只在是否流式输出。
 */
const llm = require('../server/llm');

const MODES = ['selfstudy', 'feynman', 'diagnosis'];
const LABEL = { selfstudy: '自学引导', feynman: '费曼学习法', diagnosis: '学情诊断' };
const QUESTION = process.env.Q || '老师今天讲了「分数」，我不太懂，感觉云里雾里的。';

(async function () {
  console.log('模型：' + JSON.stringify(llm.resolveModel('default')));
  console.log('提问：' + QUESTION);
  console.log('温度：0.6（与线上对话一致）\n');

  for (const mode of MODES) {
    const system = llm.buildSystemPrompt({ mode: mode, spaceName: 'A/B 测试空间', grade: '五年级' });
    const t0 = Date.now();
    let out = '';
    try {
      out = await llm.complete({
        messages: [{ role: 'system', content: system }, { role: 'user', content: QUESTION }],
        model: 'default',
        temperature: 0.6,
      });
    } catch (e) {
      out = '【调用失败】' + (e && e.message);
    }
    console.log('════════════════════════════════════════════════════════');
    console.log('【' + LABEL[mode] + '】（' + mode + '）  system ' + system.length
      + ' 字符，模式段落 ' + (llm.MODE_PROMPTS[mode] || '').length + ' 字符，'
      + ((Date.now() - t0) / 1000).toFixed(1) + 's');
    console.log('────────────────────────────────────────────────────────');
    console.log(out.trim() || '（空）');
    console.log('');
  }
})();

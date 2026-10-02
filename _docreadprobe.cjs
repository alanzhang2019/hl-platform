'use strict';
/**
 * 探针：聊天窗口里粘贴/上传的文档，AI 到底能不能读到？
 * 走真实代码路径（kb + llm.buildSystemPrompt），不起服务、不连模型。
 */
const fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto');
process.env.DATA_DIR = path.join(os.tmpdir(), 'hl-docread-' + crypto.randomBytes(4).toString('hex'));
process.env.DB_FILE = path.join(process.env.DATA_DIR, 'app.db');
process.env.NO_DOTENV = '1';
process.env.LLM_API_KEY = '';
fs.mkdirSync(process.env.DATA_DIR, { recursive: true });

const kb = require('./server/kb');
const llm = require('./server/llm');

const SID = '9001', CID = 'conv_probe';

const TEXT = '一、分数乘法应用题\n' +
  '1. 一根绳子长 3/4 米，用去了 2/3，用去了多少米？求一个数的几分之几，用乘法。\n' +
  '2. 果园里有苹果树 120 棵，梨树的棵数是苹果树的 5/6，梨树有多少棵？\n' +
  '二、分数除法应用题\n' +
  '3. 小明看一本书，第一天看了全书的 1/4，正好是 30 页，这本书共多少页？已知一个数的几分之几是多少，求这个数，用除法。\n' +
  '4. 一件衣服打八折后是 96 元，原价多少元？\n' +
  '三、比和比例\n' +
  '5. 甲乙两数的比是 3:5，甲数是 12，乙数是多少？按比例分配要先求总份数。\n' +
  '6. 把 60 个苹果按 2:3 分给两个班，每班各得多少个？\n' +
  '四、百分数\n' +
  '7. 某商品原价 200 元，涨价 10% 后是多少元？\n' +
  '8. 六（1）班今天出勤 48 人，请假 2 人，出勤率是多少？出勤率 = 出勤人数 ÷ 总人数 × 100%。';

const doc = kb.addDocument(SID, null, {
  filename: '分数应用题专项.txt', text: TEXT, conversationId: CID, scope: 'temp',
});
console.log('① 粘贴的文档入库：status=' + doc.status + '，字数=' + doc.textLength + '，scope=' + doc.scope);
console.log('');

const ctxFor = q => kb.contextFor(SID, q, { limit: 5, conversationId: CID });

console.log('② 纯检索在不同问法下的命中数（这就是"模型看不到文档"的直接原因）');
['帮我看看我传的这份文档', '这个怎么讲', '你看下我发的资料', '这份卷子我该怎么练', '分数乘法应用题怎么列式']
  .forEach(q => {
    const c = ctxFor(q);
    console.log('   ' + (c.hits.length ? '命中 ' + c.hits.length + ' 段' : '★ 命中 0 段') + '  ← 「' + q + '」');
  });
console.log('');

// 复刻 server.js 的取数方式
const tempDocs = kb.listDocuments(SID, { conversationId: CID, scope: 'temp' }).map(d => ({
  filename: d.filename, status: d.status, error: d.error,
  text: d.status === 'ready' ? ((kb.getDocument(SID, d.id) || {}).text || '') : '',
}));

const Q = '帮我看看我传的这份文档';
const realCtx = ctxFor(Q).text;

console.log('③ 只给检索结果（改动前的行为）');
const before = llm.buildSystemPrompt({ mode: 'selfstudy', docNames: [], docContext: realCtx });
console.log('   提到文件名：' + (before.indexOf('分数应用题专项') >= 0 ? '是' : '★ 否'));
console.log('');
console.log('④ 带上临时资料（改动后的行为）');
const after = llm.buildSystemPrompt({ mode: 'selfstudy', docNames: [], docContext: realCtx, tempDocs: tempDocs });
console.log('   清单段「学生这次在对话里上传的资料」：' + (after.indexOf('学生这次在对话里上传的资料') >= 0 ? '有' : '★ 无'));
console.log('   提到文件名：' + (after.indexOf('分数应用题专项') >= 0 ? '是' : '否'));
console.log('   兜底正文段「他上传资料的正文开头」：' + (after.indexOf('他上传资料的正文开头') >= 0 ? '有' : '★ 无'));
console.log('   正文里的第一题出现了吗：' + (after.indexOf('用去了多少米') >= 0 ? '是' : '★ 否'));
console.log('   提示词长度：' + before.length + ' → ' + after.length + ' 字');
console.log('');

console.log('⑤ 解析失败的资料，模型会不会被误导');
const bad = kb.addDocument(SID, null, { filename: '扫描卷.pdf', dataBase64: Buffer.from('not a pdf at all').toString('base64'), conversationId: CID, scope: 'temp' });
const td2 = kb.listDocuments(SID, { conversationId: CID, scope: 'temp' }).map(d => ({
  filename: d.filename, status: d.status, error: d.error, text: '',
}));
const withBad = llm.buildSystemPrompt({ mode: 'selfstudy', tempDocs: td2 });
console.log('   扫描件入库：status=' + bad.status);
console.log('   提示词如实标注「没读出内容」：' + (withBad.indexOf('没读出内容') >= 0 ? '是' : '★ 否'));
console.log('   明确禁止假装看过：' + (withBad.indexOf('不要假装看过') >= 0 ? '是' : '★ 否'));
console.log('   失败的资料没有被塞进正文：' + (withBad.indexOf('他上传资料的正文开头') >= 0 ? '★ 塞进去了' : '没有'));

try { fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true }); } catch (e) {}

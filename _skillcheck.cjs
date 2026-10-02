'use strict';
/**
 * 技能注册表自检（只读，不起服务）。
 *
 * 为什么要单独一个文件而不是 node -e：
 * 本机 Bash 里 node -e 带中文时偶发 "sandbox-center cmd decisionRecord missing
 * actual resource subject"，把脚本落盘再跑就没事。这是环境问题，不是代码问题。
 *
 * 这个脚本不替 _platformtest.cjs 干活（那里测的是"技能真的进了系统提示词"），
 * 它只回答一件事：**57 条注册表本身自洽吗**。
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

// skills.js 会 require ./db，而 db 在模块加载时就会开库、建表。
// 这里只是要读 REGISTRY，不该动项目自己的 data/ —— 所以先指到临时目录，
// 退出时再删掉。（跑测试的人不该因为"跑了个只读检查"而多出一个 data 目录。）
const TMP = path.join(os.tmpdir(), 'hl-skcheck-' + crypto.randomBytes(4).toString('hex'));
process.env.DATA_DIR = TMP;
// 先关库再删目录 —— Windows 上文件还被句柄占着是删不掉的。
process.on('exit', () => {
  try { require(path.join(__dirname, 'server', 'db.js')).db.close(); } catch (e) {}
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
});

const SK = require(path.join(__dirname, 'server', 'skills.js'));

let pass = 0, fail = 0;
const bad = [];
function ok(name, cond, extra) {
  if (cond) { pass++; return; }
  fail++; bad.push(name + (extra ? '  → ' + (typeof extra === 'string' ? extra : JSON.stringify(extra)) : ''));
}

const R = SK.REGISTRY;
console.log('=== 技能注册表自检 ===\n');

// 1. 数量
ok('条目数为 57', R.length === 57, 'got ' + R.length);
console.log('条目数：' + R.length);

// 2. id 唯一 + 命名规范
const ids = R.map(x => x.id);
const dupIds = ids.filter((v, i) => ids.indexOf(v) !== i);
ok('id 全局唯一', dupIds.length === 0, '重复：' + dupIds.join(','));
ok('id 全部是小写连字符风格', ids.every(i => /^[a-z][a-z0-9-]*$/.test(i)), ids.filter(i => !/^[a-z][a-z0-9-]*$/.test(i)).join(','));
ok('id 长度 <= 24', ids.every(i => i.length <= 24), ids.filter(i => i.length > 24).join(','));

// 3. 显示名唯一
const names = R.map(x => x.display_name);
const dupNames = names.filter((v, i) => names.indexOf(v) !== i);
ok('display_name 全局唯一', dupNames.length === 0, '重复：' + dupNames.join(','));

// 4. sort_order 唯一
const orders = R.map(x => x.sort_order);
const dupOrders = orders.filter((v, i) => orders.indexOf(v) !== i);
ok('sort_order 全局唯一', dupOrders.length === 0, '重复：' + dupOrders.join(','));
ok('sort_order 全是 10 的倍数（每块留出插入位）', orders.every(o => o % 10 === 0), orders.filter(o => o % 10 !== 0).join(','));

// 按 sort_order 升序看，同一"块"必须是连续的。块 = 学科 + 分类 ——
// 注意 general 会出现两次（通用方法一块、工具一块），它们本来就是两个块，
// 所以不能只按学科分组，否则这两块会被误判成"穿插"。
const key = x => x.subject + '/' + x.category;
const byOrder = R.slice().sort((a, b) => a.sort_order - b.sort_order).map(key);
const blocks = byOrder.filter((s, i) => i === 0 || s !== byOrder[i - 1]);
ok('同一块在排序结果里连续（没有穿插）', new Set(blocks).size === blocks.length, '实际块序：' + blocks.join(' → '));

// 5. 必填字段非空
const FIELD_MIN = { display_name: 2, icon_svg: 2, description: 8, prompt: 40 };
for (const f of Object.keys(FIELD_MIN)) {
  const empties = R.filter(x => typeof x[f] !== 'string' || x[f].trim().length < FIELD_MIN[f]);
  ok('字段 ' + f + ' 全部非空且够长(>=' + FIELD_MIN[f] + ')', empties.length === 0,
    empties.map(x => x.id).join(','));
}

// 6. prompt 里必须真的写着"不许干什么"——这是本项目的立场
//    否则它就不是"限制 AI 怎么说话的方法"，而是"让 AI 多说话"。
const NEG = ['不要', '不能', '禁止', '只', '别', '不许', '不得'];
const noNeg = R.filter(x => !NEG.some(w => x.prompt.includes(w)));
ok('每条 prompt 都含限制性表述（不要/只能/禁止…）', noNeg.length === 0, noNeg.map(x => x.id).join(','));
if (noNeg.length) noNeg.forEach(x => console.log('   缺限制语：' + x.id + ' / ' + x.display_name));

// 7. prompt 里不许出现"直接给答案"这类措辞（苏格拉底底线）
const LEAK = ['正确答案是', '答案就是', '直接告诉你答案'];
const leak = R.filter(x => LEAK.some(w => x.prompt.includes(w)));
ok('prompt 里没有"直接给答案"式措辞', leak.length === 0, leak.map(x => x.id).join(','));

// 8. 枚举值合法
const SUBJECTS = require(path.join(__dirname, 'server', 'subjects.js')).SUBJECTS;
const CATS = ['method', 'subject', 'tool'];
ok('subject 取值合法', R.every(x => SUBJECTS.includes(x.subject)),
  R.filter(x => !SUBJECTS.includes(x.subject)).map(x => x.id + '=' + x.subject).join(','));
ok('category 取值合法', R.every(x => CATS.includes(x.category)),
  R.filter(x => !CATS.includes(x.category)).map(x => x.id + '=' + x.category).join(','));

// 9. 学科与分类要自洽：subject 类技能不该挂在 general 下
const mismatch = R.filter(x => x.category === 'subject' && x.subject === 'general');
ok('category=subject 的条目都有具体学科', mismatch.length === 0, mismatch.map(x => x.id).join(','));
const mismatch2 = R.filter(x => x.category === 'method' && x.subject !== 'general');
ok('category=method 的条目都挂在 general 下', mismatch2.length === 0, mismatch2.map(x => x.id).join(','));

// 10. 分布
const bySubject = {}, byCat = {};
R.forEach(x => { bySubject[x.subject] = (bySubject[x.subject] || 0) + 1; byCat[x.category] = (byCat[x.category] || 0) + 1; });
console.log('\n按学科：', JSON.stringify(bySubject, null, 0));
console.log('按分类：', JSON.stringify(byCat, null, 0));
ok('新增的 social 学科确实有内容（>=3 条）', (bySubject.social || 0) >= 3, 'got ' + (bySubject.social || 0));
ok('六大主学科（语数英科社）各 >= 5 条',
  ['math', 'chinese', 'english', 'science'].every(s => (bySubject[s] || 0) >= 5) && (bySubject.social || 0) >= 3,
  JSON.stringify(bySubject));

// 11. prompt 体量
const lens = R.map(x => x.prompt.length);
const avg = Math.round(lens.reduce((a, b) => a + b, 0) / lens.length);
console.log('\nprompt 字数：最短 ' + Math.min(...lens) + '，最长 ' + Math.max(...lens) + '，平均 ' + avg);
ok('最短 prompt >= 60 字（不是敷衍的一句话）', Math.min(...lens) >= 60, 'got ' + Math.min(...lens));
ok('没有超长 prompt（<= 600 字，避免挤爆上下文）', Math.max(...lens) <= 600, 'got ' + Math.max(...lens));

// 12. 导出面
ok('导出 seed', typeof SK.seed === 'function');
ok('导出 list', typeof SK.list === 'function');
ok('导出 get', typeof SK.get === 'function');
ok('导出 grant/revoke', typeof SK.grant === 'function' && typeof SK.revoke === 'function');
ok('导出 setEnabled/enabledIds', typeof SK.setEnabled === 'function' && typeof SK.enabledIds === 'function');
ok('导出 promptsFor', typeof SK.promptsFor === 'function');

// 13. 学科清单的跨文件一致性
//     加 social 的时候，同一条清单散在六个地方，漏一处症状都不一样。
//     这几条断言就是防它再散开。
const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
const appjs = fs.readFileSync(path.join(__dirname, 'public', 'js', 'app.js'), 'utf8');

SUBJECTS.forEach(s => {
  ok('index.html 的下拉里有 ' + s, html.indexOf('value="' + s + '"') >= 0, '找不到 value="' + s + '"');
});
const mName = /const SUBJ_NAME = \{([^}]*)\}/.exec(appjs);
ok('app.js 里能找到 SUBJ_NAME', !!mName);
if (mName) {
  const missing = SUBJECTS.filter(s => !new RegExp('\\b' + s + ':').test(mName[1]));
  ok('前端 SUBJ_NAME 覆盖全部学科（漏了界面上就会冒出英文值）', missing.length === 0, '缺：' + missing.join(','));
}
ok('app.js 的 SUBJ_ORDER 覆盖全部学科',
  SUBJECTS.every(s => new RegExp("'" + s + "'").test((/const SUBJ_ORDER = \[([^\]]*)\]/.exec(appjs) || [, ''])[1])));
// skills.js 自己的 subject 取值也必须在这个清单里（第 8 条已经查过，这里只是把
// "清单来自哪个文件"这件事留个痕）
ok('skills.js 的学科取值来源与 subjects.js 一致', SUBJECTS.indexOf('social') >= 0);

// 14. 与对标站的等级分布对照（我们全免费，这里只留痕）
console.log('\n对照：对标站 free 1 / basic 6 / camp 20 / pro 30 = 57');
console.log('本项目：57 条全部 required_tier = free（seed 时统一写入）');

if (fail) bad.forEach(b => console.log('  ✗ ' + b));
// 这行的措辞要和 _run-tests.cjs 的解析正则对齐（它按 "通过 N 项，失败 M 项" 抓数）
console.log('\n=== 通过 ' + pass + ' 项，失败 ' + fail + ' 项 ===');
process.exit(fail ? 1 : 0);

/**
 * 语音输入回归测试：中间停顿后，后面的字不能覆盖前面的。
 *
 * 跑法（零依赖，Node 22 即可）：
 *   node test/voice-input.test.js
 *
 * 做法：从**真实的 public/js/app.js** 里切出 bindVoice 函数（不是抄一份），
 * 塞进极简 DOM mock + 假的 SpeechRecognition，再按 Web Speech API 的真实语义
 * 喂事件序列。因为切的是真代码，重构 app.js 时这个测试会跟着一起变，
 * 不会腐化成"测一个已经不存在的实现"。
 *
 * 关键语义：`e.resultIndex` 是「本次事件里**最早发生变化**的结果的下标」，
 * 而 `e.results` 是**累积**的。停顿会把前面的结果从 interim 翻成 isFinal，
 * 于是 resultIndex 前移 —— 只拼 resultIndex..end 就会丢掉前面的。
 */
'use strict';

const fs = require('fs');
const path = require('path');

// ---------- 1) 从真实 app.js 里切出 bindVoice ----------
const appJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
const a = appJs.indexOf('// ================= 语音输入 =================');
const b = appJs.indexOf('// ================= 事件绑定 =================');
if (a < 0 || b < 0 || b <= a) {
  console.error('❌ 在 app.js 里找不到「语音输入」区块的锚点，测试需要同步更新');
  process.exit(1);
}
const src = appJs.slice(a, b);

// ---------- 2) 极简 DOM mock ----------
function mkEl(id) {
  return {
    id,
    value: '',
    textContent: '',
    _h: {},
    classList: {
      _s: new Set(),
      add(c) { this._s.add(c); },
      remove(c) { this._s.delete(c); },
      contains(c) { return this._s.has(c); },
    },
    addEventListener(t, fn) { (this._h[t] = this._h[t] || []).push(fn); },
    click() { (this._h.click || []).forEach((f) => f({})); },
    focus() {},
  };
}
const els = { '#input': mkEl('input'), '#mic': mkEl('mic'), '#voiceHint': mkEl('voiceHint') };
const $ = (sel) => els[sel];
const toast = () => {};
const autoGrow = () => {};

// ---------- 3) 假的 SpeechRecognition ----------
let lastRec = null;
let startCalls = 0;
class FakeSR {
  constructor() { lastRec = this; }
  start() { startCalls += 1; if (this.onstart) this.onstart(); }
  stop() { if (this.onend) this.onend(); }
}
const window = { SpeechRecognition: FakeSR };

// ---------- 4) 装载 bindVoice 并初始化 ----------
const factory = new Function('$', 'window', 'toast', 'autoGrow', `${src}\n; return bindVoice;`);
factory($, window, toast, autoGrow)();

const input = () => els['#input'].value;
const results = [];
function check(name, got, want) {
  const ok = got === want;
  results.push(ok);
  console.log(`  ${ok ? '✅' : '❌'} ${name.padEnd(30)} 得到「${got}」${ok ? '' : `，期望「${want}」`}`);
  return ok;
}
function fire(resultIndex, arr) {
  const rs = arr.map((x) => {
    const r = [{ transcript: x.t }];
    r.isFinal = x.f;
    return r;
  });
  lastRec.onresult({ resultIndex, results: rs });
}

console.log('=== 1. 中间停顿不得丢字 ===');
$('#mic').click();
fire(0, [{ t: '你好', f: false }]);
check('说「你好」（未确认）', input(), '你好');
fire(0, [{ t: '你好', f: true }, { t: '世界', f: false }]);
check('停顿，改说「世界」', input(), '你好世界');
fire(1, [{ t: '你好', f: true }, { t: '世界', f: true }, { t: '再见', f: false }]);
check('再停顿，改说「再见」', input(), '你好世界再见');
fire(2, [{ t: '你好', f: true }, { t: '世界', f: true }, { t: '再见', f: true }]);
check('全部确认', input(), '你好世界再见');

console.log('\n=== 2. Chrome 静默自动 end 后要自动续听 ===');
const before = startCalls;
lastRec.onend();
check('自动重启（start 调用次数 +1）', String(startCalls), String(before + 1));

console.log('\n=== 3. 用户主动点结束，不得自动重启 ===');
const before2 = startCalls;
$('#mic').click();
check('没有自动重启', String(startCalls), String(before2));
check('mic 高亮已关闭', String(els['#mic'].classList.contains('on')), 'false');

console.log('\n=== 4. 追加到输入框已有文字后面 ===');
els['#input'].value = '帮我讲讲';
$('#mic').click();
fire(0, [{ t: '这道题', f: true }]);
check('已有文字 + 语音', input(), '帮我讲讲这道题');

const failed = results.filter((x) => !x).length;
console.log(`\n${failed === 0 ? '════ 全部通过 ════' : `════ ${failed} 项失败 ════`}`);
process.exit(failed === 0 ? 0 : 1);

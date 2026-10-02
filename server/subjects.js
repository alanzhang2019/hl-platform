'use strict';
/**
 * 学科清单：**只此一份**。
 *
 * 为什么专门开一个文件装 6 个字符串：
 *   加 social（历史/地理/道法）这个学科时，同一条清单散在六个地方 ——
 *   cards.js 的写入白名单、pool.js 的 SUBJECTS、前端三处 <select>、
 *   两张"英文值 → 中文名"的映射。任何一处漏改，症状都不一样：
 *   漏了白名单 → 卡片存进去但学科丢了（静默降级，最难查）；
 *   漏了映射 → 界面上直接冒出英文 "social"。
 *   所以集中到这里，加学科只改这一个文件。
 *
 * 注意 fallback 的分工：
 *   cards 建卡时学科可以"没选"，用 '' 表示未填；
 *   pool 的条目必须有学科才能筛，所以落回 'general'。
 *   两种语义都留着，靠第二个参数区分，不要合成一种。
 */

/** 顺序 = 界面上下拉框的顺序。social 放在 general 之前，让"未填"永远排最后。 */
const SUBJECTS = ['math', 'chinese', 'english', 'science', 'social', 'general'];

/** 中文显示名。前端也有一份（app.js 的 SUBJ_NAME）—— 前端不能 require 服务端模块，
 *  只能各自维护；好在 _skillcheck.cjs 会比对两边，漂了就报错。 */
const SUBJECT_NAME = {
  math: '数学', chinese: '语文', english: '英语',
  science: '科学', social: '社会', general: '综合',
};

/**
 * 归一化学科值。
 * @param {*} s        原始值
 * @param {string} dflt 不认识时落回什么（不传 = 'general'）
 */
function normSubject(s, dflt) {
  const v = String(s == null ? '' : s).trim().toLowerCase();
  if (SUBJECTS.indexOf(v) >= 0) return v;
  return dflt === undefined ? 'general' : dflt;
}

function isSubject(s) {
  return SUBJECTS.indexOf(String(s == null ? '' : s).trim().toLowerCase()) >= 0;
}

module.exports = { SUBJECTS, SUBJECT_NAME, normSubject, isSubject };

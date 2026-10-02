'use strict';
/**
 * 宠物养成（P9）：成长值按「理解质量」结算，不按在线时长。
 *
 * 为什么这样设计：
 *   对标站是"学习赚积分 → 喂养 → 进化"，本质是时长军备竞赛，会诱导刷时长。
 *   这里改成：只有**知识卡的状态真正往前推进**才给成长值；理解核对拿到"理解到位"才喂得动。
 *   纯粹挂着刷对话，成长值不动。也不做退化（不制造焦虑）。
 */
const D = require('./db');

const STAGES = [
  { stage: 1, name: '嫩芽', need: 0 },
  { stage: 2, name: '幼苗', need: 30 },
  { stage: 3, name: '小树', need: 90 },
  { stage: 4, name: '大树', need: 200 },
  { stage: 5, name: '参天', need: 400 },
];

/**
 * 功能解锁表：宠物长到哪一步，就开放到哪一步。
 *
 * 为什么要有这张表：
 *   之前所有功能一次性摊开，新手进来看到十个入口，第一件事是"该点哪个"——
 *   把"我要学什么"变成了"我要选哪个功能"。改成逐级解锁后，
 *   每一步只需要面对当前这一步该做的事。
 *
 * 为什么阶段 1 就给了这五件事（对话/项目/资料/知识卡/看板）：
 *   前四件合起来是**自学的完整闭环**（问 → 归组 → 存 → 复习），少一件都转不起来。
 *   尤其知识卡不能往后放 —— 成长值只由"知识卡状态推进"产生，
 *   把它锁在阶段 2 就会出现"攒不到 30 点、所以永远解锁不了知识卡"的死锁。
 *
 *   ★ 看板（含学习日报）也是**批次10 从阶段 5 提到阶段 1** 的，理由：
 *     ① 日报是"留痕"，不是"功能"。它更像作业本 —— 不会等孩子攒够积分才发。
 *     ② 新学生恰恰最需要"我今天到底留下了什么"这个反馈来建立习惯；
 *        而对用了很久的人，日报反而是可看可不看的。
 *     ③ 日报是周报与家长端的数据前置，锁住它等于把后面两条线一起锁住。
 *     ④ 第 1 天看板本来就是空的，不存在"信息过载"这个解锁表要防的问题。
 *   代价：阶段 5 只剩共享池一项。这反而更合理 ——
 *   共享池是唯一"需要先有东西可分享"的功能，放最后正合适。
 *
 * key 与前端 KB_SUBS 的 key 对齐（英语在前端叫 en）。
 */
const UNLOCKS = [
  { stage: 1, features: ['chat', 'projects', 'docs', 'cards', 'dash'] },
  { stage: 2, features: ['skills'] },
  { stage: 3, features: ['memory', 'exam'] },
  { stage: 4, features: ['en'] },
  { stage: 5, features: ['pool'] },
];

const FEATURE_LABEL = {
  chat: '对话', projects: '项目', docs: '资料', cards: '知识卡',
  skills: '能力', memory: '记忆', exam: '测评', en: '英语',
  pool: '共享池', dash: '看板',
};

function ensure(spaceId, userId) {
  const uid = userId || '_anon';
  let p = D.get('SELECT * FROM pets WHERE space_id = ? AND user_id = ?', spaceId, uid);
  if (!p) {
    D.run('INSERT INTO pets(space_id,user_id,species,stage,growth,unlocked_at) VALUES(?,?,?,?,?,?)',
      spaceId, uid, 'sprout', 1, 0, D.now());
    p = D.get('SELECT * FROM pets WHERE space_id = ? AND user_id = ?', spaceId, uid);
  }
  return p;
}

function stageOf(growth) {
  let s = STAGES[0];
  for (const it of STAGES) if (growth >= it.need) s = it;
  return s;
}

function shape(spaceId, userId) {
  const p = ensure(spaceId, userId);
  const cur = stageOf(p.growth);
  const next = STAGES.find(s => s.stage === cur.stage + 1) || null;
  return {
    stage: cur.stage, stageName: cur.name, growth: p.growth,
    nextNeed: next ? next.need : null,
    toNext: next ? Math.max(0, next.need - p.growth) : 0,
    maxed: !next,
    species: p.species,
  };
}

/**
 * 当前解锁了哪些功能，以及"再攒多少点能解锁什么"。
 *
 * 返回 next 而不是把未解锁项也列成 available —— 前端要的是
 * "下一步该做什么"，不是"还有什么没做"。所以 next 只给最近的那一级。
 */
function unlockedFeatures(spaceId, userId) {
  const p = ensure(spaceId, userId);
  const cur = stageOf(p.growth);
  const unlocked = [];
  for (const it of UNLOCKS) if (it.stage <= cur.stage) unlocked.push(...it.features);
  const nextStage = STAGES.find(s => s.stage === cur.stage + 1) || null;
  const nextRow = nextStage ? UNLOCKS.find(u => u.stage === nextStage.stage) : null;
  const nextFeatures = nextRow ? nextRow.features : [];
  return {
    stage: cur.stage,
    stageName: cur.name,
    growth: p.growth,
    unlocked,
    next: nextStage ? {
      stage: nextStage.stage,
      name: nextStage.name,
      need: nextStage.need,
      toNext: Math.max(0, nextStage.need - p.growth),
      features: nextFeatures,
      labels: nextFeatures.map(f => FEATURE_LABEL[f] || f),
    } : null,
    maxed: !nextStage,
  };
}

/**
 * 知识卡复习结算。成长值只看「状态是否真的往前推进」。
 *  - 答对且 stage 提升 → +按跨度给分
 *  - 理解核对 solid → 额外 +5（"理解到位"才喂得动）
 *  - unknown / wrong → 0（不惩罚，只是不涨）
 */
function onCardReview(spaceId, userId, { result, verdict, fromStage, toStage, cardId }) {
  const gain = Math.max(0, (Number(toStage) || 0) - (Number(fromStage) || 0));
  let delta = 0;
  if (result === 'right') delta += 5 + gain * 3;
  if (verdict === 'solid') delta += 5;
  if (!delta) return { delta: 0, pet: shape(spaceId, userId) };
  const p = ensure(spaceId, userId);
  const before = stageOf(p.growth).stage;
  const growth = p.growth + delta;
  D.run('UPDATE pets SET growth = ?, fed_at = ? WHERE space_id = ? AND user_id = ?', growth, D.now(), spaceId, userId || '_anon');
  D.run('INSERT INTO pet_events(id,space_id,user_id,kind,source_card_id,delta,created_at) VALUES(?,?,?,?,?,?,?)',
    D.uid('pe_'), spaceId, userId || '_anon', 'card_review', cardId || null, delta, D.now());
  const after = stageOf(growth).stage;
  return { delta, evolved: after > before, pet: shape(spaceId, userId) };
}

module.exports = { STAGES, UNLOCKS, FEATURE_LABEL, shape, ensure, onCardReview, stageOf, unlockedFeatures };

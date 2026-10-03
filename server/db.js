'use strict';
/**
 * 数据层：node:sqlite（Node 22 内置，零依赖）
 *
 * 为什么从文件存储换到 SQLite：
 *   旧版把数据写在 JSON 文件里，有三个硬伤 —— 并发写会互相覆盖、无法做聚合查询、没有事务。
 *   平台化之后（会话/消息/知识卡/测评/资料池）文件存储撑不住。
 *   node:sqlite 是 Node 22 内置的，不引入任何 npm 依赖，"零依赖"这条底线守住了。
 *
 * 约定：
 *   - 所有业务表都带 space_id，查询层强制注入，沿用旧版的"空间隔离"模型。
 *   - 布尔值在 node:sqlite 里不被接受，统一在 norm() 里转成 0/1。
 */
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
const DB_FILE = process.env.DB_FILE || path.join(DATA_DIR, 'app.db');
fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
fs.mkdirSync(path.join(DATA_DIR, 'files'), { recursive: true });

const db = new DatabaseSync(DB_FILE);
// ★ 用 DELETE（回滚日志）而非 WAL：
// 云宿主（app.workbuddy.host）在不同请求/实例间只保证主库 app.db 文件持久，
// -wal 伴随文件可能丢失或不被冷启进程读取，导致 WAL 模式下写入“看不见”（spaces 偶发 checkpoint 落盘、
// sessions 读不到）。DELETE 模式每次提交直接落到主库文件，读方冷启也能立即看到，对 Serverless/临时卷最稳。
db.exec('PRAGMA journal_mode = DELETE');
db.exec('PRAGMA synchronous = FULL');
db.exec('PRAGMA busy_timeout = 5000');
db.exec('PRAGMA foreign_keys = ON');

// ---------- schema ----------
const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);

-- 学习空间：家庭/班级一级隔离。id 连号（0001 起），name 就是"姓名"，强制唯一。
CREATE TABLE IF NOT EXISTS spaces (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  name_key      TEXT NOT NULL,          -- 归一化后的姓名（trim+连续空格+小写），用于唯一性判断
  passcode      TEXT NOT NULL DEFAULT '',
  -- 档位（批次25）：本空间能用哪一档技能。取值见 server/skills.js 的 TIER_KEYS：
  --   self 自学（默认）/ guide 引导 / deep 深研 / all 通学
  -- ⚠️ 老库里这里是 'free'（对标站时代的付费档名，已废弃）。
  --    CREATE TABLE IF NOT EXISTS 不给已存在的表改默认值，所以靠 skills.migrateTiers() 归一。
  tier          TEXT NOT NULL DEFAULT 'self',
  settings_json TEXT NOT NULL DEFAULT '{}',
  created_at    INTEGER NOT NULL,
  last_at       INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_spaces_name_key ON spaces(name_key);

-- 账号（可选）：不注册也能用（空间口令），注册是为了跨设备同步与家长/孩子分角色。
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  space_id      TEXT NOT NULL,
  username      TEXT,
  phone         TEXT,
  email         TEXT,
  password_hash TEXT,
  name          TEXT NOT NULL DEFAULT '',
  stage         TEXT NOT NULL DEFAULT '',
  grade         TEXT NOT NULL DEFAULT '',
  avatar        TEXT,
  speech_rate   REAL NOT NULL DEFAULT 0,
  role          TEXT NOT NULL DEFAULT 'student',   -- student | parent | admin
  created_at    INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users(username) WHERE username IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_phone    ON users(phone)    WHERE phone    IS NOT NULL;

-- 会话令牌：kind='space' 是空间口令登录，kind='account' 是账号登录
CREATE TABLE IF NOT EXISTS sessions (
  token        TEXT PRIMARY KEY,
  user_id      TEXT,
  space_id     TEXT NOT NULL,
  kind         TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  ended_at     INTEGER
);

-- 协议同意（未成年人合规必需）
CREATE TABLE IF NOT EXISTS consents (
  user_id   TEXT NOT NULL,
  doc       TEXT NOT NULL,
  version   TEXT NOT NULL,
  agreed_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, doc)
);

-- 项目：项目 = 一组资料 + 一条学习指令
CREATE TABLE IF NOT EXISTS projects (
  id            TEXT PRIMARY KEY,
  space_id      TEXT NOT NULL,
  name          TEXT NOT NULL,
  instructions  TEXT NOT NULL DEFAULT '',
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

-- 知识库分类与文档（P2 的地基，P0 先建表）
CREATE TABLE IF NOT EXISTS kb_categories (
  id         TEXT PRIMARY KEY,
  space_id   TEXT NOT NULL,
  name       TEXT NOT NULL,
  hidden     INTEGER NOT NULL DEFAULT 0,
  -- 容量：这个"本子"最多放几份文档。默认 5，可扩容（对齐对标产品的"容量 x/y + 扩容"）。
  capacity   INTEGER NOT NULL DEFAULT 5,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS kb_documents (
  id           TEXT PRIMARY KEY,
  space_id     TEXT NOT NULL,
  category_id  TEXT,
  filename     TEXT NOT NULL,
  size         INTEGER NOT NULL DEFAULT 0,
  pages        INTEGER NOT NULL DEFAULT 0,
  status       TEXT NOT NULL DEFAULT 'pending',  -- pending|parsing|ready|failed
  progress     INTEGER NOT NULL DEFAULT 0,
  storage_path TEXT,
  parsed_text  TEXT,
  error        TEXT,
  created_at   INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS project_docs (
  project_id TEXT NOT NULL,
  doc_id     TEXT NOT NULL,
  PRIMARY KEY (project_id, doc_id)
);

-- 对话
CREATE TABLE IF NOT EXISTS conversations (
  id           TEXT PRIMARY KEY,
  space_id     TEXT NOT NULL,
  user_id      TEXT,
  project_id   TEXT,
  title        TEXT NOT NULL DEFAULT '新对话',
  model        TEXT NOT NULL DEFAULT '',
  instructions TEXT NOT NULL DEFAULT '',   -- 对话级自定义指令（"设置指令"）
  agent_id     TEXT,                       -- 选中的智能体（映射到能力中心的技能）
  web_search   INTEGER NOT NULL DEFAULT 0, -- 联网搜索开关
  is_favorite  INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conv_space ON conversations(space_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  seq             INTEGER NOT NULL,
  role            TEXT NOT NULL,             -- user | assistant | system
  content         TEXT NOT NULL DEFAULT '',
  blocks_json     TEXT,                      -- 结构化块：追问/脚手架/知识卡/SVG
  model           TEXT,
  tokens_in       INTEGER NOT NULL DEFAULT 0,
  tokens_out      INTEGER NOT NULL DEFAULT 0,
  -- ★ status 是"SSE 断流恢复"的地基：
  --   助手回复在开始生成前就先落一行 status='streaming'，边生成边回写 content。
  --   前端连接断了也不要紧 —— 它拿着 messageId 轮询 /api/messages/:id，
  --   只要 status 变成 done 就能把完整回复补回来。这是"已从 DB 拉到完整回复"的实现。
  status          TEXT NOT NULL DEFAULT 'done',   -- streaming | done | aborted | error
  meta_json       TEXT,                      -- 引用来源 / 命中技能 / 联网结果 / 智能体
  attachments_json TEXT,                     -- 附件清单：[{id,name,kind,size,mime}]
  client_id       TEXT,                      -- 前端生成的幂等键，防重复发送
  deleted         INTEGER NOT NULL DEFAULT 0,-- 软删除：不进上下文，但保留审计
  edited_at       INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_msg_conv ON messages(conversation_id, seq);
CREATE INDEX IF NOT EXISTS idx_msg_client ON messages(client_id);

-- 记忆：跨会话记住学生的偏好与学习状态
CREATE TABLE IF NOT EXISTS memories (
  id         TEXT PRIMARY KEY,
  space_id   TEXT NOT NULL,
  user_id    TEXT,
  kind       TEXT NOT NULL DEFAULT 'note',
  content    TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS memory_settings (
  space_id   TEXT PRIMARY KEY,
  enabled    INTEGER NOT NULL DEFAULT 1,
  summary    TEXT,
  summary_at INTEGER
);

-- 知识卡（P4 核心）
CREATE TABLE IF NOT EXISTS cards (
  id                     TEXT PRIMARY KEY,
  space_id               TEXT NOT NULL,
  user_id                TEXT,
  knowledge              TEXT NOT NULL,      -- 知识点
  question               TEXT NOT NULL DEFAULT '',
  answer                 TEXT NOT NULL DEFAULT '',
  type                   TEXT NOT NULL DEFAULT 'choice',  -- choice|spelling|understanding
  options_json           TEXT,
  subject                TEXT NOT NULL DEFAULT '',        -- math|chinese|english|science|general
  status                 TEXT NOT NULL DEFAULT 'learning', -- learning|almost|mastered|retired
  stage                  INTEGER NOT NULL DEFAULT 0,
  consecutive_right      INTEGER NOT NULL DEFAULT 0,        -- 连续答对计数（§5：满 5 次即已掌握）
  plan                   TEXT NOT NULL DEFAULT 'scheduled', -- scheduled | pending（复习时间待更新）
  due_at                 INTEGER NOT NULL DEFAULT 0,
  last_reviewed_at       INTEGER NOT NULL DEFAULT 0,
  source_conversation_id TEXT,
  source_message_id      TEXT,
  created_at             INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cards_space ON cards(space_id, status, due_at);

CREATE TABLE IF NOT EXISTS card_reviews (
  id             TEXT PRIMARY KEY,
  card_id        TEXT NOT NULL,
  result         TEXT NOT NULL,             -- right | wrong | unknown
  student_answer TEXT,
  ai_verdict     TEXT,                      -- 理解题：solid|partial|off|unknown
  verdict_json   TEXT,
  is_free        INTEGER NOT NULL DEFAULT 0, -- 自由练习：不计入复习计划
  interval_days  INTEGER NOT NULL DEFAULT 0,
  next_due_at    INTEGER NOT NULL DEFAULT 0,
  reviewed_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reviews_card ON card_reviews(card_id, reviewed_at);

-- 分享
CREATE TABLE IF NOT EXISTS shares (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,                 -- conversation | report
  target_id  TEXT NOT NULL,
  space_id   TEXT NOT NULL,
  token      TEXT NOT NULL UNIQUE,
  views      INTEGER NOT NULL DEFAULT 0,
  active     INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- 活动流水：日报/周报/学习曲线的原料
CREATE TABLE IF NOT EXISTS activity (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  space_id  TEXT NOT NULL,
  user_id   TEXT,
  kind      TEXT NOT NULL,                  -- chat | card_review | card_created | kb_upload | login
  ref_id    TEXT,
  meta_json TEXT,
  at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_activity_space ON activity(space_id, at DESC);

-- 宠物（P9 地基，成长值按"理解质量"结算）
CREATE TABLE IF NOT EXISTS pets (
  space_id    TEXT NOT NULL,
  user_id     TEXT NOT NULL,
  species     TEXT NOT NULL DEFAULT 'sprout',
  stage       INTEGER NOT NULL DEFAULT 1,
  growth      INTEGER NOT NULL DEFAULT 0,
  fed_at      INTEGER NOT NULL DEFAULT 0,
  unlocked_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (space_id, user_id)
);
CREATE TABLE IF NOT EXISTS pet_events (
  id             TEXT PRIMARY KEY,
  space_id       TEXT NOT NULL,
  user_id        TEXT NOT NULL,
  kind           TEXT NOT NULL,
  source_card_id TEXT,
  delta          INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL
);

-- 技能（P7 地基）
CREATE TABLE IF NOT EXISTS skills (
  id            TEXT PRIMARY KEY,
  display_name  TEXT NOT NULL,
  icon_svg      TEXT NOT NULL DEFAULT '',
  description   TEXT NOT NULL DEFAULT '',
  subject       TEXT NOT NULL DEFAULT 'general',
  stage         TEXT NOT NULL DEFAULT 'all',
  category      TEXT NOT NULL DEFAULT 'subject',
  -- 这条技能要求的最低档位（批次25）。取值同 spaces.tier：self/guide/deep/all。
  -- ⚠️ 老库里是 'free'，由 skills.migrateTiers() 归一到 'self'。
  required_tier TEXT NOT NULL DEFAULT 'self',
  prompt        TEXT NOT NULL DEFAULT '',
  sort_order    INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS skill_grants (
  space_id   TEXT NOT NULL,
  skill_id   TEXT NOT NULL,
  granted_at INTEGER NOT NULL,
  PRIMARY KEY (space_id, skill_id)
);

-- 英语（P10）：单词本 + 听写
CREATE TABLE IF NOT EXISTS word_units (
  id         TEXT PRIMARY KEY,
  space_id   TEXT NOT NULL,
  name       TEXT NOT NULL,
  grade      TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS words (
  id         TEXT PRIMARY KEY,
  space_id   TEXT NOT NULL,
  unit_id    TEXT,
  word       TEXT NOT NULL,
  phonetic   TEXT NOT NULL DEFAULT '',
  meaning    TEXT NOT NULL DEFAULT '',
  example    TEXT NOT NULL DEFAULT '',
  wrong_count INTEGER NOT NULL DEFAULT 0,
  right_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_words_space ON words(space_id, unit_id);

-- 英语复习（批次24）：艾宾浩斯间隔**与知识卡同一张表**（1/3/5/7 → 14 → 60 天）。
-- 为什么这条落库而日报不落库：日报的系统侧事实**能**现算（从 activity 推）；
-- 这里的连对次数是**有状态的累计量**，只能重放全部历史才算得出来 ——
-- 它本质上是一条学习痕迹，和 card_reviews 同类。
CREATE TABLE IF NOT EXISTS english_reviews (
  id            TEXT PRIMARY KEY,
  space_id      TEXT NOT NULL,
  user_id       TEXT,
  word_id       TEXT NOT NULL,
  gate          TEXT NOT NULL DEFAULT '',   -- recognize | read | recall | use
  result        TEXT NOT NULL,              -- right | wrong | unknown
  consecutive   INTEGER NOT NULL DEFAULT 0, -- 这次之后连对了几次
  interval_days INTEGER,                    -- 这次定下的间隔（unknown 时为 NULL）
  next_due_at   INTEGER NOT NULL,
  reviewed_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_enrev_word ON english_reviews(word_id, reviewed_at DESC);
CREATE INDEX IF NOT EXISTS idx_enrev_space ON english_reviews(space_id, next_due_at);

-- 测评（P6）
CREATE TABLE IF NOT EXISTS exams (
  id           TEXT PRIMARY KEY,
  space_id     TEXT NOT NULL,
  user_id      TEXT,
  project_id   TEXT,
  title        TEXT NOT NULL,
  items_json   TEXT NOT NULL DEFAULT '[]',
  answers_json TEXT,
  score_json   TEXT,
  status       TEXT NOT NULL DEFAULT 'open',   -- open | submitted
  created_at   INTEGER NOT NULL,
  submitted_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_exams_space ON exams(space_id, created_at DESC);

-- 公共资料池（P3）：只放用户主动共享的内容，不做预置题库
CREATE TABLE IF NOT EXISTS pool_items (
  id          TEXT PRIMARY KEY,
  space_id    TEXT NOT NULL,
  author_name TEXT NOT NULL DEFAULT '',
  title       TEXT NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'note',    -- note | cards | words | exam
  subject     TEXT NOT NULL DEFAULT 'general',
  grade       TEXT NOT NULL DEFAULT '',
  summary     TEXT NOT NULL DEFAULT '',
  content_json TEXT NOT NULL DEFAULT '{}',
  status      TEXT NOT NULL DEFAULT 'active',  -- active | hidden | removed
  copies      INTEGER NOT NULL DEFAULT 0,
  reports     INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pool ON pool_items(status, subject, created_at DESC);

CREATE TABLE IF NOT EXISTS pool_actions (
  id         TEXT PRIMARY KEY,
  item_id    TEXT NOT NULL,
  space_id   TEXT NOT NULL,
  action     TEXT NOT NULL,                    -- copy | report
  reason     TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pool_actions ON pool_actions(item_id, action);

-- 短信验证码：登录 / 注册 / 重置密码共用一张表，用 scene 区分
CREATE TABLE IF NOT EXISTS sms_codes (
  id         TEXT PRIMARY KEY,
  phone      TEXT NOT NULL,
  code       TEXT NOT NULL,
  scene      TEXT NOT NULL,                    -- login | register | reset
  tries      INTEGER NOT NULL DEFAULT 0,
  used       INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sms_phone ON sms_codes(phone, scene, created_at DESC);

-- 学习会话事件：真实学习时长只能从这里算（登录次数不等于学习时长）
CREATE TABLE IF NOT EXISTS session_events (
  id       TEXT PRIMARY KEY,
  space_id TEXT NOT NULL,
  user_id  TEXT,
  token    TEXT,
  kind     TEXT NOT NULL,                      -- start | heartbeat | end
  at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sess_events ON session_events(space_id, at DESC);

-- 公告
CREATE TABLE IF NOT EXISTS announcements (
  id         TEXT PRIMARY KEY,
  title      TEXT NOT NULL,
  body       TEXT NOT NULL DEFAULT '',
  level      TEXT NOT NULL DEFAULT 'normal',   -- important | normal
  published  INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS announcement_reads (
  user_id TEXT NOT NULL,
  ann_id  TEXT NOT NULL,
  read_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, ann_id)
);

-- 翻译缓存：同一句反复翻很常见（分级阅读点词、对话译文），缓存能省掉大量上游调用
CREATE TABLE IF NOT EXISTS translations (
  hash       TEXT PRIMARY KEY,
  src        TEXT NOT NULL,
  dst        TEXT NOT NULL,
  direction  TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- 异步任务：AI 配图 / 互动课堂。
-- ★ 必须有这张表：这两件事都要几十秒到几分钟，前端会断流/关页面，
--   没有持久化就"东西做好了但用户永远看不到"。status + heartbeat_at 支撑轮询恢复。
CREATE TABLE IF NOT EXISTS jobs (
  id              TEXT PRIMARY KEY,
  space_id        TEXT NOT NULL,
  user_id         TEXT,
  kind            TEXT NOT NULL,               -- image | interactive
  conversation_id TEXT,
  message_id      TEXT,
  status          TEXT NOT NULL DEFAULT 'pending',  -- pending|running|done|failed
  progress        TEXT NOT NULL DEFAULT '',
  input_json      TEXT,
  result_json     TEXT,
  error           TEXT,
  heartbeat_at    INTEGER NOT NULL DEFAULT 0,
  started_at      INTEGER NOT NULL,
  finished_at     INTEGER
);
CREATE INDEX IF NOT EXISTS idx_jobs_space ON jobs(space_id, kind, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_msg ON jobs(message_id);

-- 学习日报（批次10）
-- 只存"人写的那部分"（四问的自述）和状态。
-- 系统侧的事实每次都从 activity / card_reviews 现算 —— 不落库、不可被改写，
-- 这样"数字可溯源"才是真的：溯源指向的是原始记录，不是日报自己的副本。
CREATE TABLE IF NOT EXISTS daily_reports (
  id           TEXT PRIMARY KEY,
  space_id     TEXT NOT NULL,
  date         TEXT NOT NULL,               -- YYYY-MM-DD（本地日）
  status       TEXT NOT NULL DEFAULT 'draft', -- draft | final
  answers_json TEXT,                        -- 四问的自述（草稿自动保存的就是它）
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  finalized_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_daily_space_date ON daily_reports(space_id, date);

-- 历史周报（批次22）
-- 和日报同源同规矩：**只存"人写的那部分"**（这周我注意到什么 / 下周想试什么），
-- 汇总数字（覆盖 / 合计 / 卡住的卡）**永不落库** —— 它们每次都从 daily.facts() 现算。
-- ★ 为什么不存一份快照：一旦存了，溯源就变成溯源自证 —— 你点"这个数从哪来"，
--   拿回来的是周报自己当初抄下来的副本，而不是产生它的那张卡那次复习。
-- 主键是 (space_id, week_from, week_to)：同一段日期只该有一条，重复定稿不改写历史。
CREATE TABLE IF NOT EXISTS weekly_reports (
  id           TEXT PRIMARY KEY,
  space_id     TEXT NOT NULL,
  week_from    TEXT NOT NULL,               -- YYYY-MM-DD（含）
  week_to      TEXT NOT NULL,               -- YYYY-MM-DD（含）
  status       TEXT NOT NULL DEFAULT 'draft', -- draft | final
  answers_json TEXT,                        -- 人写的那段（不超过 2000 字/条）
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  finalized_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_weekly_space_range ON weekly_reports(space_id, week_from, week_to);
CREATE INDEX IF NOT EXISTS idx_weekly_space_to ON weekly_reports(space_id, week_to DESC);
`;

// ---------- 轻量迁移 ----------
// CREATE TABLE IF NOT EXISTS 不会给**已存在**的表补列。
// 这里按"目标列清单"做增量补列，保证老库升级后不炸。
const MIGRATIONS = [
  ['cards', 'subject', "TEXT NOT NULL DEFAULT ''"],
  // 账号资料扩展：学科/偏好/目标（个人中心三段），头像预设，最后登录时间
  ['users', 'subjects_json', "TEXT NOT NULL DEFAULT '[]'"],
  ['users', 'preferences_json', "TEXT NOT NULL DEFAULT '{}'"],
  ['users', 'goals_json', "TEXT NOT NULL DEFAULT '[]'"],
  ['users', 'avatar_preset', "TEXT NOT NULL DEFAULT ''"],
  ['users', 'last_login_at', 'INTEGER NOT NULL DEFAULT 0'],
  // 消息级操作：收藏 + 译文（译文按消息存，避免每次进页面重翻）
  ['messages', 'is_favorite', 'INTEGER NOT NULL DEFAULT 0'],
  ['messages', 'translated_json', 'TEXT'],
  // 知识库文档：conversation_id + scope 支撑"对话级临时资料"
  // —— 临时资料挂在对话上，聊完随对话删除，不污染正式知识库
  ['kb_documents', 'conversation_id', 'TEXT'],
  ['kb_documents', 'scope', "TEXT NOT NULL DEFAULT 'kb'"],
  // 扫描件 OCR：任务要能反查"这份资料的识别任务还在不在"。
  // 没有这一列，任务被清掉后文档会永远停在「识别中」—— 用户既看不到进度，
  // 也没法重新识别，只能干等一个不会来的结果。
  ['jobs', 'doc_id', 'TEXT'],
  // 消息状态机 + 元信息 + 附件 + 软删除（批次2：Chat 富功能）
  ['messages', 'status', "TEXT NOT NULL DEFAULT 'done'"],
  ['messages', 'meta_json', 'TEXT'],
  ['messages', 'attachments_json', 'TEXT'],
  ['messages', 'client_id', 'TEXT'],
  ['messages', 'deleted', 'INTEGER NOT NULL DEFAULT 0'],
  ['messages', 'edited_at', 'INTEGER NOT NULL DEFAULT 0'],
  // 对话级设置：智能体 + 联网搜索
  ['conversations', 'agent_id', 'TEXT'],
  ['conversations', 'web_search', 'INTEGER NOT NULL DEFAULT 0'],
  // 批次3 知识卡深度：连续答对计数 + 复习计划状态 + 自由练习标记
  ['cards', 'consecutive_right', 'INTEGER NOT NULL DEFAULT 0'],
  ['cards', 'plan', "TEXT NOT NULL DEFAULT 'scheduled'"],
  ['card_reviews', 'is_free', 'INTEGER NOT NULL DEFAULT 0'],
  // 知识库改版：分类容量 + 排序（对齐对标产品的"本子 + 容量 + 扩容"）
  ['kb_categories', 'capacity', 'INTEGER NOT NULL DEFAULT 5'],
  ['kb_categories', 'sort_order', 'INTEGER NOT NULL DEFAULT 0'],
  // 管理员要能禁用用户（不是删号 —— 删了学习和错题记录就都没了，那是家长的资产）。
  // 0 = 正常，非 0 = 被禁，登录会被拦、已有会话会被踢下线。
  ['users', 'disabled', 'INTEGER NOT NULL DEFAULT 0'],
  ['users', 'disabled_reason', "TEXT NOT NULL DEFAULT ''"],
  // 模型的思考过程（reasoning_content）。只给前端折叠展示用，**不进模型上下文**
  // —— 那是模型的旁白，喂回上下文只会让它自己带偏自己，还白烧 token。
  ['messages', 'reasoning', "TEXT NOT NULL DEFAULT ''"],
];
function migrate() {
  MIGRATIONS.forEach(([table, col, decl]) => {
    let cols;
    try { cols = db.prepare('PRAGMA table_info(' + table + ')').all(); } catch (e) { return; }
    if (!cols.length) return;                       // 表不存在（由 SCHEMA 负责创建）
    if (cols.some(c => c.name === col)) return;
    try { db.exec('ALTER TABLE ' + table + ' ADD COLUMN ' + col + ' ' + decl); }
    catch (e) { console.error('[migrate] ' + table + '.' + col + ' 失败：' + e.message); }
  });
}
/**
 * ★ 执行顺序很关键：**先补列，再建表建索引**。
 *
 * SCHEMA 里有一句 `CREATE INDEX IF NOT EXISTS idx_msg_client ON messages(client_id)`。
 * 老库的 messages 表里还没有 client_id，如果先跑 SCHEMA，这句会直接
 * `no such column: client_id` —— 整个服务起不来。
 * 先跑一遍 migrate（表不存在时它会自己跳过），把缺的列补上，SCHEMA 才能顺利执行。
 *
 * 最后再跑一遍 migrate 是幂等兜底：SCHEMA 新建的表理论上列是齐的，
 * 但以后往 SCHEMA 里加表却忘了加列时，这一遍能兜住。
 *
 * ★★ 三件事必须包在**同一个事务**里。
 *
 * 原来是一条条裸跑。而 `journal_mode = DELETE` + `synchronous = FULL` 下，
 * **每条 DDL 都是一个独立事务，各自要 fsync 一次回滚日志 + 主库文件**。
 * 在 fsync 便宜的机器上无所谓；在 Windows + 实时杀毒 + 冷盘上，
 * 一次 fsync 能要几百毫秒 —— 本机实测：**51 条语句要 33 秒**，
 * 整个 `require('./server/db.js')` 要 **80 秒**。
 *
 * 后果不是"慢一点"：所有"自带服务"的测试套件都会因为服务在超时前起不来而**假红**，
 * 而且红得毫无线索（子进程只吐一句"服务在超时前没有就绪"）。
 *
 * SQLite 的 DDL 本来就是事务性的，包起来之后 51 条语句只 fsync 一次。
 * 顺带还赚到一点：建表要么全成、要么全不成，不会留下"建了一半"的库。
 */
db.exec('BEGIN');
try {
  migrate();          // 先补列
  db.exec(SCHEMA);    // 再建表建索引
  migrate();          // 幂等兜底
  db.exec('COMMIT');
} catch (e) {
  try { db.exec('ROLLBACK'); } catch (_) {}
  throw e;
}

// ---------- helpers ----------
// node:sqlite 只接受 null / number / bigint / string / Uint8Array。
// boolean 和 undefined 会直接抛错，所以统一在这里归一。
function norm(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'object') return JSON.stringify(v);
  return v;
}
const all = (sql, ...p) => db.prepare(sql).all(...p.map(norm));
const get = (sql, ...p) => db.prepare(sql).get(...p.map(norm));
const run = (sql, ...p) => db.prepare(sql).run(...p.map(norm));
/**
 * ★ 可重入事务。
 *
 * 原来是最朴素的 `BEGIN … COMMIT`，**嵌套会抛
 * "cannot start a transaction within a transaction"**。
 * 后果不是"少用一层"，而是**没人敢在外层包事务** —— 于是"一次请求写 N 行"
 * 就退化成 N 个独立事务。而 `journal_mode = DELETE` + `synchronous = FULL` 下
 * **每个事务要 fsync 两次**，本机一次事务约 500ms。
 *
 * 实测（`_wprobe.cjs`，14 条 INSERT）：
 *   各自一个事务  7113ms（单条均摊 508ms）
 *   包在一个事务里  576ms（单条均摊  41ms）  ← 12.3×
 *
 * 典型受害者：共享池「取用」6 张卡 = 6×INSERT cards + 6×logActivity + 2×pool
 * ≈ 14 次独立事务 ≈ **7 秒**。用户看到的就是"点了取用，转半天"。
 *
 * 改法：嵌套计数 + SAVEPOINT。最外层才是真 BEGIN，内层退化成 SAVEPOINT/RELEASE。
 * 语义不变（内层回滚只回滚内层），但整个请求只 fsync 一次。
 */
let txDepth = 0;
function tx(fn) {
  const outer = txDepth === 0;
  const sp = 'hl_sp_' + txDepth;
  db.exec(outer ? 'BEGIN' : 'SAVEPOINT ' + sp);
  txDepth++;
  try {
    const r = fn();
    txDepth--;
    db.exec(outer ? 'COMMIT' : 'RELEASE ' + sp);
    return r;
  } catch (e) {
    txDepth--;
    if (outer) {
      try { db.exec('ROLLBACK'); } catch (_) {}
    } else {
      // 先回滚到存档点，再释放它 —— 两步都要做，否则存档点会一直挂着。
      try { db.exec('ROLLBACK TO ' + sp); } catch (_) {}
      try { db.exec('RELEASE ' + sp); } catch (_) {}
    }
    throw e;
  }
}
const now = () => Date.now();

function metaGet(k, dflt) {
  const r = get('SELECT v FROM meta WHERE k = ?', k);
  return r ? r.v : dflt;
}
function metaSet(k, v) { run('INSERT INTO meta(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v', k, String(v)); }

// ---------- 通用小工具 ----------
const crypto = require('crypto');
const uid = (p) => (p || '') + crypto.randomBytes(9).toString('hex');
function hashPw(pw, salt) {
  const s = salt || crypto.randomBytes(8).toString('hex');
  return s + '$' + crypto.scryptSync(String(pw), s, 32).toString('hex');
}
function checkPw(pw, stored) {
  if (!stored || stored.indexOf('$') < 0) return false;
  const [s, h] = stored.split('$');
  try {
    const got = crypto.scryptSync(String(pw), s, 32).toString('hex');
    return crypto.timingSafeEqual(Buffer.from(got, 'hex'), Buffer.from(h, 'hex'));
  } catch (e) { return false; }
}
// 姓名归一：剔除**所有**空白 + 转小写，用于唯一性判断。
// 为什么连内部空格也去掉：姓名里的空白没有语义（"张 小明" 和 "张小明" 是同一个人），
// 只压连续空格会放过这种近似重名，而这个功能的全部意义就是拦住"看着像同一个人"的空间。
const nameKey = (n) => String(n == null ? '' : n).replace(/\s+/g, '').toLowerCase();
// 空间 ID 规范化：小写、只留 [a-z0-9_-]、纯数字左补零到 4 位
function canonSpaceId(id) {
  let s = String(id == null ? '' : id).trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
  if (/^\d+$/.test(s)) s = s.padStart(4, '0');
  return s;
}
function normalizeSpace(id) {
  const s = canonSpaceId(id);
  return (s.length >= 3 && s.length <= 40) ? s : '_public';
}

module.exports = {
  db, DATA_DIR, DB_FILE,
  all, get, run, tx, norm, now, uid, hashPw, checkPw, nameKey,
  canonSpaceId, normalizeSpace, metaGet, metaSet,
};

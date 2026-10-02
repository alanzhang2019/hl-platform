/* 批次25 · 能力中心 静态接线套件
 *
 * 守三件事：
 *   A. 57 个图标名在后端有、前端也有，且**一一对应**（多一个少一个都红）
 *   B. 前端真的把图标**渲染进了卡片**（不是定义了不用）
 *   C. 「用它开一段对话」整条链路的**调用点**都在：
 *      data-go 生成 → 委托先拦 data-go → openSkillChat → newConv({keepAgent}) → agentId 进建会话体
 *   D. 管理员授权的边界（当前批次先守"没有付费售卖字样"这条红线）
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = __dirname;
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let pass = 0, fail = 0;
const chk = (c, m) => { if (c) { pass++; } else { fail++; console.log('  ✗ ' + m); } };
/** 去掉 // 行注释与 /* *\/ 块注释 —— 断言调用点顺序时不能把注释算进去。
 *  （本项目已踩过：注释里出现 closest('.skill-c') 会让"顺序"断言假绿/假红。） */
const strip = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|\s)\/\/[^\n]*/g, '$1');

/** 整套检查。导出成函数是为了让反证脚本能在**同一个进程**里反复调用 ——
 *  本沙箱 execFileSync(node, …) 会 EBUSY，起子进程反证走不通。 */
function check(quiet) {
  pass = 0; fail = 0;
  const log = quiet ? () => {} : (s) => console.log(s);
  const problems = [];
  const C = (c, m) => { if (c) { pass++; } else { fail++; problems.push(m); if (!quiet) console.log('  ✗ ' + m); } };

  const skillsJs = read('server/skills.js');
  const iconsJs = read('public/js/skillicons.js');
  const appJs = read('public/js/app.js');
  const html = read('public/index.html');
  const css = read('public/app.css');
  const serverJs = read('server.js');

  log('== A 组：57 个图标名两端一一对应 ==');
  const beNames = [...skillsJs.matchAll(/icon_svg: '([^']+)'/g)].map(m => m[1]);
  C(beNames.length === 57, '后端 57 个 icon_svg，实际 ' + beNames.length);
  const beBody = iconsJs.slice(iconsJs.indexOf('const ICONS = {'), iconsJs.indexOf('const FALLBACK'));
  const feNames = [...beBody.matchAll(/^\s{4}([a-z]+):/gm)].map(m => m[1]);
  C(feNames.length === 57, '前端 57 个图标，实际 ' + feNames.length);
  const miss = beNames.filter(x => feNames.indexOf(x) < 0);
  C(miss.length === 0, '后端要的图标前端都有，缺:' + miss.join(','));
  const extra = feNames.filter(x => beNames.indexOf(x) < 0);
  C(extra.length === 0, '前端没有多余图标，多:' + extra.join(','));
  C(new Set(beNames).size === beNames.length, '后端图标名不重复');

  log('== B 组：前端真的渲染了图标（钉调用点，不是"字符串存在"） ==');
  C(/function renderSkillList\(\)/.test(appJs), 'renderSkillList 存在');
  // 必须真的把图标翻成 SVG 并塞进卡片。
  // 注意写法是 `const skIcon = HL.skillIcons ? HL.skillIcons.icon : ...` 再 `skIcon(...)` ——
  // 所以断言要认「取了 icon 方法」+「模板里调了它」两件事，不能只盯着直接调用。
  C(/HL\.skillIcons[\s\S]{0,120}\.icon/.test(appJs), 'renderSkillList 取到了 HL.skillIcons.icon');
  const rsl = appJs.slice(appJs.indexOf('function renderSkillList()'), appJs.indexOf('async function toggleSkill'));
  C(/sc-ico/.test(rsl), '卡片模板含 sc-ico 容器');
  C(/skIcon\s*\(/.test(rsl), '卡片模板调用 skIcon()');
  C(/skIcon=sIcon|skIcon = .*icon/.test(rsl) || /HL\.skillIcons[\s\S]{0,120}\.icon/.test(rsl), 'skIcon 指向 HL.skillIcons.icon');
  C(rsl.indexOf('data-id') > 0, '卡片仍带 data-id（开关行为不丢）');
  // 图标脚本必须在 app.js 之前加载
  const iIcons = html.indexOf('/js/skillicons.js');
  const iApp = html.indexOf('/js/app.js');
  C(iIcons > 0, 'index.html 引入了 skillicons.js');
  C(iIcons < iApp, 'skillicons.js 在 app.js 之前加载');

  log('== C 组：用它开一段对话 —— 整条链路的调用点 ==');
  C(/function openSkillChat\(/.test(appJs), 'openSkillChat 定义存在');
  // 生成按钮
  C(/data-go=/.test(rsl), '卡片模板生成 data-go 按钮');
  // 委托必须先拦 data-go（否则会被 closest('.skill-c') 吃掉变成开关）。
  // 顺序断言必须在**去掉注释**的代码上做 —— 注释里正好也出现了 closest('.skill-c')。
  const bind = strip(appJs.slice(appJs.indexOf("$('#skillList').addEventListener('click'"), appJs.indexOf("$('#skillClear').addEventListener")));
  C(/closest\('\[data-go\]'\)/.test(bind), '点击委托用 closest([data-go]) 拦按钮');
  C(bind.indexOf('data-go') < bind.indexOf("closest('.skill-c')"), '拦 data-go 在 closest(.skill-c) 之前');
  C(/stopPropagation/.test(bind), '拦到按钮时 stopPropagation');
  C(/openSkillChat\(go\.dataset\.go\)/.test(bind), '委托真的调 openSkillChat');
  // openSkillChat 内部：设 agentId → newConv({keepAgent}) 
  const osc = appJs.slice(appJs.indexOf('async function openSkillChat'), appJs.indexOf('async function openSkillChat') + 600);
  C(/S\.agentId\s*=\s*id/.test(osc), 'openSkillChat 设 S.agentId');
  C(/newConv\(\{\s*keepAgent:\s*true\s*\}\)/.test(osc), 'openSkillChat 调 newConv({keepAgent:true})');
  // newConv 必须真的尊重 keepAgent（否则会把 agent 清掉 = 功能失效且零报错）
  const nc = appJs.slice(appJs.indexOf('function newConv(opts)'), appJs.indexOf('function newConv(opts)') + 900);
  C(/keepAgent/.test(nc), 'newConv 读取 keepAgent');
  C(/if\s*\(!keepAgent\)\s*S\.agentId\s*=\s*''/.test(nc), 'newConv 仅在非 keepAgent 时清空 agentId');
  // 建会话时必须把 agentId 发给后端
  C(/agentId:\s*S\.agentId/.test(appJs), '建会话体带 agentId');
  // 后端必须用 conv.agentId 注入技能提示词
  C(/promptsFor\(sid,\s*\[conv\.agentId\]\)/.test(serverJs), '后端按 conv.agentId 注入技能提示词');

  log('== D 组：CSS 基准规则在媒体查询之前 ==');
  // 必须找**真正的** @media 规则（行首），不能 indexOf('@media') ——
  // 文件里有注释提到"见下面的 @media"，那会把断言引到错误位置。
  const cssNoComment = strip(css);
  const iMedia = cssNoComment.search(/^@media/m);
  const iSki = cssNoComment.indexOf('.skill-c .sc-ico');
  C(iMedia > 0, '找到真实的 @media 规则，位置 ' + iMedia);
  C(iSki > 0, 'sc-ico 样式存在');
  C(iSki < iMedia, 'sc-ico 样式在第一个 @media 之前（否则会被媒体查询盖掉）');
  C(/\.sc-go\b/.test(cssNoComment), 'sc-go 按钮样式存在');
  let d = 0, min = 0;
  for (const ch of css) { if (ch === '{') d++; else if (ch === '}') d--; if (d < min) min = d; }
  C(d === 0 && min === 0, 'CSS 花括号配平');

  log('== E 组：零依赖与红线 ==');
  C(skillsJs.indexOf('required_tier') > 0, 'skills 表仍有 required_tier 字段（授权模型的地基）');
  C(iconsJs.indexOf('http://') < 0 && iconsJs.indexOf('https://') < 0, '图标模块不引外部资源');
  // 能力中心不许出现"售卖/价格"字样（roadmap：等级改为管理员授权，不做付费售卖）。
  // 红线只针对**用户可见文本** —— 注释里写"反面教材"是给开发者看的，不算违规。
  const skillRegion = strip(appJs.slice(appJs.indexOf('能力中心'), appJs.indexOf('英语（P10）')));
  C(!/￥|价格|购买|付费|解锁价|学币|订阅/.test(skillRegion), '能力视图（去注释）无售卖/价格字样');
  C(!/教材|课本/.test(skillRegion), '能力视图（去注释）无「教材/课本」（IP 红线）');
  // 顺带守：技能提示词里也不该出现版本名（"人教版/苏教版"这类标注是明确不做的）
  const skillPrompts = skillsJs.slice(skillsJs.indexOf('const REGISTRY'), skillsJs.indexOf('function seed()'));
  C(!/人教版|苏教版|北师大版|沪教版|外研版/.test(skillPrompts), '技能提示词无教材版本标注');

  log('== F 组：档位（授权模型）后端接线 ==');
  const serverJs2 = read('server.js');
  const authJs = read('server/auth.js');
  // 档位阶梯与默认档
  C(/const TIERS = \[/.test(skillsJs), 'skills.js 定义 TIERS 阶梯');
  C(/const DEFAULT_TIER = 'self'/.test(skillsJs), "默认档是 'self'（中文意图命名的第一档）");
  C(/function tierAllows\(/.test(skillsJs), 'tierAllows 存在');
  // 档位表必须覆盖全部 57 条（漏配 = 静默落进 self = 对所有人放行）
  C(/function tierCoverage\(/.test(skillsJs), 'tierCoverage 存在（防漏配）');
  C(/const TIER_ASSIGN = \{/.test(skillsJs), 'TIER_ASSIGN 表存在');
  // list 必须按档位算 locked / 不给锁定项 enabled
  const listFn = skillsJs.slice(skillsJs.indexOf('function list(spaceId'), skillsJs.indexOf('function get(id)'));
  C(/locked/.test(listFn), 'list() 计算 locked');
  C(/enabled: !locked/.test(listFn), '★ 锁定的技能 enabled 一律 false（授权收回后旧记录不能再生效）');
  // grant 必须过闸
  const grantFn = skillsJs.slice(skillsJs.indexOf('function grant(spaceId'), skillsJs.indexOf('function revoke'));
  C(/assertUnlocked\(/.test(grantFn), 'grant() 调 assertUnlocked（服务端强制，不只靠前端）');
  // promptsFor 显式 ids 也要过闸（对话级技能走这条路）
  const pf = skillsJs.slice(skillsJs.indexOf('function promptsFor'), skillsJs.indexOf('function promptsFor') + 700);
  C(/tierAllows\(myTier/.test(pf), '★ promptsFor() 对显式 ids 也过档位闸（防拿 id 绕过）');
  // 管理员端点
  C(serverJs2.indexOf('admTierM') > 0 && /admin\\\/spaces/.test(serverJs2), '管理员改档路由存在');
  C(/admin\/skill-tiers/.test(serverJs2), '管理员查档位路由存在');
  // 路由必须在"需要登录"闸门之前（管理员是另一套 token 体系）
  const iAdmTier = serverJs2.indexOf("admin/skill-tiers");
  const iGate = serverJs2.indexOf('以下都需要登录');
  C(iAdmTier > 0 && iAdmTier < iGate, '管理员档位路由在登录闸门之前');
  // FORBIDDEN 必须映射成 403（不是 400）
  C(/FORBIDDEN' \? 403/.test(serverJs2), '锁定技能返回 403 而不是 400');
  // 新空间的 tier 必须显式写（不能靠 schema 默认值，老库默认是已废弃的 free）
  C(/passcode,tier,created_at,last_at/.test(authJs), '★ createSpace 显式写 tier（不依赖 schema 默认值）');

  log('== G 组：档位的前端接线 ==');
  // 卡片要按 locked 加类、不画开关、不给"开对话"入口
  const rsl2 = appJs.slice(appJs.indexOf('function renderSkillList()'), appJs.indexOf('async function toggleSkill'));
  C(/s\.locked \? ' locked'/.test(rsl2), '卡片按 locked 加类');
  C(/sc-lock/.test(rsl2), '锁定态画锁图标');
  C(/s\.locked \? '' : '<button class="sc-go"/.test(rsl2), '★ 锁定技能不给「用它开对话」入口');
  C(/需「' \+ HL\.esc\(s\.tierName/.test(rsl2), '锁定卡片写清"需要哪一档"');
  // 点锁定卡片不发请求，只解释
  const tog = appJs.slice(appJs.indexOf('async function toggleSkill'), appJs.indexOf('async function openSkillChat'));
  C(/if \(s && s\.locked\)/.test(tog), '★ toggleSkill 对锁定技能直接返回（不发请求）');
  const osc2 = appJs.slice(appJs.indexOf('async function openSkillChat'), appJs.indexOf('async function openSkillChat') + 700);
  C(/if \(s && s\.locked\)/.test(osc2), '★ openSkillChat 对锁定技能直接返回');
  // 档位说明条
  C(/function renderSkillTierNote\(/.test(appJs), 'renderSkillTierNote 存在');
  C(/renderSkillTierNote\(\)/.test(appJs.slice(appJs.indexOf('async function loadSkills'))), '★ loadSkills 真的调用了 renderSkillTierNote（钉调用点）');
  C(/id="skillTierNote"/.test(html), 'HTML 有 skillTierNote 容器');
  // 档位措辞不能被包装成"奖励/升级"
  const noteFn = appJs.slice(appJs.indexOf('function renderSkillTierNote'), appJs.indexOf('function renderSkillList()'));
  C(!/升级|奖励|打卡|排行榜/.test(noteFn), '★ 档位说明不含"升级/奖励"（不用外部激励驱动学习）');
  // 管理面板下拉
  C(/class="adm-tier"/.test(appJs), '管理面板有档位下拉');
  C(/closest\('\.adm-tier'\)/.test(appJs), '★ 档位下拉的 change 委托已绑（钉调用点）');
  C(/spaces\/' \+ encodeURIComponent\(sid\) \+ '\/tier'/.test(appJs), '下拉真的打改档接口');
  C(/\.adm-tier\b/.test(read('public/app.css')), 'adm-tier 有样式');

  return { pass: pass, fail: fail, problems: problems };
}

if (require.main === module) {
  const r = check(false);
  console.log('\n通过 ' + r.pass + ' 项，失败 ' + r.fail + ' 项');
  process.exit(r.fail ? 1 : 0);
}
module.exports = { check };

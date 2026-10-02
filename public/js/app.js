/* 后浪学习平台 · 前端应用
 *
 * 分工：
 *   render.js 只管"把一段文本变成 DOM 该长什么样"（含 svg-json → 原生 SVG）
 *   本文件只管"状态、请求、交互"——不拼 HTML 细节（消息体一律交给 HL.render）
 *
 * 两个刻意的取舍：
 *   · 流式渲染用 requestAnimationFrame 节流。每个 delta 都重排 Markdown 会把主线程打满，
 *     观感上反而更卡。攒一帧再画。
 *   · 装饰性动效（空间门背景）用 Canvas 2D，不占用 SVG 通道——
 *     需要被理解/编辑/导出的东西才走 SVG，这条线不越。
 */
(function () {
  'use strict';

  const $ = s => document.querySelector(s);
  const $$ = s => Array.prototype.slice.call(document.querySelectorAll(s));
  const TOKEN_KEY = 'hl_token', THEME_KEY = 'hl_theme', FONT_KEY = 'hl_font';

  // ================= 状态 =================
  const S = {
    token: localStorage.getItem(TOKEN_KEY) || '',
    me: null,
    space: null,
    convs: [],
    convId: '',
    mode: 'selfstudy',
    model: 'default',
    projects: [],
    streaming: false,
    models: [],
    cards: { items: [], total: 0, page: 1, pages: 1, pageSize: 20 },
    justCard: '',
    cardQ: { status: 'all', sort: 'due', q: '' },
    memory: { enabled: true, memories: [] },
    pet: null,
    stats: null,
    skills: [],
    skillEnabled: [],
    kbCats: [],
    kbDocs: [],
    kbUncat: 0,
    kbCapa: { capacity: 5, maxCapacity: 200, maxCategories: 30 },
    en: { units: [], words: [] },
    pool: { items: [], ban: null, active: 0, maxActive: 20 },
    anns: [],
    // ---- 批次2：Chat 富功能 ----
    agents: [],            // 智能体清单（= 能力中心的技能）
    agentId: '',           // 当前对话选中的智能体
    webSearch: false,      // 联网搜索开关
    tempDocs: [],          // 对话级临时资料
    pending: [],           // 待发送附件（图片）
    tts: { rate: 1, maxChars: 5000 },
    speaking: '',          // 正在朗读的消息 id
    favOnly: false,        // 侧栏只看收藏
    convQ: '',             // 侧栏搜索词
    jobs: {},              // 配图任务：messageId -> job
    sideCollapsed: false,
    // ---- 批次7：项目为主轴 + 宠物阶段解锁 ----
    openProj: {},          // 左栏项目展开状态：projectId -> bool（缺省展开）
    unlocks: null,         // 当前已解锁的功能（来自 /api/pet，null = 还没拿到，此时不锁任何东西）
  };

  // 学科显示名。全局一份 —— 以前"能力"页和"测评/卡片/池子"各写各的，
  // 新增 social 学科时就会漏掉其中一处，界面上冒出个英文 "social"。
  const SUBJ_NAME = { general: '综合', math: '数学', chinese: '语文', english: '英语', science: '科学', social: '社会' };
  // 学科筛选的展示顺序（不跟着对象键序走，免得换写法就变序）
  const SUBJ_ORDER = ['general', 'math', 'chinese', 'english', 'science', 'social'];

  // ================= 通用工具 =================
  // 搜索框输入防抖：每敲一个字就发一次请求，会把后端打满，也会让列表闪
  function debounce(fn, ms) {
    let t = 0;
    return function () {
      const a = arguments;
      clearTimeout(t);
      t = setTimeout(() => fn.apply(null, a), ms);
    };
  }
  function toast(msg, ms) {
    const el = $('#toast');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(el._t);
    el._t = setTimeout(() => { el.hidden = true; }, ms || 2400);
  }
  function copyText(t) {
    const done = () => toast('已复制');
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(t).then(done).catch(() => fallback());
    } else fallback();
    function fallback() {
      const ta = document.createElement('textarea');
      ta.value = t; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); done(); } catch (e) { toast('复制失败，请手动选中'); }
      ta.remove();
    }
  }
  function fmtTime(ts) {
    if (!ts) return '';
    const d = new Date(ts), n = Date.now(), diff = n - ts;
    if (diff < 60000) return '刚刚';
    if (diff < 3600000) return Math.floor(diff / 60000) + ' 分钟前';
    if (diff < 86400000) return Math.floor(diff / 3600000) + ' 小时前';
    if (diff < 86400000 * 7) return Math.floor(diff / 86400000) + ' 天前';
    return (d.getMonth() + 1) + '月' + d.getDate() + '日';
  }
  function fmtDue(ts) {
    if (!ts) return '';
    const diff = ts - Date.now();
    if (diff <= 0) return '现在可以练';
    const d = Math.ceil(diff / 86400000);
    if (d <= 1) return '明天再练';
    return d + ' 天后再练';
  }
  function petIcon(stage) {
    const n = Math.max(1, Math.min(5, Number(stage) || 1));
    let leaves = '';
    for (let i = 0; i < n; i++) {
      const y = 15 - i * 2.4;
      const w = 3 + i * 0.7;
      leaves += '<path d="M12 ' + y + ' C' + (12 - w) + ' ' + (y - 2) + ' ' + (12 - w) + ' ' + (y - 4) + ' 12 ' + (y - 4.6) +
        ' C' + (12 + w) + ' ' + (y - 4) + ' ' + (12 + w) + ' ' + (y - 2) + ' 12 ' + y + ' Z" fill="var(--ok)" opacity="' + (0.45 + i * 0.14) + '"/>';
    }
    return '<svg class="pet-ico" viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">' +
      '<rect x="11.2" y="13" width="1.6" height="9" rx=".8" fill="var(--dim2)"/>' + leaves + '</svg>';
  }

  // ================= 请求 =================
  // noSignOut：登录/注册/重置这类接口自己就会返 401（比如验证码错），
  // 不能因为一次登录失败就把整个页面踢回空间门 —— 那是 401 自动登出的语义。
  async function api(path, opt) {
    const o = opt || {};
    const h = { 'Content-Type': 'application/json' };
    if (S.token) h['Authorization'] = 'Bearer ' + S.token;
    // 云宿主(app.workbuddy.host)反代会剥掉 Authorization 头，故把 token 同时放进查询串 ?_t= 穿透代理。
    let url = path;
    if (S.token) {
      const sep = url.indexOf('?') >= 0 ? '&' : '?';
      url = url + sep + '_t=' + encodeURIComponent(S.token);
    }
    const res = await fetch(url, {
      method: o.method || 'GET',
      headers: Object.assign(h, o.headers || {}),
      body: o.body ? JSON.stringify(o.body) : undefined,
    });
    let j = null;
    try { j = await res.json(); } catch (e) { j = {}; }
    if (res.status === 401 && !o.noSignOut) { signOut(true); throw new Error(j.message || '登录已失效'); }
    if (!res.ok) { const e = new Error(j.message || j.error || ('请求失败 ' + res.status)); e.code = j.error; e.data = j; throw e; }
    return j;
  }

  // ================= 主题 / 字号 =================
  function applyTheme(t) {
    document.documentElement.setAttribute('data-theme', t);
    try { localStorage.setItem(THEME_KEY, t); } catch (e) {}
    $$('#themeSeg button').forEach(b => b.classList.toggle('on', b.dataset.theme === t));
  }
  function applyFont(f) {
    document.documentElement.setAttribute('data-font', f);
    try { localStorage.setItem(FONT_KEY, f); } catch (e) {}
    $$('#fontSeg button').forEach(b => b.classList.toggle('on', b.dataset.font === f));
  }

  // ================= 空间门 =================
  function showLand(stale) {
    $('#app').style.display = 'none';
    $('#land').style.display = 'flex';
    $('#landStale').style.display = stale ? 'block' : 'none';
    if (stale) $('#landStale').textContent = stale;
    startLandCanvas();
  }
  function hideLand() {
    $('#land').style.display = 'none';
    stopLandCanvas();
  }

  // —— 背景粒子：纯装饰，用 Canvas 2D ——
  let rafId = null, particles = [], cvSize = { w: 0, h: 0 };
  const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  function startLandCanvas() {
    const cv = $('#landCanvas');
    if (!cv || reduceMotion) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    function resize() {
      cvSize.w = cv.clientWidth; cvSize.h = cv.clientHeight;
      cv.width = cvSize.w * dpr; cv.height = cvSize.h * dpr;
      const ctx = cv.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    resize();
    window.addEventListener('resize', resize);
    const N = Math.min(46, Math.round(cvSize.w * cvSize.h / 26000));
    particles = Array.from({ length: N }, () => ({
      x: Math.random() * cvSize.w, y: Math.random() * cvSize.h,
      vx: (Math.random() - .5) * .22, vy: (Math.random() - .5) * .22,
      r: Math.random() * 1.7 + .7,
    }));
    const ctx = cv.getContext('2d');
    function frame() {
      const dark = document.documentElement.getAttribute('data-theme') === 'dark';
      ctx.clearRect(0, 0, cvSize.w, cvSize.h);
      for (let i = 0; i < particles.length; i++) {
        const p = particles[i];
        p.x += p.vx; p.y += p.vy;
        if (p.x < 0 || p.x > cvSize.w) p.vx *= -1;
        if (p.y < 0 || p.y > cvSize.h) p.vy *= -1;
        for (let j = i + 1; j < particles.length; j++) {
          const q = particles[j], dx = p.x - q.x, dy = p.y - q.y;
          const d2 = dx * dx + dy * dy;
          if (d2 < 16000) {
            ctx.strokeStyle = dark ? 'rgba(91,140,255,' + (0.16 * (1 - d2 / 16000)) + ')' : 'rgba(37,99,235,' + (0.13 * (1 - d2 / 16000)) + ')';
            ctx.lineWidth = 1;
            ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); ctx.stroke();
          }
        }
        ctx.fillStyle = dark ? 'rgba(123,164,255,.5)' : 'rgba(37,99,235,.42)';
        ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, 6.2832); ctx.fill();
      }
      rafId = requestAnimationFrame(frame);
    }
    cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(frame);
  }
  function stopLandCanvas() { cancelAnimationFrame(rafId); rafId = null; }

  // 姓名预检（防抖 + 防乱序）
  let nameTimer = null, nameSeq = 0;
  function bindLand() {
    $$('.land-tab').forEach(t => t.addEventListener('click', () => {
      $$('.land-tab').forEach(x => x.classList.toggle('on', x === t));
      const tab = t.dataset.tab;
      $('#paneCreate').style.display = tab === 'create' ? '' : 'none';
      $('#paneEnter').style.display = tab === 'enter' ? '' : 'none';
      $('#paneAccount').style.display = tab === 'account' ? '' : 'none';
      $('#landErr').textContent = '';
      if (tab === 'account') showAcctPanel('login');
      else setTimeout(() => (tab === 'create' ? $('#spName') : $('#spId')).focus(), 30);
    }));

    $('#spName').addEventListener('input', () => {
      const nm = $('#spName').value.trim();
      const hint = $('#spNameHint');
      clearTimeout(nameTimer);
      if (!nm) { hint.textContent = ''; hint.className = 'land-namehint'; return; }
      hint.textContent = '检查中…'; hint.className = 'land-namehint';
      nameTimer = setTimeout(async () => {
        const seq = ++nameSeq;
        try {
          const r = await fetch('/api/space-name?name=' + encodeURIComponent(nm)).then(x => x.json());
          if (seq !== nameSeq) return;
          if (r.available) { hint.textContent = '这个姓名可以用'; hint.className = 'land-namehint ok'; }
          else { hint.textContent = '已有同名的学习空间，建议改成「' + r.suggested + '」'; hint.className = 'land-namehint bad'; }
        } catch (e) { hint.textContent = ''; hint.className = 'land-namehint'; }
      }, 350);
    });

    $('#spCreate').addEventListener('click', async () => {
      const name = $('#spName').value.trim();
      const passcode = $('#spPass').value;
      $('#landErr').textContent = '';
      if (!name) { $('#landErr').textContent = '请先填写姓名'; return; }
      $('#spCreate').disabled = true;
      try {
        const r = await api('/api/space', { method: 'POST', body: { name, passcode } });
        setToken(r.token); await enterApp();
      } catch (e) {
        if (e.code === 'NAME_TAKEN' && e.data && e.data.suggested) {
          $('#spName').value = e.data.suggested;
          $('#spName').select();
          $('#spNameHint').textContent = '已自动改成「' + e.data.suggested + '」，可以直接创建';
          $('#spNameHint').className = 'land-namehint bad';
        }
        $('#landErr').textContent = e.message;
      } finally { $('#spCreate').disabled = false; }
    });

    $('#spEnter').addEventListener('click', async () => {
      const spaceId = $('#spId').value.trim();
      const passcode = $('#spPass2').value;
      $('#landErr').textContent = '';
      if (!spaceId) { $('#landErr').textContent = '请填写空间 ID'; return; }
      $('#spEnter').disabled = true;
      try {
        const r = await api('/api/space', { method: 'POST', body: { spaceId, passcode } });
        setToken(r.token); await enterApp();
      } catch (e) { $('#landErr').textContent = e.message; }
      finally { $('#spEnter').disabled = false; }
    });

    $('#spAdmin').addEventListener('click', openAdmin);
    ['spName', 'spId'].forEach(id => $('#' + id).addEventListener('keydown', e => {
      if (e.key === 'Enter') (id === 'spName' ? $('#spCreate') : $('#spEnter')).click();
    }));
    bindAccount();
  }

  // ================= 账号（批次1）=================
  // 三条入口并存：空间口令（最轻）、账号密码、手机验证码。
  // 为什么保留空间口令：家长给孩子开个空间不该先注册账号；账号是"要跨设备/要分角色"才需要。
  const DOC_IDS = ['terms', 'privacy', 'children-privacy'];
  const STAGES = ['小学', '初中', '高中', '已毕业'];
  const GRADES = {
    '小学': ['1年级', '2年级', '3年级', '4年级', '5年级', '6年级'],
    '初中': ['七年级', '八年级', '九年级'],
    '高中': ['高一', '高二', '高三'],
    '已毕业': ['已毕业'],
  };
  let smsTimer = null;

  function acctErr(msg) { $('#landErr').textContent = msg || ''; }
  function panelId(k) { return '#acct' + k.charAt(0).toUpperCase() + k.slice(1); }
  function showAcctPanel(which) {
    ['login', 'sms', 'register', 'reset'].forEach(k => { $(panelId(k)).hidden = k !== which; });
    acctErr('');
  }
  function fillGrades(gs, stage, grade) {
    const list = GRADES[stage] || [];
    gs.innerHTML = '<option value="">年级</option>' + list.map(g => '<option value="' + g + '">' + g + '</option>').join('');
    gs.value = grade || '';
  }
  function fillStageGrade(stageId, gradeId, stage, grade) {
    const ss = $(stageId);
    ss.innerHTML = '<option value="">学段</option>' + STAGES.map(s => '<option value="' + s + '">' + s + '</option>').join('');
    ss.value = stage || '';
    fillGrades($(gradeId), stage, grade);
  }

  async function openDoc(id) {
    try {
      const r = await fetch('/api/docs/' + id).then(x => x.json());
      if (!r.ok || !r.doc) { toast('这份文件暂时打不开'); return; }
      const d = r.doc;
      openModal(d.title, '<div class="doc-meta">版本 ' + HL.esc(d.version) + '</div><div class="doc-body">' +
        d.sections.map(s => '<h4>' + HL.esc(s.heading) + '</h4><p>' + HL.esc(s.body) + '</p>').join('') + '</div>');
    } catch (e) { toast('这份文件暂时打不开'); }
  }

  function startSmsCountdown(btn) {
    let n = 60;
    btn.disabled = true;
    btn.textContent = n + ' 秒后重发';
    clearInterval(smsTimer);
    smsTimer = setInterval(() => {
      n--;
      if (n <= 0) { clearInterval(smsTimer); btn.disabled = false; btn.textContent = '获取验证码'; return; }
      btn.textContent = n + ' 秒后重发';
    }, 1000);
  }

  // 返回验证码：开发模式（后端没配短信通道）下把码回填进输入框，本地才跑得通。
  // 线上配了 SMS_PROVIDER_URL，后端就不会回 devCode，这里自然什么都不填。
  async function sendCode(phone, scene, btn) {
    const p = String(phone || '').trim();
    if (!/^1\d{10}$/.test(p)) { acctErr('请输入正确的 11 位手机号'); return null; }
    btn.disabled = true;
    try {
      const r = await fetch('/api/auth/sms/send', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: p, scene }),
      }).then(x => x.json());
      if (!r.ok) { acctErr(r.message || '验证码发送失败'); btn.disabled = false; return null; }
      acctErr('');
      startSmsCountdown(btn);
      if (r.devCode) { toast('当前是开发模式，验证码 ' + r.devCode, 6000); return r.devCode; }
      toast('验证码已发送');
      return '';
    } catch (e) { acctErr('发送失败，请检查网络'); btn.disabled = false; return null; }
  }

  function bindAccount() {
    fillStageGrade('#rgStage', '#rgGrade', '', '');
    fillStageGrade('#smsStage', '#smsGrade', '', '');
    $('#rgStage').addEventListener('change', () => fillGrades($('#rgGrade'), $('#rgStage').value, ''));
    $('#smsStage').addEventListener('change', () => fillGrades($('#smsGrade'), $('#smsStage').value, ''));

    // 协议链接（勾选框里的三个 + 页脚常驻的三个）
    // ★ 必须限定在 #land 内：知识库资料卡的「看全文 / 重新解析 / 移到 / 删除」
    //   也用 data-doc 传动作名，全文档扫会把它们一起绑成"打开协议"。
    //   现在靠"渲染时机晚于 bindAccount"侥幸不出错，属于随时会炸的巧合。
    $$('#land [data-doc]').forEach(a => a.addEventListener('click', e => { e.preventDefault(); openDoc(a.dataset.doc); }));

    // —— 密码登录 ——
    $('#acctLoginBtn').addEventListener('click', async () => {
      const account = $('#acctName').value.trim();
      const password = $('#acctPass').value;
      acctErr('');
      if (!account) return acctErr('请输入用户名、手机号或邮箱');
      if (!password) return acctErr('请输入密码');
      $('#acctLoginBtn').disabled = true;
      try {
        const r = await api('/api/auth/login', { method: 'POST', noSignOut: true, body: { account, password } });
        setToken(r.token); await enterApp();
      } catch (e) { acctErr(e.message); }
      finally { $('#acctLoginBtn').disabled = false; }
    });
    $('#acctName').addEventListener('keydown', e => { if (e.key === 'Enter') $('#acctPass').focus(); });
    $('#acctPass').addEventListener('keydown', e => { if (e.key === 'Enter') $('#acctLoginBtn').click(); });

    $('#acctToRegister').addEventListener('click', () => { showAcctPanel('register'); $('#rgName').focus(); });
    $('#acctToSms').addEventListener('click', () => { showAcctPanel('sms'); $('#smsPhone').focus(); });
    $('#acctToReset').addEventListener('click', () => { showAcctPanel('reset'); $('#rsPhone').focus(); });
    $('#smsBack').addEventListener('click', () => showAcctPanel('login'));
    $('#rgBack').addEventListener('click', () => showAcctPanel('login'));
    $('#rsBack').addEventListener('click', () => showAcctPanel('login'));

    // —— 手机验证码登录 ——
    $('#smsSend').addEventListener('click', async () => {
      const c = await sendCode($('#smsPhone').value, 'login', $('#smsSend'));
      if (c) $('#smsCode').value = c;
    });
    $('#smsLoginBtn').addEventListener('click', async () => {
      const phone = $('#smsPhone').value.trim();
      const code = $('#smsCode').value.trim();
      acctErr('');
      if (!/^1\d{10}$/.test(phone)) return acctErr('请输入正确的 11 位手机号');
      if (!/^\d{6}$/.test(code)) return acctErr('请输入 6 位验证码');
      const consents = $('#smsAgree').checked ? DOC_IDS.slice() : [];
      $('#smsLoginBtn').disabled = true;
      try {
        const r = await api('/api/auth/login/sms', {
          method: 'POST', noSignOut: true,
          body: {
            phone, code, consents,
            name: $('#smsName').value.trim(),
            stage: $('#smsStage').value, grade: $('#smsGrade').value,
          },
        });
        setToken(r.token); await enterApp();
      } catch (e) {
        // 只有新用户会被 NEED_CONSENT 拦下 —— 顺便把"填名字/学段"这步露出来，
        // 老用户永远看不到这些字段，少填两栏
        if (e.code === 'NEED_CONSENT') {
          $('#smsNewUser').hidden = false;
          acctErr('首次登录：请填写你的名字，并勾选下面的三份文件');
        } else acctErr(e.message);
      } finally { $('#smsLoginBtn').disabled = false; }
    });

    // —— 注册 ——
    $('#rgSubmit').addEventListener('click', async () => {
      const username = $('#rgName').value.trim();
      const phone = $('#rgPhone').value.trim();
      const email = $('#rgEmail').value.trim();
      const p1 = $('#rgPass').value, p2 = $('#rgPass2').value;
      acctErr('');
      if (!username && !phone && !email) return acctErr('请至少填写用户名、手机号、邮箱中的一项');
      if (p1.length < 6) return acctErr('密码至少 6 位');
      if (p1 !== p2) return acctErr('两次密码不一致');
      if (!$('#rgAgree').checked) return acctErr('请先阅读并同意三份文件');
      $('#rgSubmit').disabled = true;
      try {
        const r = await api('/api/auth/register', {
          method: 'POST', noSignOut: true,
          body: {
            username, phone, email, password: p1, name: username,
            stage: $('#rgStage').value, grade: $('#rgGrade').value, consents: DOC_IDS.slice(),
          },
        });
        setToken(r.token); await enterApp();
      } catch (e) { acctErr(e.message); }
      finally { $('#rgSubmit').disabled = false; }
    });

    // —— 忘记密码 ——
    $('#rsSend').addEventListener('click', async () => {
      const c = await sendCode($('#rsPhone').value, 'reset', $('#rsSend'));
      if (c) $('#rsCode').value = c;
    });
    $('#rsSubmit').addEventListener('click', async () => {
      const phone = $('#rsPhone').value.trim();
      const code = $('#rsCode').value.trim();
      const p1 = $('#rsPass').value, p2 = $('#rsPass2').value;
      acctErr('');
      if (!/^1\d{10}$/.test(phone)) return acctErr('请输入正确的 11 位手机号');
      if (!/^\d{6}$/.test(code)) return acctErr('请输入 6 位验证码');
      if (p1.length < 6) return acctErr('新密码至少 6 位');
      if (p1 !== p2) return acctErr('两次密码不一致');
      $('#rsSubmit').disabled = true;
      try {
        await api('/api/auth/reset-password', { method: 'POST', noSignOut: true, body: { phone, code, password: p1 } });
        toast('密码已重置，请用新密码登录');
        showAcctPanel('login');
        $('#acctName').value = phone;
        $('#acctPass').value = '';
        $('#acctPass').focus();
      } catch (e) { acctErr(e.message); }
      finally { $('#rsSubmit').disabled = false; }
    });
  }

  function setToken(t) {
    S.token = t || '';
    try { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY); } catch (e) {}
  }

  // 管理员：空间列表 + **用户管理**
  //
  // 以前这个面板只有一列空间，看得到用户却管不着 —— 家长打电话来说"帮我停掉那个账号"，
  // 管理员只能在数据库里手改。现在把三件事做进界面：看清楚是谁、停用/恢复、重置密码。
  // ★ 删号不做：学生攒的对话和错题是家长的资产，删掉不可逆；停用 + 可恢复才对。
  let adminToken = '';
  function adminApi(path, opt) {
    const o = Object.assign({ headers: { 'Content-Type': 'application/json' } }, opt || {});
    const sep = path.indexOf('?') >= 0 ? '&' : '?';
    return fetch(path + sep + '_t=' + encodeURIComponent(adminToken), o);
  }

  function agoStr(ts) {
    if (!ts) return '从未';
    const d = Date.now() - Number(ts);
    if (d < 60000) return '刚刚';
    if (d < 3600000) return Math.floor(d / 60000) + ' 分钟前';
    if (d < 86400000) return Math.floor(d / 3600000) + ' 小时前';
    if (d < 2592000000) return Math.floor(d / 86400000) + ' 天前';
    try { return new Date(Number(ts)).toLocaleDateString(); } catch (e) { return '—'; }
  }

  function adminUsersHTML(users) {
    if (!users.length) return '<p class="dim">还没有注册用户</p>';
    return users.map(u => {
      const who = HL.esc(u.name || u.username || u.phone || u.email || u.id);
      // 联系方式要能"看得到也能复制走" —— 管理员常常要去另一个系统里查这个人
      const contacts = [u.phone ? ('手机 ' + HL.esc(u.phone)) : '', u.email ? HL.esc(u.email) : '']
        .filter(Boolean).join(' · ') || '未绑定联系方式';
      return '<div class="row-card adm-user" data-uid="' + HL.esc(u.id) + '">' +
        '<div class="adm-u-h"><b>' + who + '</b>' +
        (u.disabled ? '<span class="chip almost">已停用</span>' : '<span class="chip mastered">正常</span>') +
        '<span class="chip">' + HL.esc(u.role === 'admin' ? '管理员' : (u.role === 'parent' ? '家长' : '学生')) + '</span>' +
        '</div>' +
        '<div class="dim adm-u-m">' + contacts + '</div>' +
        '<div class="dim adm-u-m">空间 ' + HL.esc(u.spaceName || u.spaceId) + '（' + u.spaceId + '）' +
        ' · 对话 ' + u.conversations + ' · 消息 ' + u.messages + '</div>' +
        '<div class="dim adm-u-m">注册 ' + agoStr(u.createdAt) + ' · 最近登录 ' + agoStr(u.lastLoginAt) + '</div>' +
        (u.disabled && u.disabledReason ? '<div class="dim adm-u-m">停用原因：' + HL.esc(u.disabledReason) + '</div>' : '') +
        '<div class="adm-u-act">' +
        '<button class="btn sm" data-adm="' + (u.disabled ? 'enable' : 'disable') + '" data-uid="' + HL.esc(u.id) + '">' +
        (u.disabled ? '恢复使用' : '停用') + '</button>' +
        '<button class="btn sm" data-adm="reset" data-uid="' + HL.esc(u.id) + '">重置密码</button>' +
        '</div></div>';
    }).join('');
  }

  async function reloadAdminUsers() {
    const r = await adminApi('/api/admin/users').then(x => x.json()).catch(() => ({ users: [] }));
    const box = $('#admUsers');
    if (box) box.innerHTML = adminUsersHTML(r.users || []);
  }

  async function openAdmin() {
    const pw = prompt('请输入管理密码');
    if (pw == null) return;
    let r;
    try {
      r = await fetch('/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: pw }) }).then(x => x.json());
    } catch (e) { toast('连不上服务器'); return; }
    if (!r.ok) { toast(r.message || '管理密码不正确'); return; }
    adminToken = r.token;

    let list = { spaces: [] }, users = { users: [] };
    try {
      [list, users] = await Promise.all([
        adminApi('/api/admin/spaces').then(x => x.json()),
        adminApi('/api/admin/users').then(x => x.json()),
      ]);
    } catch (e) { toast('读取管理数据失败'); return; }

    const spRows = (list.spaces || []).map(s =>
      '<div class="row-card" style="margin-bottom:8px"><div><b>' + HL.esc(s.name) + '</b>' +
      (s.dupName ? ' <span class="chip almost">重名</span>' : '') +
      '<div class="dim">ID：' + HL.esc(s.spaceId) + ' · 对话 ' + s.conversations + ' · 知识卡 ' + s.cards +
      ' · ' + (s.hasPasscode ? '有口令' : '无口令') + '</div></div></div>').join('');

    openModal('管理后台', [
      '<div class="adm-tabs">' +
      '<button class="adm-tab on" data-admtab="users">用户管理（' + (users.users || []).length + '）</button>' +
      '<button class="adm-tab" data-admtab="spaces">空间（' + (list.spaces || []).length + '）</button>' +
      '</div>',
      '<div id="admUsers">' + adminUsersHTML(users.users || []) + '</div>',
      '<div id="admSpaces" hidden>' + (spRows || '<p class="dim">还没有空间</p>') + '</div>',
      '<p class="dim" style="margin-top:10px">停用会立刻让他下线并无法登录；这里不提供删号 —— ' +
      '学生的对话与错题是家长的资产，删掉不可逆。</p>',
    ].join(''));
  }

  // 管理后台的事件委托：面板内容是动态重排的，逐个绑会在重绘后失效
  function initAdminPanel() {
    document.addEventListener('click', async (e) => {
      const tab = e.target && e.target.closest ? e.target.closest('.adm-tab') : null;
      if (tab) {
        const want = tab.dataset.admtab;
        const uBox = $('#admUsers'), sBox = $('#admSpaces');
        if (uBox && sBox) {
          const isUsers = want === 'users';
          uBox.hidden = !isUsers; sBox.hidden = isUsers;
        }
        const wrap = tab.parentElement;
        if (wrap) Array.prototype.forEach.call(wrap.querySelectorAll('.adm-tab'), b => b.classList.toggle('on', b === tab));
        return;
      }
      const btn = e.target && e.target.closest ? e.target.closest('[data-adm]') : null;
      if (!btn) return;
      const uid = btn.dataset.uid;
      const act = btn.dataset.adm;
      try {
        if (act === 'disable') {
          const why = prompt('停用原因（会显示给他看，可留空）', '');
          if (why == null) return;
          const j = await adminApi('/api/admin/users/' + encodeURIComponent(uid) + '/disabled', {
            method: 'POST', body: JSON.stringify({ disabled: true, reason: why }),
          }).then(x => x.json());
          if (!j.ok) throw new Error(j.message || '操作失败');
          toast('已停用，该用户已下线');
        } else if (act === 'enable') {
          const j = await adminApi('/api/admin/users/' + encodeURIComponent(uid) + '/disabled', {
            method: 'POST', body: JSON.stringify({ disabled: false }),
          }).then(x => x.json());
          if (!j.ok) throw new Error(j.message || '操作失败');
          toast('已恢复使用');
        } else if (act === 'reset') {
          const np = prompt('输入新密码（至少 6 位）', '');
          if (np == null) return;
          if (String(np).length < 6) { toast('密码至少 6 位'); return; }
          const j = await adminApi('/api/admin/users/' + encodeURIComponent(uid) + '/password', {
            method: 'POST', body: JSON.stringify({ password: np }),
          }).then(x => x.json());
          if (!j.ok) throw new Error(j.message || '操作失败');
          toast('密码已重置，他需要用新密码重新登录');
        }
        await reloadAdminUsers();
      } catch (err) { toast(err.message || '操作失败'); }
    });
  }

  // ================= 主界面 =================
  async function enterApp() {
    let me;
    try { me = await api('/api/me'); }
    catch (e) { setToken(''); showLand('登录状态已失效，请重新进入空间'); return; }
    S.me = me;
    S.space = me.space;
    hideLand();
    $('#app').style.display = 'flex';
    $('#spaceName').textContent = me.space.name || me.space.id;
    $('#spaceIdChip').textContent = 'ID：' + me.space.id;
    $('#spaceIdChip').title = '点击复制空间 ID：' + me.space.id;

    await Promise.all([loadModels(), loadSide(), loadPet(), loadCardSummary(), loadSkills(), loadAvatars(), loadAnnouncements(), loadAgents(), loadTtsPref()]);
    // 侧栏收起状态是本地偏好，跟着设备走（手机上默认就是收起的）
    try { if (localStorage.getItem('hl_side_min') === '1') { S.sideCollapsed = false; toggleSide(); } } catch (e) {}
    startHeartbeat();
    renderKbTabs();
    // loadSkills() 在 renderKbTabs() 之前跑完，角标元素当时还不存在，这里补一次
    setTabBadge('skills', (S.skillEnabled || []).length);
    renderMeChip();
    switchView('chat');
    // 刷新后不要落在空白对话上——那看起来像"东西丢了"。
    // 有历史就直接接上最近一条，没有才显示引导语。
    if (S.convs.length) await openConv(S.convs[0].id);
    else renderStreamEmpty();
  }

  function signOut(silent) {
    stopSpeak();
    if (S.token) {
      api('/api/auth/logout', { method: 'POST' }).catch(() => {});
      api('/api/users/session/end', { method: 'POST' }).catch(() => {});
    }
    stopHeartbeat();
    setToken('');
    S.convId = ''; S.convs = []; S.me = null; S.tempDocs = []; S.pending = [];
    S.pendingProjectId = null;
    if (!silent) toast('已退出');
    showLand(silent ? '登录状态已失效，请重新进入空间' : '');
  }

  async function loadModels() {
    try {
      const r = await fetch('/api/models').then(x => x.json());
      S.models = r.models || [];
      const sel = $('#modelSel');
      sel.innerHTML = S.models.map(m =>
        '<option value="' + HL.esc(m.id) + '" title="' + HL.esc(m.desc || '') + '">' +
        HL.esc(m.tag || m.name) + ' · ' + HL.esc(m.displayName || m.name) + '</option>').join('');
      if (S.models.length) S.model = S.models[0].id;
    } catch (e) {}
  }

  async function loadTtsPref() {
    try {
      const r = await api('/api/tts/settings');
      S.tts = { rate: r.settings.rate, maxChars: r.maxChars };
    } catch (e) {}
  }

  // ---------- 视图切换 ----------
  // ★ 顶级只有两根：对话 / 知识库。
  //   其余功能不再是平级导航，而是知识库里的二级分区（KB_SUBS）。
  //   memory / settings 只在右上角头像菜单里出现，不占分区条 ——
  //   它们是"设置类"入口，跟"翻自己的东西"不是一回事，混在分区条里会让人以为要去找资料。
  const TOP_VIEWS = ['chat', 'kb'];
  const KB_SUBS = [
    { key: 'docs', id: 'sub-docs', name: '资料', hint: '左边挑一个本子，右边的资料就是对它生效的', load: () => loadKb() },
    { key: 'cards', id: 'view-cards', name: '知识卡', hint: '把学过的知识，慢慢收在这里', load: () => loadCards() },
    { key: 'exam', id: 'view-exam', name: '测评', hint: '题从你收下的知识卡里出，做完的每一题都会回到复习队列', load: () => loadExams() },
    { key: 'en', id: 'view-en', name: '英语', hint: '单词本 + 听写', load: () => loadEn() },
    { key: 'pool', id: 'view-pool', name: '共享池', hint: '同学之间互相给的学习资料，取用是复制进自己空间', load: () => loadPool() },
    { key: 'projects', id: 'view-projects', name: '项目', hint: '一个项目 = 一组资料 + 一条学习指令', load: () => loadProjects() },
    { key: 'dash', id: 'view-dash', name: '看板', hint: '先看清楚做了什么，再决定补哪里', load: () => loadDash() },
    { key: 'parent', id: 'view-parent', name: '家长视角', hint: '同一批事实，换一个"我能做什么"的问法', load: () => loadParent() },
    { key: 'skills', id: 'view-skills', name: '能力', hint: '每个能力都是一套「怎么教你」的方法', load: () => loadSkills() },
    { key: 'memory', id: 'view-memory', name: '记忆', hint: '让 AI 记住你的偏好与学习状态', hidden: true, load: () => loadMemory() },
    { key: 'settings', id: 'view-settings', name: '设置', hint: '个人资料 · 主题 · 字号', hidden: true, load: () => renderSettings() },
  ];
  let kbSub = 'docs';
  function kbSubOf(key) { return KB_SUBS.filter(s => s.key === key)[0] || KB_SUBS[0]; }

  /**
   * 这个功能解锁了没有。
   * unlocks 还没拿到（null）时一律当作已解锁 —— 否则首屏会先闪一下"全灰"再亮起来。
   * 设置不算功能，永远可用。
   */
  function isUnlocked(key) {
    if (key === 'settings') return true;
    if (!S.unlocks) return true;
    return (S.unlocks.unlocked || []).indexOf(key) >= 0;
  }
  /** 未解锁时的提示统一在这里生成，省得每个入口各写一套说法 */
  function lockedTip(key) {
    const row = KB_SUBS.filter(s => s.key === key)[0];
    const name = row ? row.name : key;
    const u = S.unlocks;
    if (u && u.next) {
      return (u.next.features || []).indexOf(key) >= 0
        ? ('再攒 ' + u.next.toNext + ' 点，就能解锁「' + name + '」')
        : ('「' + name + '」还在后面，先把「' + u.next.name + '」长出来');
    }
    return '「' + name + '」还没解锁';
  }

  function renderKbTabs() {
    $('#kbTabs').innerHTML = KB_SUBS.filter(s => !s.hidden).map(s => {
      const locked = !isUnlocked(s.key);
      return '<button class="kb-tab' + (kbSub === s.key ? ' on' : '') + (locked ? ' locked' : '') +
        '" data-sub="' + s.key + '" type="button"' +
        (locked ? ' data-locked="1" title="' + HL.esc(lockedTip(s.key)) + '"' : '') + '>' +
        HL.esc(s.name) +
        (locked ? '<span class="kb-tab-l"><svg width="9" height="9" viewBox="0 0 9 9" aria-hidden="true">' +
          '<rect x="1.5" y="4" width="6" height="4.5" rx="1" fill="currentColor"/>' +
          '<path d="M3 4V2.8a1.5 1.5 0 013 0V4" fill="none" stroke="currentColor" stroke-width="1"/></svg></span>' : '') +
        '<span class="kb-tab-b" data-b="' + s.key + '" hidden></span></button>';
    }).join('');
  }
  function setTabBadge(key, n) {
    const b = $('#kbTabs .kb-tab-b[data-b="' + key + '"]');
    if (!b) return;
    b.hidden = !n;
    b.textContent = n || '';
  }
  function setKbSub(key) {
    const row = kbSubOf(key);
    // 没解锁的分区点不进去 —— 但要说清楚"再攒多少点能开"，不能只弹一句"不可用"
    if (!isUnlocked(row.key)) { toast(lockedTip(row.key)); return; }
    kbSub = row.key;
    KB_SUBS.forEach(s => { const el = $('#' + s.id); if (el) el.hidden = s.id !== row.id; });
    $$('#kbTabs .kb-tab').forEach(b => b.classList.toggle('on', b.dataset.sub === kbSub));
    // 左侧"本子树"只对资料分区有意义：知识卡、看板这些东西不属于任何一个本子
    $('#kbTree').hidden = kbSub !== 'docs';
    $('#kbSearch').style.display = kbSub === 'docs' ? '' : 'none';
    $('#kbSub').textContent = row.hint;
    row.load();
  }
  function switchView(v) {
    const sub = KB_SUBS.filter(s => s.key === v)[0];
    if (sub) { showTop('kb'); setKbSub(v); return; }
    if (v === 'chat') { showTop('chat'); return; }
    // ★ 点顶级「知识库」一律落回「资料」，不保留上次停留的分区。
    //   保留会很贴心，但也让人困惑：点了"知识库"却停在"看板"，像进错了门。
    showTop('kb'); setKbSub('docs');
  }
  function showTop(v) {
    $$('.nav-i').forEach(b => b.classList.toggle('on', b.dataset.view === v));
    TOP_VIEWS.forEach(k => { const el = $('#view-' + k); if (el) el.hidden = k !== v; });
    $('#side').classList.remove('open');
    if (v === 'chat') setTimeout(() => $('#input').focus(), 40);
  }

  // ---------- 右上角头像入口 ----------
  // 顶级导航砍到两根之后，记忆 / 设置 / 公告 / 空间 不能继续占一级导航。
  // 它们都是"偶尔改一次"的入口，不是每天要翻的东西 —— 收进头像菜单更合适。
  function renderMeChip() {
    const me = S.me || {};
    const pr = me.profile || null;
    const cur = AVATARS.filter(a => a.id === (pr && pr.avatarPreset))[0] || AVATARS[0] || null;
    const nm = pr ? (pr.name || pr.username || pr.phone || '学习者')
      : ((me.space && (me.space.name || me.space.id)) || '学习者');
    $$('.me-chip').forEach(b => {
      b.innerHTML = '<span class="me-av">' + (cur ? avatarSvg(cur.shape, cur.color) : '') + '</span>' +
        '<span class="me-nm">' + esc(nm) + '</span><span class="me-caret">▾</span>';
    });
  }
  function meMenu() {
    const me = S.me || {};
    const sp = me.space || {};
    const unread = (S.anns || []).filter(a => !a.read).length;
    openModal('我的',
      '<div class="me-head"><span class="me-av big">' +
      ($$('.me-chip .me-av')[0] ? $$('.me-chip .me-av')[0].innerHTML : '') + '</span>' +
      '<div><b>' + esc(sp.name || sp.id || '学习者') + '</b>' +
      '<div class="dim">空间 ID ' + esc(sp.id || '') + '</div></div></div>' +
      '<div class="me-menu">' +
      // 记忆锁在阶段3（见 server/pet.js 的 UNLOCKS）—— 菜单项本身也要置灰，
      // 不能等用户点进去才告诉他"还不能用"。
      (isUnlocked('memory')
        ? '<button class="me-mi" data-me="memory" type="button"><b>记忆</b><span>让 AI 记住你的偏好与学习状态</span></button>'
        : '<button class="me-mi locked" data-me="memory" type="button" disabled><b>记忆 · 未解锁</b><span>' + esc(lockedTip('memory')) + '</span></button>') +
      '<button class="me-mi" data-me="settings" type="button"><b>设置</b><span>个人资料 · 主题 · 字号</span></button>' +
      '<button class="me-mi" data-me="ann" type="button"><b>公告</b><span>' +
      (unread ? '有 ' + unread + ' 条没看' : '看看有什么新消息') + '</span></button>' +
      '<button class="me-mi danger" data-me="logout" type="button"><b>退出登录</b><span>退出后可以换一个空间或个人账号</span></button>' +
      '</div>');
    $$('#modalBody .me-mi').forEach(b => b.addEventListener('click', () => {
      const k = b.dataset.me;
      if (k === 'logout') { closeModal(); signOut(); return; }
      if (k === 'ann') { closeModal(); openAnnouncements(); return; }
      closeModal(); switchView(k);
    }));
  }

  // ================= 对话 =================
  // 批次2 把这一块从"能聊"扩成"能干活"：消息级操作、附件、临时资料、
  // 联网搜索、AI 配图、断流恢复、侧栏与目录管理。
  const esc = s => HL.esc(s == null ? '' : s);

  /**
   * 拉左栏数据：项目 + 对话一起拉。
   * 项目现在是左栏的主轴，不能再像以前那样"用到才兜底拉一次" —— 项目没到位，分组就画不出来。
   */
  async function loadSide() {
    try {
      const qs = [];
      if (S.convQ) qs.push('q=' + encodeURIComponent(S.convQ));
      if (S.favOnly) qs.push('favorite=1');
      const [pr, cr] = await Promise.all([
        api('/api/projects').catch(() => ({ projects: [] })),
        api('/api/conversations' + (qs.length ? '?' + qs.join('&') : '')).catch(() => ({ conversations: [] })),
      ]);
      S.projects = pr.projects || [];
      S.convs = cr.conversations || [];
      renderSideTree();
    } catch (e) {}
  }

  /**
   * 左栏 = 项目树。
   *   项目（可展开/收起，带对话数）→ 它下面的对话
   *   未归入项目 → 散装对话，不会因为"没建项目"就没地方去
   * 搜索时只显示有命中的项目，避免结果里全是空壳。
   */
  function renderSideTree() {
    const box = $('#convList');
    const projects = S.projects || [];
    const convs = S.convs || [];
    const searching = !!(S.convQ || S.favOnly);

    const grouped = {};
    projects.forEach(p => { grouped[p.id] = []; });
    const loose = [];
    convs.forEach(c => {
      if (c.projectId && grouped[c.projectId]) grouped[c.projectId].push(c);
      else loose.push(c);
    });

    const convRow = c =>
      '<div class="conv-i' + (c.id === S.convId ? ' on' : '') + '" data-id="' + esc(c.id) + '">' +
      (c.isFavorite ? '<span class="ci-fav" title="已收藏">★</span>' : '') +
      '<span class="ci-t">' + esc(c.title || '新对话') + '</span>' +
      '<button class="ci-x" data-menu="' + esc(c.id) + '" type="button" title="重命名 / 移动 / 删除">⋯</button></div>';

    const group = (id, name, list, addTitle) => {
      const open = S.openProj[id] !== false;
      return '<div class="side-p' + (open ? ' open' : '') + '" data-proj="' + esc(id) + '">' +
        '<div class="sp-h" data-p="toggle">' +
        '<span class="sp-caret">' + (open ? '▾' : '▸') + '</span>' +
        '<span class="sp-n">' + esc(name) + '</span>' +
        '<span class="sp-c">' + list.length + '</span>' +
        '<button class="sp-add" data-p="newconv" type="button" title="' + esc(addTitle) + '">＋</button>' +
        (id === '__none__' ? '' : '<button class="sp-x" data-p="pmenu" type="button" title="编辑 / 删除项目">⋯</button>') +
        '</div>' +
        (open ? list.map(convRow).join('') : '') +
        '</div>';
    };

    const rows = [];
    projects.forEach(p => {
      const list = grouped[p.id] || [];
      if (searching && !list.length) return;
      rows.push(group(p.id, p.name, list, '在这个项目里新建对话'));
    });
    if (loose.length) rows.push(group('__none__', '未归入项目', loose, '直接开一个新对话'));

    if (!rows.length) {
      box.innerHTML = '<div class="side-empty">' +
        '<p>' + (searching ? '没有匹配的项目或对话' : '还没有项目') + '</p>' +
        (searching ? '' :
          '<p class="dim">项目 = 一组资料 + 一条学习指令，比如「这学期物理」。<br>不想建项目，也可以直接开问。</p>' +
          '<div class="se-acts">' +
          '<button class="btn sm" data-p="newproj" type="button">+ 新建项目</button>' +
          '<button class="btn ghost sm" data-p="newconv" type="button">直接开始问</button>' +
          '</div>') +
        '</div>';
      return;
    }
    box.innerHTML = rows.join('');
    // 顶栏标题跟着当前对话走：发完第一条消息后服务端会自动起标题，这里同步过来
    if (S.convId) {
      const cur = S.convs.filter(c => c.id === S.convId)[0];
      if (cur) $('#convTitle').textContent = cur.title || '新对话';
    }
  }

  /**
   * 空状态：学生第一次进来最怕的是"不知道能问什么"。
   * 四张卡不是菜单，是**四个起点** —— 给方向，不给选择题。
   *
   * 三个刻意的取舍：
   *   ① 点击只**预填**输入框，不直接发送 —— 学生可以先改成自己的话再发。
   *      直接发送等于替他决定了怎么问，而"把问题说清楚"本身就是学习的一部分。
   *   ② 四张卡全部走对话，**不做跨模块跳转**。新空间只解锁了对话/项目/资料/知识卡
   *      （批次7 的阶段门控），做一张"去背单词"的卡会直接撞上锁。
   *   ③ 文案是自己的，不对标站那四张（错题讲解/作文起步/英语单词/十万个为什么）。
   */
  const EMPTY_CARDS = [
    { k: 'wrong', t: '讲错题', d: '把题目发我，我先问你卡在哪一步', p: '这道题我做错了，但说不清错在哪：',
      i: '<path d="M4 14.5 3 19l4.5-1L18 7.5 14.5 4 4 14.5Z"/><path d="M13 5.5 16.5 9"/>' },
    { k: 'read', t: '读材料', d: '贴一段进来，我陪你把不懂的挖出来', p: '这段材料我读不太懂：',
      i: '<path d="M5 3h7l4 4v12a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z"/><path d="M12 3v4h4"/><path d="M7 12h8M7 15.5h5"/>' },
    { k: 'mem', t: '背下来', d: '要记的词或概念，报给我，我来考你', p: '帮我记住这几个：',
      i: '<path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H18v14H6.5A2.5 2.5 0 0 0 4 19.5V5.5Z"/><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H18v3H6.5A2.5 2.5 0 0 1 4 19.5Z"/>' },
    { k: 'why', t: '问个为什么', d: '任何想不通的现象，我们一起拆', p: '我想不通一件事：',
      i: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.5 15.5 4 4"/><path d="M8 9.5h5M10.5 7v5"/>' },
  ];

  /**
   * 视觉主体：后浪 + 嫩芽。
   * 用我们自己的意象（品牌是「后浪奔涌」，宠物是嫩芽→参天），
   * **不是**对标站那个贯穿全站的动漫少年 —— 那是它的品牌资产。
   * 纯 SVG 线条，零依赖、跟随主题色（var(--pri)）、可换色、<1KB。
   */
  const EMPTY_ART =
    '<circle cx="49" cy="50" r="2.5" fill="var(--pri)" opacity=".34"/>' +
    '<circle cx="119" cy="40" r="3" fill="var(--pri)" opacity=".26"/>' +
    '<circle cx="70" cy="24" r="2" fill="var(--pri)" opacity=".2"/>' +
    '<circle cx="99" cy="30" r="2.5" fill="var(--pri)" opacity=".3"/>' +
    '<path d="M84 113 C 81 93 87 75 84 53" stroke="var(--pri)" stroke-width="3" stroke-linecap="round"/>' +
    '<path d="M84 89 C 71 87 60 78 58 65 C 71 63 82 72 84 89 Z" fill="var(--pri)" opacity=".85"/>' +
    '<path d="M84 77 C 97 73 107 64 109 51 C 96 51 86 60 84 77 Z" fill="var(--pri)" opacity=".5"/>' +
    '<path d="M0 112 Q 42 96 84 112 T 168 112 L168 132 L0 132 Z" fill="var(--pri)" opacity=".1"/>' +
    '<path d="M0 122 Q 42 108 84 122 T 168 122 L168 132 L0 132 Z" fill="var(--pri)" opacity=".2"/>';

  function renderStreamEmpty() {
    const nm = (S.space && S.space.name) ? S.space.name : '';
    const cards = EMPTY_CARDS.map(c =>
      '<button class="ec" type="button" data-ec="' + c.k + '">' +
        '<span class="ec-i" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
          'stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">' + c.i + '</svg></span>' +
        '<b>' + HL.esc(c.t) + '</b><span class="ec-d">' + HL.esc(c.d) + '</span>' +
      '</button>').join('');
    $('#stream').innerHTML =
      '<div class="stream-in"><div class="empty" id="streamEmpty">' +
        '<svg class="empty-art" viewBox="0 0 168 132" fill="none" aria-hidden="true">' + EMPTY_ART + '</svg>' +
        '<h1 class="empty-hi">你好' + (nm ? '，' + HL.esc(nm) : '') + '</h1>' +
        '<p class="empty-ask">今天想弄明白什么？</p>' +
        '<p class="empty-stance">我不会直接给你答案 —— 先问你卡在哪一步，再陪你走完剩下那步。</p>' +
        '<div class="empty-cards" id="emptyCards">' + cards + '</div>' +
        '<div class="empty-tips">💡 在「知识库」上传资料 → 创建「项目」把资料归组 → 对话顶部选项目，自动引用资料作答</div>' +
      '</div></div>';
  }
  function streamIn() {
    let box = $('#stream').querySelector('.stream-in');
    if (!box) { $('#stream').innerHTML = '<div class="stream-in"></div>'; box = $('#stream').querySelector('.stream-in'); }
    return box;
  }
  function scrollBottom(force) {
    const st = $('#stream');
    const near = st.scrollHeight - st.scrollTop - st.clientHeight < 160;
    if (force || near) st.scrollTop = st.scrollHeight;
    updateJump();
  }
  function updateJump() {
    const st = $('#stream');
    const box = $('#jumpBtns');
    if (!box) return;
    const canUp = st.scrollTop > 240;
    const canDown = st.scrollHeight - st.scrollTop - st.clientHeight > 240;
    box.hidden = !(canUp || canDown);
    $('#jumpTop').disabled = !canUp;
    $('#jumpBottom').disabled = !canDown;
  }

  // ---------- 消息渲染 ----------
  /**
   * 附件渲染。分两段放（批次11）：
   *   phase='head' —— 正文**之前**：用户自己传的图片 / 文件，先看到"我在说什么"；
   *   phase='tail' —— 正文**之后**：AI 配的插画、互动课堂，先读完讲解再见图，和竞品一致。
   * data-ivt-open 仍按下标索引回 attachments，所以两段必须用同一个原始下标。
   */
  /**
   * 附件的直链。
   *
   * ★ 必须带 ?_t=：<img src> 是浏览器自己发的请求，**带不上 Authorization 头**，
   *   而后端 /api/files/:id 在鉴权闸门后面 —— 不带 token 一律 401，
   *   结果就是"图片一片空白，控制台一个 401"。查询串是反代唯一放行的地方
   *   （它会把 Authorization / x-token 头剥掉，见 server.js 的说明）。
   */
  function fileUrl(id) {
    return '/api/files/' + encodeURIComponent(id) + (S.token ? '?_t=' + encodeURIComponent(S.token) : '');
  }

  function msgAttachHTML(m, phase) {
    const want = phase === 'tail' ? 'tail' : 'head';
    const list = m.attachments || [];
    if (!list.length) return '';
    const items = [];
    list.forEach((a, i) => {
      const isTail = a.kind === 'illustration' || a.kind === 'interactive';
      if ((isTail ? 'tail' : 'head') !== want) return;
      if (a.kind === 'image') {
        items.push('<a class="msg-att-img" href="' + fileUrl(a.id) + '" target="_blank" rel="noopener" title="' + esc(a.name) + '">' +
          '<img src="' + fileUrl(a.id) + '" alt="' + esc(a.name) + '" loading="lazy"></a>');
        return;
      }
      if (a.kind === 'illustration') {
        // AI 自动配的矢量插画：svg-json 直接渲染成 SVG（白名单在 render.js / 服务端各拦一层）
        const svg = illuAttachHTML(a);
        if (svg) items.push(svg);
        return;
      }
      if (a.kind === 'interactive') {
        const d = a.dsl || {};
        items.push('<div class="msg-att-ivt">' +
          '<div class="ivt-ic" aria-hidden="true">◇</div>' +
          '<div class="ivt-txt"><b>互动课堂 · ' + esc(d.title || '可交互教具') + '</b>' +
          '<span class="dim">拖动、调参，自己把它玩明白</span></div>' +
          '<button class="btn sm primary" data-ivt-open="' + i + '" type="button">打开</button></div>');
        return;
      }
      items.push('<span class="msg-att-file">' + esc(a.name) + '</span>');
    });
    if (!items.length) return '';
    // data-phase 让"流式补图"能精确定位到正文之后那个盒子，而不是误往正文前的盒子里塞
    return '<div class="msg-atts" data-phase="' + want + '">' + items.join('') + '</div>';
  }

  // 「已读取链接 / 没读到链接」的提示条。
  // 流式时和刷新后都要画同一套东西，所以抽出来 —— 写两份文案迟早会走样。
  function linksHTML(lk) {
    if (!lk) return '';
    const pages = lk.pages || [];
    const errs = lk.errors || [];
    let out = '';
    if (pages.length) {
      out += '<div class="msg-net on">已读取 ' + pages.length + ' 个链接' +
        '<div class="net-list">' + pages.map(p => {
          // 图片直链没有标题，直接显示 URL 会被截断成没信息的一段开头 ——
          // 标一句"图片（已识别文字）"，学生才知道 AI 真的看了那张图。
          const label = p.image ? '图片（已识别文字）' : String(p.title || p.url);
          return '<a href="' + esc(p.url) + '" target="_blank" rel="noopener">' + esc(label.slice(0, 70)) + '</a>';
        }).join('') + '</div></div>';
    }
    if (errs.length) {
      out += '<div class="msg-net off">' + errs.length + ' 个链接没读到：' +
        esc(errs.map(x => x.message || '读取失败').join('；')) + '</div>';
    }
    return out;
  }

  function msgExtraHTML(m) {
    let out = '';
    const meta = m.meta || {};
    if (meta.webSearch) {
      out += meta.webSearch.ok && (meta.webSearch.results || []).length
        ? '<div class="msg-net on">联网搜索：找到 ' + meta.webSearch.results.length + ' 条网页' +
          '<div class="net-list">' + meta.webSearch.results.map((r, i) =>
            '<a href="' + esc(r.url) + '" target="_blank" rel="noopener">' + (i + 1) + '. ' + esc(r.title || r.url) + '</a>').join('') + '</div></div>'
        : '<div class="msg-net off">' + esc(meta.webSearch.message || '联网搜索暂时不可用，本条回答未联网') + '</div>';
    }
    out += linksHTML(meta.links);      // 学生发了链接 → 这里显示读没读到
    if (meta.sources && meta.sources.length) {
      out += '<div class="msg-src">引用了：' + meta.sources.map(s =>
        '<span class="src-chip" title="第 ' + (s.chunk + 1) + ' 段">' + esc(s.filename) + '</span>').join('') + '</div>';
    }
    if (m.translated) {
      Object.keys(m.translated).forEach(k => {
        const t = m.translated[k];
        if (!t || !t.text) return;
        out += '<div class="msg-tr" data-tr="' + esc(k) + '"><b>' + esc((CHAT_DIR[k] || k)) + '</b>' + HL.render(t.text) + '</div>';
      });
    }
    if (m.status === 'aborted') out += '<div class="msg-flag">（已停止生成，下面是已经生成的部分）</div>';
    if (m.status === 'streaming') out += '<div class="msg-flag">正在生成…</div>';
    if (m.status === 'error') out += '<div class="msg-flag bad">这条没有生成出内容</div>';
    return out;
  }

  const CHAT_DIR = { zh2en: '中 → 英', en2zh: '英 → 中' };

  function msgActionsHTML(m) {
    if (m.role === 'user') {
      return '<button class="btn ghost sm" data-a="copy" type="button">复制</button>' +
        '<button class="btn ghost sm" data-a="delete" type="button">删除消息</button>';
    }
    return '<button class="btn ghost sm" data-a="copy" type="button">复制</button>' +
      '<button class="btn ghost sm" data-a="speak" type="button">朗读这条回答</button>' +
      '<button class="btn ghost sm" data-a="translate" type="button">翻译</button>' +
      '<button class="btn ghost sm' + (m.isFavorite ? ' on' : '') + '" data-a="fav" type="button">' +
      (m.isFavorite ? '已收藏' : '收藏') + '</button>' +
      '<button class="btn ghost sm" data-a="cards" type="button">收成知识卡</button>' +
      '<button class="btn ghost sm" data-a="ivt" type="button">互动课堂</button>' +
      '<button class="btn ghost sm" data-a="regen" type="button">重新生成</button>' +
      '<button class="btn ghost sm" data-a="delete" type="button">删除消息</button>';
  }

  /** 按消息对象建 DOM。msgId 为空 = 正在生成中的临时节点 */
  function renderMsgEl(m) {
    const role = m.role === 'user' ? 'user' : 'ai';
    const e = $('#streamEmpty'); if (e) e.remove();
    const wrap = document.createElement('div');
    wrap.className = 'msg ' + role;
    if (m.id) wrap.dataset.mid = m.id;
    // 落款行：谁在说话 + 什么时候说的（用户消息不显示落款，与竞品一致）
    const metaHTML = role === 'user' ? ''
      : '<span class="who">小涌</span><span>只问不答' + (m.createdAt ? ' · ' + fmtTime(m.createdAt) : '') + '</span>';
    wrap.innerHTML = '<div class="av">' + (role === 'user' ? '我' : '涌') + '</div>' +
      '<div class="body">' +
      '<div class="meta">' + metaHTML + '</div>' +
      msgAttachHTML(m, 'head') +
      '<div class="md"></div>' +
      msgAttachHTML(m, 'tail') +
      msgExtraHTML(m) +
      '<div class="acts"></div>' +
      '</div>';
    wrap.querySelector('.md').innerHTML = HL.render(m.content || '');
    // 互动课堂附件：把"打开"按钮接到右侧面板
    const atts0 = m.attachments || [];
    wrap.querySelectorAll('[data-ivt-open]').forEach(btn => {
      const idx = Number(btn.getAttribute('data-ivt-open'));
      const att = atts0[idx];
      if (att && att.dsl) {
        btn.addEventListener('click', () => {
          HL.interactive.openInPanel(att.dsl, { title: att.dsl.title, jobId: att.jobId || null });
          wirePanelShare(att.jobId);
        });
      }
    });
    const obj = { id: m.id || '', el: wrap, body: wrap.querySelector('.md'), data: m };
    streamIn().appendChild(wrap);
    scrollBottom(true);
    return obj;
  }

  function appendMsg(role, content, extra) {
    return renderMsgEl(Object.assign({ role: role, content: content, status: 'done' }, extra || {}));
  }

  function refreshMsgActions(m) {
    const acts = m.el.querySelector('.acts');
    if (!acts) return;
    acts.innerHTML = msgActionsHTML(m.data);
    acts.classList.add('bound');
  }

  /** 计划卡 → 竖版海报 PNG。画图在 poster.js，这里只管取数据与触发下载 */
  function todayDash() {
    const d = new Date();
    const p = n => (n < 10 ? '0' : '') + n;
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }

  function savePlanPoster(btn) {
    if (btn.disabled) return;
    let spec = null;
    try { spec = JSON.parse(decodeURIComponent(btn.dataset.spec || '')); } catch (e) { spec = null; }
    if (!spec || !window.HL || typeof HL.planPoster !== 'function') { toast('这张图暂时生成不了'); return; }
    let cv = null;
    try { cv = HL.planPoster(spec, { date: todayDash() }); } catch (e) { cv = null; }
    if (!cv) { toast('计划内容太少，生成不了图片'); return; }
    btn.disabled = true;
    const old = btn.textContent;
    btn.textContent = '生成中…';
    // 文件名里不能有路径分隔符等非法字符，否则部分浏览器会静默失败
    const name = (String(spec.title || '学习计划').replace(/[\\/:*?"<>|]/g, '').slice(0, 20) || '学习计划')
      + '-' + todayDash() + '.png';
    cv.toBlob(blob => {
      btn.disabled = false; btn.textContent = old;
      if (!blob) { toast('图片生成失败'); return; }
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = name;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      toast('图片已生成');
    }, 'image/png');
  }

  // 消息是动态插入的（切会话 / 刷新回填），所以用事件委托绑一次就够
  document.addEventListener('click', ev => {
    const b = ev.target.closest && ev.target.closest('.plan-save');
    if (!b) return;
    ev.preventDefault();
    savePlanPoster(b);
  });

  function attachMsgActions(m) {
    refreshMsgActions(m);
    const acts = m.el.querySelector('.acts');
    if (!acts || acts._bound) return;
    acts._bound = true;
    acts.addEventListener('click', ev => {
      const b = ev.target.closest('[data-a]'); if (!b) return;
      msgAction(b.dataset.a, m, b);
    });
  }

  async function msgAction(a, m, btn) {
    const id = m.data.id;
    if (a === 'copy') { copyText(m.body.innerText); return; }
    if (a === 'delete') {
      if (!id) return;
      if (!confirm('确定删除这条消息吗？删除后将不再作为上下文发送给AI。')) return;
      try {
        await api('/api/messages/' + id, { method: 'DELETE' });
        m.el.remove(); toast('已删除');
      } catch (e) { toast(e.message); }
      return;
    }
    if (a === 'fav') {
      if (!id) return;
      try {
        const r = await api('/api/messages/' + id + '/favorite', { method: 'POST' });
        m.data.isFavorite = r.isFavorite;
        toast(r.isFavorite ? '已收藏' : '已取消收藏');
        refreshMsgActions(m);
      } catch (e) { toast(e.message); }
      return;
    }
    if (a === 'speak') {
      speakText(id, m.body.innerText, btn);
      return;
    }
    if (a === 'translate') {
      if (!id) return;
      const cur = m.el.querySelector('.msg-tr');
      if (cur) { cur.remove(); return; }        // 再点一次收起译文
      btn.disabled = true; const old = btn.textContent; btn.textContent = '翻译中…';
      try {
        const r = await api('/api/messages/' + id + '/translate', { method: 'POST', body: {} });
        const div = document.createElement('div');
        div.className = 'msg-tr';
        div.dataset.tr = r.direction;
        div.innerHTML = '<b>' + esc(r.label || CHAT_DIR[r.direction] || '') + (r.cached ? ' · 缓存' : '') + '</b>' + HL.render(r.text);
        m.el.querySelector('.acts').before(div);
        m.data.translated = m.data.translated || {};
        m.data.translated[r.direction] = { text: r.text, at: Date.now() };
      } catch (e) { toast(e.message); }
      btn.disabled = false; btn.textContent = old;
      return;
    }
    if (a === 'cards') {
      btn.disabled = true; const old = btn.textContent; btn.textContent = '正在提炼…';
      try {
        const r = await api('/api/cards/generate', { method: 'POST', body: { conversationId: S.convId, messageId: id, count: 3 } });
        toast(r.cards && r.cards.length ? '收下了 ' + r.cards.length + ' 张知识卡' : '这段对话里没找到值得记的知识点');
        await loadCardSummary();
      } catch (e) { toast(e.message); }
      btn.disabled = false; btn.textContent = old;
      return;
    }
    if (a === 'ivt') {
      makeInteractive(m, btn);
      return;
    }
    if (a === 'regen') {
      if (!id) return;
      if (!confirm('重新生成会发起一次新的模型请求并消耗相应额度，是否继续？')) return;
      await regenerate(id, m);
      return;
    }
  }

  // ---------- 朗读（TTS）----------
  let ttsVoice = null;
  function browserSpeak(text, rate) {
    if (!window.speechSynthesis) { toast('这个浏览器不支持朗读'); return false; }
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = /[\u4e00-\u9fa5]/.test(text) ? 'zh-CN' : 'en-US';
    u.rate = Math.min(2, Math.max(0.5, Number(rate) || 1));
    window.speechSynthesis.speak(u);
    return true;
  }
  function stopSpeak() {
    try { if (window.speechSynthesis) window.speechSynthesis.cancel(); } catch (e) {}
    if (ttsVoice) { try { ttsVoice.pause(); } catch (e) {} ttsVoice = null; }
    S.speaking = '';
    $$('.msg .acts [data-a="speak"]').forEach(b => { b.textContent = '朗读这条回答'; });
  }
  async function speakText(id, text, btn) {
    // 正在念同一条 → 再点就是停
    if (S.speaking === id) { stopSpeak(); return; }
    stopSpeak();
    const body = String(text || '').trim();
    if (!body) { toast('这条没有可以朗读的内容'); return; }
    if (body.length > S.tts.maxChars) {
      toast('一次最多朗读 ' + S.tts.maxChars + ' 字，这条有 ' + body.length + ' 字，请分段朗读');
      return;
    }
    S.speaking = id;
    if (btn) btn.textContent = '停止朗读';
    try {
      const r = id
        ? await api('/api/messages/' + id + '/speak', { method: 'POST', body: {} })
        : await api('/api/tts/speak', { method: 'POST', body: { text: body } });
      if (r.mode === 'audio' && r.audio) {
        ttsVoice = new Audio('data:' + (r.mime || 'audio/mpeg') + ';base64,' + r.audio);
        ttsVoice.onended = stopSpeak;
        ttsVoice.play().catch(() => { browserSpeak(body, r.rate); });
      } else if (r.mode === 'url' && r.url) {
        ttsVoice = new Audio(r.url);
        ttsVoice.onended = stopSpeak;
        ttsVoice.play().catch(() => { browserSpeak(body, r.rate); });
      } else {
        if (r.degraded && r.note) toast(r.note);
        if (!browserSpeak(body, r.rate)) { S.speaking = ''; if (btn) btn.textContent = '朗读这条回答'; return; }
        // 浏览器合成没有可靠的回调，用估时把按钮恢复回去
        const est = Math.max(2000, body.length * 220 / (Number(r.rate) || 1));
        setTimeout(() => { if (S.speaking === id) stopSpeak(); }, est);
      }
    } catch (e) {
      toast(e.message); S.speaking = ''; if (btn) btn.textContent = '朗读这条回答';
    }
  }

  // ---------- 发送（SSE 流式 + 断流恢复）----------
  let streamPaint = 0;
  let abortCtl = null;
  let currentReply = '';   // 正在生成的那条助手消息 id（"停止生成"要拿它去告诉服务端）

  async function ensureConv() {
    if (S.convId) return S.convId;
    const r = await api('/api/conversations', {
      method: 'POST',
      body: { model: S.model, agentId: S.agentId, webSearch: S.webSearch, projectId: S.pendingProjectId || undefined },
    });
    S.convId = r.conversation.id;
    S.pendingProjectId = null;
    await loadSide();
    return S.convId;
  }

  async function send() {
    const input = $('#input');
    const text = input.value.trim();
    if ((!text && !S.pending.length) || S.streaming) return;
    const atts = S.pending.slice();
    input.value = ''; autoGrow();
    S.pending = []; renderAttachPreview();

    const u = appendMsg('user', text, { attachments: atts.length ? atts : null });
    attachMsgActions(u);
    const a = renderMsgEl({ role: 'assistant', content: '', status: 'streaming' });
    // 消息里带了链接的话，服务端要先花几秒把页面抓下来才开始生成 ——
    // 这段时间干等会让人以为卡住了，所以把等待原因直接写出来。
    const hasLink = /https?:\/\/[^\s]+/i.test(text);
    a.body.innerHTML = '<span class="skel" style="display:inline-block;width:' + (hasLink ? 16 : 8) + 'em"></span>' +
      (hasLink ? '<div class="wait-hint">正在打开你发的链接…</div>' : '');
    a.el.querySelector('.acts').innerHTML = '';

    S.streaming = true;
    setComposerBusy(true);
    let acc = '';
    let replyId = '';
    let expectingArt = null;   // 服务端推了 art 事件 = 这条会有配图，画完才落库
    try {
      abortCtl = new AbortController();
      const res = await fetch('/api/chat/stream?_t=' + encodeURIComponent(S.token), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + S.token },
        signal: abortCtl.signal,
        body: JSON.stringify({
          text: text, conversationId: S.convId || undefined, mode: S.mode, model: S.model,
          agentId: S.agentId || undefined, webSearch: S.webSearch,
          // 新对话时把「待归入的项目」一起带上：会话是服务端在收到首条消息时才创建的，
          // 漏了这个字段就会 project_id=NULL 掉进「未归入项目」。
          // 已有对话（S.convId 存在）不用传，归属由「移动到项目」单独管。
          projectId: S.convId ? undefined : (S.pendingProjectId || undefined),
          skillIds: S.skillEnabled && S.skillEnabled.length ? S.skillEnabled : undefined,
          attachments: atts.length ? atts.map(x => ({ id: x.id, name: x.name, kind: x.kind, size: x.size, mime: x.mime })) : undefined,
          clientId: 'cl_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
        }),
      });
      if (!res.ok) {
        let j = {}; try { j = await res.json(); } catch (e) {}
        if (res.status === 401) { signOut(true); return; }
        throw new Error(j.message || ('服务返回 ' + res.status));
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      let errored = null;
      while (true) {
        const rd = await reader.read();
        if (rd.done) break;
        buf += dec.decode(rd.value, { stream: true });
        const parts = buf.split('\n\n');
        buf = parts.pop();
        for (const part of parts) {
          let ev = '', data = '';
          part.split('\n').forEach(l => {
            if (l.indexOf('event:') === 0) ev = l.slice(6).trim();
            else if (l.indexOf('data:') === 0) data += l.slice(5).trim();
          });
          if (!data) continue;
          let j; try { j = JSON.parse(data); } catch (e) { continue; }
          if (ev === 'meta') {
            // ★ 会话是**服务端**在收到首条消息时才创建的，所以这是"这条对话刚刚存在"的第一时刻。
            //   早先这里只记下 convId、不刷左栏，左栏要等 `finally` 里的 loadSide()
            //   —— 也就是**整段回答流完**之后才出现这条对话。
            //   真模型下一等十几秒，用户会以为"没建上"（实测：mock 模型下也要 14–16 秒）。
            //   只在"这条是新会话"时刷，避免每发一条消息都多两次请求。
            const isNewConv = !S.convId;
            S.convId = j.conversationId;
            S.pendingProjectId = null;   // 会话已带着项目建好，待归入意图用完即清
            if (isNewConv) loadSide();
            replyId = j.replyId || '';
            currentReply = replyId;
            a.data.id = replyId;
            if (j.webSearch) {
              const tag = (j.webSearch.ok && (j.webSearch.results || []).length)
                ? '联网搜索：找到 ' + j.webSearch.results.length + ' 条网页'
                : (j.webSearch.message || '联网搜索暂时不可用，本条回答未联网');
              a.el.querySelector('.acts').insertAdjacentHTML('beforebegin',
                '<div class="msg-net ' + (j.webSearch.ok && (j.webSearch.results || []).length ? 'on' : 'off') + '">' + esc(tag) + '</div>');
            }
            if (j.links) {
              const lh = linksHTML(j.links);
              if (lh) a.el.querySelector('.acts').insertAdjacentHTML('beforebegin', lh);
            }
          } else if (ev === 'delta') {
            acc += j.text || '';
            paintSoon(a, acc);
          } else if (ev === 'attachment') {
            // AI 自动配图到了：服务端已落库，这里原地补进气泡
            appendIllustration(a, j.attachment);
          } else if (ev === 'art') {
            // 服务端说"这条会配图"（画完才落库，比 done 晚几十秒）。
            // 只是先立个旗子，真正的等待放到 finally 里做，别卡住事件循环。
            expectingArt = j || { kind: 'svg' };
          } else if (ev === 'error') {
            errored = j.message || '未知错误';
          }
        }
      }
      // 没收到 done 事件就结束 = 连接断了。这时才需要走恢复流程。
      if (errored) {
        if (!acc) acc = '';
        a.el.querySelector('.acts').insertAdjacentHTML('beforebegin',
          '<div class="msg-flag bad">出错了：' + esc(errored) + '</div>');
      } else if (replyId) {
        acc = await syncReplyFromDb(replyId, a, acc);
      }
    } catch (e) {
      if (e && e.name === 'AbortError') {
        a.el.querySelector('.acts').insertAdjacentHTML('beforebegin', '<div class="msg-flag">已停止生成</div>');
        if (replyId) acc = await syncReplyFromDb(replyId, a, acc);
      } else {
        // 网络层断了（关 WiFi、切后台被系统掐掉）。占位行还在库里，
        // 拿 replyId 去 DB 把完整回复捞回来 —— 这就是"SSE 断流恢复"。
        const got = replyId ? await syncReplyFromDb(replyId, a, acc) : acc;
        if (got) acc = got;
        else a.el.querySelector('.acts').insertAdjacentHTML('beforebegin',
          '<div class="msg-flag bad">没能连上：' + esc(e.message) + '</div>');
      }
    } finally {
      cancelAnimationFrame(streamPaint);
      a.data.content = acc;
      a.body.innerHTML = HL.render(acc || '（没有返回内容）');
      attachMsgActions(a);
      S.streaming = false;
      abortCtl = null;
      currentReply = '';
      setComposerBusy(false);
      $('#input').focus();
      scrollBottom();
      loadSide();
      loadPet(true);
      // 画图是后台任务，SSE 早断了 —— 这里再盯一会儿，出图就原地补进去，
      // 不用学生自己刷新。没配图意图就一个字都不多问。
      if (expectingArt && replyId) watchArt(replyId, a);
    }
  }

  /**
   * 从 DB 把这条回复的最终内容同步回来。
   * 轮询到 status 变成终态（done/aborted/error）就停。最多等 60 秒 ——
   * 再久说明后端也出问题了，那就让用户看到已经拿到的部分，而不是无限转圈。
   */
  async function syncReplyFromDb(replyId, a, acc) {
    const base = String(acc || '');
    for (let i = 0; i < 60; i++) {
      let m = null;
      try { m = (await api('/api/messages/' + replyId)).message; } catch (e) { m = null; }
      if (m && ['done', 'aborted', 'error'].indexOf(m.status) >= 0) {
        if ((m.content || '').length > base.length) {
          a.data.content = m.content;
          a.body.innerHTML = HL.render(m.content);
          toast('SSE 断流恢复：已从 DB 拉到完整回复');
          return m.content;
        }
        return base;
      }
      await new Promise(r => setTimeout(r, 900));
    }
    return base;
  }

  function setComposerBusy(busy) {
    $('#send').disabled = busy;
    $('#stop').hidden = !busy;
  }
  /**
   * 停止生成 = 两件事，缺一不可：
   *   ① 告诉服务端"是我主动停的" —— 否则服务端把断开当成意外断流，会继续生成；
   *   ② 掐掉本地这条 SSE 连接。
   * 只做 ② 的话，点了停止后台还在跑；只做 ① 的话，本地还会傻等。
   */
  function stopStream() {
    const id = currentReply;
    if (id) api('/api/messages/' + id + '/stop', { method: 'POST' }).catch(() => {});
    if (abortCtl) { try { abortCtl.abort(); } catch (e) {} }
  }

  async function regenerate(replyId, m) {
    // 原地重生成：把这条的正文清空，重新接流
    m.data.content = '';
    m.body.innerHTML = '<span class="skel" style="display:inline-block;width:8em"></span>';
    S.streaming = true; setComposerBusy(true);
    let acc = '';
    let expectingArt = null;
    try {
      abortCtl = new AbortController();
      const res = await fetch('/api/messages/' + replyId + '/regenerate?_t=' + encodeURIComponent(S.token), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + S.token },
        signal: abortCtl.signal,
        body: JSON.stringify({ model: S.model, mode: S.mode }),
      });
      if (!res.ok) throw new Error('服务返回 ' + res.status);
      const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = ''; let rid = '';
      while (true) {
        const rd = await reader.read(); if (rd.done) break;
        buf += dec.decode(rd.value, { stream: true });
        const parts = buf.split('\n\n'); buf = parts.pop();
        for (const part of parts) {
          let ev = '', data = '';
          part.split('\n').forEach(l => {
            if (l.indexOf('event:') === 0) ev = l.slice(6).trim();
            else if (l.indexOf('data:') === 0) data += l.slice(5).trim();
          });
          if (!data) continue;
          let j; try { j = JSON.parse(data); } catch (e) { continue; }
          if (ev === 'meta') { rid = j.replyId || ''; currentReply = rid; }
          else if (ev === 'delta') { acc += j.text || ''; paintSoon(m, acc); }
          else if (ev === 'attachment') { appendIllustration(m, j.attachment); }
          else if (ev === 'art') { expectingArt = j || { kind: 'svg' }; }
        }
      }
      if (rid) acc = await syncReplyFromDb(rid, m, acc);
    } catch (e) {
      if (!acc) m.el.querySelector('.acts').insertAdjacentHTML('beforebegin', '<div class="msg-flag bad">重新生成失败：' + esc(e.message) + '</div>');
    } finally {
      cancelAnimationFrame(streamPaint);
      m.data.content = acc;
      m.body.innerHTML = HL.render(acc || '（没有返回内容）');
      m.data.id = m.data.id;              // 新消息 id 由下次打开对话时同步
      attachMsgActions(m);
      S.streaming = false; abortCtl = null; currentReply = ''; setComposerBusy(false);
      toast('已重新生成');
      // 重生成会换掉正文，配图也是新画的 —— 同样盯一会儿
      if (expectingArt && rid) watchArt(rid, m);
    }
  }

  function paintSoon(a, acc, now) {
    if (now) { a.body.innerHTML = HL.render(acc) + '<span class="caret"></span>'; scrollBottom(); return; }
    if (streamPaint) return;
    streamPaint = requestAnimationFrame(() => {
      streamPaint = 0;
      a.body.innerHTML = HL.render(acc) + '<span class="caret"></span>';
      scrollBottom();
    });
  }

  async function openConv(id) {
    try {
      S.pendingProjectId = null;   // 打开已有对话 = 放弃"待归入项目"的意图，别把它带进下一次创建
      const r = await api('/api/conversations/' + id);
      S.convId = id;
      const c = r.conversation;
      $('#convTitle').textContent = c.title || '新对话';
      $('#convSubText').textContent = convSubText(c);
      renderProjectSel(c.projectId || '');
      if (c.model) { S.model = c.model; $('#modelSel').value = S.model; }
      S.agentId = c.agentId || '';
      S.webSearch = !!c.webSearch;
      renderAgentBtn(); renderWebBtn();
      const box = streamIn();
      box.innerHTML = '';
      (r.messages || []).forEach(m => {
        const el = renderMsgEl(m);
        if (m.role !== 'user') attachMsgActions(el);
        else attachMsgActions(el);
      });
      if (!(r.messages || []).length) renderStreamEmpty();
      renderSideTree();
      switchView('chat');
      await loadTempDocs();
      scrollBottom(true);
      // 断流恢复：上次关页面时还在生成的那条，这次打开直接补完
      const stuck = (r.messages || []).filter(m => m.status === 'streaming');
      if (stuck.length) {
        const el = box.querySelector('[data-mid="' + stuck[stuck.length - 1].id + '"]');
        if (el) {
          const obj = { id: stuck[stuck.length - 1].id, el: el, body: el.querySelector('.md'), data: stuck[stuck.length - 1] };
          syncReplyFromDb(stuck[stuck.length - 1].id, obj, stuck[stuck.length - 1].content || '').then(txt => {
            obj.data.content = txt; obj.body.innerHTML = HL.render(txt || '（没有返回内容）');
            obj.el.querySelectorAll('.msg-flag').forEach(n => n.remove());
            attachMsgActions(obj);
          });
        }
      }
    } catch (e) { toast(e.message); }
  }

  function convSubText(c) {
    const bits = [];
    if (c.projectId) bits.push('项目：' + projName(c.projectId));
    if (c.agentId) bits.push('智能体：' + agentName(c.agentId));
    if (c.instructions) bits.push('已设指令');
    if (c.webSearch) bits.push('联网搜索已开');
    return bits.length ? bits.join(' · ') : '问吧，我不会直接给你答案';
  }

  /** 渲染对话顶部的项目选择器 */
  function renderProjectSel(currentId) {
    const sel = $('#projectSel');
    if (!sel) return;
    const opts = ['<option value="">📁 未选择项目</option>'];
    (S.projects || []).forEach(p => {
      opts.push('<option value="' + esc(p.id) + '"' + (p.id === currentId ? ' selected' : '') + '>📁 ' + esc(p.name) + '</option>');
    });
    opts.push('<option value="__new__">＋ 新建项目…</option>');
    sel.innerHTML = opts.join('');
  }

  function newConv(opts) {
    // 从项目视图「新建对话」进来：记住项目，第一条消息创建对话时归入该项目
    S.pendingProjectId = (opts && opts.projectId) || null;
    S.convId = '';
    S.agentId = ''; S.webSearch = false; S.pending = []; S.tempDocs = [];
    $('#convTitle').textContent = '新对话';
    $('#convSubText').textContent = S.pendingProjectId ? '新对话 · 将归入「' + projName(S.pendingProjectId) + '」' : '问吧，我不会直接给你答案';
    renderProjectSel(S.pendingProjectId || '');
    renderStreamEmpty();
    renderSideTree();
    renderAgentBtn(); renderWebBtn(); renderAttachPreview(); renderTempDocs();
    switchView('chat');
  }

  // ---------- 对话级设置：智能体 / 联网 / 指令 / 重命名 / 项目 ----------
  function agentName(id) {
    const a = (S.agents || []).filter(x => x.id === id)[0];
    return a ? a.name : id;
  }
  function renderAgentBtn() {
    const b = $('#agentBtn');
    if (!b) return;
    b.textContent = S.agentId ? ('智能体 · ' + agentName(S.agentId)) : '智能体';
    b.classList.toggle('on', !!S.agentId);
  }
  function renderWebBtn() {
    const b = $('#webBtn');
    if (!b) return;
    b.classList.toggle('on', !!S.webSearch);
    b.textContent = S.webSearch ? '联网搜索 · 开' : '联网搜索';
  }
  async function loadAgents() {
    try {
      const r = await api('/api/agents');
      S.agents = r.agents || [];
      renderAgentBtn();
    } catch (e) {}
  }
  function openAgents() {
    const list = S.agents || [];
    openModal('选择 AI 助手',
      '<div class="field"><input class="inp" id="agQ" placeholder="搜索名称或关键词，例如：数学、作文"></div>' +
      '<div class="ag-list" id="agList"></div>');
    const paint = q => {
      const k = String(q || '').trim().toLowerCase();
      const rows = k ? list.filter(a => (a.name + a.description + a.subject).toLowerCase().indexOf(k) >= 0) : list;
      $('#agList').innerHTML = '<button class="ag-i' + (!S.agentId ? ' on' : '') + '" data-ag="" type="button">' +
        '<b>全部智能体</b><span>不指定，由我按你的问题自己判断</span></button>' +
        rows.map(a => '<button class="ag-i' + (S.agentId === a.id ? ' on' : '') + '" data-ag="' + esc(a.id) + '" type="button">' +
          '<b>' + esc(a.name) + (a.enabled ? '' : ' <i class="dim">未开启</i>') + '</b><span>' + esc(a.description || '') + '</span></button>').join('') ||
        '<div class="dim" style="padding:10px">没找到匹配的智能体</div>';
    };
    paint('');
    $('#agQ').addEventListener('input', debounce(e => paint(e.target.value), 160));
    $('#agList').addEventListener('click', async ev => {
      const b = ev.target.closest('[data-ag]'); if (!b) return;
      S.agentId = b.dataset.ag || '';
      renderAgentBtn();
      if (S.convId) {
        try { await api('/api/conversations/' + S.convId, { method: 'PATCH', body: { agentId: S.agentId } }); } catch (e) {}
      }
      $('#convSub').textContent = S.agentId ? ('智能体：' + agentName(S.agentId)) : '问吧，我不会直接给你答案';
      toast(S.agentId ? ('已选「' + agentName(S.agentId) + '」') : '已切回全部智能体');
      closeModal();
    });
  }

  async function toggleWeb() {
    S.webSearch = !S.webSearch;
    renderWebBtn();
    if (S.convId) {
      try { await api('/api/conversations/' + S.convId, { method: 'PATCH', body: { webSearch: S.webSearch } }); } catch (e) {}
    }
    toast(S.webSearch ? '开启联网搜索：适合查最新资讯' : '已关闭联网搜索');
  }

  function openConvMenu() {
    if (!S.convId) { toast('先聊两句，或从左侧选一条对话'); return; }
    const c = S.convs.filter(x => x.id === S.convId)[0] || {};
    openModal('对话设置',
      '<div class="cm-list">' +
      '<button class="cm-i" data-cm="rename" type="button"><b>重命名对话</b><span>' + esc(c.title || '新对话') + '</span></button>' +
      '<button class="cm-i" data-cm="instr" type="button"><b>设置指令</b><span>' + (c.instructions ? '已设置，点开修改' : '给这条对话一条只对它生效的指令') + '</span></button>' +
      '<button class="cm-i" data-cm="move" type="button"><b>移动到项目</b><span>' + (c.projectId ? '当前：' + projName(c.projectId) : '还没放进任何项目') + '</span></button>' +
      '<button class="cm-i" data-cm="fav" type="button"><b>' + (c.isFavorite ? '取消收藏' : '收藏这条对话') + '</b><span>收藏后在侧栏点 ★ 能快速找到</span></button>' +
      '<button class="cm-i" data-cm="share" type="button"><b>分享管理</b><span>创建链接 / 停止分享 / 看访问次数</span></button>' +
      '<button class="cm-i danger" data-cm="del" type="button"><b>删除对话</b><span>消息与临时资料一起删除</span></button>' +
      '</div>');
  }

  /** 对话菜单的动作 —— 由 bindApp 里的全局委托调用（见 openModal 的注释） */
  async function convMenuAction(k) {
    if (!S.convId) return;
    const c = S.convs.filter(x => x.id === S.convId)[0] || {};
    if (k === 'rename') return openRename();
    if (k === 'instr') return openInstructions();
    if (k === 'move') return openMoveProject();
    if (k === 'share') return openShareMgr();
    if (k === 'fav') {
      try {
        await api('/api/conversations/' + S.convId, { method: 'PATCH', body: { isFavorite: !c.isFavorite } });
        closeModal(); loadSide(); toast(c.isFavorite ? '已取消收藏' : '已收藏');
      } catch (e) { toast(e.message); }
      return;
    }
    if (k === 'del') {
      if (!confirm('确定删除这条对话吗？消息和它的临时资料会一起删掉。')) return;
      try {
        await api('/api/conversations/' + S.convId, { method: 'DELETE' });
        closeModal(); newConv(); loadSide(); toast('已删除');
      } catch (e) { toast(e.message); }
    }
  }

  function projName(id) {
    const p = (S.projects || []).filter(x => x.id === id)[0];
    return p ? p.name : '某个项目';
  }

  function openRename() {
    const c = S.convs.filter(x => x.id === S.convId)[0] || {};
    openModal('重命名对话',
      '<div class="field"><label>对话名称</label><input id="rnT" maxlength="60" value="' + esc(c.title || '') + '"></div>' +
      '<div class="pc-acts"><button class="btn primary" id="rnGo" type="button">保存</button></div>');
    $('#rnGo').addEventListener('click', async () => {
      const t = $('#rnT').value.trim();
      if (!t) { toast('名字不能为空'); return; }
      try {
        await api('/api/conversations/' + S.convId, { method: 'PATCH', body: { title: t } });
        $('#convTitle').textContent = t;
        closeModal(); loadSide(); toast('重命名成功');
      } catch (e) { toast(e.message); }
    });
  }

  function openInstructions() {
    const c = S.convs.filter(x => x.id === S.convId)[0] || {};
    openModal('设置指令',
      '<p class="dim" style="margin-top:0">这条指令只对当前对话生效。比如「只用提问，不要给结论」「每句话都举一个生活里的例子」。</p>' +
      '<div class="field"><textarea id="inT" rows="4" maxlength="2000" placeholder="比如：讲题时先问我这一步为什么这么想">' + esc(c.instructions || '') + '</textarea></div>' +
      '<div class="pc-acts"><button class="btn primary" id="inGo" type="button">保存</button>' +
      '<span class="sp"></span><button class="btn ghost sm" id="inClr" type="button">清空</button></div>');
    $('#inGo').addEventListener('click', async () => {
      try {
        await api('/api/conversations/' + S.convId, { method: 'PATCH', body: { instructions: $('#inT').value } });
        closeModal(); loadSide(); toast('自定义指令已保存');
      } catch (e) { toast(e.message); }
    });
    $('#inClr').addEventListener('click', () => { $('#inT').value = ''; });
  }

  async function openMoveProject() {
    if (!S.projects.length) await loadProjects();
    const c = S.convs.filter(x => x.id === S.convId)[0] || {};
    openModal('移动到项目',
      '<div class="ag-list">' +
      '<button class="ag-i' + (!c.projectId ? ' on' : '') + '" data-pj="" type="button"><b>不放进项目</b><span>移出项目</span></button>' +
      (S.projects || []).map(p => '<button class="ag-i' + (c.projectId === p.id ? ' on' : '') + '" data-pj="' + esc(p.id) + '" type="button">' +
        '<b>' + esc(p.name) + '</b><span>' + (p.conversationCount || 0) + ' 条对话 · ' + (p.docs || []).length + ' 份资料</span></button>').join('') +
      '</div>');
  }

  async function moveToProjectAction(pid) {
    if (!S.convId) return;
    try {
      await api('/api/conversations/' + S.convId, { method: 'PATCH', body: { projectId: pid || null } });
      closeModal(); loadSide();
      toast(pid ? '已移动到项目' : '已移出项目');
    } catch (e) { toast(e.message); }
  }

  async function openShareMgr() {
    try {
      const r = await api('/api/conversations/' + S.convId + '/share');
      const s = r.share || {};
      openModal('分享管理',
        s.active
          ? '<p class="dim" style="margin-top:0">任何人拿到这个链接都能看，不需要登录。访问次数：<b>' + (s.views || 0) + '</b></p>' +
            '<div class="field"><input id="shUrl" readonly value="' + esc(location.origin + '/s/' + s.token) + '"></div>' +
            '<div class="pc-acts"><button class="btn primary" id="shCopy" type="button">复制链接</button>' +
            '<span class="sp"></span><button class="btn danger sm" id="shStop" type="button">停止分享</button></div>'
          : '<p class="dim" style="margin-top:0">这条对话还没有分享链接。</p>' +
            '<div class="pc-acts"><button class="btn primary" id="shMake" type="button">创建分享链接</button></div>');
      if (s.active) {
        $('#shCopy').addEventListener('click', () => copyText($('#shUrl').value));
        $('#shStop').addEventListener('click', async () => {
          if (!confirm('确定要取消分享吗？取消后这个链接立刻失效。')) return;
          await api('/api/conversations/' + S.convId + '/share', { method: 'DELETE' });
          toast('已停止分享'); closeModal();
        });
      } else {
        $('#shMake').addEventListener('click', async () => {
          const rr = await api('/api/conversations/' + S.convId + '/share', { method: 'POST' });
          copyText(location.origin + '/s/' + rr.share.token);
          toast('分享链接已创建并复制');
          openShareMgr();
        });
      }
    } catch (e) { toast(e.message); }
  }

  // ================= 互动课堂（批次4）=================
  /** 把面板里的"分享"按钮接上：仅当这条互动课堂带 jobId（能定位到分享目标）时才显示 */
  function wirePanelShare(jobId) {
    if (!jobId) return;
    const panel = document.getElementById('ivPanel');
    if (!panel) return;
    let sb = panel.querySelector('#ivShare');
    if (!sb) {
      sb = document.createElement('button');
      sb.id = 'ivShare'; sb.className = 'btn ghost sm'; sb.type = 'button'; sb.textContent = '分享';
      const h = panel.querySelector('.iv-h');
      if (h) h.insertBefore(sb, panel.querySelector('#ivClose'));
    }
    sb.onclick = () => shareInteractive(jobId);
  }
  async function shareInteractive(jobId) {
    try {
      const r = await api('/api/interactive/' + jobId + '/share', { method: 'POST' });
      const token = r.share && r.share.token;
      if (!token) { toast('分享链接创建失败'); return; }
      const url = location.origin + '/s/' + token;
      copyText(url);
      toast('分享链接已复制：' + url);
    } catch (e) { toast(e.message); }
  }
  /** 收集"触发这条回复的上一条用户消息 + 这条助手回复"，作为生成互动课堂的上下文 */
  function collectInteractiveText(mEl) {
    const all = Array.from(document.querySelectorAll('#stream .stream-in .msg'));
    const idx = all.indexOf(mEl);
    let text = '';
    if (idx > 0) {
      const prev = all[idx - 1];
      if (prev.classList.contains('user')) {
        const md = prev.querySelector('.md');
        if (md) text += '学生：' + md.innerText + '\n\n';
      }
    }
    const md = mEl.querySelector('.md');
    if (md) text += 'AI：' + md.innerText;
    return text.slice(0, 4000);
  }
  /** 轮询异步生成的互动课堂任务，最多约 28 秒 */
  async function pollInteractiveJob(jobId) {
    for (let i = 0; i < 40; i++) {
      let j = null;
      try { const r = await api('/api/jobs/' + jobId); j = r.job; } catch (e) {}
      if (j && (j.status === 'done' || j.status === 'error')) return j.result || null;
      await new Promise(r => setTimeout(r, 700));
    }
    return null;
  }
  async function makeInteractive(m, btn) {
    const id = m.data.id;
    if (!id) { toast('这条回复还没存下来，发完再试'); return; }
    const convText = collectInteractiveText(m.el);
    if (btn) { btn.disabled = true; var old = btn.textContent; btn.textContent = '生成中…'; }
    try {
      const r = await api('/api/interactive/generate', { method: 'POST', body: { conversationId: S.convId, messageId: id, text: convText } });
      const dsl = await pollInteractiveJob(r.jobId);
      if (dsl) {
        HL.interactive.openInPanel(dsl, { title: dsl.title, jobId: r.jobId });
        wirePanelShare(r.jobId);
        toast('互动课堂已生成，并挂到这条回复下');
      } else {
        toast('互动课堂没生成出来（' + (r.error || '试试换个说法') + '）');
      }
    } catch (e) { toast(e.message); }
    if (btn) { btn.disabled = false; btn.textContent = old; }
  }

  function openTtsSettings() {
    openModal('朗读设置',
      '<p class="dim" style="margin-top:0">一次最多朗读 ' + S.tts.maxChars + ' 字。</p>' +
      '<div class="field"><label>语速：<b id="ttsVal">' + S.tts.rate + '</b> 倍</label>' +
      '<input type="range" id="ttsRate" min="0.5" max="2" step="0.1" value="' + S.tts.rate + '" style="width:100%"></div>' +
      '<div class="pc-acts"><button class="btn primary" id="ttsGo" type="button">保存</button>' +
      '<span class="sp"></span><button class="btn ghost sm" id="ttsTry" type="button">试听一句</button></div>');
    $('#ttsRate').addEventListener('input', e => { $('#ttsVal').textContent = e.target.value; });
    $('#ttsTry').addEventListener('click', () => {
      browserSpeak('这句话用来试一下语速，你觉得快慢合适吗？', Number($('#ttsRate').value));
    });
    $('#ttsGo').addEventListener('click', async () => {
      const rate = Number($('#ttsRate').value);
      try {
        const r = await api('/api/tts/settings', { method: 'POST', body: { rate: rate } });
        S.tts.rate = r.settings.rate;
        toast('语速已保存');
        closeModal();
      } catch (e) { toast(e.message || '获取语速设置失败'); }
    });
  }

  // ---------- 附件（图片）----------
  function renderAttachPreview() {
    const box = $('#attachPreview');
    if (!box) return;
    if (!S.pending.length) { box.hidden = true; box.innerHTML = ''; return; }
    box.hidden = false;
    box.innerHTML = S.pending.map((a, i) =>
      '<span class="att-chip"><img src="' + fileUrl(a.id) + '" alt=""><b>' + esc(a.name) + '</b>' +
      '<i>' + Math.round(a.size / 1024) + 'KB</i><button data-rm="' + i + '" type="button" title="移除">×</button></span>').join('');
  }

  async function pickAttach(files) {
    if (!files || !files.length) return;
    const imgs = [], docs = [];
    for (const f of files) {
      if (/^image\//.test(f.type) || /\.(png|jpe?g|gif|webp|bmp)$/i.test(f.name)) imgs.push(f);
      else docs.push(f);
    }
    if (imgs.length) {
      const payload = [];
      for (const f of imgs.slice(0, 6)) {
        if (f.size > 10 * 1024 * 1024) { toast('图片 ' + f.name + ' 大小超过 10MB，已跳过'); continue; }
        payload.push({ filename: f.name, dataBase64: await fileToBase64(f) });
      }
      if (payload.length) {
        try {
          const r = await api('/api/upload/image', { method: 'POST', body: { files: payload } });
          (r.images || []).forEach(x => S.pending.push(x));
          (r.skipped || []).forEach(x => toast(x.reason));
          renderAttachPreview();
          toast('已加入 ' + (r.images || []).length + ' 张图片');
        } catch (e) { toast(e.message); }
      }
    }
    if (docs.length) {
      const cid = await ensureConv();
      const payload = [];
      for (const f of docs.slice(0, 6)) {
        if (f.size > 24 * 1024 * 1024) { toast(f.name + ' 超过 24MB，已跳过'); continue; }
        payload.push({ filename: f.name, dataBase64: await fileToBase64(f) });
      }
      if (!payload.length) return;
      toast('文档正在解析中，请稍候...');
      try {
        const r = await api('/api/conversations/' + cid + '/temp-documents', { method: 'POST', body: { files: payload } });
        (r.skipped || []).forEach(x => toast(x.reason));
        await loadTempDocs();
        const ids = (r.documents || []).map(d => d.id);
        if (ids.length) pollTempDocs(cid, ids);
      } catch (e) { toast(e.message); }
    }
  }

  function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result).replace(/^data:[^;]+;base64,/, ''));
      fr.onerror = () => reject(new Error('读不到这个文件'));
      fr.readAsDataURL(file);
    });
  }

  // ---------- 对话级临时资料 ----------
  async function loadTempDocs() {
    if (!S.convId) { S.tempDocs = []; renderTempDocs(); return; }
    try {
      const r = await api('/api/conversations/' + S.convId + '/temp-documents');
      S.tempDocs = r.documents || [];
      renderTempDocs();
    } catch (e) { S.tempDocs = []; renderTempDocs(); }
  }
  function renderTempDocs() {
    const box = $('#tempDocs');
    if (!box) return;
    if (!S.tempDocs.length) { box.hidden = true; box.innerHTML = ''; return; }
    box.hidden = false;
    box.innerHTML = '<span class="td-label">本次对话的资料</span>' + S.tempDocs.map(d =>
      '<span class="td-chip' + (d.status === 'failed' ? ' bad' : '') + '" data-id="' + esc(d.id) + '" title="' +
      (d.status === 'parsing' ? 'AI 正在识别文字' + (d.progress ? ' · ' + d.progress + '%' : '') : (d.error || d.filename)) + '">' +
      esc(d.filename) +
      (d.status === 'parsing' ? (d.progress ? ' · 识别中 ' + d.progress + '%' : ' · 识别中') : '') +
      (d.status === 'failed' ? ' · 解析失败' : '') +
      '<button data-td="' + esc(d.id) + '" type="button" title="移除">×</button></span>').join('') +
      '<span class="td-note">聊完随对话一起删除，不会进正式资料库</span>';
  }
  const tdSleep = ms => new Promise(r => setTimeout(r, ms));
  /**
   * 轮询临时资料状态。
   * ★ 原来是「连打 40 次、中间不等待」—— 对扫描件识别（几分钟起）根本不够用，
   *   而且会在资料还没就绪时就弹「资料已就绪」。改成按**时间**给截止（默认 15 分钟）、
   *   每 2 秒看一次，并且只在真的全部就绪（或确实失败）时才提示。
   */
  async function pollTempDocs(cid, ids, deadline) {
    const until = deadline || (Date.now() + 15 * 60 * 1000);
    try {
      const r = await api('/api/conversations/' + cid + '/temp-documents/status', { method: 'POST', body: { ids: ids } });
      const st = r.status || {};
      const pending = ids.filter(id => st[id] && (st[id].status === 'parsing' || st[id].status === 'pending'));
      if (cid === S.convId) {
        S.tempDocs = S.tempDocs.map(d => (st[d.id] ? Object.assign({}, d, st[d.id]) : d));
        renderTempDocs();
      }
      if (!pending.length) {
        const bad = ids.filter(id => st[id] && st[id].status === 'failed');
        if (cid === S.convId) {
          toast(bad.length ? '有资料没能识别出文字，可移除后重传' : '资料已就绪，可以开始问了');
        }
        return;
      }
      if (Date.now() > until) {
        if (cid === S.convId) toast('资料还在识别中，识别完就能用了');
        return;
      }
      await tdSleep(2000);
      return pollTempDocs(cid, ids, until);
    } catch (e) {
      if (Date.now() > until) { toast('临时文档状态查询失败，稍后会自动重试'); return; }
      await tdSleep(3000);
      return pollTempDocs(cid, ids, until);
    }
  }

  // ---------- AI 配图 ----------
  // 手动"配图"按钮已移除：公告说的配图是 AI 在对话流里**自动**边讲边画（服务端
  // streamReply 按 shouldIllustrate 启发式挂 kind:'illustration' 附件，前端见下方
  // appendIllustration / msgAttachHTML 的 illustration 分支）。/api/chat/image 保留为
  // 服务端入口（后续"主动出题配图"用），前端不再有触发按钮。
  function illuAttachHTML(att) {
    // plan 模式 = 计划卡：服务端只抽了结构化数据（天数 / 主题 / 要点），
    // 排版全交给 render.js 的模板 —— 中文一定是对的，版式也不会走样。
    // （AI 生图写不对中文；让模型自由画 SVG 则会画成一张只有标题的空壳。）
    if (att && att.mode === 'plan' && att.plan) {
      const html = HL.planCard(att.plan);
      if (html) return '<div class="msg-att-illu art-plan-wrap">' + html + '</div>';
    }
    // raster 模式 = AI 生图（规划 / 总结 / 计划类的场景插画）。
    // 画完就存成了一个空间文件，这里跟普通图片一样直接指向 /api/files/<id>，
    // 刷新、换设备都还在 —— 不要再把 base64 塞进消息体里。
    if (att && att.mode === 'raster' && att.fileId) {
      return '<div class="msg-att-illu art-ai">' +
        '<img src="' + fileUrl(att.fileId) + '" alt="' + esc(att.title || 'AI 配图') + '" loading="lazy">' +
        '<span class="illu-cap">AI 插画' + (att.title ? ' · ' + esc(att.title) : '') + '</span></div>';
    }
    const svg = HL.svgFromJSON(att);
    if (!svg) return '';
    return '<div class="msg-att-illu">' + svg + '</div>';
  }
  /** 流式过程中服务端推来一张自动配图：挂进数据 + 原地补渲染 */
  function appendIllustration(a, att) {
    if (!a || !att) return;
    if (!a.data.attachments) a.data.attachments = [];
    a.data.attachments.push(att);
    // 插画挂在**正文之后**（body 段），与静态渲染的 tail 位置一致
    let box = a.el.querySelector('.msg-atts[data-phase="tail"]');
    if (!box) {
      const body = a.el.querySelector('.body');
      const md = a.el.querySelector('.md');
      box = document.createElement('div');
      box.className = 'msg-atts';
      box.setAttribute('data-phase', 'tail');
      if (md && md.parentNode === body) md.insertAdjacentElement('afterend', box);
      else if (body) body.appendChild(box);
    }
    const html = illuAttachHTML(att);
    if (html) {
      box.insertAdjacentHTML('beforeend', html);
      scrollBottom();
    }
  }

  /**
   * 等后台画的那张图。
   *
   * 服务端在 SSE 里先推一条 `art` 事件（"这条会配图"），画完再落库 ——
   * 中间隔着几十秒（AI 生图约 20-40 秒，加上排队更久），SSE 早关了。
   * 所以这里按消息轮询，一旦附件数比本地多，就把新的补进气泡。
   *
   * 只在这条消息**确实要配图**时才会被调用（服务器说了才等），
   * 普通对话一次都不会触发，不浪费请求。
   * 上限 40 × 4 秒 = 160 秒；AI 生图实测 20-40 秒，留足余量。
   */
  async function watchArt(replyId, a) {
    if (!replyId || !a) return;
    if (!a.data.attachments) a.data.attachments = [];
    for (let i = 0; i < 40; i++) {
      await new Promise(r => setTimeout(r, 4000));
      if (!a.el || !a.el.isConnected) return;         // 学生已经翻到别的对话了，别再轮询
      let m = null;
      try { m = (await api('/api/messages/' + replyId)).message; } catch (e) { continue; }
      if (!m) continue;
      const list = m.attachments || [];
      if (list.length > a.data.attachments.length) {
        for (let k = a.data.attachments.length; k < list.length; k++) appendIllustration(a, list[k]);
        return;
      }
    }
  }

  // ---------- 侧栏 / 目录宽度 / 快速滚动 ----------
  function toggleSide() {
    S.sideCollapsed = !S.sideCollapsed;
    $('#app').classList.toggle('side-min', S.sideCollapsed);
    $('#sideToggle').textContent = S.sideCollapsed ? '⇥' : '⇤';
    $('#sideToggle').title = S.sideCollapsed ? '展开菜单' : '收起菜单（只留图标）';
    try { localStorage.setItem('hl_side_min', S.sideCollapsed ? '1' : ''); } catch (e) {}
  }

  function bindResizer() {
    const rz = $('#sideResizer');
    if (!rz) return;
    const KEY = 'hl_side_w';
    const saved = Number(localStorage.getItem(KEY) || 0);
    if (saved >= 180 && saved <= 460) document.documentElement.style.setProperty('--side-w', saved + 'px');
    let dragging = false;
    const onMove = e => {
      if (!dragging) return;
      const x = (e.touches ? e.touches[0].clientX : e.clientX);
      const w = Math.min(460, Math.max(180, x));
      document.documentElement.style.setProperty('--side-w', w + 'px');
    };
    const onUp = () => {
      if (!dragging) return;
      dragging = false;
      document.body.classList.remove('resizing');
      const w = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--side-w'), 10);
      if (w) { try { localStorage.setItem(KEY, String(w)); } catch (e) {} }
    };
    const onDown = e => { dragging = true; document.body.classList.add('resizing'); e.preventDefault(); };
    rz.addEventListener('mousedown', onDown);
    rz.addEventListener('touchstart', onDown, { passive: false });
    window.addEventListener('mousemove', onMove);
    window.addEventListener('touchmove', onMove, { passive: false });
    window.addEventListener('mouseup', onUp);
    window.addEventListener('touchend', onUp);
  }

  // ================= 知识卡 =================
  async function loadCardSummary() {
    try {
      const r = await api('/api/cards/summary');
      S.stats = r;
      const due = r.due || 0;
      const nav = $('#navDue');
      nav.hidden = due <= 0;
      nav.textContent = due;
    } catch (e) {}
  }
  async function loadCards() {
    // 先给骨架屏：汇总要等一次请求，不给骨架会看到一瞬间的空白统计条
    if (!S.stats) $('#cardStats').innerHTML = '<div class="skel" style="height:52px;flex:1;min-width:78px"></div>';
    if (!S.cards.items.length) {
      $('#cardList').innerHTML = '<div class="skel" style="height:74px"></div><div class="skel" style="height:74px"></div><div class="skel" style="height:74px"></div>';
    }
    try {
      const q = '/api/cards?status=' + encodeURIComponent(S.cardQ.status) +
        '&sort=' + encodeURIComponent(S.cardQ.sort) +
        '&q=' + encodeURIComponent(S.cardQ.q) +
        '&page=' + S.cards.page + '&pageSize=' + S.cards.pageSize;
      const r = await api(q);
      S.cards = r;
      // 先拿汇总再画统计条：否则首屏渲染时 S.stats 还是空的，六个数全是 0
      await loadCardSummary();
      renderCardStats();
      renderCardList();
      renderCardPager();
      loadCardQuota();
    } catch (e) { toast(e.message); }
  }
  function renderCardStats() {
    const s = S.stats || {};
    const defs = [
      { k: 'due', label: '今日待练', cls: 'hot' },
      { k: 'learning', label: '学习中' },
      { k: 'almost', label: '快记住了' },
      { k: 'mastered', label: '已掌握', cls: 'done' },
      { k: 'retired', label: '无需再复习' },
      { k: 'total', label: '全部' },
    ];
    $('#cardStats').innerHTML = defs.map(d =>
      '<div class="st ' + (d.cls || '') + (S.cardQ.status === d.k ? ' on' : '') + '" data-st="' + d.k + '">' +
      '<b>' + (s[d.k] || 0) + '</b><span>' + d.label + '</span></div>').join('');
  }
  function renderCardList() {
    const box = $('#cardList');
    if (!S.cards.items.length) {
      box.innerHTML = '<div class="empty" style="padding:8vh 20px"><p>这里还是空的。</p>' +
        '<p class="dim">在对话里说「把这些收成知识卡」，或者点消息下面的「收成知识卡」。</p></div>';
      return;
    }
    const just = S.justCard;
    box.innerHTML = S.cards.items.map(c =>
      '<div class="kcard' + (c.overdue ? ' due' : '') + '" data-id="' + c.id + '">' +
      '<div class="kc-top"><span class="kc-k">' + HL.esc(c.knowledge) + '</span>' +
      // 刚练过的那张，状态 chip 呼吸一次 —— 让"变的是这里"被看见，
      // 而不是练完之后整页重新渲染、用户找不到刚才那张卡
      '<span class="chip ' + c.status + (c.id === just ? ' just' : '') + '">' + HL.esc(c.statusLabel) + '</span>' +
      '<span class="chip t-' + c.type + '">' + ({ choice: '选择题', spelling: '拼写', understanding: '理解题' }[c.type] || c.type) + '</span>' +
      '</div>' +
      (c.question ? '<div class="kc-q">' + HL.esc(c.question) + '</div>' : '') +
      '<div class="kc-foot"><span>' + (c.overdue ? '<b style="color:var(--warn)">该练了</b>' : fmtDue(c.dueAt)) + '</span>' +
      '<span>· 练过 ' + c.reviewCount + ' 次</span>' +
      (c.lastResult ? '<span>· 上次' + ({ right: '答对', wrong: '没答对', unknown: '没判断' }[c.lastResult] || '') + '</span>' : '') +
      '<span class="sp"></span>' +
      '<button class="btn sm primary" data-do="practice" type="button">开始练习</button>' +
      '<button class="btn ghost sm" data-do="del" type="button">删除</button>' +
      '</div></div>').join('');
    S.justCard = '';
  }
  function renderCardPager() {
    const p = $('#cardPager');
    if (!S.cards.pages || S.cards.pages <= 1) { p.innerHTML = ''; return; }
    let h = '<button data-pg="' + (S.cards.page - 1) + '"' + (S.cards.page <= 1 ? ' disabled' : '') + '>上一页</button>';
    for (let i = 1; i <= S.cards.pages; i++) {
      if (S.cards.pages > 7 && i > 2 && i < S.cards.pages - 1 && Math.abs(i - S.cards.page) > 1) {
        if (i === 3) h += '<span class="dim" style="padding:0 4px">…</span>';
        continue;
      }
      h += '<button data-pg="' + i + '"' + (i === S.cards.page ? ' class="on"' : '') + '>' + i + '</button>';
    }
    h += '<button data-pg="' + (S.cards.page + 1) + '"' + (S.cards.page >= S.cards.pages ? ' disabled' : '') + '>下一页</button>';
    p.innerHTML = h;
  }

  // 生成额度展示（§5：/flashcards/eligibility）
  async function loadCardQuota() {
    try {
      const r = await api('/api/cards/eligibility');
      S.cardQuota = r;
      const el = $('#cardQuota');
      if (el) {
        el.textContent = '收卡额度 ' + r.used + '/' + r.limit + ' 今日';
        el.classList.toggle('low', r.remaining <= 0);
        const t = new Date(r.resetAt);
        el.title = '今天已用 ' + r.used + ' 次，还剩 ' + r.remaining + ' 次，' +
          t.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) + ' 重置';
      }
    } catch (e) {}
  }
  // 规则说明弹窗
  async function openCardRules() {
    try {
      const r = await api('/api/cards/rules');
      const pts = (r.points || []).map(p => '<li>' + HL.esc(p) + '</li>').join('');
      openModal(r.title || '学习进度规则', '<ul class="rules">' + pts + '</ul>');
    } catch (e) { toast(e.message); }
  }
  // AI 主动提醒收卡：拉草稿，确认后才落地
  async function openSuggest() {
    if (!S.convId) { toast('先去聊几句，让 AI 看看哪些值得收卡'); return; }
    const btn = $('#cardSuggestBtn');
    if (btn) { btn.disabled = true; btn.textContent = '正在看…'; }
    try {
      const r = await api('/api/cards/suggest', { method: 'POST', body: { conversationId: S.convId, count: 4 } });
      const drafts = r.drafts || [];
      if (!drafts.length) { toast('这段对话里暂时没找到特别值得收的点'); return; }
      const rows = drafts.map((d, i) =>
        '<label class="sg-row"><input type="checkbox" class="sg-chk" data-i="' + i + '" checked>' +
        '<span class="sg-k">' + HL.esc(d.knowledge) + '</span>' +
        '<span class="chip t-' + d.type + '">' + ({ choice: '选择题', spelling: '拼写', understanding: '理解题' }[d.type] || d.type) + '</span>' +
        (d.question ? '<span class="sg-q">' + HL.esc(d.question) + '</span>' : '') +
        '</label>').join('');
      const body = '<div class="sg-note">AI 觉得下面这些值得收成知识卡。勾选想留下的，确认后才会生成（会计入今日额度）。</div>' +
        rows +
        '<div class="pc-acts" style="margin-top:16px"><button class="btn sm primary" id="sgOk" type="button">收下选中的</button>' +
        '<span class="sp"></span><button class="btn ghost sm" id="sgCancel" type="button">先不用</button></div>';
      openModal('AI 收卡建议', body);
      const ok = $('#sgOk');
      if (ok) ok.addEventListener('click', async () => {
        const picks = $$('.sg-chk').filter(x => x.checked).map(x => drafts[Number(x.dataset.i)]);
        if (!picks.length) { toast('先勾选要收下的'); return; }
        ok.disabled = true; ok.textContent = '收集中…';
        let n = 0;
        for (const d of picks) {
          try { await api('/api/cards', { method: 'POST', body: d }); n++; } catch (e) { toast('有一张没存成：' + e.message); }
        }
        toast('已收下 ' + n + ' 张知识卡');
        closeModal();
        loadCards();
      });
      const cancel = $('#sgCancel');
      if (cancel) cancel.addEventListener('click', () => closeModal());
    } catch (e) { toast(e.message); }
    finally { if (btn) { btn.disabled = false; btn.textContent = '让 AI 建议收卡'; } }
  }

  // ---------- 练习流程 ----------
  let practice = null;   // { card, answered }
  async function openPractice(id) {
    let card;
    try { card = (await api('/api/cards/' + id)).card; } catch (e) { toast(e.message); return; }
    practice = { card: card, answered: false, prevSelfKnown: null };
    openModal('练习 · ' + (card.statusLabel || ''), practiceHTML(card));
    bindPractice();
  }
  function practiceHTML(c) {
    const typeName = { choice: '选择题', spelling: '拼写题', understanding: '理解题' }[c.type] || c.type;
    let inner = '';
    if (c.type === 'choice' && c.options && c.options.choices) {
      inner = '<div class="pc-opts" id="pcOpts">' + c.options.choices.map((ch, i) =>
        '<button class="pc-opt" data-i="' + i + '" type="button"><span class="oi">' + 'ABCD'[i] + '</span><span>' + HL.esc(ch) + '</span></button>').join('') + '</div>';
    } else if (c.type === 'spelling') {
      inner = '<input class="inp" id="pcInput" style="width:100%;font-size:1.05rem" placeholder="把单词拼出来" autocomplete="off" autocapitalize="off" spellcheck="false">';
    } else {
      inner = '<textarea class="pc-input" id="pcInput" placeholder="用你自己的话讲一遍——不用背原句，讲清意思就行"></textarea>';
    }
    return '<div class="practice">' +
      '<div class="pc-k">' + HL.esc(typeName) + ' · 已练 ' + c.reviewCount + ' 次 · ' + fmtDue(c.dueAt) + '</div>' +
      '<div class="pc-q">' + HL.esc(c.question || c.knowledge) + '</div>' +
      inner +
      '<label class="pc-free"><input type="checkbox" id="pcFree"> 自由练习（不计入复习计划）</label>' +
      '<div id="pcFb"></div>' +
      '<div class="pc-acts">' +
      '<button class="btn sm" id="pcHint" type="button">给点提示</button>' +
      (c.type === 'understanding' ? '<button class="btn sm primary" id="pcCheck" type="button">让 AI 核对我的理解</button>'
        : '<button class="btn sm primary" id="pcSubmit" type="button">提交</button>') +
      '<span class="sp"></span>' +
      '<button class="btn ghost sm" id="pcKnown" type="button">我已经会了</button>' +
      '</div></div>';
  }
  function bindPractice() {
    const c = practice.card;
    const fb = $('#pcFb');
    const opts = $('#pcOpts');
    if (opts) {
      opts.addEventListener('click', ev => {
        const b = ev.target.closest('.pc-opt');
        if (!b || practice.answered) return;
        const i = Number(b.dataset.i);
        const right = i === (c.options.answerIndex || 0);
        practice.answered = true;
        $$('#pcOpts .pc-opt').forEach((x, k) => {
          x.disabled = true;
          if (k === (c.options.answerIndex || 0)) x.classList.add('right');
          else if (k === i) x.classList.add('wrong');
        });
        submitReview(right ? 'right' : 'wrong', c.options.choices[i]);
      });
    }
    const sub = $('#pcSubmit');
    if (sub) sub.addEventListener('click', () => {
      if (practice.answered) return;
      const v = ($('#pcInput').value || '').trim();
      if (!v) { toast('先写点什么'); return; }
      practice.answered = true;
      const ok = normAns(v) === normAns(c.answer);
      fb.innerHTML = '<div class="pc-fb ' + (ok ? 'ok' : 'bad') + '">' +
        (ok ? '对了。' : '这次不太一样。参考：' + HL.esc(c.answer || '（无）')) + '</div>';
      submitReview(ok ? 'right' : 'wrong', v);
    });
    const chk = $('#pcCheck');
    if (chk) chk.addEventListener('click', async () => {
      if (practice.answered) return;
      const v = ($('#pcInput').value || '').trim();
      if (!v) { toast('先用你自己的话讲一遍'); return; }
      chk.disabled = true; chk.textContent = '正在核对…';
      try {
        const r = await api('/api/cards/' + c.id + '/understanding-check', { method: 'POST', body: { answer: v } });
        renderVerdict(r.verdict, v);
      } catch (e) { toast(e.message); chk.disabled = false; chk.textContent = '让 AI 核对我的理解'; }
    });
    $('#pcHint').addEventListener('click', async () => {
      const b = $('#pcHint'); b.disabled = true; b.textContent = '想一想…';
      try {
        const r = await api('/api/cards/' + c.id + '/hint', { method: 'POST' });
        if (r.hidden) fb.innerHTML = '<div class="pc-hint">' + HL.esc(r.message) + '</div>';
        else fb.innerHTML = '<div class="pc-hint"><b>提示：</b>' + HL.esc(r.hint) + '</div>';
      } catch (e) { toast(e.message); }
      b.disabled = false; b.textContent = '给点提示';
    });
    $('#pcKnown').addEventListener('click', async () => {
      try {
        const r = await api('/api/cards/' + c.id + '/self-known', { method: 'POST' });
        practice.prevSelfKnown = r.previous;
        toast(r.message);
        closeModal();
        loadCards();
      } catch (e) { toast(e.message); }
    });
  }
  function renderVerdict(v, answer) {
    const map = { solid: ['ok', '理解到位'], partial: ['mid', '说到了一部分'], off: ['bad', '这里有理解偏差'], unknown: ['neutral', '暂时判断不了'] };
    const m = map[v.verdict] || map.unknown;
    let h = '<div class="pc-fb ' + m[0] + '"><b>' + m[1] + '</b>';
    if (v.comment) h += '<div style="margin-top:4px">' + HL.esc(v.comment) + '</div>';
    if (v.covered && v.covered.length) h += '<div class="pc-covered">已说到：' + v.covered.map(HL.esc).join('、') + '</div>';
    if (v.missing && v.missing.length) h += '<div class="pc-missing">还差：' + v.missing.map(HL.esc).join('；') + '</div>';
    h += '</div>';
    $('#pcFb').innerHTML = h;
    practice.answered = true;
    $('#pcCheck').style.display = 'none';
    doReview(null, answer, v);
  }
  function readFree() { const f = $('#pcFree'); return !!(f && f.checked); }
  function verdictToResult(v) { return v === 'solid' ? 'right' : v === 'off' ? 'wrong' : v === 'partial' ? 'right' : 'unknown'; }
  // 统一收口：自由练习走 /free-practice；理解题核对走 /understanding-complete；其余走 /review
  async function doReview(result, answer, verdict) {
    const id = practice.card.id;
    const isFree = readFree();
    const r0 = verdict ? verdictToResult(verdict.verdict) : result;
    try {
      let r;
      if (isFree) {
        r = await api('/api/cards/' + id + '/free-practice', { method: 'POST', body: { result: r0, studentAnswer: answer, verdict: verdict || null, verdictJson: verdict || null } });
      } else if (verdict) {
        r = await api('/api/cards/' + id + '/understanding-complete', { method: 'POST', body: { answer: answer, verdict: verdict } });
      } else {
        r = await api('/api/cards/' + id + '/review', { method: 'POST', body: { result: result, studentAnswer: answer } });
      }
      afterReview(r);
    } catch (e) { toast(e.message); }
  }
  async function submitReview(result, answer) { await doReview(result, answer, null); }
  function afterReview(r) {
    const fb = $('#pcFb');
    const cls = r.card.status === 'mastered' ? 'ok' : (r.card.lastResult === 'wrong' ? 'bad' : r.card.lastResult === 'unknown' ? 'neutral' : 'ok');
    fb.insertAdjacentHTML('beforeend', '<div class="pc-fb ' + cls + '">' + HL.esc(r.message) + '</div>');
    const acts = document.querySelector('.pc-acts');
    if (acts) acts.innerHTML = '<button class="btn sm primary" id="pcDone" type="button">好，收起来</button>' +
      '<span class="sp"></span><button class="btn ghost sm" id="pcRestore" type="button">刚才没答好，重来一次</button>' +
      '<button class="btn ghost sm" data-plan="today" type="button">今天再练</button>' +
      '<button class="btn ghost sm" data-plan="tomorrow" type="button">明天再练</button>' +
      '<button class="btn ghost sm" data-plan="pending" type="button">复习时间待更新</button>';
    const done = $('#pcDone');
    if (done) done.addEventListener('click', () => { closeModal(); loadCards(); });
    const rs = $('#pcRestore');
    if (rs) rs.addEventListener('click', async () => {
      try { await api('/api/cards/' + practice.card.id + '/restore-review', { method: 'POST' }); toast('已重置为「学习中」，明天再练'); closeModal(); loadCards(); }
      catch (e) { toast(e.message); }
    });
    if (acts) Array.prototype.slice.call(acts.querySelectorAll('[data-plan]')).forEach(b => b.addEventListener('click', async () => {
      const when = b.dataset.plan;
      try {
        const rr = await api('/api/cards/' + practice.card.id + '/plan', { method: 'POST', body: { when } });
        const label = when === 'pending' ? '已标记为「复习时间待更新」' : (when === 'today' ? '已设为今天再练' : '已设为明天再练');
        toast(label);
        fb.insertAdjacentHTML('beforeend', '<div class="pc-fb neutral">' + HL.esc(rr.card.statusLabel) + ' · ' + fmtDue(rr.card.dueAt) + '</div>');
        b.disabled = true;
      } catch (e) { toast(e.message); }
    }));
    // 记住刚练的是哪张，列表重渲染后让它的状态 chip 呼吸一次
    S.justCard = practice.card.id;
    loadPet(true);
    loadCardSummary();
    loadCardQuota();
  }
  function normAns(s) {
    return String(s == null ? '' : s).toLowerCase().replace(/\s+/g, '').replace(/[，。；：、,.;:!?！？"'「」]/g, '');
  }

  // ================= 学习日报（批次10）=================
  /**
   * 日报不是"再做一个看板"。区别在于：
   *   看板回答「我做了多少」（量），日报回答「我走到哪一步」（留痕）。
   * 所以日报里：
   *   · 四问是**问句**，学生自己写 —— 系统只摆事实，不替他下结论；
   *   · 每个数字**点得开**，看到的是一条条原始记录，不是我们算好的结论；
   *   · 算不出来的数字显示「暂不能确定」而**不是 0**；
   *   · 专设一节说清楚**为什么不给分数**。
   */
  let dailyDate = '';        // '' = 今天（由服务端决定，避免前后端各算一次"今天"）
  let dailyData = null;
  let dailySaveTimer = null;
  let dailySaveSeq = 0;

  function dayShift(s, delta) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
    if (!m) return s;
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    d.setDate(d.getDate() + delta);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function dayLabel(s, today) {
    if (s === today) return '今天';
    if (s === dayShift(today, -1)) return '昨天';
    const m = /^\d{4}-(\d{2})-(\d{2})$/.exec(s || '');
    return m ? (Number(m[1]) + ' 月 ' + Number(m[2]) + ' 日') : s;
  }

  async function loadDaily(date) {
    const box = $('#dailyBox');
    if (!box) return;
    if (!dailyData) box.innerHTML = '<div class="skel" style="height:200px"></div>';
    let r, h;
    try {
      r = await api('/api/daily' + (date ? '?date=' + encodeURIComponent(date) : ''));
      h = await api('/api/daily/history?limit=14');
    } catch (e) { box.innerHTML = '<div class="empty"><p>' + HL.esc(e.message) + '</p></div>'; return; }
    dailyData = r.report;
    dailyDate = r.report.date;
    renderDaily(h.days || []);
  }

  function renderDaily(history) {
    const box = $('#dailyBox');
    const d = dailyData;
    if (!box || !d) return;
    const today = d.isToday ? d.date : dayShift(d.date, 0);   // d.date 本身就是选中那天
    const isFinal = d.status === 'final';

    // —— 数字：每个都可点开看依据 ——
    const nums = d.metrics.map(m => {
      const na = m.value === null;
      return '<button class="d-num' + (na ? ' na' : '') + '" type="button" data-metric="' + HL.esc(m.key) + '"' +
        (na ? ' title="' + HL.esc(m.unknown) + '"' : '') + '>' +
        '<b>' + (na ? '—' : HL.esc(String(m.value))) + '</b>' +
        '<span>' + HL.esc(m.label) + (m.unit ? '（' + HL.esc(m.unit) + '）' : '') + '</span>' +
        (na ? '<i>' + HL.esc(m.unknown) + '</i>' : '<i class="d-num-go">看依据</i>') +
        '</button>';
    }).join('');

    // —— 四问 ——
    const qs = d.questions.map((q, i) => {
      const fs = q.findings.map(f =>
        '<li>' + HL.esc(f.text) +
        (f.evidence && f.evidence.ids && f.evidence.ids.length
          ? ' <button class="d-ev" type="button" data-kind="' + HL.esc(f.evidence.kind) + '" data-ids="' + HL.esc(f.evidence.ids.join(',')) + '">看依据</button>'
          : '') +
        '</li>').join('');
      const un = q.unknown.map(t => '<li class="d-un">' + HL.esc(t) + '</li>').join('');
      const val = (d.answers && d.answers[q.key]) || '';
      return '<div class="d-q">' +
        '<div class="d-q-h"><i>' + (i + 1) + '</i><span>' + HL.esc(q.ask) + '</span></div>' +
        ((fs || un) ? '<ul class="d-f">' + fs + un + '</ul>' : '') +
        '<textarea class="d-ans" data-k="' + HL.esc(q.key) + '" rows="2"' + (isFinal ? ' readonly' : '') +
        ' placeholder="' + (isFinal ? '' : '用你自己的话说，写几句就行') + '">' + HL.esc(val) + '</textarea>' +
        '</div>';
    }).join('');

    const ns = d.notScored.map(x =>
      '<div class="d-ns-i"><b>' + HL.esc(x.title) + '</b><p>' + HL.esc(x.why) + '</p></div>').join('');
    const lim = d.limits.map(x => '<li>' + HL.esc(x) + '</li>').join('');

    const hist = (history || []).filter(x => x.date !== d.date);
    const histHtml = hist.length
      ? '<div class="d-hist">' + hist.map(x =>
        '<button class="d-hb" type="button" data-day="' + HL.esc(x.date) + '">' +
        HL.esc(dayLabel(x.date, d.date)) +
        '<i>' + (x.status === 'final' ? '已定稿' : '草稿 ' + x.filled + '/4') + '</i></button>').join('') + '</div>'
      : '<div class="dim" style="font-size:.8rem">还没有别的日报。每天来看一眼就行。</div>';

    box.innerHTML =
      '<div class="dash-panel d-daily">' +
        '<div class="d-head">' +
          '<h3>学习日报 <span>' + HL.esc(dayLabel(d.date, d.date)) + '</span></h3>' +
          '<div class="d-nav">' +
            '<button class="btn ghost sm" id="dailyPrev" type="button">前一天</button>' +
            '<button class="btn ghost sm" id="dailyToday" type="button"' + (d.isToday ? ' disabled' : '') + '>回到今天</button>' +
            '<button class="btn ghost sm" id="dailyNext" type="button"' + (d.isToday ? ' disabled' : '') + '>后一天</button>' +
          '</div>' +
        '</div>' +

        '<p class="d-headline">' + HL.esc(d.headline) + '</p>' +
        '<div class="d-nums">' + nums + '</div>' +
        '<p class="d-hint">每个数字都点得开 —— 看到的是当时的原始记录，不是我们替你下的结论。</p>' +

        '<div class="d-qs">' + qs + '</div>' +

        '<div class="d-savebar"><span id="dailySaveHint">' +
          (isFinal ? '已定稿。定稿之后不再改写 —— 这是你当时写下的。'
                   : (d.updatedAt ? '草稿会自动保存' : '写点什么，草稿会自动保存')) +
        '</span>' +
        '<button class="btn sm" id="dailyFinal"' + (isFinal ? ' disabled' : '') + ' type="button">' +
          (isFinal ? '已定稿' : '定稿') + '</button></div>' +

        '<details class="d-fold"><summary>为什么不给分数</summary><div class="d-ns">' + ns + '</div></details>' +
        '<details class="d-fold"><summary>这份日报不能证明什么</summary><ul class="d-lim">' + lim + '</ul></details>' +

        '<div class="d-hwrap"><div class="d-ht">之前的日报</div>' + histHtml + '</div>' +
      '</div>';
  }

  /** 草稿自动保存：停手 900ms 才发，避免每敲一个字打一次接口 */
  function queueDraftSave() {
    const box = $('#dailyBox');
    if (!box || !dailyData) return;
    const answers = {};
    $$('#dailyBox .d-ans').forEach(t => { answers[t.dataset.k] = t.value; });
    clearTimeout(dailySaveTimer);
    const hint = $('#dailySaveHint');
    if (hint) hint.textContent = '正在保存…';
    dailySaveTimer = setTimeout(async () => {
      const seq = ++dailySaveSeq;
      try {
        const r = await api('/api/daily/' + encodeURIComponent(dailyDate) + '/draft', { method: 'POST', body: { answers } });
        if (seq !== dailySaveSeq) return;             // 防乱序：晚到的旧请求不许覆盖提示
        if (dailyData) { dailyData.answers = r.report.answers; dailyData.status = r.report.status; }
        const h = $('#dailySaveHint');
        if (h) h.textContent = '草稿已保存 · ' + new Date().toTimeString().slice(0, 5);
      } catch (e) {
        const h = $('#dailySaveHint');
        if (h) h.textContent = '保存失败：' + e.message + '（内容还在页面上，别关）';
      }
    }, 900);
  }

  async function finalizeDaily() {
    const answers = {};
    $$('#dailyBox .d-ans').forEach(t => { answers[t.dataset.k] = t.value; });
    try {
      const r = await api('/api/daily/' + encodeURIComponent(dailyDate) + '/finalize', { method: 'POST', body: { answers } });
      dailyData = Object.assign({}, dailyData, { status: r.report.status, answers: r.report.answers });
      const h = await api('/api/daily/history?limit=14');
      renderDaily(h.days || []);
      toast('已定稿。定稿之后不再改写。');
    } catch (e) { toast(e.message); }
  }

  /** 溯源弹窗：把原始记录一条条摆出来 */
  async function openDailyEvidence(metricKey, kind, ids) {
    let items = [];
    try {
      if (kind && ids && ids.length) {
        // 四问里某一条发现：它自带 kind + ids，按 id 精确取那几条
        const r = await api('/api/daily/' + encodeURIComponent(dailyDate) + '/evidence', { method: 'POST', body: { kind: kind, ids: ids } });
        items = r.items || [];
      } else {
        const r = await api('/api/daily/' + encodeURIComponent(dailyDate) + '/evidence/' + encodeURIComponent(metricKey));
        items = r.items || [];
      }
    } catch (e) { return toast(e.message); }
    if (!items.length) return openModal('依据', '<p class="dim">这一项没有可展开的原始记录。</p>');
    const html = '<div class="ev-list">' + items.map(i =>
      '<div class="ev-i">' +
      '<div class="ev-h"><b>' + HL.esc(i.title) + '</b>' + (i.time ? '<span>' + HL.esc(i.time) + '</span>' : '') + '</div>' +
      (i.detail ? '<p>' + HL.esc(i.detail) + '</p>' : '') +
      (i.verdict || i.aiVerdict ? '<div class="ev-v">' + HL.esc(i.verdict || '') +
        (i.aiVerdict ? ' · AI 当时的判定：' + HL.esc(i.aiVerdict) : '') + '</div>' : '') +
      '</div>').join('') + '</div>';
    openModal('依据（' + items.length + ' 条原始记录）', html);
  }

  function bindDaily() {
    // ★ 绑在 #dashBody 上，不绑 #dailyBox —— #dailyBox 是 loadDash 每次重建的，
    //   绑在它身上，第二次进看板（或点「刷新」）监听就跟着旧节点一起没了。
    //   绑在稳定的容器上，内容怎么重写都不会失效。
    const host = $('#dashBody');
    if (!host) return;
    // 事件委托：innerHTML 每次重写，逐个 bind 会漏
    host.addEventListener('click', ev => {
      const t = ev.target;
      if (t.closest('#dailyPrev')) { loadDaily(dayShift(dailyDate, -1)); return; }
      if (t.closest('#dailyNext')) { loadDaily(dayShift(dailyDate, 1)); return; }
      if (t.closest('#dailyToday')) { loadDaily(''); return; }
      if (t.closest('#dailyFinal')) { finalizeDaily(); return; }
      const hb = t.closest('[data-day]');
      if (hb) { loadDaily(hb.dataset.day); return; }
      // ★ 先判 data-kind（四问里某一条发现的「看依据」），它带 kind + ids；
      //   数字卡片只有 data-metric，走整指标的溯源。顺序反了会走错分支。
      const ev1 = t.closest('[data-kind]');
      if (ev1) {
        openDailyEvidence('', ev1.dataset.kind, ev1.dataset.ids ? ev1.dataset.ids.split(',') : []);
        return;
      }
      const numBtn = t.closest('[data-metric]');
      if (numBtn) { openDailyEvidence(numBtn.dataset.metric, '', null); return; }
    });
    host.addEventListener('input', ev => {
      if (ev.target && ev.target.classList && ev.target.classList.contains('d-ans')) queueDraftSave();
    });
    // 离开页面/切视图前把没保存的草稿补一次
    host.addEventListener('focusout', ev => {
      if (ev.target && ev.target.classList && ev.target.classList.contains('d-ans')) queueDraftSave();
    });
  }

  // ================= 周报（批次16 + 增强）=================
  /**
   * 周报的立场和日报一样：**摆事实，不给分数**。
   * 后端 weekly.js 把 summary/coverage/days/notScored/limits 全都算好了，
   * 而且每一项都带「算不出来就说算不出来」的口径。前端这里只负责**把它们摆出来** ——
   * 算好了不显示，等于这份诚实白做了。
   *
   * ★ 三条不能破的规矩（与日报共用）：
   *   ① 数字每次现算，周报不落库；
   *   ② value === null 时显示「—」+ 说明，**绝不补 0**；
   *   ③ 不评分，并把「为什么不给分数」明明白白写出来。
   */
  const WEEK_MAX_DAYS = 7;      // 与 server/weekly.js 的 MAX_DAYS 对齐（前端先拦，省一次 400）
  let weeklyRange = null;       // { from, to } —— 记忆用户选的区间，切走再回来不丢

  function todayStr() {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  /** 两个日期字符串相差几天（含首尾），用于前端先拦超范围 */
  function daysBetween(a, b) {
    const pa = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(a || ''));
    const pb = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(b || ''));
    if (!pa || !pb) return null;
    const ta = new Date(Number(pa[1]), Number(pa[2]) - 1, Number(pa[3])).getTime();
    const tb = new Date(Number(pb[1]), Number(pb[2]) - 1, Number(pb[3])).getTime();
    return Math.round((tb - ta) / 86400000) + 1;
  }
  function defaultWeeklyRange() {
    const to = todayStr();
    return { from: dayShift(to, -(WEEK_MAX_DAYS - 1)), to: to };
  }

  async function loadWeekly(range) {
    const box = $('#weeklyBox');
    if (!box) return;
    const r2 = range || weeklyRange || defaultWeeklyRange();
    weeklyRange = r2;
    box.innerHTML = '<div class="skel" style="height:150px"></div>';
    try {
      const r = await api('/api/weekly?from=' + encodeURIComponent(r2.from) + '&to=' + encodeURIComponent(r2.to));
      box.innerHTML = renderWeekly(r.report);
    } catch (e) {
      // 失败时把选择器**留着**，否则用户改了一次坏日期就再也改不回来
      box.innerHTML = weeklyShell(r2, '<div class="w-empty">' + HL.esc(e.message) + '</div>');
    }
    // ★ 这两块必须等 renderWeekly 把占位节点写进 DOM 之后再取数 ——
    //   提前调会让 $('#weeklyNoteSec') / $('#weeklyHist') 取到 null，
    //   然后函数静默 return（本项目踩过"建容器先于取数"的坑），页面上一片空白还零报错。
    await Promise.all([loadWeeklyNote(r2), loadWeeklyHist()]);
  }

  /** 外壳（头部 + 日期选择器）。单独抽出来，是为了让"取数失败"也能保留选择器。 */
  function weeklyShell(range, body, isCurrentWeek) {
    const from = range.from, to = range.to;
    const quick = (label, f, t) => {
      const on = (from === f && to === t) ? ' on' : '';
      return '<button class="w-q' + on + '" type="button" data-wfrom="' + HL.esc(f) + '" data-wto="' + HL.esc(t) + '">' + HL.esc(label) + '</button>';
    };
    // 上一个 7 天窗口：从当前窗口往前再推 7 天
    const prevTo = dayShift(from, -1);
    const prevFrom = dayShift(prevTo, -(WEEK_MAX_DAYS - 1));
    return '<div class="w-header">' +
        '<h3>学习周报' + (isCurrentWeek ? ' <span class="w-cur">本周</span>' : '') + '</h3>' +
        '<div class="w-pick">' +
          '<input class="w-date" type="date" id="wFrom" value="' + HL.esc(from) + '" title="起始日期">' +
          '<span class="w-tilde">–</span>' +
          '<input class="w-date" type="date" id="wTo" value="' + HL.esc(to) + '" title="结束日期">' +
        '</div>' +
      '</div>' +
      '<div class="w-quicks">' +
        quick('最近 7 天', dayShift(todayStr(), -6), todayStr()) +
        quick('上周', prevFrom, prevTo) +
        '<span class="w-limit">最多 7 天</span>' +
      '</div>' +
      body;
  }

  /** 「—」和「0」是两件事：null 一律走这里，附上为什么 */
  function wNum(v, unit, unknownText) {
    if (v === null || v === undefined) {
      return '<b class="w-na">—</b><i class="w-why">' + HL.esc(unknownText || '暂不能确定') + '</i>';
    }
    return '<b>' + HL.esc(String(v)) + (unit || '') + '</b>';
  }
  function renderWeekly(report) {
    const s = report.summary;
    const cov = report.coverage || { totalCards: 0, bySubject: [] };

    // —— ① 概览数字：每一张都能看出"算得出来 / 算不出来" ——
    const kpi = [
      {
        v: s.records, l: '留下的记录', u: '条',
        why: s.records === 0 ? '这几天还没有任何记录' : null,
      },
      {
        v: s.reviews, l: '练知识卡', u: '次',
        why: s.reviews === 0 ? '这几天没有练习记录' : null,
      },
      {
        v: s.accuracy === null ? null : s.accuracy + '%', l: '答对的比例',
        sub: s.accuracy === null ? null : '对 ' + s.right + ' / 错 ' + s.wrong,
        why: '没有一次判得出对错的练习，算不出比例',
      },
      {
        v: s.cardsTouched, l: '碰过的知识卡', u: '张',
        why: s.cardsTouched === 0 ? '这几天没有复习过任何卡' : null,
      },
      {
        v: s.daysWithRecord + ' / ' + report.daysCount, l: '有记录的天数',
      },
    ].map(c => '<div class="w-kpi">' + wNum(c.v, c.u, c.why) +
      '<span>' + HL.esc(c.l) + '</span>' +
      (c.sub ? '<em class="w-sub">' + HL.esc(c.sub) + '</em>' : '') + '</div>').join('');

    // —— ② 逐天：哪天留了记录、哪天是空的（空的那天如实显示为空，不补 0）——
    // ★ 类名刻意用 .w-blank，不用 .w-na ——
    //   .w-na 的语义是"这个指标算不出来"（KPI 卡上的「—」），
    //   "这天完全没有记录"是另一回事（不是算不出来，是那天确实没发生）。
    //   两者共用一个类名会让**样式无法区分**、**测试选择器也只能连着一起抓**，
    //   这正是记忆里那条"同一属性名被两种语义复用 = 定时炸弹"的同类。
    const days = report.days.map(d => {
      const okCount = d.keyMetrics.filter(m => m.key === 'accuracy')[0];
      const isToday = d.date === todayStr();
      const dateShort = d.date.replace(/^\d{4}-/, '').replace('-', '/');
      return '<div class="w-day' + (d.hasRecord ? ' has' : '') + '" title="' + HL.esc(d.headline) + '">' +
        '<i>' + HL.esc(dateShort) + (isToday ? ' 今天' : '') + '</i>' +
        (d.hasRecord
          ? '<b>' + d.keyMetrics.filter(m => m.key === 'records')[0].value + '</b>'
          : '<b class="w-blank">空</b>') +
        '<em>' + (okCount && okCount.value !== null ? okCount.value + '%' : '—') + '</em>' +
        '</div>';
    }).join('');

    // —— ③ 按科目：只摆对错次数，不给"科目评分" ——
    const subs = s.subjects.length
      ? s.subjects.map(x => {
          const judged = x.right + x.wrong;
          const pct = judged ? Math.round(x.right / judged * 100) : null;
          const w = judged ? Math.round(x.wrong / judged * 100) : 0;
          return '<div class="w-sub-row">' +
            '<span class="w-sub-n">' + HL.esc(x.subject) + '</span>' +
            '<div class="w-bar" title="' + HL.esc('对 ' + x.right + ' 次，错 ' + x.wrong + ' 次') + '">' +
              '<i class="w-bar-ok" style="width:' + (pct === null ? 0 : 100 - w) + '%"></i>' +
            '</div>' +
            '<span class="w-sub-v">' + HL.esc('练 ' + x.reviews + ' 次') +
              (pct === null ? '' : ' · ' + pct + '%') + '</span>' +
          '</div>';
        }).join('')
      : '<div class="dim w-none">这几天没有按科目分得开的练习记录。</div>';

    // —— ④ 卡住的卡：跨天累计没答对的，这才是"该补哪里" ——
    const stuck = s.stuckCards.length
      ? s.stuckCards.map(c =>
        '<div class="w-stuck"><span class="w-stuck-t">' + HL.esc(c.knowledge) + '</span>' +
        '<span class="w-stuck-n">' + c.wrongs + ' 次没答对</span></div>').join('')
      : '<div class="dim w-none">这几天没有反复卡住的卡。</div>';

    // —— ⑤ 覆盖 ——
    const coverTxt = cov.totalCards
      ? '这几天碰过 <b>' + cov.totalCards + '</b> 张不同的卡，分布在 ' + cov.bySubject.length + ' 个科目：' +
        cov.bySubject.map(x => HL.esc(x.subject) + ' ' + x.count + ' 张').join(' · ')
      : '这几天没有碰过任何知识卡。';

    // —— ⑥ 为什么不给分数 / 这份周报不能证明什么（结构化条目，不是散文）——
    const ns = report.notScored.map(x =>
      '<div class="d-ns-i"><b>' + HL.esc(x.title) + '</b><p>' + HL.esc(x.why) + '</p></div>').join('');
    const lim = report.limits.map(x => '<li>' + HL.esc(x) + '</li>').join('');

    const body =
      '<div class="w-grid">' + kpi + '</div>' +

      '<div class="w-sec"><h4>这几天</h4><div class="w-days">' + days + '</div>' +
        '<p class="w-note">灰色的是没有留下记录的那天 —— 那是「没有记录」，不是「0 条」。</p></div>' +

      '<div class="w-sec"><h4>按科目</h4>' + subs + '</div>' +

      '<div class="w-sec"><h4>卡住的卡 <span>跨天累计没答对 2 次以上</span></h4>' + stuck + '</div>' +

      '<div class="w-sec"><h4>覆盖</h4><p class="w-cover">' + coverTxt + '</p></div>' +

      // —— ⑦ 这周我写下的一句话（批次22）——
      // ★ 这是全页**唯一会被存进数据库的东西**（其余数字全部现算）。
      //   所以它单独成块、明确标注"会被保存"，跟纯事实的其余部分视觉上分开。
      '<div class="w-sec w-note-sec" id="weeklyNoteSec"></div>' +

      '<details class="d-fold"><summary>为什么这份周报不给分数</summary><div class="d-ns">' + ns + '</div></details>' +
      '<details class="d-fold"><summary>这份周报不能证明什么</summary><ul class="d-lim">' + lim + '</ul></details>' +

      // —— ⑧ 历史周报（批次22）——
      '<div class="w-sec" id="weeklyHistSec"><h4>以前的周报 <span>只存了我写下的那段</span></h4><div id="weeklyHist"></div></div>';

    return weeklyShell({ from: report.from, to: report.to }, body, report.isCurrentWeek);
  }

  // ================= 历史周报（批次22）=================
  /**
   * 这里只做两件事：
   *   ① 显示/编辑**这一段日期**里"人写的那段"（唯一落库的东西）；
   *   ② 列出以前的周报，点开可以回看那周写了什么。
   *
   * ★ 为什么历史里能回看的只有"我写的那段"：
   *   数字是现算的，回看数字没有意义（它本来就每次都对）；
   *   有意义的恰恰是"当时的我注意到了什么" —— 那是无法重算的。
   *   而且回看时那些数字**仍是按当时那段日期现算的**，不是复制品。
   */
  let weeklyNoteRange = null;   // 编辑中的 note 属于哪一段

  async function loadWeeklyNote(range) {
    const sec = $('#weeklyNoteSec');
    if (!sec) return;
    const r2 = range || weeklyRange || defaultWeeklyRange();
    weeklyNoteRange = r2;
    try {
      const r = await api('/api/weekly/note?from=' + encodeURIComponent(r2.from) + '&to=' + encodeURIComponent(r2.to));
      sec.innerHTML = renderWeeklyNote(r.note, r2);
    } catch (e) {
      sec.innerHTML = '<h4>这周我写下的一句话</h4><p class="w-note">' + HL.esc(e.message) + '</p>';
    }
  }

  function renderWeeklyNote(note, range) {
    const isFinal = !!(note && note.status === 'final');
    const a = (note && note.answers) || {};
    const noticed = typeof a.noticed === 'string' ? a.noticed : '';
    const next = typeof a.next === 'string' ? a.next : '';
    const qs = [['noticed', '这周我注意到什么', '哪一天、哪件事让你觉得"哦，原来是这样"', noticed],
                ['next', '下周想试什么', '一个小小的、你真的会去做的事', next]];

    if (isFinal) {
      // 定稿后只读 —— 与日报同规矩：定稿是"当时写的"，不该被后来改写
      const rd = qs.map(q =>
        '<div class="w-rd"><b>' + HL.esc(q[1]) + '</b><p>' +
          (q[3].trim() ? HL.esc(q[3]) : '<span class="dim">（这条空着）</span>') + '</p></div>').join('');
      return '<h4>这周我写下的一句话 <span class="w-final-tag">已定稿 · 只读</span></h4>' + rd +
        '<p class="w-note">定稿之后就改不了了 —— 这是「当时的我」写的，后来的我不该替它改。</p>';
    }

    const fields = qs.map(q =>
      '<label class="w-note-l"><b>' + HL.esc(q[1]) + '</b>' +
        '<input type="text" maxlength="2000" data-nk="' + q[0] + '" ' +
          'placeholder="' + HL.esc(q[2]) + '" value="' + HL.esc(q[3]) + '"></label>').join('');

    return '<h4>这周我写下的一句话 <span>会保存，其余数字不会</span></h4>' +
      '<p class="w-note">上面所有数字都是每次重新算的，存不下来也不用存。下面这两句是你写的 —— ' +
        '它才是这一周里唯一"别人算不出来"的东西。</p>' +
      fields +
      '<div class="w-note-act">' +
        '<button class="btn sm" type="button" id="wNoteSave">先存着</button>' +
        '<button class="btn sm" type="button" id="wNoteFinal">定稿（之后不能改）</button>' +
      '</div>';
  }

  function collectWeeklyNote() {
    const out = {};
    $$('#weeklyNoteSec [data-nk]').forEach(el => { out[el.dataset.nk] = el.value || ''; });
    return out;
  }

  async function saveWeeklyNote(finalize) {
    const r2 = weeklyNoteRange || weeklyRange || defaultWeeklyRange();
    const btn = finalize ? $('#wNoteFinal') : $('#wNoteSave');
    if (btn) { btn.disabled = true; btn.textContent = finalize ? '定稿中…' : '保存中…'; }
    try {
      await api('/api/weekly/note/' + r2.from + '/' + r2.to, {
        method: 'POST',
        body: JSON.stringify({ answers: collectWeeklyNote(), finalize: !!finalize }),
      });
      toast(finalize ? '已定稿，这周的记录就留在这儿了' : '已保存');
      await loadWeeklyNote(r2);
      await loadWeeklyHist();      // 定稿后历史里要立刻出现这一条
    } catch (e) {
      toast(e.message);
      if (btn) { btn.disabled = false; btn.textContent = finalize ? '定稿（之后不能改）' : '先存着'; }
    }
  }

  async function loadWeeklyHist() {
    const box = $('#weeklyHist');
    if (!box) return;
    try {
      const r = await api('/api/weekly/history');
      const ws = r.weeks || [];
      if (!ws.length) {
        box.innerHTML = '<div class="dim w-none">还没有以前的周报。写过并定稿之后，会一条条攒在这里。</div>';
        return;
      }
      box.innerHTML = ws.map(w => {
        const a = w.answers || {};
        const parts = [];
        if (a.noticed && a.noticed.trim()) parts.push('注意到：' + a.noticed);
        if (a.next && a.next.trim()) parts.push('想试：' + a.next);
        const head = w.from.replace(/^\d{4}-/, '') + ' ~ ' + w.to.replace(/^\d{4}-/, '');
        // ★ 这里的数字是**现算**的（后端 history 每次都重算），不是当初存下来的
        return '<button class="w-hist" type="button" data-hfrom="' + HL.esc(w.from) + '" data-hto="' + HL.esc(w.to) + '">' +
          '<div class="w-hist-h"><b>' + HL.esc(head) + '</b>' +
            '<em class="w-hist-st' + (w.status === 'final' ? ' final' : '') + '">' +
              (w.status === 'final' ? '已定稿' : '草稿') + '</em></div>' +
          '<div class="w-hist-n">记录 ' + w.records + ' 条 · 练卡 ' + w.reviews + ' 次' +
            (w.accuracy === null ? ' · 比例算不出' : ' · 对 ' + w.accuracy + '%') + '</div>' +
          (parts.length
            ? '<div class="w-hist-t">' + HL.esc(parts.join('　·　')) + '</div>'
            : '<div class="w-hist-t dim">这一周没有写下什么。</div>') +
          '</button>';
      }).join('');
    } catch (e) {
      box.innerHTML = '<div class="dim w-none">' + HL.esc(e.message) + '</div>';
    }
  }

  function bindWeeklyNote() {
    // ★★ 这里**不能**加 `if (!$('#weeklyNoteSec')) return;` 这样的守卫，
    //    即使它看起来"更安全"。#weeklyNoteSec 是 loadWeekly() **异步**渲染出来的，
    //    而 bindWeeklyNote() 在 loadDash 里同步调用 —— 那一刻它必然还不存在。
    //    加了守卫 ⇒ 函数静默 return ⇒ 事件根本没绑上 ⇒ 点历史条目毫无反应、
    //    控制台也不报任何错（本套件实测抓到过：6 项断言全红在"点了没反应"上）。
    //    真正要绑的宿主是 #weeklyBox，它在 loadDash 里是先建好的。
    const box = $('#weeklyBox');
    if (!box) return;
    box.addEventListener('click', e => {
      const t = e.target;
      if (!t) return;
      if (t.id === 'wNoteSave') { saveWeeklyNote(false); return; }
      if (t.id === 'wNoteFinal') {
        if (!confirm('定稿之后就改不了了，确定吗？')) return;
        saveWeeklyNote(true); return;
      }
      const h = t.closest ? t.closest('.w-hist') : null;
      if (h) loadWeekly({ from: h.dataset.hfrom, to: h.dataset.hto });
    });
  }

  /** 日期选择器 / 快捷按钮的事件（绑在 #weeklyBox 上，它每次整体重建） */
  function bindWeekly() {
    const box = $('#weeklyBox');
    if (!box) return;
    box.addEventListener('change', e => {
      const t = e.target;
      if (!t || !t.classList.contains('w-date')) return;
      const from = $('#wFrom') ? $('#wFrom').value : '';
      const to = $('#wTo') ? $('#wTo').value : '';
      if (!from || !to) return;
      if (to < from) return toast('结束日期不能早于开始日期');
      const n = daysBetween(from, to);
      if (n === null) return toast('日期格式不对');
      if (n > WEEK_MAX_DAYS) return toast('一次最多看 ' + WEEK_MAX_DAYS + ' 天，把范围收窄一点');
      loadWeekly({ from: from, to: to });
    });
    box.addEventListener('click', e => {
      const t = e.target && e.target.closest ? e.target.closest('.w-q') : null;
      if (!t) return;
      loadWeekly({ from: t.dataset.wfrom, to: t.dataset.wto });
    });
  }

  // ================= 家长视角（批次20）=================
  /**
   * 家长视角与看板**共用同一批事实**（activity / card_reviews / 已定稿日报），
   * 但问的问题不同：
   *   看板：我做了什么？（学习者视角，给复习队列、成长曲线、弱项计数）
   *   家长：我能做什么？（回答"要不要管、管什么、怎么说"）
   * ⇒ 所以这里**不重复看板的数字**。同一个数摆两遍，家长会以为那是两个指标。
   *
   * ★ 三条硬规矩在这里的落点：
   *   ① 数字每次现算（后端已经保证，前端不缓存进 localStorage）；
   *   ② value === null ⇒ 显示说明文字，**绝不补 0**；
   *      （`accuracy: null` 拼成 "0%" 是最容易犯的错 —— 见 renderParent 里的判断）
   *   ③ 不评分，并且把「为什么这里没有分数」放在最显眼处之一。
   *
   * ★ 家长端最容易做歪的地方：把它做成"监看仪表盘"。
   *   所以这一段代码里**刻意没有**：排名、平均线、时长、同比红绿箭头、
   *   "已掌握 N 张"这类存量数字（存量会变成家长的目标）。
   */
  const PARENT_MAX_DAYS = 31;   // 与 server/parent.js 的上限对齐（前端先拦，省一次 400）
  let parentRange = null;       // { from, to } —— 切走再回来不丢

  function defaultParentRange() {
    const to = todayStr();
    return { from: dayShift(to, -(PARENT_MAX_DAYS - 1)), to: to };
  }

  async function loadParent(range) {
    const box = $('#parentBody');
    if (!box) return;
    const r2 = range || parentRange || defaultParentRange();
    parentRange = r2;
    box.innerHTML = '<div class="skel" style="height:120px;margin-bottom:10px"></div><div class="skel" style="height:180px"></div>';
    try {
      const r = await api('/api/parent?from=' + encodeURIComponent(r2.from) + '&to=' + encodeURIComponent(r2.to));
      box.innerHTML = renderParent(r.view);
    } catch (e) {
      box.innerHTML = parentShell(r2, '<div class="w-empty">' + HL.esc(e.message) + '</div>');
    }
  }

  /** 外壳（头部 + 日期选择器）。与周报同构，失败时也保留选择器。 */
  function parentShell(range, body) {
    const from = range.from, to = range.to;
    const quick = (label, f, t) => {
      const on = (from === f && to === t) ? ' on' : '';
      return '<button class="w-q' + on + '" type="button" data-pfrom="' + HL.esc(f) + '" data-pto="' + HL.esc(t) + '">' + HL.esc(label) + '</button>';
    };
    const prevTo = dayShift(from, -1);
    const prevFrom = dayShift(prevTo, -6);
    return '<div class="w-header">' +
        '<h3>家长视角</h3>' +
        '<div class="w-pick">' +
          '<input class="w-date" type="date" id="pFrom" value="' + HL.esc(from) + '" title="起始日期">' +
          '<span class="w-tilde">–</span>' +
          '<input class="w-date" type="date" id="pTo" value="' + HL.esc(to) + '" title="结束日期">' +
        '</div>' +
      '</div>' +
      '<div class="w-quicks">' +
        quick('最近 7 天', dayShift(todayStr(), -6), todayStr()) +
        quick('最近 30 天', dayShift(todayStr(), -29), todayStr()) +
        quick('上一段', prevFrom, prevTo) +
        '<span class="w-limit">最多 ' + PARENT_MAX_DAYS + ' 天</span>' +
      '</div>' +
      body;
  }

  /** 家长视角专属的「算不出来」渲染：和 wNum 一样，null 给说明不给 0 */
  function pNum(v, unit, unknownText) {
    if (v === null || v === undefined) {
      return '<b class="w-na">—</b><i class="w-why">' + HL.esc(unknownText || '算不出来') + '</i>';
    }
    return '<b>' + HL.esc(String(v)) + (unit || '') + '</b>';
  }

  function renderParent(v) {
    const rh = v.rhythm, mv = v.movement;

    // —— ① 一句话总结：这是整页的"产品灵魂"，必须排在最上面 ——
    //    三件套：发生了什么 / 这正常吗 / 你能做什么。
    //    ★ markdown 的 ** ** 在这里手动转成 <b>，否则会把星号原样显示给家长。
    function em(s) {
      return HL.esc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
    }
    const head = '<div class="p-head p-tone-' + HL.esc(v.headline.tone) + '">' +
        '<div class="p-head-t">' + em(v.headline.text) + '</div>' +
        '<p class="p-head-p">' + em(v.headline.plain) + '</p>' +
        '<div class="p-head-a"><span>你可以做的</span>' + em(v.headline.action) + '</div>' +
      '</div>';

    // —— ② 节奏：有记录的天数（**不是时长**）——
    const perDay = rh.perDay.length
      ? rh.perDay.map(d => '<span class="p-day" title="' + HL.esc(d.date) + ' 有 ' + d.actions + ' 条记录">' +
          '<i>' + HL.esc(d.date.replace(/^\d{4}-/, '').replace('-', '/')) + '</i><b>' + d.actions + '</b></span>').join('')
      : '<div class="dim w-none">这段时间里，这个工具没有被打开过。</div>';

    const gapTxt = rh.gapDays === null
      ? '<b class="w-na">—</b><i class="w-why">还没有任何记录，算不出"停了几天"</i>'
      : (rh.gapDays === 0
        ? '<b>今天</b><i class="w-why">今天有记录</i>'
        : '<b>' + rh.gapDays + ' 天前</b><i class="w-why">最后一次看到记录</i>');

    const rhythmBlock =
      '<div class="w-grid">' +
        '<div class="w-kpi">' + pNum(rh.activeDays + ' / ' + rh.totalDays, ' 天', null) + '<span>有记录的天数</span>' +
          '<em class="w-sub">' + (rh.activeDays === 0 ? '这段时间一条记录也没有' : '不是"学了多久"，是"哪几天留下了记录"') + '</em></div>' +
        '<div class="w-kpi">' + pNum(rh.longestStreak, ' 天',
          rh.activeDays === 0 ? '没有记录，算不出连续天数' : null) + '<span>最长连着几天</span></div>' +
        '<div class="w-kpi">' + gapTxt + '<span>距最近一次</span></div>' +
      '</div>' +
      '<div class="p-days">' + perDay + '</div>' +
      // ★ 主动说明"为什么不用时长" —— 家长脑子里默认的指标就是时长，不说清他会往里套
      '<details class="d-fold"><summary>为什么这里不显示"学了多长时间"</summary>' +
        '<div class="d-ns"><div class="d-ns-i"><b>时长算不准，所以不给</b>' +
        '<p>这个工具只在页面开着的时候记一笔，关掉页面就断了。拿它算时长会**系统性少算** —— ' +
        '而一个偏低的时长比不给时长更糟：会让没发生的事看起来像发生了。' +
        '所以这里只说"哪几天留下了记录"，这个数能被忠实反映。</p></div></div></details>';

    // —— ③ 在不在推进：**过程指标**，不是存量 ——
    //    ★ 刻意不给"已掌握 N 张"：存量会被家长拿去做比较，而他没有参照系。
    const mvBlock =
      '<div class="w-grid">' +
        '<div class="w-kpi">' + pNum(mv.judged, ' 次',
          mv.judged === 0 ? '这段时间没有判得出对错的练习' : null) + '<span>判得出对错的练习</span></div>' +
        '<div class="w-kpi">' + pNum(mv.accuracy === null ? null : mv.accuracy, '%', mv.accuracyUnknown) +
          '<span>答对的比例</span>' +
          // ★ 用后端给的 `wrong`，不要在前端算 `judged - right`：
          //   前端算就会在字段缺失时得到 NaN 并**直接印到界面上**（实测印过「对 1 / 错 NaN」）。
          //   后端已经是唯一口径，前端只负责显示。
          (mv.accuracy === null ? '' : '<em class="w-sub">对 ' + mv.right + ' / 错 ' + mv.wrong + '</em>') + '</div>' +
        '<div class="w-kpi">' + pNum(mv.advanced, ' 张', mv.advancedUnknown) +
          '<span>复习过的卡里走到"快记住"以上的</span>' +
          (mv.advanced === null ? '' : '<em class="w-sub">这段时间复习过 ' + mv.touched + ' 张</em>') + '</div>' +
      '</div>' +
      '<p class="w-note">"往前走了"这件事，比"掌握了多少"更值得看 —— ' +
      '前者说明他在反复重来，后者只是一个越攒越大的数字。' +
      '这个工具的设计就是让卡**反复出现**，所以同一张卡错两三次是过程的一部分。</p>' +
      (mv.accuracy === null && mv.judged === 0
        ? '<div class="p-unknown-box"><b>为什么正确率是「—」</b>' +
          '<p>' + HL.esc(mv.accuracyUnknown) + '。这不是 0% —— ' +
          '"全错"和"没有可判的练习"是两件事。这天他可能只是在看书、在提问，还没到做题那一步。</p></div>'
        : '');

    // —— ④ 卡在哪里：给"怎么帮"，**不给知识点原文** ——
    const help = v.helpPoints.length
      ? v.helpPoints.map(h =>
        '<div class="p-help">' +
          '<div class="p-help-h"><span class="p-help-a">' + HL.esc(h.area) + '</span>' +
            '<span class="p-help-n">反复遇到 ' + h.wrongs + ' 次</span></div>' +
          '<p class="p-help-t">' + HL.esc(h.advice) + '</p>' +
        '</div>').join('')
      : '<div class="dim w-none">这段时间没有反复卡住的地方 —— 这是好事，不用做什么。</div>';

    const helpBlock = help +
      // ★ 主动说明"为什么不告诉你是哪个知识点" —— 否则家长会觉得这页在藏着掖着
      '<details class="d-fold"><summary>为什么不告诉你具体是哪个知识点</summary>' +
        '<div class="d-ns"><div class="d-ns-i"><b>因为一旦知道，就很难不去考他</b>' +
        '<p>如果你拿着"判别式与根的个数"去问他，那件事就从"他自己想弄明白"变成了"他要向你证明"。' +
        '自学一旦变成被考，孩子下一步就会开始挑**能答对的**去学。' +
        '所以这里只说到科目 —— 你想帮的话，问一句"这块卡在哪一步"就够了。</p></div></div></details>';

    // —— ⑤ 他自己写的那段（只读，且只读已定稿的）——
    const notes = v.notes.length
      ? v.notes.map(n => {
          const d = n.date.replace(/^\d{4}-/, '').replace('-', '/');
          return '<div class="p-note"><div class="p-note-d">' + HL.esc(d) + '</div>' +
            n.answers.map(a => '<p class="p-note-l"><span>' +
              HL.esc({ goal: '目标', state: '状态', process: '过程', adjust: '调整' }[a.key] || a.key) +
              '</span>' + HL.esc(a.text) + '</p>').join('') +
          '</div>';
        }).join('')
      : '<div class="dim w-none">这段时间他没有写下定稿的日报。定稿的那份才会出现在这里 —— 写着写着又改主意的草稿不算。</div>';

    // —— ⑥ 我答不了什么（这一页最诚实、也最值钱的部分）——
    const cannot = v.cannotSay.map(c =>
      '<div class="p-cannot-i"><b>' + HL.esc(c.q) + '</b><p>' + em(c.a) + '</p></div>').join('');

    // —— ⑦ 承诺边界 ——
    const privacy = '<div class="p-priv">' +
        '<b>这一页看不到：' + v.privacy.notShown.map(HL.esc).join(' · ') + '</b>' +
        '<p>' + em(v.privacy.why) + '</p></div>';

    // —— ⑧ 现在有什么（存量，只摆不评）——
    const nowBlock = '<div class="p-now">' +
      [['知识卡', v.now.cards, '张'], ['已掌握', v.now.mastered, '张'], ['到期待复习', v.now.due, '张'],
       ['资料', v.now.documents, '份'], ['对话', v.now.conversations, '次']]
        .map(x => '<span class="p-now-i"><b>' + x[1] + '</b><i>' + HL.esc(x[0]) + '</i></span>').join('') +
      '</div>';

    const body =
      head +
      '<div class="w-sec"><h4>这周的节奏</h4>' + rhythmBlock + '</div>' +
      '<div class="w-sec"><h4>在不在往前走</h4>' + mvBlock + '</div>' +
      '<div class="w-sec"><h4>可以帮上忙的地方 <span>只说到科目，不点破知识点</span></h4>' + helpBlock + '</div>' +
      '<div class="w-sec"><h4>他自己写的那段 <span>已定稿的才显示</span></h4>' + notes + '</div>' +
      '<div class="w-sec"><h4>现在有什么</h4>' + nowBlock +
        '<p class="w-note">存量数字只说明"攒了多少"，不说明"学得怎么样"。</p></div>' +
      '<details class="d-fold" open><summary>这一页答不了的三件事</summary><div class="d-ns">' + cannot + '</div></details>' +
      privacy;

    return parentShell({ from: v.range.from, to: v.range.to }, body);
  }

  /** 日期选择器 / 快捷按钮（绑在 #parentBody 上，它每次整体重建） */
  function bindParent() {
    const box = $('#parentBody');
    if (!box) return;
    box.addEventListener('change', e => {
      const t = e.target;
      if (!t || !t.classList.contains('w-date')) return;
      const from = $('#pFrom') ? $('#pFrom').value : '';
      const to = $('#pTo') ? $('#pTo').value : '';
      if (!from || !to) return;
      if (to < from) return toast('结束日期不能早于开始日期');
      const n = daysBetween(from, to);
      if (n === null) return toast('日期格式不对');
      if (n > PARENT_MAX_DAYS) return toast('一次最多看 ' + PARENT_MAX_DAYS + ' 天，把范围收窄一点');
      loadParent({ from: from, to: to });
    });
    box.addEventListener('click', e => {
      const t = e.target && e.target.closest ? e.target.closest('.w-q') : null;
      if (!t) return;
      loadParent({ from: t.dataset.pfrom, to: t.dataset.pto });
    });
  }

  // ================= 看板（P5）=================
  async function loadDash() {
    // ★ 单滚动容器：日报（#dailyBox）和看板（#dashPanels）都住在 #dashBody 里。
    //   早先给日报单开了一个 .card-list，结果两个 flex:1 的兄弟在一个纵向 flex 里
    //   **抢高度**，各自 overflow-y:auto —— 日报和看板各缩一半、各滚各的，两块都看不全。
    //   现在只在 #dashBody 上留一个滚动条，两者在它内部按文档流往下排。
    //   #dashPanels 是后写看板内容的落点，避免重写看板时把 #dailyBox 一起冲掉。
    const box = $('#dashBody');
    box.innerHTML = '<div id="weeklyBox"></div><div id="dailyBox"></div>' +
      '<div id="dashPanels"><div class="skel" style="height:120px;margin-bottom:10px"></div><div class="skel" style="height:180px"></div></div>';
    // ★ 事件必须绑在 #weeklyBox 的**外层稳定容器** #dashBody 上吗？不需要 ——
    //   #weeklyBox 本身是每次 loadDash 新建的，但 bindWeekly() 也在同一个同步块里
    //   紧跟其后调用，绑定发生在它被替换之前，所以不会重复绑定、也不会绑到旧节点上。
    //   （反面教材是 #dailyBox：它的内容被异步重建，委托就必须挂在 #dashBody 上。）
    bindWeekly();
    bindWeeklyNote();
    // loadWeekly 内部会在渲染完之后自己去取 note / history（见那里的注释）
    loadWeekly();
    loadDaily(dailyDate || '');
    const panels = $('#dashPanels');
    let d, rep;
    try {
      d = await api('/api/dashboard?days=' + ($('#dashDays').value || 14));
      rep = await api('/api/dashboard/report?period=week');
    } catch (e) { panels.innerHTML = '<div class="empty"><p>' + HL.esc(e.message) + '</p></div>'; return; }

    const t = d.totals;
    const cmp = d.compare;
    const kpi = [
      { v: cmp.thisWeek, l: '近 7 天记录', cls: cmp.direction },
      { v: d.streak.days, l: '连续学习天数' },
      { v: t.due, l: '今日待练' },
      { v: t.mastered, l: '已掌握' },
      { v: d.movement.reviews ? d.movement.accuracy + '%' : '—', l: '本周答对率' },
      { v: t.documents, l: '资料份数' },
    ].map(k => '<div class="dash-kpi ' + (k.cls || '') + '"><b>' + k.v + '</b><span>' + k.l + '</span></div>').join('');

    const curveChart = HL.chart({
      title: '每天的学习动作',
      type: 'bar',
      labels: d.curve.map(x => x.date),
      series: [
        { name: '对话', values: d.curve.map(x => x.chat), color: 'var(--pri)' },
        { name: '练知识卡', values: d.curve.map(x => x.card_review), color: '#16A34A' },
        { name: '收知识卡', values: d.curve.map(x => x.card_created), color: '#D97706' },
      ],
    });

    const statusChart = HL.chart({
      title: '知识卡状态分布',
      type: 'bar',
      height: 160,
      labels: ['学习中', '快记住了', '已掌握', '无需再复习'],
      series: [{ name: '张数', values: [t.learning, t.almost, t.mastered, t.retired], color: 'var(--pri)' }],
    });

    // —— 阶段进度可视化（批次16 增强）——
    // ★ 为什么用"推进条"而不是再画一张柱状图：
    //   柱状图回答的是"各状态各有多少张"，推进条回答的是"整批卡走到哪一步了"。
    //   日报的「数字不等于掌握」那句文案已经把结论说死了 ——
    //   **真正的证据是知识卡的状态推进**，那就得让它以"推进"的形态出现。
    //   数据源就是 dashboard.totals()，不需要任何新接口。
    const stages = [
      { k: 'learning', n: '还在学', c: 'var(--pri)' },
      { k: 'almost',   n: '快记住', c: '#D97706' },
      { k: 'mastered', n: '已掌握', c: '#16A34A' },
      { k: 'retired',  n: '不用复习', c: '#94A3B8' },
    ];
    const cardTotal = stages.reduce((s, x) => s + (Number(t[x.k]) || 0), 0);
    const progress = cardTotal
      ? '<div class="pg-bar">' + stages.map(x => {
          const v = Number(t[x.k]) || 0;
          if (!v) return '';
          return '<i style="width:' + (v / cardTotal * 100).toFixed(2) + '%;background:' + x.c + '" title="' +
            HL.esc(x.n + ' ' + v + ' 张') + '"></i>';
        }).join('') + '</div>' +
        '<div class="pg-lg">' + stages.map(x =>
          '<span><i style="background:' + x.c + '"></i>' + HL.esc(x.n) +
          ' <b>' + (Number(t[x.k]) || 0) + '</b></span>').join('') + '</div>' +
        '<p class="w-note">掌握是<b>迁移</b>，不是堆积：卡从「还在学」一步步走到「已掌握」，靠的是间隔复习（5 连对 → 5·14·60 天）后的推进，不是某一天多做几道。</p>'
      : '<div class="dim" style="font-size:.86rem">还没有知识卡，收几张之后这里会显示它们走到哪一步了。</div>';

    const weak = d.weakPoints.length
      ? d.weakPoints.map(w =>
        '<div class="weak-i"><span class="w-t">' + HL.esc(w.knowledge) +
        '<span class="dim" style="font-size:.76rem"> · 状态 ' + HL.esc({ learning: '学习中', almost: '快记住了', mastered: '已掌握', retired: '无需再复习' }[w.status] || w.status) + '</span></span>' +
        '<span class="w-n">' + w.wrongs + ' / ' + w.reviews + ' 次没答对</span></div>').join('')
      : '<div class="dim" style="font-size:.86rem">还没有反复卡住的知识点。</div>';

    const kinds = { chat: '对话', card_review: '练了知识卡', card_created: '收了知识卡', kb_upload: '上传了资料', login: '进入空间' };
    const recent = d.recent.length
      ? d.recent.slice(0, 8).map(r => {
        const extra = r.meta && r.meta.knowledge ? '「' + HL.esc(r.meta.knowledge) + '」'
          : r.meta && r.meta.filename ? '「' + HL.esc(r.meta.filename) + '」' : '';
        return '<div class="weak-i"><span class="w-t">' + HL.esc(kinds[r.kind] || r.kind) + ' ' + extra + '</span>' +
          '<span class="dim" style="font-size:.74rem">' + fmtTime(r.at) + '</span></div>';
      }).join('')
      : '<div class="dim" style="font-size:.86rem">还没有记录。</div>';

    panels.innerHTML =
      '<div class="dash-grid">' + kpi + '</div>' +
      '<div class="dash-panel"><h3>本周小结 <span>数字都由系统直接统计，不经模型改写</span></h3>' +
      '<ul class="report-lines">' + rep.lines.map(l => '<li>' + HL.esc(l) + '</li>').join('') + '</ul></div>' +
      '<div class="dash-panel"><h3>学习动作曲线</h3>' + curveChart + '</div>' +
      '<div class="dash-panel"><h3>知识卡状态分布 <span>掌握是迁移，不是堆积</span></h3>' + statusChart + '</div>' +
      '<div class="dash-panel"><h3>阶段进度 <span>整批卡走到哪一步了</span></h3>' + progress + '</div>' +
      '<div class="dash-panel"><h3>该补哪里 <span>按"没答对次数"排</span></h3>' + weak + '</div>' +
      '<div class="dash-panel"><h3>最近做了什么</h3>' + recent + '</div>';
  }

  // ================= 能力中心（P7）=================
  const SKILL_CATS = [
    { k: 'all', n: '全部' }, { k: 'method', n: '通用方法' }, { k: 'subject', n: '学科能力' }, { k: 'tool', n: '工具' },
  ];
  let skillCat = 'all';
  let skillSubject = 'all';

  async function loadSkills() {
    if (!S.skills.length) $('#skillList').innerHTML = '<div class="skel" style="height:92px;margin-bottom:10px"></div><div class="skel" style="height:92px"></div>';
    try {
      const r = await api('/api/skills');
      S.skills = r.skills || [];
      S.skillEnabled = r.enabled || [];
      // 顶级导航砍成两根之后，能力徽标改挂在知识库的「能力」分区上
      setTabBadge('skills', S.skillEnabled.length);
      renderSkillCats();
      renderSkillSubjects();
      renderSkillList();
    } catch (e) { toast(e.message); }
  }
  /** 当前"分类"下的条目。学科是二级筛选，只在分类结果里再切一层。 */
  function skillPool() {
    return skillCat === 'all' ? S.skills : S.skills.filter(s => s.category === skillCat);
  }
  function renderSkillCats() {
    // 每个分类都带数量：57 条平铺在一个网格里，不写数量根本不知道"学科能力"底下有多少。
    $('#skillCats').innerHTML = SKILL_CATS.map(c => {
      const n = c.k === 'all' ? S.skills.length : S.skills.filter(s => s.category === c.k).length;
      return '<button class="cat-chip' + (skillCat === c.k ? ' on' : '') + '" data-cat="' + c.k + '" type="button">' +
        c.n + ' ' + n + '</button>';
    }).join('');
  }
  function renderSkillSubjects() {
    const pool = skillPool();
    const counts = {};
    pool.forEach(s => { counts[s.subject] = (counts[s.subject] || 0) + 1; });
    const subs = SUBJ_ORDER.filter(k => counts[k]);
    const box = $('#skillSubjects');
    // 只剩一个学科时（比如切到"工具"，清一色 general），这一排筛选是噪音，收起来
    if (subs.length < 2) { box.hidden = true; box.innerHTML = ''; skillSubject = 'all'; return; }
    box.hidden = false;
    // 换了分类之后，原来选中的学科可能已经不在这一层里了 —— 退回"全部"
    if (skillSubject !== 'all' && subs.indexOf(skillSubject) < 0) skillSubject = 'all';
    // 第一个 chip 写"全部学科"而不是"全部" —— 上一排分类也有个"全部"，
    // 两个"全部 57"并排会出现一模一样的按钮，看不出谁管谁。
    box.innerHTML = [{ k: 'all', n: '全部学科', c: pool.length }]
      .concat(subs.map(k => ({ k: k, n: SUBJ_NAME[k] || k, c: counts[k] })))
      .map(x => '<button class="cat-chip' + (skillSubject === x.k ? ' on' : '') + '" data-subj="' + x.k + '" type="button">' +
        x.n + ' ' + x.c + '</button>').join('');
  }
  function renderSkillList() {
    let list = skillPool();
    if (skillSubject !== 'all') list = list.filter(s => s.subject === skillSubject);
    if (!list.length) { $('#skillList').innerHTML = '<div class="empty"><p>这个筛选下还没有能力。</p></div>'; return; }
    $('#skillList').innerHTML = '<div class="skill-grid">' + list.map(s =>
      '<div class="skill-c' + (s.enabled ? ' on' : '') + '" data-id="' + s.id + '" role="button" tabindex="0">' +
      '<div class="sc-top"><span class="sc-n">' + HL.esc(s.name) + '</span><span class="tgl"></span></div>' +
      '<div class="sc-d">' + HL.esc(s.description) + '</div>' +
      '<div class="sc-b"><span>' + (SUBJ_NAME[s.subject] || s.subject) + '</span><span>·</span><span>' +
      ({ method: '方法', subject: '学科', tool: '工具' }[s.category] || s.category) + '</span></div>' +
      '</div>').join('') + '</div>';
  }
  async function toggleSkill(id) {
    const on = (S.skillEnabled || []).indexOf(id) >= 0;
    try {
      await api('/api/skills/' + id + '/grant', { method: on ? 'DELETE' : 'POST' });
      await loadSkills();
      const s = S.skills.filter(x => x.id === id)[0];
      toast(on ? '已取消「' + (s ? s.name : id) + '」' : '已启用「' + (s ? s.name : id) + '」，下一句对话就生效');
    } catch (e) { toast(e.message); }
  }

  // ================= 英语（P10）=================
  /* 说明：不接外部语音评测。朗读用浏览器自带的 SpeechSynthesis，
   * 跟读比对用 SpeechRecognition —— 只判"识别成了什么词"，不给音准分。
   * 与其编一个假的分数骗孩子，不如老实回显识别结果。 */
  let enUnit = '';
  const EN_MODE_NAME = { meaning: '看中文写英文', listen: '听音写单词', spell: '看英文写单词' };
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition || null;

  function speak(text) {
    if (!text) return;
    try {
      if (!window.speechSynthesis) { toast('这个浏览器不支持朗读'); return; }
      const u = new SpeechSynthesisUtterance(String(text));
      u.lang = 'en-US'; u.rate = .9;
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(u);
    } catch (e) { toast('朗读失败'); }
  }

  async function loadEn() {
    const box = $('#enList');
    if (!box.dataset.ready) box.innerHTML = '<div class="skel" style="height:54px;margin-bottom:8px"></div><div class="skel" style="height:54px"></div>';
    const q = [];
    if (enUnit) q.push('unitId=' + encodeURIComponent(enUnit));
    q.push('sort=' + encodeURIComponent($('#enSort').value || 'new'));
    const kw = $('#enSearch').value.trim();
    if (kw) q.push('q=' + encodeURIComponent(kw));
    try {
      const [u, w] = await Promise.all([api('/api/english/units'), api('/api/english/words?' + q.join('&'))]);
      S.en = { units: u.units || [], words: w.words || [] };
      box.dataset.ready = '1';
      renderEnStats(); renderEnUnits(); renderEnList();
    } catch (e) { box.innerHTML = '<div class="empty"><p>' + HL.esc(e.message) + '</p></div>'; }
  }
  function renderEnStats() {
    const ws = (S.en && S.en.words) || [];
    const wrong = ws.filter(w => w.wrongCount > 0).length;
    const ok = ws.filter(w => w.wrongCount === 0 && w.rightCount >= 2).length;
    const box = $('#enStats');
    if (!ws.length) { box.innerHTML = ''; return; }
    box.innerHTML = [
      { v: ws.length, l: '当前列表单词' },
      { v: ok, l: '已经记住' },
      { v: wrong, l: '错过至少一次' },
      { v: (S.en.units || []).length, l: '单元' },
    ].map(k => '<div class="st"><b>' + k.v + '</b><span>' + k.l + '</span></div>').join('');
  }
  function renderEnUnits() {
    const us = (S.en && S.en.units) || [];
    $('#enUnits').innerHTML =
      '<button class="cat-chip' + (!enUnit ? ' on' : '') + '" data-u="" type="button">全部</button>' +
      us.map(u => '<button class="cat-chip' + (enUnit === u.id ? ' on' : '') + '" data-u="' + u.id + '" type="button">' +
        HL.esc(u.name) + ' ' + u.count + '</button>').join('');
  }
  function renderEnList() {
    const ws = (S.en && S.en.words) || [];
    const box = $('#enList');
    if (!ws.length) {
      box.innerHTML = '<div class="empty"><p>还没有单词。</p><p class="dim">点右上角「批量导入」，把词表整段粘进来就行。一行一个，中文意思可写可不写。</p></div>';
      return;
    }
    box.innerHTML = ws.map(w =>
      '<div class="en-i" data-id="' + w.id + '">' +
      '<span class="en-w">' + HL.esc(w.word) + '</span>' +
      '<span class="en-p">' + HL.esc(w.phonetic || '') + '</span>' +
      '<span class="en-m">' + HL.esc(w.meaning || '') + '</span>' +
      '<span class="en-n' + (w.wrongCount > 0 ? ' hot' : '') + '">错 ' + w.wrongCount + ' · 对 ' + w.rightCount + '</span>' +
      '<button class="speak-btn" data-speak="' + HL.esc(w.word) + '" type="button" title="朗读">🔊</button>' +
      (SR ? '<button class="speak-btn" data-say="' + HL.esc(w.word) + '" type="button" title="跟读，看看识别成了什么">🎤</button>' : '') +
      '<button class="btn ghost sm en-x" data-delw="' + w.id + '" type="button">删</button>' +
      '</div>').join('');
  }

  function openImportWords() {
    openModal('批量导入单词', '<div class="pool-note">一行一个词。下面这些写法都认：<br>' +
      '<code>apple /ˈæpl/ 苹果</code> · <code>apple 苹果</code> · <code>apple,苹果</code> · 也可以只有英文。</div>' +
      '<div style="margin-bottom:10px"><label class="lb">单元（可留空）</label><select class="sel" id="iwUnit" style="width:100%">' +
      '<option value="">不归入单元</option>' + ((S.en && S.en.units) || []).map(u => '<option value="' + u.id + '">' + HL.esc(u.name) + '</option>').join('') + '</select></div>' +
      '<div style="margin-bottom:10px"><label class="lb">词表</label><textarea class="pc-input" id="iwText" style="min-height:200px;font-family:var(--mono)" placeholder="apple /ˈæpl/ 苹果&#10;banana 香蕉&#10;cherry,樱桃"></textarea></div>' +
      '<div id="iwFb"></div>' +
      '<div class="pc-acts"><button class="btn primary sm" id="iwGo" type="button">导入</button></div>');
    $('#iwGo').addEventListener('click', async () => {
      const text = $('#iwText').value;
      if (!text.trim()) { toast('先粘一段词表'); return; }
      const b = $('#iwGo'); b.disabled = true; b.textContent = '导入中…';
      try {
        const r = await api('/api/english/words/import', { method: 'POST', body: { text: text, unitId: $('#iwUnit').value || undefined } });
        let h = '<div class="pc-fb ok">新增 ' + r.added + ' 个词。' +
          (r.duplicates ? '有 ' + r.duplicates + ' 个已经在单词本里了，没重复添加。' : '') +
          (r.skipped.length ? '有 ' + r.skipped.length + ' 行没认出来，下面列出来了。' : '') + '</div>';
        if (r.duplicateWords && r.duplicateWords.length) {
          h += '<div class="pc-fb neutral"><b>已存在（跳过）：</b>' + r.duplicateWords.slice(0, 20).map(HL.esc).join('、') + '</div>';
        }
        if (r.skipped.length) h += '<div class="pc-fb neutral"><b>没认出来的行：</b><br>' + r.skipped.slice(0, 12).map(HL.esc).join('<br>') + '</div>';
        $('#iwFb').innerHTML = h;
        await loadEn();
      } catch (e) { toast(e.message); }
      b.disabled = false; b.textContent = '导入';
    });
  }

  function openNewUnit() {
    openModal('新建单元', '<div style="margin-bottom:10px"><label class="lb">单元名</label><input class="inp" id="nuName" placeholder="如：Unit 1 或 七年级上册 M1" maxlength="40"></div>' +
      '<div style="margin-bottom:10px"><label class="lb">年级（可留空）</label><input class="inp" id="nuGrade" placeholder="如：七年级"></div>' +
      '<div class="pc-acts"><button class="btn primary sm" id="nuGo" type="button">创建</button></div>');
    $('#nuGo').addEventListener('click', async () => {
      try {
        await api('/api/english/units', { method: 'POST', body: { name: $('#nuName').value, grade: $('#nuGrade').value } });
        closeModal(); await loadEn(); toast('单元已创建');
      } catch (e) { toast(e.message); }
    });
  }

  /** 听写：出题不带答案，交卷才批改。错词自动转成拼写卡。 */
  async function openDictation() {
    let d;
    try { d = await api('/api/english/dictation?count=10&mode=' + (dictMode || 'meaning') + '&order=wrong' + (enUnit ? '&unitId=' + enUnit : '')); }
    catch (e) { toast(e.message); return; }
    if (!d.items.length) { toast('单词本是空的，先导入几个词'); return; }
    dictation = { data: d, items: d.items };
    openModal('听写 · ' + EN_MODE_NAME[d.mode], dictHTML());
    bindDict();
  }
  let dictMode = 'meaning';
  let dictation = null;
  function dictHTML() {
    const d = dictation.data;
    const rows = d.items.map((it, i) =>
      '<div class="dict-i" id="di_' + it.id + '">' +
      '<div class="dict-h"><span class="dict-n">' + (i + 1) + '/' + d.items.length + '</span>' +
      (d.mode === 'listen'
        ? '<button class="speak-btn" data-speak="' + HL.esc(it.prompt) + '" type="button" title="再听一遍">🔊</button><span class="dict-p">（点左边再听一遍）</span>'
        : '<span class="dict-p">' + HL.esc(it.prompt) + '</span>') +
      (it.letters ? '<span class="dict-l">' + new Array(it.letters + 1).join('·') + '</span>' : '') +
      '</div>' +
      '<input class="inp" id="da_' + it.id + '" style="width:100%;font-family:var(--mono)" placeholder="写英文" autocomplete="off" autocapitalize="off" spellcheck="false">' +
      '<div class="dict-fb" id="df_' + it.id + '"></div>' +
      '</div>').join('');
    return '<div class="pool-note">听写只挑"你错得最多"的词。交卷后答错的词会自动变成拼写卡，进复习队列。</div>' +
      '<div class="dict-wrap">' + rows + '</div>' +
      '<div id="dictSum"></div>' +
      '<div class="pc-acts"><button class="btn primary sm" id="dictGo" type="button">交卷</button>' +
      '<span class="sp"></span><button class="btn ghost sm" id="dictAgain" type="button">换一批</button></div>';
  }
  function bindDict() {
    if (dictation.data.mode === 'listen' && dictation.items.length) speak(dictation.items[0].prompt);
    $('#dictGo').addEventListener('click', async () => {
      const items = dictation.items.map(it => ({ id: it.id, answer: ($('#da_' + it.id).value || '').trim() }));
      const b = $('#dictGo'); b.disabled = true; b.textContent = '批改中…';
      try {
        const r = await api('/api/english/grade', { method: 'POST', body: { items: items, createCards: true } });
        r.results.forEach(res => {
          const box = $('#di_' + res.id);
          const fb = $('#df_' + res.id);
          if (!box || !fb) return;
          box.classList.add(res.ok ? 'ok' : 'bad');
          const inp = $('#da_' + res.id); if (inp) inp.disabled = true;
          fb.className = 'dict-fb ' + (res.ok ? 'ok' : 'bad');
          fb.innerHTML = res.ok
            ? '✓ ' + HL.esc(res.word) + (res.meaning ? ' · ' + HL.esc(res.meaning) : '')
            : '✗ 你写的是「' + HL.esc(res.answer || '（空）') + '」' +
              (res.diff ? '，' + HL.esc(res.diff.message) : '') +
              '<div style="color:var(--dim);margin-top:3px">再想一下，交卷后再看正确写法。</div>';
        });
        let sum = '<div class="dict-score"><b>' + r.right + '/' + r.total + '</b><span class="dim">答对 ' + r.accuracy + '%</span>' +
          (r.cardsCreated ? '<span class="dim">· ' + r.cardsCreated + ' 个错词已转成拼写卡</span>' : '') + '</div>';
        if (r.wrongWords.length) {
          sum += '<div class="pool-note">这次没写出来的：' + r.wrongWords.map(w => '<b>' + HL.esc(w.word) + '</b>' + (w.meaning ? '（' + HL.esc(w.meaning) + '）' : '')).join('、') + '</div>';
        }
        $('#dictSum').innerHTML = sum;
        $('#dictGo').style.display = 'none';
        b.disabled = false;
        await Promise.all([loadEn(), loadCardSummary(), loadPet(true)]);
      } catch (e) { toast(e.message); b.disabled = false; b.textContent = '交卷'; }
    });
    $('#dictAgain').addEventListener('click', () => { closeModal(); openDictation(); });
  }

  /** 跟读：用浏览器识别，回显"听成了什么"，不给音准分 */
  function startSay(target) {
    if (!SR) { toast('这个浏览器不支持语音识别'); return; }
    const rec = new SR();
    rec.lang = 'en-US'; rec.interimResults = false; rec.maxAlternatives = 1;
    toast('请读：' + target + '（说完自动停）', 4000);
    rec.onresult = async ev => {
      const heard = ev.results[0][0].transcript;
      try {
        const r = await api('/api/english/speech-compare', { method: 'POST', body: { target: target, heard: heard } });
        openModal('跟读比对', '<div class="pool-note">' + HL.esc(r.note) + '</div>' +
          '<div class="pc-fb ' + (r.accuracy >= 80 ? 'ok' : 'mid') + '"><b>目标：</b>' + HL.esc(r.target) + '<br><b>我听到：</b>' + HL.esc(r.heard) + '</div>' +
          (r.miss.length ? '<div class="pc-fb bad"><b>这几个词没听出来：</b>' + r.miss.map(HL.esc).join('、') + '</div>' : '<div class="pc-fb ok">每个词都听出来了。</div>') +
          '<div class="pc-acts"><button class="btn primary sm" id="sayAgain" type="button">再读一次</button>' +
          '<span class="sp"></span><button class="btn ghost sm" data-speak="' + HL.esc(target) + '" type="button">听标准读音</button></div>');
        const a = $('#sayAgain'); if (a) a.addEventListener('click', () => { closeModal(); startSay(target); });
      } catch (e) { toast(e.message); }
    };
    rec.onerror = () => toast('没听清，再试一次');
    try { rec.start(); } catch (e) { toast('启动识别失败'); }
  }

  // ================= 测评（P6）=================
  const TYPE_NAME = { choice: '选择', spelling: '拼写', understanding: '理解' };
  let exams = [];

  async function loadExams() {
    const box = $('#exList');
    if (!box.dataset.ready) box.innerHTML = '<div class="skel" style="height:62px;margin-bottom:8px"></div><div class="skel" style="height:62px"></div>';
    try {
      const [a, b] = await Promise.all([api('/api/exams'), api('/api/exams/breakdown')]);
      exams = a.exams || [];
      box.dataset.ready = '1';
      const subs = b.subjects || [];
      $('#exStats').innerHTML = subs.length
        ? subs.map(s => '<div class="st"><b>' + s.total + '</b><span>' + (SUBJ_NAME[s.subject] || s.subject) + ' · 已掌握 ' + s.mastered + '</span></div>').join('')
        : '';
      renderExams();
    } catch (e) { box.innerHTML = '<div class="empty"><p>' + HL.esc(e.message) + '</p></div>'; }
  }
  function renderExams() {
    const box = $('#exList');
    if (!exams.length) {
      box.innerHTML = '<div class="empty"><p>还没有测评卷。</p><p class="dim">右上角点「出一张卷」——题目直接从你已经收下的知识卡里抽，优先抽你答错过、还没记牢的。做错的题会自动回到复习队列。</p></div>';
      return;
    }
    box.innerHTML = exams.map(e => {
      const done = e.status === 'submitted';
      const sc = e.score || {};
      const sub = done
        ? (sc.counted ? '答对 ' + sc.right + '/' + sc.counted + '（' + sc.accuracy + '%）' : '已交卷') + (sc.unknown ? ' · ' + sc.unknown + ' 题没判断' : '')
        : '还没做 · ' + e.itemCount + ' 题';
      return '<div class="ex-i" data-id="' + e.id + '"><div>' +
        '<b>' + HL.esc(e.title) + '</b>' +
        '<div class="dim">' + HL.esc(sub) + ' · ' + fmtTime(e.createdAt) + '</div></div>' +
        '<span class="ex-pill ' + (done ? 'done' : 'open') + '">' + (done ? '已完成' : '未做') + '</span>' +
        '<button class="btn sm primary" data-open="' + e.id + '" type="button">' + (done ? '看结果' : '开始做') + '</button>' +
        '<button class="btn ghost sm" data-delex="' + e.id + '" type="button">删</button>' +
        '</div>';
    }).join('');
  }
  async function createExam() {
    const b = $('#exNew'); b.disabled = true; b.textContent = '出题中…';
    try {
      const body = { count: Number($('#exCount').value) || 8 };
      const s = $('#exSubject').value; if (s) body.subjects = [s];
      const r = await api('/api/exams', { method: 'POST', body: body });
      await loadExams();
      openExam(r.exam.id);
    } catch (e) { toast(e.message); }
    b.disabled = false; b.textContent = '出一张卷';
  }
  async function openExam(id) {
    let e;
    try { e = (await api('/api/exams/' + id)).exam; } catch (err) { toast(err.message); return; }
    if (e.status === 'submitted') return showExamResult(e);
    openModal('测评 · ' + HL.esc(e.title), examTakeHTML(e));
    bindExamTake(e);
  }
  function examTakeHTML(e) {
    return '<div class="ex-flow">交卷后每一题都会回到你的知识卡复习队列：答错的按「退一档」重新排，答对的推进档位。理解题如果 AI 判断不了，会记为"没判断"，不算错。</div>' +
      '<div style="max-height:58vh;overflow:auto;padding-top:12px">' + (e.items || []).map((it, i) => examQHTML(it, i)).join('') + '</div>' +
      '<div class="pc-acts"><button class="btn primary sm" id="exGo" type="button">交卷</button>' +
      '<span class="sp"></span><button class="btn ghost sm" id="exLater" type="button">先放着</button></div>';
  }
  function examQHTML(it, i) {
    const head = '<div class="eq-h"><span>' + (i + 1) + '</span><span>·</span><span>' + (TYPE_NAME[it.type] || it.type) + '</span>' +
      '<span>·</span><span>' + (SUBJ_NAME[it.subject] || it.subject) + '</span></div>';
    let body = '';
    if (it.type === 'choice' && it.options && it.options.choices) {
      body = '<div class="pc-opts">' + it.options.choices.map((ch, k) =>
        '<button class="pc-opt" data-i="' + k + '" type="button"><span class="oi">' + 'ABCD'[k] + '</span><span>' + HL.esc(ch) + '</span></button>').join('') + '</div>';
    } else if (it.type === 'spelling') {
      body = '<input class="inp" id="exA_' + it.cardId + '" style="width:100%;font-family:var(--mono)" placeholder="写英文单词" autocomplete="off" autocapitalize="off" spellcheck="false">';
    } else {
      body = '<textarea class="pc-input" id="exA_' + it.cardId + '" placeholder="用你自己的话讲一遍"></textarea>';
    }
    return '<div class="ex-q" id="exQ_' + it.cardId + '">' + head +
      '<div class="eq-t">' + HL.esc(it.question || it.knowledge) + '</div>' + body + '</div>';
  }
  function bindExamTake(e) {
    $$('#modalBody .pc-opts').forEach(opts => {
      opts.addEventListener('click', ev => {
        const b = ev.target.closest('.pc-opt'); if (!b) return;
        opts.querySelectorAll('.pc-opt').forEach(x => x.classList.remove('on'));
        b.classList.add('on');
      });
    });
    $('#exGo').addEventListener('click', async () => {
      const answers = (e.items || []).map(it => {
        if (it.type === 'choice') {
          const sel = document.querySelector('#exQ_' + it.cardId + ' .pc-opt.on');
          return { cardId: it.cardId, answerIndex: sel ? Number(sel.dataset.i) : undefined };
        }
        const el = $('#exA_' + it.cardId);
        return { cardId: it.cardId, answer: el ? el.value.trim() : '' };
      });
      const b = $('#exGo'); b.disabled = true; b.textContent = '批改中…（理解题要逐题核对）';
      try {
        const r = await api('/api/exams/' + e.id + '/submit', { method: 'POST', body: { answers: answers } });
        await Promise.all([loadExams(), loadCardSummary(), loadPet(true)]);
        openModal('测评结果 · ' + HL.esc(e.title), examResultHTML(r.score, r.results));
      } catch (err) { toast(err.message); b.disabled = false; b.textContent = '交卷'; }
    });
    $('#exLater').addEventListener('click', closeModal);
  }
  function showExamResult(e) {
    openModal('测评结果 · ' + HL.esc(e.title), examResultHTML(e.score, (e.items || []).map((it, i) => Object.assign({}, it, {
      studentAnswer: (e.answers || [])[i] ? (e.answers[i].answer != null ? e.answers[i].answer : '') : '',
    }))));
  }
  function examResultHTML(score, results) {
    const s = score || {};
    const head = '<div class="ex-res">' +
      '<div class="r"><b>' + (s.counted ? s.accuracy + '%' : '—') + '</b>答对率</div>' +
      '<div class="r"><b>' + (s.right || 0) + '</b>答对</div>' +
      '<div class="r"><b>' + (s.wrong || 0) + '</b>答错</div>' +
      '<div class="r"><b>' + (s.unknown || 0) + '</b>没判断</div>' +
      '</div>';
    const byType = Object.keys(s.byType || {}).map(k => '<span class="dim">' + (TYPE_NAME[k] || k) + ' ' + s.byType[k].right + '/' + s.byType[k].total + '</span>').join(' · ');
    const rows = (results || []).map((r, i) => {
      const cls = r.result === 'right' ? 'ok' : r.result === 'wrong' ? 'bad' : 'unknown';
      let fb = '<div class="eq-fb">';
      if (r.type === 'choice' && r.detail) {
        fb += '<span class="k">正确答案：</span>' + 'ABCD'[r.detail.correctIndex] + '　';
        fb += r.detail.pickIndex == null ? '<span class="k">你没选</span>' : (r.result === 'right' ? '<span style="color:var(--ok)">你选对了</span>' : '<span style="color:var(--bad)">你选了 ' + 'ABCD'[r.detail.pickIndex] + '</span>');
      } else {
        fb += '<span class="k">参考答案：</span>' + HL.esc(r.answer || '（无）') + '<br><span class="k">你写的：</span>' + HL.esc(r.studentAnswer || '（空）');
      }
      if (r.detail && r.detail.comment) fb += '<div style="margin-top:4px">' + HL.esc(r.detail.comment) + '</div>';
      if (r.message) fb += '<div class="dim" style="margin-top:4px">' + HL.esc(r.message) + '</div>';
      fb += '</div>';
      return '<div class="ex-q ' + cls + '">' +
        '<div class="eq-h"><span>' + (i + 1) + '</span><span>·</span><span>' + (TYPE_NAME[r.type] || r.type) + '</span>' +
        '<span>·</span><span>' + (SUBJ_NAME[r.subject] || r.subject) + '</span>' +
        '<span>·</span><span>' + (r.result === 'right' ? '答对' : r.result === 'wrong' ? '答错' : '没判断') + '</span></div>' +
        '<div class="eq-t">' + HL.esc(r.question || r.knowledge) + '</div>' + fb + '</div>';
    }).join('');
    return head + '<div class="ex-flow" style="margin-bottom:10px">' + byType + '<br>这些题已经回到你的知识卡队列了，之后会在该复习的时候再出现。</div>' +
      '<div style="max-height:52vh;overflow:auto">' + rows + '</div>' +
      '<div class="pc-acts"><button class="btn primary sm" id="exDone" type="button">好，收起来</button></div>';
  }

  // ================= 公共资料池（P3）=================
  /* 只放用户主动共享的内容；取用是「复制进自己空间」，不做跨空间读写。
   * 池子里不出现真实姓名 —— 署名只用用户自己填的昵称。 */
  let poolTab = 'browse';
  async function loadPool() {
    const box = $('#poolList');
    if (!box.dataset.ready) box.innerHTML = '<div class="skel" style="height:74px;margin-bottom:8px"></div><div class="skel" style="height:74px"></div>';
    try {
      if (poolTab === 'mine') {
        const r = await api('/api/pool/mine');
        S.pool = { items: r.items || [], ban: (r.stats || {}).ban, active: 0, maxActive: 20, stats: r.stats };
      } else {
        const q = ['subject=' + $('#poolSubject').value, 'kind=' + $('#poolKind').value, 'sort=' + $('#poolSort').value];
        const kw = $('#poolSearch').value.trim();
        if (kw) q.push('q=' + encodeURIComponent(kw));
        const r = await api('/api/pool?' + q.join('&'));
        S.pool = { items: r.items || [], ban: r.ban, active: r.active, maxActive: r.maxActive };
      }
      box.dataset.ready = '1';
      renderPool();
    } catch (e) { box.innerHTML = '<div class="empty"><p>' + HL.esc(e.message) + '</p></div>'; }
  }
  function renderPool() {
    const d = S.pool || { items: [] };
    const box = $('#poolList');
    let head = '';
    if (poolTab === 'browse') {
      head = '<div class="pool-note">池子一开始是空的，里面每一条都是某个同学自己放上来的。取用 = 复制进你的空间，之后你改你的，他改他的。</div>';
      if (d.ban && d.ban.banned) head += '<div class="pool-ban">你的空间已有 ' + d.ban.hiddenCount + ' 条分享被下架，暂时不能往池子里放新内容。</div>';
      else if (d.active >= d.maxActive) head += '<div class="pool-ban">你在池子里已经有 ' + d.active + ' 条了（上限 ' + d.maxActive + ' 条），先撤掉几条再分享。</div>';
    } else {
      const st = d.stats || {};
      head = '<div class="pool-note">你分享出去 ' + (st.shared || 0) + ' 条，被别人取用 ' + (st.copiesGained || 0) + ' 次；你从池子里取用了 ' + (st.got || 0) + ' 次。</div>';
    }
    if (!d.items.length) {
      box.innerHTML = head + '<div class="empty"><p>' + (poolTab === 'mine' ? '你还没有分享过东西。' : '池子里还没有内容。') + '</p>' +
        '<p class="dim">' + (poolTab === 'mine' ? '点右上角「分享我的资料」，可以把知识卡、单词表、练习卷或一段笔记放进来。' : '等你或别的同学放东西进来，这里就有了。') + '</p></div>';
      return;
    }
    const KN = { cards: '知识卡', words: '单词表', exam: '练习卷', note: '笔记' };
    box.innerHTML = head + d.items.map(it => {
      const gone = it.status && it.status !== 'active';
      return '<div class="pool-i' + (it.mine ? ' mine' : '') + (gone ? ' hidden-i' : '') + '">' +
        '<div class="pool-top"><b>' + HL.esc(it.title) + '</b>' +
        '<span class="pool-tag k-' + it.kind + '">' + (KN[it.kind] || it.kind) + '</span>' +
        '<span class="pool-tag">' + (SUBJ_NAME[it.subject] || it.subject) + '</span>' +
        (gone ? '<span class="pool-tag gone">已下架</span>' : '') +
        (it.copied ? '<span class="pool-tag">已取用</span>' : '') +
        '</div>' +
        '<div class="pool-sum">' + HL.esc(it.summary || '') + '</div>' +
        (it.preview ? '<div class="pool-prev">' + HL.esc(it.preview) + '</div>' : '') +
        '<div class="pool-bot"><span class="by">' + HL.esc(it.authorName || '一位同学') + ' · ' + fmtTime(it.createdAt) +
        ' · 被取用 ' + it.copies + ' 次' + (it.reports ? ' · 被举报 ' + it.reports + ' 次' : '') + '</span>' +
        (it.mine
          ? '<button class="btn ghost sm" data-uncshare="' + it.id + '" type="button">' + (gone ? '删除' : '撤下') + '</button>'
          : '<button class="btn ghost sm" data-report="' + it.id + '" type="button">举报</button>') +
        (gone ? '' : '<button class="btn sm primary" data-copy="' + it.id + '" type="button">取用</button>') +
        '</div></div>';
    }).join('');
  }

  async function openShareToPool() {
    // 先把可选素材拉齐（练习卷列表），否则分享弹窗里没法选卷
    try { if (!exams.length) exams = (await api('/api/exams')).exams || []; } catch (e) {}
    openModal('分享到共享池',
      '<div class="pool-note">池子里<b>不会出现你的姓名</b>。署名只能是你自己填的昵称，跟空间名一样会被自动隐去。别人取用后会复制进他自己的空间，之后各改各的。</div>' +
      '<div class="lb-wrap"><label class="lb">分享什么</label><select class="sel" id="psKind" style="width:100%">' +
      '<option value="cards">知识卡</option><option value="words">单词表</option><option value="exam">练习卷</option><option value="note">一段笔记</option></select></div>' +
      '<div class="lb-wrap"><label class="lb">学科</label><select class="sel" id="psSubject" style="width:100%">' +
      '<option value="general">综合</option><option value="math">数学</option><option value="chinese">语文</option><option value="english">英语</option><option value="science">科学</option><option value="social">社会</option></select></div>' +
      '<div id="psExtra"></div>' +
      '<div class="lb-wrap"><label class="lb">标题（留空自动起名）</label><input class="inp" id="psTitle" maxlength="60"></div>' +
      '<div class="lb-wrap"><label class="lb">署名昵称（可留空，默认「一位同学」）</label><input class="inp" id="psNick" maxlength="20"></div>' +
      '<div id="psFb"></div>' +
      '<div class="pc-acts"><button class="btn primary sm" id="psGo" type="button">分享出去</button></div>');
    renderPsExtra('cards');
    $('#psKind').addEventListener('change', e => renderPsExtra(e.target.value));
    $('#psGo').addEventListener('click', doShareToPool);
  }
  function renderPsExtra(kind) {
    const box = $('#psExtra');
    const lbl = t => '<label class="lb">' + t + '</label>';
    if (kind === 'note') {
      box.innerHTML = '<div class="lb-wrap">' + lbl('笔记内容') + '<textarea class="pc-input" id="psText" placeholder="比如：这道题我卡在哪、后来想通了什么"></textarea></div>';
    } else if (kind === 'words') {
      box.innerHTML = '<div class="lb-wrap">' + lbl('从哪个单元取（留空 = 全部单词，最多 200 个）') +
        '<select class="sel" id="psUnit" style="width:100%"><option value="">全部单词</option>' +
        ((S.en && S.en.units) || []).map(u => '<option value="' + u.id + '">' + HL.esc(u.name) + '（' + u.count + ' 个）</option>').join('') + '</select></div>';
    } else if (kind === 'exam') {
      box.innerHTML = '<div class="lb-wrap">' + lbl('分享哪张卷（含答案，等于一份带答案的练习）') +
        (exams.length
          ? '<select class="sel" id="psExam" style="width:100%">' + exams.map(e => '<option value="' + e.id + '">' + HL.esc(e.title) + '</option>').join('') + '</select>'
          : '<div class="dim" style="font-size:.82rem">你还没有测评卷。先去「测评」出一张。</div>') + '</div>';
    } else {
      box.innerHTML = '<div class="pool-note" style="padding:0 0 8px">会把最近收下的知识卡打包分享（最多 40 张）。想让内容更集中，先去「知识卡」里按学科筛一筛。</div>';
    }
  }
  async function doShareToPool() {
    const kind = $('#psKind').value;
    const body = { kind: kind, subject: $('#psSubject').value, title: $('#psTitle').value, nickname: $('#psNick').value };
    if (kind === 'note') body.text = ($('#psText') || {}).value || '';
    if (kind === 'words' && $('#psUnit') && $('#psUnit').value) {
      const ws = (S.en && S.en.words) || [];
      body.wordIds = ws.filter(w => w.unitId === $('#psUnit').value).map(w => w.id);
      if (!body.wordIds.length) { try { const r = await api('/api/english/words?unitId=' + $('#psUnit').value); body.wordIds = r.words.map(w => w.id); } catch (e) {} }
    }
    if (kind === 'exam') {
      if (!$('#psExam')) { toast('先去「测评」出一张卷'); return; }
      body.examId = $('#psExam').value;
    }
    const b = $('#psGo'); b.disabled = true; b.textContent = '分享中…';
    try {
      const r = await api('/api/pool', { method: 'POST', body: body });
      closeModal();
      toast('已分享，署名：' + r.item.authorName);
      // 分享完必须刷新当前列表 —— 否则刚放上去的东西不在眼前，
      // 看起来像"分享没成功"，用户会再点一次。
      $('#poolList').dataset.ready = '';
      await loadPool();
    } catch (e) {
      $('#psFb').innerHTML = '<div class="pc-fb bad">' + HL.esc(e.message) + '</div>';
    }
    b.disabled = false; b.textContent = '分享出去';
  }
  async function copyFromPool(id) {
    try {
      const r = await api('/api/pool/' + id + '/copy', { method: 'POST', body: {} });
      const m = r.made || {};
      const parts = [];
      if (m.cards) parts.push(m.cards + ' 张知识卡');
      if (m.words) parts.push(m.words + ' 个单词');
      if (m.note) parts.push('一段笔记（' + m.note + ' 字）');
      toast(parts.length ? '已复制：' + parts.join('、') : '已复制');
      await Promise.all([loadPool(), loadCardSummary(), loadPet(), loadEn()]);
    } catch (e) { toast(e.message); }
  }
  function reportPool(id) {
    openModal('举报这条资料', '<div class="pool-note">举报是给"放错了地方"的东西用的（广告、跟学习无关、明显抄错）。累计 3 次会自动下架，不做人工排队审核。</div>' +
      '<div class="lb-wrap"><label class="lb">原因（可留空）</label><input class="inp" id="rpWhy" maxlength="200" placeholder="比如：跟学习无关"></div>' +
      '<div class="pc-acts"><button class="btn primary sm" id="rpGo" type="button">提交举报</button></div>');
    $('#rpGo').addEventListener('click', async () => {
      try {
        const r = await api('/api/pool/' + id + '/report', { method: 'POST', body: { reason: $('#rpWhy').value } });
        closeModal(); toast(r.message); await loadPool();
      } catch (e) { toast(e.message); }
    });
  }
  async function unsharePool(id, hard) {
    try {
      await api('/api/pool/' + id, { method: 'DELETE' });
      toast('已撤下'); await loadPool();
    } catch (e) { toast(e.message); }
  }

  // ================= 知识库（主工作区）=================
  // 结构对齐对标产品：左边是"本子"（分类树，每个本子有容量），
  // 右边是状态 Tab（全部 / 已就绪 / 解析中 / 需处理）+ 文档行（名称 · 大小 · 日期 · 状态）。
  let kbCat = '';        // '' = 全部资料；'__none__' = 未归类；其余是分类 id
  let kbState = '';      // '' | ready | parsing | todo
  let kbHits = null;
  const NONE = '__none__';
  const TEXT_EXT = ['txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'log', 'js', 'ts', 'py', 'html', 'htm', 'xml', 'yml', 'yaml', 'sql', 'css'];

  function fmtSize(n) {
    n = Number(n) || 0;
    if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
    if (n >= 1024) return (n / 1024).toFixed(1) + ' KB';
    return n + ' B';
  }
  function fmtDate(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    return d.getFullYear() + '/' + (d.getMonth() + 1) + '/' + d.getDate();
  }
  /** 当前本子里的文档（未归类 = 没有本子，或本子已被删掉） */
  function inCurrentCat(d) {
    if (!kbCat) return true;
    if (kbCat === NONE) return !d.categoryId || !(S.kbCats || []).some(c => c.id === d.categoryId);
    return d.categoryId === kbCat;
  }
  function catList() { return (S.kbDocs || []).filter(inCurrentCat); }

  let kbPollTimer = null;
  let kbPollLeft = 0;
  /**
   * 有资料在识别时自动刷新列表。
   * 扫描件要识别几分钟到几十分钟，让用户手动点刷新等于没做 —— 识别完自己变成「已就绪」才对。
   * ★ 上限必须**比后端任务上限还长**：服务端 `JOB_MAX_MS.ocr` 是 45 分钟，
   *   一本 130 页的书实测要 20 分钟左右（限流时会更久）。原来按 400 次（20 分钟）封顶，
   *   正好卡在识别差不多的时刻 —— 表现是"进度条停住不动了"，看着像卡死。
   *   现在给到 1100 次（约 55 分钟）留出余量；真正的兜底是服务端的对账：
   *   任务被清掉后文档会被捞成可重试，`parsing` 不会永远转下去。
   */
  function scheduleKbPoll(hasParsing) {
    if (kbPollTimer) { clearTimeout(kbPollTimer); kbPollTimer = null; }
    if (!hasParsing) { kbPollLeft = 0; return; }
    if (kbPollLeft <= 0) kbPollLeft = 1100;
    kbPollLeft--;
    kbPollTimer = setTimeout(() => { kbPollTimer = null; loadKb(true); }, 3000);
  }

  async function loadKb(silent) {
    try {
      const [cats, docs] = await Promise.all([api('/api/kb/categories'), api('/api/kb/documents')]);
      S.kbCats = cats.categories || [];
      S.kbUncat = cats.uncategorized || 0;
      if (cats.defaults) S.kbCapa = cats.defaults;
      S.kbDocs = docs.documents || [];
      renderKbTree();
      renderKbState();
      renderKbList();
      scheduleKbPoll((S.kbDocs || []).some(d => d.state === 'parsing'));
    } catch (e) { if (!silent) toast(e.message); }
  }

  function treeRow(id, name, docs, cap) {
    const on = kbCat === id;
    const full = cap && docs >= cap;
    const capTxt = cap ? '容量 ' + docs + '/' + cap : (id === NONE ? '不占容量' : '');
    return '<div class="kb-tree-i' + (on ? ' on' : '') + '" data-cat="' + esc(id) + '">' +
      '<span class="kt-n">' + esc(name) + '</span>' +
      (capTxt ? '<span class="kt-c' + (full ? ' full' : '') + '">' + capTxt + '</span>' : '') +
      // 满了才给"扩容"：没满就放个按钮，等于怂恿学生不停扩容，容量就失去意义了
      (full ? '<button class="kt-x" data-expand="' + esc(id) + '" type="button" title="把这个本子的容量加大">扩容</button>' : '') +
      '</div>';
  }
  function renderKbTree() {
    const c = S.kbCats || [];
    $('#kbTreeList').innerHTML =
      treeRow('', '全部资料', (S.kbDocs || []).length, 0) +
      treeRow(NONE, '未归类', S.kbUncat, 0) +
      c.map(x => treeRow(x.id, x.name, x.docs, x.capacity)).join('');
    $('#kbTreeFoot').innerHTML = c.length
      ? '<div class="dim">共 ' + c.length + ' 个本子 · 单个上限 ' + (S.kbCapa.maxCapacity || 200) + ' 份</div>'
      : '<div class="dim">还没有本子。点右上角「＋」新建一个，比如「数学」「错题本」。</div>';
  }
  /** Tab 上的 data-state="all" 是给读代码的人看的，过滤时它就是"不限" */
  function tabState(s) { return (!s || s === 'all') ? '' : s; }
  function renderKbState() {
    const list = catList();
    const n = { all: list.length, ready: 0, parsing: 0, todo: 0 };
    list.forEach(d => { if (n[d.state] != null) n[d.state]++; });
    $$('#kbState .kb-state-i').forEach(b => b.classList.toggle('on', tabState(b.dataset.state) === kbState));
    $$('#kbState b[data-n]').forEach(b => { b.textContent = n[b.dataset.n] || 0; });
  }
  const STATE_CHIP = { ready: 'mastered', parsing: 'learning', todo: 'almost' };
  function renderKbList() {
    const box = $('#kbList');
    if (kbHits) {
      box.innerHTML = kbHits.length
        ? '<div class="dim" style="font-size:.8rem;padding:2px 2px 6px">在资料里找到 ' + kbHits.length + ' 段相关内容 · <button class="land-link" id="kbClearSearch" type="button">清除搜索</button></div>' +
        kbHits.map(h =>
          '<div class="hit-i"><div class="h-f">《' + HL.esc(h.filename) + '》第 ' + (h.chunkIndex + 1) + ' 段 · 相关度 ' + h.score + '</div>' +
          HL.esc(h.text).slice(0, 400) + '</div>').join('')
        : '<div class="empty" style="padding:6vh 20px"><p>没找到相关内容。</p><p class="dim">换个说法试试，或者先把资料传上来。</p></div>';
      return;
    }
    const list = catList().filter(d => !kbState || d.state === kbState);
    if (!list.length) {
      box.innerHTML = '<div class="empty" style="padding:6vh 20px"><p>' +
        (kbState ? '这个状态下没有资料。'
          : kbCat === NONE ? '没有未归类的资料。'
            : kbCat ? '这个本子还是空的。' : '还没有资料。') + '</p>' +
        '<p class="dim">把你的资料传进来 —— 讲义、笔记、试卷、随堂记录都行。AI 讲的时候会引用它们，并说明出自哪一份。</p></div>';
      return;
    }
    box.innerHTML = list.map(d =>
      '<div class="doc-i' + (d.state === 'todo' ? ' bad' : '') + '" data-id="' + d.id + '">' +
      '<div><b>' + esc(d.filename) + '</b>' +
      '<div class="dim">' + fmtSize(d.size) +
      (d.pages ? ' · ' + d.pages + ' 页' : '') +
      (d.textLength ? ' · 抽出 ' + d.textLength + ' 字' : '') +
      ' · ' + fmtDate(d.createdAt) +
      (d.projects.length ? ' · 已挂到 ' + d.projects.map(p => esc(p.name)).join('、') : '') +
      '</div>' +
      (d.error ? '<div class="doc-err">' + esc(d.error) + '</div>' : '') +
      // 扫描件识别中：告诉用户"在动、走到哪了、大概还要多久"。
      // 一本 130 页的书要几分钟，只给个转圈会让人以为它卡死了。
      (d.state === 'parsing'
        ? '<div class="doc-prog"><i style="width:' + Math.max(3, Math.min(100, d.progress || 0)) + '%"></i></div>' +
          '<div class="doc-prog-t">AI 正在逐页识别文字' + (d.pages ? ' · 共 ' + d.pages + ' 页' : '') +
          (d.progress ? ' · ' + d.progress + '%' : '') + '</div>'
        : '') +
      '</div>' +
      '<span class="chip ' + (STATE_CHIP[d.state] || 'learning') + '">' +
      (d.state === 'parsing' && d.progress ? '识别中 ' + d.progress + '%' : esc(d.stateText)) + '</span>' +
      (d.state === 'ready' ? '<button class="btn sm" data-doc="view" type="button">看全文</button>' : '') +
      (d.state === 'todo' ? '<button class="btn sm" data-doc="reparse" type="button">' +
        (d.kind === 'pdf' ? '重新识别' : '重新解析') + '</button>' : '') +
      '<button class="btn ghost sm" data-doc="proj" type="button">加入项目</button>' +
      '<button class="btn ghost sm" data-doc="move" type="button">移到…</button>' +
      '<button class="btn ghost sm" data-doc="del" type="button">删除</button>' +
      '</div>').join('');
  }
  /** 移到别的本子：列出所有本子（+ 未归类）让它选 */
  async function moveDocModal(doc) {
    const opts = (S.kbCats || []).map(c =>
      '<option value="' + esc(c.id) + '"' + (doc.categoryId === c.id ? ' selected' : '') + '>' +
      esc(c.name) + '（容量 ' + c.docs + '/' + c.capacity + '）</option>').join('');
    openModal('把《' + doc.filename + '》移到',
      '<div class="field"><label>目标本子</label><select class="sel" id="mvCat" style="width:100%">' +
      '<option value="">未归类</option>' + opts + '</select></div>' +
      '<div class="dim" style="font-size:.78rem">本子满了会拒绝移入，先扩容。</div>' +
      '<div class="pc-acts"><span class="sp"></span><button class="btn primary" id="mvSave" type="button">移过去</button></div>');
    $('#mvSave').addEventListener('click', async () => {
      const cid = $('#mvCat').value;
      try {
        await api('/api/kb/documents/' + doc.id + '/move', { method: 'POST', body: { categoryId: cid || null } });
        closeModal(); loadKb(); toast('已移动');
      } catch (e) { toast(e.message); }
    });
  }

  /**
   * 把一份资料挂到哪些项目（多选，保存时只发差异）。
   *
   * 语义：挂进项目 **不等于"只有这个项目能用"**，而是"这个项目的对话优先用它" ——
   * 项目里一段都没检索到时，服务端仍会退回全库。所以文案写"优先"，不写"限定"。
   */
  async function docProjectsModal(doc) {
    let projects = S.projects || [];
    if (!projects.length) {
      // 拉不到就和"没有项目"混为一谈会出事：那种情况下点保存会把已挂的项目全摘掉。
      try { const r = await api('/api/projects'); projects = r.projects || []; S.projects = projects; }
      catch (e) { toast('项目列表没拉到，稍后再试'); return; }
    }
    const have = (doc.projects || []).map(p => p.id);
    const list = projects.length
      ? '<div class="ag-list" id="dpList">' + projects.map(p =>
          '<button class="ag-i' + (have.indexOf(p.id) >= 0 ? ' on' : '') + '" data-pj="' + esc(p.id) + '" type="button">' +
          '<b>' + esc(p.name) + '</b><span>' + (p.conversationCount || 0) + ' 条对话 · 资料 ' + (p.docs || []).length + ' 份</span></button>').join('') +
        '</div>'
      : '<div class="dim" style="font-size:.85rem">还没有项目。项目 = 一组资料 + 一条学习指令，比如「这学期物理」。</div>';
    openModal('把《' + doc.filename + '》放进项目',
      list +
      '<div class="dim" style="font-size:.78rem;margin-top:8px">挂进项目后，这个项目的对话会优先用这份资料；项目里没找到时，仍会去整个知识库找。</div>' +
      '<div class="pc-acts"><span class="sp"></span><button class="btn primary" id="dpSave" type="button">保存</button></div>');
    $$('#dpList .ag-i').forEach(b => b.addEventListener('click', () => b.classList.toggle('on')));
    $('#dpSave').addEventListener('click', async () => {
      const want = $$('#dpList .ag-i.on').map(b => b.dataset.pj);
      const add = want.filter(x => have.indexOf(x) < 0);
      const del = have.filter(x => want.indexOf(x) < 0);
      try {
        for (const pid of add) await api('/api/kb/attach', { method: 'POST', body: { docId: doc.id, projectId: pid, on: true } });
        for (const pid of del) await api('/api/kb/attach', { method: 'POST', body: { docId: doc.id, projectId: pid, on: false } });
        closeModal(); loadKb(); loadProjects();
        toast(add.length || del.length ? '已更新挂载' : '没有变化');
      } catch (e) { toast(e.message); }
    });
  }

  async function newCatModal() {
    openModal('新建本子',
      '<div class="field"><label>本子名字</label><input id="ncName" maxlength="40" placeholder="如：数学、错题本、这学期物理"></div>' +
      '<div class="field"><label>容量（最多放几份）</label><input id="ncCap" type="number" min="1" max="' + (S.kbCapa.maxCapacity || 200) + '" value="' + (S.kbCapa.capacity || 5) + '"></div>' +
      '<div class="dim" style="font-size:.78rem">容量不是限制你，是提醒你：一个本子堆太满，翻的时候就找不到了。随时能扩容。</div>' +
      '<div class="pc-acts"><span class="sp"></span><button class="btn primary" id="ncSave" type="button">创建</button></div>');
    $('#ncSave').addEventListener('click', async () => {
      const name = $('#ncName').value, cap = Number($('#ncCap').value) || 0;
      try {
        await api('/api/kb/categories', { method: 'POST', body: { name: name, capacity: cap } });
        closeModal(); await loadKb(); toast('本子建好了');
      } catch (e) { toast(e.message); }
    });
  }
  async function uploadFiles(files) {
    const arr = Array.from(files || []);
    if (!arr.length) return;
    let okN = 0, badN = 0;
    for (let i = 0; i < arr.length; i++) {
      const f = arr[i];
      toast('正在上传 ' + (i + 1) + '/' + arr.length + '：' + f.name, 60000);
      try {
        const ext = (f.name.split('.').pop() || '').toLowerCase();
        // 在"未归类"里上传就真的不挂本子 —— 不然它会被静默塞进某个本子，跟 UI 说的不一样
        let body = { filename: f.name, categoryId: (kbCat && kbCat !== NONE) ? kbCat : undefined };
        if (TEXT_EXT.indexOf(ext) >= 0) {
          body.text = await f.text();
        } else {
          body.dataBase64 = await new Promise((res, rej) => {
            const fr = new FileReader();
            fr.onload = () => res(String(fr.result).replace(/^data:[^;]+;base64,/, ''));
            fr.onerror = () => rej(new Error('读取文件失败'));
            fr.readAsDataURL(f);
          });
        }
        const r = await fetch('/api/kb/documents?_t=' + encodeURIComponent(S.token), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + S.token },
          body: JSON.stringify(body),
        });
        const j = await r.json().catch(() => ({}));
        if (r.ok) okN++;
        else {
          badN++;
          // 明确告诉用户为什么失败，以及该怎么办
          toast(f.name + '：' + (j.document && j.document.error ? j.document.error : (j.message || '上传失败')), 5200);
        }
      } catch (e) { badN++; toast(f.name + '：' + e.message, 4000); }
    }
    if (okN) toast('上传完成：成功 ' + okN + ' 份' + (badN ? '，失败 ' + badN + ' 份' : ''));
    loadKb();
  }

  // ================= 项目 =================
  async function loadProjects() {
    try {
      const r = await api('/api/projects');
      S.projects = r.projects || [];
      const box = $('#projList');
      if (!S.projects.length) {
        box.innerHTML = '<div class="empty" style="padding:8vh 20px"><p>还没有项目。</p>' +
          '<p class="dim">项目 = 一组资料 + 一条学习指令。比如「这学期物理」+「先用问题引导我，别直接讲」。</p></div>';
        return;
      }
      box.innerHTML = S.projects.map(p =>
        '<div class="row-card" data-id="' + p.id + '"><div><b>' + HL.esc(p.name) + '</b>' +
        '<div class="dim">' + (p.instructions ? HL.esc(p.instructions.slice(0, 60)) : '还没有学习指令') +
        ' · 资料 ' + p.docs.length + ' 份 · 对话 ' + (p.conversationCount || 0) + ' 条</div></div>' +
        '<button class="btn sm" data-p="open" type="button" title="看看这个项目里的对话">对话 ' + (p.conversationCount || 0) + '</button>' +
        '<button class="btn sm" data-p="edit" type="button">编辑</button>' +
        '<button class="btn ghost sm" data-p="del" type="button">删除</button></div>').join('');
    } catch (e) { toast(e.message); }
  }
  async function projectModal(p, opts) {
    const o = opts || {};
    // 「资料」区得知道知识库里有什么。S.kbDocs 只有进过知识库页才被填过，
    // 从项目页直接点进来的话它是空的 —— 那样用户会以为"我明明传了资料"。
    // 所以这里自己拉一次。
    let docs = [], docsOk = false;
    try { const r = await api('/api/kb/documents'); docs = r.documents || []; S.kbDocs = docs; docsOk = true; } catch (e) {}
    const picked = p ? (p.docs || []).map(d => d.id) : [];
    const docBox = docs.length
      ? '<div class="ag-list" id="pjDocs" style="max-height:30vh;overflow:auto">' +
        docs.map(d => '<button class="ag-i' + (picked.indexOf(d.id) >= 0 ? ' on' : '') + '" data-doc="' + esc(d.id) + '" type="button">' +
          '<b>' + esc(d.filename) + '</b><span>' + (d.state === 'ready' ? '可以检索' : esc(d.stateText || '还没解析好')) +
          ((d.projects || []).length ? ' · 已在 ' + d.projects.length + ' 个项目' : '') + '</span></button>').join('') +
        '</div>' +
        '<div class="dim" style="font-size:.8rem;margin-top:6px">已选 <b id="pjDocN">' + picked.length + '</b> 份 · 点一下切换</div>'
      : '<div class="dim" style="font-size:.85rem">知识库里还没有资料。先去「知识库」把你的资料传上来，再回来挂给这个项目。</div>';
    openModal(p ? '编辑项目' : '新建项目',
      '<div class="field"><label>项目名称</label><input id="pjName" maxlength="40" value="' + (p ? HL.esc(p.name) : '') + '" placeholder="如：这学期物理"></div>' +
      '<div class="field"><label>学习指令</label><textarea class="pc-input" id="pjIns" style="min-height:6em" placeholder="如：先用问题引导我，别直接讲；每讲完一段让我自己复述">' + (p ? HL.esc(p.instructions) : '') + '</textarea></div>' +
      '<div class="field"><label>这个项目用哪些资料</label>' + docBox + '</div>' +
      '<div class="pc-acts"><span class="sp"></span><button class="btn primary" id="pjSave" type="button">保存</button></div>');
    $$('#pjDocs .ag-i').forEach(b => b.addEventListener('click', () => {
      b.classList.toggle('on');
      const n = $('#pjDocN'); if (n) n.textContent = $$('#pjDocs .ag-i.on').length;
    }));
    $('#pjSave').addEventListener('click', async () => {
      const body = { name: $('#pjName').value.trim(), instructions: $('#pjIns').value.trim() };
      // ★ 只有"确实拉到资料列表"才提交 docIds。拉失败时列表是空的，
      //   跟着提交 [] 会把已有项目挂的资料**静默清空** —— 这种损失用户根本发现不了。
      if (docsOk) body.docIds = $$('#pjDocs .ag-i.on').map(b => b.dataset.doc);
      if (!body.name) { toast('项目名称不能为空'); return; }
      try {
        let created = null;
        if (p) await api('/api/projects/' + p.id, { method: 'PATCH', body: body });
        else created = await api('/api/projects', { method: 'POST', body: body });
        closeModal();
        // ★ 左栏（项目树）和「项目」视图是两套渲染，各刷各的。
        //   之前只调了 loadProjects()，左栏要手动刷新才看得到新项目 —— 就是这里漏的。
        await loadSide();
        loadProjects();
        if (!p && created && created.project && o.select) {
          // 从对话顶部的项目下拉里「＋ 新建项目…」进来的：建完直接归入它，
          // 否则用户建完还得再选一次，等于白建。
          S.pendingProjectId = created.project.id;
          renderProjectSel(created.project.id);
          const st = $('#convSubText');
          if (st) st.textContent = '新对话 · 将归入「' + projName(created.project.id) + '」';
          toast('已新建并归入「' + body.name + '」');
        } else {
          toast(p ? '已保存' : '已创建「' + body.name + '」');
        }
      } catch (e) { toast(e.message); }
    });
  }

  /** 项目视图 → 点「对话 N」：列出这个项目下的全部对话，点开即聊 */
  async function openProjectConvs(pid, name) {
    let list = [];
    try {
      const r = await api('/api/conversations?projectId=' + encodeURIComponent(pid));
      list = r.conversations || [];
    } catch (e) { toast(e.message); }
    const rows = list.length
      ? list.map(c =>
          '<div class="row-card" data-conv="' + esc(c.id) + '"><div><b>' + esc(c.title || '新对话') + '</b>' +
          '<div class="dim">' + (c.messageCount || 0) + ' 条消息 · ' + fmtTime(c.updatedAt) + '</div></div>' +
          '<button class="btn sm" type="button">打开</button></div>').join('')
      : '<div class="empty" style="padding:5vh 20px"><p>这个项目下还没有对话。</p>' +
        '<p class="dim">点下面「新建对话」，或把已有对话用「⋯ → 移动到项目」放进来。</p></div>';
    openModal('「' + (name || '项目') + '」的对话（' + list.length + '）',
      '<div class="card-list" id="pjConvs">' + rows + '</div>' +
      '<div class="pc-acts"><span class="sp"></span>' +
      '<button class="btn primary" id="pjNewConv" type="button">在这个项目里新建对话</button></div>');
    $('#pjNewConv').addEventListener('click', () => {
      closeModal();
      newConv({ projectId: pid });
      toast('新对话已归入「' + (name || '项目') + '」，发第一条消息即创建');
    });
    $('#pjConvs').addEventListener('click', ev => {
      const row = ev.target.closest('[data-conv]'); if (!row) return;
      closeModal();
      openConv(row.dataset.conv);
    });
  }

  /**
   * 左栏项目行右侧的 ⋯：编辑 / 新建对话 / 删除。
   * 删除时项目下的对话**退回「未归入项目」而不是被删掉** ——
   * 删一个"分组"不该顺手毁掉里面的内容，这个代价用户事前想不到。
   */
  function openProjMenu(pid) {
    const p = (S.projects || []).filter(x => x.id === pid)[0];
    if (!p) return;
    const n = (S.convs || []).filter(c => c.projectId === pid).length;
    openModal('「' + p.name + '」',
      '<div class="card-list">' +
      '<div class="row-card" data-pm="edit"><div><b>编辑项目</b><div class="dim">改名字、改学习指令</div></div><button class="btn sm" type="button">编辑</button></div>' +
      '<div class="row-card" data-pm="newconv"><div><b>在这个项目里新建对话</b><div class="dim">新建的对话会自动归入这个项目</div></div><button class="btn sm" type="button">新建</button></div>' +
      '<div class="row-card" data-pm="del"><div><b>删除项目</b><div class="dim">' +
      (n ? '项目里的 ' + n + ' 条对话会退回「未归入项目」，不会被删掉' : '项目里还没有对话') +
      '</div></div><button class="btn ghost sm" type="button">删除</button></div>' +
      '</div>');
    $$('#modalBody [data-pm]').forEach(el => el.addEventListener('click', async () => {
      const k = el.dataset.pm;
      if (k === 'edit') { closeModal(); projectModal(p); return; }
      if (k === 'newconv') { closeModal(); newConv({ projectId: pid }); return; }
      if (k === 'del') {
        if (!confirm('确定删除项目「' + p.name + '」？' +
          (n ? '\n里面的 ' + n + ' 条对话会退回「未归入项目」，不会被删掉。' : ''))) return;
        try {
          await api('/api/projects/' + pid, { method: 'DELETE' });
          closeModal(); loadSide(); loadProjects(); toast('已删除项目');
        } catch (e) { toast(e.message); }
      }
    }));
  }

  // ================= 记忆 =================
  async function loadMemory() {
    try {
      const r = await api('/api/memory');
      S.memory = r;
      $('#memToggle').checked = !!r.enabled;
      const box = $('#memList');
      if (!r.memories.length) {
        box.innerHTML = '<div class="empty" style="padding:6vh 20px"><p>还没有记忆。</p><p class="dim">加一条，AI 在之后的对话里会一直记得。</p></div>';
        return;
      }
      box.innerHTML = r.memories.map(m =>
        '<div class="row-card"><div><b>' + HL.esc(m.content) + '</b><div class="dim">' + fmtTime(m.createdAt) + '</div></div>' +
        '<button class="btn ghost sm" data-mem="' + m.id + '" type="button">删除</button></div>').join('');
    } catch (e) { toast(e.message); }
  }

  // ================= 宠物 =================
  async function loadPet(pulse) {
    try {
      const r = await api('/api/pet');
      const prev = S.pet;
      S.pet = r.pet;
      // 宠物阶段同时是**功能解锁的门槛**（见 server/pet.js 的 UNLOCKS）：
      // 解锁集变了，知识库分区条要重画，否则刚解锁的功能还挂着一把锁。
      const before = S.unlocks ? (S.unlocks.unlocked || []).join(',') : '';
      S.unlocks = r.unlocks || null;
      const after = S.unlocks ? (S.unlocks.unlocked || []).join(',') : '';
      if (before !== after && $('#kbTabs')) renderKbTabs();
      const p = r.pet;
      const pct = p.maxed ? 100 : Math.round(Math.min(1, p.growth / (p.nextNeed || 1)) * 100);
      const line = $('#petLine');
      const nx = r.unlocks && r.unlocks.next;
      // 宠物条不只是进度条，它同时是"下一步做什么"的提示牌 ——
      // 所以把"再攒 N 点能解锁什么"直接写在上面，而不是藏在某个说明页里。
      line.innerHTML = petIcon(p.stage) +
        '<span>' + HL.esc(p.stageName) +
        (p.maxed ? ' · 已长成'
                 : ' · 还差 ' + p.toNext + ' 点' +
                   (nx && nx.labels && nx.labels.length ? '解锁 ' + HL.esc(nx.labels.join('、')) : '')) +
        '</span>' +
        '<span class="pet-bar"><i style="width:' + pct + '%"></i></span>';
      // 成长值真的涨了才亮一下。只是刷新页面不该有动效 ——
      // 那会把"没变化"也演成"有变化"，动效就变成了噪音。
      if (pulse && prev && p.growth > prev.growth) {
        line.classList.remove('up');
        void line.offsetWidth;   // 强制重排，否则连续两次加分不会重放动画
        line.classList.add('up');
        setTimeout(() => line.classList.remove('up'), 800);
      }
    } catch (e) {}
  }

  // ================= 设置 =================
  // ================= 头像（原生 SVG，不引图片资源）=================
  // 形状 + 颜色，9 款。全部用 SVG 路径画 —— 需要被识别/复用的图形走 SVG，这条线不越。
  const AV_SHAPES = {
    wave: '<path d="M4 20c4-6 8-6 12 0s8 6 12 0" fill="none" stroke="{C}" stroke-width="2.2" stroke-linecap="round"/>',
    beam: '<path d="M11 27l2-16h6l2 16z" fill="none" stroke="{C}" stroke-width="2" stroke-linejoin="round"/><path d="M5 10l6-2M27 10l-6-2" stroke="{C}" stroke-width="2" stroke-linecap="round"/>',
    star: '<path d="M16 6l2.9 6.4 6.6.7-4.9 4.5 1.4 6.5-6-3.4-6 3.4 1.4-6.5L6.5 13l6.6-.7z" fill="none" stroke="{C}" stroke-width="1.8" stroke-linejoin="round"/>',
    leaf: '<path d="M16 26C8 22 8 12 16 6c8 6 8 16 0 20z" fill="none" stroke="{C}" stroke-width="2" stroke-linejoin="round"/><path d="M16 9v16" stroke="{C}" stroke-width="1.5" stroke-linecap="round"/>',
    drop: '<path d="M16 6c5 6 7 9 7 12a7 7 0 01-14 0c0-3 2-6 7-12z" fill="none" stroke="{C}" stroke-width="2" stroke-linejoin="round"/>',
    peak: '<path d="M4 25l8-14 5 8 3-4 8 10z" fill="none" stroke="{C}" stroke-width="2" stroke-linejoin="round"/>',
    sun: '<circle cx="16" cy="16" r="6" fill="none" stroke="{C}" stroke-width="2"/><path d="M16 3v3M16 26v3M3 16h3M26 16h3M7 7l2 2M23 23l2 2M25 7l-2 2M9 23l-2 2" stroke="{C}" stroke-width="1.7" stroke-linecap="round"/>',
    moon: '<path d="M21 6a11 11 0 100 20 9 9 0 010-20z" fill="none" stroke="{C}" stroke-width="2" stroke-linejoin="round"/>',
    grid: '<path d="M6 6h8v8H6zM18 6h8v8h-8zM6 18h8v8H6zM18 18h8v8h-8z" fill="none" stroke="{C}" stroke-width="1.7" stroke-linejoin="round"/>',
  };
  function avatarSvg(shape, color) {
    const body = (AV_SHAPES[shape] || AV_SHAPES.grid).replace(/\{C\}/g, color);
    return '<svg viewBox="0 0 32 32" aria-hidden="true">' +
      '<rect width="32" height="32" fill="' + color + '" opacity=".14"/>' + body + '</svg>';
  }

  let AVATARS = [];
  async function loadAvatars() {
    if (AVATARS.length) return;
    try { const r = await fetch('/api/avatars').then(x => x.json()); AVATARS = r.avatars || []; } catch (e) {}
  }

  function renderSettings() {
    const me = S.me || {};
    const sp = me.space || {};
    const pr = me.profile;

    // —— 个人资料（账号登录才有）——
    if (pr) {
      const bits = [];
      if (pr.stage || pr.grade) bits.push([pr.stage, pr.grade].filter(Boolean).join(' · '));
      if (pr.username) bits.push('@' + pr.username);
      if (pr.phone) bits.push(String(pr.phone).replace(/^(\d{3})\d{4}(\d{4})$/, '$1****$2'));
      const cur = AVATARS.filter(a => a.id === pr.avatarPreset)[0] || AVATARS[0] || null;
      const subs = pr.subjects || [];
      const goals = pr.goals || [];

      $('#profBox').innerHTML =
        '<div class="card-list">' +
        '<div class="row-card"><div class="prof-head"><div class="prof-av">' +
        (cur ? avatarSvg(cur.shape, cur.color) : '') + '</div><div><b>' +
        HL.esc(pr.name || pr.username || pr.phone || '学习者') + '</b><div class="dim">' +
        HL.esc(bits.join(' · ') || '账号已登录') + '</div></div></div></div>' +

        '<div class="row-card"><div style="width:100%"><b>头像</b><div class="dim">选一个就好，随时能换</div>' +
        '<div class="av-grid" id="avGrid">' + AVATARS.map(a =>
          '<button class="av-cell' + (a.id === pr.avatarPreset ? ' on' : '') + '" data-av="' + a.id + '" type="button">' +
          avatarSvg(a.shape, a.color) + '<span>' + HL.esc(a.name) + '</span></button>').join('') +
        '</div></div></div>' +

        '<div class="row-card"><div style="width:100%"><b>我在学</b><div class="dim">勾上的学科会优先出现在出卷与复习里</div>' +
        '<div class="chip-wrap" id="profSubjects">' + SUBJ_ORDER.map(k =>
          '<button class="chip-btn' + (subs.indexOf(k) >= 0 ? ' on' : '') + '" data-subj="' + k + '" type="button">' +
          HL.esc(SUBJ_NAME[k]) + '</button>').join('') + '</div></div></div>' +

        '<div class="row-card"><div style="width:100%"><b>我的目标</b><div class="dim">写下来，AI 会更贴近你的方向</div>' +
        '<div class="goal-list" id="profGoals">' + (goals.length
          ? goals.map((g, i) => '<div class="goal-item"><span class="gt">' + HL.esc(g) + '</span>' +
            '<button class="btn ghost sm" data-goal-del="' + i + '" type="button">删除</button></div>').join('')
          : '<div class="goal-empty">还没有写目标。写一条，比如「这学期把分数提上来」。</div>') + '</div>' +
        '<div class="card-bar" style="margin-top:8px"><input class="inp" id="goalInput" maxlength="120" placeholder="比如：这学期把分数提上来">' +
        '<button class="btn sm" id="goalAdd" type="button">添加</button></div></div></div>' +

        '<div class="row-card"><div style="width:100%"><b>修改密码</b><div class="dim">手机号注册的账号首次设置不需要原密码</div>' +
        '<div class="card-bar" style="margin-top:8px">' +
        '<input class="inp" id="pwOld" type="password" placeholder="原密码" autocomplete="current-password">' +
        '<input class="inp" id="pwNew" type="password" placeholder="新密码（至少 6 位）" autocomplete="new-password">' +
        '<button class="btn sm" id="pwSave" type="button">保存</button></div></div></div>' +
        '</div>';
      bindProfile();
    } else {
      $('#profBox').innerHTML =
        '<div class="card-list"><div class="row-card"><div><b>空间口令登录</b>' +
        '<div class="dim">没有个人资料。注册账号后才能设置头像、学科与目标，也能跨设备同步。</div></div>' +
        '<button class="btn sm" id="toAccount" type="button">去注册 / 登录</button></div></div>';
      $('#toAccount').addEventListener('click', () => {
        signOut(true); showLand();
        setTimeout(() => { const t = $$('.land-tab')[2]; if (t) t.click(); }, 60);
      });
    }

    // —— 空间 / 主题 / 字号 / 退出 ——
    $('#setList').innerHTML =
      '<div class="row-card"><div><b>' + HL.esc(sp.name || '') + '</b>' +
      '<div class="dim">空间 ID：' + HL.esc(sp.id || '') + ' · ' + (pr ? '账号：' + HL.esc(pr.name || pr.username || '') : '空间口令登录') + '</div></div>' +
      '<button class="btn sm" id="copySpace" type="button">复制 ID</button>' +
      '<button class="btn sm" id="switchSpace2" type="button">切换空间</button></div>' +
      '<div class="row-card"><div><b>主题</b><div class="dim">浅色 / 深色</div></div>' +
      '<div class="seg" id="themeSeg"><button data-theme="light" type="button">浅色</button><button data-theme="dark" type="button">深色</button></div></div>' +
      '<div class="row-card"><div><b>字号</b><div class="dim">按学段选，孩子看得舒服</div></div>' +
      '<div class="seg" id="fontSeg"><button data-font="sm" type="button">小学低</button><button data-font="md" type="button">小学高</button><button data-font="lg" type="button">初中以上</button></div></div>' +
      '<div class="row-card"><div><b>退出</b><div class="dim">回到空间门</div></div>' +
      '<button class="btn danger sm" id="signOut" type="button">退出登录</button></div>';

    applyTheme(document.documentElement.getAttribute('data-theme') || 'light');
    applyFont(document.documentElement.getAttribute('data-font') || 'md');
    $('#copySpace').addEventListener('click', () => copyText(sp.id || ''));
    $('#switchSpace2').addEventListener('click', () => signOut());
    $('#signOut').addEventListener('click', () => signOut());
  }

  function bindProfile() {
    const patch = async (body, msg) => {
      try {
        const r = await api('/api/me', { method: 'PATCH', body });
        S.me.profile = r.profile;
        renderSettings();
        if (msg) toast(msg);
      } catch (e) { toast(e.message); }
    };
    $$('#profBox [data-av]').forEach(b => b.addEventListener('click', () => patch({ avatarPreset: b.dataset.av }, '头像已换')));
    $$('#profBox [data-subj]').forEach(b => b.addEventListener('click', () => {
      const cur = (S.me.profile.subjects || []).slice();
      const k = b.dataset.subj;
      const i = cur.indexOf(k);
      if (i >= 0) cur.splice(i, 1); else cur.push(k);
      patch({ subjects: cur });
    }));
    const addGoal = () => {
      const v = $('#goalInput').value.trim();
      if (!v) return;
      patch({ goals: (S.me.profile.goals || []).concat([v]) }, '已添加');
    };
    $('#goalAdd').addEventListener('click', addGoal);
    $('#goalInput').addEventListener('keydown', e => { if (e.key === 'Enter') addGoal(); });
    $$('#profBox [data-goal-del]').forEach(b => b.addEventListener('click', () => {
      const cur = (S.me.profile.goals || []).slice();
      cur.splice(Number(b.dataset.goalDel), 1);
      patch({ goals: cur });
    }));
    $('#pwSave').addEventListener('click', async () => {
      const oldPassword = $('#pwOld').value, newPassword = $('#pwNew').value;
      if (newPassword.length < 6) { toast('新密码至少 6 位'); return; }
      try {
        await api('/api/auth/change-password', { method: 'POST', body: { oldPassword, newPassword } });
        $('#pwOld').value = ''; $('#pwNew').value = '';
        toast('密码已更新');
      } catch (e) { toast(e.message); }
    });
  }

  // ================= 公告 =================
  async function loadAnnouncements() {
    try {
      const r = await api('/api/announcements');
      const n = r.unreadImportant || 0;
      const b = $('#annBadge');
      b.hidden = n === 0;
      b.textContent = n > 99 ? '99+' : String(n);
      S.anns = r.announcements || [];
    } catch (e) { S.anns = S.anns || []; }
  }
  function openAnnouncements() {
    const list = S.anns || [];
    const body = list.length ? list.map(a =>
      '<div class="ann-item" data-ann="' + a.id + '">' +
      '<div class="ah">' + (a.read ? '' : '<span class="ann-unread"></span>') +
      (a.level === 'important' ? '<span class="ann-tag">重要</span>' : '') +
      '<b>' + HL.esc(a.title) + '</b></div>' +
      '<div class="ab">' + HL.esc(a.body || '') + '</div>' +
      '<div class="at">' + new Date(a.createdAt).toLocaleString('zh-CN') + '</div></div>').join('')
      : '<p class="dim">暂时没有公告。</p>';
    openModal('公告', body);
    // 打开即已读
    list.filter(a => !a.read && a.level === 'important').forEach(a => {
      api('/api/announcements/' + a.id + '/read', { method: 'POST' }).catch(() => {});
    });
    setTimeout(loadAnnouncements, 400);
  }

  // ================= 学习会话心跳 =================
  // 真实学习时长只能从这里来。登录次数、页面打开次数都不是学习时长。
  // 30 秒一次；服务端 60 秒内重复会被跳过，所以偶尔重复发也无所谓。
  let hbTimer = null;
  function startHeartbeat() {
    stopHeartbeat();
    api('/api/users/session/start', { method: 'POST' }).catch(() => {});
    hbTimer = setInterval(() => {
      if (document.hidden) return;
      api('/api/users/session/heartbeat', { method: 'POST' }).catch(() => {});
    }, 30000);
    document.addEventListener('visibilitychange', onVisible);
  }
  function onVisible() {
    if (document.hidden) {
      api('/api/users/session/end', { method: 'POST' }).catch(() => {});
    } else {
      api('/api/users/session/heartbeat', { method: 'POST' }).catch(() => {});
    }
  }
  function stopHeartbeat() {
    if (hbTimer) { clearInterval(hbTimer); hbTimer = null; }
  }

  // ================= 弹窗 =================
  /**
   * 弹窗。
   *
   * ★ 只清 innerHTML，不换节点。
   *   因为 bindApp 里有一份**全局**委托挂在 #modalBody 上（朗读按钮、听写模式、
   *   对话菜单、移动到项目）。换节点会把那份委托一起丢掉 ——
   *   表现是"第一次能用，第二次点没反应"，非常难查。
   *   所以：全局委托一律挂在稳定的 #mask / #modalBody 上，
   *   只在渲染函数里给"新建出来的子元素"挂的事件才是安全的。
   */
  function openModal(title, body) {
    $('#modalTitle').textContent = title;
    $('#modalBody').innerHTML = body;
    $('#mask').hidden = false;
  }
  function closeModal() { $('#mask').hidden = true; $('#modalBody').innerHTML = ''; practice = null; }

  // ================= 输入框自适应高度 =================
  function autoGrow() {
    const t = $('#input');
    t.style.height = 'auto';
    t.style.height = Math.min(t.scrollHeight, 160) + 'px';
  }

  // ================= 语音输入 =================
  function bindVoice() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    const mic = $('#mic'), hint = $('#voiceHint');
    if (!SR) {
      mic.addEventListener('click', () => toast('这个浏览器不支持语音输入，可以换个浏览器试试'));
      return;
    }
    let rec = null, on = false;
    mic.addEventListener('click', () => {
      if (on) { rec && rec.stop(); return; }
      rec = new SR();
      rec.lang = 'zh-CN';
      rec.continuous = true;
      rec.interimResults = true;
      let base = $('#input').value;
      rec.onstart = () => { on = true; mic.classList.add('on'); hint.textContent = '正在听…再点一下结束'; };
      rec.onresult = e => {
        let s = '';
        for (let i = e.resultIndex; i < e.results.length; i++) s += e.results[i][0].transcript;
        $('#input').value = (base + s).slice(0, 2000);
        autoGrow();
      };
      rec.onerror = e => { hint.textContent = '语音输入出错：' + (e.error || ''); };
      rec.onend = () => { on = false; mic.classList.remove('on'); hint.textContent = ''; $('#input').focus(); };
      try { rec.start(); } catch (e) { toast('无法启动语音输入'); }
    });
  }

  // ================= 事件绑定 =================
  function bindApp() {
    // 导航
    $$('.nav-i').forEach(b => b.addEventListener('click', () => switchView(b.dataset.view)));
    $$('.hamb').forEach(b => b.addEventListener('click', () => $('#side').classList.toggle('open')));
    // 移动端抽屉：点遮罩关闭。侧栏浮层打开时正好盖住汉堡按钮，
    // 只靠汉堡切换的话用户"打得开、关不上"。
    if ($('#sideMask')) $('#sideMask').addEventListener('click', () => $('#side').classList.remove('open'));
    $$('.me-chip').forEach(b => b.addEventListener('click', () => meMenu()));
    $('#switchSpace').addEventListener('click', () => { signOut(); });
    $('#spaceIdChip').addEventListener('click', () => copyText(S.space ? S.space.id : ''));
    $('#annBtn').addEventListener('click', openAnnouncements);
    // 知识库使用引导：点击关闭后记住，下次不再显示
    const kg = $('#kbGuide');
    if (kg) {
      try { if (localStorage.getItem('hl_kb_guide') === '1') kg.hidden = true; } catch (e) {}
      $('#kbGuideClose').addEventListener('click', () => { kg.hidden = true; try { localStorage.setItem('hl_kb_guide', '1'); } catch (e) {} });
    }

    // 对话
    $('#newProj').addEventListener('click', () => projectModal(null));
    $('#send').addEventListener('click', send);
    $('#stop').addEventListener('click', stopStream);
    $('#sideToggle').addEventListener('click', toggleSide);
    $('#agentBtn').addEventListener('click', openAgents);
    $('#convMenuBtn').addEventListener('click', openConvMenu);
    $('#webBtn').addEventListener('click', toggleWeb);
    $('#ttsBtn').addEventListener('click', openTtsSettings);
    $('#attachBtn').addEventListener('click', () => $('#attachFile').click());
    $('#attachFile').addEventListener('change', async e => {
      await pickAttach(e.target.files);
      e.target.value = '';
    });
    // 附件 / 临时资料都只在这里委托一次 —— 放进渲染函数里会随每次重绘累加监听器
    $('#attachPreview').addEventListener('click', ev => {
      const b = ev.target.closest('[data-rm]'); if (!b) return;
      S.pending.splice(Number(b.dataset.rm), 1);
      renderAttachPreview();
    });
    $('#tempDocs').addEventListener('click', async ev => {
      const b = ev.target.closest('[data-td]'); if (!b) return;
      try {
        await api('/api/temp-documents/' + b.dataset.td, { method: 'DELETE' });
        await loadTempDocs();
        toast('已移除');
      } catch (e) { toast(e.message); }
    });
    $('#input').addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
    });
    $('#input').addEventListener('input', autoGrow);
    // 直接粘贴图片/文件（Ctrl+V / 截图后粘贴）—— 上传入口里最傻瓜的一个：
    // 不用先存盘再点「＋」。**只有剪贴板里真有文件时才接管**，
    // 否则要放行纯文本粘贴（拦掉的话连字都打不进去）。
    $('#input').addEventListener('paste', e => {
      const cd = e.clipboardData;
      if (!cd) return;
      const files = [];
      const items = cd.items || [];
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        if (!it || it.kind !== 'file') continue;
        const f = it.getAsFile && it.getAsFile();
        if (f) files.push(f);
      }
      if (!files.length && cd.files) for (let i = 0; i < cd.files.length; i++) files.push(cd.files[i]);
      if (!files.length) return;                 // 纯文本 → 交给浏览器默认行为
      // ★ 剪贴板里**同时**有文字和文件时不能接管：从 Word / WPS / 网页复制题目，
      //   给出来的常常是「文字 + 同一段内容的渲染图」。一接管文字就被吞掉，
      //   用户以为发过去的是整段题目，实际只过去一张 AI 看不见的图 ——
      //   这正是"粘贴的文档 AI 没读"的另一半原因。有文字就放行文本粘贴。
      const plain = String((cd.getData ? cd.getData('text/plain') : '') || '').trim();
      if (plain) {
        if (files.length) toast('已按文字粘贴（剪贴板里还带了一张图，要插图请用「＋」选原文件）');
        return;
      }
      e.preventDefault();
      // 截图粘贴过来的 Blob 往往没有有意义的名字，一律叫 "image.png"，
      // 发多张就分不清哪张是哪张了 —— 按序号补个中文名。
      const named = files.map((f, i) => {
        if (f.name && f.name !== 'image.png' && f.name !== 'blob') return f;
        const t = String(f.type || '');
        const isImg = t.indexOf('image') === 0;
        // ★ 类型未知时**不能**默认当图片 —— 会被 pickAttach 的扩展名规则误判成图片送进图床。
        //   给 .bin 让它走文档那条路，宁可解析失败提示一句，也不要静默当成图。
        const ext = !isImg ? 'bin'
          : (t.indexOf('jpeg') >= 0 || t.indexOf('jpg') >= 0 ? 'jpg'
            : (t.indexOf('gif') >= 0 ? 'gif' : (t.indexOf('webp') >= 0 ? 'webp' : 'png')));
        return new File([f], '粘贴的' + (isImg ? '图片' : '文件') + (i ? '-' + (i + 1) : '') + '.' + ext, { type: f.type || '' });
      });
      toast('已读取剪贴板里的 ' + named.length + ' 个文件');
      pickAttach(named);
    });
    $('#stream').addEventListener('scroll', updateJump);
    // 空状态快捷卡：只**预填**，不直接发送。
    // 直接发等于替学生决定了怎么问，而"把问题说清楚"本身就是学习的一部分。
    // 用委托而不是逐卡绑定 —— renderStreamEmpty() 每次都会重写 innerHTML。
    $('#stream').addEventListener('click', ev => {
      const b = ev.target.closest ? ev.target.closest('.ec') : null;
      if (!b) return;
      const c = EMPTY_CARDS.filter(x => x.k === b.dataset.ec)[0];
      if (!c) return;
      const inp = $('#input');
      inp.value = c.p;
      // 派发 input 让 autoGrow 跟着长高（直接赋值 .value 不会触发）
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      inp.focus();
      try { inp.setSelectionRange(inp.value.length, inp.value.length); } catch (e) {}
    });
    $('#jumpTop').addEventListener('click', () => { $('#stream').scrollTop = 0; updateJump(); });
    $('#jumpBottom').addEventListener('click', () => { $('#stream').scrollTop = $('#stream').scrollHeight; updateJump(); });
    let convQT = null;
    $('#convSearch').addEventListener('input', e => {
      clearTimeout(convQT);
      convQT = setTimeout(() => { S.convQ = e.target.value.trim(); loadSide(); }, 280);
    });
    $('#favOnly').addEventListener('click', () => {
      S.favOnly = !S.favOnly;
      $('#favOnly').classList.toggle('on', S.favOnly);
      toast(S.favOnly ? '只看收藏的对话' : '显示全部对话');
      loadSide();
    });
    // 拖拽文件直接进对话
    // ★ 挂在整个 #view-chat 上，不只 #stream —— 学生的直觉动作是把文件拖到**输入框**附近
    //   （那里才是"要发的东西"），拖到那儿以前是没反应的。
    const st = $('#stream');
    const dropZone = $('#view-chat') || st;
    ['dragover', 'dragenter'].forEach(k => dropZone.addEventListener(k, e => { e.preventDefault(); st.classList.add('drop'); }));
    ['dragleave', 'drop'].forEach(k => dropZone.addEventListener(k, e => {
      e.preventDefault();
      // 子元素之间移动也会触发 dragleave：只有真的离开整块区域才取消高亮，
      // 否则鼠标划过任意一行，提示就闪一下。
      if (k === 'drop' || !dropZone.contains(e.relatedTarget)) st.classList.remove('drop');
    }));
    dropZone.addEventListener('drop', e => {
      const fl = e.dataTransfer && e.dataTransfer.files;
      if (fl && fl.length) { pickAttach(fl); toast('正在读取拖入的文件…'); }
    });
    $('#modeSel').addEventListener('change', e => { S.mode = e.target.value; toast('已切到「' + e.target.selectedOptions[0].text + '」'); });
    $('#modelSel').addEventListener('change', e => {
      S.model = e.target.value;
      const m = (S.models || []).filter(x => x.id === S.model)[0];
      toast(m && m.desc ? m.desc : '已切换模型');
      if (S.convId) api('/api/conversations/' + S.convId, { method: 'PATCH', body: { model: S.model } }).catch(() => {});
    });
    $('#projectSel').addEventListener('change', async e => {
      const v = e.target.value;
      if (v === '__new__') { projectModal(null, { select: true }); renderProjectSel(''); return; }
      if (!S.convId) { S.pendingProjectId = v || null; toast(v ? '将归入「' + projName(v) + '」' : '取消项目关联'); return; }
      try {
        await api('/api/conversations/' + S.convId, { method: 'PATCH', body: { projectId: v || null } });
        await loadSide();
        const cur = (S.convs || []).filter(c => c.id === S.convId)[0];
        if (cur) $('#convSubText').textContent = convSubText(cur);
        toast(v ? '已归入「' + projName(v) + '」' : '已移出项目');
      } catch (err) { toast(err.message); }
    });
    $('#convList').addEventListener('click', async ev => {
      // 对话行右侧的 ⋯：重命名 / 移动 / 删除
      const menu = ev.target.closest('[data-menu]');
      if (menu) {
        ev.stopPropagation();
        await openConv(menu.dataset.menu);
        openConvMenu();
        return;
      }
      // 项目行的操作：展开收起 / 新建对话 / 项目菜单
      const act = ev.target.closest('[data-p]');
      if (act) {
        ev.stopPropagation();
        const holder = act.closest('[data-proj]');
        const pid = holder ? holder.dataset.proj : '';
        const k = act.dataset.p;
        if (k === 'toggle') {
          S.openProj[pid] = S.openProj[pid] === false;   // 缺省展开，点一下收起
          renderSideTree();
          return;
        }
        if (k === 'newconv') { newConv(pid && pid !== '__none__' ? { projectId: pid } : {}); return; }
        if (k === 'pmenu') { openProjMenu(pid); return; }
        if (k === 'newproj') { projectModal(null); return; }
        return;
      }
      const it = ev.target.closest('.conv-i');
      if (it) openConv(it.dataset.id);
    });
    bindResizer();
    $('#shareBtn').addEventListener('click', async () => {
      if (!S.convId) { toast('先聊两句再分享'); return; }
      await openShareMgr();
    });

    // 知识卡
    $('#cardStats').addEventListener('click', ev => {
      const st = ev.target.closest('[data-st]'); if (!st) return;
      S.cardQ.status = st.dataset.st; S.cards.page = 1;
      $('#cardStatus').value = ['all', 'due', 'learning', 'almost', 'mastered', 'retired'].indexOf(st.dataset.st) >= 0 ? st.dataset.st : 'all';
      loadCards();
    });
    $('#cardStatus').addEventListener('change', e => { S.cardQ.status = e.target.value; S.cards.page = 1; loadCards(); });
    $('#cardSort').addEventListener('change', e => { S.cardQ.sort = e.target.value; S.cards.page = 1; loadCards(); });
    let cardSearchT = null;
    $('#cardSearch').addEventListener('input', e => {
      clearTimeout(cardSearchT);
      cardSearchT = setTimeout(() => { S.cardQ.q = e.target.value.trim(); S.cards.page = 1; loadCards(); }, 300);
    });
    $('#cardRefresh').addEventListener('click', () => loadCards());
    $('#cardList').addEventListener('click', async ev => {
      const card = ev.target.closest('.kcard'); if (!card) return;
      const b = ev.target.closest('[data-do]');
      if (b && b.dataset.do === 'del') {
        if (!confirm('删除这张知识卡？')) return;
        try { await api('/api/cards/' + card.dataset.id, { method: 'DELETE' }); loadCards(); toast('已删除'); }
        catch (e) { toast(e.message); }
        return;
      }
      openPractice(card.dataset.id);
    });
    $('#cardPager').addEventListener('click', ev => {
      const b = ev.target.closest('[data-pg]'); if (!b || b.disabled) return;
      S.cards.page = Number(b.dataset.pg); loadCards();
    });
    $('#cardRulesBtn').addEventListener('click', openCardRules);
    $('#cardSuggestBtn').addEventListener('click', openSuggest);

    // 看板
    $('#dashRefresh').addEventListener('click', loadDash);
    $('#dashDays').addEventListener('change', loadDash);
    // 日报：事件委托只绑一次（内容每次重写，逐个 bind 会漏）
    bindDaily();

    // 家长视角（批次20）：和看板一样，事件委托绑在 #parentBody 上 ——
    // 它每次 loadParent 整体重建，逐个 bind 会漏（日报踩过这个坑）。
    $('#parentRefresh').addEventListener('click', () => loadParent());
    bindParent();

    // 能力中心
    $('#skillCats').addEventListener('click', ev => {
      const b = ev.target.closest('[data-cat]'); if (!b) return;
      skillCat = b.dataset.cat;
      // 换分类必须重画学科筛选条：学科计数是跟着当前分类算的，
      // 漏掉这一步会出现"选了工具，学科条还停在上一个分类的计数"。
      renderSkillCats(); renderSkillSubjects(); renderSkillList();
    });
    $('#skillSubjects').addEventListener('click', ev => {
      const b = ev.target.closest('[data-subj]'); if (!b) return;
      skillSubject = b.dataset.subj; renderSkillSubjects(); renderSkillList();
    });
    $('#skillList').addEventListener('click', ev => {
      const c = ev.target.closest('.skill-c'); if (!c) return;
      toggleSkill(c.dataset.id);
    });
    $('#skillList').addEventListener('keydown', ev => {
      if (ev.key !== 'Enter' && ev.key !== ' ') return;
      const c = ev.target.closest('.skill-c'); if (!c) return;
      ev.preventDefault(); toggleSkill(c.dataset.id);
    });
    $('#skillClear').addEventListener('click', async () => {
      if (!(S.skillEnabled || []).length) { toast('当前没有启用任何能力'); return; }
      try {
        await api('/api/skills/enabled', { method: 'POST', body: { skillIds: [] } });
        await loadSkills();
        toast('已全部取消');
      } catch (e) { toast(e.message); }
    });

    // ---------- 知识库：本子树 + 分区条 + 状态 Tab + 文档行 ----------
    $('#kbTabs').addEventListener('click', ev => {
      const b = ev.target.closest('[data-sub]'); if (!b) return;
      setKbSub(b.dataset.sub);
    });
    $('#kbNewCat').addEventListener('click', () => newCatModal());
    $('#kbTreeList').addEventListener('click', async ev => {
      const x = ev.target.closest('[data-expand]');
      if (x) {
        ev.stopPropagation();
        try {
          const r = await api('/api/kb/categories/' + x.dataset.expand + '/expand', { method: 'POST', body: { delta: 5 } });
          await loadKb(); toast('「' + r.category.name + '」容量加到 ' + r.category.capacity);
        } catch (e) { toast(e.message); }
        return;
      }
      const b = ev.target.closest('[data-cat]'); if (!b) return;
      kbCat = b.dataset.cat; kbHits = null;
      renderKbTree(); renderKbState(); renderKbList();
    });
    $('#kbState').addEventListener('click', ev => {
      const b = ev.target.closest('[data-state]'); if (!b) return;
      kbState = tabState(b.dataset.state); kbHits = null;
      renderKbState(); renderKbList();
    });
    $('#kbUploadBtn').addEventListener('click', () => $('#kbFile').click());
    $('#kbDrop').addEventListener('click', () => $('#kbFile').click());
    $('#kbFile').addEventListener('change', e => { uploadFiles(e.target.files); e.target.value = ''; });
    ['dragenter', 'dragover'].forEach(k => $('#kbDrop').addEventListener(k, e => {
      e.preventDefault(); $('#kbDrop').classList.add('over');
    }));
    ['dragleave', 'drop'].forEach(k => $('#kbDrop').addEventListener(k, e => {
      e.preventDefault(); $('#kbDrop').classList.remove('over');
    }));
    $('#kbDrop').addEventListener('drop', e => {
      if (e.dataTransfer && e.dataTransfer.files) uploadFiles(e.dataTransfer.files);
    });
    let kbSearchT = null;
    $('#kbSearch').addEventListener('input', e => {
      clearTimeout(kbSearchT);
      const q = e.target.value.trim();
      kbSearchT = setTimeout(async () => {
        if (!q) { kbHits = null; renderKbList(); return; }
        try {
          const r = await api('/api/kb/search?q=' + encodeURIComponent(q) + '&limit=8');
          kbHits = r.hits || [];
          renderKbList();
        } catch (err) { toast(err.message); }
      }, 320);
    });
    $('#kbList').addEventListener('click', async ev => {
      if (ev.target.closest('#kbClearSearch')) {
        kbHits = null; $('#kbSearch').value = ''; renderKbList(); return;
      }
      const row = ev.target.closest('.doc-i'); if (!row) return;
      const b = ev.target.closest('[data-doc]'); if (!b) return;
      const doc = (S.kbDocs || []).filter(d => d.id === row.dataset.id)[0];
      const act = b.dataset.doc;
      if (act === 'del') {
        if (!confirm('删除这份资料？')) return;
        try { await api('/api/kb/documents/' + row.dataset.id, { method: 'DELETE' }); loadKb(); toast('已删除'); }
        catch (e) { toast(e.message); }
        return;
      }
      if (act === 'move') { if (doc) moveDocModal(doc); return; }
      if (act === 'proj') { if (doc) docProjectsModal(doc); return; }
      if (act === 'reparse') {
        try {
          const r = await api('/api/kb/documents/' + row.dataset.id + '/reparse', { method: 'POST' });
          loadKb();
          toast(r.document.state === 'ready' ? '重新解析成功，现在能检索了' : '还是没能抽出文字：' + (r.document.error || '这份文件可能没有文字层'));
        } catch (e) { toast(e.message); }
        return;
      }
      if (act === 'view') {
        try {
          const r = await api('/api/kb/documents/' + row.dataset.id + '/text');
          openModal('《' + r.filename + '》· 抽出 ' + r.textLength + ' 字',
            '<div class="md" style="max-height:56vh;overflow:auto">' + HL.render(r.text || '（没有文字）') + '</div>');
        } catch (e) { toast(e.message); }
      }
    });

    // 项目
    // 注意：左栏那个「+ 新建项目」是 #newProj，这里是知识库「项目」分区里的同名按钮，
    // 必须用不同的 id —— 两个 id 撞了的话，$('#newProj') 只会绑到先出现的那一个。
    $('#newProjPane').addEventListener('click', () => projectModal(null));
    $('#projList').addEventListener('click', async ev => {
      const row = ev.target.closest('.row-card'); if (!row) return;
      const p = S.projects.find(x => x.id === row.dataset.id);
      const b = ev.target.closest('[data-p]');
      if (b && b.dataset.p === 'del') {
        if (!confirm('删除项目「' + (p ? p.name : '') + '」？')) return;
        try { await api('/api/projects/' + row.dataset.id, { method: 'DELETE' }); loadProjects(); toast('已删除'); }
        catch (e) { toast(e.message); }
        return;
      }
      if (b && b.dataset.p === 'open') {
        openProjectConvs(row.dataset.id, p ? p.name : '');
        return;
      }
      if (p) projectModal(p);
    });

    // 记忆
    $('#memToggle').addEventListener('change', async e => {
      try { await api('/api/memory/settings', { method: 'POST', body: { enabled: e.target.checked } }); toast(e.target.checked ? '记忆已开启' : '记忆已关闭'); }
      catch (err) { toast(err.message); }
    });
    $('#memAdd').addEventListener('click', addMemory);
    $('#memInput').addEventListener('keydown', e => { if (e.key === 'Enter') addMemory(); });
    $('#memList').addEventListener('click', async ev => {
      const b = ev.target.closest('[data-mem]'); if (!b) return;
      try { await api('/api/memory/' + b.dataset.mem, { method: 'DELETE' }); loadMemory(); toast('已删除'); }
      catch (e) { toast(e.message); }
    });

    // 设置（内容动态重建，用委托）
    $('#view-settings').addEventListener('click', ev => {
      const t = ev.target.closest('#themeSeg button');
      if (t) { applyTheme(t.dataset.theme); return; }
      const f = ev.target.closest('#fontSeg button');
      if (f) { applyFont(f.dataset.font); return; }
      if (ev.target.closest('#copySpace')) { copyText(S.space ? S.space.id : ''); return; }
      if (ev.target.closest('#switchSpace2')) { signOut(); return; }
      if (ev.target.closest('#signOut')) { signOut(); }
    });

    // 弹窗 / 复制
    $('#modalClose').addEventListener('click', closeModal);
    $('#mask').addEventListener('click', e => { if (e.target === $('#mask')) closeModal(); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('#mask').hidden) closeModal(); });
    document.addEventListener('click', ev => {
      const c = ev.target.closest('.code-copy');
      if (c) {
        const el = document.getElementById(c.dataset.copy);
        if (el) copyText(el.innerText);
      }
    });

    // 英语（P10）
    $('#enUnit').addEventListener('click', openNewUnit);
    $('#enImport').addEventListener('click', openImportWords);
    $('#enDict').addEventListener('click', () => {
      openModal('听写模式', '<div class="pool-note">选一种练法。听音模式会用浏览器朗读，需要先点一下页面（浏览器要求先有交互才允许发声）。</div>' +
        Object.keys(EN_MODE_NAME).map(k => '<div class="pool-i" style="cursor:pointer" data-mode="' + k + '"><div class="pool-top"><b>' + EN_MODE_NAME[k] + '</b></div>' +
          '<div class="pool-sum">' + ({ meaning: '看中文意思，写出英文单词。', listen: '听发音，写出单词。', spell: '看到单词本身，练准确拼写（会提示字母个数）。' }[k]) + '</div></div>').join(''));
    });
    $('#enUnits').addEventListener('click', ev => {
      const b = ev.target.closest('.cat-chip'); if (!b) return;
      enUnit = b.dataset.u || '';
      loadEn();
    });
    $('#enSort').addEventListener('change', loadEn);
    $('#enSearch').addEventListener('input', debounce(loadEn, 320));
    $('#enToCards').addEventListener('click', async () => {
      const b = $('#enToCards'); b.disabled = true; b.textContent = '处理中…';
      try {
        const r = await api('/api/english/words/to-cards', { method: 'POST', body: {} });
        toast(r.count ? '生成了 ' + r.count + ' 张拼写卡，去「知识卡」看看' : '这些词都已经有拼写卡了');
        await Promise.all([loadCardSummary(), loadPet(true)]);
      } catch (e) { toast(e.message); }
      b.disabled = false; b.textContent = '转成拼写卡';
    });
    $('#enList').addEventListener('click', async ev => {
      const sp = ev.target.closest('[data-speak]');
      if (sp) { speak(sp.dataset.speak); return; }
      const sy = ev.target.closest('[data-say]');
      if (sy) { startSay(sy.dataset.say); return; }
      const dl = ev.target.closest('[data-delw]');
      if (dl) {
        try { await api('/api/english/words/' + dl.dataset.delw, { method: 'DELETE' }); loadEn(); toast('已删除'); }
        catch (e) { toast(e.message); }
      }
    });

    // 测评（P6）
    $('#exNew').addEventListener('click', createExam);
    $('#exList').addEventListener('click', async ev => {
      const o = ev.target.closest('[data-open]');
      if (o) { openExam(o.dataset.open); return; }
      const d = ev.target.closest('[data-delex]');
      if (d) {
        try { await api('/api/exams/' + d.dataset.delex, { method: 'DELETE' }); loadExams(); toast('已删除'); }
        catch (e) { toast(e.message); }
      }
    });

    // 公共资料池（P3）
    $('#poolTabs').addEventListener('click', ev => {
      const b = ev.target.closest('button[data-tab]'); if (!b) return;
      poolTab = b.dataset.tab;
      $$('#poolTabs button').forEach(x => x.classList.toggle('on', x === b));
      $('#poolList').dataset.ready = '';
      loadPool();
    });
    ['#poolSubject', '#poolKind', '#poolSort'].forEach(s => $(s).addEventListener('change', loadPool));
    $('#poolSearch').addEventListener('input', debounce(loadPool, 320));
    $('#poolRefresh').addEventListener('click', () => { $('#poolList').dataset.ready = ''; loadPool(); });
    $('#poolShare').addEventListener('click', openShareToPool);
    $('#poolList').addEventListener('click', ev => {
      const c = ev.target.closest('[data-copy]');
      if (c) { copyFromPool(c.dataset.copy); return; }
      const r = ev.target.closest('[data-report]');
      if (r) { reportPool(r.dataset.report); return; }
      const u = ev.target.closest('[data-uncshare]');
      if (u) { unsharePool(u.dataset.uncshare); }
    });

    // 弹窗内的通用动作（朗读、选听写模式、关闭结果页）
    $('#modalBody').addEventListener('click', ev => {
      const sp = ev.target.closest('[data-speak]');
      if (sp) { speak(sp.dataset.speak); return; }
      const md = ev.target.closest('[data-mode]');
      if (md) {
        const k = md.dataset.mode;
        if (EN_MODE_NAME[k]) { dictMode = k; closeModal(); openDictation(); }
        return;
      }
      if (ev.target.closest('#exDone')) { closeModal(); switchView('cards'); return; }
      // 批次2：对话菜单 / 移动到项目。挂在这里而不是每次 openModal 里 ——
      // 每次挂一份会在重复打开后叠加，点一下执行两次。
      const cm = ev.target.closest('[data-cm]');
      if (cm) { convMenuAction(cm.dataset.cm); return; }
      const pj = ev.target.closest('[data-pj]');
      if (pj) { moveToProjectAction(pj.dataset.pj); return; }
    });

    bindVoice();
  }

  async function addMemory() {
    const v = $('#memInput').value.trim();
    if (!v) return;
    try {
      await api('/api/memory', { method: 'POST', body: { content: v } });
      $('#memInput').value = '';
      loadMemory(); toast('记住了');
    } catch (e) { toast(e.message); }
  }

  // ================= 分享页（/s/:token，无需登录）=================
  async function renderSharePage(token) {
    document.body.innerHTML = '<div class="share-body"><div class="skel" style="height:2em;width:40%"></div></div>';
    try {
      const r = await fetch('/api/share/' + token).then(x => x.json());
      if (!r.ok) throw new Error(r.message || '分享不存在');
      if (r.kind === 'interactive') {
        document.body.innerHTML = '<div class="share-body">' +
          '<div class="share-head"><h1>' + HL.esc(r.title || '互动课堂') + '</h1>' +
          '<div class="dim">来自「' + HL.esc(r.spaceName || '') + '」的学习空间 · 只读分享</div></div>' +
          '<div class="iv-share-fig" id="ivShareFig"></div></div>';
        HL.interactive.render(r.dsl, document.getElementById('ivShareFig'));
        return;
      }
      const msgs = (r.messages || []).map(m =>
        '<div class="msg ' + (m.role === 'user' ? 'user' : 'ai') + '"><div class="av">' + (m.role === 'user' ? '我' : '涌') + '</div>' +
        '<div class="body"><div class="md">' + HL.render(m.content) + '</div></div></div>').join('');
      document.body.innerHTML = '<div class="share-body">' +
        '<div class="share-head"><h1>学习对话</h1><div class="dim">来自「' + HL.esc(r.spaceName || '') + '」的学习空间 · 只读分享</div></div>' +
        msgs + '</div>';
    } catch (e) {
      document.body.innerHTML = '<div class="share-body"><div class="empty"><p>这条分享不存在或已失效。</p></div></div>';
    }
  }

  // ================= 启动 =================
  function boot() {
    applyTheme(document.documentElement.getAttribute('data-theme') || 'light');
    applyFont(document.documentElement.getAttribute('data-font') || 'md');

    const m = location.pathname.match(/^\/s\/([a-zA-Z0-9]+)$/);
    if (m) { renderSharePage(m[1]); return; }

    bindLand();
    bindApp();
    initAdminPanel();

    // 开机自检：拿不到健康检查就不要假装能用
    fetch('/api/health').then(x => x.json()).then(h => {
      if (!h.ok) throw new Error('服务异常');
      if (h.mockLLM) console.info('[后浪] 当前是离线演示模式（服务端未配置模型 Key）');
    }).catch(() => {
      $('#landStale').style.display = 'block';
      $('#landStale').textContent = '连不上服务，请确认服务已启动。';
    });

    if (S.token) {
      api('/api/me').then(enterApp).catch(() => { setToken(''); showLand(); });
    } else {
      showLand();
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();

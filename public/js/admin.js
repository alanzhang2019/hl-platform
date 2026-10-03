'use strict';
/**
 * 管理员看板前端（2026-10-03）
 *
 * 零依赖，纯 DOM。为什么不塞进 app.js：
 *   app.js 已经 340KB，是学生对话界面；看板是内部工具，两者没有共享状态。
 *   分开放，改看板不会碰学生的东西，加载看板也不会拖进整个对话应用。
 *
 * ★ 路径写法注意：这里所有请求都写以斜杠 api 开头的**站内绝对路径**，
 *   不要自己加平台前缀。nginx 对 /ai 这个 location 挂了 sub_filter，会把响应体里的
 *   '/api/' 统一重写成带前缀的形式（`sub_filter_once off`，全量替换）。
 *   如果这里写死了带前缀的路径，线上会被二次替换成双前缀，直接 404。
 *   本文件在本地直连 3100 端口调试时同样可用 —— 那时 nginx 不在链路上，
 *   站内绝对路径正是后端的真实路径。
 */
(function () {
  var $ = function (s) { return document.querySelector(s); };

  var S = {
    token: '',
    days: 14,
    spaces: [],
    models: [],
    allReason: false,   // 「展开全部思考过程」的开关，跨重渲染保持
    convLimit: 25,
    convOffset: 0,
    convTotal: 0,
    convSpace: '',
    convQ: '',
  };

  var MODE_LABEL = {
    selfstudy: '自学引导',
    feynman: '费曼学习法',
    diagnosis: '学情诊断',
    untracked: '未记录（历史）',
    unknown: '未知',
  };
  var KIND_LABEL = {
    chat: '对话',
    card_review: '知识卡复习',
    card_created: '新建知识卡',
    card_free_practice: '自由练习',
    kb_upload: '上传资料',
    exam_submit: '测评提交',
    pool_share: '共享池贡献',
    pool_copy: '取用共享卡',
    pool_report: '举报',
    login: '登录',
  };
  var ROLE_LABEL = { user: '学生', assistant: 'AI', system: '系统' };

  // ---------- 工具 ----------
  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function pad2(n) { return String(n).padStart(2, '0'); }
  function fmtTime(ts) {
    if (!ts) return '—';
    var d = new Date(ts);
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) +
      ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }
  function fmtDay(ts) {
    if (!ts) return '—';
    var d = new Date(ts);
    return pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }
  function ago(ts) {
    if (!ts) return '从未';
    var diff = Date.now() - ts;
    if (diff < 60e3) return '刚刚';
    if (diff < 3600e3) return Math.floor(diff / 60e3) + ' 分钟前';
    if (diff < 86400e3) return Math.floor(diff / 3600e3) + ' 小时前';
    return Math.floor(diff / 86400e3) + ' 天前';
  }
  function num(n) {
    return String(Number(n) || 0).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  /** 带管理员令牌的请求。令牌走 ?_t= 而不是请求头 —— 宿主反代会剥掉自定义头。 */
  function api(path, opt) {
    var sep = path.indexOf('?') >= 0 ? '&' : '?';
    var o = opt || {};
    o.headers = Object.assign({ 'Content-Type': 'application/json' }, o.headers || {});
    return fetch(path + sep + '_t=' + encodeURIComponent(S.token), o).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) {
          var e = new Error(j.message || j.error || ('请求失败 ' + r.status));
          e.status = r.status;
          e.code = j.error;
          throw e;
        }
        return j;
      });
    });
  }

  function setErr(msg) { $('#adErr').textContent = msg || ''; }

  // ---------- 登录 ----------
  function doLogin() {
    var pw = $('#adPw').value;
    setErr('');
    if (!pw) { setErr('请输入管理密码'); return; }
    $('#adLogin').disabled = true;
    fetch('/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: pw }),
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) throw new Error(j.message || j.error || '登录失败');
        return j;
      });
    }).then(function (j) {
      S.token = j.token;
      try { sessionStorage.setItem('hl_admin_token', S.token); } catch (e) {}
      $('#adPw').value = '';
      enter();
    }).catch(function (e) {
      setErr(e.message);
    }).then(function () { $('#adLogin').disabled = false; });
  }

  function logout() {
    S.token = '';
    try { sessionStorage.removeItem('hl_admin_token'); } catch (e) {}
    $('#adMain').style.display = 'none';
    $('#adGate').style.display = '';
    $('#adLogout').style.display = 'none';
  }

  function enter() {
    $('#adGate').style.display = 'none';
    $('#adMain').style.display = '';
    $('#adLogout').style.display = '';
    loadAll();
  }

  // ---------- 渲染：KPI ----------
  function kpi(k, v, s) {
    return '<div class="ad-kpi"><div class="k">' + esc(k) + '</div><div class="v">' + esc(v) + '</div>' +
      (s ? '<div class="s">' + esc(s) + '</div>' : '') + '</div>';
  }

  function renderKpis(ov) {
    var t = ov.totals || {};
    var a = ov.active || {};
    var c = ov.compare || {};
    var deltaTxt = c.delta === null || c.delta === undefined ? '' :
      (c.delta >= 0 ? '↑ ' : '↓ ') + num(Math.abs(c.delta)) +
      (c.deltaPct === null || c.deltaPct === undefined ? '' : '（' + (c.deltaPct >= 0 ? '+' : '') + c.deltaPct + '%）');
    $('#adKpis').innerHTML =
      kpi('学习空间', num(t.spaces), '含默认空间') +
      kpi('账号', num(t.users), '') +
      kpi('对话数', num(t.conversations), '') +
      kpi('消息数', num(t.messages), '') +
      kpi('窗口内消息', num(c.messages), deltaTxt ? '对比上一周期 ' + deltaTxt : '') +
      kpi('今日活跃空间', num(a.today), '') +
      kpi('7 日活跃', num(a.days7), '') +
      kpi('30 日活跃', num(a.days30), '') +
      kpi('知识卡', num(t.cards), '') +
      kpi('资料', num(t.documents), '');
  }

  // ---------- 渲染：柱状图 ----------
  function renderChart(daily) {
    var host = $('#adChart');
    if (!daily || !daily.length) { host.innerHTML = '<div class="ad-empty">窗口内没有数据</div>'; return; }
    var max = 1;
    daily.forEach(function (d) { if (d.messages > max) max = d.messages; });
    var n = daily.length;
    var bw = 600 / n;
    var bars = '';
    daily.forEach(function (d, i) {
      var h = Math.round((d.messages / max) * 104);
      var x = i * bw + bw * 0.18;
      var w = Math.max(bw * 0.64, 1.6);
      var y = 116 - h;
      bars += '<rect x="' + x.toFixed(1) + '" y="' + (d.messages ? y : 115) + '" width="' + w.toFixed(1) +
        '" height="' + (d.messages ? Math.max(h, 2) : 1) + '" rx="2" style="fill:var(--pri)">' +
        '<title>' + esc(d.date) + '：' + d.messages + ' 条消息 · ' + d.activeSpaces + ' 个空间</title></rect>';
    });
    var labels = '';
    [0, Math.floor((n - 1) / 2), n - 1].forEach(function (i, idx) {
      if (!daily[i]) return;
      var anchor = idx === 0 ? 'start' : (idx === 2 ? 'end' : 'middle');
      var lx = idx === 0 ? 0 : (idx === 2 ? 600 : 300);
      labels += '<text x="' + lx + '" y="134" text-anchor="' + anchor +
        '" style="font-size:11px;fill:var(--dim2)">' + esc(fmtDay(daily[i].at)) + '</text>';
    });
    host.innerHTML =
      '<svg viewBox="0 0 600 142" width="100%" height="142" role="img" aria-label="每日消息量">' +
      '<line x1="0" y1="116" x2="600" y2="116" style="stroke:var(--line)"/>' +
      '<text x="0" y="12" style="font-size:11px;fill:var(--dim2)">峰值 ' + max + ' 条/天</text>' +
      bars + labels + '</svg>';
    var sum = daily.reduce(function (a, d) { return a + d.messages; }, 0);
    $('#adChartHint').textContent = '共 ' + num(sum) + ' 条 · 平均 ' + (sum / n).toFixed(1) + ' 条/天 · 柱子上悬停可看当天明细';
  }

  // ---------- 渲染：横向条 ----------
  function renderBars(host, obj, labelMap, emptyText) {
    var keys = Object.keys(obj || {});
    if (!keys.length) { host.innerHTML = '<div class="ad-empty">' + esc(emptyText || '暂无数据') + '</div>'; return; }
    keys.sort(function (a, b) { return obj[b] - obj[a]; });
    var max = obj[keys[0]] || 1;
    host.innerHTML = '<div class="ad-bars">' + keys.map(function (kk) {
      var pct = Math.max(2, Math.round(obj[kk] / max * 100));
      var lb = (labelMap && labelMap[kk]) || kk;
      return '<div class="ad-bar"><span class="lb" title="' + esc(kk) + '">' + esc(lb) + '</span>' +
        '<span class="tr"><span class="fl" style="width:' + pct + '%"></span></span>' +
        '<span class="vl">' + num(obj[kk]) + '</span></div>';
    }).join('') + '</div>';
  }

  // ---------- 渲染：模型切换 ----------
  function renderModels(slots, catalog) {
    var host = $('#adModels');
    if (!slots || !slots.length) { host.innerHTML = '<div class="ad-empty">没有可配置的模型档位</div>'; return; }
    var opts = '';
    if (catalog && catalog.ok && catalog.models && catalog.models.length) {
      opts = catalog.models.map(function (m) { return '<option value="' + esc(m) + '">' + esc(m) + '</option>'; }).join('');
    }
    host.innerHTML = slots.map(function (s) {
      // 目录里没有当前值时补一个 option，否则下拉会显示成空、一保存就把配置清空了。
      var sel = '<select class="ad-model-sel" data-slot="' + esc(s.id) + '">' +
        (opts || '<option value="' + esc(s.model) + '">' + esc(s.model) + '</option>') +
        '<option value="' + esc(s.model) + '" data-cur="1">' + esc(s.model) + '（当前）</option></select>';
      return '<div style="margin-bottom:14px">' +
        '<div style="font-size:.85rem;font-weight:500;margin-bottom:5px">' + esc(s.displayName) +
        ' <span class="ad-pill' + (s.overridden ? ' pri' : '') + '">' + (s.overridden ? '已覆盖' : '环境变量') + '</span>' +
        (s.thinking ? ' <span class="ad-pill">思考</span>' : '') + '</div>' +
        '<div class="ad-tools">' + sel +
        '<button class="btn sm primary" type="button" data-msave="' + esc(s.id) + '">保存</button>' +
        '<button class="btn sm ghost" type="button" data-mreset="' + esc(s.id) + '">恢复默认</button>' +
        '</div>' +
        '<div class="dim" style="font-size:.75rem;margin-top:4px">当前生效 <b>' + esc(s.model) + '</b> · ' +
        '环境变量 <code>' + esc(s.envModel) + '</code>' + (s.desc ? ' · ' + esc(s.desc) : '') + '</div>' +
        '</div>';
    }).join('') +
      '<div class="ad-tools" style="margin-bottom:0">' +
      '<span class="dim" style="font-size:.76rem" id="adModelCat"></span>' +
      '<span style="flex:1"></span>' +
      '<button class="btn sm ghost" type="button" id="adModelRefresh">刷新可用模型</button></div>';

    slots.forEach(function (s) {
      var el = host.querySelector('select[data-slot="' + s.id + '"]');
      if (!el) return;
      el.value = s.model;
      if (el.value !== s.model) {
        var o = document.createElement('option');
        o.value = s.model; o.textContent = s.model;
        el.appendChild(o);
        el.value = s.model;
      }
    });

    var cat = $('#adModelCat');
    if (cat) {
      if (catalog && catalog.ok) {
        var src = catalog.source === 'live' ? '实时拉取' : '缓存';
        cat.textContent = '可用模型 ' + catalog.models.length + ' 个（' + src + '）';
      } else {
        cat.textContent = '目录获取失败：' + ((catalog && catalog.error) || '未知原因') + ' —— 可以直接手填模型名';
      }
    }
  }

  function loadModels(refresh) {
    return api('/api/admin/models' + (refresh ? '?refresh=1' : ''))
      .then(function (j) { S.models = j.slots || []; renderModels(S.models, j.catalog); })
      .catch(handleAuthError);
  }

  function setModel(slot, model) {
    return api('/api/admin/models', {
      method: 'POST',
      body: JSON.stringify({ slot: slot, model: model }),
    }).then(function () {
      // 保存成功后重拉一次：SET 的响应里没有候选目录，重拉能一次性把
      // "当前值 + 候选列表"都渲染对（目录走 5 分钟缓存，这一下很快）。
      return loadModels();
    }).catch(function (e) { alert(e.message); });
  }

  // ---------- TTS 切换 ----------
  function loadTts() {
    return api('/api/admin/tts')
      .then(function (j) { renderTts(j.config || {}, j.voices || {}); })
      .catch(handleAuthError);
  }

  function saveTts(patch) {
    return api('/api/admin/tts', {
      method: 'POST',
      body: JSON.stringify(patch),
    }).then(function (j) { renderTts(j.config || {}, j.voices || {}); alert('TTS 配置已保存'); })
      .catch(function (e) { alert(e.message || '保存失败'); });
  }

  function testTts() {
    var btn = $('#adTtsTest');
    if (btn) { btn.disabled = true; btn.textContent = '测试中…'; }
    var text = ($('#adTtsTestText') || {}).value || '你好，这是 TTS 测试。';
    api('/api/admin/tts/test', {
      method: 'POST',
      body: JSON.stringify({ text: text }),
    }).then(function (r) {
      if (r.mode === 'audio' && r.audio) {
        // 直接 Base64 播放
        var a = new Audio('data:' + (r.mime || 'audio/mpeg') + ';base64,' + r.audio);
        a.play();
        alert('测试朗读已播放（' + (r.provider || '未知') + '）');
      } else if (r.mode === 'url' && r.url) {
        var a2 = new Audio(r.url); a2.play();
        alert('测试朗读已播放（URL 模式）');
      } else {
        var synth = window.speechSynthesis;
        if (synth) {
          var u = new SpeechSynthesisUtterance(text);
          if (r.rate) u.rate = Number(r.rate) || 1;
          synth.speak(u);
        }
        alert('已用浏览器语音合成播放（' + (r.note || '降级模式') + '）');
      }
    }).catch(function (e) {
      alert('测试失败：' + (e.message || '未知错误'));
    }).finally(function () {
      if (btn) { btn.disabled = false; btn.textContent = '测试朗读'; }
    });
  }

  function renderTts(cfg, voices) {
    var host = $('#adTts');
    var providers = [
      { id: 'custom', name: '自定义' },
      { id: 'siliconflow', name: 'SiliconFlow' },
      { id: 'openai', name: 'OpenAI 官方' },
      { id: 'openai-compatible', name: 'OpenAI 兼容' },
    ];
    var provOpts = providers.map(function (p) {
      return '<option value="' + esc(p.id) + '"' + (cfg.kind === p.id ? ' selected' : '') + '>' + esc(p.name) + '</option>';
    }).join('');

    // 音色快速选择：按当前 provider 列出已知候选
    var voiceOpts = '';
    if (voices && voices.voices && voices.voices.length) {
      voiceOpts = '<datalist id="adTtsVoiceList">' +
        voices.voices.map(function (v) { return '<option value="' + esc(v) + '">'; }).join('') +
        '</datalist>';
    }

    var envNote = function (label, cur, env, over) {
      return '<div class="dim" style="font-size:.74rem;margin-top:2px">' +
        '当前生效 <b>' + esc(cur || '—') + '</b> · ' +
        (over ? '<span style="color:var(--pri)">已覆盖</span> · ' : '') +
        '环境变量 ' + esc(env || '未设置') + ' · ' + esc(label) + '</div>';
    };

    host.innerHTML =
      '<div class="ad-tts-row">' +
        '<label>服务商</label>' +
        '<select id="adTtsProvider">' + provOpts + '</select>' +
        envNote('留空恢复环境变量', cfg.kind, cfg.envKind, cfg.overridden && cfg.overridden.kind) +
      '</div>' +
      '<div class="ad-tts-row">' +
        '<label>模型</label>' +
        '<input type="text" id="adTtsModel" value="' + esc(cfg.model || '') + '" placeholder="如 FunAudioLLM/CosyVoice2-0.5B">' +
        envNote('留空恢复环境变量', cfg.model, cfg.envModel, cfg.overridden && cfg.overridden.model) +
      '</div>' +
      '<div class="ad-tts-row">' +
        '<label>音色</label>' +
        '<input type="text" id="adTtsVoice" value="' + esc(cfg.voice || '') + '" placeholder="如 alex" list="adTtsVoiceList">' + voiceOpts +
        envNote('留空恢复环境变量', cfg.voice, cfg.envVoice, cfg.overridden && cfg.overridden.voice) +
      '</div>' +
      '<div class="ad-tts-row">' +
        '<label>接口地址</label>' +
        '<input type="text" id="adTtsUrl" value="' + esc(cfg.url || '') + '" placeholder="https://api.xxx.com/v1">' +
        envNote('留空恢复环境变量', cfg.url, cfg.envUrl, cfg.overridden && cfg.overridden.url) +
      '</div>' +
      '<div class="ad-tts-row">' +
        '<label style="display:flex;align-items:center;gap:6px;cursor:pointer">' +
          '<input type="checkbox" id="adTtsEnabled"' + (cfg.enabled ? ' checked' : '') + '> 启用外部 TTS' +
        '</label>' +
        '<div class="dim" style="font-size:.74rem;margin-top:2px">' +
          '当前 ' + (cfg.enabled ? '启用' : '关闭') + ' · ' +
          (cfg.overridden && cfg.overridden.enabled ? '<span style="color:var(--pri)">已覆盖</span> · ' : '') +
          '环境变量 ' + (cfg.envEnabled ? '启用' : '关闭') +
          (cfg.hasKey ? ' · Key 已配置' : ' · <span style="color:var(--coral-600)">Key 未配置</span>') +
        '</div>' +
      '</div>' +
      '<div class="ad-tts-row" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:8px">' +
        '<button class="btn sm pri" id="adTtsSave">保存</button>' +
        '<button class="btn sm ghost" id="adTtsReset">恢复默认</button>' +
        '<span style="flex:1"></span>' +
        '<input type="text" id="adTtsTestText" value="你好，这是 TTS 测试。" placeholder="测试文本" style="max-width:220px;font-size:.78rem">' +
        '<button class="btn sm" id="adTtsTest">测试朗读</button>' +
      '</div>';

    // provider 切了要重拉候选音色
    $('#adTtsProvider').addEventListener('change', function () {
      saveTts({ provider: this.value });
    });
  }

  // ---------- 渲染：空间列表 ----------
  function renderSpaces(list) {
    if (!list || !list.length) { $('#adSpaces').innerHTML = '<div class="ad-empty">还没有学习空间</div>'; return; }
    var rows = list.map(function (s) {
      return '<tr class="click" data-sid="' + esc(s.spaceId) + '">' +
        '<td class="t">' + esc(s.name) + (s.isDefault ? ' <span class="ad-pill">默认</span>' : '') + '</td>' +
        '<td>' + esc(s.spaceId) + '</td>' +
        '<td><span class="ad-pill pri">' + esc(s.tier) + '</span></td>' +
        '<td class="num">' + num(s.conversations) + '</td>' +
        '<td class="num">' + num(s.messages) + '</td>' +
        '<td class="num">' + num(s.recentMessages) + '</td>' +
        '<td class="num">' + num(s.cards) + '</td>' +
        '<td>' + esc(ago(s.lastMessageAt || s.lastAt)) + '</td>' +
        '</tr>';
    }).join('');
    $('#adSpaces').innerHTML =
      '<table class="ad-tbl"><thead><tr>' +
      '<th>空间</th><th>ID</th><th>档位</th><th style="text-align:right">对话</th>' +
      '<th style="text-align:right">消息</th><th style="text-align:right">窗口内</th>' +
      '<th style="text-align:right">知识卡</th><th>最后对话</th>' +
      '</tr></thead><tbody>' + rows + '</tbody></table>';
  }

  function renderTopSpaces(list) {
    var host = $('#adTopSpaces');
    if (!list || !list.length) { host.innerHTML = '<div class="ad-empty">窗口内没有数据</div>'; return; }
    var max = list[0].messages || 1;
    host.innerHTML = '<div class="ad-bars">' + list.map(function (s) {
      return '<div class="ad-bar"><span class="lb" title="' + esc(s.spaceId) + '">' + esc(s.name) + '</span>' +
        '<span class="tr"><span class="fl" style="width:' + Math.max(2, Math.round(s.messages / max * 100)) + '%"></span></span>' +
        '<span class="vl">' + num(s.messages) + '</span></div>';
    }).join('') + '</div>';
  }

  // ---------- 渲染：空间明细 ----------
  function renderSpaceDetail(d) {
    var box = $('#adSpaceDetail');
    box.style.display = '';
    var t = d.totals || {};
    var modes = d.modes || {};
    var modeKeys = Object.keys(modes);
    box.innerHTML =
      '<h3>空间明细：' + esc(d.space.name) + ' <span class="ad-pill pri">' + esc(d.space.tier) + '</span></h3>' +
      '<div class="hint">' + esc(d.space.spaceId) + ' · 创建于 ' + esc(fmtTime(d.space.createdAt)) +
      ' · 口令 ' + (d.space.hasPasscode ? '已设置' : '未设置') + '</div>' +
      '<div class="ad-kpis" style="margin-bottom:12px">' +
      kpi('对话', num(t.conversations)) + kpi('消息', num(t.messages)) +
      kpi('知识卡', num(t.cards)) + kpi('资料', num(t.documents)) + kpi('记忆', num(t.memories)) +
      '</div>' +
      '<div class="ad-grid">' +
      '<div><div class="hint" style="margin-bottom:6px">每日消息量</div><div id="adSdChart"></div></div>' +
      '<div><div class="hint" style="margin-bottom:6px">模式分布</div><div id="adSdModes"></div></div>' +
      '</div>' +
      '<div style="margin-top:14px"><div class="hint" style="margin-bottom:6px">该空间的对话</div>' +
      (d.conversations && d.conversations.length
        ? '<table class="ad-tbl"><thead><tr><th>标题</th><th>模型</th><th style="text-align:right">消息</th><th>最后更新</th><th></th></tr></thead><tbody>' +
          d.conversations.map(function (c) {
            return '<tr class="click" data-cid="' + esc(c.id) + '"><td class="t">' + esc(c.title) + '</td>' +
              '<td>' + esc(c.model || '—') + '</td><td class="num">' + num(c.messages) + '</td>' +
              '<td>' + esc(fmtTime(c.updatedAt)) + '</td>' +
              '<td><button class="btn ghost sm" type="button" data-open="' + esc(c.id) + '">查看</button></td></tr>';
          }).join('') + '</tbody></table>'
        : '<div class="ad-empty">还没有对话</div>') +
      '</div>' +
      '<div style="margin-top:12px"><button class="btn sm ghost" id="adSdClose" type="button">收起</button></div>';

    renderChartInto($('#adSdChart'), d.daily);
    renderBars($('#adSdModes'), modes, MODE_LABEL, '窗口内没有记录');
    $('#adSdClose').addEventListener('click', function () { box.style.display = 'none'; });
    box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function renderChartInto(host, daily) {
    if (!host) return;
    if (!daily || !daily.length) { host.innerHTML = '<div class="ad-empty">无数据</div>'; return; }
    var max = 1;
    daily.forEach(function (d) { if (d.messages > max) max = d.messages; });
    var n = daily.length, bw = 600 / n, bars = '';
    daily.forEach(function (d, i) {
      var h = Math.round((d.messages / max) * 104);
      bars += '<rect x="' + (i * bw + bw * 0.18).toFixed(1) + '" y="' + (d.messages ? 116 - h : 115) +
        '" width="' + Math.max(bw * 0.64, 1.6).toFixed(1) + '" height="' + (d.messages ? Math.max(h, 2) : 1) +
        '" rx="2" style="fill:var(--pri)"><title>' + esc(d.date) + '：' + d.messages + ' 条</title></rect>';
    });
    host.innerHTML = '<svg viewBox="0 0 600 126" width="100%" height="126" role="img" aria-label="每日消息量">' +
      '<line x1="0" y1="116" x2="600" y2="116" style="stroke:var(--line)"/>' + bars + '</svg>';
  }

  // ---------- 渲染：对话列表 ----------
  function renderConvList(data) {
    S.convTotal = data.total || 0;
    if (!data.conversations || !data.conversations.length) {
      $('#adConvList').innerHTML = '<div class="ad-empty">没有匹配的对话</div>';
    } else {
      $('#adConvList').innerHTML =
        '<table class="ad-tbl"><thead><tr>' +
        '<th>标题</th><th>空间</th><th>模型</th>' +
        '<th style="text-align:right">消息</th><th>最后更新</th><th></th>' +
        '</tr></thead><tbody>' +
        data.conversations.map(function (c) {
          return '<tr class="click" data-cid="' + esc(c.id) + '">' +
            '<td class="t">' + esc(c.title || '未命名') + '</td>' +
            '<td>' + esc(c.spaceName) + '</td>' +
            '<td>' + esc(c.model || '—') + '</td>' +
            '<td class="num">' + num(c.messages) + '<span class="dim"> / ' + num(c.userMessages) + ' 问</span></td>' +
            '<td>' + esc(fmtTime(c.updatedAt)) + '</td>' +
            '<td><button class="btn ghost sm" type="button" data-open="' + esc(c.id) + '">查看</button></td></tr>';
        }).join('') + '</tbody></table>';
    }
    var from = S.convTotal ? S.convOffset + 1 : 0;
    var to = Math.min(S.convOffset + S.convLimit, S.convTotal);
    $('#adConvPager').innerHTML = '共 ' + num(S.convTotal) + ' 条 · 当前 ' + from + '–' + to +
      ' <button class="btn ghost sm" id="adPrev" type="button"' + (S.convOffset <= 0 ? ' disabled' : '') + '>上一页</button>' +
      ' <button class="btn ghost sm" id="adNext" type="button"' + (to >= S.convTotal ? ' disabled' : '') + '>下一页</button>';
    var prev = $('#adPrev'), next = $('#adNext');
    if (prev) prev.addEventListener('click', function () { S.convOffset = Math.max(0, S.convOffset - S.convLimit); loadConvs(); });
    if (next) next.addEventListener('click', function () { S.convOffset += S.convLimit; loadConvs(); });
  }

  /**
   * 思考过程块：**始终存在**，默认折叠。
   *
   * ★ 以前是"有内容才渲染" —— 结果大多数 AI 回复上整块不见了
   *   （线上 409 条消息里只有 101 条带思考过程）。管理员看到 AI 的回答下
   *   面光秃秃的，只会有一个结论：看板把数据弄丢了。
   *   正确做法是块一直在（折叠着），没内容的如实写"本条没有输出"，
   *   把"模型没给"和"看板丢了"这两件事区分开 —— 后者才是事故。
   */
  function rsnHTML(raw) {
    var r = String(raw || '').trim();
    if (!r) return '<div class="ad-rsn-none">思考过程 · 本条没有输出</div>';
    return '<details class="ad-rsn"><summary>思考过程 · ' + num(r.length) + ' 字</summary>' +
      '<div class="ad-rsn-bd">' + esc(r) + '</div></details>';
  }

  // ---------- 渲染：对话全文 ----------
  function renderConvDetail(d) {
    var c = d.conversation;
    var box = $('#adConvDetail');
    box.style.display = '';
    var body = d.messages.length ? d.messages.map(function (m) {
      var cls = 'ad-msg' + (m.role === 'user' ? ' user' : '') + (m.deleted ? ' del' : '');
      var atts = (m.attachments && m.attachments.length)
        ? '<div class="dim" style="font-size:.74rem;margin-top:6px">附件：' + esc(m.attachments.map(function (a) { return a.name || a.id; }).join('、')) + '</div>'
        : '';
      var reason = m.role === 'assistant' ? rsnHTML(m.reasoning) : '';
      var mode = m.meta && m.meta.mode ? '<span class="ad-pill">' + esc(MODE_LABEL[m.meta.mode] || m.meta.mode) + '</span>' : '';
      return '<div class="' + cls + '"><div class="ad-msg-h">' +
        '<span class="ad-pill' + (m.role === 'user' ? ' pri' : '') + '">' + esc(ROLE_LABEL[m.role] || m.role) + '</span>' +
        '<span>#' + m.seq + '</span><span>' + esc(fmtTime(m.createdAt)) + '</span>' + mode +
        (m.deleted ? '<span class="ad-pill bad">已删除</span>' : '') +
        (m.status !== 'done' ? '<span class="ad-pill bad">' + esc(m.status) + '</span>' : '') +
        '</div><div class="ad-msg-b">' + esc(m.content) + '</div>' + atts + reason + '</div>';
    }).join('') : '<div class="ad-empty">这条对话没有消息</div>';

    box.innerHTML =
      '<div class="ad-crumb"><a id="adCdBack">← 返回对话列表</a>' +
      '<span>·</span><span>' + esc(c.spaceName) + '（' + esc(c.spaceId) + '）</span></div>' +
      '<h3>' + esc(c.title || '未命名') + '</h3>' +
      '<div class="hint">对话 ' + esc(c.id) + ' · 模型 ' + esc(c.model || '—') +
      ' · 创建 ' + esc(fmtTime(c.createdAt)) + ' · 共 ' + d.counts.total + ' 条' +
      (d.counts.deleted ? '（已删除 ' + d.counts.deleted + ' 条）' : '') + '</div>' +
      '<div class="ad-tools">' +
      '<label class="dim" style="font-size:.78rem"><input type="checkbox" id="adShowDel"' +
      (S.showDeleted ? ' checked' : '') + '> 显示已删除的消息</label>' +
      '<label class="dim" style="font-size:.78rem"><input type="checkbox" id="adAllRsn"' +
      (S.allReason ? ' checked' : '') + '> 展开全部思考过程</label>' +
      '<span class="dim" style="font-size:.76rem" id="adRsnCount"></span>' +
      '<span style="flex:1"></span>' +
      '<a class="btn sm" id="adExport">导出 Markdown</a>' +
      '</div>' +
      '<div class="ad-msgs">' + body + '</div>';

    $('#adCdBack').addEventListener('click', function () { box.style.display = 'none'; });
    $('#adShowDel').addEventListener('change', function (e) {
      S.showDeleted = e.target.checked;
      openConv(c.id);
    });
    // 「展开全部」只切 open 属性，不重新拉取 —— 一次网络往返换几十个 DOM 操作不划算。
    $('#adAllRsn').addEventListener('change', function (e) {
      S.allReason = e.target.checked;
      Array.prototype.forEach.call(box.querySelectorAll('details.ad-rsn'), function (el) { el.open = S.allReason; });
    });
    // 导出走 <a download>：浏览器直接存文件，不用前端拼 Blob，
    // 也不会把整篇对话再塞进一次 JSON 响应。
    $('#adExport').setAttribute('href', '/api/admin/conversations/' + encodeURIComponent(c.id) + '/export?_t=' + encodeURIComponent(S.token));
    $('#adExport').setAttribute('download', '');

    // 重渲染时把「展开全部」的开关状态带回来；顺便报个数，
    // 让"有几条没有思考过程"这件事一眼可见，不用一条条点开确认。
    var rsnEls = box.querySelectorAll('details.ad-rsn');
    if (S.allReason) Array.prototype.forEach.call(rsnEls, function (el) { el.open = true; });
    var noneCount = box.querySelectorAll('.ad-rsn-none').length;
    var cntEl = $('#adRsnCount');
    if (cntEl) {
      cntEl.textContent = rsnEls.length
        ? '本对话 ' + rsnEls.length + ' 条有思考过程' + (noneCount ? '，' + noneCount + ' 条没有' : '')
        : '本对话没有思考过程';
    }
    box.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function openConv(id) {
    var url = '/api/admin/conversations/' + encodeURIComponent(id) + (S.showDeleted ? '?includeDeleted=1' : '');
    return api(url).then(renderConvDetail).catch(function (e) { alert(e.message); });
  }

  // ---------- 加载 ----------
  function loadAll() {
    loadOverview();
    loadSpaces();
    loadConvs();
    loadModels();
    loadTts();
  }

  function loadOverview() {
    return api('/api/admin/overview?days=' + S.days).then(function (j) {
      renderKpis(j);
      renderChart(j.daily || []);
      renderBars($('#adModes'), j.modes || {}, MODE_LABEL, '窗口内没有记录');
      renderBars($('#adKinds'), j.activityKinds || {}, KIND_LABEL, '窗口内没有记录');
      renderTopSpaces(j.topSpaces || []);
    }).catch(handleAuthError);
  }

  function loadSpaces() {
    return api('/api/admin/usage/spaces?days=' + S.days).then(function (j) {
      S.spaces = j.spaces || [];
      renderSpaces(S.spaces);
      // 空间筛选下拉：保留当前选中值，避免刷新后跳回"全部空间"
      var sel = $('#adConvSpace');
      var cur = sel.value;
      sel.innerHTML = '<option value="">全部空间</option>' + S.spaces.map(function (s) {
        return '<option value="' + esc(s.spaceId) + '">' + esc(s.name) + '（' + esc(s.spaceId) + '）</option>';
      }).join('');
      sel.value = cur;
    }).catch(handleAuthError);
  }

  function loadConvs() {
    var q = '/api/admin/conversations?limit=' + S.convLimit + '&offset=' + S.convOffset;
    if (S.convSpace) q += '&spaceId=' + encodeURIComponent(S.convSpace);
    if (S.convQ) q += '&q=' + encodeURIComponent(S.convQ);
    return api(q).then(renderConvList).catch(handleAuthError);
  }

  function handleAuthError(e) {
    if (e && (e.status === 401 || e.code === 'NO_AUTH')) {
      logout();
      setErr('登录已过期，请重新输入管理密码');
      return;
    }
    console.error(e);
  }

  // ---------- 事件绑定 ----------
  function bind() {
    $('#adLogin').addEventListener('click', doLogin);
    $('#adPw').addEventListener('keydown', function (e) { if (e.key === 'Enter') doLogin(); });
    $('#adLogout').addEventListener('click', logout);
    $('#adReload').addEventListener('click', function () { $('#adSpaceDetail').style.display = 'none'; loadAll(); });

    $('#adRange').addEventListener('click', function (e) {
      var b = e.target.closest('button[data-d]');
      if (!b) return;
      S.days = Number(b.getAttribute('data-d')) || 14;
      Array.prototype.forEach.call(this.querySelectorAll('button'), function (x) { x.classList.remove('on'); });
      b.classList.add('on');
      loadOverview();
      loadSpaces();
    });

    // 空间表 → 看明细
    $('#adSpaces').addEventListener('click', function (e) {
      var tr = e.target.closest('tr[data-sid]');
      if (!tr) return;
      var sid = tr.getAttribute('data-sid');
      api('/api/admin/spaces/' + encodeURIComponent(sid) + '/usage?days=' + S.days)
        .then(renderSpaceDetail).catch(handleAuthError);
    });

    // 空间明细里的对话 → 直接打开全文
    $('#adSpaceDetail').addEventListener('click', function (e) {
      var el = e.target.closest('[data-cid],[data-open]');
      if (!el) return;
      var cid = el.getAttribute('data-cid') || el.getAttribute('data-open');
      if (cid) openConv(cid);
    });

    // 对话列表 → 打开全文
    $('#adConvList').addEventListener('click', function (e) {
      var el = e.target.closest('[data-cid],[data-open]');
      if (!el) return;
      var cid = el.getAttribute('data-cid') || el.getAttribute('data-open');
      if (cid) openConv(cid);
    });

    $('#adConvSpace').addEventListener('change', function () {
      S.convSpace = this.value; S.convOffset = 0; loadConvs();
    });
    $('#adConvSearch').addEventListener('click', function () {
      S.convQ = $('#adConvQ').value.trim(); S.convOffset = 0; loadConvs();
    });
    $('#adConvQ').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { S.convQ = this.value.trim(); S.convOffset = 0; loadConvs(); }
    });

    // 模型切换面板：保存 / 恢复默认 / 刷新目录
    $('#adModels').addEventListener('click', function (e) {
      var save = e.target.closest('[data-msave]');
      if (save) {
        var id = save.getAttribute('data-msave');
        var sel = this.querySelector('select[data-slot="' + id + '"]');
        setModel(id, sel ? sel.value : '');
        return;
      }
      var reset = e.target.closest('[data-mreset]');
      if (reset) { setModel(reset.getAttribute('data-mreset'), ''); return; }
      if (e.target.closest('#adModelRefresh')) { loadModels(true); }
    });

    // TTS 面板：保存 / 恢复默认 / 测试朗读
    $('#adTts').addEventListener('click', function (e) {
      if (e.target.closest('#adTtsSave')) {
        saveTts({
          provider: $('#adTtsProvider').value,
          model: $('#adTtsModel').value,
          voice: $('#adTtsVoice').value,
          baseUrl: $('#adTtsUrl').value,
          enabled: $('#adTtsEnabled').checked,
        });
        return;
      }
      if (e.target.closest('#adTtsReset')) {
        saveTts({ provider: '', model: '', voice: '', baseUrl: '', enabled: '' });
        return;
      }
      if (e.target.closest('#adTtsTest')) { testTts(); }
    });
  }

  // ---------- 启动 ----------
  bind();
  try {
    var saved = sessionStorage.getItem('hl_admin_token');
    if (saved) { S.token = saved; enter(); }
  } catch (e) {}
})();

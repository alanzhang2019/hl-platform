/* 后浪学习平台 · 学习计划海报（Canvas 端合成）
 *
 * 为什么这张"最终计划图"不交给 AI 生图直接画：
 *   实测可灵 o1 画中文的错字率约 30%（"百分数"→"百数分"、卡片里蹦出乱码、
 *   "圆与扇形"→"圆柱与扇形"、序号也串了）。教育材料有一个错字就废掉，
 *   而错在哪、错几个完全不可控，所以 AI 不能当"文字真源"。
 *
 * 分工：模型负责**内容**（结构化 JSON：天数/主题/要点/重点），
 *       这里负责**设计**（Canvas + 系统字体把字画准）。
 * 好处：汉字 100% 准确、不用等生图队列（90 秒）、断网也能出图、改动即时生效。
 *
 * 产出：1080 宽的竖版 PNG，家长存下来能直接发微信/打印。
 */
(function (global) {
  'use strict';

  var W = 1080;
  var PAD = 72;
  var PALETTE = ['#2563EB', '#7C3AED', '#EA580C', '#16A34A', '#0D9488', '#0891B2', '#DB2777', '#C9A24B'];
  var FONT = '"Noto Sans SC","Microsoft YaHei","PingFang SC","Hiragino Sans GB",sans-serif';

  function font(w, s) { return w + ' ' + s + 'px ' + FONT; }
  function cut(v, n) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n); }

  function roundRect(c, x, y, w, h, r) {
    r = Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2);
    c.beginPath();
    if (c.roundRect) { c.roundRect(x, y, w, h, r); return; }
    c.moveTo(x + r, y);
    c.arcTo(x + w, y, x + w, y + h, r);
    c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r);
    c.arcTo(x, y, x + w, y, r);
    c.closePath();
  }

  /** 按当前 font 量宽，超了加省略号。Canvas 没有 CSS 的 ellipsis，只能自己截 */
  function ellipsis(c, t, maxW) {
    if (c.measureText(t).width <= maxW) return t;
    var s = t;
    while (s.length > 1 && c.measureText(s + '…').width > maxW) s = s.slice(0, -1);
    return s + '…';
  }

  /** 标题这类大字要自适应：字太宽会顶出画布，缩到装得下为止 */
  function fitSize(c, t, maxW, start, min, weight) {
    var s = start;
    while (s > min) { c.font = font(weight, s); if (c.measureText(t).width <= maxW) break; s -= 2; }
    return s;
  }

  function cardShadow(c) {
    c.shadowColor = 'rgba(15,23,42,.08)';
    c.shadowBlur = 28;
    c.shadowOffsetY = 10;
  }
  function noShadow(c) { c.shadowColor = 'transparent'; c.shadowBlur = 0; c.shadowOffsetY = 0; }

  /** 左上角到右下角的线性渐变 */
  function grad(c, x0, y0, x1, y1, stops) {
    var g = c.createLinearGradient(x0, y0, x1, y1);
    stops.forEach(function (s) { g.addColorStop(s[0], s[1]); });
    return g;
  }

  // ================= 版式常量 =================
  var HEAD_H = 430;
  var ROW_H = 172;
  var ROW_GAP = 22;

  /**
   * 把计划 spec 画成海报。
   * @param {object} spec  {title, subtitle, days:[{label,theme,points,focus}], tips:[]}
   * @param {object} [opts] {date:'2026-10-02'}
   * @returns {HTMLCanvasElement|null}
   */
  function planPoster(spec, opts) {
    spec = spec || {};
    var o = opts || {};
    var days = (Array.isArray(spec.days) ? spec.days : [])
      .filter(function (d) { return d && typeof d === 'object'; })
      .slice(0, 8);
    if (!days.length) return null;                       // 没有条目就不出图，别产出一张空壳
    var tips = (Array.isArray(spec.tips) ? spec.tips : []).filter(Boolean).slice(0, 2);

    // 高度按内容算：列数与会话里的天数无关（3 天也能出图），不能让画布留一大截空白
    var listH = days.length * ROW_H + (days.length - 1) * ROW_GAP;
    var tipBlock = tips.length ? 12 + 62 + tips.length * 46 : 0;
    var H = HEAD_H + 52 + listH + tipBlock + 46 + 52 + 56;

    var cv = document.createElement('canvas');
    cv.width = W;
    cv.height = H;
    var c = cv.getContext('2d');
    if (!c) return null;

    // ---------- 底 ----------
    c.fillStyle = '#F5F7FB';
    c.fillRect(0, 0, W, H);

    // ---------- 头部 ----------
    c.fillStyle = grad(c, 0, 0, W, HEAD_H, [[0, '#0A0E1A'], [1, '#16305F']]);
    c.fillRect(0, 0, W, HEAD_H);

    // 装饰圆（品牌蓝，半透明）
    c.save();
    c.beginPath(); c.arc(1010, 40, 300, 0, Math.PI * 2);
    c.fillStyle = 'rgba(37,99,235,.22)'; c.fill();
    c.beginPath(); c.arc(80, 430, 240, 0, Math.PI * 2);
    c.fillStyle = 'rgba(56,189,248,.13)'; c.fill();
    c.restore();

    // 左上角小标签
    c.font = font('bold', 27);
    var tag = '学习计划';
    var tagW = c.measureText(tag).width + 44;
    c.fillStyle = 'rgba(255,255,255,.14)';
    roundRect(c, PAD + 16, 46, tagW, 56, 28); c.fill();
    c.fillStyle = 'rgba(255,255,255,.9)';
    c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillText(tag, PAD + 16 + tagW / 2, 46 + 29);

    // 标题
    var title = cut(spec.title, 34) || '学习计划';
    var tSize = fitSize(c, title, W - PAD * 2 - 16, 84, 40, 'bold');
    c.font = font('bold', tSize);
    c.textAlign = 'left'; c.textBaseline = 'alphabetic';
    c.fillStyle = '#FFFFFF';
    c.fillText(title, PAD + 16, 232);

    // 标题下的渐变短条
    c.fillStyle = grad(c, PAD + 16, 0, PAD + 16 + 132, 0, [[0, '#38BDF8'], [1, '#7DD3FC']]);
    roundRect(c, PAD + 16, 262, 132, 10, 5); c.fill();

    // 副标题
    if (spec.subtitle) {
      c.font = font('400', 33);
      c.fillStyle = 'rgba(255,255,255,.72)';
      c.fillText(ellipsis(c, cut(spec.subtitle, 40), W - PAD * 2 - 16), PAD + 16, 352);
    }

    // ---------- 卡片列表 ----------
    var y = HEAD_H + 52;
    days.forEach(function (d, k) {
      var col = PALETTE[k % PALETTE.length];
      var cy = y + ROW_H / 2;

      // 卡片本体
      c.save();
      cardShadow(c);
      c.fillStyle = '#FFFFFF';
      roundRect(c, PAD, y, W - PAD * 2, ROW_H, 30);
      c.fill();
      c.restore();

      // 左侧色条（裁进卡片圆角里，免得直角露出来）
      c.save();
      roundRect(c, PAD, y, W - PAD * 2, ROW_H, 30);
      c.clip();
      c.fillStyle = col;
      c.fillRect(PAD, y, 14, ROW_H);
      c.restore();

      // 序号徽章
      var bx = PAD + 100;
      c.beginPath(); c.arc(bx, cy, 40, 0, Math.PI * 2);
      c.fillStyle = col; c.fill();
      c.font = font('bold', 38);
      c.fillStyle = '#FFFFFF';
      c.textAlign = 'center'; c.textBaseline = 'middle';
      c.fillText(String(k + 1), bx, cy + 2);

      // 文字区
      var tx = bx + 68;
      var maxW = W - PAD * 2 - (tx - PAD) - 40;
      var label = cut(d.label, 12) || ('第 ' + (k + 1) + ' 组');

      c.textAlign = 'left'; c.textBaseline = 'alphabetic';
      c.font = font('bold', 30);
      var labelW = c.measureText(label).width;
      c.fillStyle = col;
      c.fillText(label, tx, cy - 6);

      // 主题跟在 label 后面；放不下就自己截断，绝不越界
      var theme = cut(d.theme, 30);
      if (theme) {
        c.font = font('bold', 42);
        c.fillStyle = '#0F172A';
        c.fillText(ellipsis(c, theme, maxW - labelW - 26), tx + labelW + 26, cy + 2);
      }

      // 第二行：优先显示 focus（那是模型标出来的重点），否则用第一条要点
      var sub = cut(d.focus, 34) || cut((d.points || [])[0], 34);
      if (sub) {
        c.font = font('400', 26);
        c.fillStyle = '#64748B';
        c.fillText(ellipsis(c, sub, maxW), tx, cy + 52);
      }
      y += ROW_H + ROW_GAP;
    });

    // ---------- 底部重点条 ----------
    // 标题独占一行：跟内容挤一行时，长句必被截断，读起来像"没写完"
    if (tips.length) {
      y += 12;
      var tipH = 62 + tips.length * 46;
      c.fillStyle = '#E8F0FE';
      roundRect(c, PAD, y, W - PAD * 2, tipH, 26); c.fill();
      c.save();
      roundRect(c, PAD, y, W - PAD * 2, tipH, 26); c.clip();
      c.fillStyle = '#2563EB';
      c.fillRect(PAD, y, 10, tipH);
      c.restore();

      var ttx = PAD + 44;
      var tmaxW = W - PAD * 2 - 88;
      c.textAlign = 'left'; c.textBaseline = 'alphabetic';
      c.font = font('bold', 27);
      c.fillStyle = '#1D4ED8';
      c.fillText('重点提醒', ttx, y + 46);

      tips.forEach(function (t, i) {
        c.font = font('400', i === 0 ? 28 : 27);
        c.fillStyle = i === 0 ? '#1E3A8A' : '#3B5BA9';
        c.fillText(ellipsis(c, t, tmaxW), ttx, y + 46 + 46 * (i + 1));
      });
      y += tipH;
    }

    // ---------- 落款 ----------
    y += 46;
    c.strokeStyle = '#E2E8F0';
    c.lineWidth = 2;
    c.beginPath(); c.moveTo(PAD, y); c.lineTo(W - PAD, y); c.stroke();

    var date = cut(o.date, 10);
    c.font = font('400', 27);
    c.fillStyle = '#94A3B8';
    c.textAlign = 'left'; c.textBaseline = 'alphabetic';
    c.fillText('后浪奔涌 · AI原生教育', PAD, y + 52);
    if (date) {
      c.textAlign = 'right';
      c.fillText(date, W - PAD, y + 52);
    }

    return cv;
  }

  global.HL = global.HL || {};
  global.HL.planPoster = planPoster;
})(window);

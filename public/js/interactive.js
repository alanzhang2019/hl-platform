/* 后浪学习平台 · 互动课堂（批次4 前端）
 *
 * 对方用 Pyodide 跑 matplotlib 出图；我们用**受限几何/函数 DSL（后端给的结构化 JSON）
 * + 前端原生 SVG + DOM 事件**做可交互。学生能拖点、滑参数、看切线/边长/角度实时变 ——
 * 这是"AI 讲题"和"AI 造教具"的区别。
 *
 * 三条硬约定（与全平台一致）：
 *   1. 零依赖：只用浏览器原生能力，不引任何库。
 *   2. 安全求值：表达式只走白名单分词 + 逆波兰求值，**绝不**用 eval / new Function。
 *      后端已经用 tokenOK 做过字符粗闸，这里再做一次真正的解析与求值，双保险。
 *   3. 原生 SVG：凡"画"出来的东西都是 <svg>，可缩放、可打印、可无障碍朗读。
 */
(function (global) {
  'use strict';
  const HL = global.HL || (global.HL = {});
  const esc = (typeof HL.esc === 'function') ? HL.esc
    : function (s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); };

  const PALETTE = ['#2563EB', '#0EA5E9', '#16A34A', '#D97706', '#7C3AED', '#DC2626', '#0891B2', '#DB2777'];

  // ================= 安全表达式求值 =================
  // 只允许：数字、变量（x 与参数名）、白名单函数、+ - * / ^ ( ) ,
  const FN = {
    sin: Math.sin, cos: Math.cos, tan: Math.tan, sqrt: Math.sqrt, abs: Math.abs,
    log: Math.log, exp: Math.exp, pow: Math.pow, min: Math.min, max: Math.max,
  };
  const FN_ARITY = { sin: 1, cos: 1, tan: 1, sqrt: 1, abs: 1, log: 1, exp: 1, pow: 2, min: 2, max: 2 };
  const PREC = { '^': 4, 'u-': 3, '*': 2, '/': 2, '+': 1, '-': 1 };

  function tokenize(f) {
    const s = String(f || '');
    const toks = [];
    let i = 0;
    while (i < s.length) {
      const c = s[i];
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }
      if (c >= '0' && c <= '9' || c === '.') {
        let j = i + 1;
        let dots = c === '.' ? 1 : 0;
        while (j < s.length && (s[j] >= '0' && s[j] <= '9' || s[j] === '.')) { if (s[j] === '.') dots++; j++; }
        if (dots > 1) throw new Error('数字写法不合法');
        toks.push({ t: 'num', v: Number(s.slice(i, j)) });
        i = j; continue;
      }
      if (/[a-zA-Z_]/.test(c)) {
        let j = i + 1;
        while (j < s.length && /[a-zA-Z0-9_]/.test(s[j])) j++;
        toks.push({ t: 'id', v: s.slice(i, j) });
        i = j; continue;
      }
      if ('+-*/^(),'.indexOf(c) >= 0) { toks.push({ t: 'op', v: c }); i++; continue; }
      throw new Error('表达式里有不允许的字符：' + c);
    }
    return toks;
  }

  function toRPN(toks) {
    const out = [], ops = [];
    let prev = null;
    for (let k = 0; k < toks.length; k++) {
      const tk = toks[k];
      if (tk.t === 'num') { out.push(tk); prev = tk; }
      else if (tk.t === 'id') {
        const nxt = toks[k + 1];
        if (nxt && nxt.t === 'op' && nxt.v === '(') ops.push({ t: 'func', v: tk.v, ar: FN_ARITY[tk.v] || 1 });
        else out.push({ t: 'var', v: tk.v });
        prev = tk;
      } else if (tk.t === 'op') {
        if (tk.v === '(') { ops.push(tk); prev = null; }
        else if (tk.v === ')') {
          while (ops.length && ops[ops.length - 1].v !== '(') out.push(ops.pop());
          if (!ops.length) throw new Error('括号不匹配');
          ops.pop();
          if (ops.length && ops[ops.length - 1].t === 'func') out.push(ops.pop());
          prev = null;
        } else if (tk.v === ',') {
          while (ops.length && ops[ops.length - 1].v !== '(') out.push(ops.pop());
          prev = null;
        } else if (tk.v === '-' && (prev === null || (prev.t === 'op' && prev.v !== ')'))) {
          ops.push({ t: 'op', v: 'u-' });
          prev = tk;
        } else {
          while (ops.length) {
            const top = ops[ops.length - 1];
            if (top.t === 'func' || top.v === '(') break;
            const tp = PREC[top.v], cp = PREC[tk.v];
            if ((tk.v === '^' && tp > cp) || (tk.v !== '^' && tp >= cp)) out.push(ops.pop());
            else break;
          }
          ops.push(tk);
          prev = tk;
        }
      }
    }
    while (ops.length) { const o = ops.pop(); if (o.v === '(') throw new Error('括号不匹配'); out.push(o); }
    return out;
  }

  function evalRPN(rpn, scope) {
    const st = [];
    for (const t of rpn) {
      if (t.t === 'num') st.push(t.v);
      else if (t.t === 'var') {
        const v = scope[t.v];
        if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error('变量 ' + t.v + ' 没有给值');
        st.push(v);
      } else if (t.t === 'func') {
        const fn = FN[t.v];
        if (!fn) throw new Error('不支持的函数：' + t.v);
        const ar = t.ar || 1;
        const args = [];
        for (let q = 0; q < ar; q++) args.unshift(st.pop());
        let r = ar === 1 ? fn(args[0]) : (ar === 2 ? fn(args[0], args[1]) : fn.apply(null, args));
        if (typeof r !== 'number' || !Number.isFinite(r)) throw new Error('这一步算不出有限的数');
        st.push(r);
      } else if (t.t === 'op') {
        if (t.v === 'u-') { st.push(-(st.pop())); continue; }
        const b = st.pop(), a = st.pop();
        let r;
        switch (t.v) { case '+': r = a + b; break; case '-': r = a - b; break; case '*': r = a * b; break; case '/': r = a / b; break; case '^': r = Math.pow(a, b); break; default: r = NaN; }
        if (!Number.isFinite(r)) throw new Error('这一步算不出有限的数');
        st.push(r);
      }
    }
    if (st.length !== 1) throw new Error('表达式不完整');
    return st[0];
  }

  function compile(f) {
    const rpn = toRPN(tokenize(f));
    if (!rpn.length) throw new Error('表达式是空的');
    return { rpn: rpn };
  }

  // ================= 工具 =================
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function fmt(v) {
    if (!Number.isFinite(v)) return '—';
    const r = Math.round(v * 100) / 100;
    if (Object.is(r, -0)) return '0';
    return String(r);
  }
  function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
  function bestStep(min, max) {
    const s = (max - min) / 100;
    if (s <= 0) return 0.01;
    if (s < 0.01) return 0.001;
    if (s < 0.1) return 0.01;
    if (s < 1) return 0.1;
    return 1;
  }
  function svgText(x, y, label, opt) {
    const o = opt || {};
    return '<text x="' + x + '" y="' + y + '" text-anchor="' + (o.anchor || 'middle') + '" font-size="' + (o.fs || 12) +
      '" font-weight="' + (o.weight || 500) + '" fill="' + (o.fill || 'var(--txt)') + '" dominant-baseline="middle" font-family="inherit">' + esc(label) + '</text>';
  }

  // 拖拽：全局只挂一次 window 监听，activeDrag 指向当前正在拖的那个渲染
  let activeDrag = null;
  let dragBound = false;
  function bindDragOnce() {
    if (dragBound) return; dragBound = true;
    function toData(svg, cx, cy) {
      try {
        const pt = svg.createSVGPoint(); pt.x = cx; pt.y = cy;
        const m = svg.getScreenCTM(); if (!m) return null;
        const p = pt.matrixTransform(m.inverse());
        return [ activeDrag.invX(p.x), activeDrag.invY(p.y) ];
      } catch (e) { return null; }
    }
    window.addEventListener('pointermove', e => {
      if (!activeDrag) return;
      const d = toData(activeDrag.svg, e.clientX, e.clientY); if (!d) return;
      activeDrag.apply(d[0], d[1]);
    });
    window.addEventListener('pointerup', () => { activeDrag = null; });
    window.addEventListener('pointercancel', () => { activeDrag = null; });
  }

  // ================= 函数图像 =================
  function renderFunctionPlot(dsl, mount) {
    mount.innerHTML = '';
    let fn;
    try { fn = compile(dsl.f || 'x'); }
    catch (e) {
      mount.innerHTML = '<div class="iv-err">这个表达式我暂时算不了：' + esc(e.message) + '。换个说法试试？</div>';
      return { destroy: function () { mount.innerHTML = ''; } };
    }

    const W = 520, H = 360, PL = 46, PR = 14, PT = 14, PB = 32;
    const pw = W - PL - PR, ph = H - PT - PB;
    let d0 = Number(dsl.domain && dsl.domain[0]), d1 = Number(dsl.domain && dsl.domain[1]);
    if (!Number.isFinite(d0) || !Number.isFinite(d1) || d0 >= d1) { d0 = -5; d1 = 5; }

    const params = (dsl.params || []).map(p => ({
      name: String(p.name || 'p'), min: Number(p.min), max: Number(p.max), value: Number(p.value),
      ok: Number.isFinite(Number(p.min)) && Number.isFinite(Number(p.max)) && Number.isFinite(Number(p.value)) && Number(p.min) < Number(p.max),
    }));
    const paramVals = {};
    params.forEach(p => { paramVals[p.name] = p.ok ? p.value : 0; });

    const hasPoint = !!(dsl.point && Number.isFinite(Number(dsl.point.x)));
    let pointX = hasPoint ? clamp(Number(dsl.point.x), d0, d1) : (d0 + d1) / 2;
    const showTangent = !!dsl.tangent;

    let ymin = -1, ymax = 1;
    let X, Y, invX, invY;
    function buildMap() {
      X = x => PL + (x - d0) / (d1 - d0) * pw;
      Y = y => PT + (1 - (y - ymin) / (ymax - ymin)) * ph;
      invX = vx => d0 + (vx - PL) / pw * (d1 - d0);
      invY = vy => ymin + (1 - (vy - PT) / ph) * (ymax - ymin);
    }
    function sampleY(x) {
      try { return evalRPN(fn.rpn, Object.assign({ x: x }, paramVals)); } catch (e) { return NaN; }
    }
    function recomputeRange() {
      let lo = Infinity, hi = -Infinity;
      const N = 200;
      for (let i = 0; i <= N; i++) {
        const y = sampleY(d0 + (d1 - d0) * i / N);
        if (Number.isFinite(y)) { if (y < lo) lo = y; if (y > hi) hi = y; }
      }
      if (!Number.isFinite(lo)) { lo = -1; hi = 1; }
      if (lo === hi) { lo -= 1; hi += 1; }
      const pad = (hi - lo) * 0.12 || 1;
      ymin = lo - pad; ymax = hi + pad;
    }
    recomputeRange(); buildMap();

    const fig = document.createElement('div'); fig.className = 'iv-fig';
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    svg.setAttribute('class', 'iv-svg');
    svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    svg.style.overflow = 'hidden';
    fig.appendChild(svg);

    const ctrl = document.createElement('div'); ctrl.className = 'iv-ctrl';
    const readout = document.createElement('div'); readout.className = 'iv-read'; ctrl.appendChild(readout);
    params.forEach((p, idx) => {
      if (!p.ok) return;
      const row = document.createElement('div'); row.className = 'iv-slider';
      row.innerHTML = '<label>' + esc(p.name) + ' = <b class="iv-pv" data-pv="' + idx + '">' + fmt(p.value) + '</b></label>' +
        '<input type="range" min="' + p.min + '" max="' + p.max + '" step="' + bestStep(p.min, p.max) + '" value="' + p.value + '" data-pidx="' + idx + '">';
      ctrl.appendChild(row);
    });
    fig.appendChild(ctrl);
    mount.appendChild(fig);

    function drawCurve() {
      let pts = [];
      const N = 260, band = (ymax - ymin) * 2;
      for (let i = 0; i <= N; i++) {
        const x = d0 + (d1 - d0) * i / N;
        const y = sampleY(x);
        if (Number.isFinite(y) && y >= ymin - band && y <= ymax + band) pts.push(X(x) + ',' + Y(y));
        else if (pts.length) pts.push('');
      }
      let inner = '';
      const xt = 5, yt = 4;
      for (let i = 0; i <= xt; i++) { const gx = PL + pw * i / xt; inner += '<line x1="' + gx + '" y1="' + PT + '" x2="' + gx + '" y2="' + (PT + ph) + '" stroke="var(--line)" stroke-width="1" opacity=".55"/>'; }
      for (let i = 0; i <= yt; i++) { const gy = PT + ph * i / yt; inner += '<line x1="' + PL + '" y1="' + gy + '" x2="' + (PL + pw) + '" y2="' + gy + '" stroke="var(--line)" stroke-width="1" opacity=".55"/>'; }
      const axY = Y(0), axX = X(0);
      if (axY >= PT && axY <= PT + ph) inner += '<line x1="' + PL + '" y1="' + axY + '" x2="' + (PL + pw) + '" y2="' + axY + '" stroke="var(--dim2)" stroke-width="1.3"/>';
      if (axX >= PL && axX <= PL + pw) inner += '<line x1="' + axX + '" y1="' + PT + '" x2="' + axX + '" y2="' + (PT + ph) + '" stroke="var(--dim2)" stroke-width="1.3"/>';
      // x 轴刻度数字
      for (let i = 0; i <= xt; i++) { const xv = d0 + (d1 - d0) * i / xt; inner += svgText(PL + pw * i / xt, PT + ph + 14, fmt(xv), { fs: 10, anchor: 'middle', fill: 'var(--dim2)' }); }
      inner += '<polyline class="iv-curve" points="' + pts.join(' ') + '" fill="none" stroke="var(--pri)" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round"/>';
      if (hasPoint) {
        const py = sampleY(pointX);
        if (Number.isFinite(py)) {
          const px = X(pointX), pY = Y(py);
          if (showTangent) {
            const h = (d1 - d0) * 1e-3 || 1e-3;
            const slope = (sampleY(pointX + h) - sampleY(pointX - h)) / (2 * h);
            if (Number.isFinite(slope)) {
              const t = (d1 - d0), x1 = pointX - t, x2 = pointX + t, y1 = py - slope * t, y2 = py + slope * t;
              inner += '<line class="iv-tan" x1="' + X(x1) + '" y1="' + Y(y1) + '" x2="' + X(x2) + '" y2="' + Y(y2) + '" stroke="var(--warn)" stroke-width="1.6" stroke-dasharray="5 4" opacity=".9"/>';
            }
          }
          inner += '<circle class="iv-v iv-pt" data-drag="point" cx="' + px + '" cy="' + pY + '" r="6.5" fill="var(--pri)" stroke="var(--panel)" stroke-width="2.5" style="cursor:grab"/>';
        }
      }
      svg.innerHTML = inner;
    }
    function updateReadout() {
      let html = '';
      if (hasPoint) {
        const py = sampleY(pointX);
        html += '<div>在 <b>x = ' + fmt(pointX) + '</b> 处，f(x) = <b>' + (Number.isFinite(py) ? fmt(py) : '—') + '</b></div>';
        if (showTangent && Number.isFinite(py)) {
          const h = (d1 - d0) * 1e-3 || 1e-3;
          const slope = (sampleY(pointX + h) - sampleY(pointX - h)) / (2 * h);
          if (Number.isFinite(slope)) html += '<div class="dim">这一点的切线斜率（瞬时变化率）≈ ' + fmt(slope) + '</div>';
        }
      } else {
        html += '<div class="dim">拖动下面的滑块，看看参数怎么改变曲线的形状</div>';
      }
      readout.innerHTML = html;
    }

    svg.addEventListener('pointerdown', e => {
      const t = e.target.closest('.iv-v'); if (!t) return;
      activeDrag = {
        svg: svg, invX: invX, invY: invY,
        apply: function (x) {
          pointX = clamp(x, d0, d1);
          drawCurve(); updateReadout();
        },
      };
      e.preventDefault();
    });
    ctrl.addEventListener('input', e => {
      const inp = e.target.closest('input[type=range][data-pidx]'); if (!inp) return;
      const idx = Number(inp.getAttribute('data-pidx'));
      const p = params[idx];
      p.value = Number(inp.value);
      paramVals[p.name] = p.value;
      const pv = ctrl.querySelector('[data-pv="' + idx + '"]'); if (pv) pv.textContent = fmt(p.value);
      recomputeRange(); buildMap(); drawCurve(); updateReadout();
    });

    bindDragOnce();
    drawCurve(); updateReadout();
    return { destroy: function () { mount.innerHTML = ''; } };
  }

  // ================= 几何图形 =================
  function renderGeometry(dsl, mount) {
    mount.innerHTML = '';
    const shapes = (dsl.shapes || []).filter(Boolean).map(s => {
      if (s.type === 'circle') return { type: 'circle', center: { x: Number(s.center.x), y: Number(s.center.y) }, r: Number(s.r) };
      return { type: s.type, points: (s.points || []).map(p => ({ x: Number(p.x), y: Number(p.y) })) };
    });
    if (!shapes.length) { mount.innerHTML = '<div class="iv-err">这个几何模型是空的</div>'; return { destroy: function () { mount.innerHTML = ''; } }; }
    const measures = dsl.measures || [];
    const wantSide = measures.indexOf('side') >= 0;
    const wantAngle = measures.indexOf('angle') >= 0;

    let xs = [], ys = [];
    shapes.forEach(s => {
      if (s.type === 'circle') { xs.push(s.center.x - s.r, s.center.x + s.r); ys.push(s.center.y - s.r, s.center.y + s.r); }
      else s.points.forEach(p => { xs.push(p.x); ys.push(p.y); });
    });
    let bx0 = Math.min.apply(null, xs), bx1 = Math.max.apply(null, xs);
    let by0 = Math.min.apply(null, ys), by1 = Math.max.apply(null, ys);
    const bw = (bx1 - bx0) || 10, bh = (by1 - by0) || 10;
    bx0 -= bw * 0.25; bx1 += bw * 0.25; by0 -= bh * 0.25; by1 += bh * 0.25;
    const WX0 = bx0, WX1 = bx1, WY0 = by0, WY1 = by1;

    const W = 520, H = 380, PL = 40, PR = 16, PT = 16, PB = 26;
    const pw = W - PL - PR, ph = H - PT - PB;
    const X = x => PL + (x - bx0) / (bx1 - bx0) * pw;
    const Y = y => PT + (1 - (y - by0) / (by1 - by0)) * ph;
    const invX = vx => bx0 + (vx - PL) / pw * (bx1 - bx0);
    const invY = vy => by0 + (1 - (vy - PT) / ph) * (by1 - by0);

    const fig = document.createElement('div'); fig.className = 'iv-fig';
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    svg.setAttribute('class', 'iv-svg');
    svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    svg.style.overflow = 'hidden';
    fig.appendChild(svg);

    const readout = document.createElement('div'); readout.className = 'iv-read';
    fig.appendChild(readout);
    mount.appendChild(fig);

    function angleDeg(opp, adj1, adj2) {
      const c = (adj1 * adj1 + adj2 * adj2 - opp * opp) / (2 * adj1 * adj2);
      if (!Number.isFinite(c) || c < -1 || c > 1) return NaN;
      return Math.acos(c) * 180 / Math.PI;
    }
    function measuresText() {
      const parts = [];
      shapes.forEach((s, si) => {
        const lab = String.fromCharCode(65 + si);
        if (s.type === 'triangle') {
          const A = s.points[0], B = s.points[1], C = s.points[2];
          const a = dist(B, C), b = dist(A, C), c = dist(A, B);
          if (wantSide) parts.push('边：a(BC)=' + fmt(a) + ' · b(AC)=' + fmt(b) + ' · c(AB)=' + fmt(c));
          if (wantAngle) {
            const angA = angleDeg(a, b, c), angB = angleDeg(b, a, c), angC = angleDeg(c, a, b);
            if (Number.isFinite(angA) && Number.isFinite(angB) && Number.isFinite(angC))
              parts.push('角：∠A=' + fmt(angA) + '° · ∠B=' + fmt(angB) + '° · ∠C=' + fmt(angC) + '°（和 ' + fmt(angA + angB + angC) + '°）');
          }
          if (!wantSide && !wantAngle) parts.push('三角形 ' + lab + '：边长 ' + fmt(a) + '/' + fmt(b) + '/' + fmt(c));
        } else if (s.type === 'segment') {
          parts.push('线段长度 = ' + fmt(dist(s.points[0], s.points[1])));
        } else if (s.type === 'circle') {
          parts.push('半径 = ' + fmt(s.r) + ' · 周长 = ' + fmt(2 * Math.PI * s.r) + ' · 面积 = ' + fmt(Math.PI * s.r * s.r));
        }
      });
      return parts.join('<br>');
    }
    function draw() {
      let inner = '';
      const xt = 4, yt = 4;
      for (let i = 0; i <= xt; i++) { const gx = PL + pw * i / xt; inner += '<line x1="' + gx + '" y1="' + PT + '" x2="' + gx + '" y2="' + (PT + ph) + '" stroke="var(--line)" stroke-width="1" opacity=".45"/>'; }
      for (let i = 0; i <= yt; i++) { const gy = PT + ph * i / yt; inner += '<line x1="' + PL + '" y1="' + gy + '" x2="' + (PL + pw) + '" y2="' + gy + '" stroke="var(--line)" stroke-width="1" opacity=".45"/>'; }
      shapes.forEach((s, si) => {
        const col = PALETTE[si % PALETTE.length];
        if (s.type === 'circle') {
          const rPx = (s.r) / (bx1 - bx0) * pw;
          inner += '<circle cx="' + X(s.center.x) + '" cy="' + Y(s.center.y) + '" r="' + rPx + '" fill="' + col + '" fill-opacity=".12" stroke="' + col + '" stroke-width="2"/>';
          inner += '<circle class="iv-v" data-drag="c" data-shape="' + si + '" data-iscenter="1" cx="' + X(s.center.x) + '" cy="' + Y(s.center.y) + '" r="7" fill="' + col + '" stroke="var(--panel)" stroke-width="2.5" style="cursor:grab"/>';
        } else if (s.type === 'triangle') {
          const ps = s.points.map(p => X(p.x) + ',' + Y(p.y)).join(' ');
          inner += '<polygon points="' + ps + '" fill="' + col + '" fill-opacity=".12" stroke="' + col + '" stroke-width="2" stroke-linejoin="round"/>';
          s.points.forEach((p, pi) => {
            inner += '<circle class="iv-v" data-drag="v" data-shape="' + si + '" data-vi="' + pi + '" cx="' + X(p.x) + '" cy="' + Y(p.y) + '" r="7" fill="' + col + '" stroke="var(--panel)" stroke-width="2.5" style="cursor:grab"/>';
            inner += svgText(X(p.x) + 11, Y(p.y) - 11, String.fromCharCode(65 + pi), { fs: 13, anchor: 'start', weight: 700, fill: col });
          });
        } else { // segment
          const A = s.points[0], B = s.points[1];
          inner += '<line x1="' + X(A.x) + '" y1="' + Y(A.y) + '" x2="' + X(B.x) + '" y2="' + Y(B.y) + '" stroke="' + col + '" stroke-width="2.2" stroke-linecap="round"/>';
          [A, B].forEach((p, pi) => {
            inner += '<circle class="iv-v" data-drag="v" data-shape="' + si + '" data-vi="' + pi + '" cx="' + X(p.x) + '" cy="' + Y(p.y) + '" r="7" fill="' + col + '" stroke="var(--panel)" stroke-width="2.5" style="cursor:grab"/>';
            inner += svgText(X(p.x) + 10, Y(p.y) - 10, String.fromCharCode(65 + pi), { fs: 13, anchor: 'start', weight: 700, fill: col });
          });
        }
      });
      svg.innerHTML = inner;
    }
    svg.addEventListener('pointerdown', e => {
      const t = e.target.closest('.iv-v'); if (!t) return;
      const shape = Number(t.getAttribute('data-shape'));
      const isCenter = t.getAttribute('data-iscenter') === '1';
      const vi = t.getAttribute('data-vi') != null ? Number(t.getAttribute('data-vi')) : null;
      activeDrag = {
        svg: svg, invX: invX, invY: invY,
        apply: function (x, y) {
          x = clamp(x, WX0, WX1); y = clamp(y, WY0, WY1);
          if (isCenter) shapes[shape].center = { x: x, y: y };
          else shapes[shape].points[vi] = { x: x, y: y };
          draw(); readout.innerHTML = measuresText();
        },
      };
      e.preventDefault();
    });
    bindDragOnce();
    draw(); readout.innerHTML = measuresText() || '<div class="dim">拖动顶点，看看边长和角度怎么变</div>';
    return { destroy: function () { mount.innerHTML = ''; } };
  }

  // ================= 顶层渲染 =================
  function render(dsl, mount) {
    if (!dsl || typeof dsl !== 'object') { mount.innerHTML = '<div class="iv-err">互动模型数据缺失</div>'; return { destroy: function () { mount.innerHTML = ''; } }; }
    if (dsl.type === 'function-plot') return renderFunctionPlot(dsl, mount);
    if (dsl.type === 'geometry') return renderGeometry(dsl, mount);
    mount.innerHTML = '<div class="iv-err">暂不支持的互动类型：' + esc(dsl.type) + '</div>';
    return { destroy: function () { mount.innerHTML = ''; } };
  }

  // ================= 右侧面板 =================
  let panelBound = false;
  function bindPanelOnce(panel) {
    if (panel._ivBound) return; panel._ivBound = true;
    const close = panel.querySelector('#ivClose');
    if (close) close.addEventListener('click', () => { panel.hidden = true; panel.classList.add('hidden'); });
    const full = panel.querySelector('#ivFull');
    if (full) full.addEventListener('click', () => panel.classList.toggle('full'));
    const res = panel.querySelector('#ivResizer');
    if (res) {
      res.addEventListener('pointerdown', e => {
        e.preventDefault();
        const startX = e.clientX, startW = panel.getBoundingClientRect().width;
        document.body.classList.add('resizing');
        function mv(ev) {
          const w = clamp(startW + (startX - ev.clientX), 320, Math.min(720, window.innerWidth - 80));
          panel.style.width = w + 'px';
        }
        function up() {
          document.body.classList.remove('resizing');
          window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up);
        }
        window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up);
      });
    }
  }

  function openInPanel(dsl, opts) {
    opts = opts || {};
    let panel = document.getElementById('ivPanel');
    if (!panel) {
      // 分享页（document.body 被替换过）没有面板容器：现场建一个全屏的
      panel = document.createElement('div');
      panel.id = 'ivPanel';
      panel.className = 'iv-panel full';
      document.body.appendChild(panel);
      panel.innerHTML = '<div class="iv-resizer" id="ivResizer"></div>' +
        '<div class="iv-h"><b id="ivTitle">互动课堂</b><div class="sp"></div>' +
        '<button class="btn ghost sm" id="ivFull" type="button" title="退出全屏">⤢</button>' +
        '<button class="btn ghost sm" id="ivClose" type="button">关闭</button></div>' +
        '<div class="iv-body" id="ivBody"></div>';
    }
    panel.hidden = false; panel.classList.remove('hidden');
    panel.classList.remove('full');
    const title = panel.querySelector('#ivTitle'); if (title) title.textContent = opts.title || (dsl && dsl.title) || '互动课堂';
    const body = panel.querySelector('#ivBody'); body.innerHTML = '';
    render(dsl, body);
    bindPanelOnce(panel);
    // 分享按钮：由调用方（app.js）按需注入，这里只负责渲染主体
    return { panel: panel, body: body };
  }

  HL.interactive = {
    render: render,
    openInPanel: openInPanel,
    evalExpr: function (f, scope) { return evalRPN(compile(f).rpn, scope || {}); },
  };
})(window);

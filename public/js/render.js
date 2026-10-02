/* 后浪学习平台 · 渲染管线
 *
 * 三条硬约定：
 *   1. AI 产出的"图"不是图片 —— 模型只输出结构化 JSON（```svg-json），
 *      由这里在前端用原生 SVG 画出来。可缩放、可复制、可无障碍朗读、可打印。
 *      判据：需要被理解/编辑/导出 → SVG；只是好看 → Canvas（见 app.js 的粒子层）。
 *   2. 不引入任何外部库（KaTeX / marked / highlight.js 都不用）。
 *      数学式用自研的轻量解析器，够用即可，不追求 TeX 完整语义。
 *   3. 必须能渲染"半截文本" —— 流式输出时代码围栏常常还没闭合，
 *      未闭合的围栏按代码块处理，不能把半截 JSON 当正文渲染出来。
 */
(function (global) {
  'use strict';

  // ================= 基础 =================
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  const PH = '\u0000';   // 占位符分隔符

  // ================= 数学（轻量 TeX 子集）=================
  const SYM = {
    times: '×', div: '÷', cdot: '·', pm: '±', mp: '∓', ast: '∗',
    le: '≤', leq: '≤', ge: '≥', geq: '≥', ne: '≠', neq: '≠', approx: '≈', equiv: '≡',
    infty: '∞', pi: 'π', theta: 'θ', alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ',
    Delta: 'Δ', lambda: 'λ', mu: 'μ', sigma: 'σ', phi: 'φ', omega: 'ω', rho: 'ρ',
    sum: '∑', prod: '∏', int: '∫', lim: 'lim',
    to: '→', rightarrow: '→', Rightarrow: '⇒', leftarrow: '←', leftrightarrow: '↔',
    angle: '∠', perp: '⊥', parallel: '∥', triangle: '△', circ: '∘', degree: '°',
    because: '∵', therefore: '∴', in: '∈', notin: '∉', subset: '⊂', cup: '∪', cap: '∩',
    ldots: '…', cdots: '⋯', quad: ' ', qquad: '  ', ',': ' ', ';': ' ', ' ': ' ', '!': '',
    '%': '%', '#': '#', '&': '&', '{': '{', '}': '}',
  };

  function texToHtml(tex) {
    let i = 0;
    const s = String(tex == null ? '' : tex);

    function readArg() {
      while (s[i] === ' ') i++;
      if (s[i] === '{') {
        let d = 1, j = i + 1;
        while (j < s.length && d > 0) {
          if (s[j] === '\\') { j += 2; continue; }
          if (s[j] === '{') d++;
          else if (s[j] === '}') { d--; if (d === 0) break; }
          j++;
        }
        const inner = s.slice(i + 1, j);
        i = j + 1;
        return inner;
      }
      if (s[i] === '\\') {
        const m = /^\\([a-zA-Z]+|.)/.exec(s.slice(i));
        const t = m ? m[0] : s[i];
        i += t.length;
        return t;
      }
      return s[i++] || '';
    }

    function parse(stop) {
      let out = '';
      while (i < s.length) {
        const c = s[i];
        if (stop && c === stop) return out;
        if (c === '\\') {
          const m = /^\\([a-zA-Z]+|.)/.exec(s.slice(i));
          const cmd = m[1];
          i += m[0].length;
          if (cmd === 'frac' || cmd === 'dfrac' || cmd === 'tfrac') {
            const a = readArg(), b = readArg();
            out += '<span class="frac"><span class="num">' + parse2(a) + '</span><span class="den">' + parse2(b) + '</span></span>';
          } else if (cmd === 'sqrt') {
            let idx = null;
            if (s[i] === '[') { const j = s.indexOf(']', i); idx = s.slice(i + 1, j); i = j + 1; }
            const a = readArg();
            out += '<span class="sqrt">' + (idx ? '<sup>' + parse2(idx) + '</sup>' : '') + '√<span class="rad">' + parse2(a) + '</span></span>';
          } else if (cmd === 'text' || cmd === 'mathrm' || cmd === 'operatorname' || cmd === 'mbox') {
            out += '<span style="font-style:normal">' + esc(readArg()) + '</span>';
          } else if (cmd === 'left' || cmd === 'right') {
            const n = s[i]; i++;
            out += esc(n === '.' ? '' : n);
          } else if (cmd === 'overline') {
            out += '<span style="text-decoration:overline">' + parse2(readArg()) + '</span>';
          } else if (cmd === 'vec') {
            out += '<span style="text-decoration:overline">' + parse2(readArg()) + '</span>';
          } else if (SYM[cmd] !== undefined) {
            out += SYM[cmd];
          } else {
            out += esc(cmd);
          }
        } else if (c === '{') {
          i++; out += parse('}'); if (s[i] === '}') i++;
        } else if (c === '^' || c === '_') {
          i++;
          const tag = c === '^' ? 'sup' : 'sub';
          let inner;
          if (s[i] === '{') { i++; inner = parse('}'); if (s[i] === '}') i++; }
          else {
            const m = /^\\?[A-Za-z0-9]/.exec(s.slice(i));
            inner = m ? m[0] : '';
            i += inner.length;
            inner = esc(inner);
          }
          out += '<' + tag + '>' + inner + '</' + tag + '>';
        } else if (c === ' ') {
          out += ' '; i++;
        } else if (c === '=' || c === '+' || c === '-' || c === '<' || c === '>') {
          out += '<span style="font-style:normal;padding:0 .12em">' + esc(c) + '</span>'; i++;
        } else {
          out += esc(c); i++;
        }
      }
      return out;
    }
    // 子表达式独立解析（复用同一份 SYM 表）
    function parse2(t) { return texToHtml(t); }
    return parse(null);
  }

  function renderMath(tex, display) {
    const html = texToHtml(tex);
    return display
      ? '<span class="math math-block">' + html + '</span>'
      : '<span class="math">' + html + '</span>';
  }

  // ================= 代码高亮（轻量）=================
  const JS_KW = ['const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'do',
    'class', 'extends', 'new', 'await', 'async', 'import', 'export', 'default', 'from', 'of', 'in',
    'try', 'catch', 'finally', 'throw', 'typeof', 'instanceof', 'delete', 'void', 'yield',
    'this', 'super', 'null', 'undefined', 'true', 'false', 'break', 'continue', 'switch', 'case', 'static'];
  const PY_KW = ['def', 'return', 'if', 'elif', 'else', 'for', 'while', 'class', 'import', 'from', 'as',
    'with', 'try', 'except', 'finally', 'lambda', 'None', 'True', 'False', 'and', 'or', 'not', 'in',
    'is', 'pass', 'break', 'continue', 'yield', 'async', 'await', 'self', 'global', 'nonlocal', 'raise'];
  const SQL_KW = ['select', 'from', 'where', 'insert', 'into', 'values', 'update', 'set', 'delete',
    'create', 'table', 'index', 'join', 'left', 'right', 'inner', 'outer', 'on', 'group', 'by', 'order',
    'having', 'limit', 'offset', 'and', 'or', 'not', 'null', 'as', 'primary', 'key', 'unique'];

  function spec(lang) {
    const l = String(lang || '').toLowerCase();
    if (l === 'json') return {
      re: /"(?:\\.|[^"\\])*"|-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b|\b(?:true|false|null)\b/g,
      // 键还是值？看这个 token 后面是不是紧跟冒号
      cls: (m, code) => {
        if (m[0][0] === '"') return /^\s*:/.test(code.slice(m.index + m[0].length)) ? 'tk-f' : 'tk-s';
        return /^(true|false|null)$/.test(m[0]) ? 'tk-k' : 'tk-n';
      },
    };
    if (l === 'python' || l === 'py') return { re: new RegExp('#[^\\n]*|"""[\\s\\S]*?"""|\'\'\'[\\s\\S]*?\'\'\'|"(?:\\\\.|[^"\\\\])*"|\'(?:\\\\.|[^\'\\\\])*\'|\\b(?:' + PY_KW.join('|') + ')\\b|\\b\\d+(?:\\.\\d+)?\\b', 'g'), cls: m => m[0][0] === '#' ? 'tk-c' : /^["']/.test(m[0]) ? 'tk-s' : PY_KW.indexOf(m[0]) >= 0 ? 'tk-k' : 'tk-n' };
    if (l === 'sql') return { re: new RegExp('--[^\\n]*|\'(?:[^\']|\'\')*\'|\\b(?:' + SQL_KW.join('|') + ')\\b|\\b\\d+(?:\\.\\d+)?\\b', 'gi'), cls: m => m[0].slice(0, 2) === '--' ? 'tk-c' : m[0][0] === '\'' ? 'tk-s' : SQL_KW.indexOf(m[0].toLowerCase()) >= 0 ? 'tk-k' : 'tk-n' };
    if (l === 'js' || l === 'javascript' || l === 'ts' || l === 'typescript' || l === 'node' || l === 'jsx') {
      return { re: new RegExp('//[^\\n]*|/\\*[\\s\\S]*?\\*/|"(?:\\\\.|[^"\\\\])*"|\'(?:\\\\.|[^\'\\\\])*\'|`(?:\\\\.|[^`\\\\])*`|\\b(?:' + JS_KW.join('|') + ')\\b|\\b\\d+(?:\\.\\d+)?\\b', 'g'), cls: m => /^(\/\/|\/\*)/.test(m[0]) ? 'tk-c' : /^["'`]/.test(m[0]) ? 'tk-s' : JS_KW.indexOf(m[0]) >= 0 ? 'tk-k' : 'tk-n' };
    }
    if (l === 'html' || l === 'xml' || l === 'svg') return { re: /<!--[\s\S]*?-->|<\/?[a-zA-Z][\w-]*|"(?:[^"]*)"|\b[a-zA-Z-]+(?==)/g, cls: m => m[0].slice(0, 4) === '<!--' ? 'tk-c' : m[0][0] === '<' ? 'tk-k' : m[0][0] === '"' ? 'tk-s' : 'tk-f' };
    if (l === 'css') return { re: /\/\*[\s\S]*?\*\/|#[0-9a-fA-F]{3,8}\b|[-a-z]+(?=\s*:)|"(?:[^"]*)"/g, cls: m => m[0].slice(0, 2) === '/*' ? 'tk-c' : m[0][0] === '#' ? 'tk-n' : m[0][0] === '"' ? 'tk-s' : 'tk-f' };
    return null;
  }

  function highlight(code, lang) {
    const sp = spec(lang);
    if (!sp) return esc(code);
    let out = '', last = 0, m;
    sp.re.lastIndex = 0;
    while ((m = sp.re.exec(code)) !== null) {
      if (m.index > last) out += esc(code.slice(last, m.index));
      const c = sp.cls(m, code);
      out += c ? '<span class="' + c + '">' + esc(m[0]) + '</span>' : esc(m[0]);
      last = m.index + m[0].length;
      if (m[0] === '') sp.re.lastIndex++;
    }
    out += esc(code.slice(last));
    return out;
  }

  // ================= svg-json → 原生 SVG =================
  const ART_NAME = {
    mindmap: '思维导图', flow: '流程图', timeline: '时间轴',
    geometry: '几何图形', bars: '条形对比', tree: '层级图', concept: '概念关系图',
    illustration: '配图',
  };
  const PALETTE = ['var(--pri)', '#0EA5E9', '#16A34A', '#D97706', '#7C3AED', '#DC2626', '#0891B2', '#DB2777'];

  function wrapText(t, per) {
    const s = String(t == null ? '' : t);
    if (s.length <= per) return [s];
    const out = [];
    // 中文按字断，英文尽量按词断
    let cur = '';
    for (const ch of s) {
      cur += ch;
      if (cur.length >= per && !/[A-Za-z0-9]$/.test(ch)) { out.push(cur); cur = ''; }
      else if (cur.length >= per + 6) { out.push(cur); cur = ''; }
    }
    if (cur) out.push(cur);
    return out;
  }
  function svgText(x, y, label, opt) {
    const o = opt || {};
    const lines = wrapText(label, o.per || 10);
    const lh = o.lh || 16;
    const fs = o.fs || 13;
    const anchor = o.anchor || 'middle';
    const fill = o.fill || 'var(--txt)';
    const weight = o.weight || 500;
    const start = y - (lines.length - 1) * lh / 2;
    return lines.map((ln, k) =>
      '<text x="' + x + '" y="' + (start + k * lh) + '" text-anchor="' + anchor + '" ' +
      'font-size="' + fs + '" font-weight="' + weight + '" fill="' + fill + '" ' +
      'dominant-baseline="middle" font-family="inherit">' + esc(ln) + '</text>'
    ).join('');
  }
  function defsArrow() {
    return '<defs><marker id="hlArrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">' +
      '<path d="M0 0 L10 5 L0 10 z" fill="var(--dim2)"/></marker></defs>';
  }
  function art(kind, title, inner, w, h, extra) {
    const kindName = ART_NAME[kind] || kind;
    const head = title || kindName || '图示';
    // 模型有时把 title 直接写成类名（"几何图形"），标题和类型标签就会重成
    // 「几何图形 几何图形」。两者一样时只留一个。
    const chip = (head === kindName) ? '' : '<span>' + esc(kindName) + '</span>';
    return '<div class="art"><div class="art-h"><b>' + esc(head) + '</b>' + chip + (extra || '') + '</div>' +
      '<svg viewBox="0 0 ' + w + ' ' + h + '" xmlns="http://www.w3.org/2000/svg" role="img" ' +
      'aria-label="' + esc(head) + '" preserveAspectRatio="xMidYMid meet">' +
      defsArrow() + inner + '</svg></div>';
  }

  // ---- 通用：节点图（mindmap / flow / tree / concept）----
  function nodeGraph(spec2) {
    const nodes = (spec2.nodes || []).filter(n => n && (n.id != null || n.label));
    if (!nodes.length) return null;
    nodes.forEach((n, k) => { if (n.id == null) n.id = 'n' + k; if (n.label == null) n.label = String(n.id); });
    const byId = {};
    nodes.forEach(n => { byId[n.id] = n; });
    const edges = (spec2.edges || []).filter(e => e && byId[e.from] && byId[e.to]);
    const kind = spec2.kind || 'mindmap';

    if (kind === 'flow') {
      // 纵向流程：一列，箭头连接
      const W = 460, NW = 300, NH = 40, GAP = 34, PAD = 20;
      const H = PAD * 2 + nodes.length * NH + (nodes.length - 1) * GAP;
      const cx = W / 2;
      let s = '';
      nodes.forEach((n, k) => {
        const y = PAD + k * (NH + GAP);
        const color = n.color || PALETTE[k % PALETTE.length];
        s += '<rect x="' + (cx - NW / 2) + '" y="' + y + '" width="' + NW + '" height="' + NH + '" rx="10" ' +
          'fill="var(--panel)" stroke="' + color + '" stroke-width="1.6"/>';
        s += svgText(cx, y + NH / 2, n.label, { per: 16, fs: 13.5 });
        if (k < nodes.length - 1) {
          const y2 = y + NH + GAP;
          s += '<line x1="' + cx + '" y1="' + (y + NH) + '" x2="' + cx + '" y2="' + (y2 - 4) + '" ' +
            'stroke="var(--dim2)" stroke-width="1.6" marker-end="url(#hlArrow)"/>';
          const lab = (edges.find(e => e.from === n.id && e.to === nodes[k + 1].id) || {}).label;
          if (lab) s += svgText(cx + 10, y + NH + GAP / 2, lab, { per: 12, fs: 11, anchor: 'start', fill: 'var(--dim)' });
        }
      });
      return art('flow', spec2.title, s, W, H);
    }

    // 树/导图：BFS 分层，横向展开（左→右），同层纵向均分
    const children = {}, incoming = {};
    nodes.forEach(n => { children[n.id] = []; incoming[n.id] = 0; });
    edges.forEach(e => { children[e.from].push(e.to); incoming[e.to]++; });
    let roots = nodes.filter(n => incoming[n.id] === 0).map(n => n.id);
    if (!roots.length) roots = [nodes[0].id];

    const depth = {}, order = [];
    let frontier = roots.slice();
    roots.forEach(r => { depth[r] = 0; });
    const seen = {};
    while (frontier.length) {
      const next = [];
      frontier.forEach(id => {
        if (seen[id]) return;
        seen[id] = 1; order.push(id);
        children[id].forEach(c => { if (depth[c] == null || depth[c] < depth[id] + 1) { depth[c] = depth[id] + 1; next.push(c); } });
      });
      frontier = next;
    }
    nodes.forEach(n => { if (depth[n.id] == null) { depth[n.id] = 1; order.push(n.id); } });

    const maxD = Math.max.apply(null, Object.keys(depth).map(k => depth[k]));
    const layers = [];
    for (let d = 0; d <= maxD; d++) layers[d] = [];
    nodes.forEach(n => layers[depth[n.id]].push(n));

    const NW = 132, NH = 38, GX = 62, GY = 16, PAD = 16;
    const colH = layers.map(L => L.length * NH + Math.max(0, L.length - 1) * GY);
    const H = Math.max.apply(null, colH.concat([120])) + PAD * 2;
    const W = PAD * 2 + (maxD + 1) * NW + maxD * GX;
    const pos = {};
    layers.forEach((L, d) => {
      const x = PAD + d * (NW + GX);
      let y = (H - colH[d]) / 2;
      L.forEach(n => { pos[n.id] = { x: x, y: y, cy: y + NH / 2 }; y += NH + GY; });
    });

    let s = '';
    // 连线（先画线，压在节点下）
    edges.forEach(e => {
      const a = pos[e.from], b = pos[e.to];
      if (!a || !b) return;
      const x1 = a.x + NW, y1 = a.cy, x2 = b.x, y2 = b.cy;
      const mx = (x1 + x2) / 2;
      s += '<path d="M' + x1 + ' ' + y1 + ' C' + mx + ' ' + y1 + ',' + mx + ' ' + y2 + ',' + (x2 - 5) + ' ' + y2 + '" ' +
        'fill="none" stroke="var(--dim2)" stroke-width="1.4" marker-end="url(#hlArrow)" opacity=".8"/>';
      if (e.label) s += svgText(mx, (y1 + y2) / 2 - 8, e.label, { per: 10, fs: 10.5, fill: 'var(--dim)' });
    });
    // 节点
    nodes.forEach((n, k) => {
      const p = pos[n.id];
      if (!p) return;
      const d = depth[n.id];
      const color = n.color || (d === 0 ? 'var(--pri)' : PALETTE[(d + k) % PALETTE.length]);
      const isRoot = d === 0;
      s += '<rect x="' + p.x + '" y="' + p.y + '" width="' + NW + '" height="' + NH + '" rx="9" ' +
        'fill="' + (isRoot ? 'var(--pri-soft)' : 'var(--panel)') + '" stroke="' + color + '" stroke-width="' + (isRoot ? 2 : 1.4) + '"/>';
      s += svgText(p.x + NW / 2, p.cy, n.label, { per: 8, fs: 12.5, weight: isRoot ? 650 : 500 });
    });
    return art(kind, spec2.title, s, W, H);
  }

  // ---- 时间轴 ----
  function timeline(spec2) {
    const items = (spec2.items || spec2.nodes || []).filter(Boolean);
    if (!items.length) return null;
    const W = Math.max(420, items.length * 128 + 40), H = 210, axisY = H / 2;
    let s = '<line x1="24" y1="' + axisY + '" x2="' + (W - 24) + '" y2="' + axisY + '" stroke="var(--line-2)" stroke-width="2"/>';
    const step = (W - 48) / Math.max(1, items.length - 1 || 1);
    items.forEach((it, k) => {
      const x = items.length === 1 ? W / 2 : 24 + k * step;
      const up = k % 2 === 0;
      const color = it.color || PALETTE[k % PALETTE.length];
      const label = it.time || it.label || it.date || ('第 ' + (k + 1) + ' 步');
      const desc = it.desc || it.text || it.description || '';
      s += '<circle cx="' + x + '" cy="' + axisY + '" r="6" fill="' + color + '" stroke="var(--panel)" stroke-width="2.5"/>';
      const ty = up ? axisY - 78 : axisY + 78;
      s += '<line x1="' + x + '" y1="' + (up ? axisY - 6 : axisY + 6) + '" x2="' + x + '" y2="' + (up ? axisY - 44 : axisY + 44) + '" stroke="' + color + '" stroke-width="1.4" opacity=".6"/>';
      s += svgText(x, ty - 8, label, { per: 9, fs: 12.5, weight: 650, fill: color });
      if (desc) s += svgText(x, ty + 12, desc, { per: 9, fs: 11, fill: 'var(--dim)' });
    });
    return art('timeline', spec2.title, s, W, H);
  }

  // ---- 几何图形 ----
  function geometry(spec2) {
    const W = 420, H = 320, PAD = 34;
    const pts = (spec2.points || []).filter(Boolean);
    const segs = spec2.segments || spec2.lines || [];
    const circles = spec2.circles || [];
    const labels = spec2.labels || [];
    const polys = spec2.polygons || spec2.shapes || [];

    // 顶点引用解析：标签名 → points 里对应的那个点。
    // ★ 线段和多边形**都要**用它。模型最习惯的写法是 ["A","B","C"]（顶点名），
    //   而不是把坐标再抄一遍；之前只有 segments 认这种写法，polygons 直接按坐标读，
    //   于是 p.x 是 undefined → X() 算出 NaN → 画出一条 d="MNaN NaN LNaN NaN…" 的废路径，
    //   控制台刷一屏报错、图里那个三角形凭空消失。写标签还是写坐标，这里都必须认。
    const findPt = ref => {
      if (ref == null) return null;
      if (typeof ref === 'object') return ref;
      const key = String(ref);
      return pts.filter(p => p.label === key || p.name === key || p.id === key)[0] || null;
    };
    const finitePoint = it => {
      const p = findPt(it);
      if (!p || p.x == null || p.y == null) return null;
      return (isFinite(Number(p.x)) && isFinite(Number(p.y))) ? p : null;
    };
    /** 多边形 → 有效顶点。解析不出 ≥3 个有限点就整条丢掉（宁可少画，不可画 NaN） */
    const polyPts = pg => {
      const arr = Array.isArray(pg) ? pg : (pg && Array.isArray(pg.points) ? pg.points : []);
      const out = arr.map(finitePoint).filter(Boolean);
      return out.length >= 3 ? out : null;
    };

    // 坐标范围要把**标注和圆**也算进去，否则贴在图形外面的文字会被 viewBox 裁掉
    const hasCoord = pts.some(p => p.x != null && p.y != null)
      || labels.some(l => l.x != null && l.y != null)
      || circles.some(c => c.x != null && c.y != null)
      || polys.some(pg => polyPts(pg) !== null);
    let minX = 0, maxX = 100, minY = 0, maxY = 100;
    if (hasCoord) {
      const xs = [], ys = [];
      pts.forEach(p => { if (p.x != null) xs.push(Number(p.x)); if (p.y != null) ys.push(Number(p.y)); });
      labels.forEach(l => { if (l.x != null) xs.push(Number(l.x)); if (l.y != null) ys.push(Number(l.y)); });
      circles.forEach(c => {
        if (c.x == null) return;
        const r = Number(c.r) || 0;
        xs.push(Number(c.x) - r, Number(c.x) + r);
        ys.push(Number(c.y) - r, Number(c.y) + r);
      });
      polys.forEach(pg => {
        const arr = polyPts(pg);
        if (!arr) return;
        arr.forEach(p => { xs.push(Number(p.x)); ys.push(Number(p.y)); });
      });
      if (xs.length) { minX = Math.min.apply(null, xs); maxX = Math.max.apply(null, xs); }
      if (ys.length) { minY = Math.min.apply(null, ys); maxY = Math.max.apply(null, ys); }
      // 退化情况（所有点在同一条水平/垂直线上）也要留出可见跨度
      if (maxX - minX < 1e-6) { maxX = minX + 1; }
      if (maxY - minY < 1e-6) { maxY = minY + 1; }
    }
    const spanX = (maxX - minX) || 1, spanY = (maxY - minY) || 1;
    const sc = Math.min((W - PAD * 2) / spanX, (H - PAD * 2) / spanY);
    const ox = PAD + ((W - PAD * 2) - spanX * sc) / 2;
    const oy = PAD + ((H - PAD * 2) - spanY * sc) / 2;
    const X = x => ox + (Number(x) - minX) * sc;
    const Y = y => H - (oy + (Number(y) - minY) * sc);

    let s = '';
    // 坐标轴只在明确要求时画：三角形的顶点常常就落在原点上，
    // 默认画轴会让轴线和边重叠，看起来像多了一条莫名其妙的线。
    if (spec2.axes === true && hasCoord) {
      s += '<line x1="' + PAD + '" y1="' + Y(minY) + '" x2="' + (W - PAD) + '" y2="' + Y(minY) + '" stroke="var(--line-2)" stroke-width="1.2" marker-end="url(#hlArrow)"/>';
      s += '<line x1="' + X(minX) + '" y1="' + (H - PAD) + '" x2="' + X(minX) + '" y2="' + PAD + '" stroke="var(--line-2)" stroke-width="1.2" marker-end="url(#hlArrow)"/>';
    }
    circles.forEach(c => {
      const cx = X(c.x == null ? 0 : c.x), cy = Y(c.y == null ? 0 : c.y);
      const r = (Number(c.r) || 10) * sc;
      s += '<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="none" stroke="' + (c.color || 'var(--pri)') + '" stroke-width="1.6"/>';
    });
    polys.forEach((pg, k) => {
      const arr = polyPts(pg);
      if (!arr) return;
      const d = arr.map((p, j) => (j ? 'L' : 'M') + X(p.x) + ' ' + Y(p.y)).join(' ') + ' Z';
      s += '<path d="' + d + '" fill="' + PALETTE[k % PALETTE.length] + '" fill-opacity=".12" stroke="' + PALETTE[k % PALETTE.length] + '" stroke-width="1.6"/>';
    });
    // 线段：支持三种写法
    //   ["A","B"]            按顶点标签连线（最常用，模型也最容易写对）
    //   [x1,y1,x2,y2]        直接给坐标
    //   {from:"A", to:"B"}   对象写法
    // 解析用上面那个共用的 findPt（多边形也走它）。
    segs.forEach(g => {
      let a = null, b = null;
      if (Array.isArray(g)) {
        const numeric = g.length >= 4 && g.slice(0, 4).every(v => typeof v === 'number' || (typeof v === 'string' && v.trim() !== '' && isFinite(Number(v))));
        if (numeric) { a = { x: Number(g[0]), y: Number(g[1]) }; b = { x: Number(g[2]), y: Number(g[3]) }; }
        else { a = findPt(g[0]); b = findPt(g[1]); }
      } else if (g && typeof g === 'object') {
        a = findPt(g.from != null ? g.from : (g.a != null ? g.a : g.start));
        b = findPt(g.to != null ? g.to : (g.b != null ? g.b : g.end));
      }
      // 四个坐标缺一个都别画 —— 少一条线只是少一条线，画 NaN 会刷一屏控制台报错
      if (!a || !b || a.x == null || a.y == null || b.x == null || b.y == null) return;
      if (![a.x, a.y, b.x, b.y].every(v => isFinite(Number(v)))) return;
      s += '<line x1="' + X(a.x) + '" y1="' + Y(a.y) + '" x2="' + X(b.x) + '" y2="' + Y(b.y) + '" stroke="var(--txt)" stroke-width="1.7" stroke-linecap="round"/>';
    });
    pts.forEach((p, k) => {
      // x、y 都要有才算一个画得出的顶点。只判 x 的话 y 缺了会得到 cy="NaN"，
      // 圆点画不出来、还刷控制台报错（真机验证时踩到过）。
      if (p.x == null || p.y == null) return;
      if (!isFinite(Number(p.x)) || !isFinite(Number(p.y))) return;
      const cx = X(p.x), cy = Y(p.y);
      s += '<circle cx="' + cx + '" cy="' + cy + '" r="3.6" fill="' + (p.color || 'var(--pri)') + '"/>';
      const lb = p.label || p.name;
      if (lb) s += svgText(cx + 10, cy - 10, lb, { per: 10, fs: 12, anchor: 'start', weight: 600 });
    });
    labels.forEach(L => {
      if (L.x == null || L.y == null) return;
      if (!isFinite(Number(L.x)) || !isFinite(Number(L.y))) return;
      s += svgText(X(L.x), Y(L.y), L.text || L.label || '', { per: 12, fs: 12, fill: L.color || 'var(--dim)', anchor: L.anchor || 'middle' });
    });
    if (!s) return null;
    return art('geometry', spec2.title, s, W, H);
  }

  // ---- 条形对比 ----
  function bars(spec2) {
    let items = spec2.items || spec2.values || [];
    if (!Array.isArray(items)) items = [];
    items = items.map((it, k) => (typeof it === 'number' || typeof it === 'string')
      ? { label: (spec2.labels || [])[k] || String(k + 1), value: Number(it) || 0 }
      : { label: it.label || it.name || String(k + 1), value: Number(it.value != null ? it.value : it.count) || 0, color: it.color });
    if (!items.length) return null;
    const max = Math.max.apply(null, items.map(i => Math.abs(i.value)).concat([1]));
    const LW = 108, W = 460, BH = 24, GAP = 12, PAD = 14;
    const H = PAD * 2 + items.length * (BH + GAP) - GAP + 22;
    const trackW = W - LW - PAD * 2 - 52;
    let s = '';
    items.forEach((it, k) => {
      const y = PAD + k * (BH + GAP);
      const w = Math.max(3, Math.abs(it.value) / max * trackW);
      const color = it.color || PALETTE[k % PALETTE.length];
      s += svgText(LW - 10, y + BH / 2, it.label, { per: 7, fs: 12, anchor: 'end', fill: 'var(--dim)' });
      s += '<rect x="' + LW + '" y="' + y + '" width="' + trackW + '" height="' + BH + '" rx="6" fill="var(--panel-3)" opacity=".55"/>';
      s += '<rect x="' + LW + '" y="' + y + '" width="' + w + '" height="' + BH + '" rx="6" fill="' + color + '" opacity=".85"/>';
      s += svgText(LW + w + 8, y + BH / 2, String(it.value), { per: 8, fs: 12, anchor: 'start', weight: 650, fill: color });
    });
    return art('bars', spec2.title, s, W, H);
  }

  /**
   * 插画：AI 配图的落点。
   *
   * 为什么不用位图：这个平台的"画"一律是模型出结构化 JSON、前端原生 SVG 渲染
   * （见项目约定）。好处很实在 —— 零外部依赖、任意缩放不糊、可打印、
   * 而且元素是白名单的，模型没法塞进 <script> 这种东西。
   *
   * 白名单是硬约束：type 不在表里的元素直接丢掉，属性也只取认识的几个。
   * 不能因为"模型应该不会乱来"就把它吐的字符串直接拼进 innerHTML。
   */
  const ILLU_EL = {
    rect: ['x', 'y', 'w', 'h', 'fill', 'rx', 'opacity'],
    circle: ['cx', 'cy', 'r', 'fill', 'opacity'],
    ellipse: ['cx', 'cy', 'rx', 'ry', 'fill', 'opacity'],
    line: ['x1', 'y1', 'x2', 'y2', 'stroke', 'width', 'opacity'],
    polygon: ['points', 'fill', 'opacity'],
    path: ['d', 'stroke', 'width', 'fill', 'opacity'],
    text: ['x', 'y', 'text', 'size', 'fill', 'anchor', 'weight'],
  };
  // 只允许这些颜色写法：十六进制、rgb()、以及本项目自己的 CSS 变量
  function safeColor(v, dflt) {
    const s = String(v == null ? '' : v).trim();
    if (/^#[0-9a-fA-F]{3,8}$/.test(s)) return s;
    if (/^rgba?\(\s*[\d.\s,%]+\)$/.test(s)) return s;
    if (/^var\(--[a-z0-9-]+\)$/.test(s)) return s;
    if (/^(none|transparent)$/.test(s)) return s;
    return dflt;
  }
  function safeNum(v, dflt, min, max) {
    const n = Number(v);
    if (!Number.isFinite(n)) return dflt;
    return Math.min(max, Math.max(min, n));
  }

  function illustration(spec2) {
    const els = Array.isArray(spec2.elements) ? spec2.elements : [];
    if (!els.length) return null;
    const W = 800, H = 520;
    let s = '';
    els.slice(0, 80).forEach(e => {
      const t = String(e && e.type || '').toLowerCase();
      const allow = ILLU_EL[t];
      if (!allow) return;
      if (t === 'rect') {
        s += '<rect x="' + safeNum(e.x, 0, -2000, 4000) + '" y="' + safeNum(e.y, 0, -2000, 4000) +
          '" width="' + safeNum(e.w, 100, 0, 4000) + '" height="' + safeNum(e.h, 100, 0, 4000) +
          '" rx="' + safeNum(e.rx, 0, 0, 400) + '" fill="' + safeColor(e.fill, '#EEF2FF') +
          '" opacity="' + safeNum(e.opacity, 1, 0, 1) + '"/>';
      } else if (t === 'circle') {
        s += '<circle cx="' + safeNum(e.cx, 400, -2000, 4000) + '" cy="' + safeNum(e.cy, 260, -2000, 4000) +
          '" r="' + safeNum(e.r, 40, 0, 2000) + '" fill="' + safeColor(e.fill, '#2563EB') +
          '" opacity="' + safeNum(e.opacity, 1, 0, 1) + '"/>';
      } else if (t === 'ellipse') {
        s += '<ellipse cx="' + safeNum(e.cx, 400, -2000, 4000) + '" cy="' + safeNum(e.cy, 260, -2000, 4000) +
          '" rx="' + safeNum(e.rx, 80, 0, 2000) + '" ry="' + safeNum(e.ry, 50, 0, 2000) +
          '" fill="' + safeColor(e.fill, '#7C3AED') + '" opacity="' + safeNum(e.opacity, 1, 0, 1) + '"/>';
      } else if (t === 'line') {
        s += '<line x1="' + safeNum(e.x1, 0, -2000, 4000) + '" y1="' + safeNum(e.y1, 0, -2000, 4000) +
          '" x2="' + safeNum(e.x2, 800, -2000, 4000) + '" y2="' + safeNum(e.y2, 520, -2000, 4000) +
          '" stroke="' + safeColor(e.stroke, '#0F172A') + '" stroke-width="' + safeNum(e.width, 3, 0.5, 40) +
          '" stroke-linecap="round" opacity="' + safeNum(e.opacity, 1, 0, 1) + '"/>';
      } else if (t === 'polygon') {
        const pts = (Array.isArray(e.points) ? e.points : []).slice(0, 40).map(p => {
          const a = Array.isArray(p) ? p : [p && p.x, p && p.y];
          return safeNum(a[0], 0, -2000, 4000) + ',' + safeNum(a[1], 0, -2000, 4000);
        }).join(' ');
        if (!pts) return;
        s += '<polygon points="' + pts + '" fill="' + safeColor(e.fill, '#10B981') +
          '" opacity="' + safeNum(e.opacity, 1, 0, 1) + '"/>';
      } else if (t === 'path') {
        // path 的 d 只允许数字、空格和路径指令字母 —— 挡住任何注入尝试
        const d = String(e.d || '').replace(/[^MmLlHhVvCcSsQqTtAaZz0-9,.\s-]/g, '');
        if (!d) return;
        const fill = safeColor(e.fill, 'none');
        s += '<path d="' + d + '" fill="' + fill + '"' +
          (fill === 'none' ? '' : '') +
          ' stroke="' + safeColor(e.stroke, '#0F172A') + '" stroke-width="' + safeNum(e.width, 3, 0.5, 40) +
          '" stroke-linejoin="round" stroke-linecap="round" opacity="' + safeNum(e.opacity, 1, 0, 1) + '"/>';
      } else if (t === 'text') {
        const fs = safeNum(e.size, 20, 8, 90);
        const anchor = ['start', 'middle', 'end'].indexOf(String(e.anchor)) >= 0 ? String(e.anchor) : 'middle';
        s += '<text x="' + safeNum(e.x, 400, -2000, 4000) + '" y="' + safeNum(e.y, 260, -2000, 4000) +
          '" font-size="' + fs + '" text-anchor="' + anchor + '" dominant-baseline="middle"' +
          ' font-weight="' + safeNum(e.weight, 600, 100, 900) + '"' +
          ' fill="' + safeColor(e.fill, '#0F172A') + '"' +
          ' font-family="inherit">' + esc(String(e.text == null ? '' : e.text).slice(0, 60)) + '</text>';
      }
    });
    if (!s) return null;
    return art('illustration', spec2.title, s, W, H);
  }

  // ---- 计划卡（学习计划 / 阶段安排）----
  /**
   * 和上面那些"画坐标"的不一样：计划卡**不画 SVG**，直接用 HTML 网格排版。
   *
   * 原因很实在 —— 计划卡的内容是"文字条目"，而 SVG 里排文字要自己算换行、
   * 算列宽、算行高，中英混排还会算错；换成 HTML 网格，折行、等高、窄屏自动
   * 变两行全是浏览器自带能力，而且跟随主题变量（浅色/深色都对）。
   *
   * 数据由服务端 sanitizePlan 洗过一遍（字段一定存在、一定是短字符串）。
   * 这里仍然再截一次长度 —— 库里的历史数据、分享页的旧数据不一定过过新规则，
   * 渲染层不能假设上游干净。
   */
  function planCard(spec2) {
    if (!spec2 || typeof spec2 !== 'object') return null;
    const days = (Array.isArray(spec2.days) ? spec2.days : []).filter(d => d && typeof d === 'object');
    if (days.length < 2) return null;                      // 一列不叫计划，别渲染出一张空表
    const cut = (v, n) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n);
    const L = { label: 12, theme: 16, point: 22, focus: 26, tip: 60, title: 34, subtitle: 48 };

    // 「存成图片」：把 spec 序列化挂在按钮上，点击时交给 poster.js 画 1080 宽的海报。
    // 为什么走 dataset 而不是全局存一份：消息是动态插入/重建的（切会话、刷新回填），
    // 挂在元素上就不存在"数据与 DOM 对不上"的窗口。
    const saveSpec = esc(encodeURIComponent(JSON.stringify({
      title: cut(spec2.title, L.title) || '学习计划',
      subtitle: cut(spec2.subtitle, L.subtitle),
      days: days.slice(0, 8).map(d => ({
        label: cut(d.label, L.label), theme: cut(d.theme, L.theme),
        points: (Array.isArray(d.points) ? d.points : []).slice(0, 4).map(p => cut(p, L.point)),
        focus: cut(d.focus, L.focus),
      })),
      tips: (Array.isArray(spec2.tips) ? spec2.tips : []).slice(0, 3).map(t => cut(t, L.tip)),
    })));
    let s = '<div class="art art-plan"><div class="art-h"><b>' + esc(cut(spec2.title, L.title) || '学习计划') +
      '</b><span>计划卡</span>' +
      '<button class="plan-save" type="button" data-spec="' + saveSpec + '">存成图片</button></div>';
    if (spec2.subtitle) s += '<div class="plan-sub">' + esc(cut(spec2.subtitle, L.subtitle)) + '</div>';
    s += '<ol class="plan-grid">';
    days.slice(0, 8).forEach((d, k) => {
      const color = PALETTE[k % PALETTE.length];
      const pts = (Array.isArray(d.points) ? d.points : []).filter(Boolean).slice(0, 4);
      // --c 只喂 PALETTE 里的常量色，不接用户输入，内联 style 是安全的
      s += '<li class="plan-col" style="--c:' + color + '">';
      s += '<div class="plan-day">' + esc(cut(d.label, L.label) || ('第 ' + (k + 1) + ' 组')) + '</div>';
      if (d.theme) s += '<div class="plan-theme">' + esc(cut(d.theme, L.theme)) + '</div>';
      if (pts.length) s += '<ul class="plan-pts">' + pts.map(p => '<li>' + esc(cut(p, L.point)) + '</li>').join('') + '</ul>';
      if (d.focus) s += '<div class="plan-focus">' + esc(cut(d.focus, L.focus)) + '</div>';
      s += '</li>';
    });
    s += '</ol>';
    const tips = (Array.isArray(spec2.tips) ? spec2.tips : []).filter(Boolean).slice(0, 3);
    if (tips.length) {
      s += '<div class="plan-tips"><b>小提醒</b><ol>' +
        tips.map(t => '<li>' + esc(cut(t, L.tip)) + '</li>').join('') + '</ol></div>';
    }
    return s + '</div>';
  }

  function svgFromJSON(obj) {
    if (!obj || typeof obj !== 'object') return null;
    const kind = String(obj.kind || '').toLowerCase();
    try {
      if (kind === 'illustration' || kind === 'picture' || kind === 'draw') return illustration(obj);
      if (kind === 'plancard' || kind === 'plan') return planCard(obj);
      if (kind === 'timeline') return timeline(obj);
      if (kind === 'geometry' || kind === 'shape' || kind === 'figure') return geometry(obj);
      if (kind === 'bars' || kind === 'bar' || kind === 'chart') return bars(obj);
      if (obj.elements && obj.elements.length) return illustration(obj);
      if (Array.isArray(obj.days) && obj.days.length) return planCard(obj);
      if (obj.nodes && obj.nodes.length) return nodeGraph(obj);
      if (obj.items && obj.items.length) return bars(obj);
      return null;
    } catch (e) { return null; }
  }

  // ================= 代码围栏 =================
  let blockSeq = 0;
  function renderFence(lang, body, closed) {
    const l = String(lang || '').toLowerCase();
    if (l === 'svg-json' || l === 'json-svg' || l === 'art') {
      const obj = safeJSON(body);
      const svg = obj ? svgFromJSON(obj) : null;
      if (svg) return svg;
      if (!closed) {
        // 还没闭合 = 模型正在吐 JSON。给一条流动的虚线，说明"在画"，
        // 而不是放一个静态的"加载中"让人怀疑是不是卡死了。
        return '<div class="art art-pending"><div class="art-h"><b>正在生成图示…</b><span class="dotline"></span></div>' +
          '<div class="skel" style="height:52px"></div></div>';
      }
      return '<div class="art"><div class="art-h"><b>图示</b><span class="art-bad">这段结构化数据没能解析成图，下面是原始内容</span></div></div>' + codeBlock('json', body);
    }
    return codeBlock(l || 'text', body);
  }
  function codeBlock(lang, body) {
    const id = 'cb' + (++blockSeq);
    return '<div class="code-wrap"><div class="code-h"><span>' + esc(lang) + '</span><span class="sp"></span>' +
      '<button class="code-copy" data-copy="' + id + '" type="button">复制</button></div>' +
      '<pre><code id="' + id + '">' + highlight(body, lang) + '</code></pre></div>';
  }
  function safeJSON(t) {
    let s = String(t || '').trim();
    try { return JSON.parse(s); } catch (e) {}
    // 流式半截 JSON：补括号再试
    const opens = { '{': '}', '[': ']' };
    const stack = []; let inStr = false, esc2 = false;
    for (const ch of s) {
      if (esc2) { esc2 = false; continue; }
      if (ch === '\\') { esc2 = true; continue; }
      if (ch === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (opens[ch]) stack.push(opens[ch]);
      else if (ch === '}' || ch === ']') stack.pop();
    }
    if (stack.length) { try { return JSON.parse(s + stack.reverse().join('')); } catch (e) {} }
    return null;
  }

  // ================= 行内 =================
  function inline(src) {
    const store = [];
    const keep = html => { store.push(html); return PH + (store.length - 1) + PH; };

    let t = esc(src);

    // 1) 行内代码
    t = t.replace(/`([^`\n]+)`/g, (m, c) => keep('<code class="inl">' + c + '</code>'));
    // 2) 数学 $$...$$ / $...$
    t = t.replace(/\$\$([\s\S]+?)\$\$/g, (m, c) => keep(renderMath(unesc(c), true)));
    t = t.replace(/\$(?!\s)([^$\n]+?)(?<!\s)\$/g, (m, c) => keep(renderMath(unesc(c), false)));
    // 3) 图片 / 链接
    // 不写内联样式：尺寸/圆角/阴影统一交给 app.css 的 `.md img`，
    // 否则内联 style 优先级更高，CSS 里的改动会被静默盖掉。
    t = t.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (m, a, u) => keep('<img src="' + u + '" alt="' + a + '" loading="lazy">'));
    t = t.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, a, u) => keep('<a href="' + u + '" target="_blank" rel="noopener noreferrer">' + a + '</a>'));
    // 4) 强调
    t = t.replace(/\*\*\*([^*]+)\*\*\*/g, '<strong><em>$1</em></strong>');
    t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    t = t.replace(/(^|[\s(（])__([^_]+)__(?=[\s)）.,，。!?！？]|$)/g, '$1<strong>$2</strong>');
    t = t.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
    t = t.replace(/~~([^~]+)~~/g, '<del>$1</del>');

    return t.replace(new RegExp(PH + '(\\d+)' + PH, 'g'), (m, i) => store[Number(i)] || '');
  }
  // 占位符里存的 HTML 是已转义的，数学解析需要原文
  function unesc(s) {
    return String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'").replace(/&amp;/g, '&');
  }

  // ================= 块级 =================
  const RE_HR = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
  const RE_H = /^(#{1,6})\s+(.*)$/;
  const RE_UL = /^(\s*)([-*+])\s+(.*)$/;
  const RE_OL = /^(\s*)(\d+)[.)]\s+(.*)$/;
  const RE_QUOTE = /^\s*>\s?/;

  function renderBlocks(src) {
    const lines = String(src == null ? '' : src).replace(/\r\n?/g, '\n').split('\n');
    let out = '', i = 0;

    while (i < lines.length) {
      const line = lines[i];

      // 围栏
      const fm = /^\s*```([\w+-]*)\s*$/.exec(line);
      if (fm) {
        const lang = fm[1] || '';
        const buf = []; i++;
        let closed = false;
        while (i < lines.length) {
          if (/^\s*```\s*$/.test(lines[i])) { closed = true; i++; break; }
          buf.push(lines[i]); i++;
        }
        out += renderFence(lang, buf.join('\n'), closed);
        continue;
      }
      if (RE_HR.test(line)) { out += '<hr>'; i++; continue; }

      const hm = RE_H.exec(line);
      if (hm) {
        const lv = Math.min(hm[1].length, 4);
        out += '<h' + lv + '>' + inline(hm[2]) + '</h' + lv + '>';
        i++; continue;
      }

      if (RE_QUOTE.test(line)) {
        const buf = [];
        while (i < lines.length && RE_QUOTE.test(lines[i])) { buf.push(lines[i].replace(RE_QUOTE, '')); i++; }
        out += '<blockquote>' + renderBlocks(buf.join('\n')) + '</blockquote>';
        continue;
      }

      // 表格
      if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
        const cells = r => r.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
        const head = cells(line);
        i += 2;
        let body = '';
        while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
          body += '<tr>' + cells(lines[i]).map(c => '<td>' + inline(c) + '</td>').join('') + '</tr>';
          i++;
        }
        out += '<table><thead><tr>' + head.map(c => '<th>' + inline(c) + '</th>').join('') + '</tr></thead><tbody>' + body + '</tbody></table>';
        continue;
      }

      // 列表
      if (RE_UL.test(line) || RE_OL.test(line)) {
        const ordered = RE_OL.test(line);
        let html = '', depth = 0, open = false;
        while (i < lines.length && (RE_UL.test(lines[i]) || RE_OL.test(lines[i]))) {
          const m = RE_OL.exec(lines[i]) || RE_UL.exec(lines[i]);
          const ind = Math.floor((m[1] || '').replace(/\t/g, '  ').length / 2);
          const txt = m[3];
          if (ind > depth) { html += '<ul>'; depth = ind; open = true; }
          else if (ind < depth) { while (depth > ind) { html += '</ul>'; depth--; } }
          html += '<li>' + inline(txt) + '</li>';
          i++;
        }
        while (depth-- > 0) html += '</ul>';
        out += (ordered ? '<ol>' : '<ul>') + html.replace(/^<ul>|<\/ul>$/g, '') + (ordered ? '</ol>' : '</ul>');
        continue;
      }

      if (!line.trim()) { i++; continue; }

      // 段落
      const buf = [];
      while (i < lines.length && lines[i].trim()
        && !/^\s*```/.test(lines[i]) && !RE_H.test(lines[i]) && !RE_QUOTE.test(lines[i])
        && !RE_UL.test(lines[i]) && !RE_OL.test(lines[i]) && !RE_HR.test(lines[i])
        && !/^\s*\|.*\|\s*$/.test(lines[i])) { buf.push(lines[i]); i++; }
      if (buf.length) out += '<p>' + inline(buf.join('\n')).replace(/\n/g, '<br>') + '</p>';
      else i++;
    }
    return out;
  }

  // ================= 图表（原生 SVG）=================
  /**
   * 折线/柱状图。和 svg-json 走同一条通道 —— 学习曲线是"要被看懂的数据"，
   * 不是装饰，所以用 SVG 而不是 canvas，这样能选中、能打印、能读屏。
   *
   * @param {{labels:string[], series:{name:string,values:number[],color?:string}[], type?:'bar'|'line', title?:string, height?:number}} cfg
   */
  function chart(cfg) {
    const c = cfg || {};
    const labels = c.labels || [];
    const series = (c.series || []).filter(s => s && Array.isArray(s.values));
    if (!labels.length || !series.length) return '';
    const type = c.type === 'line' ? 'line' : 'bar';
    const W = 640, H = c.height || (type === 'line' ? 210 : 200);
    const PAD = { l: 42, r: 16, t: 14, b: 32 };
    const iw = W - PAD.l - PAD.r, ih = H - PAD.t - PAD.b;
    const all = series.reduce((a, s) => a.concat(s.values.map(v => Number(v) || 0)), []);
    const rawMax = Math.max.apply(null, all.concat([1]));
    const max = rawMax <= 4 ? 4 : Math.ceil(rawMax / 4) * 4;
    const stepX = iw / labels.length;
    const yOf = v => PAD.t + ih - (Number(v) || 0) / max * ih;

    let s = '';
    // 横向网格 + y 轴刻度
    for (let i = 0; i <= 4; i++) {
      const v = max * i / 4;
      const y = yOf(v);
      s += '<line x1="' + PAD.l + '" y1="' + y + '" x2="' + (W - PAD.r) + '" y2="' + y + '" stroke="var(--line)" stroke-width="1"' + (i ? ' opacity=".7"' : '') + '/>';
      s += '<text x="' + (PAD.l - 8) + '" y="' + (y + 4) + '" text-anchor="end" font-size="10.5" fill="var(--dim2)">' + Math.round(v * 10) / 10 + '</text>';
    }
    // x 轴标签：太密就隔几个显示
    const every = Math.ceil(labels.length / 9);
    labels.forEach((lb, i) => {
      if (i % every !== 0 && i !== labels.length - 1) return;
      const x = PAD.l + stepX * i + stepX / 2;
      const short = String(lb).replace(/^\d{4}-/, '').replace('-', '/');
      s += '<text x="' + x + '" y="' + (H - 10) + '" text-anchor="middle" font-size="10.5" fill="var(--dim2)">' + esc(short) + '</text>';
    });

    if (type === 'bar') {
      const n = series.length;
      const slot = stepX * 0.62 / n;
      series.forEach((se, si) => {
        const color = se.color || PALETTE[si % PALETTE.length];
        se.values.forEach((v, i) => {
          const val = Number(v) || 0;
          const h = Math.max(val > 0 ? 2 : 0, val / max * ih);
          if (!h) return;
          const x = PAD.l + stepX * i + stepX * 0.19 + slot * si;
          const y = PAD.t + ih - h;
          // ch-bar + 错峰 delay：柱子从底部长起来。delay 封顶 240ms，
          // 免得 30 根柱子排到最后要等两秒 —— 那就不叫动效叫卡顿了。
          const delay = Math.min(i * 18 + si * 40, 240);
          s += '<rect class="ch-bar" style="animation-delay:' + delay + 'ms" x="' + x + '" y="' + y + '" width="' + Math.max(2, slot - 2) + '" height="' + h + '" rx="2.5" fill="' + color + '" opacity=".85"><title>' + esc(labels[i] + '：' + val) + '</title></rect>';
        });
      });
    } else {
      series.forEach((se, si) => {
        const color = se.color || PALETTE[si % PALETTE.length];
        const pts = se.values.map((v, i) => (PAD.l + stepX * i + stepX / 2) + ' ' + yOf(v));
        const d = pts.map((p, i) => (i ? 'L' : 'M') + p).join(' ');
        if (si === 0) {
          s += '<path class="ch-area" d="' + d + ' L' + (PAD.l + stepX * (se.values.length - 1) + stepX / 2) + ' ' + (PAD.t + ih) + ' L' + (PAD.l + stepX / 2) + ' ' + (PAD.t + ih) + ' Z" fill="' + color + '" opacity=".1"/>';
        }
        // pathLength="1" 把路径长度归一成 1，CSS 就能用同一套 stroke-dasharray:1 动画
        // 画任意长度的折线，不用在 JS 里等布局完成再调 getTotalLength()（那会闪一下）。
        s += '<path class="ch-line" pathLength="1" style="animation-delay:' + (si * 90) + 'ms" d="' + d + '" fill="none" stroke="' + color + '" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>';
        se.values.forEach((v, i) => {
          const delay = Math.min(320 + i * 14, 700);
          s += '<circle class="ch-dot" style="animation-delay:' + delay + 'ms" cx="' + (PAD.l + stepX * i + stepX / 2) + '" cy="' + yOf(v) + '" r="2.8" fill="' + color + '"><title>' + esc(labels[i] + '：' + v) + '</title></circle>';
        });
      });
    }

    const legend = series.length > 1
      ? '<div class="chart-lg">' + series.map((se, i) => '<span><i style="background:' + (se.color || PALETTE[i % PALETTE.length]) + '"></i>' + esc(se.name || '') + '</span>').join('') + '</div>'
      : '';
    return '<div class="chart">' + (c.title ? '<div class="chart-t">' + esc(c.title) + '</div>' : '') + legend +
      '<svg viewBox="0 0 ' + W + ' ' + H + '" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="' + esc(c.title || '图表') + '" preserveAspectRatio="xMidYMid meet">' + s + '</svg></div>';
  }

  // ================= 导出 =================
  const HL = {
    render: renderBlocks,
    inline: inline,
    esc: esc,
    highlight: highlight,
    math: renderMath,
    svgFromJSON: svgFromJSON,
    planCard: planCard,
    chart: chart,
    artName: k => ART_NAME[k] || k,
    /** 提取文本里的 svg-json 块（给需要"另存为图"的场景用） */
    extractArtifacts(text) {
      const out = [];
      const re = /```(?:svg-json|art)\s*([\s\S]*?)```/g;
      let m;
      while ((m = re.exec(String(text || '')))) { const o = safeJSON(m[1]); if (o) out.push(o); }
      return out;
    },
    /** 纯文本摘要（列表页预览用） */
    plain(text, n) {
      const t = String(text || '')
        .replace(/```[\s\S]*?```/g, ' [图示] ')
        .replace(/[#*`>_~]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
      return t.slice(0, n || 80);
    },
  };

  global.HL = HL;
})(window);

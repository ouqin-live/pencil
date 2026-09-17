// Pencil 网页涂鸦 - content script
// 注入一个全屏 Canvas 覆盖层 + 悬浮工具栏，实现画笔 / 橡皮擦 / 颜色 / 粗细 / 清空 / 撤销重做。
// 涂鸦锚定在绘制处的内容上（内嵌滚动容器内容坐标或页面文档坐标），随内容滚动；
// 样式与页面完全隔离（Shadow DOM）。

(() => {
  if (window.__pencilInjected) return;
  window.__pencilInjected = true;

  /* ------------------------------------------------------------------ *
   * 状态
   * ------------------------------------------------------------------ */
  const state = {
    active: false,
    tool: "pen", // pen | eraser | mouse（鼠标模式：画布让开指针，可正常操作页面）
    color: "#ff9500",
    size: 6,
  };

  const COLORS = [
    "#ff3b30",
    "#ff9500",
    "#ffcc00",
    "#34c759",
    "#007aff",
    "#af52de",
    "#1c1c1e",
    "#ffffff",
  ];

  /* ------------------------------------------------------------------ *
   * 消息监听（必须同步注册，保证注入后立刻可响应 toggle）
   * ------------------------------------------------------------------ */
  try {
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg && msg.type === "pencil-toggle") toggle();
    });
  } catch (e) {
    /* 非扩展环境（如代码静态检查）忽略 */
  }

  /* ------------------------------------------------------------------ *
   * 构建 DOM（Shadow DOM 隔离）
   * ------------------------------------------------------------------ */
  const host = document.createElement("div");
  host.id = "pencil-overlay-host";
  host.style.cssText =
    "all: initial; position: fixed; inset: 0; z-index: 2147483647; pointer-events: none;";
  const shadow = host.attachShadow({ mode: "open" });

  const canvas = document.createElement("canvas");
  canvas.style.cssText =
    "position: fixed; inset: 0; width: 100%; height: 100%; pointer-events: none; cursor: crosshair; touch-action: none;";
  shadow.appendChild(canvas);

  const bar = document.createElement("div");
  bar.className = "bar";
  bar.hidden = true;
  bar.innerHTML = `
    <div class="head">
      <span class="title">Pencil</span>
      <button class="icon close" title="关闭 (Esc)" data-tip="关闭 (Esc)">
        <svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>
      </button>
    </div>

    <div class="row tools">
      <button class="tool active" data-tool="pen" title="画笔">
        <svg viewBox="0 0 24 24"><path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>
      </button>
      <button class="tool" data-tool="eraser" title="橡皮擦">
        <svg viewBox="0 0 24 24"><path d="M16.24 3.56l4.2 4.2a2 2 0 0 1 0 2.83l-8.5 8.5H20v2H6.5l-3.2-3.21a2 2 0 0 1 0-2.83l10.1-10.1a2 2 0 0 1 2.84 0z"/></svg>
      </button>
      <button class="tool" data-tool="mouse" title="鼠标（操作页面）">
        <svg viewBox="0 0 24 24"><path d="M13 1.07V9h7c0-4.08-3.05-7.44-7-7.93zM4 15c0 4.42 3.58 8 8 8s8-3.58 8-8v-4H4v4zm7-13.93C7.05 1.56 4 4.92 4 9v1h7V1.07z"/></svg>
      </button>
    </div>

    <div class="label">颜色</div>
    <div class="row colors"></div>

    <div class="label">粗细 <span class="size-val">6</span></div>
    <input class="size" type="range" min="1" max="40" step="1" value="6" />

    <div class="row actions">
      <button class="icon undo" title="撤销 (Ctrl/Cmd+Z)">
        <svg viewBox="0 0 24 24"><polyline points="9 14 4 9 9 4"/><path d="M20 20v-7a4 4 0 0 0-4-4H4"/></svg>
      </button>
      <button class="icon redo" title="重做 (Ctrl/Cmd+Shift+Z)">
        <svg viewBox="0 0 24 24"><polyline points="15 14 20 9 15 4"/><path d="M4 20v-7a4 4 0 0 1 4-4h12"/></svg>
      </button>
      <button class="icon clear" title="清空画布">
        <svg viewBox="0 0 24 24"><path d="M3 6h18"/><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M10 11v6M14 11v6"/></svg>
      </button>
    </div>

    <div class="hint">Esc 退出 · Alt+P 切换</div>
  `;
  shadow.appendChild(bar);

  const style = document.createElement("style");
  style.textContent = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Segoe UI", sans-serif; }
    .bar {
      position: fixed; top: 16px; right: 16px; width: 168px;
      background: #ffffff; border: 1px solid rgba(0,0,0,.08); border-radius: 14px;
      box-shadow: 0 8px 28px rgba(0,0,0,.18); padding: 10px 12px 12px;
      pointer-events: auto; user-select: none; color: #1c1c1e;
    }
    .head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; cursor: grab; }
    .head:active { cursor: grabbing; }
    .title { font-size: 14px; font-weight: 600; }
    .row { display: flex; gap: 8px; }
    .row.tools .tool {
      flex: 1; height: 40px; display: flex; align-items: center; justify-content: center;
      background: #f2f2f7; border: none; border-radius: 10px; cursor: pointer; color: #3a3a3c;
    }
    .row.tools .tool svg { width: 20px; height: 20px; }
    .row.tools .tool:hover { background: #e5e5ea; }
    .row.tools .tool.active { background: #ff9500; color: #fff; }
    .label { font-size: 12px; color: #6e6e73; margin: 10px 0 6px; }
    .label .size-val { color: #ff9500; font-weight: 600; }
    .colors { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; }
    .swatch {
      width: 26px; height: 26px; border-radius: 50%; cursor: pointer;
      border: 2px solid transparent; box-shadow: inset 0 0 0 1px rgba(0,0,0,.12);
    }
    .swatch.active { border-color: #ff9500; box-shadow: inset 0 0 0 1px rgba(0,0,0,.12), 0 0 0 2px rgba(255,149,0,.35); }
    .swatch.custom {
      display: flex; align-items: center; justify-content: center; overflow: hidden;
      background: conic-gradient(#ff3b30,#ffcc00,#34c759,#007aff,#af52de,#ff3b30);
      position: relative;
    }
    .swatch.custom input { position: absolute; inset: 0; opacity: 0; cursor: pointer; border: none; padding: 0; }
    .size { width: 100%; accent-color: #ff9500; cursor: pointer; }
    .row.actions { margin-top: 12px; justify-content: space-between; }
    .icon {
      width: 36px; height: 36px; display: flex; align-items: center; justify-content: center;
      background: #f2f2f7; border: none; border-radius: 10px; cursor: pointer; color: #3a3a3c;
    }
    .icon:hover { background: #e5e5ea; }
    .icon:disabled { opacity: .35; cursor: default; }
    .icon:disabled:hover { background: #f2f2f7; }
    .icon svg { width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
    .icon.close { width: 28px; height: 28px; background: transparent; }
    .icon.close:hover { background: #f2f2f7; }
    .icon.clear { color: #ff3b30; }
    .hint { margin-top: 10px; font-size: 11px; color: #aeaeb2; text-align: center; }
  `;
  shadow.appendChild(style);

  document.documentElement.appendChild(host);

  /* ------------------------------------------------------------------ *
   * Canvas 初始化（视口大小 + 高分屏）
   * ------------------------------------------------------------------ */
  const ctx = canvas.getContext("2d");
  let dpr = window.devicePixelRatio || 1;

  function fitCanvas() {
    dpr = window.devicePixelRatio || 1;
    const w = window.innerWidth;
    const h = window.innerHeight;
    canvas.width = Math.max(1, Math.floor(w * dpr));
    canvas.height = Math.max(1, Math.floor(h * dpr));
    canvas.style.width = w + "px";
    canvas.style.height = h + "px";
    scheduleRender(); // 笔画以页面坐标重绘，尺寸变化无需搬运位图
  }

  let resizeTimer = null;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(fitCanvas, 150);
  });

  /* ------------------------------------------------------------------ *
   * 笔画模型与历史
   * 每笔记录为锚定坐标系下的点序列（含颜色与粗细）：笔落在内嵌滚动容器
   * 内时锚定到该容器的内容坐标，否则锚定到页面文档坐标。渲染时叠加
   * “容器/窗口当前位置”推出的偏移，因此整页滚动、内嵌容器滚动（以及
   * 容器本身被带动）时，涂鸦都跟随内容移动。
   * 撤销 / 重做基于笔画列表的版本引用，内存开销极小。
   * ------------------------------------------------------------------ */
  let strokes = []; // 已提交的笔画（按渲染顺序）
  const undoStack = []; // 各历史版本的笔画数组（浅拷贝引用）
  const redoStack = [];
  const MAX_UNDO = 300;

  function commit(next) {
    undoStack.push(strokes);
    while (undoStack.length > MAX_UNDO) undoStack.shift();
    redoStack.length = 0;
    strokes = next;
    updateHistoryButtons();
    scheduleRender();
  }
  function undo() {
    if (!undoStack.length) return;
    redoStack.push(strokes);
    strokes = undoStack.pop();
    updateHistoryButtons();
    scheduleRender();
  }
  function redo() {
    if (!redoStack.length) return;
    undoStack.push(strokes);
    strokes = redoStack.pop();
    updateHistoryButtons();
    scheduleRender();
  }
  function updateHistoryButtons() {
    $(".undo").disabled = undoStack.length === 0;
    $(".redo").disabled = redoStack.length === 0;
  }

  /* ------------------------------------------------------------------ *
   * 渲染引擎：把笔画从各自锚定坐标系映射到视口画布
   * ------------------------------------------------------------------ */
  let renderScheduled = false;
  function scheduleRender() {
    if (renderScheduled) return;
    renderScheduled = true;
    requestAnimationFrame(() => {
      renderScheduled = false;
      render();
    });
  }

  // 页面滚动（含内部滚动容器）时重绘，让涂鸦跟随内容移动
  document.addEventListener("scroll", scheduleRender, { capture: true, passive: true });

  /* ------------------------------------------------------------------ *
   * 内嵌容器滚动转发
   * 涂鸦模式下画布覆盖全屏且 pointer-events: auto，滚轮事件的命中目标变成
   * 画布；Chrome 只会滚动画布的最近可滚动祖先（即整页），画布下方的内嵌
   * 滚动容器收不到滚轮，表现为“画笔状态下内部无法滚动”。这里手动把滚轮
   * 派发给指针下方最近的可滚动祖先；找不到时保持默认行为（整页滚动）。
   * ------------------------------------------------------------------ */
  canvas.addEventListener("wheel", forwardWheel, { passive: false });

  function forwardWheel(e) {
    if (!state.active || e.ctrlKey) return; // ctrl+滚轮是页面缩放，保持默认

    // deltaMode：0=像素 1=行 2=页，统一换算成像素
    let dx = e.deltaX;
    let dy = e.deltaY;
    if (e.deltaMode === 1) {
      dx *= 16;
      dy *= 16;
    } else if (e.deltaMode === 2) {
      dx *= window.innerWidth;
      dy *= window.innerHeight;
    }
    if (!dx && !dy) return;

    const scroller = findScrollableAt(e.clientX, e.clientY, dx, dy);
    if (!scroller) return; // 没有内嵌滚动容器：不拦截，交给默认行为滚整页

    scroller.scrollBy(dx, dy);
    e.preventDefault();
  }

  function findScrollableAt(x, y, dx, dy) {
    let node = deepestUnderPoint(x, y);
    while (node && node !== document.body && node !== document.documentElement) {
      if (canScrollBy(node, dx, dy)) return node;
      node = nextAncestor(node);
    }
    return null;
  }

  // 取指针下方最深的真实元素（跳过本扩展的 overlay，钻进开放 Shadow DOM）
  function deepestUnderPoint(x, y) {
    const els = document.elementsFromPoint
      ? document.elementsFromPoint(x, y)
      : [document.elementFromPoint(x, y)];
    let start = els.find((el) => el && el !== host && !shadow.contains(el));
    if (!start) return null;

    // 逐层钻进开放 Shadow DOM，取最深的元素
    for (let i = 0; start.shadowRoot && i < 10; i++) {
      const inner = start.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === start) break;
      start = inner;
    }
    return start;
  }

  function nextAncestor(node) {
    if (node.parentElement) return node.parentElement;
    const root = node.getRootNode();
    return root && root.host ? root.host : null; // 跨出 Shadow DOM 回到宿主
  }

  // 绘制起点下方最近的可滚动容器（不看当前滚动方向，只看内容是否溢出），
  // 用于把笔画锚定到容器内容坐标；找不到则锚定到页面文档坐标
  function findScrollAnchor(x, y) {
    let node = deepestUnderPoint(x, y);
    while (node && node !== document.body && node !== document.documentElement) {
      if (canEverScroll(node)) return node;
      node = nextAncestor(node);
    }
    return null;
  }

  function canEverScroll(el) {
    if (!(el instanceof Element) || el === host || shadow.contains(el)) return false;
    const s = getComputedStyle(el);
    if (
      /(auto|scroll|overlay)/.test(s.overflowY) &&
      el.scrollHeight > el.clientHeight + 1
    ) {
      return true;
    }
    if (
      /(auto|scroll|overlay)/.test(s.overflowX) &&
      el.scrollWidth > el.clientWidth + 1
    ) {
      return true;
    }
    return false;
  }

  function canScrollBy(el, dx, dy) {
    if (!(el instanceof Element)) return false;
    const s = getComputedStyle(el);
    if (
      dy !== 0 &&
      /(auto|scroll|overlay)/.test(s.overflowY) &&
      (dy > 0
        ? el.scrollTop + el.clientHeight < el.scrollHeight - 1
        : el.scrollTop > 0)
    ) {
      return true;
    }
    if (
      dx !== 0 &&
      /(auto|scroll|overlay)/.test(s.overflowX) &&
      (dx > 0
        ? el.scrollLeft + el.clientWidth < el.scrollWidth - 1
        : el.scrollLeft > 0)
    ) {
      return true;
    }
    return false;
  }

  // 笔画的“屏幕偏移”：屏幕坐标 = 笔画坐标 + offset。
  // 锚定容器时由容器当前视口位置与滚动量推出（自然涵盖容器自身滚动、被
  // 外层滚动带动、页面重排等所有移动）；锚定文档时即 window 滚动的反向
  // 量。容器被移除后沿用最后一帧的 offset。
  function strokeOffset(s) {
    if (s.anchor && s.anchor.isConnected) {
      const r = s.anchor.getBoundingClientRect();
      const offset = {
        x: r.left - s.anchor.scrollLeft,
        y: r.top - s.anchor.scrollTop,
      };
      s.lastOffset = offset;
      return offset;
    }
    if (s.anchor) {
      // 容器已被移除：沿用最后一帧的偏移冻结渲染
      return s.lastOffset || { x: -window.scrollX, y: -window.scrollY };
    }
    // 锚定页面文档：偏移始终按当前 window 滚动计算
    return { x: -window.scrollX, y: -window.scrollY };
  }

  // 视口在笔画坐标系中的范围（用于按包围盒剔除视口外的笔画）
  function strokeVisible(s, offset) {
    const b = s.bbox;
    const vx0 = -offset.x;
    const vy0 = -offset.y;
    const vx1 = vx0 + window.innerWidth;
    const vy1 = vy0 + window.innerHeight;
    return !(b.x1 < vx0 || b.x0 > vx1 || b.y1 < vy0 || b.y0 > vy1);
  }

  // 元素是否会裁剪后代内容（overflow 非 visible 即裁剪；结果缓存，页面很少动态改它）
  const clipperCache = new WeakMap();
  function clipsContent(el) {
    let v = clipperCache.get(el);
    if (v === undefined) {
      const cs = getComputedStyle(el);
      v = cs.overflowX !== "visible" || cs.overflowY !== "visible";
      clipperCache.set(el, v);
    }
    return v;
  }

  function intersectRects(a, b) {
    const x = Math.max(a.x, b.x);
    const y = Math.max(a.y, b.y);
    const w = Math.min(a.x + a.w, b.x + b.w) - x;
    const h = Math.min(a.y + a.h, b.y + b.h) - y;
    return w > 0 && h > 0 ? { x, y, w, h } : { x: 0, y: 0, w: 0, h: 0 };
  }

  // 锚定容器当前可见的内容窗口（笔画坐标系）：容器内容滚出这一窗口的
  // 部分会被裁掉。再与所有会裁剪内容的祖先容器可见窗口求交，这样外层
  // 容器把整块内容滚出视野时，内层笔画的显示同步消失。
  // offset 为 strokeOffset 算出的屏幕偏移（与渲染变换保持一致）。
  // 返回 null 表示不裁剪（未锚定容器，或容器已被移除）；w/h 为 0 表示完全不可见。
  function anchorClipRect(s, offset) {
    if (!s.anchor || !s.anchor.isConnected) return null;
    const a = s.anchor;
    let clip = {
      x: a.scrollLeft + a.clientLeft,
      y: a.scrollTop + a.clientTop,
      w: a.clientWidth,
      h: a.clientHeight,
    };
    let node = nextAncestor(a);
    while (node) {
      if (clipsContent(node)) {
        const r = node.getBoundingClientRect();
        clip = intersectRects(clip, {
          x: r.left + node.clientLeft - offset.x,
          y: r.top + node.clientTop - offset.y,
          w: node.clientWidth,
          h: node.clientHeight,
        });
        if (!clip.w || !clip.h) return clip; // 与祖先窗口已无交集，整笔不可见
      }
      node = nextAncestor(node);
    }
    return clip;
  }

  // 在锚定容器的可见窗口内绘制；整笔完全滚出窗口时不画。
  // 调用前需先把变换设置到该笔画的坐标系，offset 为该变换的偏移。
  function withAnchorClip(s, offset, paint) {
    const clip = anchorClipRect(s, offset);
    if (!clip) {
      paint();
      return;
    }
    if (!clip.w || !clip.h) return; // 可见窗口已为空，整笔跳过
    const b = s.bbox;
    if (
      b &&
      (b.x1 < clip.x || b.x0 > clip.x + clip.w || b.y1 < clip.y || b.y0 > clip.y + clip.h)
    ) {
      return; // 包围盒整体在可见窗口之外，整笔跳过
    }
    ctx.save();
    ctx.beginPath();
    ctx.rect(clip.x, clip.y, clip.w, clip.h);
    ctx.clip();
    paint();
    ctx.restore();
  }

  function applyTransform(s) {
    const o = s ? strokeOffset(s) : { x: -window.scrollX, y: -window.scrollY };
    ctx.setTransform(dpr, 0, 0, dpr, o.x * dpr, o.y * dpr);
    return o;
  }

  function renderStroke(s) {
    ctx.globalCompositeOperation =
      s.tool === "eraser" ? "destination-out" : "source-over";
    ctx.strokeStyle = s.color;
    ctx.fillStyle = s.color;
    ctx.lineWidth = s.width;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    const pts = s.points;
    // 起点圆点：点按只留一个圆点，也保证笔迹头部圆润
    ctx.beginPath();
    ctx.arc(pts[0].x, pts[0].y, s.width / 2, 0, Math.PI * 2);
    ctx.fill();
    if (pts.length === 1) return;

    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) {
      const mx = (pts[i - 1].x + pts[i].x) / 2;
      const my = (pts[i - 1].y + pts[i].y) / 2;
      ctx.quadraticCurveTo(pts[i - 1].x, pts[i - 1].y, mx, my);
    }
    const last = pts[pts.length - 1];
    ctx.lineTo(last.x, last.y);
    ctx.stroke();
  }

  function render() {
    // 清空视口
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.globalCompositeOperation = "source-over";

    for (const s of strokes) {
      const offset = strokeOffset(s);
      if (!strokeVisible(s, offset)) continue; // 视口外跳过
      ctx.setTransform(dpr, 0, 0, dpr, offset.x * dpr, offset.y * dpr);
      withAnchorClip(s, offset, () => renderStroke(s));
    }
    if (currentStroke) {
      const offset = strokeOffset(currentStroke);
      ctx.setTransform(dpr, 0, 0, dpr, offset.x * dpr, offset.y * dpr);
      withAnchorClip(currentStroke, offset, () => renderStroke(currentStroke));
    }

    ctx.globalCompositeOperation = "source-over";
  }

  /* ------------------------------------------------------------------ *
   * 绘制逻辑（锚定坐标系）
   * ------------------------------------------------------------------ */
  let drawing = false;
  let currentStroke = null;

  // 指针位置 → 当前笔画的锚定坐标（strokeOffset 的逆变换）
  function toStrokeCoord(e, s) {
    if (s.anchor) {
      const r = s.anchor.getBoundingClientRect();
      return {
        x: e.clientX - r.left + s.anchor.scrollLeft,
        y: e.clientY - r.top + s.anchor.scrollTop,
      };
    }
    return { x: e.clientX + window.scrollX, y: e.clientY + window.scrollY };
  }

  function strokeWidth() {
    return state.tool === "eraser" ? state.size * 3 : state.size;
  }

  function applyStrokeStyle(s) {
    ctx.globalCompositeOperation =
      s.tool === "eraser" ? "destination-out" : "source-over";
    ctx.strokeStyle = s.color;
    ctx.fillStyle = s.color;
    ctx.lineWidth = s.width;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
  }

  // 橡皮擦模式下把光标换成与擦除范围等大的白色方块，便于对准；画笔模式用十字准星；
  // 鼠标模式下画布不接收指针，光标由页面自己决定
  function updateCursor() {
    if (state.tool === "mouse") {
      canvas.style.cursor = "default";
      return;
    }
    if (state.tool !== "eraser") {
      canvas.style.cursor = "crosshair";
      return;
    }
    const w = Math.max(4, Math.min(128, Math.round(strokeWidth())));
    const half = Math.floor(w / 2);
    const svg =
      `<svg xmlns='http://www.w3.org/2000/svg' width='${w}' height='${w}'>` +
      `<rect x='0.5' y='0.5' width='${w - 1}' height='${w - 1}' fill='rgba(255,255,255,0.85)' stroke='#666'/>` +
      `</svg>`;
    canvas.style.cursor = `url("data:image/svg+xml,${encodeURIComponent(svg)}") ${half} ${half}, cell`;
  }

  // 维护笔画包围盒（锚定坐标），用于滚动重绘时剔除视口外的笔画
  function growBBox(s, x, y) {
    const r = s.width / 2 + 2;
    if (!s.bbox) {
      s.bbox = { x0: x - r, y0: y - r, x1: x + r, y1: y + r };
    } else {
      s.bbox.x0 = Math.min(s.bbox.x0, x - r);
      s.bbox.y0 = Math.min(s.bbox.y0, y - r);
      s.bbox.x1 = Math.max(s.bbox.x1, x + r);
      s.bbox.y1 = Math.max(s.bbox.y1, y + r);
    }
  }

  canvas.addEventListener("pointerdown", (e) => {
    if (!state.active || e.button !== 0) return;
    e.preventDefault();
    drawing = true;
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch (err) {}

    currentStroke = {
      tool: state.tool,
      color: state.color,
      width: strokeWidth(),
      points: [],
      bbox: null,
      anchor: findScrollAnchor(e.clientX, e.clientY), // 起点下方最近的可滚动容器
      lastOffset: null,
    };
    const p = toStrokeCoord(e, currentStroke);
    currentStroke.points.push(p);
    growBBox(currentStroke, p.x, p.y);
    // 预置屏幕偏移（client − 笔画坐标），容器若在首帧渲染前被移除也能按此冻结
    currentStroke.lastOffset = { x: e.clientX - p.x, y: e.clientY - p.y };

    const offset = applyTransform(currentStroke);
    applyStrokeStyle(currentStroke);
    // 点按也留下一个圆点
    withAnchorClip(currentStroke, offset, () => {
      ctx.beginPath();
      ctx.arc(p.x, p.y, currentStroke.width / 2, 0, Math.PI * 2);
      ctx.fill();
    });
  });

  canvas.addEventListener("pointermove", (e) => {
    if (!drawing || !currentStroke) return;
    const p = toStrokeCoord(e, currentStroke);
    const pts = currentStroke.points;
    const prev = pts[pts.length - 1];
    pts.push(p);
    growBBox(currentStroke, p.x, p.y);

    const offset = applyTransform(currentStroke);
    applyStrokeStyle(currentStroke);
    // 二次贝塞尔平滑：以相邻两点中点为控制终点
    const mx = (prev.x + p.x) / 2;
    const my = (prev.y + p.y) / 2;
    withAnchorClip(currentStroke, offset, () => {
      ctx.beginPath();
      // 本段起点 = 上一对点的中点（第一段从起点开始画）
      if (pts.length >= 3) {
        const a = pts[pts.length - 3];
        ctx.moveTo((a.x + prev.x) / 2, (a.y + prev.y) / 2);
      } else {
        ctx.moveTo(prev.x, prev.y);
      }
      ctx.quadraticCurveTo(prev.x, prev.y, mx, my);
      ctx.stroke();
    });
  });

  function endStroke(e) {
    if (!drawing) return;
    drawing = false;
    if (currentStroke) {
      const pts = currentStroke.points;
      const offset = applyTransform(currentStroke);
      applyStrokeStyle(currentStroke);
      // 收尾：从最后一段的中点补画到落点
      withAnchorClip(currentStroke, offset, () => {
        if (pts.length < 2) return;
        const prev = pts[pts.length - 2];
        const last = pts[pts.length - 1];
        ctx.beginPath();
        ctx.moveTo((prev.x + last.x) / 2, (prev.y + last.y) / 2);
        ctx.lineTo(last.x, last.y);
        ctx.stroke();
      });
      ctx.globalCompositeOperation = "source-over";
      const finished = currentStroke;
      currentStroke = null;
      commit(strokes.concat(finished));
    }
    try {
      canvas.releasePointerCapture(e.pointerId);
    } catch (err) {}
  }
  canvas.addEventListener("pointerup", endStroke);
  canvas.addEventListener("pointercancel", endStroke);

  /* ------------------------------------------------------------------ *
   * 清空（可撤销）
   * ------------------------------------------------------------------ */
  function clearAll() {
    commit([]);
  }

  /* ------------------------------------------------------------------ *
   * 工具栏交互
   * ------------------------------------------------------------------ */
  function $(sel) {
    return shadow.querySelector(sel);
  }

  // 工具切换
  shadow.querySelectorAll(".tool").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.tool = btn.dataset.tool;
      shadow
        .querySelectorAll(".tool")
        .forEach((b) => b.classList.toggle("active", b === btn));
      syncCanvasPointer();
      updateCursor();
    });
  });

  // 颜色色板
  const colorsRow = $(".colors");
  COLORS.forEach((c) => {
    const sw = document.createElement("div");
    sw.className = "swatch";
    sw.style.background = c;
    sw.title = c;
    sw.addEventListener("click", () => {
      selectColor(c);
      savePrefs();
    });
    colorsRow.appendChild(sw);
  });
  // 自定义颜色
  const custom = document.createElement("div");
  custom.className = "swatch custom";
  custom.title = "自定义颜色";
  const colorInput = document.createElement("input");
  colorInput.type = "color";
  colorInput.value = state.color;
  colorInput.addEventListener("input", () => {
    selectColor(colorInput.value, true);
    savePrefs();
  });
  colorInput.addEventListener("click", (e) => e.stopPropagation());
  custom.appendChild(colorInput);
  colorsRow.appendChild(custom);

  function selectColor(c, fromCustom) {
    state.color = c;
    if (!fromCustom) colorInput.value = c;
    const lower = c.toLowerCase();
    shadow.querySelectorAll(".swatch").forEach((sw) => {
      sw.classList.remove("active");
    });
    const preset = COLORS.find((p) => p.toLowerCase() === lower);
    if (preset && !fromCustom) {
      const idx = COLORS.indexOf(preset);
      shadow.querySelectorAll(".swatch")[idx].classList.add("active");
    } else if (fromCustom) {
      custom.classList.add("active");
    }
  }
  selectColor(state.color);

  // 粗细
  const sizeInput = $(".size");
  const sizeVal = $(".size-val");
  sizeInput.addEventListener("input", () => {
    state.size = Number(sizeInput.value);
    sizeVal.textContent = state.size;
    updateCursor(); // 橡皮擦方块光标随粗细同步变化
    savePrefs();
  });

  // “记住上次设置”：颜色与粗细存入 chrome.storage.local，初始化时恢复；
  // 写入防抖，拖动滑块时合并为一次
  let saveTimer = null;
  function savePrefs() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try {
        chrome.storage.local.set({ color: state.color, size: state.size });
      } catch (e) {}
    }, 300);
  }
  function loadPrefs() {
    try {
      chrome.storage.local.get({ color: state.color, size: state.size }, (v) => {
        if (chrome.runtime.lastError || !v) return;
        if (typeof v.size === "number") {
          state.size = Math.max(1, Math.min(40, Math.round(v.size)));
        }
        if (typeof v.color === "string") {
          state.color = v.color;
          colorInput.value = v.color;
        }
        sizeInput.value = String(state.size);
        sizeVal.textContent = String(state.size);
        const isPreset = COLORS.some(
          (p) => p.toLowerCase() === state.color.toLowerCase()
        );
        selectColor(state.color, !isPreset);
        updateCursor(); // 恢复后同步光标尺寸（橡皮擦方块随粗细）
      });
    } catch (e) {}
  }

  // 撤销 / 重做 / 清空
  $(".undo").addEventListener("click", undo);
  $(".redo").addEventListener("click", redo);
  $(".clear").addEventListener("click", clearAll);

  // 关闭
  $(".close").addEventListener("click", () => setActive(false));

  // 拖拽工具栏（按住标题栏）
  const head = $(".head");
  head.addEventListener("pointerdown", (e) => {
    if (e.target.closest(".close")) return;
    const rect = bar.getBoundingClientRect();
    bar.style.right = "auto";
    bar.style.left = rect.left + "px";
    bar.style.top = rect.top + "px";
    const startX = e.clientX;
    const startY = e.clientY;
    const move = (ev) => {
      const left = Math.min(
        Math.max(0, rect.left + ev.clientX - startX),
        window.innerWidth - rect.width
      );
      const top = Math.min(
        Math.max(0, rect.top + ev.clientY - startY),
        window.innerHeight - 60
      );
      bar.style.left = left + "px";
      bar.style.top = top + "px";
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    e.preventDefault();
  });

  /* ------------------------------------------------------------------ *
   * 键盘快捷键（激活时拦截，避免触发页面自身的快捷键）
   * ------------------------------------------------------------------ */
  window.addEventListener(
    "keydown",
    (e) => {
      if (!state.active) return;
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setActive(false);
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        e.stopPropagation();
        e.shiftKey ? redo() : undo();
      }
    },
    true
  );

  /* ------------------------------------------------------------------ *
   * 激活 / 关闭
   * ------------------------------------------------------------------ */
  // 画布是否接收指针：激活且非鼠标模式时接收（画笔 / 橡皮擦需要绘制）；
  // 鼠标模式下让开指针事件，页面可正常点击、滚动、悬停
  function syncCanvasPointer() {
    canvas.style.pointerEvents =
      state.active && state.tool !== "mouse" ? "auto" : "none";
  }

  function setActive(on) {
    state.active = on;
    bar.hidden = !on;
    syncCanvasPointer();
    if (on) scheduleRender(); // 关闭期间页面可能滚动了，重新对齐涂鸦位置
  }
  function toggle() {
    setActive(!state.active);
  }

  // 初始化画布尺寸与历史按钮态
  fitCanvas();
  updateHistoryButtons();
  updateCursor();

  // 恢复上次使用的颜色与粗细
  loadPrefs();

  console.log("[Pencil] 涂鸦模式就绪：涂鸦锚定页面内容并随滚动移动，Alt+P 或点击扩展图标切换");
})();

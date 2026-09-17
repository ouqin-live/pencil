// Pencil 网页涂鸦 - content script
// 注入一个全屏 Canvas 覆盖层 + 悬浮工具栏，实现画笔 / 橡皮擦 / 颜色 / 粗细 / 清空 / 撤销重做。
// 涂鸦以“页面坐标”存储，随页面内容滚动；样式与页面完全隔离（Shadow DOM）。

(() => {
  if (window.__pencilInjected) return;
  window.__pencilInjected = true;

  /* ------------------------------------------------------------------ *
   * 状态
   * ------------------------------------------------------------------ */
  const state = {
    active: false,
    tool: "pen", // pen | eraser
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
   * 每笔记录为“页面坐标”下的点序列（含颜色与粗细），渲染时叠加当前滚动
   * 偏移，因此滚动页面时涂鸦跟随页面内容移动。
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
   * 渲染引擎：把页面坐标的笔画映射到视口画布
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

  function applyTransform() {
    ctx.setTransform(dpr, 0, 0, dpr, -window.scrollX * dpr, -window.scrollY * dpr);
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

    applyTransform();
    const vx0 = window.scrollX;
    const vy0 = window.scrollY;
    const vx1 = vx0 + window.innerWidth;
    const vy1 = vy0 + window.innerHeight;

    for (const s of strokes) {
      const b = s.bbox;
      if (b.x1 < vx0 || b.x0 > vx1 || b.y1 < vy0 || b.y0 > vy1) continue; // 视口外跳过
      renderStroke(s);
    }
    if (currentStroke) renderStroke(currentStroke);

    ctx.globalCompositeOperation = "source-over";
    // 若正在绘制中，重绘后把增量路径的起点接回原位
    if (drawing && currentStroke) reseedIncrementalPath();
  }

  /* ------------------------------------------------------------------ *
   * 绘制逻辑（页面坐标系）
   * ------------------------------------------------------------------ */
  let drawing = false;
  let currentStroke = null;

  function toWorld(e) {
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

  // 橡皮擦模式下把光标换成与擦除范围等大的白色方块，便于对准；画笔模式用十字准星
  function updateCursor() {
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

  // 维护笔画包围盒（页面坐标），用于滚动重绘时剔除视口外的笔画
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

  // 整屏重绘若发生在笔画中途（例如绘制时滚动页面），
  // 把增量贝塞尔路径的当前位置接回最后一个中点，保证后续笔迹连续
  function reseedIncrementalPath() {
    const pts = currentStroke.points;
    ctx.beginPath();
    if (pts.length <= 1) {
      ctx.moveTo(pts[0].x, pts[0].y);
    } else {
      const a = pts[pts.length - 2];
      const b = pts[pts.length - 1];
      ctx.moveTo((a.x + b.x) / 2, (a.y + b.y) / 2);
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
    };
    const p = toWorld(e);
    currentStroke.points.push(p);
    growBBox(currentStroke, p.x, p.y);

    applyTransform();
    applyStrokeStyle(currentStroke);
    // 点按也留下一个圆点
    ctx.beginPath();
    ctx.arc(p.x, p.y, currentStroke.width / 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
  });

  canvas.addEventListener("pointermove", (e) => {
    if (!drawing || !currentStroke) return;
    const p = toWorld(e);
    const pts = currentStroke.points;
    const prev = pts[pts.length - 1];
    pts.push(p);
    growBBox(currentStroke, p.x, p.y);

    applyTransform();
    applyStrokeStyle(currentStroke);
    // 二次贝塞尔平滑：以相邻两点中点为控制终点
    const mx = (prev.x + p.x) / 2;
    const my = (prev.y + p.y) / 2;
    ctx.quadraticCurveTo(prev.x, prev.y, mx, my);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(mx, my);
  });

  function endStroke(e) {
    if (!drawing) return;
    drawing = false;
    if (currentStroke) {
      const pts = currentStroke.points;
      applyTransform();
      applyStrokeStyle(currentStroke);
      const last = pts[pts.length - 1];
      ctx.lineTo(last.x, last.y);
      ctx.stroke();
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
    sw.addEventListener("click", () => selectColor(c));
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
  });

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
  function setActive(on) {
    state.active = on;
    bar.hidden = !on;
    canvas.style.pointerEvents = on ? "auto" : "none";
    if (on) scheduleRender(); // 关闭期间页面可能滚动了，重新对齐涂鸦位置
  }
  function toggle() {
    setActive(!state.active);
  }

  // 初始化画布尺寸与历史按钮态
  fitCanvas();
  updateHistoryButtons();
  updateCursor();

  console.log("[Pencil] 涂鸦模式就绪：涂鸦锚定页面内容并随滚动移动，Alt+P 或点击扩展图标切换");
})();

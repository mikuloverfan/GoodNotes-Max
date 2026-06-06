"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// main.ts
var main_exports = {};
__export(main_exports, {
  default: () => GoodNoteMaxPlugin
});
module.exports = __toCommonJS(main_exports);
var import_obsidian = require("obsidian");
var CANVAS_CONSTANTS = {
  ERASER_RADIUS: 10,
  SPEED_NORMALIZATION: 3,
  JITTER_THRESHOLD: 5,
  CURVATURE_NORMALIZATION: 10,
  MIN_STROKE_WIDTH: 0.6,
  MAX_STROKE_WIDTH: 3.5
};
var CAMERA_CONSTANTS = {
  MIN_ZOOM: 0.2,
  MAX_ZOOM: 4,
  ZOOM_STEP: 0.08,
  ZOOM_WHEEL_FACTOR: 1e-3
};
var INERTIA_FRICTION = 0.92;
var INERTIA_STOP_THRESHOLD = 0.1;
function createDefaultCamera() {
  return { x: 0, y: 0, zoom: 1 };
}
var InertiaController = class {
  constructor() {
    this.vx = 0;
    this.vy = 0;
    this.active = false;
    this._onDirty = null;
  }
  /** Start inertia with initial velocity. onDirty called each tick + on stop. */
  start(vx, vy, onDirty) {
    this.vx = vx;
    this.vy = vy;
    this.active = true;
    this._onDirty = onDirty;
  }
  /**
   * Advance one frame of physics. Called by unified frame tick.
   * @returns true if still active, false if stopped.
   */
  tick() {
    if (!this.active)
      return false;
    this._onDirty?.();
    this.vx *= INERTIA_FRICTION;
    this.vy *= INERTIA_FRICTION;
    if (Math.abs(this.vx) < INERTIA_STOP_THRESHOLD && Math.abs(this.vy) < INERTIA_STOP_THRESHOLD) {
      this.vx = 0;
      this.vy = 0;
      this.active = false;
      this._onDirty?.();
      return false;
    }
    return true;
  }
  /** Force-stop inertia immediately. */
  stop() {
    this.active = false;
    this.vx = 0;
    this.vy = 0;
    this._onDirty = null;
  }
};
function clampZoom(zoom) {
  return Math.max(CAMERA_CONSTANTS.MIN_ZOOM, Math.min(CAMERA_CONSTANTS.MAX_ZOOM, zoom));
}
function migratePage(raw) {
  return {
    id: raw.id || genId(),
    title: raw.title || "Untitled",
    index: raw.index ?? 0,
    strokes: raw.strokes || raw.content?.strokes || [],
    background: raw.background || { type: "blank", color: "#ffffff" },
    createdAt: raw.createdAt || (/* @__PURE__ */ new Date()).toISOString(),
    updatedAt: raw.updatedAt || (/* @__PURE__ */ new Date()).toISOString(),
    thumbnail: raw.thumbnail
  };
}
var CursorRenderer = class {
  constructor(session, ownerDocument) {
    this._unsub = null;
    this._mounted = false;
    this._session = null;
    this._session = session;
    this._doc = ownerDocument ?? document;
  }
  /** Bind or rebind session. Safe to call multiple times. */
  bindSession(session) {
    if (this._unsub) {
      this._unsub();
      this._unsub = null;
    }
    this._session = session;
    if (this._mounted) {
      this._subscribeViewState();
      session.syncViewState();
    }
  }
  /** Mount the cursor overlay into document.body. Safe to call before session exists. */
  mount() {
    if (this._mounted)
      return;
    this._mounted = true;
    const existing = this._doc.querySelector(".goodnote-cursor-overlay");
    if (existing)
      existing.remove();
    this.el = this._doc.body.createEl("div", { cls: "goodnote-cursor-overlay" });
    if (this._session) {
      this._subscribeViewState();
    }
    this._onGlobalPointerMove = (ev) => {
      if (!this.el || !this._doc.body.contains(this.el)) {
        this.el = this._doc.body.createEl("div", { cls: "goodnote-cursor-overlay" });
      }
      this.el.style.setProperty("--cursor-x", ev.clientX + "px");
      this.el.style.setProperty("--cursor-y", ev.clientY + "px");
      this.el.classList.remove("cursor-hidden");
      if (this._session) {
        const vs = this._session.viewState.cursor;
        vs.x = ev.clientX;
        vs.y = ev.clientY;
        vs.visible = true;
      }
    };
    window.addEventListener("pointermove", this._onGlobalPointerMove);
    this._onGlobalPointerLeave = () => {
      if (this.el)
        this.el.classList.add("cursor-hidden");
      if (this._session) {
        this._session.viewState.cursor.visible = false;
      }
    };
    this._doc.addEventListener("pointerleave", this._onGlobalPointerLeave);
  }
  /** Subscribe to session viewState for tool-driven appearance. */
  _subscribeViewState() {
    const session = this._session;
    if (!session)
      return;
    this._unsub = session.subscribeViewUI((vs) => {
      if (!this.el || !this._doc.body.contains(this.el))
        return;
      this.el.classList.remove("cursor-pen", "cursor-eraser", "cursor-hand", "cursor-hand-grabbing");
      this.el.style.removeProperty("--cursor-size");
      this.el.textContent = "";
      const cs = vs.cursor;
      const sizePx = Math.round(cs.size);
      switch (cs.mode) {
        case "pen":
          this.el.classList.add("cursor-pen");
          this.el.style.setProperty("--cursor-size", sizePx + "px");
          break;
        case "eraser":
          this.el.classList.add("cursor-eraser");
          this.el.style.setProperty("--cursor-size", sizePx + "px");
          break;
        case "hand":
          this.el.classList.add("cursor-hand");
          this.el.textContent = "\u270B";
          break;
      }
      if (cs.visible) {
        this.el.classList.remove("cursor-hidden");
      } else {
        this.el.classList.add("cursor-hidden");
      }
    });
    session.syncViewState();
  }
  /** Remove cursor overlay and all listeners. Idempotent. */
  destroy() {
    this._mounted = false;
    if (this._unsub) {
      this._unsub();
      this._unsub = null;
    }
    if (this._onGlobalPointerMove)
      window.removeEventListener("pointermove", this._onGlobalPointerMove);
    if (this._onGlobalPointerLeave)
      this._doc.removeEventListener("pointerleave", this._onGlobalPointerLeave);
    if (this.el && this._doc.body.contains(this.el))
      this.el.remove();
    this._session = null;
  }
};
var InputSnapshotController = class {
  /**
   * Capture a frozen InputSnapshot from a PointerEvent.
   * All state (camera, tool, coords) is copied — never references live objects.
   */
  capture(ev, session) {
    const rect = session.canvasEl.getBoundingClientRect();
    const sx = ev.clientX - rect.left;
    const sy = ev.clientY - rect.top;
    const c = session.viewport.camera;
    const worldX = (sx - c.x) / c.zoom;
    const worldY = (sy - c.y) / c.zoom;
    let pType;
    switch (ev.type) {
      case "pointerdown":
        pType = "down";
        break;
      case "pointermove":
        pType = "move";
        break;
      case "pointerup":
        pType = "up";
        break;
      default:
        pType = "move";
        break;
    }
    const activeTool = session.toolManager.getActive();
    const settingsCopy = JSON.parse(JSON.stringify(activeTool.settings));
    return {
      pointer: {
        screenX: sx,
        screenY: sy,
        worldX,
        worldY,
        pressure: ev.pressure || 0.5,
        pointerId: ev.pointerId,
        type: pType
      },
      camera: { x: c.x, y: c.y, zoom: c.zoom },
      tool: { id: activeTool.id, settings: settingsCopy },
      timestamp: performance.now()
    };
  }
  /** Extract world point from a snapshot (convenience). */
  getWorldPoint(snapshot) {
    return { x: snapshot.pointer.worldX, y: snapshot.pointer.worldY };
  }
};
var PenTool = class {
  constructor() {
    this.id = "pen";
    this.settings = CanvasPolicy.getDefaults();
  }
  onPointerDown(snapshot, session) {
    const pt = { x: snapshot.pointer.worldX, y: snapshot.pointer.worldY };
    session.engine.startStroke(pt, snapshot.pointer.pointerId, (id) => session.canvasEl.setPointerCapture(id));
  }
  onPointerMove(snapshot, session) {
    if (!session.engine.drawing)
      return;
    const pt = { x: snapshot.pointer.worldX, y: snapshot.pointer.worldY };
    session.engine.addPoint(pt);
    const strokeId = session.engine.currentStrokeId;
    const prev = session.engine.lastPoint;
    if (strokeId && prev && pt) {
      const bounds = computeStrokeBounds([prev, pt]);
      session.markDirty(strokeId, bounds);
    } else {
      session.markDirty();
    }
  }
  onPointerUp(_snapshot, session) {
    if (!session.engine.drawing)
      return;
    const strokeId = session.engine.currentStrokeId;
    session.engine.endStroke();
    if (strokeId) {
      session.markDirty(strokeId);
    } else {
      session.markDirty();
    }
  }
};
var EraserTool = class {
  constructor() {
    this.id = "eraser";
    this.settings = { mode: "point", size: 50, strength: 50 };
    this.isErasing = false;
    this.lastErasePt = null;
  }
  resolveRadius() {
    return 5 + this.settings.size / 100 * 35;
  }
  onPointerDown(snapshot, session) {
    const pt = { x: snapshot.pointer.worldX, y: snapshot.pointer.worldY };
    this.isErasing = true;
    this.lastErasePt = pt;
    this.executeErase(pt, session);
  }
  onPointerMove(snapshot, session) {
    if (!this.isErasing)
      return;
    const pt = { x: snapshot.pointer.worldX, y: snapshot.pointer.worldY };
    const minDist = this.resolveRadius() * 0.5;
    if (this.lastErasePt && Math.hypot(pt.x - this.lastErasePt.x, pt.y - this.lastErasePt.y) < minDist) {
      return;
    }
    this.lastErasePt = pt;
    this.executeErase(pt, session);
  }
  onPointerUp(_snapshot, session) {
    if (!this.isErasing)
      return;
    this.isErasing = false;
    this.lastErasePt = null;
    session.engine.commit();
    session.requestFullRebuild();
    session.markDirty();
  }
  /** Execute erase AND trigger immediate re-render for real-time feedback */
  executeErase(pt, session) {
    const engine = session.engine;
    const radius = this.resolveRadius();
    switch (this.settings.mode) {
      case "stroke":
        this.eraseStroke(pt, engine, radius);
        break;
      case "point":
        this.erasePoints(pt, engine, radius);
        break;
      case "smart":
        this.eraseSmart(pt, engine, radius);
        break;
    }
    session.requestFullRebuild();
    session.markDirty();
  }
  /** Stroke Eraser: delete entire stroke if any point within radius */
  eraseStroke(pt, engine, radius) {
    for (let i = engine.strokes.length - 1; i >= 0; i--) {
      const s = engine.strokes[i];
      if (!s?.points)
        continue;
      if (engine.hitTestStroke(s, pt, radius)) {
        engine.removeStroke(s.id);
        return;
      }
    }
  }
  /** Point Eraser: remove individual points within radius, split stroke if needed */
  erasePoints(pt, engine, radius) {
    const toRemove = [];
    for (let si = engine.strokes.length - 1; si >= 0; si--) {
      const s = engine.strokes[si];
      if (!s?.points)
        continue;
      const indices = [];
      for (let pi = 0; pi < s.points.length; pi++) {
        const p = s.points[pi];
        if (Math.hypot(p.x - pt.x, p.y - pt.y) < radius) {
          indices.push(pi);
        }
      }
      if (indices.length > 0) {
        toRemove.push({ strokeIdx: si, pointIndices: indices });
      }
    }
    for (const item of toRemove) {
      engine.erasePointsFromStroke(item.strokeIdx, item.pointIndices);
    }
  }
  /** Smart Eraser: distance-based segment detection + auto split */
  eraseSmart(pt, engine, radius) {
    const aggressiveness = this.settings.strength / 100;
    const smartRadius = radius * (0.5 + aggressiveness * 1.5);
    for (let si = engine.strokes.length - 1; si >= 0; si--) {
      const s = engine.strokes[si];
      if (!s?.points || s.points.length < 2)
        continue;
      const hitPoints = s.points.map((p) => Math.hypot(p.x - pt.x, p.y - pt.y) < smartRadius);
      const toRemove = [];
      for (let pi = 0; pi < hitPoints.length; pi++) {
        if (hitPoints[pi])
          toRemove.push(pi);
      }
      if (toRemove.length > 0) {
        engine.erasePointsFromStroke(si, toRemove);
        return;
      }
    }
  }
};
var HandTool = class {
  constructor() {
    this.id = "hand";
    this.settings = CanvasPolicy.getDefaults();
    // unused
    this.lastScreenX = 0;
    this.lastScreenY = 0;
  }
  onPointerDown(snapshot, session) {
    session.viewport.inertia.stop();
    session.viewport.isPanning = true;
    session.viewport.inertia.vx = 0;
    session.viewport.inertia.vy = 0;
    this.lastScreenX = snapshot.pointer.screenX;
    this.lastScreenY = snapshot.pointer.screenY;
    session.canvasEl.setPointerCapture(snapshot.pointer.pointerId);
  }
  onPointerMove(snapshot, session) {
    if (!session.viewport.isPanning)
      return;
    const dx = snapshot.pointer.screenX - this.lastScreenX;
    const dy = snapshot.pointer.screenY - this.lastScreenY;
    this.lastScreenX = snapshot.pointer.screenX;
    this.lastScreenY = snapshot.pointer.screenY;
    session.viewport.pan(dx, dy);
    session.viewport.inertia.vx = dx;
    session.viewport.inertia.vy = dy;
    session.syncViewState();
    session.markCameraDirty();
  }
  onPointerUp(_snapshot, session) {
    session.viewport.isPanning = false;
    session.viewport.inertia.start(
      session.viewport.inertia.vx,
      session.viewport.inertia.vy,
      () => {
        session.viewport.camera.x += session.viewport.inertia.vx;
        session.viewport.camera.y += session.viewport.inertia.vy;
        session.syncViewState();
        session.markCameraDirty();
      }
    );
  }
};
function migrateNotebook(raw) {
  const now = (/* @__PURE__ */ new Date()).toISOString();
  return {
    id: raw.id || genId(),
    name: raw.name || "Untitled",
    pages: (raw.pages || []).map((p) => migratePage(p)),
    activePageId: raw.activePageId ?? (raw.pages?.[0]?.id ?? null),
    nextPageIndex: raw.nextPageIndex ?? (raw.pages?.length ?? 0),
    createdAt: raw.createdAt || now,
    updatedAt: raw.updatedAt || now,
    lastPageId: raw.lastPageId,
    isPinned: raw.isPinned
  };
}
var NOTEBOOK_VIEW_TYPE = "goodnote-max-notebook-view";
var PAGE_VIEW_TYPE = "goodnote-max-page-view";
var CANVAS_VIEW_TYPE = "goodnote-max-canvas-view";
var _idCounter = Date.now();
function genId() {
  return `${++_idCounter}`;
}
var FileGateway = class _FileGateway {
  constructor(app) {
    this.app = app;
  }
  static {
    this.DIR = "GoodNoteMax";
  }
  /** Normalize: strip double-prefix, backslash→slash, ensure single GoodNoteMax/ prefix. */
  normalizePath(raw) {
    let p = raw.replace(/\\/g, "/");
    while (p.startsWith(`${_FileGateway.DIR}/${_FileGateway.DIR}/`)) {
      p = p.substring(_FileGateway.DIR.length + 1);
    }
    if (!p.startsWith(`${_FileGateway.DIR}/`)) {
      p = `${_FileGateway.DIR}/${p.replace(/^\/+/, "")}`;
    }
    return p;
  }
  /** Build a guaranteed-correct path from a bare filename. */
  buildPath(filename) {
    const bare = filename.replace(/\\/g, "/").split("/").pop() || filename;
    return this.normalizePath(`${_FileGateway.DIR}/${bare}`);
  }
  async saveNotebook(notebook) {
    const adapter = this.app.vault.adapter;
    if (!await adapter.exists(_FileGateway.DIR))
      await this.app.vault.createFolder(_FileGateway.DIR);
    const path = this.buildPath(`${notebook.name}.gnnote`);
    await adapter.write(path, JSON.stringify(notebook));
  }
  async loadNotebooks() {
    const adapter = this.app.vault.adapter;
    const dir = _FileGateway.DIR;
    try {
      if (!await adapter.exists(dir)) {
        await this.app.vault.createFolder(dir);
        console.log("[BOOT] GoodNoteMax folder created, no notebooks");
        return [];
      }
    } catch (e) {
      console.warn("[BOOT] adapter.exists failed:", e);
      try {
        await this.app.vault.createFolder(dir);
      } catch (_) {
      }
      return [];
    }
    let list;
    try {
      list = await adapter.list(dir);
    } catch (e) {
      console.warn("[BOOT] adapter.list failed:", e);
      return [];
    }
    const gnFiles = list.files.filter((f) => f.endsWith(".gnnote") || f.endsWith(".gnote"));
    console.log("[BOOT] gnnote files found:", gnFiles.length);
    const result = [];
    for (const rawName of gnFiles) {
      const filePath = this.buildPath(rawName);
      try {
        const raw = await adapter.read(filePath);
        const raw_nb = JSON.parse(raw);
        const nb = migrateNotebook(raw_nb);
        if (!nb.id)
          nb.id = genId();
        if (!nb.pages)
          nb.pages = [];
        result.push(nb);
        const correctPath = this.buildPath(`${nb.name}.gnnote`);
        if (filePath !== correctPath) {
          try {
            await adapter.write(correctPath, JSON.stringify(nb));
            if (filePath !== correctPath)
              await adapter.remove(filePath);
            console.log("[BOOT] migrated:", filePath, "\u2192", correctPath);
          } catch (migErr) {
            console.warn("[BOOT] migration failed:", filePath, migErr);
          }
        }
        console.log("[BOOT] parsed:", nb.name, "| pages:", nb.pages.length);
      } catch (e) {
        console.warn("[BOOT] skip invalid:", filePath, e);
      }
    }
    console.log("[BOOT] notebooks hydrated:", result.length);
    return result;
  }
  async deleteNotebook(notebook) {
    const p = this.buildPath(`${notebook.name}.gnnote`);
    try {
      if (await this.app.vault.adapter.exists(p))
        await this.app.vault.adapter.remove(p);
    } catch (e) {
      console.warn("[FileGateway] delete failed:", p, e);
    }
  }
  async notebookFileExists(notebook) {
    try {
      return await this.app.vault.adapter.exists(this.buildPath(`${notebook.name}.gnnote`));
    } catch {
      return false;
    }
  }
};
var NotebookModal = class extends import_obsidian.Modal {
  constructor(app, plugin) {
    super(app);
    this.plugin = plugin;
  }
  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Create Notebook" });
    let name = "";
    new import_obsidian.Setting(contentEl).setName("Notebook name").addText((t) => t.setPlaceholder("Enter notebook name").onChange((v) => {
      name = v;
    }));
    new import_obsidian.Setting(contentEl).addButton((b) => b.setButtonText("Create").setCta().onClick(async () => {
      try {
        const now = (/* @__PURE__ */ new Date()).toISOString();
        await this.plugin.addNotebook({
          id: genId(),
          name: name || "Untitled",
          pages: [{
            id: "page-1",
            title: "Page 1",
            index: 0,
            strokes: [],
            background: { type: "blank", color: "#ffffff" },
            createdAt: now,
            updatedAt: now
          }],
          activePageId: "page-1",
          nextPageIndex: 1,
          createdAt: now,
          updatedAt: now
        });
      } catch (e) {
        console.error(e);
      } finally {
        this.close();
      }
    })).addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()));
  }
  onClose() {
    this.contentEl.empty();
  }
};
var NotebookRenameModal = class extends import_obsidian.Modal {
  constructor(app, p, nbId, cur) {
    super(app);
    this.plugin = p;
    this.nbId = nbId;
    this.cur = cur;
  }
  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Rename Notebook" });
    let v = this.cur;
    new import_obsidian.Setting(contentEl).setName("Notebook name").addText((t) => t.setValue(this.cur).onChange((x) => v = x));
    new import_obsidian.Setting(contentEl).addButton((b) => b.setButtonText("Rename").setCta().onClick(() => {
      try {
        this.plugin.renameNotebook(this.nbId, v || this.cur);
      } catch (e) {
        console.error(e);
      } finally {
        this.close();
      }
    })).addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()));
  }
  onClose() {
    this.contentEl.empty();
  }
};
var RenameModal = class extends import_obsidian.Modal {
  constructor(app, p, nbId, pId, cur) {
    super(app);
    this.plugin = p;
    this.nbId = nbId;
    this.pId = pId;
    this.cur = cur;
  }
  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Rename Page" });
    let v = this.cur;
    new import_obsidian.Setting(contentEl).setName("Page title").addText((t) => t.setValue(this.cur).onChange((x) => v = x));
    new import_obsidian.Setting(contentEl).addButton((b) => b.setButtonText("Rename").setCta().onClick(async () => {
      try {
        await this.plugin.renamePage(this.nbId, this.pId, v || this.cur);
      } catch (e) {
        console.error(e);
      } finally {
        this.close();
      }
    })).addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()));
  }
  onClose() {
    this.contentEl.empty();
  }
};
var NotebookView = class extends import_obsidian.ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
  }
  getViewType() {
    return NOTEBOOK_VIEW_TYPE;
  }
  getDisplayText() {
    return "Notebooks";
  }
  getIcon() {
    return "pen-tool";
  }
  async onOpen() {
    const c = this.containerEl;
    c.empty();
    c.addClass("goodnote-max-view");
    const h = c.createEl("div", { cls: "goodnote-header" });
    h.createEl("h4", { text: "Notebooks" });
    h.createEl("button", { text: "+ Create" }).onclick = () => new NotebookModal(this.plugin.app, this.plugin).open();
    this.listEl = c.createEl("ul");
    this.plugin.on("notebooks-changed", () => this.render());
    this.plugin.on("selection-changed", () => this.render());
    this.render();
  }
  render() {
    const nbs = this.plugin.getSortedNotebooks();
    const sid = this.plugin.getSelectedNotebook()?.id ?? null;
    this.listEl.empty();
    nbs.forEach((nb) => {
      const li = this.listEl.createEl("li");
      if (nb.id === sid)
        li.addClass("is-selected");
      li.createSpan({ text: `${nb.isPinned ? "\u{1F4CC}" : "\u{1F4D2}"} ${nb.name}` });
      li.createEl("button", { text: "\u{1F5D1}" }).onclick = () => this.plugin.deleteNotebook(nb.id);
      li.addEventListener("contextmenu", (ev) => {
        ev.preventDefault();
        new import_obsidian.Menu().addItem((i) => i.setTitle(nb.isPinned ? "Unpin" : "Pin").setIcon("pin").onClick(() => this.plugin.togglePinNotebook(nb.id))).addItem((i) => i.setTitle("Rename").setIcon("pencil").onClick(() => new NotebookRenameModal(this.plugin.app, this.plugin, nb.id, nb.name).open())).addItem((i) => i.setTitle("Delete").setIcon("trash").onClick(() => this.plugin.deleteNotebook(nb.id))).showAtMouseEvent(ev);
      });
      li.onclick = () => {
        new import_obsidian.Notice(`\u{1F4D2} ${nb.name}`);
        this.plugin.ui.selectNotebook(nb.id);
      };
    });
  }
};
var PageView = class extends import_obsidian.ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.dropdownOpen = false;
    /** UI-only state — 不影响数据层，不传给 PageManager */
    this.mode = "list";
    this.plugin = plugin;
  }
  getViewType() {
    return PAGE_VIEW_TYPE;
  }
  getDisplayText() {
    return "Pages";
  }
  getIcon() {
    return "files";
  }
  async onOpen() {
    const c = this.containerEl;
    c.empty();
    c.addClass("goodnote-page-view");
    this.headerEl = c.createEl("div", { cls: "gn-page-header" });
    this.buildHeader();
    this.listEl = c.createEl("div", { cls: "gn-page-list" });
    this.footerEl = c.createEl("div", { cls: "gn-page-footer" });
    this.buildFooter();
    this.plugin.on("selection-changed", () => this.render());
    this.plugin.on("notebooks-changed", () => this.render());
    this.render();
  }
  // ==========================================================
  //  Header
  // ==========================================================
  buildHeader() {
    this.headerEl.empty();
    const nb = this.plugin.getSelectedNotebook();
    const titleText = nb?.name ?? "No Notebook";
    const topRow = this.headerEl.createEl("div", { cls: "gn-page-header-top" });
    const titleBtn = topRow.createEl("button", { cls: "gn-page-header-title" });
    titleBtn.createSpan({ text: `\u{1F4D2} ${titleText}` });
    titleBtn.createSpan({ cls: "gn-page-header-chevron", text: "\u25BE" });
    titleBtn.onclick = (ev) => {
      ev.stopPropagation();
      this.toggleDropdown();
    };
    if (nb) {
      topRow.createEl("span", { cls: "gn-page-count-badge", text: `${nb.pages.length}` });
    }
    this.modeBarEl = this.headerEl.createEl("div", { cls: "gn-page-mode-bar" });
    this.buildModeBar();
    this.renderDropdown();
  }
  /** Build mode toggle buttons — UI-only, no data impact */
  buildModeBar() {
    this.modeBarEl.empty();
    const modes = [
      { key: "list", icon: "\u2630", label: "List" },
      { key: "thumbnail", icon: "\u25A6", label: "Thumbnail" }
    ];
    for (const m of modes) {
      const btn = this.modeBarEl.createEl("button", {
        cls: `gn-page-mode-btn${this.mode === m.key ? " is-active" : ""}`,
        attr: { title: m.label }
      });
      btn.createSpan({ text: m.icon });
      btn.onclick = () => this.setMode(m.key);
    }
  }
  setMode(mode) {
    if (this.mode === mode)
      return;
    this.mode = mode;
    this.buildModeBar();
    this.render();
  }
  toggleDropdown() {
    this.dropdownOpen = !this.dropdownOpen;
    this.renderDropdown();
  }
  renderDropdown() {
    const old = this.headerEl.querySelector(".gn-page-dropdown");
    if (old)
      old.remove();
    if (!this.dropdownOpen)
      return;
    const nb = this.plugin.getSelectedNotebook();
    if (!nb)
      return;
    const menu = this.headerEl.createEl("div", { cls: "gn-page-dropdown" });
    const items = [
      {
        label: "New Page",
        icon: "\uFF0B",
        action: () => this.handleNewPage()
      },
      {
        label: "Rename Notebook",
        icon: "\u270E",
        action: () => {
          new NotebookRenameModal(this.plugin.app, this.plugin, nb.id, nb.name).open();
          this.dropdownOpen = false;
          this.renderDropdown();
        }
      }
    ];
    for (const item of items) {
      const row = menu.createEl("div", { cls: "gn-page-dropdown-item" });
      row.createSpan({ cls: "gn-page-dropdown-icon", text: item.icon });
      row.createSpan({ text: item.label });
      row.onclick = () => {
        this.dropdownOpen = false;
        item.action();
      };
    }
  }
  // ==========================================================
  //  Footer
  // ==========================================================
  buildFooter() {
    this.footerEl.empty();
    const btn = this.footerEl.createEl("button", { cls: "gn-page-new-btn" });
    btn.createSpan({ text: "\uFF0B  New Page" });
    btn.onclick = () => this.handleNewPage();
  }
  // ==========================================================
  //  Page List — 模式分发
  //  同数据，两种投影：list（信息密度） / thumbnail（视觉优先）
  // ==========================================================
  render() {
    this.buildHeader();
    this.listEl.empty();
    const nb = this.plugin.getSelectedNotebook();
    if (!nb) {
      this.listEl.createEl("div", { cls: "gn-page-placeholder", text: "Select a notebook to view pages" });
      return;
    }
    if (nb.pages.length === 0) {
      this.listEl.createEl("div", { cls: "gn-page-placeholder", text: "No pages yet. Create one!" });
      return;
    }
    switch (this.mode) {
      case "list":
        this.renderList(nb);
        break;
      case "thumbnail":
        this.renderThumbnail(nb);
        break;
    }
  }
  // ── List mode: compact rows, info-dense ──
  renderList(nb) {
    const activeId = nb.activePageId;
    for (const page of nb.pages) {
      const card = this.listEl.createEl("div", {
        cls: `gn-page-card${page.id === activeId ? " is-active" : ""}`
      });
      const thumb = card.createEl("div", { cls: "gn-page-thumb" });
      if (page.thumbnail) {
        const img = thumb.createEl("img", { cls: "gn-page-thumb-img" });
        img.src = page.thumbnail;
      } else {
        thumb.createSpan({ cls: "gn-page-thumb-placeholder", text: "\u{1F4DD}" });
        if (page.strokes && page.strokes.length > 0) {
          thumb.createEl("span", { cls: "gn-page-stroke-hint", text: `${page.strokes.length}` });
        }
      }
      const info = card.createEl("div", { cls: "gn-page-info" });
      info.createSpan({ cls: "gn-page-title", text: page.title });
      info.createSpan({ cls: "gn-page-meta", text: this.formatDate(page.updatedAt) });
      card.onclick = () => this.handlePageClick(nb.id, page.id);
      card.addEventListener("contextmenu", (ev) => {
        ev.preventDefault();
        new import_obsidian.Menu().addItem((it) => it.setTitle("Rename").setIcon("pencil").onClick(() => new RenameModal(this.plugin.app, this.plugin, nb.id, page.id, page.title).open())).addItem((it) => it.setTitle("Delete").setIcon("trash").onClick(() => this.handleDeletePage(nb.id, page.id))).showAtMouseEvent(ev);
      });
    }
  }
  // ── Thumbnail mode: grid cards, visual-first ──
  renderThumbnail(nb) {
    const activeId = nb.activePageId;
    this.listEl.addClass("gn-page-list-thumb");
    for (const page of nb.pages) {
      const isActive = page.id === activeId;
      const card = this.listEl.createEl("div", {
        cls: `gn-page-thumb-card${isActive ? " is-active" : ""}`
      });
      const preview = card.createEl("div", { cls: "gn-page-thumb-preview" });
      preview.createEl("span", {
        cls: "gn-thumb-badge",
        text: `Page ${page.index + 1}`
      });
      if (page.thumbnail) {
        const img = preview.createEl("img", { cls: "gn-page-thumb-preview-img" });
        img.src = page.thumbnail;
      } else {
        preview.createSpan({ cls: "gn-page-thumb-preview-icon", text: "\u{1F4DD}" });
        if (page.strokes && page.strokes.length > 0) {
          preview.createEl("span", { cls: "gn-page-thumb-stroke-badge", text: `${page.strokes.length}` });
        }
      }
      card.createSpan({ cls: "gn-thumb-meta", text: this.formatDate(page.updatedAt) });
      card.createSpan({ cls: "gn-page-thumb-title", text: page.title });
      card.onclick = () => this.handlePageClick(nb.id, page.id);
      card.addEventListener("contextmenu", (ev) => {
        ev.preventDefault();
        new import_obsidian.Menu().addItem((it) => it.setTitle("Rename").setIcon("pencil").onClick(() => new RenameModal(this.plugin.app, this.plugin, nb.id, page.id, page.title).open())).addItem((it) => it.setTitle("Delete").setIcon("trash").onClick(() => this.handleDeletePage(nb.id, page.id))).showAtMouseEvent(ev);
      });
    }
  }
  // ==========================================================
  //  Actions (delegate to PageManager)
  // ==========================================================
  handlePageClick(notebookId, pageId) {
    this.plugin.ui.openCanvas(notebookId, pageId);
  }
  handleNewPage() {
    const nb = this.plugin.getSelectedNotebook();
    if (!nb)
      return;
    this.plugin.pageManager.createPage(nb.id);
  }
  handleDeletePage(notebookId, pageId) {
    this.plugin.pageManager.deletePage(notebookId, pageId);
  }
  // ==========================================================
  //  Helpers
  // ==========================================================
  formatDate(iso) {
    if (!iso)
      return "";
    const d = new Date(iso);
    const now = /* @__PURE__ */ new Date();
    const diffMs = now.getTime() - d.getTime();
    const diffMin = Math.floor(diffMs / 6e4);
    if (diffMin < 1)
      return "Just now";
    if (diffMin < 60)
      return `${diffMin}m ago`;
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24)
      return `${diffHr}h ago`;
    const diffDay = Math.floor(diffHr / 24);
    if (diffDay < 7)
      return `${diffDay}d ago`;
    return d.toLocaleDateString();
  }
};
var CanvasLayoutManager = class {
  constructor(app, plugin) {
    this.app = app;
    this.plugin = plugin;
  }
  async mountCanvas(notebookId, pageId, _mode = "main") {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(CANVAS_VIEW_TYPE)[0];
    if (!leaf) {
      leaf = workspace.getLeaf(false);
      await leaf.setViewState({ type: CANVAS_VIEW_TYPE, active: true });
    } else {
      workspace.revealLeaf(leaf);
    }
    const view = leaf.view;
    view.createSession(notebookId, pageId);
    return view;
  }
  getActiveCanvas() {
    const leaf = this.app.workspace.getLeavesOfType(CANVAS_VIEW_TYPE)[0];
    return leaf ? leaf.view : null;
  }
};
var PageManager = class {
  constructor(plugin) {
    this.plugin = plugin;
  }
  // ============ 内部辅助 ============
  getNotebook(notebookId) {
    return this.plugin.getNotebooks().find((n) => n.id === notebookId);
  }
  async saveNotebook(nb) {
    await this.plugin.fileGateway.saveNotebook(nb);
    this.plugin.emit("notebooks-changed");
  }
  // ============ CRUD ============
  /**
   * 创建新 page 并自动设为 active。渲染由 Plugin.requestPageChange 调度。
   */
  createPage(notebookId, title) {
    const nb = this.getNotebook(notebookId);
    if (!nb)
      return null;
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const page = {
      id: genId(),
      title: title || `Page ${nb.nextPageIndex + 1}`,
      index: nb.nextPageIndex,
      strokes: [],
      background: { type: "blank", color: "#ffffff" },
      createdAt: now,
      updatedAt: now
    };
    nb.pages.push(page);
    nb.nextPageIndex++;
    nb.activePageId = page.id;
    nb.updatedAt = now;
    this.plugin.requestPageChange(notebookId, page.id);
    this.saveNotebook(nb);
    return page;
  }
  /**
   * 删除 page。如果删除的是 activePage，自动切换到相邻 page。
   */
  deletePage(notebookId, pageId) {
    const nb = this.getNotebook(notebookId);
    if (!nb)
      return false;
    const idx = nb.pages.findIndex((p) => p.id === pageId);
    if (idx === -1)
      return false;
    const isActive = nb.activePageId === pageId;
    nb.pages.splice(idx, 1);
    nb.pages.forEach((p, i) => {
      p.index = i;
    });
    nb.nextPageIndex = nb.pages.length;
    nb.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
    if (isActive) {
      const adjacent = nb.pages[Math.min(idx, nb.pages.length - 1)];
      nb.activePageId = adjacent?.id ?? null;
      if (adjacent) {
        this.plugin.requestPageChange(notebookId, adjacent.id);
      } else {
        this.plugin.requestPageChange(notebookId, "");
      }
    }
    this.saveNotebook(nb);
    return true;
  }
  /**
   * 切换 active page。渲染由 Plugin.requestPageChange 调度。
   */
  switchPage(notebookId, pageId) {
    const nb = this.getNotebook(notebookId);
    if (!nb)
      return false;
    const page = nb.pages.find((p) => p.id === pageId);
    if (!page)
      return false;
    nb.activePageId = pageId;
    this.plugin.requestPageChange(notebookId, pageId);
    return true;
  }
  /**
   * 更新 page 元数据（title / background），不影响 strokes。
   */
  updatePage(notebookId, pageId, patch) {
    const nb = this.getNotebook(notebookId);
    if (!nb)
      return false;
    const page = nb.pages.find((p) => p.id === pageId);
    if (!page)
      return false;
    if (patch.title !== void 0)
      page.title = patch.title;
    if (patch.background !== void 0)
      page.background = patch.background;
    if (patch.thumbnail !== void 0)
      page.thumbnail = patch.thumbnail;
    page.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
    nb.updatedAt = page.updatedAt;
    this.saveNotebook(nb);
    return true;
  }
  /**
   * 直接用新的 strokes 数组更新 page 数据。
   * 如果是当前活跃 page，通过 Plugin 调度重绘。
   */
  updatePageData(notebookId, pageId, strokes) {
    const nb = this.getNotebook(notebookId);
    if (!nb)
      return false;
    const page = nb.pages.find((p) => p.id === pageId);
    if (!page)
      return false;
    page.strokes = strokes;
    page.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
    nb.updatedAt = page.updatedAt;
    if (nb.activePageId === pageId) {
      this.plugin.requestPageChange(notebookId, pageId);
    }
    this.saveNotebook(nb);
    return true;
  }
  // ============ 排序 ============
  /** 移动 page 到指定 index */
  movePage(notebookId, pageId, targetIndex) {
    const nb = this.getNotebook(notebookId);
    if (!nb)
      return false;
    const idx = nb.pages.findIndex((p) => p.id === pageId);
    if (idx === -1)
      return false;
    const [page] = nb.pages.splice(idx, 1);
    nb.pages.splice(targetIndex, 0, page);
    nb.pages.forEach((p, i) => {
      p.index = i;
    });
    nb.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
    this.saveNotebook(nb);
    return true;
  }
  /** 深拷贝 page（新 ID + 深拷贝 strokes） */
  duplicatePage(notebookId, pageId) {
    const nb = this.getNotebook(notebookId);
    if (!nb)
      return null;
    const src = nb.pages.find((p) => p.id === pageId);
    if (!src)
      return null;
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const copy = {
      ...src,
      id: genId(),
      title: `${src.title} (copy)`,
      index: nb.pages.length,
      strokes: src.strokes.map((s) => ({ ...s, id: genId(), points: s.points.map((p) => ({ ...p })) })),
      createdAt: now,
      updatedAt: now,
      thumbnail: void 0
    };
    nb.pages.push(copy);
    nb.nextPageIndex = nb.pages.length;
    nb.updatedAt = now;
    this.saveNotebook(nb);
    this.switchPage(notebookId, copy.id);
    return copy;
  }
  // ============ 查询 ============
  getActivePage(notebookId) {
    const nb = this.getNotebook(notebookId);
    if (!nb || !nb.activePageId)
      return null;
    return nb.pages.find((p) => p.id === nb.activePageId) ?? null;
  }
  getPages(notebookId) {
    return this.getNotebook(notebookId)?.pages ?? [];
  }
  getStrokeCount(notebookId, pageId) {
    const nb = this.getNotebook(notebookId);
    const page = nb?.pages.find((p) => p.id === pageId);
    return page?.strokes?.length ?? 0;
  }
  // ============ 缩略图 ============
  generateThumbnail(notebookId, pageId) {
    const canvas = this.plugin.layoutManager?.getActiveCanvas();
    if (!canvas?.session?.isAlive())
      return null;
    const session = canvas.session;
    if (session.pageId !== pageId) {
      const nb = this.getNotebook(notebookId);
      const page = nb?.pages.find((p) => p.id === pageId);
      if (page) {
        session.loadPage(notebookId, page);
      }
    }
    try {
      return session.canvasEl.toDataURL("image/png", 0.5);
    } catch {
      return null;
    }
  }
};
var CanvasPolicy = class {
  static getDefaults() {
    return {
      spacing: 3,
      smoothness: 0.5,
      strokeWidth: 2,
      cornerKeep: 0.3,
      dynamicInk: { enabled: true, strength: 0.25, minWidth: 0.6, maxWidth: 1.8 }
    };
  }
  static clampStrokeWidth(w) {
    return Math.max(CANVAS_CONSTANTS.MIN_STROKE_WIDTH, Math.min(CANVAS_CONSTANTS.MAX_STROKE_WIDTH, w));
  }
  static normalizeSpeed(speed) {
    return Math.min(1, speed / CANVAS_CONSTANTS.SPEED_NORMALIZATION);
  }
};
var _engineIdCounter = 0;
var CanvasRuntimeEngine = class {
  // ============================================================
  constructor() {
    this.id = ++_engineIdCounter;
    this.notebookId = "";
    this.pageId = "";
    this.strokes = [];
    this.mode = "raw";
    this.isDrawing = false;
    this.currentStroke = null;
    this.commitTimer = null;
    this.lastRecordedPoint = null;
    this.params = CanvasPolicy.getDefaults();
    // ============================================================
    //  Event System — lightweight pub/sub, zero external deps
    // ============================================================
    this._listeners = /* @__PURE__ */ new Map();
  }
  /** Subscribe to an engine event. Returns unsubscribe function. */
  on(event, fn) {
    if (!this._listeners.has(event))
      this._listeners.set(event, []);
    this._listeners.get(event).push(fn);
    return () => this.off(event, fn);
  }
  /** Unsubscribe a specific handler from an event. */
  off(event, fn) {
    const arr = this._listeners.get(event);
    if (!arr)
      return;
    const idx = arr.indexOf(fn);
    if (idx !== -1)
      arr.splice(idx, 1);
  }
  /** Emit an event with optional payload. Engine never knows who listens. */
  emit(event, payload) {
    const arr = this._listeners.get(event);
    if (!arr)
      return;
    for (const fn of arr)
      fn(payload);
  }
  get drawing() {
    return this.isDrawing;
  }
  /** Current stroke ID — for dirty tracking by Tool layer. */
  get currentStrokeId() {
    return this.currentStroke?.id ?? null;
  }
  /** Last added point — for computing dirty region bounds. */
  get lastPoint() {
    if (!this.currentStroke?.points?.length)
      return null;
    const pts = this.currentStroke.points;
    return pts[pts.length - 1];
  }
  /**
   * 加载 page 数据 — 幂等可重复调用，返回是否成功。
   * 调用方负责提供 strokes 数据；Engine 不查询 Plugin/Notebook。
   */
  load(notebookId, pageId, strokes) {
    if (this.notebookId === notebookId && this.pageId === pageId)
      return true;
    this.commitNow();
    const safe = strokes && Array.isArray(strokes) ? strokes : [];
    this.notebookId = notebookId;
    this.pageId = pageId;
    this.strokes = safe;
    this.isDrawing = false;
    this.currentStroke = null;
    return true;
  }
  setParams(p) {
    Object.assign(this.params, p);
  }
  setMode(mode) {
    this.mode = mode;
  }
  startStroke(pt, pointerId, setCapture) {
    if (!Number.isFinite(pt.x) || !Number.isFinite(pt.y)) {
      console.warn("[ENGINE] startStroke blocked \u2014 non-finite coords", pt);
      return;
    }
    this.isDrawing = true;
    const p0 = { x: pt.x, y: pt.y, t: performance.now(), speed: 0 };
    this.currentStroke = {
      id: genId(),
      points: [p0],
      color: "#000000",
      width: this.params.strokeWidth,
      _penParams: {
        spacing: this.params.spacing,
        smoothness: this.params.smoothness,
        strokeWidth: this.params.strokeWidth,
        cornerKeep: this.params.cornerKeep
      },
      debug: { pointCount: 1, resampleCount: 0, droppedPoints: 0, avgSpeed: 0 },
      penState: { lastSpeed: 0, smoothedSpeed: 0, lastWidth: this.params.strokeWidth }
    };
    this.strokes.push(this.currentStroke);
    setCapture(pointerId);
  }
  addPoint(pt) {
    if (!this.isDrawing || !this.currentStroke)
      return;
    if (!Number.isFinite(pt.x) || !Number.isFinite(pt.y)) {
      console.warn("[ENGINE] addPoint blocked \u2014 non-finite coords", pt);
      return;
    }
    const points = this.currentStroke.points;
    if (points.length === 0) {
      points.push({ x: pt.x, y: pt.y, t: performance.now(), speed: 0 });
      this.lastRecordedPoint = { x: pt.x, y: pt.y };
      if (this.currentStroke.debug) {
        this.currentStroke.debug.pointCount++;
      }
      return;
    }
    if (points.length === 1) {
      this.lastRecordedPoint = { x: points[0].x, y: points[0].y };
    }
    if (!this.lastRecordedPoint) {
      this.lastRecordedPoint = { x: points[points.length - 1].x, y: points[points.length - 1].y };
    }
    const dist = Math.hypot(pt.x - this.lastRecordedPoint.x, pt.y - this.lastRecordedPoint.y);
    if (dist < this.params.spacing) {
      if (this.currentStroke.debug) {
        this.currentStroke.debug.droppedPoints++;
      }
      return;
    }
    const count = Math.floor(dist / this.params.spacing);
    if (this.currentStroke.debug && count > 0) {
      this.currentStroke.debug.resampleCount += count;
    }
    const dx = (pt.x - this.lastRecordedPoint.x) / dist * this.params.spacing;
    const dy = (pt.y - this.lastRecordedPoint.y) / dist * this.params.spacing;
    let cx = this.lastRecordedPoint.x;
    let cy = this.lastRecordedPoint.y;
    for (let i = 0; i < count; i++) {
      cx += dx;
      cy += dy;
      const prev = points[points.length - 1];
      points.push({
        x: prev.x * 0.3 + cx * 0.7,
        y: prev.y * 0.3 + cy * 0.7,
        t: performance.now(),
        speed: prev.speed ?? 0
      });
      if (this.currentStroke.debug) {
        this.currentStroke.debug.pointCount++;
      }
    }
    if (this.currentStroke.debug && pt.speed != null) {
      this.currentStroke.debug.avgSpeed = (this.currentStroke.debug.avgSpeed + pt.speed) * 0.5;
    }
    if (count > 0) {
      this.lastRecordedPoint = { x: cx, y: cy };
    }
    if (this.currentStroke.penState) {
      const prev = points[points.length - 1];
      const dx2 = pt.x - prev.x;
      const dy2 = pt.y - prev.y;
      const dist2 = Math.hypot(dx2, dy2);
      const dt = Math.max(1, (pt.t ?? 0) - (prev.t ?? pt.t ?? 0));
      const rawSpeed = dist2 / dt;
      const ps = this.currentStroke.penState;
      ps.lastSpeed = rawSpeed;
      ps.smoothedSpeed = this.smoothSpeed(ps.smoothedSpeed, rawSpeed);
    }
  }
  smoothSpeed(prev, current) {
    const alpha = 0.25;
    return prev * (1 - alpha) + current * alpha;
  }
  endStroke() {
    if (!this.isDrawing)
      return;
    this.isDrawing = false;
    const stroke = this.currentStroke;
    if (stroke) {
      stroke.quality = this.analyzeStroke(stroke.points);
    }
    this.currentStroke = null;
    this.commit();
  }
  analyzeStroke(points) {
    if (points.length < 2) {
      return { smoothness: 1, jitter: 0, density: 1, curvature: 0, overall: 1 };
    }
    let jitter = 0;
    let curvature = 0;
    const distances = [];
    for (let i = 1; i < points.length; i++) {
      const dx = points[i].x - points[i - 1].x;
      const dy = points[i].y - points[i - 1].y;
      const dist = Math.hypot(dx, dy);
      distances.push(dist);
      if (i > 1) {
        const prevDx = points[i - 1].x - points[i - 2].x;
        const prevDy = points[i - 1].y - points[i - 2].y;
        const dot = dx * prevDx + dy * prevDy;
        const mag1 = Math.hypot(dx, dy);
        const mag2 = Math.hypot(prevDx, prevDy);
        const cos = mag1 * mag2 === 0 ? 1 : dot / (mag1 * mag2);
        curvature += Math.acos(Math.max(-1, Math.min(1, cos)));
      }
    }
    const avg = distances.reduce((a, b) => a + b, 0) / distances.length;
    jitter = distances.reduce((a, b) => a + Math.abs(b - avg), 0) / distances.length;
    const smoothness = Math.max(0, 1 - jitter / CANVAS_CONSTANTS.JITTER_THRESHOLD);
    const density = Math.max(0, Math.min(1, 1 / (avg + 1e-3)));
    const normCurvature = Math.min(1, curvature / CANVAS_CONSTANTS.CURVATURE_NORMALIZATION);
    const overall = smoothness * 0.4 + density * 0.2 + (1 - normCurvature) * 0.4;
    return { smoothness, jitter, density, curvature: normCurvature, overall };
  }
  // ============================================================
  //  Eraser support — public API for ToolSystem
  // ============================================================
  /** Hit-test: does any point in stroke fall within radius of pt? */
  hitTestStroke(stroke, pt, radius = CANVAS_CONSTANTS.ERASER_RADIUS) {
    if (!stroke?.points)
      return false;
    for (const p of stroke.points) {
      if (Math.hypot(p.x - pt.x, p.y - pt.y) < radius) {
        return true;
      }
    }
    return false;
  }
  /**
   * Point-level erase: remove specific point indices from a stroke.
   * Automatically splits stroke into multiple if gap is detected.
   */
  erasePointsFromStroke(strokeIdx, pointIndices) {
    if (strokeIdx < 0 || strokeIdx >= this.strokes.length)
      return;
    const stroke = this.strokes[strokeIdx];
    if (!stroke?.points)
      return;
    const sorted = [...pointIndices].sort((a, b) => b - a);
    const removeSet = new Set(sorted);
    const segments = [];
    let current = [];
    for (let i = 0; i < stroke.points.length; i++) {
      if (removeSet.has(i)) {
        if (current.length >= 2)
          segments.push(current);
        current = [];
      } else {
        current.push({ ...stroke.points[i] });
      }
    }
    if (current.length >= 2)
      segments.push(current);
    if (segments.length === 0) {
      this.strokes.splice(strokeIdx, 1);
      return;
    }
    if (segments.length === 1 && segments[0].length === stroke.points.length) {
      return;
    }
    stroke.points = segments[0];
    for (let si = 1; si < segments.length; si++) {
      const newStroke = {
        id: genId(),
        points: segments[si],
        color: stroke.color,
        width: stroke.width,
        _penParams: stroke._penParams ? { ...stroke._penParams } : void 0
      };
      this.strokes.splice(strokeIdx + si, 0, newStroke);
    }
  }
  // ============================================================
  //  Public Stroke CRUD API — sole write path to strokes[]
  //  Tool layer MUST use these; NEVER touch engine.strokes directly
  // ============================================================
  /** Remove a stroke by its ID. Returns true if found and removed. */
  removeStroke(strokeId) {
    const idx = this.strokes.findIndex((s) => s.id === strokeId);
    if (idx === -1)
      return false;
    this.strokes.splice(idx, 1);
    return true;
  }
  /** Add a fully-constructed stroke (for external injection, e.g. paste / import). */
  addStroke(stroke) {
    this.strokes.push(stroke);
  }
  /** Update an existing stroke's metadata (color, width, etc.) by ID. Does NOT touch points. */
  updateStroke(strokeId, patch) {
    const stroke = this.strokes.find((s) => s.id === strokeId);
    if (!stroke)
      return false;
    Object.assign(stroke, patch);
    return true;
  }
  /** 同步提交 — emit commit event（用于切页前 flush） */
  commitNow() {
    if (this.commitTimer) {
      window.clearTimeout(this.commitTimer);
      this.commitTimer = null;
    }
    this.emitCommit();
  }
  /** 异步提交 — debounce 80ms（正常绘制路径） */
  commit() {
    if (this.commitTimer)
      window.clearTimeout(this.commitTimer);
    this.commitTimer = window.setTimeout(() => this.emitCommit(), 80);
  }
  /** Fire commit event with current state. Subscribers handle persistence. */
  emitCommit() {
    this.emit("commit", {
      notebookId: this.notebookId,
      pageId: this.pageId,
      strokes: this.strokes
    });
  }
  reset() {
    if (this.commitTimer)
      window.clearTimeout(this.commitTimer);
    this.notebookId = "";
    this.pageId = "";
    this.strokes = [];
    this.isDrawing = false;
    this.currentStroke = null;
  }
  detach() {
    if (this.commitTimer)
      window.clearTimeout(this.commitTimer);
    this.isDrawing = false;
    this.currentStroke = null;
  }
};
var Viewport = class {
  constructor() {
    /** CSS pixel dimensions — the single source of truth for world space. */
    this.cssW = 0;
    this.cssH = 0;
    /** devicePixelRatio — used ONLY in render buffer mapping, never in input math. */
    this.dpr = 1;
    /** Camera — 唯一视图变换源，只影响显示，不影响数据 */
    this.camera = createDefaultCamera();
    /** Interaction guard — true during active pointer drag. Input state, NOT camera state. */
    this.isPanning = false;
    /** Inertia physics controller — driven by unified frame tick, no independent RAF. */
    this.inertia = new InertiaController();
  }
  update(cssW, cssH, dpr) {
    this.cssW = cssW;
    this.cssH = cssH;
    this.dpr = dpr;
  }
  /**
   * screen → camera → world
   * screen（canvas-relative pixels）→ world（stroke data space）
   * 公式: world = (screen - camera) / zoom
   */
  screenToWorld(clientX, clientY, canvasRect) {
    const sx = clientX - canvasRect.left;
    const sy = clientY - canvasRect.top;
    const c = this.camera;
    return {
      x: (sx - c.x) / c.zoom,
      y: (sy - c.y) / c.zoom
    };
  }
  /**
   * world → screen
   * 公式: screen = world * zoom + camera
   */
  worldToScreen(worldX, worldY) {
    const c = this.camera;
    return {
      x: worldX * c.zoom + c.x,
      y: worldY * c.zoom + c.y
    };
  }
  /**
   * Render transform: 应用 camera 到 canvas context
   * 公式: deviceCoord = (worldCoord * zoom + camera) * dpr
   * 用 setTransform 一次性设置，避免累积变换
   */
  applyTransform(ctx) {
    const c = this.camera;
    ctx.setTransform(
      this.dpr * c.zoom,
      0,
      0,
      this.dpr * c.zoom,
      c.x * this.dpr,
      c.y * this.dpr
    );
  }
  /**
   * Pan — 拖动画布
   * delta 是 screen-space pixels，直接加到 camera 偏移
   */
  pan(dx, dy) {
    this.camera.x += dx;
    this.camera.y += dy;
  }
  // ============================================================
  //  Inertia — driven by unified frame tick (no independent RAF)
  // ============================================================
  /** Get a snapshot of the camera state (for viewState sync). */
  getCameraSnapshot() {
    const c = this.camera;
    return { x: c.x, y: c.y, zoom: c.zoom, vx: this.inertia.vx, vy: this.inertia.vy };
  }
  /**
   * Zoom at anchor — 以指定世界坐标为锚点缩放
   * 保持 anchorWorld 在屏幕上的位置不变
   *
   * @param anchorScreenX 锚点在 canvas-relative screen space 的 X
   * @param anchorScreenY 锚点在 canvas-relative screen space 的 Y
   * @param newZoom 目标缩放值（会被 clamp）
   */
  zoomAt(anchorScreenX, anchorScreenY, newZoom) {
    const c = this.camera;
    const oldZoom = c.zoom;
    newZoom = clampZoom(newZoom);
    if (newZoom === oldZoom)
      return;
    const worldX = (anchorScreenX - c.x) / oldZoom;
    const worldY = (anchorScreenY - c.y) / oldZoom;
    c.zoom = newZoom;
    c.x = anchorScreenX - worldX * newZoom;
    c.y = anchorScreenY - worldY * newZoom;
  }
  /** 重置 camera 到默认状态（含停止惯性） */
  resetCamera() {
    this.inertia.stop();
    this.camera = createDefaultCamera();
  }
  /** 获取当前 zoom 级别（方便外部读取） */
  get zoom() {
    return this.camera.zoom;
  }
};
var ReplayController = class {
  constructor() {
    this._strokeId = null;
    this._cursorIndex = 0;
    this._enabled = false;
  }
  get active() {
    return this._enabled;
  }
  get strokeId() {
    return this._strokeId;
  }
  get cursorIndex() {
    return this._cursorIndex;
  }
  /** Check if a given stroke is the one currently being replayed. */
  isActive(strokeId) {
    return this._enabled && this._strokeId === strokeId;
  }
  start(strokeId) {
    this._strokeId = strokeId;
    this._cursorIndex = 0;
    this._enabled = true;
  }
  /** Advance cursor by one frame. Returns true if still within stroke bounds. */
  tick() {
    this._cursorIndex++;
    return true;
  }
  stop() {
    this._enabled = false;
  }
  reset() {
    this.stop();
    this._strokeId = null;
    this._cursorIndex = 0;
  }
};
var StrokeDirtyTracker = class {
  constructor() {
    this.dirtyIds = /* @__PURE__ */ new Set();
  }
  /** Mark a stroke as dirty — its Path2D needs rebuild. */
  markDirty(strokeId) {
    this.dirtyIds.add(strokeId);
  }
  /** Check if a stroke is dirty. */
  isDirty(strokeId) {
    return this.dirtyIds.has(strokeId);
  }
  /** Get all dirty stroke IDs and clear the set. */
  flushDirty() {
    const ids = Array.from(this.dirtyIds);
    this.dirtyIds.clear();
    return ids;
  }
  /** Check if any stroke is dirty. */
  get hasDirty() {
    return this.dirtyIds.size > 0;
  }
  /** Mark all strokes as dirty (e.g. page load, camera reset). */
  markAllDirty(strokeIds) {
    for (const id of strokeIds)
      this.dirtyIds.add(id);
  }
  /** Clear all dirty flags without processing. */
  clear() {
    this.dirtyIds.clear();
  }
};
var StrokeRenderCache = class {
  constructor() {
    this.cache = /* @__PURE__ */ new Map();
  }
  /** Get cached Path2D, or undefined if not built yet. */
  get(strokeId) {
    return this.cache.get(strokeId);
  }
  /** Store a Path2D in cache. */
  set(strokeId, path2D) {
    this.cache.set(strokeId, path2D);
  }
  /** Invalidate (remove) a stroke's cached Path2D. */
  invalidate(strokeId) {
    this.cache.delete(strokeId);
  }
  /** Clear all cached Path2Ds. */
  clear() {
    this.cache.clear();
  }
  /** Number of cached entries. */
  get size() {
    return this.cache.size;
  }
};
function mergeDirtyRegions(a, b) {
  if (!a)
    return { ...b };
  const ax2 = a.x + a.w, ay2 = a.y + a.h;
  const bx2 = b.x + b.x + b.w, by2 = b.y + b.h;
  const nx = Math.min(a.x, b.x);
  const ny = Math.min(a.y, b.y);
  return {
    x: nx,
    y: ny,
    w: Math.max(ax2, bx2) - nx,
    h: Math.max(ay2, by2) - ny
  };
}
function computeStrokeBounds(points) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX)
      minX = p.x;
    if (p.y < minY)
      minY = p.y;
    if (p.x > maxX)
      maxX = p.x;
    if (p.y > maxY)
      maxY = p.y;
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}
var RenderScheduler = class {
  constructor() {
    this.rafId = null;
    this._onFrame = null;
    this._running = false;
  }
  /** Register the frame callback. Called once per RAF tick. */
  set onFrame(fn) {
    this._onFrame = fn;
  }
  get running() {
    return this._running;
  }
  /**
   * Request a render. Multiple rapid calls are merged into a single RAF tick.
   * Idempotent — if already pending, this is a no-op.
   */
  requestRender() {
    if (this.rafId !== null)
      return;
    if (!this._running)
      return;
    this.rafId = window.requestAnimationFrame(() => {
      this.rafId = null;
      if (!this._running)
        return;
      this._onFrame?.();
    });
  }
  /** Start the scheduler. Before start(), requestRender() is silently ignored. */
  start() {
    this._running = true;
  }
  /** Stop the scheduler and cancel any pending RAF. */
  stop() {
    this._running = false;
    if (this.rafId !== null) {
      window.cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }
};
var RenderQueue = class {
  constructor() {
    this.renderables = [];
    /** Camera snapshot at queue-build time */
    this.camera = { x: 0, y: 0, zoom: 1 };
    /** Canvas buffer dimensions (cssW/cssH * dpr) */
    this.bufW = 0;
    this.bufH = 0;
    /** Accumulated dirty region in world-space (for partial repaint clip). */
    this.dirtyRegion = null;
    /** Background color */
    this.backgroundColor = "#ffffff";
  }
  // ==========================================================
  //  Full rebuild — used for page load / camera reset / resize
  // ==========================================================
  /** Full rebuild of all renderables from scratch. Uses cache for Path2D. */
  fullRebuild(strokes, params, cache, replayCtrl) {
    const newRenderables = [];
    for (const s of strokes) {
      if (!s?.points || s.points.length === 0)
        continue;
      if (replayCtrl?.isActive(s.id)) {
        const cursorIdx = replayCtrl.cursorIndex;
        const pts = s.points.slice(0, cursorIdx);
        if (pts.length < 2)
          continue;
        const path2D2 = buildPath2D(pts, s._penParams || params);
        cache.set(s.id, path2D2);
        newRenderables.push({
          id: s.id,
          path2D: path2D2,
          style: buildStyle(s, s._penParams || params),
          _sourcePoints: s.points,
          _totalPoints: s.points.length
        });
        continue;
      }
      let path2D = cache.get(s.id);
      if (!path2D) {
        path2D = buildPath2D(s.points, s._penParams || params);
        cache.set(s.id, path2D);
      }
      newRenderables.push({
        id: s.id,
        path2D,
        style: buildStyle(s, s._penParams || params),
        _sourcePoints: s.points,
        _totalPoints: s.points.length
      });
    }
    this.renderables = newRenderables;
    this.dirtyRegion = null;
  }
  // ==========================================================
  //  Incremental update — only dirty strokes rebuild Path2D
  //  O(k) where k = number of dirty strokes
  // ==========================================================
  /**
   * Update only dirty strokes. Non-dirty strokes keep their existing Path2D.
   * @param dirtyIds Set of stroke IDs that need rebuild
   * @param strokes Full strokes array (for index lookup)
   * @param params Engine pen params
   * @param cache StrokeRenderCache for Path2D storage
   */
  updateDirty(dirtyIds, strokes, params, cache) {
    if (dirtyIds.length === 0)
      return;
    const indexMap = /* @__PURE__ */ new Map();
    for (let i = 0; i < strokes.length; i++) {
      indexMap.set(strokes[i].id, i);
    }
    for (const id of dirtyIds) {
      const idx = indexMap.get(id);
      if (idx === void 0) {
        cache.invalidate(id);
        continue;
      }
      const s = strokes[idx];
      if (!s?.points || s.points.length === 0)
        continue;
      const pp = s._penParams || params;
      const path2D = buildPath2D(s.points, pp);
      cache.set(s.id, path2D);
      while (this.renderables.length <= idx) {
        this.renderables.push(null);
      }
      this.renderables[idx] = {
        id: s.id,
        path2D,
        style: buildStyle(s, pp),
        _sourcePoints: s.points,
        _totalPoints: s.points.length
      };
    }
  }
  // ==========================================================
  //  Dirty region management
  // ==========================================================
  /** Merge a new dirty region (world-space) into the accumulated region. */
  mergeDirtyRegion(region) {
    this.dirtyRegion = mergeDirtyRegions(this.dirtyRegion, region);
  }
  /** Get the accumulated dirty region, or null if none. */
  getDirtyRegion() {
    return this.dirtyRegion;
  }
  /** Clear the accumulated dirty region. */
  clearDirtyRegion() {
    this.dirtyRegion = null;
  }
  /** Clear all cached renderables. */
  clear() {
    this.renderables = [];
    this.dirtyRegion = null;
  }
};
function buildPath2D(points, p) {
  const path = new Path2D();
  if (points.length === 1) {
    path.moveTo(points[0].x, points[0].y);
    path.arc(points[0].x, points[0].y, 1, 0, Math.PI * 2);
    return path;
  }
  if (points.length === 2) {
    path.moveTo(points[0].x, points[0].y);
    path.lineTo(points[1].x, points[1].y);
    return path;
  }
  const thresholdAngle = p.cornerKeep * Math.PI;
  path.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length - 1; i++) {
    const v1x = points[i].x - points[i - 1].x;
    const v1y = points[i].y - points[i - 1].y;
    const v2x = points[i + 1].x - points[i].x;
    const v2y = points[i + 1].y - points[i].y;
    const dot = v1x * v2x + v1y * v2y;
    const m1 = Math.hypot(v1x, v1y);
    const m2 = Math.hypot(v2x, v2y);
    const cosA = m1 && m2 ? dot / (m1 * m2) : 1;
    const angle = Math.acos(Math.max(-1, Math.min(1, cosA)));
    if (angle > thresholdAngle) {
      path.lineTo(points[i].x, points[i].y);
      continue;
    }
    const t = p.smoothness;
    path.quadraticCurveTo(
      points[i].x,
      points[i].y,
      points[i].x + (points[i + 1].x - points[i].x) * t,
      points[i].y + (points[i + 1].y - points[i].y) * t
    );
  }
  path.lineTo(points[points.length - 1].x, points[points.length - 1].y);
  return path;
}
function buildStyle(s, p) {
  return {
    color: s.color,
    lineWidth: CanvasPolicy.clampStrokeWidth(p.strokeWidth),
    lineCap: "round",
    lineJoin: "round"
  };
}
var Renderer = class {
  /**
   * Draw the render queue to canvas.
   * If queue has a dirtyRegion, uses ctx.clip() for partial redraw.
   * Otherwise performs full canvas redraw.
   */
  draw(ctx, canvas, queue, viewport) {
    const dirty = queue.getDirtyRegion();
    const cam = queue.camera;
    const dpr = viewport.dpr;
    if (dirty && dirty.w > 0 && dirty.h > 0) {
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      const dx = (dirty.x * cam.zoom + cam.x) * dpr;
      const dy = (dirty.y * cam.zoom + cam.y) * dpr;
      const dw = dirty.w * cam.zoom * dpr;
      const dh = dirty.h * cam.zoom * dpr;
      const pad = 4;
      ctx.beginPath();
      ctx.rect(dx - pad, dy - pad, dw + pad * 2, dh + pad * 2);
      ctx.clip();
      ctx.clearRect(dx - pad, dy - pad, dw + pad * 2, dh + pad * 2);
      ctx.fillStyle = queue.backgroundColor;
      ctx.fillRect(dx - pad, dy - pad, dw + pad * 2, dh + pad * 2);
      ctx.restore();
    } else {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = queue.backgroundColor;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    ctx.setTransform(
      dpr * cam.zoom,
      0,
      0,
      dpr * cam.zoom,
      cam.x * dpr,
      cam.y * dpr
    );
    for (const r of queue.renderables) {
      if (!r)
        continue;
      ctx.save();
      ctx.strokeStyle = r.style.color;
      ctx.lineWidth = r.style.lineWidth;
      ctx.lineCap = r.style.lineCap;
      ctx.lineJoin = r.style.lineJoin;
      ctx.stroke(r.path2D);
      ctx.restore();
    }
  }
};
var CanvasSessionRegistry = class _CanvasSessionRegistry {
  constructor() {
    this.activeSession = null;
    this.sessionId = "";
  }
  static {
    this._instance = null;
  }
  static getInstance() {
    if (!this._instance) {
      this._instance = new _CanvasSessionRegistry();
    }
    return this._instance;
  }
  register(session) {
    if (this.activeSession && !this.activeSession.destroyed) {
      console.warn("[REGISTRY] \u26A0\uFE0F  destroying previous session before creating new one");
      this.activeSession.destroy();
    }
    this.activeSession = session;
    this.sessionId = `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    console.log("[REGISTRY] \u2705 session registered", this.sessionId);
  }
  deregister() {
    if (this.activeSession) {
      console.log("[REGISTRY] \u{1F5D1}  session deregistered", this.sessionId);
    }
    this.activeSession = null;
    this.sessionId = "";
  }
  get isActive() {
    return this.activeSession !== null && !this.activeSession.destroyed;
  }
};
var ToolManager = class {
  constructor() {
    this.tools = /* @__PURE__ */ new Map();
    this.tools.set("pen", new PenTool());
    this.tools.set("eraser", new EraserTool());
    this.tools.set("hand", new HandTool());
    this.active = this.tools.get("pen");
  }
  /** Get the currently active tool instance. */
  getActive() {
    return this.active;
  }
  /** Get active tool ID for UI query. */
  getActiveId() {
    return this.active.id;
  }
  /** Get a specific tool by ID (for settings UI). */
  get(id) {
    return this.tools.get(id);
  }
  /** Switch active tool by ID. Returns false if tool not found. */
  setActive(id) {
    const tool = this.tools.get(id);
    if (!tool)
      return false;
    this.active = tool;
    return true;
  }
  /** Update settings on a specific tool. */
  updateSettings(id, patch) {
    const tool = this.tools.get(id);
    if (!tool)
      return false;
    Object.assign(tool.settings, patch);
    return true;
  }
  /** Cleanup all tools. */
  destroy() {
    this.tools.clear();
  }
};
var PointerPipeline = class {
  constructor(session) {
    this.session = session;
    this.inputCtrl = new InputSnapshotController();
    const el = session.canvasEl;
    this._onPD = (ev) => {
      if (!session.isReady)
        return;
      const snapshot = this.inputCtrl.capture(ev, session);
      session.toolManager.getActive().onPointerDown(snapshot, session);
    };
    this._onPM = (ev) => {
      if (!session.isReady)
        return;
      const snapshot = this.inputCtrl.capture(ev, session);
      session.toolManager.getActive().onPointerMove(snapshot, session);
    };
    this._onPU = (ev) => {
      if (!session.isReady)
        return;
      const snapshot = this.inputCtrl.capture(ev, session);
      session.toolManager.getActive().onPointerUp(snapshot, session);
    };
    this._onWH = (ev) => {
      if (!session.isReady)
        return;
      ev.preventDefault();
      const r = el.getBoundingClientRect();
      const ax = ev.clientX - r.left, ay = ev.clientY - r.top;
      const dz = -ev.deltaY * CAMERA_CONSTANTS.ZOOM_WHEEL_FACTOR;
      session.viewport.zoomAt(ax, ay, session.viewport.camera.zoom * (1 + dz));
      session.syncViewState();
      session.markCameraDirty();
    };
    el.addEventListener("pointerdown", this._onPD);
    el.addEventListener("pointermove", this._onPM);
    el.addEventListener("pointerup", this._onPU);
    el.addEventListener("wheel", this._onWH, { passive: false });
  }
  destroy() {
    const el = this.session?.canvasEl;
    if (!el)
      return;
    el.removeEventListener("pointerdown", this._onPD);
    el.removeEventListener("pointermove", this._onPM);
    el.removeEventListener("pointerup", this._onPU);
    el.removeEventListener("wheel", this._onWH);
  }
};
var CanvasSession = class {
  constructor(notebookId, pageId, plugin, parentEl) {
    this.notebookId = notebookId;
    this.pageId = pageId;
    this.plugin = plugin;
    this.viewport = new Viewport();
    this.replayCtrl = new ReplayController();
    this.toolManager = new ToolManager();
    this.destroyed = false;
    // ============================================================
    // ============================================================
    //  Render Pipeline — PS级调度系统 + 增量更新
    // ============================================================
    this.renderScheduler = new RenderScheduler();
    this.renderQueue = new RenderQueue();
    this.renderer = new Renderer();
    this.dirtyTracker = new StrokeDirtyTracker();
    this.strokeCache = new StrokeRenderCache();
    /** True when a full rebuild is needed (page load, camera change, resize). */
    this._needsFullRebuild = true;
    /** Execution Guard — 唯一生命周期标记，destroy 后永久为 false */
    this.alive = true;
    // ============================================================
    //  ViewUIState — single source for cursor/camera/tool UI
    // ============================================================
    this.viewState = {
      cursor: { x: 0, y: 0, visible: true, mode: "pen", size: 8 },
      camera: { x: 0, y: 0, zoom: 1, vx: 0, vy: 0 },
      tool: {
        activeTool: "pen",
        penSettings: CanvasPolicy.getDefaults(),
        eraserMode: "point",
        eraserSize: 50,
        eraserStrength: 50
      }
    };
    this._viewSubs = [];
    this._frameCount = 0;
    this.engine = plugin.createEngine();
    const nb = plugin.getNotebooks().find((n) => n.id === notebookId);
    const page = nb?.pages.find((p) => p.id === pageId);
    const strokes = page?.strokes ?? [];
    this.engine.load(notebookId, pageId, strokes);
    this.engine.on("commit", (payload) => {
      if (!payload)
        return;
      const nb2 = plugin.getNotebooks().find((n) => n.id === payload.notebookId);
      const page2 = nb2?.pages.find((p) => p.id === payload.pageId);
      if (!nb2 || !page2)
        return;
      page2.strokes = payload.strokes ?? [];
      page2.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
      plugin.isInternalWrite = true;
      try {
        plugin.fileGateway.saveNotebook(nb2);
      } finally {
        plugin.isInternalWrite = false;
      }
    });
    const wrapper = parentEl.createEl("div", { cls: "goodnote-canvas-wrapper" });
    this.canvasEl = wrapper.createEl("canvas", { cls: "goodnote-canvas" });
    this.ctx = this.canvasEl.getContext("2d");
    this._onResize = () => this.applySize();
    this.applySize();
    window.addEventListener("resize", this._onResize);
    this.pointerPipeline = new PointerPipeline(this);
    this.renderScheduler.onFrame = () => this._unifiedTick();
    this.renderScheduler.start();
    this.syncViewState();
  }
  /** Subscribe to viewState changes. Returns unsubscribe function. */
  subscribeViewUI(fn) {
    this._viewSubs.push(fn);
    return () => {
      const i = this._viewSubs.indexOf(fn);
      if (i !== -1)
        this._viewSubs.splice(i, 1);
    };
  }
  /** Sync internal state → viewState + notify subscribers. Call after any change. */
  syncViewState() {
    const c = this.viewport.camera;
    const inertia = this.viewport.inertia;
    this.viewState.camera = { x: c.x, y: c.y, zoom: c.zoom, vx: inertia.vx, vy: inertia.vy };
    const activeTool = this.toolManager.getActiveId();
    this.viewState.tool.activeTool = activeTool;
    this.viewState.cursor.mode = activeTool;
    if (activeTool === "pen") {
      const pen = this.toolManager.get("pen");
      if (pen) {
        const ps = pen.settings;
        this.viewState.tool.penSettings = { ...ps };
        this.viewState.cursor.size = 6 + ps.strokeWidth * 3;
      }
    } else if (activeTool === "eraser") {
      const eraser = this.toolManager.get("eraser");
      if (eraser) {
        const es = eraser.settings;
        this.viewState.tool.eraserMode = es.mode;
        this.viewState.tool.eraserSize = es.size;
        this.viewState.tool.eraserStrength = es.strength;
        this.viewState.cursor.size = 10 + es.size / 100 * 50;
      }
    } else {
      this.viewState.cursor.size = 10;
    }
    for (const fn of this._viewSubs)
      fn(this.viewState);
  }
  /** 公开只读 — 外部 guard 用，不会 throw */
  isAlive() {
    return this.alive;
  }
  /** 内部强制检查 — 任何核心方法入口调用，destroy 后 throw */
  assertAlive() {
    if (!this.alive) {
      throw new Error("[CanvasSession] \u274C Execution blocked \u2014 session already destroyed");
    }
  }
  get isReady() {
    return this.alive && !this.destroyed && !!this.engine;
  }
  // ---- lifecycle ----
  destroy() {
    if (this.destroyed)
      return;
    this.alive = false;
    this.destroyed = true;
    this.stopReplayLoop();
    this.replayCtrl.reset();
    this.viewport.inertia.stop();
    this.renderScheduler.stop();
    this.renderQueue.clear();
    this.dirtyTracker.clear();
    this.strokeCache.clear();
    window.removeEventListener("resize", this._onResize);
    if (this.pointerPipeline) {
      this.pointerPipeline.destroy();
    }
    if (this.engine) {
      this.engine.detach();
    }
    if (this.canvasEl) {
      this.canvasEl.parentElement?.remove();
    }
    const self = this;
    self.engine = null;
    self.viewport = null;
    self.canvasEl = null;
    self.ctx = null;
    self.replayCtrl = null;
    self._onResize = null;
    console.log("[SESSION] \u{1F480} fully destroyed \u2014 all references nulled, all listeners removed");
  }
  // ---- size ----
  applySize() {
    window.requestAnimationFrame(() => {
      if (!this.alive)
        return;
      const rect = this.canvasEl.getBoundingClientRect();
      const w = Math.round(rect.width), h = Math.round(rect.height);
      if (w < 50 || h < 50)
        return;
      if (w === this.viewport.cssW && h === this.viewport.cssH && this.viewport.cssW > 0)
        return;
      const dpr = window.devicePixelRatio || 1;
      this.canvasEl.width = Math.round(w * dpr);
      this.canvasEl.height = Math.round(h * dpr);
      this.canvasEl.style.setProperty("--canvas-css-w", w + "px");
      this.canvasEl.style.setProperty("--canvas-css-h", h + "px");
      this.viewport.update(w, h, dpr);
    });
  }
  requestResize() {
    this.assertAlive();
    this.applySize();
  }
  // ---- pointer events ----
  // ---- pointer events (routed through ToolSystem) ----
  // ---- Page loading (zero-overhead, no DOM rebuild) ----
  /**
   * 加载 Page 数据 — 仅更新 engine 引用，不重建 DOM。
   * 调用方（Plugin）提供完整 Page 对象；Session 不查询 Notebook。
   */
  loadPage(notebookId, page) {
    this.assertAlive();
    this.engine.commitNow();
    this.engine.load(notebookId, page.id, page.strokes ?? []);
    this.notebookId = notebookId;
    this.pageId = page.id;
    this.strokeCache.clear();
    this._needsFullRebuild = true;
    this.markDirty();
    this.syncViewState();
  }
  /** Switch active tool by ID. Returns false if tool not found. */
  setTool(id) {
    const ok = this.toolManager.setActive(id);
    if (ok)
      this.syncViewState();
    return ok;
  }
  /** Get active tool ID (for UI query). */
  getActiveToolId() {
    return this.toolManager.getActiveId();
  }
  /** Update settings on a specific tool. */
  updateToolSettings(id, patch) {
    return this.toolManager.updateSettings(id, patch);
  }
  // ---- Stroke accessor (for PageManager) ----
  /** 获取当前渲染的 strokes（直接引用，非拷贝） */
  getStrokes() {
    return this.engine.strokes;
  }
  /** 替换 strokes 并触发重绘（用于 PageManager.updatePageData） */
  setStrokes(strokes) {
    this.assertAlive();
    this.engine.strokes = strokes;
    this.strokeCache.clear();
    this._needsFullRebuild = true;
    this.markDirty();
  }
  /** 强制重绘（不检查 isDirty） */
  rerender() {
    this.assertAlive();
    this._needsFullRebuild = true;
    this.renderFrame();
  }
  // ---- Render Pipeline (PS级调度 + 增量更新) ----
  /**
   * Mark canvas dirty.
   * @param strokeId Optional — the stroke that changed (for incremental update).
   * @param dirtyRect Optional — world-space bounding box of the change (for partial redraw).
   */
  markDirty(strokeId, dirtyRect) {
    this.assertAlive();
    if (strokeId) {
      this.dirtyTracker.markDirty(strokeId);
    }
    if (dirtyRect) {
      this.renderQueue.mergeDirtyRegion(dirtyRect);
    }
    this.renderScheduler.requestRender();
  }
  /**
   * Notify that the camera changed — triggers full rebuild + full redraw on next frame.
   */
  markCameraDirty() {
    this.assertAlive();
    this._needsFullRebuild = true;
    this.renderScheduler.requestRender();
  }
  /**
   * Request a full rebuild on next frame (e.g. after erase operations that may split strokes).
   * Public so Tool layer can trigger it.
   */
  requestFullRebuild() {
    this.assertAlive();
    this._needsFullRebuild = true;
  }
  /**
   * Render frame — called by RenderScheduler at most once per RAF tick.
   * ① Decides: full rebuild vs incremental update
   * ② Delegates to Renderer.draw()
   */
  renderFrame() {
    this.assertAlive();
    const ctx = this.ctx, canvas = this.canvasEl, engine = this.engine;
    if (!ctx || !canvas || !engine)
      return;
    this._frameCount++;
    if (this._frameCount % 60 === 0) {
      console.log("[RENDER CHECK]", {
        cssW: this.viewport.cssW,
        cssH: this.viewport.cssH,
        bufW: canvas.width,
        bufH: canvas.height,
        strokeCount: engine.strokes.length,
        cacheSize: this.strokeCache.size,
        dirtyCount: this.dirtyTracker.hasDirty ? "(has dirty)" : "(clean)"
      });
    }
    const c = this.viewport.camera;
    this.renderQueue.camera = { x: c.x, y: c.y, zoom: c.zoom };
    this.renderQueue.bufW = canvas.width;
    this.renderQueue.bufH = canvas.height;
    if (this._needsFullRebuild) {
      this._needsFullRebuild = false;
      this.renderQueue.fullRebuild(engine.strokes, engine.params, this.strokeCache, this.replayCtrl);
      this.dirtyTracker.clear();
    } else if (this.dirtyTracker.hasDirty) {
      const dirtyIds = this.dirtyTracker.flushDirty();
      this.renderQueue.updateDirty(dirtyIds, engine.strokes, engine.params, this.strokeCache);
    }
    this.renderer.draw(ctx, canvas, this.renderQueue, this.viewport);
    this.renderQueue.clearDirtyRegion();
  }
  // ---- Unified Frame Tick (single RAF → inertia → replay → render) ----
  /**
   * Start replay animation. Replay is now driven by the unified frame tick,
   * not by its own RAF loop.
   */
  startReplayLoop() {
    this.markDirty();
  }
  /** Stop replay animation. */
  stopReplayLoop() {
    this.replayCtrl.stop();
  }
  /**
   * SINGLE UNIFIED FRAME TICK — the only RAF callback in the entire system.
   * Called by RenderScheduler once per frame.
   * Order: inertia physics → replay advance → render
   */
  _unifiedTick() {
    if (!this.alive)
      return;
    if (this.viewport.inertia.active) {
      const stillActive = this.viewport.inertia.tick();
      if (!stillActive) {
      }
    }
    if (this.replayCtrl.active) {
      const stroke = this.engine?.strokes.find((s) => s.id === this.replayCtrl.strokeId);
      if (!stroke || this.replayCtrl.cursorIndex >= stroke.points.length) {
        this.replayCtrl.stop();
      } else {
        this.replayCtrl.tick();
      }
      this.markDirty();
    }
    this.renderFrame();
  }
};
function createDefaultToolbarState() {
  return {
    x: 12,
    y: -1,
    // -1 = uninitialized, will be computed from viewport on first render
    dock: "free",
    dragging: false,
    dragOx: 0,
    dragOy: 0,
    viewportW: window.innerWidth,
    viewportH: window.innerHeight,
    toolbarW: 0,
    toolbarH: 0
  };
}
var CanvasView = class _CanvasView extends import_obsidian.ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.session = null;
    this.isDrawerOpen = false;
    // Floating toolbar — single state source
    this.ts = createDefaultToolbarState();
    this._resizeObserver = null;
    this.plugin = plugin;
  }
  getViewType() {
    return CANVAS_VIEW_TYPE;
  }
  getDisplayText() {
    return "Canvas";
  }
  getIcon() {
    return "pen-tool";
  }
  // ---- session lifecycle ----
  /**
   * 创建或切换 session。
   * - 首次调用：创建 CanvasSession + canvas DOM
   * - 后续调用（同一 notebook 不同 page）：仅 switchPage，零 DOM 开销
   * - 不同 notebook：销毁重建（notebook 切换是低频操作）
   */
  createSession(notebookId, pageId) {
    if (this.session?.isAlive() && this.session.notebookId === notebookId) {
      if (this.session.pageId === pageId)
        return;
      const nb = this.plugin.getNotebooks().find((n) => n.id === notebookId);
      const page = nb?.pages.find((p) => p.id === pageId);
      if (page) {
        this.session.loadPage(notebookId, page);
        console.log("[SESSION] \u{1F504} page switched (zero-overhead)", { notebookId, pageId });
        return;
      }
      console.warn("[SESSION] \u26A0\uFE0F page not found, falling back to rebuild");
    }
    this.destroySession();
    if (!this.canvasAreaEl)
      return;
    this.canvasAreaEl.empty();
    console.assert(
      typeof _CanvasView === "function",
      "CanvasView must NOT exist at runtime logic level"
    );
    this.session = new CanvasSession(notebookId, pageId, this.plugin, this.canvasAreaEl);
    CanvasSessionRegistry.getInstance().register(this.session);
    const ownerDoc = this.containerEl.ownerDocument;
    const canvasCount = ownerDoc.querySelectorAll("canvas").length;
    if (canvasCount !== 1) {
      console.error(`\u274C Canvas count = ${canvasCount}, expected 1 \u2014 destroying and recreating`);
      CanvasSessionRegistry.getInstance().deregister();
      this.session.destroy();
      this.canvasAreaEl.empty();
      this.session = new CanvasSession(notebookId, pageId, this.plugin, this.canvasAreaEl);
      CanvasSessionRegistry.getInstance().register(this.session);
      console.assert(ownerDoc.querySelectorAll("canvas").length === 1, "\u274C FAILED: Multiple canvases after retry");
    }
    if (this.cursorRenderer) {
      this.cursorRenderer.bindSession(this.session);
      this.cursorRenderer.mount();
    }
    window.requestAnimationFrame(() => {
      const r = this.layoutEl.getBoundingClientRect();
      this.ts.viewportW = r.width;
      this.ts.viewportH = r.height;
      this.cacheToolbarSize();
      this.initToolbarPosition();
    });
    console.log("[SESSION] \u2705 created", { notebookId, pageId, engineId: this.session.engine.id });
  }
  destroySession() {
    if (this.session) {
      CanvasSessionRegistry.getInstance().deregister();
      this.session.destroy();
      console.log("[SESSION] \u{1F480} destroyed");
      this.session = null;
    }
    const remainingCanvases = this.containerEl.ownerDocument.querySelectorAll("canvas").length;
    if (remainingCanvases > 0) {
      console.warn(`\u26A0\uFE0F [GHOST] Orphan canvas detected after destroySession: ${remainingCanvases} remaining`);
    }
  }
  async onClose() {
    if (this.cursorRenderer) {
      this.cursorRenderer.destroy();
    }
    if (this._resizeObserver) {
      this._resizeObserver.disconnect();
      this._resizeObserver = null;
    }
    this.destroySession();
  }
  async onOpen() {
    const c = this.containerEl;
    c.empty();
    c.addClass("goodnote-canvas-view");
    this.layoutEl = c.createEl("div", { cls: "goodnote-canvas-layout" });
    this.canvasAreaEl = c.createEl("div", { cls: "goodnote-canvas-area" });
    this.drawerEl = this.layoutEl.createEl("div", { cls: "goodnote-canvas-drawer" });
    this.buildDrawer(this.drawerEl);
    this.buildFloatingToolbar(this.layoutEl);
    let _roTimer = null;
    this._resizeObserver = new ResizeObserver(() => {
      if (_roTimer !== null)
        return;
      _roTimer = window.setTimeout(() => {
        _roTimer = null;
        const r = this.layoutEl.getBoundingClientRect();
        if (Math.abs(r.width - this.ts.viewportW) < 2 && Math.abs(r.height - this.ts.viewportH) < 2)
          return;
        this.ts.viewportW = r.width;
        this.ts.viewportH = r.height;
        this.applyToolbarState();
      }, 150);
    });
    this._resizeObserver.observe(this.layoutEl);
    window.requestAnimationFrame(() => {
      const r = this.layoutEl.getBoundingClientRect();
      this.ts.viewportW = r.width;
      this.ts.viewportH = r.height;
      this.cacheToolbarSize();
      this.initToolbarPosition();
    });
    this.containerEl.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape" && this.isDrawerOpen)
        this.toggleDrawer();
    });
    this.cursorRenderer = new CursorRenderer(null, this.containerEl?.ownerDocument);
  }
  // ============================================================
  //  Toolbar State Machine
  //  ┌──────────┐    drag     ┌──────────┐   release   ┌──────────┐
  //  │  FREE    │◄──────────►│ DRAGGING │───────────►│  SNAP    │
  //  │ (x,y)    │            │ (x,y)    │            │ compute  │
  //  └──────────┘            └──────────┘            └────┬─────┘
  //       ▲                      ▲                       │
  //       │                      │            ┌──────────▼──────────┐
  //       │                      │            │  DOCK (left/right/  │
  //       │                      │            │  top/bottom)        │
  //       │                      │            └─────────────────────┘
  //       │                      │                       │
  //       │         undock (pointerdown from dock) ──────┘
  //       └──────────────────────────────────────────────┘
  // ============================================================
  /** Single render path: state → DOM. Never reads DOM for position. */
  applyToolbarState() {
    if (!this.toolbarEl)
      return;
    const s = this.ts;
    const isVertical = s.dock === "left" || s.dock === "right";
    this.toolbarEl.classList.remove("horizontal", "vertical");
    this.toolbarEl.classList.add(isVertical ? "vertical" : "horizontal");
    window.requestAnimationFrame(() => this.cacheToolbarSize());
    const maxX = Math.max(0, s.viewportW - s.toolbarW);
    const maxY = Math.max(0, s.viewportH - s.toolbarH);
    s.x = Math.max(0, Math.min(s.x, maxX));
    s.y = Math.max(0, Math.min(s.y, maxY));
    this.toolbarEl.style.setProperty("--toolbar-x", s.x + "px");
    this.toolbarEl.style.setProperty("--toolbar-y", s.y + "px");
  }
  /** Cache toolbar intrinsic size — called once after DOM create + after tool switch */
  cacheToolbarSize() {
    if (!this.toolbarEl)
      return;
    this.ts.toolbarW = this.toolbarEl.offsetWidth;
    this.ts.toolbarH = this.toolbarEl.offsetHeight;
  }
  /** Initial position: bottom-left corner (12, viewportH - toolbarH - 12) */
  initToolbarPosition() {
    this.ts.dock = "free";
    this.ts.x = 12;
    this.ts.y = Math.max(0, this.ts.viewportH - this.ts.toolbarH - 12);
    this.clearDockClasses();
    this.applyToolbarState();
  }
  clearDockClasses() {
    this.toolbarEl.classList.remove(
      "dock-left",
      "dock-right",
      "dock-top",
      "dock-bottom",
      "compact",
      "snapping",
      "undocking",
      "horizontal",
      "vertical"
    );
  }
  // ============================================================
  //  Drag — only mutates state, never touches DOM directly
  // ============================================================
  buildFloatingToolbar(parent) {
    this.toolbarEl = parent.createEl("div", { cls: "goodnote-floating-toolbar" });
    const toolLabels = { pen: "\u94A2\u7B14", eraser: "\u6A61\u76AE", hand: "\u624B\u638C" };
    for (const t of [{ k: "pen", l: "\u2712\uFE0F" }, { k: "eraser", l: "\u{1F9F9}" }, { k: "hand", l: "\u270B" }]) {
      const b = this.toolbarEl.createEl("button", { text: t.l, title: toolLabels[t.k] });
      b.setAttribute("data-tool", t.k);
      const curTool = this.session?.getActiveToolId();
      if (curTool === t.k)
        b.addClass("is-active");
      b.onclick = () => {
        if (!this.session?.isReady || !this.session?.engine)
          return;
        this.session?.setTool(t.k);
        this.updateToolbarState();
        this.buildDrawer(this.drawerEl);
        window.requestAnimationFrame(() => this.cacheToolbarSize());
      };
    }
    this.toolbarEl.createEl("button", { text: "\u2699\uFE0F", title: "\u8BBE\u7F6E" }).onclick = () => this.toggleDrawer();
    this.toolbarEl.onpointerdown = (ev) => {
      if (ev.target.tagName === "BUTTON")
        return;
      const s = this.ts;
      this.toolbarEl.classList.add("no-transition");
      if (s.dock !== "free") {
        s.dock = "free";
        this.clearDockClasses();
      }
      s.dragging = true;
      s.dragOx = ev.clientX - s.x;
      s.dragOy = ev.clientY - s.y;
      this.toolbarEl.classList.add("dragging");
      this.toolbarEl.setPointerCapture(ev.pointerId);
    };
    this.toolbarEl.onpointermove = (ev) => {
      const s = this.ts;
      if (!s.dragging)
        return;
      this.toolbarEl.classList.add("no-transition");
      s.x = ev.clientX - s.dragOx;
      s.y = ev.clientY - s.dragOy;
      const maxX = Math.max(0, s.viewportW - s.toolbarW);
      const maxY = Math.max(0, s.viewportH - s.toolbarH);
      s.x = Math.max(0, Math.min(s.x, maxX));
      s.y = Math.max(0, Math.min(s.y, maxY));
      this.toolbarEl.style.setProperty("--toolbar-x", s.x + "px");
      this.toolbarEl.style.setProperty("--toolbar-y", s.y + "px");
    };
    this.toolbarEl.onpointerup = () => {
      const s = this.ts;
      s.dragging = false;
      this.toolbarEl.classList.remove("dragging");
      this.toolbarEl.classList.remove("no-transition");
      this.smartSnap();
    };
    this.toolbarEl.onmouseenter = () => {
      if (this.ts.dock !== "free" && !this.ts.dragging)
        this.toolbarEl.classList.remove("compact");
    };
    this.toolbarEl.onmouseleave = () => {
      if (this.ts.dock !== "free" && !this.ts.dragging)
        this.toolbarEl.classList.add("compact");
    };
  }
  // ============================================================
  //  Smart Snap — pure math on state + cached viewport
  // ============================================================
  smartSnap() {
    const s = this.ts;
    const SNAP_DISTANCE = 100;
    const tw = s.toolbarW;
    const th = s.toolbarH;
    const vw = s.viewportW;
    const vh = s.viewportH;
    const distTo = {
      left: s.x,
      right: vw - tw - s.x,
      top: s.y,
      bottom: vh - th - s.y
    };
    let bestEdge = "free";
    let bestDist = Infinity;
    for (const [edge, dist] of Object.entries(distTo)) {
      if (dist < SNAP_DISTANCE && dist < bestDist) {
        bestDist = dist;
        bestEdge = edge;
      }
    }
    this.clearDockClasses();
    if (bestEdge === "free") {
      s.dock = "free";
      this.applyToolbarState();
      return;
    }
    switch (bestEdge) {
      case "left":
        s.x = 8;
        s.y = (vh - th) / 2;
        break;
      case "right":
        s.x = vw - tw - 8;
        s.y = (vh - th) / 2;
        break;
      case "top":
        s.x = 12;
        s.y = 12;
        break;
      case "bottom":
        s.x = (vw - tw) / 2;
        s.y = vh - th - 12;
        break;
    }
    s.dock = bestEdge;
    this.toolbarEl.classList.add("dock-" + bestEdge, "compact", "snapping");
    this.applyToolbarState();
    window.setTimeout(() => {
      this.toolbarEl.classList.remove("snapping");
      this.toolbarEl.classList.remove("no-transition");
    }, 420);
  }
  updateToolbarState() {
    const curTool = this.session?.getActiveToolId();
    this.containerEl.querySelectorAll(".goodnote-floating-toolbar button").forEach((b) => {
      const el = b;
      const toolId = el.getAttribute("data-tool");
      if (toolId)
        el.classList.toggle("is-active", toolId === curTool);
    });
  }
  toggleDrawer() {
    this.isDrawerOpen = !this.isDrawerOpen;
    this.drawerEl.classList.toggle("is-visible", this.isDrawerOpen);
  }
  // ==========================================================
  //  Settings Panel — reads tool state from Session.toolManager
  // ==========================================================
  buildDrawer(container) {
    container.empty();
    const toolId = this.session?.getActiveToolId();
    if (toolId === "pen") {
      this.buildPenPanel(container);
    } else if (toolId === "eraser") {
      this.buildEraserPanel(container);
    } else {
      container.createEl("h4", { text: "\u270B \u624B\u638C" });
      container.createEl("p", { text: "\u62D6\u52A8\u753B\u5E03", cls: "goodnote-placeholder" });
    }
  }
  // ── Pen Panel — reads/writes via session.toolManager ──
  /** Derive UI-friendly inkFlow (0-100) from engine spacing param. */
  getPenInkFlow() {
    const pen = this.session?.toolManager.get("pen");
    const ps = pen?.settings;
    return ps ? Math.round((6 - ps.spacing) / 5 * 100) : 70;
  }
  getPenStability() {
    const pen = this.session?.toolManager.get("pen");
    const ps = pen?.settings;
    return ps ? Math.round((0.55 - ps.cornerKeep) / 0.45 * 100) : 65;
  }
  getPenStrokeWidth() {
    const pen = this.session?.toolManager.get("pen");
    const ps = pen?.settings;
    return ps?.strokeWidth ?? 2;
  }
  /** Apply pen params to both Engine and Tool settings via session. */
  applyPenParams(inkFlow, stability, strokeWidth) {
    const s = this.session;
    if (!s?.isAlive?.() || !s?.engine)
      return;
    const t = inkFlow / 100;
    const st = stability / 100;
    const spacing = +(6 - t * 5).toFixed(1);
    const smoothness = +(0.15 + t * 0.6).toFixed(2);
    const cornerKeep = +(0.55 - st * 0.45).toFixed(2);
    const params = { spacing, smoothness, strokeWidth, cornerKeep };
    s.engine.setParams(params);
    s.updateToolSettings("pen", params);
    s.markDirty();
  }
  buildPenPanel(container) {
    container.createEl("h4", { text: "\u270D\uFE0F \u94A2\u7B14" });
    const presets = [
      { label: "\u5706\u73E0\u7B14", ink: 60, stab: 70, w: 1.5 },
      { label: "\u94A2\u7B14", ink: 85, stab: 50, w: 2.5 },
      { label: "\u94C5\u7B14", ink: 25, stab: 30, w: 1.8 }
    ];
    const presetRow = container.createEl("div", { cls: "goodnote-drawer-presets" });
    for (const p of presets) {
      const btn = presetRow.createEl("button", { text: p.label });
      btn.onclick = () => {
        this.applyPenParams(p.ink, p.stab, p.w);
        this.syncPenSliders();
      };
    }
    this.buildSlider(
      container,
      "\u58A8\u6D41",
      "\u7C97\u6DA9 \u2192 \u987A\u6ED1",
      0,
      100,
      this.getPenInkFlow(),
      (v) => this.applyPenParams(v, this.getPenStability(), this.getPenStrokeWidth())
    );
    this.buildSlider(
      container,
      "\u7A33\u5B9A\u6027",
      "\u81EA\u7136 \u2192 \u7CBE\u51C6",
      0,
      100,
      this.getPenStability(),
      (v) => this.applyPenParams(this.getPenInkFlow(), v, this.getPenStrokeWidth())
    );
    this.buildSlider(
      container,
      "\u7B14\u89E6\u5BBD\u5EA6",
      "",
      0.5,
      8,
      this.getPenStrokeWidth(),
      (v) => this.applyPenParams(this.getPenInkFlow(), this.getPenStability(), v),
      0.5
    );
  }
  syncPenSliders() {
    const map = {
      "\u58A8\u6D41": this.getPenInkFlow(),
      "\u7A33\u5B9A\u6027": this.getPenStability(),
      "\u7B14\u89E6\u5BBD\u5EA6": this.getPenStrokeWidth()
    };
    this.drawerEl.querySelectorAll("input[type=range]").forEach((s) => {
      const el = s;
      const key = el.getAttribute("data-slider-key");
      if (key && map[key] !== void 0)
        el.value = String(map[key]);
    });
  }
  // ── Eraser Panel — reads/writes via session.toolManager ──
  buildEraserPanel(container) {
    container.empty();
    const eraser = this.session?.toolManager.get("eraser");
    if (!eraser)
      return;
    const es = eraser.settings;
    container.createEl("h4", { text: "\u{1F9F9} \u6A61\u76AE" });
    const modeRow = container.createEl("div", { cls: "goodnote-drawer-presets" });
    for (const m of [
      { k: "stroke", l: "\u6574\u4F53\u64E6\u9664" },
      { k: "point", l: "\u5C40\u90E8\u64E6\u9664" },
      { k: "smart", l: "\u667A\u80FD\u64E6\u9664" }
    ]) {
      const btn = modeRow.createEl("button", { text: m.l });
      if (es.mode === m.k)
        btn.addClass("is-active");
      btn.onclick = () => {
        es.mode = m.k;
        this.session?.updateToolSettings("eraser", { mode: m.k });
        this.buildEraserPanel(container);
      };
    }
    this.buildSlider(
      container,
      "\u5927\u5C0F",
      "\u5C0F \u2192 \u5927",
      0,
      100,
      es.size,
      (v) => {
        es.size = v;
        this.session?.updateToolSettings("eraser", { size: v });
        this.session?.syncViewState();
      }
    );
    if (es.mode === "smart") {
      this.buildSlider(
        container,
        "\u7075\u654F\u5EA6",
        "\u8F7B\u67D4 \u2192 \u5F3A\u529B",
        0,
        100,
        es.strength,
        (v) => {
          es.strength = v;
          this.session?.updateToolSettings("eraser", { strength: v });
        }
      );
    }
  }
  // ── Generic Slider Builder ──
  buildSlider(container, label, hint, min, max, value, onChange, step = 1) {
    const row = container.createEl("div", { cls: "goodnote-pen-slider" });
    const hdr = row.createEl("div", { cls: "goodnote-pen-slider-header" });
    hdr.createEl("span", { cls: "goodnote-pen-slider-label", text: label });
    if (hint)
      hdr.createEl("span", { cls: "goodnote-pen-slider-hint", text: hint });
    const input = row.createEl("input", { type: "range" });
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.value = String(value);
    input.oninput = () => onChange(parseFloat(input.value));
    input.setAttribute("data-slider-key", label);
  }
};
var GoodNoteMaxPlugin = class extends import_obsidian.Plugin {
  constructor() {
    super(...arguments);
    this._initialized = false;
    this.notebooks = [];
    this.selectedNotebookId = null;
    this.listeners = /* @__PURE__ */ new Map();
    this.isInternalWrite = false;
    this.isInternalRename = false;
    this.uiState = { selectedNotebookId: null, selectedPageId: null, activeView: "notebook", isCanvasDirty: false };
    /** UI intent layer — views call these instead of mutating state directly. */
    this.ui = {
      selectNotebook: (id) => {
        this.uiState.selectedNotebookId = id;
        this.uiState.selectedPageId = null;
        this.uiState.activeView = "page";
        this.setSelectedNotebook(id);
        this.emit("ui-changed");
      },
      selectPage: (pageId) => {
        this.uiState.selectedPageId = pageId;
        this.uiState.activeView = "canvas";
        this.emit("ui-changed");
      },
      openCanvas: (notebookId, pageId) => {
        this.ui.selectPage(pageId);
        this.openCanvasForPage(notebookId, pageId);
      },
      backToPages: () => {
        this.uiState.activeView = "page";
        this.uiState.selectedPageId = null;
        this.emit("ui-changed");
      }
    };
  }
  on(event, h) {
    if (!this.listeners.has(event))
      this.listeners.set(event, []);
    this.listeners.get(event).push(h);
  }
  emit(event) {
    for (const fn of this.listeners.get(event) ?? [])
      fn();
  }
  getNotebooks() {
    return this.notebooks;
  }
  getSortedNotebooks() {
    return [...this.notebooks.filter((n) => n.isPinned), ...this.notebooks.filter((n) => !n.isPinned)];
  }
  getSelectedNotebook() {
    return this.selectedNotebookId ? this.notebooks.find((n) => n.id === this.selectedNotebookId) ?? null : null;
  }
  setSelectedNotebook(id) {
    const nb = this.notebooks.find((n) => n.id === id);
    if (nb && !nb.isPinned) {
      const i = this.notebooks.findIndex((n) => n.id === id);
      if (i > 0) {
        const [it] = this.notebooks.splice(i, 1);
        this.notebooks.unshift(it);
      }
    }
    this.selectedNotebookId = id;
    this.emit("selection-changed");
  }
  togglePinNotebook(id) {
    const nb = this.notebooks.find((n) => n.id === id);
    if (!nb)
      return;
    nb.isPinned = !nb.isPinned;
    this.fileGateway.saveNotebook(nb);
    this.emit("notebooks-changed");
  }
  async resolveNotebookPath(id) {
    const adapter = this.app.vault.adapter;
    const files = (await adapter.list("GoodNoteMax")).files.filter((f) => f.endsWith(".gnnote"));
    for (const f of files) {
      try {
        const raw = await adapter.read(f);
        if (JSON.parse(raw).id === id)
          return f;
      } catch (_) {
      }
    }
    return void 0;
  }
  async renameNotebook(id, newName) {
    const trimmed = newName.trim();
    if (!trimmed)
      return;
    const nb = this.notebooks.find((n) => n.id === id);
    if (!nb)
      return;
    const adapter = this.app.vault.adapter;
    const files = (await adapter.list("GoodNoteMax")).files;
    if (files.some((f) => f.endsWith(`${trimmed}.gnnote`)))
      return;
    const oldPath = await this.resolveNotebookPath(id);
    if (!oldPath)
      return;
    const newPath = `GoodNoteMax/${trimmed}.gnnote`;
    this.isInternalRename = true;
    this.isInternalWrite = true;
    try {
      await adapter.rename(oldPath, newPath);
      nb.name = trimmed;
      await this.fileGateway.saveNotebook(nb);
    } finally {
      this.isInternalRename = false;
      this.isInternalWrite = false;
    }
    this.emit("notebooks-changed");
  }
  safeBootCheck(caller) {
    if (!this._initialized) {
      console.warn(`[BOOT] ${caller}: ignored \u2014 plugin not initialized`);
      return false;
    }
    return true;
  }
  async handleVaultEvent(type, file, oldPath) {
    if (!this.safeBootCheck("handleVaultEvent"))
      return;
    if (this.isInternalRename || this.isInternalWrite)
      return;
    const path = file?.path ?? "";
    if (!path.startsWith("GoodNoteMax/") || !path.endsWith(".gnnote"))
      return;
    if (type === "delete") {
      const filename = path.replace(/^GoodNoteMax\//, "").replace(/\.gnnote$/, "");
      const match = this.notebooks.find((n) => n.name === filename || `${n.name}.gnnote` === path.replace(/^GoodNoteMax\//, ""));
      if (!match)
        return;
      this.notebooks = this.notebooks.filter((n) => n.id !== match.id);
      if (this.selectedNotebookId === match.id) {
        this.selectedNotebookId = null;
        this.emit("selection-changed");
      }
      const activeCanvas = this.layoutManager?.getActiveCanvas();
      console.log("[ENGINE LIFECYCLE]", {
        action: "VAULT_DELETE",
        matchId: match.id,
        activeEngineId: activeCanvas?.session?.engine?.id ?? "none",
        activeEngineNotebookId: activeCanvas?.session?.engine?.notebookId ?? "none"
      });
      if (activeCanvas) {
        activeCanvas.destroySession();
      }
      this.emit("notebooks-changed");
      return;
    }
    if (type === "create") {
      try {
        const raw = await this.app.vault.adapter.read(path);
        const nb = JSON.parse(raw);
        if (!nb.id)
          return;
        if (this.notebooks.some((n) => n.id === nb.id))
          return;
        if (!nb.pages)
          nb.pages = [];
        if (!nb.updatedAt)
          nb.updatedAt = Date.now();
        this.notebooks.push(nb);
        this.emit("notebooks-changed");
      } catch (_) {
      }
      return;
    }
    if (type === "rename") {
      try {
        const raw = await this.app.vault.adapter.read(path);
        const nb = JSON.parse(raw);
        if (!nb.id)
          return;
        const existing = this.notebooks.find((n) => n.id === nb.id);
        if (!existing)
          return;
        if (!nb.updatedAt)
          nb.updatedAt = Date.now();
        if (existing.updatedAt && nb.updatedAt < existing.updatedAt)
          return;
        nb.updatedAt = Date.now();
        const preservedStrokes = existing.pages.map((p) => {
          const nbPage = nb.pages?.find((np) => np.id === p.id);
          return nbPage ? { ...nbPage, strokes: p.strokes } : p;
        });
        Object.assign(existing, nb);
        existing.pages = preservedStrokes;
        this.emit("notebooks-changed");
      } catch (_) {
      }
      return;
    }
    if (type === "modify") {
      try {
        const raw = await this.app.vault.adapter.read(path);
        const nb = JSON.parse(raw);
        if (!nb.id)
          return;
        const existing = this.notebooks.find((n) => n.id === nb.id);
        if (!existing)
          return;
        if (!nb.updatedAt)
          nb.updatedAt = Date.now();
        if (existing.updatedAt && nb.updatedAt < existing.updatedAt)
          return;
        nb.updatedAt = Date.now();
        const preservedStrokes = existing.pages.map((p) => {
          const nbPage = nb.pages?.find((np) => np.id === p.id);
          return nbPage ? { ...nbPage, strokes: p.strokes } : p;
        });
        Object.assign(existing, nb);
        existing.pages = preservedStrokes;
        this.emit("notebooks-changed");
      } catch (_) {
      }
      return;
    }
  }
  async addNotebook(nb) {
    this.notebooks.push(nb);
    await this.fileGateway.saveNotebook(nb);
    this.emit("notebooks-changed");
  }
  async deleteNotebook(id) {
    const nb = this.notebooks.find((n) => n.id === id);
    if (!nb)
      return;
    const activeCanvas = this.layoutManager?.getActiveCanvas();
    console.log("[ENGINE LIFECYCLE]", {
      action: "DELETE_NOTEBOOK",
      notebookId: id,
      activeEngineId: activeCanvas?.session?.engine?.id ?? "none",
      activeEngineNotebookId: activeCanvas?.session?.engine?.notebookId ?? "none"
    });
    await this.fileGateway.deleteNotebook(nb);
    this.notebooks = this.notebooks.filter((n) => n.id !== id);
    if (this.selectedNotebookId === id) {
      this.selectedNotebookId = null;
      this.emit("selection-changed");
    }
    this.emit("notebooks-changed");
  }
  async renamePage(nbId, pId, title) {
    this.pageManager.updatePage(nbId, pId, { title });
  }
  async deletePage(nbId, pId) {
    this.pageManager.deletePage(nbId, pId);
  }
  recordLastPage(nbId, pId) {
    const nb = this.notebooks.find((n) => n.id === nbId);
    if (!nb)
      return;
    nb.lastPageId = pId;
    this.fileGateway.saveNotebook(nb);
  }
  /**
   * 单向调度：Page 数据变更 → Session 状态重建。
   * PageManager / UI 不直接接触 CanvasSession，统一走此入口。
   */
  requestPageChange(notebookId, pageId) {
    const canvas = this.layoutManager?.getActiveCanvas();
    if (!canvas?.session?.isAlive())
      return;
    if (!pageId) {
      canvas.session.setStrokes([]);
      this.emit("selection-changed");
      return;
    }
    const nb = this.notebooks.find((n) => n.id === notebookId);
    const page = nb?.pages.find((p) => p.id === pageId);
    if (!page)
      return;
    canvas.session.loadPage(notebookId, page);
    this.emit("selection-changed");
  }
  createEngine() {
    return new CanvasRuntimeEngine();
  }
  // ==========================================================
  //  Canvas entry — delegates to LayoutManager
  // ==========================================================
  async openCanvasForPage(notebookId, pageId) {
    this.recordLastPage(notebookId, pageId);
    const nb = this.notebooks.find((n) => n.id === notebookId);
    if (nb)
      nb.activePageId = pageId;
    await this.layoutManager.mountCanvas(notebookId, pageId, "main");
  }
  // --- Lifecycle ---
  // --- Lifecycle ---
  async onload() {
    console.log("[PLUGIN INSTANCE]", this);
    if (this._initialized) {
      console.warn("[BOOT] blocked duplicate init");
      return;
    }
    this._initialized = true;
    console.log("[BOOT] init start");
    await this._boot();
  }
  async _boot() {
    console.log("[BOOT] running core init");
    this.fileGateway = new FileGateway(this.app);
    this.layoutManager = new CanvasLayoutManager(this.app, this);
    this.pageManager = new PageManager(this);
    this.notebooks = await this.fileGateway.loadNotebooks();
    console.log("[BOOT] gnnote files hydrated:", this.notebooks.length);
    this.registerView(NOTEBOOK_VIEW_TYPE, (leaf) => new NotebookView(leaf, this));
    this.registerView(PAGE_VIEW_TYPE, (leaf) => new PageView(leaf, this));
    this.registerView(CANVAS_VIEW_TYPE, (leaf) => new CanvasView(leaf, this));
    this.addRibbonIcon("pen-tool", "GoodNote Max", () => this.openBothViews());
    this.app.workspace.onLayoutReady(() => {
      this.openBothViews();
      this.emit("notebooks-changed");
    });
    const vault = this.app.vault;
    vault.on("create", (file) => this.handleVaultEvent("create", file));
    vault.on("delete", (file) => this.handleVaultEvent("delete", file));
    vault.on("rename", (file, oldPath) => this.handleVaultEvent("rename", file, oldPath));
    vault.on("modify", (file) => this.handleVaultEvent("modify", file));
    window.setInterval(() => {
      const registry = CanvasSessionRegistry.getInstance();
      const canvasCount = document.querySelectorAll("canvas").length;
      const sessionAlive = !!(registry.activeSession && !registry.activeSession.destroyed);
      console.assert(
        sessionAlive || canvasCount === 0,
        "\u274C [HEALTH] No active session but canvases exist in DOM"
      );
      if (sessionAlive) {
        console.assert(
          canvasCount === 1,
          `\u274C [HEALTH] Canvas count \u2260 1 (actual: ${canvasCount})`
        );
      }
      console.log("[SESSION HEALTH]", {
        canvasCount,
        sessionAlive,
        sessionDestroyed: registry.activeSession?.destroyed ?? null,
        sessionId: registry.sessionId || "none",
        timestamp: (/* @__PURE__ */ new Date()).toISOString()
      });
    }, 5e3);
  }
  async openBothViews() {
    if (!this.safeBootCheck("openBothViews"))
      return;
    const { workspace } = this.app;
    let l = workspace.getLeavesOfType(NOTEBOOK_VIEW_TYPE)[0];
    if (!l) {
      const leaf = workspace.getLeftLeaf(false);
      if (leaf)
        await leaf.setViewState({ type: NOTEBOOK_VIEW_TYPE, active: true });
    } else
      workspace.revealLeaf(l);
    let r = workspace.getLeavesOfType(PAGE_VIEW_TYPE)[0];
    if (!r) {
      const leaf = workspace.getRightLeaf(false);
      if (leaf)
        await leaf.setViewState({ type: PAGE_VIEW_TYPE, active: true });
    } else
      workspace.revealLeaf(r);
  }
};

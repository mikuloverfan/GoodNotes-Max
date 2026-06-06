import { Plugin, Modal, Setting, ItemView, WorkspaceLeaf, Menu, Notice } from 'obsidian';

// ============================================================
//  World Coordinate Lock — 禁止任何缩放重算
// ============================================================

const WORLD_LOCK = true;

// ============================================================
//  Phase 2-A: Constants Layer — 所有魔法数字集中管理
// ============================================================

const CANVAS_CONSTANTS = {
  ERASER_RADIUS: 10,
  SPEED_NORMALIZATION: 3,
  JITTER_THRESHOLD: 5,
  CURVATURE_NORMALIZATION: 10,
  MIN_STROKE_WIDTH: 0.6,
  MAX_STROKE_WIDTH: 3.5,
} as const;

// ============================================================
//  Data interfaces
// ============================================================

interface StrokeDebug {
  pointCount: number;
  resampleCount: number;
  droppedPoints: number;
  avgSpeed: number;
}

interface StrokeQuality {
  smoothness: number;
  jitter: number;
  density: number;
  curvature: number;
  overall: number;
}

interface StrokePenState {
  lastSpeed: number;
  smoothedSpeed: number;
  lastWidth: number;
}

interface StrokeModifiers {
  speed: number;      // motion: 唯一动态源
  taper: number;      // style: 仅形状微调
  modeFactor: number; // style: UI 微调
}

interface Stroke {
  id: string;
  points: { x: number; y: number; t?: number; speed?: number }[];
  color: string;
  width: number;
  /** Immutable pen snapshot — captured at stroke creation, never changes */
  _penParams?: {
    spacing: number;
    smoothness: number;
    strokeWidth: number;
    cornerKeep: number;
  };
  debug?: StrokeDebug;
  replay?: {
    enabled: boolean;
    cursorIndex: number;
  };
  quality?: StrokeQuality;
  penState?: StrokePenState;
}

type InkMode = 'raw' | 'assist' | 'ai';

type Tool = 'pen' | 'eraser' | 'hand';

// ============================================================
//  Camera System — 稳定版二维视图变换
//  只影响"显示"，不改变任何数据
//  screen → camera → world → stroke
// ============================================================

/** Pure camera state — no velocity, no interaction flags. */
interface Camera {
  x: number;      // 平移 X（CSS pixels）
  y: number;      // 平移 Y（CSS pixels）
  zoom: number;   // 缩放比例，默认 1，范围 [0.2, 4.0]
}

const CAMERA_CONSTANTS = {
  MIN_ZOOM: 0.2,
  MAX_ZOOM: 4.0,
  ZOOM_STEP: 0.08,
  ZOOM_WHEEL_FACTOR: 0.001,
} as const;

const INERTIA_FRICTION = 0.92;
const INERTIA_STOP_THRESHOLD = 0.1;

function createDefaultCamera(): Camera {
  return { x: 0, y: 0, zoom: 1 };
}

// ============================================================
//  InertiaController — pure physics, no RAF (driven by unified tick)
// ============================================================

class InertiaController {
  vx = 0;
  vy = 0;
  active = false;
  private _onDirty: (() => void) | null = null;

  /** Start inertia with initial velocity. onDirty called each tick + on stop. */
  start(vx: number, vy: number, onDirty: () => void): void {
    this.vx = vx;
    this.vy = vy;
    this.active = true;
    this._onDirty = onDirty;
  }

  /**
   * Advance one frame of physics. Called by unified frame tick.
   * @returns true if still active, false if stopped.
   */
  tick(): boolean {
    if (!this.active) return false;

    // Update camera position via callback
    this._onDirty?.();

    // Friction decay
    this.vx *= INERTIA_FRICTION;
    this.vy *= INERTIA_FRICTION;

    // Stop condition
    if (Math.abs(this.vx) < INERTIA_STOP_THRESHOLD && Math.abs(this.vy) < INERTIA_STOP_THRESHOLD) {
      this.vx = 0;
      this.vy = 0;
      this.active = false;
      this._onDirty?.(); // Final render to snap to position
      return false;
    }

    return true;
  }

  /** Force-stop inertia immediately. */
  stop(): void {
    this.active = false;
    this.vx = 0;
    this.vy = 0;
    this._onDirty = null;
  }
}

function clampZoom(zoom: number): number {
  return Math.max(CAMERA_CONSTANTS.MIN_ZOOM, Math.min(CAMERA_CONSTANTS.MAX_ZOOM, zoom));
}

// ============================================================
//  PageBackground — 页面背景配置
// ============================================================

interface PageBackground {
  type: 'blank' | 'ruled' | 'grid' | 'dot' | 'custom';
  color: string;
  lineColor?: string;
  spacing?: number;
}

// ============================================================
//  PageData — 完整页面数据结构（向后兼容旧 Page）
//  strokes 是唯一数据源；canvas 只是渲染器
// ============================================================

interface Page {
  id: string;
  title: string;
  /** 页面索引（notebook 中顺序，0-based） */
  index: number;
  /** 笔迹数据 — 唯一数据源，不属于 canvas */
  strokes: Stroke[];
  /** 页面背景 */
  background: PageBackground;
  /** ISO 8601 创建时间 */
  createdAt: string;
  /** ISO 8601 最后修改时间 */
  updatedAt: string;
  /** 缩略图 base64 */
  thumbnail?: string;
  /** 旧兼容：content.strokes → 迁移到 strokes */
  content?: { strokes?: Stroke[] };
}

// ============================================================
//  旧数据迁移 — 将旧版 Page 升级为完整 PageData
// ============================================================

function migratePage(raw: any): Page {
  return {
    id: raw.id || genId(),
    title: raw.title || 'Untitled',
    index: raw.index ?? 0,
    strokes: raw.strokes || raw.content?.strokes || [],
    background: raw.background || { type: 'blank' as const, color: '#ffffff' },
    createdAt: raw.createdAt || new Date().toISOString(),
    updatedAt: raw.updatedAt || new Date().toISOString(),
    thumbnail: raw.thumbnail,
  };
}

interface HandwritingParams {
  spacing: number;
  smoothness: number;
  strokeWidth: number;
  cornerKeep: number;
  dynamicInk: {
    enabled: boolean;
    strength: number;
    minWidth: number;
    maxWidth: number;
  };
}

type DockMode = 'free' | 'left' | 'right' | 'top' | 'bottom';

// ============================================================
//  ViewUIState — unified cursor / camera / tool UI state
//  CursorSystem / CameraSystem / ToolUI all subscribe, never own state
// ============================================================

interface UICursorState {
  x: number;
  y: number;
  visible: boolean;
  mode: Tool;
  /** Unified cursor size in CSS pixels — drives pen brush radius AND eraser circle. */
  size: number;
}

// ============================================================
//  CursorRenderer — 唯一光标渲染器，PS级笔刷预览
//  UIState → DOM overlay，不依赖任何 Tool / Camera / Render
// ============================================================

class CursorRenderer {
  private el!: HTMLDivElement;
  private _onGlobalPointerMove!: (ev: PointerEvent) => void;
  private _onGlobalPointerLeave!: (ev: PointerEvent) => void;
  private _unsub: (() => void) | null = null;
  private _mounted = false;
  private _session: CanvasSession | null = null;

  constructor(session: CanvasSession | null) {
    this._session = session;
  }

  /** Bind or rebind session. Safe to call multiple times. */
  bindSession(session: CanvasSession): void {
    // Unsubscribe previous session if any
    if (this._unsub) { this._unsub(); this._unsub = null; }
    this._session = session;
    if (this._mounted) {
      this._subscribeViewState();
      // Force initial sync
      session.syncViewState();
    }
  }

  /** Mount the cursor overlay into document.body. Safe to call before session exists. */
  mount(): void {
    if (this._mounted) return;
    this._mounted = true;

    // Singleton guard — remove any existing cursor overlay
    const existing = document.querySelector('.goodnote-cursor-overlay');
    if (existing) existing.remove();

    this.el = document.body.createEl('div', { cls: 'goodnote-cursor-overlay' });

    // Subscribe if session already available
    if (this._session) {
      this._subscribeViewState();
    }

    // ── Global pointermove (window-level, never disconnected) ──
    this._onGlobalPointerMove = (ev: PointerEvent) => {
      if (!this.el || !document.body.contains(this.el)) {
        this.el = document.body.createEl('div', { cls: 'goodnote-cursor-overlay' });
      }
      this.el.style.left = ev.clientX + 'px';
      this.el.style.top = ev.clientY + 'px';
      this.el.classList.remove('cursor-hidden');
      // Write back to viewState if session available
      if (this._session) {
        const vs = this._session.viewState.cursor;
        vs.x = ev.clientX;
        vs.y = ev.clientY;
        vs.visible = true;
      }
    };
    window.addEventListener('pointermove', this._onGlobalPointerMove);

    // ── Document-level leave (pointer exits the page) ──
    this._onGlobalPointerLeave = () => {
      if (this.el) this.el.classList.add('cursor-hidden');
      if (this._session) {
        this._session.viewState.cursor.visible = false;
      }
    };
    document.addEventListener('pointerleave', this._onGlobalPointerLeave);
  }

  /** Subscribe to session viewState for tool-driven appearance. */
  private _subscribeViewState(): void {
    const session = this._session;
    if (!session) return;

    this._unsub = session.subscribeViewUI((vs) => {
      if (!this.el || !document.body.contains(this.el)) return;

      // Reset all tool classes
      this.el.classList.remove('cursor-pen', 'cursor-eraser', 'cursor-hand', 'cursor-hand-grabbing');
      this.el.style.width = '';
      this.el.style.height = '';
      this.el.textContent = '';

      const cs = vs.cursor;
      const sizePx = Math.round(cs.size);

      switch (cs.mode) {
        case 'pen':
          this.el.classList.add('cursor-pen');
          this.el.style.width = sizePx + 'px';
          this.el.style.height = sizePx + 'px';
          break;
        case 'eraser':
          this.el.classList.add('cursor-eraser');
          this.el.style.width = sizePx + 'px';
          this.el.style.height = sizePx + 'px';
          break;
        case 'hand':
          this.el.classList.add('cursor-hand');
          this.el.textContent = '\u270B';
          break;
      }

      // Visibility
      if (cs.visible) {
        this.el.classList.remove('cursor-hidden');
      } else {
        this.el.classList.add('cursor-hidden');
      }
    });

    // Force initial sync
    session.syncViewState();
  }

  /** Remove cursor overlay and all listeners. Idempotent. */
  destroy(): void {
    this._mounted = false;
    if (this._unsub) { this._unsub(); this._unsub = null; }
    if (this._onGlobalPointerMove) window.removeEventListener('pointermove', this._onGlobalPointerMove);
    if (this._onGlobalPointerLeave) document.removeEventListener('pointerleave', this._onGlobalPointerLeave);
    if (this.el && document.body.contains(this.el)) this.el.remove();
    this._session = null;
  }
}

interface ViewUIState {
  cursor: UICursorState;
  camera: { x: number; y: number; zoom: number; vx: number; vy: number };
  tool: { activeTool: Tool; penSettings: HandwritingParams; eraserMode: EraserMode; eraserSize: number; eraserStrength: number };
}

// ============================================================
//  ToolSystem — unified tool interface
//  Tool = behavior, UI = controller, Stroke = data, CanvasSession = inviolable core
// ============================================================

type EraserMode = 'stroke' | 'point' | 'smart';

interface EraserSettings {
  mode: EraserMode;
  size: number;      // 0..100 → eraser radius in world px
  strength: number;  // 0..100 → smart erase aggressiveness
}

// ============================================================
//  InputSnapshot — Single Input Snapshot Model (SIM)
//  每次 pointer event 冻结一个不可变快照作为"唯一真相"
//  Tool / Engine / Render 都不再实时读 camera / viewport
// ============================================================

interface InputSnapshot {
  /** Pointer state (screen-space + pre-computed world-space) */
  pointer: {
    screenX: number;
    screenY: number;
    worldX: number;
    worldY: number;
    pressure: number;
    pointerId: number;
    type: 'down' | 'move' | 'up';
  };
  /** Frozen camera state at the moment of the event */
  camera: {
    x: number;
    y: number;
    zoom: number;
  };
  /** Active tool state at the moment of the event */
  tool: {
    id: Tool;
    settings: HandwritingParams | EraserSettings;
  };
  /** Monotonic timestamp (performance.now()) */
  timestamp: number;
}

// ============================================================
//  InputSnapshotController — captures frozen snapshot from DOM event
// ============================================================

class InputSnapshotController {
  /**
   * Capture a frozen InputSnapshot from a PointerEvent.
   * All state (camera, tool, coords) is copied — never references live objects.
   */
  capture(ev: PointerEvent, session: CanvasSession): InputSnapshot {
    const rect = session.canvasEl.getBoundingClientRect();
    const sx = ev.clientX - rect.left;
    const sy = ev.clientY - rect.top;
    const c = session.viewport.camera;

    // Pre-compute world coordinates using frozen camera
    const worldX = (sx - c.x) / c.zoom;
    const worldY = (sy - c.y) / c.zoom;

    // Determine pointer type
    let pType: 'down' | 'move' | 'up';
    switch (ev.type) {
      case 'pointerdown': pType = 'down'; break;
      case 'pointermove': pType = 'move'; break;
      case 'pointerup':   pType = 'up';   break;
      default:            pType = 'move'; break;
    }

    // Deep-copy tool settings to prevent mutation
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
        type: pType,
      },
      camera: { x: c.x, y: c.y, zoom: c.zoom },
      tool: { id: activeTool.id, settings: settingsCopy },
      timestamp: performance.now(),
    };
  }

  /** Extract world point from a snapshot (convenience). */
  getWorldPoint(snapshot: InputSnapshot): { x: number; y: number } {
    return { x: snapshot.pointer.worldX, y: snapshot.pointer.worldY };
  }
}

// ============================================================
//  ITool — unified tool interface (Step 9: InputSnapshot)
// ============================================================

interface ITool {
  readonly id: Tool;
  settings: HandwritingParams | EraserSettings;
  onPointerDown(snapshot: InputSnapshot, session: CanvasSession): void;
  onPointerMove(snapshot: InputSnapshot, session: CanvasSession): void;
  onPointerUp(snapshot: InputSnapshot, session: CanvasSession): void;
}

// ============================================================
//  PenTool — wraps existing pen logic, zero behavior change
// ============================================================

class PenTool implements ITool {
  readonly id: Tool = 'pen';
  settings: HandwritingParams = CanvasPolicy.getDefaults();

  onPointerDown(snapshot: InputSnapshot, session: CanvasSession): void {
    const pt = { x: snapshot.pointer.worldX, y: snapshot.pointer.worldY };
    session.engine.startStroke(pt, snapshot.pointer.pointerId, (id) => session.canvasEl.setPointerCapture(id));
  }

  onPointerMove(snapshot: InputSnapshot, session: CanvasSession): void {
    if (!session.engine.drawing) return;
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

  onPointerUp(_snapshot: InputSnapshot, session: CanvasSession): void {
    if (!session.engine.drawing) return;
    const strokeId = session.engine.currentStrokeId;
    session.engine.endStroke();
    if (strokeId) {
      session.markDirty(strokeId);
    } else {
      session.markDirty();
    }
  }
}

// ============================================================
//  EraserTool — 3 modes: Stroke / Point / Smart
//  Operates on engine.strokes directly, never touches render pipeline
// ============================================================

class EraserTool implements ITool {
  readonly id: Tool = 'eraser';
  settings: EraserSettings = { mode: 'point', size: 50, strength: 50 };
  private isErasing = false;
  private lastErasePt: { x: number; y: number } | null = null;

  private resolveRadius(): number {
    return 5 + (this.settings.size / 100) * 35;
  }

  onPointerDown(snapshot: InputSnapshot, session: CanvasSession): void {
    const pt = { x: snapshot.pointer.worldX, y: snapshot.pointer.worldY };
    this.isErasing = true;
    this.lastErasePt = pt;
    this.executeErase(pt, session);
  }

  onPointerMove(snapshot: InputSnapshot, session: CanvasSession): void {
    if (!this.isErasing) return;
    const pt = { x: snapshot.pointer.worldX, y: snapshot.pointer.worldY };

    // Distance-based throttle: erase when pointer moves > half radius from last erase
    const minDist = this.resolveRadius() * 0.5;
    if (this.lastErasePt && Math.hypot(pt.x - this.lastErasePt.x, pt.y - this.lastErasePt.y) < minDist) {
      return;
    }
    this.lastErasePt = pt;
    this.executeErase(pt, session);
  }

  onPointerUp(_snapshot: InputSnapshot, session: CanvasSession): void {
    if (!this.isErasing) return;
    this.isErasing = false;
    this.lastErasePt = null;
    session.engine.commit();
    session.requestFullRebuild(); // Erase may split strokes → full rebuild
    session.markDirty();
  }

  /** Execute erase AND trigger immediate re-render for real-time feedback */
  private executeErase(pt: { x: number; y: number }, session: CanvasSession): void {
    const engine = session.engine;
    const radius = this.resolveRadius();

    switch (this.settings.mode) {
      case 'stroke':
        this.eraseStroke(pt, engine, radius);
        break;
      case 'point':
        this.erasePoints(pt, engine, radius);
        break;
      case 'smart':
        this.eraseSmart(pt, engine, radius);
        break;
    }

    // 🔑 Real-time render: erase modifies strokes → full rebuild for correctness
    session.requestFullRebuild();
    session.markDirty();
  }

  /** Stroke Eraser: delete entire stroke if any point within radius */
  private eraseStroke(pt: { x: number; y: number }, engine: CanvasRuntimeEngine, radius: number): void {
    for (let i = engine.strokes.length - 1; i >= 0; i--) {
      const s = engine.strokes[i];
      if (!s?.points) continue;
      if (engine.hitTestStroke(s, pt, radius)) {
        engine.removeStroke(s.id);
        return; // One stroke per pointer event
      }
    }
  }

  /** Point Eraser: remove individual points within radius, split stroke if needed */
  private erasePoints(pt: { x: number; y: number }, engine: CanvasRuntimeEngine, radius: number): void {
    const toRemove: { strokeIdx: number; pointIndices: number[] }[] = [];

    for (let si = engine.strokes.length - 1; si >= 0; si--) {
      const s = engine.strokes[si];
      if (!s?.points) continue;
      const indices: number[] = [];
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
  private eraseSmart(pt: { x: number; y: number }, engine: CanvasRuntimeEngine, radius: number): void {
    const aggressiveness = this.settings.strength / 100;
    const smartRadius = radius * (0.5 + aggressiveness * 1.5); // 0.5x..2x

    for (let si = engine.strokes.length - 1; si >= 0; si--) {
      const s = engine.strokes[si];
      if (!s?.points || s.points.length < 2) continue;

      // Find consecutive segments within smartRadius
      const hitPoints: boolean[] = s.points.map(p => Math.hypot(p.x - pt.x, p.y - pt.y) < smartRadius);

      // Remove hit points
      const toRemove: number[] = [];
      for (let pi = 0; pi < hitPoints.length; pi++) {
        if (hitPoints[pi]) toRemove.push(pi);
      }

      if (toRemove.length > 0) {
        engine.erasePointsFromStroke(si, toRemove);
        return; // One stroke per event for smart mode
      }
    }
  }
}

// ============================================================
//  HandTool — Pan（拖动画布）
//  Camera System: 直接修改 camera.x / camera.y
//  不影响 stroke 数据，不影响 CanvasSession 结构
// ============================================================

class HandTool implements ITool {
  readonly id: Tool = 'hand';
  settings: HandwritingParams = CanvasPolicy.getDefaults(); // unused

  private lastScreenX = 0;
  private lastScreenY = 0;

  onPointerDown(snapshot: InputSnapshot, session: CanvasSession): void {
    // ① 停止任何运行中的惯性
    session.viewport.inertia.stop();

    // ② 进入拖动状态 — isPanning 是 Viewport 的输入状态标记
    session.viewport.isPanning = true;
    session.viewport.inertia.vx = 0;
    session.viewport.inertia.vy = 0;

    this.lastScreenX = snapshot.pointer.screenX;
    this.lastScreenY = snapshot.pointer.screenY;
    session.canvasEl.setPointerCapture(snapshot.pointer.pointerId);
  }

  onPointerMove(snapshot: InputSnapshot, session: CanvasSession): void {
    if (!session.viewport.isPanning) return;

    const dx = snapshot.pointer.screenX - this.lastScreenX;
    const dy = snapshot.pointer.screenY - this.lastScreenY;
    this.lastScreenX = snapshot.pointer.screenX;
    this.lastScreenY = snapshot.pointer.screenY;

    // 实时拖动 + 记录瞬时速度到 inertia controller
    session.viewport.pan(dx, dy);
    session.viewport.inertia.vx = dx;
    session.viewport.inertia.vy = dy;

    session.syncViewState();
    session.markCameraDirty();
  }

  onPointerUp(_snapshot: InputSnapshot, session: CanvasSession): void {
    session.viewport.isPanning = false;

    // 启动惯性 — driven by unified frame tick, no independent RAF
    session.viewport.inertia.start(
      session.viewport.inertia.vx,
      session.viewport.inertia.vy,
      () => {
        // Apply inertia velocity to camera position each tick
        session.viewport.camera.x += session.viewport.inertia.vx;
        session.viewport.camera.y += session.viewport.inertia.vy;
        session.syncViewState();
        session.markCameraDirty();
      },
    );
  }
}

interface Notebook {
  id: string;
  name: string;
  pages: Page[];
  /** 当前活跃 page ID */
  activePageId: string | null;
  /** 下次新建 page 的自增索引 */
  nextPageIndex: number;
  /** 创建时间 */
  createdAt: string;
  /** 最后修改时间 */
  updatedAt: string;
  lastPageId?: string;
  isPinned?: boolean;
}

/** 旧数据迁移 — 将旧版 Notebook 升级 */
function migrateNotebook(raw: any): Notebook {
  const now = new Date().toISOString();
  return {
    id: raw.id || genId(),
    name: raw.name || 'Untitled',
    pages: (raw.pages || []).map((p: any) => migratePage(p)),
    activePageId: raw.activePageId ?? (raw.pages?.[0]?.id ?? null),
    nextPageIndex: raw.nextPageIndex ?? (raw.pages?.length ?? 0),
    createdAt: raw.createdAt || now,
    updatedAt: raw.updatedAt || now,
    lastPageId: raw.lastPageId,
    isPinned: raw.isPinned,
  };
}

const NOTEBOOK_VIEW_TYPE = 'goodnote-max-notebook-view';
const PAGE_VIEW_TYPE = 'goodnote-max-page-view';
const CANVAS_VIEW_TYPE = 'goodnote-max-canvas-view';

let _idCounter = Date.now();
function genId(): string { return `${++_idCounter}`; }

// ============================================================
//  FileGateway
// ============================================================

class FileGateway {
  private static DIR = 'GoodNoteMax';

  constructor(private app: any) {}

  /** Normalize: strip double-prefix, backslash→slash, ensure single GoodNoteMax/ prefix. */
  private normalizePath(raw: string): string {
    let p = raw.replace(/\\/g, '/');
    // Fix double-prefix: GoodNoteMax/GoodNoteMax/ → GoodNoteMax/
    while (p.startsWith(`${FileGateway.DIR}/${FileGateway.DIR}/`)) {
      p = p.substring(FileGateway.DIR.length + 1);
    }
    // Ensure single prefix
    if (!p.startsWith(`${FileGateway.DIR}/`)) {
      p = `${FileGateway.DIR}/${p.replace(/^\/+/, '')}`;
    }
    return p;
  }

  /** Build a guaranteed-correct path from a bare filename. */
  private buildPath(filename: string): string {
    // Strip any accidental directory prefix from filename
    const bare = filename.replace(/\\/g, '/').split('/').pop() || filename;
    return this.normalizePath(`${FileGateway.DIR}/${bare}`);
  }

  async saveNotebook(notebook: Notebook): Promise<void> {
    const adapter = this.app.vault.adapter;
    if (!(await adapter.exists(FileGateway.DIR))) await this.app.vault.createFolder(FileGateway.DIR);
    const path = this.buildPath(`${notebook.name}.gnnote`);
    await adapter.write(path, JSON.stringify(notebook));
  }

  async loadNotebooks(): Promise<Notebook[]> {
    const adapter = this.app.vault.adapter;
    const dir = FileGateway.DIR;

    try {
      if (!(await adapter.exists(dir))) {
        await this.app.vault.createFolder(dir);
        console.log('[BOOT] GoodNoteMax folder created, no notebooks');
        return [];
      }
    } catch (e) {
      console.warn('[BOOT] adapter.exists failed:', e);
      try { await this.app.vault.createFolder(dir); } catch (_) {}
      return [];
    }

    let list: { files: string[]; folders: string[] };
    try {
      list = await adapter.list(dir);
    } catch (e) {
      console.warn('[BOOT] adapter.list failed:', e);
      return [];
    }

    const gnFiles = list.files.filter((f: string) => f.endsWith('.gnnote') || f.endsWith('.gnote'));
    console.log('[BOOT] gnnote files found:', gnFiles.length);

    const result: Notebook[] = [];
    for (const rawName of gnFiles) {
      const filePath = this.buildPath(rawName);
      try {
        const raw = await adapter.read(filePath);
        const raw_nb = JSON.parse(raw);
        // 旧数据迁移：补全 Page / Notebook 新字段
        const nb = migrateNotebook(raw_nb);
        if (!nb.id) nb.id = genId();
        if (!nb.pages) nb.pages = [];
        result.push(nb);

        // Auto-migrate to id-based filename
        const correctPath = this.buildPath(`${nb.name}.gnnote`);
        if (filePath !== correctPath) {
          try {
            await adapter.write(correctPath, JSON.stringify(nb));
            if (filePath !== correctPath) await adapter.remove(filePath);
            console.log('[BOOT] migrated:', filePath, '→', correctPath);
          } catch (migErr) { console.warn('[BOOT] migration failed:', filePath, migErr); }
        }

        console.log('[BOOT] parsed:', nb.name, '| pages:', nb.pages.length);
      } catch (e) { console.warn('[BOOT] skip invalid:', filePath, e); }
    }

    console.log('[BOOT] notebooks hydrated:', result.length);
    return result;
  }

  async deleteNotebook(notebook: Notebook): Promise<void> {
    const p = this.buildPath(`${notebook.name}.gnnote`);
    try {
      if (await this.app.vault.adapter.exists(p)) await this.app.vault.adapter.remove(p);
    } catch (e) { console.warn('[FileGateway] delete failed:', p, e); }
  }

  async notebookFileExists(notebook: Notebook): Promise<boolean> {
    try { return await this.app.vault.adapter.exists(this.buildPath(`${notebook.name}.gnnote`)); }
    catch { return false; }
  }
}

// ============================================================
//  NotebookModal
// ============================================================

class NotebookModal extends Modal {
  plugin: GoodNoteMaxPlugin;
  constructor(app: any, plugin: GoodNoteMaxPlugin) { super(app); this.plugin = plugin; }
  onOpen() {
    const { contentEl } = this; contentEl.empty();
    contentEl.createEl('h2', { text: 'Create Notebook' });
    let name = '';
    new Setting(contentEl).setName('Notebook name').addText((t) =>
      t.setPlaceholder('Enter notebook name').onChange((v) => { name = v; }));
    new Setting(contentEl)
      .addButton((b) => b.setButtonText('Create').setCta().onClick(async () => {
        try {
          const now = new Date().toISOString();
          await this.plugin.addNotebook({
            id: genId(), name: name || 'Untitled',
            pages: [{
              id: 'page-1', title: 'Page 1', index: 0,
              strokes: [], background: { type: 'blank', color: '#ffffff' },
              createdAt: now, updatedAt: now,
            }],
            activePageId: 'page-1', nextPageIndex: 1,
            createdAt: now, updatedAt: now,
          });
        } catch (e) { console.error(e); } finally { this.close(); }
      }))
      .addButton((b) => b.setButtonText('Cancel').onClick(() => this.close()));
  }
  onClose() { this.contentEl.empty(); }
}

// ============================================================
//  NotebookRenameModal
// ============================================================

class NotebookRenameModal extends Modal {
  plugin: GoodNoteMaxPlugin; nbId: string; cur: string;
  constructor(app: any, p: GoodNoteMaxPlugin, nbId: string, cur: string) { super(app); this.plugin = p; this.nbId = nbId; this.cur = cur; }
  onOpen() {
    const { contentEl } = this; contentEl.empty(); contentEl.createEl('h2', { text: 'Rename Notebook' });
    let v = this.cur;
    new Setting(contentEl).setName('Notebook name').addText((t) => t.setValue(this.cur).onChange((x) => v = x));
    new Setting(contentEl)
      .addButton((b) => b.setButtonText('Rename').setCta().onClick(() => {
        try { this.plugin.renameNotebook(this.nbId, v || this.cur); } catch (e) { console.error(e); } finally { this.close(); }
      }))
      .addButton((b) => b.setButtonText('Cancel').onClick(() => this.close()));
  }
  onClose() { this.contentEl.empty(); }
}

// ============================================================
//  RenameModal
// ============================================================

class RenameModal extends Modal {
  plugin: GoodNoteMaxPlugin; nbId: string; pId: string; cur: string;
  constructor(app: any, p: GoodNoteMaxPlugin, nbId: string, pId: string, cur: string) { super(app); this.plugin = p; this.nbId = nbId; this.pId = pId; this.cur = cur; }
  onOpen() {
    const { contentEl } = this; contentEl.empty(); contentEl.createEl('h2', { text: 'Rename Page' });
    let v = this.cur;
    new Setting(contentEl).setName('Page title').addText((t) => t.setValue(this.cur).onChange((x) => v = x));
    new Setting(contentEl)
      .addButton((b) => b.setButtonText('Rename').setCta().onClick(async () => {
        try { await this.plugin.renamePage(this.nbId, this.pId, v || this.cur); } catch (e) { console.error(e); } finally { this.close(); }
      }))
      .addButton((b) => b.setButtonText('Cancel').onClick(() => this.close()));
  }
  onClose() { this.contentEl.empty(); }
}

// ============================================================
//  NotebookView — left leaf
// ============================================================

class NotebookView extends ItemView {
  plugin: GoodNoteMaxPlugin; listEl!: HTMLElement;
  constructor(leaf: WorkspaceLeaf, plugin: GoodNoteMaxPlugin) { super(leaf); this.plugin = plugin; }
  getViewType(): string { return NOTEBOOK_VIEW_TYPE; }
  getDisplayText(): string { return 'Notebooks'; }
  getIcon(): string { return 'pen-tool'; }

  async onOpen() {
    const c = this.containerEl; c.empty(); c.addClass('goodnote-max-view');
    const h = c.createEl('div', { cls: 'goodnote-header' });
    h.createEl('h4', { text: 'Notebooks' });
    h.createEl('button', { text: '+ Create' }).onclick = () => new NotebookModal(this.plugin.app, this.plugin).open();
    this.listEl = c.createEl('ul');
    this.plugin.on('notebooks-changed', () => this.render());
    this.plugin.on('selection-changed', () => this.render());
    this.render();
  }

  private render() {
    const nbs = this.plugin.getSortedNotebooks();
    const sid = this.plugin.getSelectedNotebook()?.id ?? null;
    this.listEl.empty();
    nbs.forEach((nb) => {
      const li = this.listEl.createEl('li');
      if (nb.id === sid) li.addClass('is-selected');
      li.createSpan({ text: `${nb.isPinned ? '📌' : '📒'} ${nb.name}` });
      li.createEl('button', { text: '🗑' }).onclick = () => this.plugin.deleteNotebook(nb.id);
      li.addEventListener('contextmenu', (ev) => {
        ev.preventDefault();
        new Menu()
          .addItem((i) => i.setTitle(nb.isPinned ? 'Unpin' : 'Pin').setIcon('pin').onClick(() => this.plugin.togglePinNotebook(nb.id)))
          .addItem((i) => i.setTitle('Rename').setIcon('pencil').onClick(() => new NotebookRenameModal(this.plugin.app, this.plugin, nb.id, nb.name).open()))
          .addItem((i) => i.setTitle('Delete').setIcon('trash').onClick(() => this.plugin.deleteNotebook(nb.id)))
          .showAtMouseEvent(ev);
      });
      li.style.cursor = 'pointer';
      li.onclick = () => { new Notice(`📒 ${nb.name}`); this.plugin.ui.selectNotebook(nb.id); };
    });
  }
}

// ============================================================
//  PageView — GoodNotes-style right sidebar page manager
//  单向数据流: AppState → PageUI 渲染
//  UI action → PageManager → AppState 更新
//  禁止: UI 直接操作 canvas / strokes
// ============================================================

type PageViewMode = 'list' | 'thumbnail';

class PageView extends ItemView {
  plugin: GoodNoteMaxPlugin;
  private headerEl!: HTMLElement;
  private listEl!: HTMLElement;
  private footerEl!: HTMLElement;
  private modeBarEl!: HTMLElement;
  private dropdownOpen = false;
  /** UI-only state — 不影响数据层，不传给 PageManager */
  private mode: PageViewMode = 'list';

  constructor(leaf: WorkspaceLeaf, plugin: GoodNoteMaxPlugin) { super(leaf); this.plugin = plugin; }
  getViewType(): string { return PAGE_VIEW_TYPE; }
  getDisplayText(): string { return 'Pages'; }
  getIcon(): string { return 'files'; }

  async onOpen() {
    const c = this.containerEl; c.empty(); c.addClass('goodnote-page-view');

    // ── Header: Notebook name + dropdown toggle ──
    this.headerEl = c.createEl('div', { cls: 'gn-page-header' });
    this.buildHeader();

    // ── Page list ──
    this.listEl = c.createEl('div', { cls: 'gn-page-list' });

    // ── Footer: + New Page ──
    this.footerEl = c.createEl('div', { cls: 'gn-page-footer' });
    this.buildFooter();

    // ── 事件绑定 ──
    this.plugin.on('selection-changed', () => this.render());
    this.plugin.on('notebooks-changed', () => this.render());

    this.render();
  }

  // ==========================================================
  //  Header
  // ==========================================================

  private buildHeader() {
    this.headerEl.empty();

    const nb = this.plugin.getSelectedNotebook();
    const titleText = nb?.name ?? 'No Notebook';

    // ── Row 1: Notebook name + dropdown + count badge ──
    const topRow = this.headerEl.createEl('div', { cls: 'gn-page-header-top' });

    const titleBtn = topRow.createEl('button', { cls: 'gn-page-header-title' });
    titleBtn.createSpan({ text: `📒 ${titleText}` });
    titleBtn.createSpan({ cls: 'gn-page-header-chevron', text: '▾' });

    titleBtn.onclick = (ev: MouseEvent) => {
      ev.stopPropagation();
      this.toggleDropdown();
    };

    if (nb) {
      topRow.createEl('span', { cls: 'gn-page-count-badge', text: `${nb.pages.length}` });
    }

    // ── Row 2: Mode toggle bar (list | thumbnail) ──
    this.modeBarEl = this.headerEl.createEl('div', { cls: 'gn-page-mode-bar' });
    this.buildModeBar();

    // Dropdown menu (rendered inline below header)
    this.renderDropdown();
  }

  /** Build mode toggle buttons — UI-only, no data impact */
  private buildModeBar() {
    this.modeBarEl.empty();

    const modes: { key: PageViewMode; icon: string; label: string }[] = [
      { key: 'list',      icon: '☰', label: 'List' },
      { key: 'thumbnail', icon: '▦', label: 'Thumbnail' },
    ];

    for (const m of modes) {
      const btn = this.modeBarEl.createEl('button', {
        cls: `gn-page-mode-btn${this.mode === m.key ? ' is-active' : ''}`,
        attr: { title: m.label },
      });
      btn.createSpan({ text: m.icon });
      btn.onclick = () => this.setMode(m.key);
    }
  }

  private setMode(mode: PageViewMode) {
    if (this.mode === mode) return;
    this.mode = mode;
    this.buildModeBar();
    this.render(); // 全量重渲染（不改变数据，仅切换投影）
  }

  private toggleDropdown() {
    this.dropdownOpen = !this.dropdownOpen;
    this.renderDropdown();
  }

  private renderDropdown() {
    // Remove old dropdown
    const old = this.headerEl.querySelector('.gn-page-dropdown');
    if (old) old.remove();

    if (!this.dropdownOpen) return;

    const nb = this.plugin.getSelectedNotebook();
    if (!nb) return;

    const menu = this.headerEl.createEl('div', { cls: 'gn-page-dropdown' });

    // ── Menu items ──
    const items: { label: string; icon: string; action: () => void }[] = [
      {
        label: 'New Page',
        icon: '＋',
        action: () => this.handleNewPage(),
      },
      {
        label: 'Rename Notebook',
        icon: '✎',
        action: () => {
          new NotebookRenameModal(this.plugin.app, this.plugin, nb.id, nb.name).open();
          this.dropdownOpen = false;
          this.renderDropdown();
        },
      },
    ];

    for (const item of items) {
      const row = menu.createEl('div', { cls: 'gn-page-dropdown-item' });
      row.createSpan({ cls: 'gn-page-dropdown-icon', text: item.icon });
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

  private buildFooter() {
    this.footerEl.empty();
    const btn = this.footerEl.createEl('button', { cls: 'gn-page-new-btn' });
    btn.createSpan({ text: '＋  New Page' });
    btn.onclick = () => this.handleNewPage();
  }

  // ==========================================================
  //  Page List — 模式分发
  //  同数据，两种投影：list（信息密度） / thumbnail（视觉优先）
  // ==========================================================

  private render() {
    this.buildHeader();
    this.listEl.empty();

    const nb = this.plugin.getSelectedNotebook();
    if (!nb) {
      this.listEl.createEl('div', { cls: 'gn-page-placeholder', text: 'Select a notebook to view pages' });
      return;
    }

    if (nb.pages.length === 0) {
      this.listEl.createEl('div', { cls: 'gn-page-placeholder', text: 'No pages yet. Create one!' });
      return;
    }

    switch (this.mode) {
      case 'list':
        this.renderList(nb);
        break;
      case 'thumbnail':
        this.renderThumbnail(nb);
        break;
    }
  }

  // ── List mode: compact rows, info-dense ──

  private renderList(nb: Notebook) {
    const activeId = nb.activePageId;

    for (const page of nb.pages) {
      const card = this.listEl.createEl('div', {
        cls: `gn-page-card${page.id === activeId ? ' is-active' : ''}`,
      });

      // Thumbnail area
      const thumb = card.createEl('div', { cls: 'gn-page-thumb' });
      if (page.thumbnail) {
        const img = thumb.createEl('img', { cls: 'gn-page-thumb-img' }) as HTMLImageElement;
        img.src = page.thumbnail;
      } else {
        thumb.createSpan({ cls: 'gn-page-thumb-placeholder', text: '📝' });
        if (page.strokes && page.strokes.length > 0) {
          thumb.createEl('span', { cls: 'gn-page-stroke-hint', text: `${page.strokes.length}` });
        }
      }

      // Page info
      const info = card.createEl('div', { cls: 'gn-page-info' });
      info.createSpan({ cls: 'gn-page-title', text: page.title });
      info.createSpan({ cls: 'gn-page-meta', text: this.formatDate(page.updatedAt) });

      card.onclick = () => this.handlePageClick(nb.id, page.id);

      card.addEventListener('contextmenu', (ev) => {
        ev.preventDefault();
        new Menu()
          .addItem((it) => it.setTitle('Rename').setIcon('pencil').onClick(() =>
            new RenameModal(this.plugin.app, this.plugin, nb.id, page.id, page.title).open()))
          .addItem((it) => it.setTitle('Delete').setIcon('trash').onClick(() =>
            this.handleDeletePage(nb.id, page.id)))
          .showAtMouseEvent(ev);
      });
    }
  }

  // ── Thumbnail mode: grid cards, visual-first ──

  private renderThumbnail(nb: Notebook) {
    const activeId = nb.activePageId;
    this.listEl.addClass('gn-page-list-thumb');

    for (const page of nb.pages) {
      const isActive = page.id === activeId;
      const card = this.listEl.createEl('div', {
        cls: `gn-page-thumb-card${isActive ? ' is-active' : ''}`,
      });

      // ── Preview area ──
      const preview = card.createEl('div', { cls: 'gn-page-thumb-preview' });

      // 🔵 Page Identity badge — 左上角页码，始终可见
      preview.createEl('span', {
        cls: 'gn-thumb-badge',
        text: `Page ${page.index + 1}`,
      });

      if (page.thumbnail) {
        const img = preview.createEl('img', { cls: 'gn-page-thumb-preview-img' }) as HTMLImageElement;
        img.src = page.thumbnail;
      } else {
        preview.createSpan({ cls: 'gn-page-thumb-preview-icon', text: '📝' });
        if (page.strokes && page.strokes.length > 0) {
          preview.createEl('span', { cls: 'gn-page-thumb-stroke-badge', text: `${page.strokes.length}` });
        }
      }

      // ── Time meta — 弱化时间信息 ──
      card.createSpan({ cls: 'gn-thumb-meta', text: this.formatDate(page.updatedAt) });

      // ── Page title ──
      card.createSpan({ cls: 'gn-page-thumb-title', text: page.title });

      card.onclick = () => this.handlePageClick(nb.id, page.id);

      card.addEventListener('contextmenu', (ev) => {
        ev.preventDefault();
        new Menu()
          .addItem((it) => it.setTitle('Rename').setIcon('pencil').onClick(() =>
            new RenameModal(this.plugin.app, this.plugin, nb.id, page.id, page.title).open()))
          .addItem((it) => it.setTitle('Delete').setIcon('trash').onClick(() =>
            this.handleDeletePage(nb.id, page.id)))
          .showAtMouseEvent(ev);
      });
    }
  }

  // ==========================================================
  //  Actions (delegate to PageManager)
  // ==========================================================

  private handlePageClick(notebookId: string, pageId: string) {
    // 单向数据流: UI → PageManager → AppState → render
    this.plugin.ui.openCanvas(notebookId, pageId);
  }

  private handleNewPage() {
    const nb = this.plugin.getSelectedNotebook();
    if (!nb) return;
    this.plugin.pageManager.createPage(nb.id);
    // createPage 内部自动 switchPage + emit('notebooks-changed') → 触发 render
  }

  private handleDeletePage(notebookId: string, pageId: string) {
    // PageManager.deletePage 自动处理 activePage 切换
    this.plugin.pageManager.deletePage(notebookId, pageId);
  }

  // ==========================================================
  //  Helpers
  // ==========================================================

  private formatDate(iso: string): string {
    if (!iso) return '';
    const d = new Date(iso);
    const now = new Date();
    const diffMs = now.getTime() - d.getTime();
    const diffMin = Math.floor(diffMs / 60000);
    if (diffMin < 1) return 'Just now';
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return `${diffHr}h ago`;
    const diffDay = Math.floor(diffHr / 24);
    if (diffDay < 7) return `${diffDay}d ago`;
    return d.toLocaleDateString();
  }
}

// ============================================================
//  CanvasLayoutManager — decouples Canvas from leaf/layout
// ============================================================

type CanvasLayoutMode = 'main'; // future: 'split' | 'fullscreen' | 'floating'

class CanvasLayoutManager {
  constructor(private app: any, private plugin: GoodNoteMaxPlugin) {}

  async mountCanvas(notebookId: string, pageId: string, _mode: CanvasLayoutMode = 'main'): Promise<CanvasView> {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(CANVAS_VIEW_TYPE)[0];
    if (!leaf) {
      leaf = workspace.getLeaf(false);
      await leaf.setViewState({ type: CANVAS_VIEW_TYPE, active: true });
    } else {
      workspace.revealLeaf(leaf);
    }
    const view = leaf.view as CanvasView;
    view.createSession(notebookId, pageId);
    return view;
  }

  getActiveCanvas(): CanvasView | null {
    const leaf = this.app.workspace.getLeavesOfType(CANVAS_VIEW_TYPE)[0];
    return leaf ? (leaf.view as CanvasView) : null;
  }
}

// ============================================================
//  PageManager — 集中管理所有 page 操作
//  Page = 唯一数据源，CanvasSession = 渲染器
// ============================================================

class PageManager {
  constructor(private plugin: GoodNoteMaxPlugin) {}

  // ============ 内部辅助 ============

  private getNotebook(notebookId: string): Notebook | undefined {
    return this.plugin.getNotebooks().find(n => n.id === notebookId);
  }

  private async saveNotebook(nb: Notebook): Promise<void> {
    await this.plugin.fileGateway.saveNotebook(nb);
    this.plugin.emit('notebooks-changed');
  }

  // ============ CRUD ============

  /**
   * 创建新 page 并自动设为 active。渲染由 Plugin.requestPageChange 调度。
   */
  createPage(notebookId: string, title?: string): Page | null {
    const nb = this.getNotebook(notebookId);
    if (!nb) return null;

    const now = new Date().toISOString();
    const page: Page = {
      id: genId(),
      title: title || `Page ${nb.nextPageIndex + 1}`,
      index: nb.nextPageIndex,
      strokes: [],
      background: { type: 'blank', color: '#ffffff' },
      createdAt: now,
      updatedAt: now,
    };

    nb.pages.push(page);
    nb.nextPageIndex++;
    nb.activePageId = page.id;
    nb.updatedAt = now;

    // 通过 Plugin 调度（不直接操作 CanvasSession）
    this.plugin.requestPageChange(notebookId, page.id);

    this.saveNotebook(nb);
    return page;
  }

  /**
   * 删除 page。如果删除的是 activePage，自动切换到相邻 page。
   */
  deletePage(notebookId: string, pageId: string): boolean {
    const nb = this.getNotebook(notebookId);
    if (!nb) return false;

    const idx = nb.pages.findIndex(p => p.id === pageId);
    if (idx === -1) return false;

    const isActive = nb.activePageId === pageId;

    // 删除
    nb.pages.splice(idx, 1);

    // 重新计算 index
    nb.pages.forEach((p, i) => { p.index = i; });
    nb.nextPageIndex = nb.pages.length;
    nb.updatedAt = new Date().toISOString();

    // 如果删除的是 activePage，切换到相邻 page（通过 Plugin 调度）
    if (isActive) {
      const adjacent = nb.pages[Math.min(idx, nb.pages.length - 1)];
      nb.activePageId = adjacent?.id ?? null;

      if (adjacent) {
        this.plugin.requestPageChange(notebookId, adjacent.id);
      } else {
        // 没有 page 了 — 请求清空 canvas
        this.plugin.requestPageChange(notebookId, '');
      }
    }

    this.saveNotebook(nb);
    return true;
  }

  /**
   * 切换 active page。渲染由 Plugin.requestPageChange 调度。
   */
  switchPage(notebookId: string, pageId: string): boolean {
    const nb = this.getNotebook(notebookId);
    if (!nb) return false;

    const page = nb.pages.find(p => p.id === pageId);
    if (!page) return false;

    nb.activePageId = pageId;

    // 通过 Plugin 调度（不直接操作 CanvasSession）
    this.plugin.requestPageChange(notebookId, pageId);

    return true;
  }

  /**
   * 更新 page 元数据（title / background），不影响 strokes。
   */
  updatePage(notebookId: string, pageId: string, patch: Partial<Pick<Page, 'title' | 'background' | 'thumbnail'>>): boolean {
    const nb = this.getNotebook(notebookId);
    if (!nb) return false;

    const page = nb.pages.find(p => p.id === pageId);
    if (!page) return false;

    if (patch.title !== undefined) page.title = patch.title;
    if (patch.background !== undefined) page.background = patch.background;
    if (patch.thumbnail !== undefined) page.thumbnail = patch.thumbnail;
    page.updatedAt = new Date().toISOString();
    nb.updatedAt = page.updatedAt;

    this.saveNotebook(nb);
    return true;
  }

  /**
   * 直接用新的 strokes 数组更新 page 数据。
   * 如果是当前活跃 page，通过 Plugin 调度重绘。
   */
  updatePageData(notebookId: string, pageId: string, strokes: Stroke[]): boolean {
    const nb = this.getNotebook(notebookId);
    if (!nb) return false;

    const page = nb.pages.find(p => p.id === pageId);
    if (!page) return false;

    page.strokes = strokes;
    page.updatedAt = new Date().toISOString();
    nb.updatedAt = page.updatedAt;

    // 如果是当前活跃 page，通过 Plugin 调度重绘
    if (nb.activePageId === pageId) {
      this.plugin.requestPageChange(notebookId, pageId);
    }

    this.saveNotebook(nb);
    return true;
  }

  // ============ 排序 ============

  /** 移动 page 到指定 index */
  movePage(notebookId: string, pageId: string, targetIndex: number): boolean {
    const nb = this.getNotebook(notebookId);
    if (!nb) return false;

    const idx = nb.pages.findIndex(p => p.id === pageId);
    if (idx === -1) return false;

    const [page] = nb.pages.splice(idx, 1);
    nb.pages.splice(targetIndex, 0, page);
    nb.pages.forEach((p, i) => { p.index = i; });
    nb.updatedAt = new Date().toISOString();

    this.saveNotebook(nb);
    return true;
  }

  /** 深拷贝 page（新 ID + 深拷贝 strokes） */
  duplicatePage(notebookId: string, pageId: string): Page | null {
    const nb = this.getNotebook(notebookId);
    if (!nb) return null;

    const src = nb.pages.find(p => p.id === pageId);
    if (!src) return null;

    const now = new Date().toISOString();
    const copy: Page = {
      ...src,
      id: genId(),
      title: `${src.title} (copy)`,
      index: nb.pages.length,
      strokes: src.strokes.map(s => ({ ...s, id: genId(), points: s.points.map(p => ({ ...p })) })),
      createdAt: now,
      updatedAt: now,
      thumbnail: undefined,
    };

    nb.pages.push(copy);
    nb.nextPageIndex = nb.pages.length;
    nb.updatedAt = now;

    this.saveNotebook(nb);

    // 自动切换到新页面
    this.switchPage(notebookId, copy.id);

    return copy;
  }

  // ============ 查询 ============

  getActivePage(notebookId: string): Page | null {
    const nb = this.getNotebook(notebookId);
    if (!nb || !nb.activePageId) return null;
    return nb.pages.find(p => p.id === nb.activePageId) ?? null;
  }

  getPages(notebookId: string): Page[] {
    return this.getNotebook(notebookId)?.pages ?? [];
  }

  getStrokeCount(notebookId: string, pageId: string): number {
    const nb = this.getNotebook(notebookId);
    const page = nb?.pages.find(p => p.id === pageId);
    return page?.strokes?.length ?? 0;
  }

  // ============ 缩略图 ============

  generateThumbnail(notebookId: string, pageId: string): string | null {
    const canvas = this.plugin.layoutManager?.getActiveCanvas();
    if (!canvas?.session?.isAlive()) return null;

    const session = canvas.session;
    // 如果不是目标 page，先通过 Plugin 调度切换
    if (session.pageId !== pageId) {
      const nb = this.getNotebook(notebookId);
      const page = nb?.pages.find(p => p.id === pageId);
      if (page) {
        session.loadPage(notebookId, page);
      }
    }

    try {
      return session.canvasEl.toDataURL('image/png', 0.5);
    } catch {
      return null;
    }
  }
}

// ============================================================
//  Phase 2-A: CanvasPolicy — 笔感参数集中管理
// ============================================================

class CanvasPolicy {
  static getDefaults(): HandwritingParams {
    return {
      spacing: 3, smoothness: 0.5, strokeWidth: 2, cornerKeep: 0.3,
      dynamicInk: { enabled: true, strength: 0.25, minWidth: 0.6, maxWidth: 1.8 },
    };
  }

  static clampStrokeWidth(w: number): number {
    return Math.max(CANVAS_CONSTANTS.MIN_STROKE_WIDTH, Math.min(CANVAS_CONSTANTS.MAX_STROKE_WIDTH, w));
  }

  static normalizeSpeed(speed: number): number {
    return Math.min(1, speed / CANVAS_CONSTANTS.SPEED_NORMALIZATION);
  }
}

// ============================================================
//  CanvasRuntimeEngine — pure logic, no UI dependency
// ============================================================

let _engineIdCounter = 0;

class CanvasRuntimeEngine {
  readonly id = ++_engineIdCounter;
  private notebookId = '';
  private pageId = '';
  strokes: Stroke[] = [];
  mode: InkMode = 'raw';
  private isDrawing = false;
  private currentStroke: Stroke | null = null;
  private commitTimer: number | null = null;
  private lastRecordedPoint: { x: number; y: number } | null = null;
  params: HandwritingParams = CanvasPolicy.getDefaults();

  // ============================================================
  //  Event System — lightweight pub/sub, zero external deps
  // ============================================================

  private _listeners = new Map<string, Array<(...args: any[]) => void>>();

  /** Subscribe to an engine event. Returns unsubscribe function. */
  on(event: string, fn: (...args: any[]) => void): () => void {
    if (!this._listeners.has(event)) this._listeners.set(event, []);
    this._listeners.get(event)!.push(fn);
    return () => this.off(event, fn);
  }

  /** Unsubscribe a specific handler from an event. */
  off(event: string, fn: (...args: any[]) => void): void {
    const arr = this._listeners.get(event);
    if (!arr) return;
    const idx = arr.indexOf(fn);
    if (idx !== -1) arr.splice(idx, 1);
  }

  /** Emit an event with optional payload. Engine never knows who listens. */
  private emit(event: string, payload?: any): void {
    const arr = this._listeners.get(event);
    if (!arr) return;
    for (const fn of arr) fn(payload);
  }

  // ============================================================

  constructor() {}

  get drawing(): boolean { return this.isDrawing; }

  /** Current stroke ID — for dirty tracking by Tool layer. */
  get currentStrokeId(): string | null { return this.currentStroke?.id ?? null; }

  /** Last added point — for computing dirty region bounds. */
  get lastPoint(): { x: number; y: number } | null {
    if (!this.currentStroke?.points?.length) return null;
    const pts = this.currentStroke.points;
    return pts[pts.length - 1];
  }

  /**
   * 加载 page 数据 — 幂等可重复调用，返回是否成功。
   * 调用方负责提供 strokes 数据；Engine 不查询 Plugin/Notebook。
   */
  load(notebookId: string, pageId: string, strokes: Stroke[]): boolean {
    // 幂等：相同 page 不重复加载
    if (this.notebookId === notebookId && this.pageId === pageId) return true;

    // ① 先提交当前脏数据
    this.commitNow();

    // ② 确保 strokes 数组存在
    const safe = (strokes && Array.isArray(strokes)) ? strokes : [];

    this.notebookId = notebookId;
    this.pageId = pageId;

    // ③ 直接引用（非深拷贝）— Page 是唯一数据源
    this.strokes = safe;
    this.isDrawing = false;
    this.currentStroke = null;

    return true;
  }

  setParams(p: Partial<HandwritingParams>) {
    Object.assign(this.params, p);
  }

  setMode(mode: InkMode) {
    this.mode = mode;
  }

  startStroke(pt: { x: number; y: number }, pointerId: number, setCapture: (id: number) => void) {
    // Task 6: NaN guard — prevent corrupted data
    if (!Number.isFinite(pt.x) || !Number.isFinite(pt.y)) {
      console.warn('[ENGINE] startStroke blocked — non-finite coords', pt);
      return;
    }
    this.isDrawing = true;
    const p0 = { x: pt.x, y: pt.y, t: performance.now(), speed: 0 };
    this.currentStroke = {
      id: genId(),
      points: [p0],
      color: '#000000',
      width: this.params.strokeWidth,
      _penParams: {
        spacing: this.params.spacing,
        smoothness: this.params.smoothness,
        strokeWidth: this.params.strokeWidth,
        cornerKeep: this.params.cornerKeep,
      },
      debug: { pointCount: 1, resampleCount: 0, droppedPoints: 0, avgSpeed: 0 },
      penState: { lastSpeed: 0, smoothedSpeed: 0, lastWidth: this.params.strokeWidth },
    };
    this.strokes.push(this.currentStroke);
    setCapture(pointerId);
  }

  addPoint(pt: { x: number; y: number }) {
    if (!this.isDrawing || !this.currentStroke) return;
    // Task 6: NaN guard
    if (!Number.isFinite(pt.x) || !Number.isFinite(pt.y)) {
      console.warn('[ENGINE] addPoint blocked — non-finite coords', pt);
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
      // debug: 记录被 spacing 丢弃的点
      if (this.currentStroke.debug) {
        this.currentStroke.debug.droppedPoints++;
      }
      return;
    }

    const count = Math.floor(dist / this.params.spacing);
    // debug: 记录进入插值循环的 resample 数量
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
        speed: prev.speed ?? 0,
      });
      // debug: 记录插值生成的新点
      if (this.currentStroke.debug) {
        this.currentStroke.debug.pointCount++;
      }
    }

    // debug: speed 统计（仅记录，不参与任何计算）
    if (this.currentStroke.debug && (pt as any).speed != null) {
      this.currentStroke.debug.avgSpeed =
        (this.currentStroke.debug.avgSpeed + (pt as any).speed) * 0.5;
    }

    if (count > 0) {
      this.lastRecordedPoint = { x: cx, y: cy };
    }

    // penState: 更新速度感知（不改 points，只记录感知状态）
    if (this.currentStroke.penState) {
      const prev = points[points.length - 1];
      const dx = pt.x - prev.x;
      const dy = pt.y - prev.y;
      const dist = Math.hypot(dx, dy);
      const dt = Math.max(1, ((pt as any).t ?? 0) - (prev.t ?? (pt as any).t ?? 0));
      const rawSpeed = dist / dt;
      const ps = this.currentStroke.penState;
      ps.lastSpeed = rawSpeed;
      ps.smoothedSpeed = this.smoothSpeed(ps.smoothedSpeed, rawSpeed);
    }
  }

  private smoothSpeed(prev: number, current: number): number {
    const alpha = 0.25; // 越小越稳，越大越敏感
    return prev * (1 - alpha) + current * alpha;
  }

  endStroke() {
    if (!this.isDrawing) return;
    this.isDrawing = false;
    const stroke = this.currentStroke;
    if (stroke) {
      stroke.quality = this.analyzeStroke(stroke.points);
    }
    this.currentStroke = null;
    this.commit();
  }

  private analyzeStroke(points: { x: number; y: number }[]): StrokeQuality {
    if (points.length < 2) {
      return { smoothness: 1, jitter: 0, density: 1, curvature: 0, overall: 1 };
    }
    let jitter = 0;
    let curvature = 0;
    const distances: number[] = [];
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
    const density = Math.max(0, Math.min(1, 1 / (avg + 0.001)));
    const normCurvature = Math.min(1, curvature / CANVAS_CONSTANTS.CURVATURE_NORMALIZATION);
    const overall = smoothness * 0.4 + density * 0.2 + (1 - normCurvature) * 0.4;
    return { smoothness, jitter, density, curvature: normCurvature, overall };
  }

  // ============================================================
  //  Eraser support — public API for ToolSystem
  // ============================================================

  /** Hit-test: does any point in stroke fall within radius of pt? */
  hitTestStroke(stroke: Stroke, pt: { x: number; y: number }, radius: number = CANVAS_CONSTANTS.ERASER_RADIUS): boolean {
    if (!stroke?.points) return false;
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
  erasePointsFromStroke(strokeIdx: number, pointIndices: number[]): void {
    if (strokeIdx < 0 || strokeIdx >= this.strokes.length) return;
    const stroke = this.strokes[strokeIdx];
    if (!stroke?.points) return;

    // Sort indices descending for safe removal
    const sorted = [...pointIndices].sort((a, b) => b - a);
    const removeSet = new Set(sorted);

    // Find contiguous segments (gaps in removal)
    const segments: { x: number; y: number; t?: number; speed?: number }[][] = [];
    let current: typeof segments[0] = [];

    for (let i = 0; i < stroke.points.length; i++) {
      if (removeSet.has(i)) {
        if (current.length >= 2) segments.push(current);
        current = [];
      } else {
        current.push({ ...stroke.points[i] });
      }
    }
    if (current.length >= 2) segments.push(current);

    if (segments.length === 0) {
      // All points removed — delete entire stroke
      this.strokes.splice(strokeIdx, 1);
      return;
    }

    if (segments.length === 1 && segments[0].length === stroke.points.length) {
      // No points removed — no-op
      return;
    }

    // Replace original stroke with first segment
    stroke.points = segments[0];

    // Create additional strokes for remaining segments
    for (let si = 1; si < segments.length; si++) {
      const newStroke: Stroke = {
        id: genId(),
        points: segments[si],
        color: stroke.color,
        width: stroke.width,
        _penParams: stroke._penParams ? { ...stroke._penParams } : undefined,
      };
      this.strokes.splice(strokeIdx + si, 0, newStroke);
    }
  }

  // ============================================================
  //  Public Stroke CRUD API — sole write path to strokes[]
  //  Tool layer MUST use these; NEVER touch engine.strokes directly
  // ============================================================

  /** Remove a stroke by its ID. Returns true if found and removed. */
  removeStroke(strokeId: string): boolean {
    const idx = this.strokes.findIndex(s => s.id === strokeId);
    if (idx === -1) return false;
    this.strokes.splice(idx, 1);
    return true;
  }

  /** Add a fully-constructed stroke (for external injection, e.g. paste / import). */
  addStroke(stroke: Stroke): void {
    this.strokes.push(stroke);
  }

  /** Update an existing stroke's metadata (color, width, etc.) by ID. Does NOT touch points. */
  updateStroke(strokeId: string, patch: Partial<Pick<Stroke, 'color' | 'width'>>): boolean {
    const stroke = this.strokes.find(s => s.id === strokeId);
    if (!stroke) return false;
    Object.assign(stroke, patch);
    return true;
  }

  /** 同步提交 — emit commit event（用于切页前 flush） */
  commitNow(): void {
    if (this.commitTimer) {
      clearTimeout(this.commitTimer);
      this.commitTimer = null;
    }
    this.emitCommit();
  }

  /** 异步提交 — debounce 80ms（正常绘制路径） */
  commit() {
    if (this.commitTimer) clearTimeout(this.commitTimer);
    this.commitTimer = window.setTimeout(() => this.emitCommit(), 80);
  }

  /** Fire commit event with current state. Subscribers handle persistence. */
  private emitCommit(): void {
    this.emit('commit', {
      notebookId: this.notebookId,
      pageId: this.pageId,
      strokes: this.strokes,
    });
  }

  reset() {
    if (this.commitTimer) clearTimeout(this.commitTimer);
    this.notebookId = '';
    this.pageId = '';
    this.strokes = [];
    this.isDrawing = false;
    this.currentStroke = null;
  }

  detach() {
    if (this.commitTimer) clearTimeout(this.commitTimer);
    this.isDrawing = false;
    this.currentStroke = null;
    // Never clear strokes — data is owned by Page, not Engine.
    // No plugin reference to null — Engine is now pure.
  }
}

// ============================================================
//  Viewport — 唯一坐标转换模块
//  Camera System 升级：screen → camera → world → stroke
//  禁止任何其他地方做坐标转换
// ============================================================

class Viewport {
  /** CSS pixel dimensions — the single source of truth for world space. */
  cssW = 0;
  cssH = 0;
  /** devicePixelRatio — used ONLY in render buffer mapping, never in input math. */
  dpr = 1;

  /** Camera — 唯一视图变换源，只影响显示，不影响数据 */
  camera: Camera = createDefaultCamera();

  /** Interaction guard — true during active pointer drag. Input state, NOT camera state. */
  isPanning = false;

  /** Inertia physics controller — driven by unified frame tick, no independent RAF. */
  inertia = new InertiaController();

  update(cssW: number, cssH: number, dpr: number) {
    this.cssW = cssW;
    this.cssH = cssH;
    this.dpr = dpr;
  }

  /**
   * screen → camera → world
   * screen（canvas-relative pixels）→ world（stroke data space）
   * 公式: world = (screen - camera) / zoom
   */
  screenToWorld(clientX: number, clientY: number, canvasRect: DOMRect): { x: number; y: number } {
    const sx = clientX - canvasRect.left;
    const sy = clientY - canvasRect.top;
    const c = this.camera;
    return {
      x: (sx - c.x) / c.zoom,
      y: (sy - c.y) / c.zoom,
    };
  }

  /**
   * world → screen
   * 公式: screen = world * zoom + camera
   */
  worldToScreen(worldX: number, worldY: number): { x: number; y: number } {
    const c = this.camera;
    return {
      x: worldX * c.zoom + c.x,
      y: worldY * c.zoom + c.y,
    };
  }

  /**
   * Render transform: 应用 camera 到 canvas context
   * 公式: deviceCoord = (worldCoord * zoom + camera) * dpr
   * 用 setTransform 一次性设置，避免累积变换
   */
  applyTransform(ctx: CanvasRenderingContext2D) {
    const c = this.camera;
    ctx.setTransform(
      this.dpr * c.zoom, 0,
      0, this.dpr * c.zoom,
      c.x * this.dpr,
      c.y * this.dpr,
    );
  }

  /**
   * Pan — 拖动画布
   * delta 是 screen-space pixels，直接加到 camera 偏移
   */
  pan(dx: number, dy: number): void {
    this.camera.x += dx;
    this.camera.y += dy;
  }

  // ============================================================
  //  Inertia — driven by unified frame tick (no independent RAF)
  // ============================================================

  /** Get a snapshot of the camera state (for viewState sync). */
  getCameraSnapshot(): { x: number; y: number; zoom: number; vx: number; vy: number } {
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
  zoomAt(anchorScreenX: number, anchorScreenY: number, newZoom: number): void {
    const c = this.camera;
    const oldZoom = c.zoom;
    newZoom = clampZoom(newZoom);

    if (newZoom === oldZoom) return;

    // 计算锚点的 world 坐标（zoom 前）
    const worldX = (anchorScreenX - c.x) / oldZoom;
    const worldY = (anchorScreenY - c.y) / oldZoom;

    // 更新 zoom
    c.zoom = newZoom;

    // 调整 camera offset 使同一 world 点映射到同一 screen 位置
    c.x = anchorScreenX - worldX * newZoom;
    c.y = anchorScreenY - worldY * newZoom;
  }

  /** 重置 camera 到默认状态（含停止惯性） */
  resetCamera(): void {
    this.inertia.stop();
    this.camera = createDefaultCamera();
  }

  /** 获取当前 zoom 级别（方便外部读取） */
  get zoom(): number { return this.camera.zoom; }
}

// ============================================================
//  Phase 2-A: ReplayController — replay state 不污染 Stroke
// ============================================================

class ReplayController {
  private _strokeId: string | null = null;
  private _cursorIndex = 0;
  private _enabled = false;

  get active(): boolean { return this._enabled; }
  get strokeId(): string | null { return this._strokeId; }
  get cursorIndex(): number { return this._cursorIndex; }

  /** Check if a given stroke is the one currently being replayed. */
  isActive(strokeId: string): boolean {
    return this._enabled && this._strokeId === strokeId;
  }

  start(strokeId: string) {
    this._strokeId = strokeId;
    this._cursorIndex = 0;
    this._enabled = true;
  }

  /** Advance cursor by one frame. Returns true if still within stroke bounds. */
  tick(): boolean {
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
}

// ============================================================
//  Render Pipeline — PS级调度系统
//  Stroke → RenderQueue → RenderScheduler → Renderer → Canvas
// ============================================================

/** Pre-computed renderable stroke — Path2D cached, never rebuilt unless points change. */
interface RenderableStroke {
  id: string;
  path2D: Path2D;
  style: { color: string; lineWidth: number; lineCap: CanvasLineCap; lineJoin: CanvasLineJoin };
  /** The stroke points reference this was built from — compared by reference to detect changes. */
  _sourcePoints: { x: number; y: number }[];
  /** For replay: total point count in source stroke */
  _totalPoints: number;
}

// ============================================================
//  StrokeDirtyTracker — 增量脏标记系统
//  O(1) mark / O(k) query（k = dirty strokes）
// ============================================================

class StrokeDirtyTracker {
  private dirtyIds = new Set<string>();

  /** Mark a stroke as dirty — its Path2D needs rebuild. */
  markDirty(strokeId: string): void {
    this.dirtyIds.add(strokeId);
  }

  /** Check if a stroke is dirty. */
  isDirty(strokeId: string): boolean {
    return this.dirtyIds.has(strokeId);
  }

  /** Get all dirty stroke IDs and clear the set. */
  flushDirty(): string[] {
    const ids = Array.from(this.dirtyIds);
    this.dirtyIds.clear();
    return ids;
  }

  /** Check if any stroke is dirty. */
  get hasDirty(): boolean {
    return this.dirtyIds.size > 0;
  }

  /** Mark all strokes as dirty (e.g. page load, camera reset). */
  markAllDirty(strokeIds: string[]): void {
    for (const id of strokeIds) this.dirtyIds.add(id);
  }

  /** Clear all dirty flags without processing. */
  clear(): void {
    this.dirtyIds.clear();
  }
}

// ============================================================
//  StrokeRenderCache — Path2D 永久缓存
//  只有 dirty stroke 才重建；hit-test / 查询不触发 rebuild
// ============================================================

class StrokeRenderCache {
  private cache = new Map<string, Path2D>();

  /** Get cached Path2D, or undefined if not built yet. */
  get(strokeId: string): Path2D | undefined {
    return this.cache.get(strokeId);
  }

  /** Store a Path2D in cache. */
  set(strokeId: string, path2D: Path2D): void {
    this.cache.set(strokeId, path2D);
  }

  /** Invalidate (remove) a stroke's cached Path2D. */
  invalidate(strokeId: string): void {
    this.cache.delete(strokeId);
  }

  /** Clear all cached Path2Ds. */
  clear(): void {
    this.cache.clear();
  }

  /** Number of cached entries. */
  get size(): number {
    return this.cache.size;
  }
}

// ============================================================
//  DirtyRegion helpers — 局部重绘区域追踪与合并
// ============================================================

interface DirtyRegion {
  x: number;
  y: number;
  w: number;
  h: number;
}

function mergeDirtyRegions(a: DirtyRegion | null, b: DirtyRegion): DirtyRegion {
  if (!a) return { ...b };
  const ax2 = a.x + a.w, ay2 = a.y + a.h;
  const bx2 = b.x + b.x + b.w, by2 = b.y + b.h;
  const nx = Math.min(a.x, b.x);
  const ny = Math.min(a.y, b.y);
  return {
    x: nx,
    y: ny,
    w: Math.max(ax2, bx2) - nx,
    h: Math.max(ay2, by2) - ny,
  };
}

/** Compute world-space bounding box from stroke points. */
function computeStrokeBounds(points: { x: number; y: number }[]): DirtyRegion {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}


// ============================================================
//  RenderScheduler — 统一 RAF 入口，合并多次请求为 1 帧
// ============================================================

class RenderScheduler {
  private rafId: number | null = null;
  private _onFrame: (() => void) | null = null;
  private _running = false;

  /** Register the frame callback. Called once per RAF tick. */
  set onFrame(fn: (() => void) | null) { this._onFrame = fn; }

  get running(): boolean { return this._running; }

  /**
   * Request a render. Multiple rapid calls are merged into a single RAF tick.
   * Idempotent — if already pending, this is a no-op.
   */
  requestRender(): void {
    if (this.rafId !== null) return;
    if (!this._running) return;
    this.rafId = requestAnimationFrame(() => {
      this.rafId = null;
      if (!this._running) return;
      this._onFrame?.();
    });
  }

  /** Start the scheduler. Before start(), requestRender() is silently ignored. */
  start(): void {
    this._running = true;
  }

  /** Stop the scheduler and cancel any pending RAF. */
  stop(): void {
    this._running = false;
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }
}

// ============================================================
//  RenderQueue — 收集所有渲染输入，提供 batch render
// ============================================================

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

class RenderQueue {
  renderables: RenderableStroke[] = [];
  /** Camera snapshot at queue-build time */
  camera: { x: number; y: number; zoom: number } = { x: 0, y: 0, zoom: 1 };
  /** Canvas buffer dimensions (cssW/cssH * dpr) */
  bufW = 0;
  bufH = 0;
  /** Accumulated dirty region in world-space (for partial repaint clip). */
  dirtyRegion: DirtyRegion | null = null;
  /** Background color */
  backgroundColor = '#ffffff';
  /** Whether replay is active and which stroke + cursor index */
  replay?: { strokeId: string; cursorIndex: number };

  // ==========================================================
  //  Full rebuild — used for page load / camera reset / resize
  // ==========================================================

  /** Full rebuild of all renderables from scratch. Uses cache for Path2D. */
  fullRebuild(
    strokes: Stroke[],
    params: HandwritingParams,
    cache: StrokeRenderCache,
    replayCtrl: ReplayController | null,
  ): void {
    const newRenderables: RenderableStroke[] = [];

    for (const s of strokes) {
      if (!s?.points || s.points.length === 0) continue;

      if (replayCtrl?.isActive(s.id)) {
        const cursorIdx = replayCtrl.cursorIndex;
        const pts = s.points.slice(0, cursorIdx);
        if (pts.length < 2) continue;
        const path2D = buildPath2D(pts, s._penParams || params);
        cache.set(s.id, path2D);
        newRenderables.push({
          id: s.id, path2D,
          style: buildStyle(s, s._penParams || params),
          _sourcePoints: s.points, _totalPoints: s.points.length,
        });
        continue;
      }

      // Cache hit check
      let path2D = cache.get(s.id);
      if (!path2D) {
        path2D = buildPath2D(s.points, s._penParams || params);
        cache.set(s.id, path2D);
      }
      newRenderables.push({
        id: s.id, path2D,
        style: buildStyle(s, s._penParams || params),
        _sourcePoints: s.points, _totalPoints: s.points.length,
      });
    }

    this.renderables = newRenderables;
    this.dirtyRegion = null; // full redraw — no clip needed
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
  updateDirty(
    dirtyIds: string[],
    strokes: Stroke[],
    params: HandwritingParams,
    cache: StrokeRenderCache,
  ): void {
    if (dirtyIds.length === 0) return;

    // Build quick lookup: strokeId → index
    const indexMap = new Map<string, number>();
    for (let i = 0; i < strokes.length; i++) {
      indexMap.set(strokes[i].id, i);
    }

    for (const id of dirtyIds) {
      const idx = indexMap.get(id);
      if (idx === undefined) {
        // Stroke was removed — invalidate cache
        cache.invalidate(id);
        continue;
      }

      const s = strokes[idx];
      if (!s?.points || s.points.length === 0) continue;

      // Rebuild Path2D and update cache
      const pp = s._penParams || params;
      const path2D = buildPath2D(s.points, pp);
      cache.set(s.id, path2D);

      // Update renderable in-place or create new
      while (this.renderables.length <= idx) {
        this.renderables.push(null as any);
      }
      this.renderables[idx] = {
        id: s.id, path2D,
        style: buildStyle(s, pp),
        _sourcePoints: s.points, _totalPoints: s.points.length,
      };
    }
  }

  // ==========================================================
  //  Dirty region management
  // ==========================================================

  /** Merge a new dirty region (world-space) into the accumulated region. */
  mergeDirtyRegion(region: DirtyRegion): void {
    this.dirtyRegion = mergeDirtyRegions(this.dirtyRegion, region);
  }

  /** Get the accumulated dirty region, or null if none. */
  getDirtyRegion(): DirtyRegion | null {
    return this.dirtyRegion;
  }

  /** Clear the accumulated dirty region. */
  clearDirtyRegion(): void {
    this.dirtyRegion = null;
  }

  /** Clear all cached renderables. */
  clear(): void {
    this.renderables = [];
    this.dirtyRegion = null;
  }
}

// ============================================================
//  Pure functions for Path2D building & style creation
// ============================================================

function buildPath2D(
  points: { x: number; y: number }[],
  p: { spacing: number; smoothness: number; strokeWidth: number; cornerKeep: number },
): Path2D {
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
      points[i].x, points[i].y,
      points[i].x + (points[i + 1].x - points[i].x) * t,
      points[i].y + (points[i + 1].y - points[i].y) * t,
    );
  }

  path.lineTo(points[points.length - 1].x, points[points.length - 1].y);
  return path;
}

function buildStyle(
  s: Stroke,
  p: { spacing: number; smoothness: number; strokeWidth: number; cornerKeep: number },
): { color: string; lineWidth: number; lineCap: CanvasLineCap; lineJoin: CanvasLineJoin } {
  return {
    color: s.color,
    lineWidth: CanvasPolicy.clampStrokeWidth(p.strokeWidth),
    lineCap: 'round' as CanvasLineCap,
    lineJoin: 'round' as CanvasLineJoin,
  };
}

// ============================================================
//  Renderer — 无状态渲染器，支持 dirty region clip
// ============================================================

class Renderer {
  /**
   * Draw the render queue to canvas.
   * If queue has a dirtyRegion, uses ctx.clip() for partial redraw.
   * Otherwise performs full canvas redraw.
   */
  draw(
    ctx: CanvasRenderingContext2D,
    canvas: HTMLCanvasElement,
    queue: RenderQueue,
    viewport: Viewport,
  ): void {
    const dirty = queue.getDirtyRegion();
    // 🔒 Use FROZEN camera from queue, NOT live viewport.camera
    const cam = queue.camera;
    const dpr = viewport.dpr;

    if (dirty && dirty.w > 0 && dirty.h > 0) {
      // ── Partial redraw: clip to dirty region in device space ──
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);

      // Convert world-space dirty region to device space using frozen camera
      const dx = (dirty.x * cam.zoom + cam.x) * dpr;
      const dy = (dirty.y * cam.zoom + cam.y) * dpr;
      const dw = dirty.w * cam.zoom * dpr;
      const dh = dirty.h * cam.zoom * dpr;

      // Expand slightly to account for stroke width and anti-aliasing
      const pad = 4;
      ctx.beginPath();
      ctx.rect(dx - pad, dy - pad, dw + pad * 2, dh + pad * 2);
      ctx.clip();

      // Clear + fill background in clipped region only
      ctx.clearRect(dx - pad, dy - pad, dw + pad * 2, dh + pad * 2);
      ctx.fillStyle = queue.backgroundColor;
      ctx.fillRect(dx - pad, dy - pad, dw + pad * 2, dh + pad * 2);
      ctx.restore();
    } else {
      // ── Full redraw ──
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = queue.backgroundColor;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }

    // 🔒 Apply camera transform using FROZEN snapshot, not live camera
    ctx.setTransform(
      dpr * cam.zoom, 0,
      0, dpr * cam.zoom,
      cam.x * dpr,
      cam.y * dpr,
    );

    // Batch draw all renderables
    for (const r of queue.renderables) {
      if (!r) continue;
      ctx.save();
      ctx.strokeStyle = r.style.color;
      ctx.lineWidth = r.style.lineWidth;
      ctx.lineCap = r.style.lineCap;
      ctx.lineJoin = r.style.lineJoin;
      ctx.stroke(r.path2D);
      ctx.restore();
    }
  }
}


// ============================================================
//  CanvasSessionRegistry — 全局唯一锁（生产级单实例强制）
// ============================================================

class CanvasSessionRegistry {
  private static _instance: CanvasSessionRegistry | null = null;
  activeSession: CanvasSession | null = null;
  sessionId: string = '';

  static getInstance(): CanvasSessionRegistry {
    if (!this._instance) {
      this._instance = new CanvasSessionRegistry();
    }
    return this._instance;
  }

  register(session: CanvasSession): void {
    if (this.activeSession && !this.activeSession.destroyed) {
      console.warn('[REGISTRY] ⚠️  destroying previous session before creating new one');
      this.activeSession.destroy();
    }
    this.activeSession = session;
    this.sessionId = `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    console.log('[REGISTRY] ✅ session registered', this.sessionId);
  }

  deregister(): void {
    if (this.activeSession) {
      console.log('[REGISTRY] 🗑  session deregistered', this.sessionId);
    }
    this.activeSession = null;
    this.sessionId = '';
  }

  get isActive(): boolean {
    return this.activeSession !== null && !this.activeSession.destroyed;
  }
}

// ============================================================
//  ToolManager — owns all Tool instances, sole lifecycle authority
// ============================================================

class ToolManager {
  private tools = new Map<string, ITool>();
  private active: ITool;

  constructor() {
    // Register default tools on construction
    this.tools.set('pen', new PenTool());
    this.tools.set('eraser', new EraserTool());
    this.tools.set('hand', new HandTool());
    this.active = this.tools.get('pen')!;
  }

  /** Get the currently active tool instance. */
  getActive(): ITool { return this.active; }

  /** Get active tool ID for UI query. */
  getActiveId(): Tool { return this.active.id; }

  /** Get a specific tool by ID (for settings UI). */
  get(id: string): ITool | undefined { return this.tools.get(id); }

  /** Switch active tool by ID. Returns false if tool not found. */
  setActive(id: string): boolean {
    const tool = this.tools.get(id);
    if (!tool) return false;
    this.active = tool;
    return true;
  }

  /** Update settings on a specific tool. */
  updateSettings(id: string, patch: Partial<any>): boolean {
    const tool = this.tools.get(id);
    if (!tool) return false;
    Object.assign(tool.settings, patch);
    return true;
  }

  /** Cleanup all tools. */
  destroy(): void { this.tools.clear(); }
}

// ============================================================
//  CanvasSession — 唯一运行单元, 不可复用, 只允许销毁重建
// ============================================================

// ============================================================
//  PointerPipeline — 唯一输入入口，统一所有 DOM 事件路由
//  Tool / Camera / UI 不再直接监听 DOM；全部经由此管道
// ============================================================

class PointerPipeline {
  private _onPD: (ev: PointerEvent) => void;
  private _onPM: (ev: PointerEvent) => void;
  private _onPU: (ev: PointerEvent) => void;
  private _onWH: (ev: WheelEvent) => void;
  private inputCtrl = new InputSnapshotController();

  constructor(private session: CanvasSession) {
    const el = session.canvasEl;
    this._onPD = (ev) => {
      if (!session.isReady) return;
      const snapshot = this.inputCtrl.capture(ev, session);
      session.toolManager.getActive().onPointerDown(snapshot, session);
    };
    this._onPM = (ev) => {
      if (!session.isReady) return;
      const snapshot = this.inputCtrl.capture(ev, session);
      session.toolManager.getActive().onPointerMove(snapshot, session);
    };
    this._onPU = (ev) => {
      if (!session.isReady) return;
      const snapshot = this.inputCtrl.capture(ev, session);
      session.toolManager.getActive().onPointerUp(snapshot, session);
    };
    this._onWH = (ev) => {
      if (!session.isReady) return;
      ev.preventDefault();
      const r = el.getBoundingClientRect();
      const ax = ev.clientX - r.left, ay = ev.clientY - r.top;
      const dz = -ev.deltaY * CAMERA_CONSTANTS.ZOOM_WHEEL_FACTOR;
      session.viewport.zoomAt(ax, ay, session.viewport.camera.zoom * (1 + dz));
      session.syncViewState();
      session.markCameraDirty();
    };
    el.addEventListener('pointerdown', this._onPD);
    el.addEventListener('pointermove', this._onPM);
    el.addEventListener('pointerup', this._onPU);
    el.addEventListener('wheel', this._onWH, { passive: false });
  }

  destroy(): void {
    const el = this.session?.canvasEl;
    if (!el) return;
    el.removeEventListener('pointerdown', this._onPD);
    el.removeEventListener('pointermove', this._onPM);
    el.removeEventListener('pointerup', this._onPU);
    el.removeEventListener('wheel', this._onWH);
  }
}

// ============================================================

class CanvasSession {
  readonly viewport = new Viewport();
  readonly replayCtrl = new ReplayController();
  readonly toolManager = new ToolManager();
  engine: CanvasRuntimeEngine;
  canvasEl: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  destroyed = false;
  private pointerPipeline!: PointerPipeline;

  // ============================================================
  // ============================================================
  //  Render Pipeline — PS级调度系统 + 增量更新
  // ============================================================
  private renderScheduler = new RenderScheduler();
  private renderQueue = new RenderQueue();
  private renderer = new Renderer();
  private dirtyTracker = new StrokeDirtyTracker();
  private strokeCache = new StrokeRenderCache();
  /** True when a full rebuild is needed (page load, camera change, resize). */
  private _needsFullRebuild = true;

/** Execution Guard — 唯一生命周期标记，destroy 后永久为 false */
private alive = true;

// ============================================================
//  ViewUIState — single source for cursor/camera/tool UI
// ============================================================

viewState: ViewUIState = {
  cursor: { x: 0, y: 0, visible: true, mode: 'pen', size: 8 },
  camera: { x: 0, y: 0, zoom: 1, vx: 0, vy: 0 },
  tool: {
    activeTool: 'pen',
    penSettings: CanvasPolicy.getDefaults(),
    eraserMode: 'point',
    eraserSize: 50,
    eraserStrength: 50,
  },
};

private _viewSubs: Array<(s: ViewUIState) => void> = [];

/** Subscribe to viewState changes. Returns unsubscribe function. */
subscribeViewUI(fn: (s: ViewUIState) => void): () => void {
  this._viewSubs.push(fn);
  return () => { const i = this._viewSubs.indexOf(fn); if (i !== -1) this._viewSubs.splice(i, 1); };
}

/** Sync internal state → viewState + notify subscribers. Call after any change. */
syncViewState(): void {
  const c = this.viewport.camera;
  const inertia = this.viewport.inertia;
  this.viewState.camera = { x: c.x, y: c.y, zoom: c.zoom, vx: inertia.vx, vy: inertia.vy };
  const activeTool = this.toolManager.getActiveId();
  this.viewState.tool.activeTool = activeTool;
  this.viewState.cursor.mode = activeTool;

  // Compute unified cursor.size based on active tool
  if (activeTool === 'pen') {
    const pen = this.toolManager.get('pen');
    if (pen) {
      const ps = pen.settings as HandwritingParams;
      this.viewState.tool.penSettings = { ...ps };
      // Pen cursor size = strokeWidth mapped to display px (1.5→10, 8→24)
      this.viewState.cursor.size = 6 + ps.strokeWidth * 3;
    }
  } else if (activeTool === 'eraser') {
    const eraser = this.toolManager.get('eraser');
    if (eraser) {
      const es = eraser.settings as EraserSettings;
      this.viewState.tool.eraserMode = es.mode;
      this.viewState.tool.eraserSize = es.size;
      this.viewState.tool.eraserStrength = es.strength;
      // Eraser cursor size = mapped from 0-100 slider to 10-60px
      this.viewState.cursor.size = 10 + (es.size / 100) * 50;
    }
  } else {
    // Hand tool — small dot
    this.viewState.cursor.size = 10;
  }

  for (const fn of this._viewSubs) fn(this.viewState);
}

  private _frameCount = 0;
  private _onResize!: () => void;

  constructor(
    public notebookId: string,
    public pageId: string,
    private plugin: GoodNoteMaxPlugin,
    parentEl: HTMLElement
  ) {
    this.engine = plugin.createEngine();

    // Look up strokes from Plugin (caller provides data, Engine is pure)
    const nb = plugin.getNotebooks().find(n => n.id === notebookId);
    const page = nb?.pages.find(p => p.id === pageId);
    const strokes = page?.strokes ?? [];
    this.engine.load(notebookId, pageId, strokes);

    // ── Subscribe Engine commit → Plugin persistence ──
    this.engine.on('commit', (payload: any) => {
      if (!payload) return;
      const nb2 = plugin.getNotebooks().find((n: Notebook) => n.id === payload.notebookId);
      const page2 = nb2?.pages.find((p: Page) => p.id === payload.pageId);
      if (!nb2 || !page2) return;
      page2.strokes = payload.strokes;
      page2.updatedAt = new Date().toISOString();
      plugin.isInternalWrite = true;
      try { plugin.fileGateway.saveNotebook(nb2); }
      finally { plugin.isInternalWrite = false; }
    });

    const wrapper = parentEl.createEl('div', { cls: 'goodnote-canvas-wrapper' });
    this.canvasEl = wrapper.createEl('canvas', { cls: 'goodnote-canvas' });
    this.ctx = this.canvasEl.getContext('2d')!;

    this._onResize = () => this.applySize();
    this.applySize();
    window.addEventListener('resize', this._onResize);
    this.pointerPipeline = new PointerPipeline(this);

    // ── Render Pipeline: wire scheduler → unified tick (single RAF for whole system) ──
    this.renderScheduler.onFrame = () => this._unifiedTick();
    this.renderScheduler.start();

    this.syncViewState(); // initial sync after construction
  }

  /** 公开只读 — 外部 guard 用，不会 throw */
  isAlive(): boolean { return this.alive; }

  /** 内部强制检查 — 任何核心方法入口调用，destroy 后 throw */
  private assertAlive(): void {
    if (!this.alive) {
      throw new Error('[CanvasSession] ❌ Execution blocked — session already destroyed');
    }
  }

  get isReady(): boolean { return this.alive && !this.destroyed && !!this.engine; }

  // ---- lifecycle ----

  destroy() {
    if (this.destroyed) return;
    // 🔴 第一条指令：立即切断 alive — 所有后续回调看到 alive=false 直接 return
    this.alive = false;
    this.destroyed = true;

    // ① Cancel all animation frames — 禁止任何 rAF 残留
    this.stopReplayLoop();
    this.replayCtrl.reset();
    this.viewport.inertia.stop();
    this.renderScheduler.stop();
    this.renderQueue.clear();
    this.dirtyTracker.clear();
    this.strokeCache.clear();

    // ② 全量断链 — Pipeline 负责移除所有 pointer/wheel 监听
    window.removeEventListener('resize', this._onResize);
    if (this.pointerPipeline) { this.pointerPipeline.destroy(); }

    // ③ Detach engine（不移除 strokes，数据属于 Page）
    if (this.engine) { this.engine.detach(); }

    // ④ DOM 强制移除 — 禁止 orphan canvas + wrapper
    if (this.canvasEl) { this.canvasEl.parentElement?.remove(); }

    // ⑤ 强制清空所有引用 — 幽灵防御系统
    (this as any).engine = null;
    (this as any).viewport = null;
    (this as any).canvasEl = null;
    (this as any).ctx = null;
    (this as any).replayCtrl = null;
    (this as any)._onResize = null;
    console.log('[SESSION] 💀 fully destroyed — all references nulled, all listeners removed');
  }

  // ---- size ----

  private applySize() {
    requestAnimationFrame(() => {
      if (!this.alive) return;
      const rect = this.canvasEl.getBoundingClientRect();
      const w = Math.round(rect.width), h = Math.round(rect.height);
      if (w < 50 || h < 50) return;
      if (w === this.viewport.cssW && h === this.viewport.cssH && this.viewport.cssW > 0) return;
      const dpr = window.devicePixelRatio || 1;
      this.canvasEl.width = Math.round(w * dpr);
      this.canvasEl.height = Math.round(h * dpr);
      this.canvasEl.style.width = w + 'px';
      this.canvasEl.style.height = h + 'px';
      this.viewport.update(w, h, dpr);
    });
  }

  requestResize() { this.assertAlive(); this.applySize(); }

  // ---- pointer events ----

  // ---- pointer events (routed through ToolSystem) ----

  // ---- Page loading (zero-overhead, no DOM rebuild) ----

  /**
   * 加载 Page 数据 — 仅更新 engine 引用，不重建 DOM。
   * 调用方（Plugin）提供完整 Page 对象；Session 不查询 Notebook。
   */
  loadPage(notebookId: string, page: Page): void {
    this.assertAlive();
    // ① 提交当前脏数据
    this.engine.commitNow();
    // ② 加载目标 page strokes（engine.load 处理幂等）
    this.engine.load(notebookId, page.id, page.strokes ?? []);
    // ③ 更新内部引用
    this.notebookId = notebookId;
    this.pageId = page.id;
    // ④ 清除缓存 + 标记全量重建（新 page = 全新数据）
    this.strokeCache.clear();
    this._needsFullRebuild = true;
    // ⑤ 触发重绘
    this.markDirty();
    this.syncViewState();
  }
/** Switch active tool by ID. Returns false if tool not found. */
setTool(id: Tool): boolean {
  const ok = this.toolManager.setActive(id);
  if (ok) this.syncViewState();
  return ok;
}

/** Get active tool ID (for UI query). */
getActiveToolId(): Tool {
  return this.toolManager.getActiveId();
}

/** Update settings on a specific tool. */
updateToolSettings(id: string, patch: Record<string, any>): boolean {
  return this.toolManager.updateSettings(id, patch);
}

// ---- Stroke accessor (for PageManager) ----


  /** 获取当前渲染的 strokes（直接引用，非拷贝） */
  getStrokes(): Stroke[] {
    return this.engine.strokes;
  }

  /** 替换 strokes 并触发重绘（用于 PageManager.updatePageData） */
  setStrokes(strokes: Stroke[]): void {
    this.assertAlive();
    this.engine.strokes = strokes;
    this.strokeCache.clear();
    this._needsFullRebuild = true;
    this.markDirty();
  }

  /** 强制重绘（不检查 isDirty） */
  rerender(): void {
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
  markDirty(strokeId?: string, dirtyRect?: DirtyRegion): void {
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
  markCameraDirty(): void {
    this.assertAlive();
    this._needsFullRebuild = true;
    this.renderScheduler.requestRender();
  }

  /**
   * Request a full rebuild on next frame (e.g. after erase operations that may split strokes).
   * Public so Tool layer can trigger it.
   */
  requestFullRebuild(): void {
    this.assertAlive();
    this._needsFullRebuild = true;
  }

  /**
   * Render frame — called by RenderScheduler at most once per RAF tick.
   * ① Decides: full rebuild vs incremental update
   * ② Delegates to Renderer.draw()
   */
  private renderFrame() {
    this.assertAlive();
    const ctx = this.ctx, canvas = this.canvasEl, engine = this.engine;
    if (!ctx || !canvas || !engine) return;

    this._frameCount++;
    if (this._frameCount % 60 === 0) {
      console.log('[RENDER CHECK]', {
        cssW: this.viewport.cssW, cssH: this.viewport.cssH,
        bufW: canvas.width, bufH: canvas.height,
        strokeCount: engine.strokes.length,
        cacheSize: this.strokeCache.size,
        dirtyCount: this.dirtyTracker.hasDirty ? '(has dirty)' : '(clean)',
      });
    }

    // ① Sync camera snapshot into queue
    const c = this.viewport.camera;
    this.renderQueue.camera = { x: c.x, y: c.y, zoom: c.zoom };
    this.renderQueue.bufW = canvas.width;
    this.renderQueue.bufH = canvas.height;

    // ② Decide: full rebuild or incremental update
    if (this._needsFullRebuild) {
      this._needsFullRebuild = false;
      this.renderQueue.fullRebuild(engine.strokes, engine.params, this.strokeCache, this.replayCtrl);
      this.dirtyTracker.clear();
    } else if (this.dirtyTracker.hasDirty) {
      const dirtyIds = this.dirtyTracker.flushDirty();
      this.renderQueue.updateDirty(dirtyIds, engine.strokes, engine.params, this.strokeCache);
    }

    // ③ Delegate to stateless Renderer (supports dirty region clip)
    this.renderer.draw(ctx, canvas, this.renderQueue, this.viewport);

    // ④ Clear dirty region after render
    this.renderQueue.clearDirtyRegion();
  }

  // ---- Unified Frame Tick (single RAF → inertia → replay → render) ----

  /**
   * Start replay animation. Replay is now driven by the unified frame tick,
   * not by its own RAF loop.
   */
  startReplayLoop() {
    // Replay is active — the unified tick handles frame-by-frame advancement
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
  private _unifiedTick(): void {
    if (!this.alive) return;

    // ① Inertia physics tick (if active)
    if (this.viewport.inertia.active) {
      const stillActive = this.viewport.inertia.tick();
      if (!stillActive) {
        // Inertia stopped — last render already triggered by tick()
      }
    }

    // ② Replay tick (if active, driven by unified frame)
    if (this.replayCtrl.active) {
      const stroke = this.engine?.strokes.find(s => s.id === this.replayCtrl.strokeId);
      if (!stroke || this.replayCtrl.cursorIndex >= stroke.points.length) {
        this.replayCtrl.stop();
      } else {
        this.replayCtrl.tick();
      }
      this.markDirty();
    }

    // ③ Render frame (always — other subsystems may have triggered markDirty)
    this.renderFrame();
  }
}

// ============================================================
//  ToolbarState — Single Source of Truth for Floating Toolbar position
//  DOM / CSS / getBoundingClientRect MUST NOT participate in computation
// ============================================================

interface ToolbarState {
  x: number;
  y: number;
  dock: DockMode;
  dragging: boolean;
  dragOx: number;
  dragOy: number;
  /** Cached viewport — updated only via ResizeObserver, never from getBoundingClientRect */
  viewportW: number;
  viewportH: number;
  /** Cached toolbar intrinsic size — updated after render or tool switch */
  toolbarW: number;
  toolbarH: number;
}

function createDefaultToolbarState(): ToolbarState {
  return {
    x: 12,
    y: -1, // -1 = uninitialized, will be computed from viewport on first render
    dock: 'free',
    dragging: false,
    dragOx: 0,
    dragOy: 0,
    viewportW: window.innerWidth,
    viewportH: window.innerHeight,
    toolbarW: 0,
    toolbarH: 0,
  };
}

// ============================================================
//  CanvasView — thin Obsidian view shell, delegates to CanvasSession
// ============================================================

class CanvasView extends ItemView {
  plugin: GoodNoteMaxPlugin;
  session: CanvasSession | null = null;

  // UI layout
  private layoutEl!: HTMLElement;
  private canvasAreaEl!: HTMLElement;
  private drawerEl!: HTMLElement;
  private isDrawerOpen = false;

  // Floating toolbar — single state source
  private ts: ToolbarState = createDefaultToolbarState();
  private toolbarEl!: HTMLElement;
  private statsEl!: HTMLElement;
  private _resizeObserver: ResizeObserver | null = null;

  // ── Cursor System v4 — unified CursorRenderer, PS-level brush preview ──
  private cursorRenderer!: CursorRenderer;

  constructor(leaf: WorkspaceLeaf, plugin: GoodNoteMaxPlugin) { super(leaf); this.plugin = plugin; }
  getViewType(): string { return CANVAS_VIEW_TYPE; }
  getDisplayText(): string { return 'Canvas'; }
  getIcon(): string { return 'pen-tool'; }

  // ---- session lifecycle ----

  /**
   * 创建或切换 session。
   * - 首次调用：创建 CanvasSession + canvas DOM
   * - 后续调用（同一 notebook 不同 page）：仅 switchPage，零 DOM 开销
   * - 不同 notebook：销毁重建（notebook 切换是低频操作）
   */
  createSession(notebookId: string, pageId: string) {
    // Case 1: 已有 session 且同一 notebook → 零开销切页
    if (this.session?.isAlive() && this.session.notebookId === notebookId) {
      if (this.session.pageId === pageId) return; // 同一 page，跳过
      const nb = this.plugin.getNotebooks().find(n => n.id === notebookId);
      const page = nb?.pages.find(p => p.id === pageId);
      if (page) {
        this.session.loadPage(notebookId, page);
        console.log('[SESSION] 🔄 page switched (zero-overhead)', { notebookId, pageId });
        return;
      }
      console.warn('[SESSION] ⚠️ page not found, falling back to rebuild');
    }

    // Case 2: 不同 notebook 或首次创建 → 销毁旧 session + 重建
    this.destroySession();
    if (!this.canvasAreaEl) return;

    // 清空旧 DOM（wrapper + canvas），确保 0 残留
    this.canvasAreaEl.empty();

    // Runtime assertion: CanvasView must NOT hold runtime logic
    console.assert(
      typeof CanvasView === 'function',
      'CanvasView must NOT exist at runtime logic level'
    );

    this.session = new CanvasSession(notebookId, pageId, this.plugin, this.canvasAreaEl);
    CanvasSessionRegistry.getInstance().register(this.session);

    // 强制单 canvas 断言 — 如果失败立即 destroy + 重建
    const canvasCount = document.querySelectorAll('canvas').length;
    if (canvasCount !== 1) {
      console.error(`❌ Canvas count = ${canvasCount}, expected 1 — destroying and recreating`);
      CanvasSessionRegistry.getInstance().deregister();
      this.session.destroy();
      this.canvasAreaEl.empty();
      this.session = new CanvasSession(notebookId, pageId, this.plugin, this.canvasAreaEl);
      CanvasSessionRegistry.getInstance().register(this.session);
      console.assert(document.querySelectorAll('canvas').length === 1, '❌ FAILED: Multiple canvases after retry');
    }

    // ── Cursor System: bind session and mount (safe: session is now valid) ──
    if (this.cursorRenderer) {
      this.cursorRenderer.bindSession(this.session);
      this.cursorRenderer.mount();
    }

    // 重定位 toolbar（session 重建后 layout 可能偏移）
    requestAnimationFrame(() => {
      const r = this.layoutEl.getBoundingClientRect();
      this.ts.viewportW = r.width;
      this.ts.viewportH = r.height;
      this.cacheToolbarSize();
      this.initToolbarPosition();
    });

    console.log('[SESSION] ✅ created', { notebookId, pageId, engineId: (this.session.engine as any).id });
  }

  destroySession() {
    if (this.session) {
      CanvasSessionRegistry.getInstance().deregister();
      this.session.destroy();
      console.log('[SESSION] 💀 destroyed');
      this.session = null;
    }
    // Ghost check: no orphan canvas
    const remainingCanvases = document.querySelectorAll('canvas').length;
    if (remainingCanvases > 0) {
      console.warn(`⚠️ [GHOST] Orphan canvas detected after destroySession: ${remainingCanvases} remaining`);
    }
  }

  async onClose() {
    // Cleanup cursor renderer (handles all DOM + listeners)
    if (this.cursorRenderer) {
      this.cursorRenderer.destroy();
    }
    // Cleanup ResizeObserver
    if (this._resizeObserver) {
      this._resizeObserver.disconnect();
      this._resizeObserver = null;
    }
    this.destroySession();
  }

  async onOpen() {
    const c = this.containerEl; c.empty(); c.addClass("goodnote-canvas-view");
    this.layoutEl = c.createEl("div", { cls: "goodnote-canvas-layout" });
    this.canvasAreaEl = c.createEl("div", { cls: "goodnote-canvas-area" });
    this.drawerEl = this.layoutEl.createEl("div", { cls: "goodnote-canvas-drawer" });
    this.buildDrawer(this.drawerEl);
    this.buildFloatingToolbar(this.layoutEl);

    // ── ResizeObserver: cache viewport, never use getBoundingClientRect in hot paths ──
    let _roTimer: number | null = null;
    this._resizeObserver = new ResizeObserver(() => {
      // Debounce: skip rapid-fire events (drawer animation, Obsidian panel resize)
      if (_roTimer !== null) return;
      _roTimer = window.setTimeout(() => {
        _roTimer = null;
        const r = this.layoutEl.getBoundingClientRect();
        // Only update if dimensions actually changed (prevents spurious re-apply)
        if (Math.abs(r.width - this.ts.viewportW) < 2 && Math.abs(r.height - this.ts.viewportH) < 2) return;
        this.ts.viewportW = r.width;
        this.ts.viewportH = r.height;
        // Re-apply state on resize (clamp + re-dock if needed)
        this.applyToolbarState();
      }, 150); // Wait for drawer transition (300ms) to settle
    });
    this._resizeObserver.observe(this.layoutEl);

    // Initial viewport cache + position init
    requestAnimationFrame(() => {
      const r = this.layoutEl.getBoundingClientRect();
      this.ts.viewportW = r.width;
      this.ts.viewportH = r.height;
      this.cacheToolbarSize();
      this.initToolbarPosition();
    });

    this.containerEl.addEventListener("keydown", (ev: KeyboardEvent) => {
      if (ev.key === "Escape" && this.isDrawerOpen) this.toggleDrawer();
    });

    // ── Cursor System v4 — unified CursorRenderer (PS-level brush preview) ──
    // NOTE: mount() is deferred to createSession() — session must exist first
    this.cursorRenderer = new CursorRenderer(null as any);
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
  private applyToolbarState(): void {
    if (!this.toolbarEl) return;
    const s = this.ts;

    // ── Dock → Layout mapping ──
    const isVertical = s.dock === 'left' || s.dock === 'right';
    this.toolbarEl.classList.remove("horizontal", "vertical");
    this.toolbarEl.classList.add(isVertical ? "vertical" : "horizontal");

    // Re-cache toolbar size (layout change shifts dimensions)
    requestAnimationFrame(() => this.cacheToolbarSize());

    // Clamp to viewport bounds
    const maxX = Math.max(0, s.viewportW - s.toolbarW);
    const maxY = Math.max(0, s.viewportH - s.toolbarH);
    s.x = Math.max(0, Math.min(s.x, maxX));
    s.y = Math.max(0, Math.min(s.y, maxY));

    // CSS lockdown — position 仅由 transform 决定
    this.toolbarEl.style.top = "0px";
    this.toolbarEl.style.left = "0px";
    this.toolbarEl.style.right = "";
    this.toolbarEl.style.bottom = "";
    this.toolbarEl.style.transform = `translate(${s.x}px, ${s.y}px)`;
  }

  /** Cache toolbar intrinsic size — called once after DOM create + after tool switch */
  private cacheToolbarSize(): void {
    if (!this.toolbarEl) return;
    this.ts.toolbarW = this.toolbarEl.offsetWidth;
    this.ts.toolbarH = this.toolbarEl.offsetHeight;
  }

  /** Initial position: bottom-left corner (12, viewportH - toolbarH - 12) */
  private initToolbarPosition(): void {
    this.ts.dock = 'free';
    this.ts.x = 12;
    this.ts.y = Math.max(0, this.ts.viewportH - this.ts.toolbarH - 12);
    this.clearDockClasses();
    this.applyToolbarState();
  }

  private clearDockClasses(): void {
    this.toolbarEl.classList.remove(
      "dock-left", "dock-right", "dock-top", "dock-bottom",
      "compact", "snapping", "undocking",
      "horizontal", "vertical"
    );
  }

  // ============================================================
  //  Drag — only mutates state, never touches DOM directly
  // ============================================================

  private buildFloatingToolbar(parent: HTMLElement) {
    this.toolbarEl = parent.createEl("div", { cls: "goodnote-floating-toolbar" });

    const toolLabels: Record<string, string> = { pen: "钢笔", eraser: "橡皮", hand: "手掌" };
    for (const t of [{ k: "pen" as const, l: "\u2712\uFE0F" }, { k: "eraser" as const, l: "\uD83E\uDDF9" }, { k: "hand" as const, l: "\u270B" }]) {
      const b = this.toolbarEl.createEl("button", { text: t.l, title: toolLabels[t.k] });
      b.setAttribute("data-tool", t.k);
      const curTool = this.session?.getActiveToolId();
      if (curTool === t.k) b.addClass("is-active");
      b.onclick = () => {
        if (!this.session?.isReady || !this.session?.engine) return;
        this.session?.setTool(t.k);
        this.updateToolbarState();
        this.buildDrawer(this.drawerEl);
        // Cursor auto-updates via session.subscribeViewUI — no explicit call needed
        requestAnimationFrame(() => this.cacheToolbarSize());
      };
    }
    this.toolbarEl.createEl("button", { text: "\u2699\uFE0F", title: "设置" }).onclick = () => this.toggleDrawer();

    // ── Drag: pure state mutation ──
    this.toolbarEl.onpointerdown = (ev: PointerEvent) => {
      if ((ev.target as HTMLElement).tagName === "BUTTON") return;
      const s = this.ts;

      // Lock transition
      this.toolbarEl.style.transition = "none";

      // Undock: state already has x/y from dock calculation, no DOM read needed
      if (s.dock !== 'free') {
        s.dock = 'free';
        this.clearDockClasses();
      }

      // Enter drag state
      s.dragging = true;
      s.dragOx = ev.clientX - s.x;
      s.dragOy = ev.clientY - s.y;
      this.toolbarEl.classList.add("dragging");
      this.toolbarEl.setPointerCapture(ev.pointerId);
    };

    this.toolbarEl.onpointermove = (ev: PointerEvent) => {
      const s = this.ts;
      if (!s.dragging) return;
      this.toolbarEl.style.transition = "none";

      // Pure math: client coords → state, clamped to cached viewport
      s.x = ev.clientX - s.dragOx;
      s.y = ev.clientY - s.dragOy;
      // Clamp using cached viewport + toolbar size
      const maxX = Math.max(0, s.viewportW - s.toolbarW);
      const maxY = Math.max(0, s.viewportH - s.toolbarH);
      s.x = Math.max(0, Math.min(s.x, maxX));
      s.y = Math.max(0, Math.min(s.y, maxY));

      // Render
      this.toolbarEl.style.transform = `translate(${s.x}px, ${s.y}px)`;
    };

    this.toolbarEl.onpointerup = () => {
      const s = this.ts;
      s.dragging = false;
      this.toolbarEl.classList.remove("dragging");
      this.toolbarEl.style.transition = "";
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

  private smartSnap(): void {
    const s = this.ts;
    const SNAP_DISTANCE = 100;
    const tw = s.toolbarW;
    const th = s.toolbarH;
    const vw = s.viewportW;
    const vh = s.viewportH;

    // Distance to each edge — pure math from state
    const distTo: Record<string, number> = {
      left:   s.x,
      right:  vw - tw - s.x,
      top:    s.y,
      bottom: vh - th - s.y,
    };

    let bestEdge: DockMode = 'free';
    let bestDist = Infinity;
    for (const [edge, dist] of Object.entries(distTo)) {
      if (dist < SNAP_DISTANCE && dist < bestDist) {
        bestDist = dist;
        bestEdge = edge as DockMode;
      }
    }

    this.clearDockClasses();

    if (bestEdge === 'free') {
      s.dock = 'free';
      this.applyToolbarState();
      return;
    }

    // Compute snap target — pure math from cached viewport + toolbar size
    switch (bestEdge) {
      case 'left':
        s.x = 8;
        s.y = (vh - th) / 2;
        break;
      case 'right':
        s.x = vw - tw - 8;
        s.y = (vh - th) / 2;
        break;
      case 'top':
        s.x = 12;
        s.y = 12;
        break;
      case 'bottom':
        s.x = (vw - tw) / 2;
        s.y = vh - th - 12;
        break;
    }

    s.dock = bestEdge;
    this.toolbarEl.classList.add("dock-" + bestEdge, "compact", "snapping");
    this.applyToolbarState();

    // Remove snapping class after animation completes
    setTimeout(() => {
      this.toolbarEl.classList.remove("snapping");
      this.toolbarEl.style.transition = "";
    }, 420);
  }

  private updateToolbarState() {
    const curTool = this.session?.getActiveToolId();
    this.containerEl.querySelectorAll(".goodnote-floating-toolbar button").forEach((b: Element) => {
      const el = b as HTMLButtonElement;
      const toolId = el.getAttribute("data-tool");
      if (toolId) el.classList.toggle("is-active", toolId === curTool);
    });
  }

  private toggleDrawer() {
    this.isDrawerOpen = !this.isDrawerOpen;
    this.drawerEl.classList.toggle("is-visible", this.isDrawerOpen);
  }

  // ==========================================================
  //  Settings Panel — reads tool state from Session.toolManager
  // ==========================================================

  private buildDrawer(container: HTMLElement) {
    container.empty();
    const toolId = this.session?.getActiveToolId();
    if (toolId === 'pen') {
      this.buildPenPanel(container);
    } else if (toolId === 'eraser') {
      this.buildEraserPanel(container);
    } else {
      container.createEl("h4", { text: "\u270B 手掌" });
      container.createEl("p", { text: "拖动画布", cls: "goodnote-placeholder" });
    }
  }

  // ── Pen Panel — reads/writes via session.toolManager ──

  /** Derive UI-friendly inkFlow (0-100) from engine spacing param. */
  private getPenInkFlow(): number {
    const pen = this.session?.toolManager.get('pen');
    const ps = pen?.settings as HandwritingParams | undefined;
    return ps ? Math.round(((6 - ps.spacing) / 5) * 100) : 70;
  }
  private getPenStability(): number {
    const pen = this.session?.toolManager.get('pen');
    const ps = pen?.settings as HandwritingParams | undefined;
    return ps ? Math.round(((0.55 - ps.cornerKeep) / 0.45) * 100) : 65;
  }
  private getPenStrokeWidth(): number {
    const pen = this.session?.toolManager.get('pen');
    const ps = pen?.settings as HandwritingParams | undefined;
    return ps?.strokeWidth ?? 2;
  }

  /** Apply pen params to both Engine and Tool settings via session. */
  private applyPenParams(inkFlow: number, stability: number, strokeWidth: number) {
    const s = this.session;
    if (!s?.isAlive?.() || !s?.engine) return;
    const t = inkFlow / 100;
    const st = stability / 100;
    const spacing    = +(6 - t * 5).toFixed(1);
    const smoothness = +(0.15 + t * 0.6).toFixed(2);
    const cornerKeep = +(0.55 - st * 0.45).toFixed(2);
    const params = { spacing, smoothness, strokeWidth, cornerKeep };
    s.engine.setParams(params);
    s.updateToolSettings('pen', params);
    s.markDirty();
  }

  private buildPenPanel(container: HTMLElement) {
    container.createEl("h4", { text: "\u270D\uFE0F 钢笔" });

    const presets = [
      { label: "圆珠笔", ink: 60, stab: 70, w: 1.5 },
      { label: "钢笔",   ink: 85, stab: 50, w: 2.5 },
      { label: "铅笔",   ink: 25, stab: 30, w: 1.8 },
    ];
    const presetRow = container.createEl("div", { cls: "goodnote-drawer-presets" });
    for (const p of presets) {
      const btn = presetRow.createEl("button", { text: p.label });
      btn.onclick = () => {
        this.applyPenParams(p.ink, p.stab, p.w);
        this.syncPenSliders();
      };
    }

    this.buildSlider(container, "墨流", "粗涩 → 顺滑", 0, 100, this.getPenInkFlow(),
      (v) => this.applyPenParams(v, this.getPenStability(), this.getPenStrokeWidth()));

    this.buildSlider(container, "稳定性", "自然 → 精准", 0, 100, this.getPenStability(),
      (v) => this.applyPenParams(this.getPenInkFlow(), v, this.getPenStrokeWidth()));

    this.buildSlider(container, "笔触宽度", "", 0.5, 8, this.getPenStrokeWidth(),
      (v) => this.applyPenParams(this.getPenInkFlow(), this.getPenStability(), v), 0.5);
  }

  private syncPenSliders() {
    const map: Record<string, number> = {
      "墨流": this.getPenInkFlow(),
      "稳定性": this.getPenStability(),
      "笔触宽度": this.getPenStrokeWidth(),
    };
    this.drawerEl.querySelectorAll("input[type=range]").forEach((s: Element) => {
      const el = s as HTMLInputElement;
      const key = el.getAttribute("data-slider-key");
      if (key && map[key] !== undefined) el.value = String(map[key]);
    });
  }

  // ── Eraser Panel — reads/writes via session.toolManager ──

  private buildEraserPanel(container: HTMLElement) {
    container.empty();
    const eraser = this.session?.toolManager.get('eraser');
    if (!eraser) return;
    const es = eraser.settings as EraserSettings;
    container.createEl("h4", { text: "\uD83E\uDDF9 橡皮" });

    const modeRow = container.createEl("div", { cls: "goodnote-drawer-presets" });
    for (const m of [
      { k: "stroke" as EraserMode, l: "整体擦除" },
      { k: "point" as EraserMode, l: "局部擦除" },
      { k: "smart" as EraserMode, l: "智能擦除" },
    ]) {
      const btn = modeRow.createEl("button", { text: m.l });
      if (es.mode === m.k) btn.addClass("is-active");
      btn.onclick = () => {
        es.mode = m.k;
        this.session?.updateToolSettings('eraser', { mode: m.k });
        this.buildEraserPanel(container);
      };
    }

    this.buildSlider(container, "大小", "小 → 大", 0, 100, es.size,
      (v) => { es.size = v; this.session?.updateToolSettings('eraser', { size: v }); this.session?.syncViewState(); });

    if (es.mode === 'smart') {
      this.buildSlider(container, "灵敏度", "轻柔 → 强力", 0, 100, es.strength,
        (v) => { es.strength = v; this.session?.updateToolSettings('eraser', { strength: v }); });
    }
  }

  // ── Generic Slider Builder ──

  private buildSlider(
    container: HTMLElement,
    label: string, hint: string,
    min: number, max: number, value: number,
    onChange: (v: number) => void,
    step = 1
  ) {
    const row = container.createEl("div", { cls: "goodnote-pen-slider" });
    const hdr = row.createEl("div", { cls: "goodnote-pen-slider-header" });
    hdr.createEl("span", { cls: "goodnote-pen-slider-label", text: label });
    if (hint) hdr.createEl("span", { cls: "goodnote-pen-slider-hint", text: hint });
    const input = row.createEl("input", { type: "range" }) as HTMLInputElement;
    input.min = String(min); input.max = String(max); input.step = String(step);
    input.value = String(value);
    input.oninput = () => onChange(parseFloat(input.value));
    input.setAttribute("data-slider-key", label);
  }

}

// ============================================================
//  UI State
// ============================================================

interface UIState {
  selectedNotebookId: string | null;
  selectedPageId: string | null;
  activeView: 'notebook' | 'page' | 'canvas';
  isCanvasDirty: boolean;
}

// ============================================================
//  GoodNoteMaxPlugin
// ============================================================

type EventHandler = () => void;

export default class GoodNoteMaxPlugin extends Plugin {
  private _initialized = false;
  private notebooks: Notebook[] = [];
  private selectedNotebookId: string | null = null;
  private listeners = new Map<string, EventHandler[]>();
  isInternalWrite = false;
  isInternalRename = false;
  fileGateway!: FileGateway;
  layoutManager!: CanvasLayoutManager;
  pageManager!: PageManager;

  uiState: UIState = { selectedNotebookId: null, selectedPageId: null, activeView: 'notebook', isCanvasDirty: false };

  /** UI intent layer — views call these instead of mutating state directly. */
  ui = {
    selectNotebook: (id: string) => {
      this.uiState.selectedNotebookId = id;
      this.uiState.selectedPageId = null;
      this.uiState.activeView = 'page';
      this.setSelectedNotebook(id);
      this.emit('ui-changed');
    },
    selectPage: (pageId: string) => {
      this.uiState.selectedPageId = pageId;
      this.uiState.activeView = 'canvas';
      this.emit('ui-changed');
    },
    openCanvas: (notebookId: string, pageId: string) => {
      this.ui.selectPage(pageId);
      this.openCanvasForPage(notebookId, pageId);
    },
    backToPages: () => {
      this.uiState.activeView = 'page';
      this.uiState.selectedPageId = null;
      this.emit('ui-changed');
    },
  };

  on(event: string, h: EventHandler) {
    if (!this.listeners.has(event)) this.listeners.set(event, []);
    this.listeners.get(event)!.push(h);
  }
  emit(event: string) { for (const fn of this.listeners.get(event) ?? []) fn(); }

  getNotebooks(): Notebook[] { return this.notebooks; }
  getSortedNotebooks(): Notebook[] {
    return [...this.notebooks.filter((n) => n.isPinned), ...this.notebooks.filter((n) => !n.isPinned)];
  }
  getSelectedNotebook(): Notebook | null {
    return this.selectedNotebookId ? this.notebooks.find((n) => n.id === this.selectedNotebookId) ?? null : null;
  }

  setSelectedNotebook(id: string) {
    const nb = this.notebooks.find((n) => n.id === id);
    if (nb && !nb.isPinned) { const i = this.notebooks.findIndex((n) => n.id === id); if (i > 0) { const [it] = this.notebooks.splice(i, 1); this.notebooks.unshift(it); } }
    this.selectedNotebookId = id;
    this.emit('selection-changed');
  }

  togglePinNotebook(id: string) { const nb = this.notebooks.find((n) => n.id === id); if (!nb) return; nb.isPinned = !nb.isPinned; this.fileGateway.saveNotebook(nb); this.emit('notebooks-changed'); }

  private async resolveNotebookPath(id: string): Promise<string | undefined> {
    const adapter = this.app.vault.adapter;
    const files = (await adapter.list('GoodNoteMax')).files.filter((f: string) => f.endsWith('.gnnote'));
    for (const f of files) {
      try {
        const raw = await adapter.read(f);
        if (JSON.parse(raw).id === id) return f;
      } catch (_) {}
    }
    return undefined;
  }

  async renameNotebook(id: string, newName: string) {
    const trimmed = newName.trim();
    if (!trimmed) return;
    const nb = this.notebooks.find((n) => n.id === id);
    if (!nb) return;
    const adapter = this.app.vault.adapter;
    const files = (await adapter.list('GoodNoteMax')).files;
    if (files.some((f: string) => f.endsWith(`${trimmed}.gnnote`))) return;
    const oldPath = await this.resolveNotebookPath(id);
    if (!oldPath) return;
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
    this.emit('notebooks-changed');
  }

  private safeBootCheck(caller: string) {
    if (!this._initialized) {
      console.warn(`[BOOT] ${caller}: ignored — plugin not initialized`);
      return false;
    }
    return true;
  }

  private async handleVaultEvent(type: string, file: any, oldPath?: string) {
    if (!this.safeBootCheck('handleVaultEvent')) return;
    if (this.isInternalRename || this.isInternalWrite) return;
    const path: string = file?.path ?? '';
    if (!path.startsWith('GoodNoteMax/') || !path.endsWith('.gnnote')) return;

    if (type === 'delete') {
      // Bug B Fix: 使用内存状态查找 notebook，不依赖文件读取（文件已删除）
      const filename = path.replace(/^GoodNoteMax\//, '').replace(/\.gnnote$/, '');
      const match = this.notebooks.find((n) => n.name === filename || `${n.name}.gnnote` === path.replace(/^GoodNoteMax\//, ''));
      if (!match) return;
      this.notebooks = this.notebooks.filter((n) => n.id !== match.id);
      if (this.selectedNotebookId === match.id) { this.selectedNotebookId = null; this.emit('selection-changed'); }
      const activeCanvas = this.layoutManager?.getActiveCanvas();
      console.log('[ENGINE LIFECYCLE]', {
        action: 'VAULT_DELETE',
        matchId: match.id,
        activeEngineId: (activeCanvas?.session?.engine as any)?.id ?? 'none',
        activeEngineNotebookId: (activeCanvas?.session?.engine as any)?.notebookId ?? 'none',
      });
      // Bug B Fix: forceReset 清空 CanvasView + engine.reset 清空 strokes
      if (activeCanvas) { activeCanvas.destroySession(); }
      this.emit('notebooks-changed');
      return;
    }

    if (type === 'create') {
      try {
        const raw = await this.app.vault.adapter.read(path);
        const nb = JSON.parse(raw);
        if (!nb.id) return;
        if (this.notebooks.some((n) => n.id === nb.id)) return;
        if (!nb.pages) nb.pages = [];
        if (!nb.updatedAt) nb.updatedAt = Date.now();
        this.notebooks.push(nb);
        this.emit('notebooks-changed');
      } catch (_) {}
      return;
    }

    if (type === 'rename') {
      try {
        const raw = await this.app.vault.adapter.read(path);
        const nb = JSON.parse(raw);
        if (!nb.id) return;
        const existing = this.notebooks.find((n) => n.id === nb.id);
        if (!existing) return;
        if (!nb.updatedAt) nb.updatedAt = Date.now();
        if ((existing as any).updatedAt && nb.updatedAt < (existing as any).updatedAt) return;
        nb.updatedAt = Date.now();
        // P1-4: 保护 strokes — rename 事件也不应覆盖笔迹（与 modify 保持一致）
        const preservedStrokes = existing.pages.map(p => {
          const nbPage = nb.pages?.find((np: Page) => np.id === p.id);
          return nbPage ? { ...nbPage, strokes: p.strokes } : p;
        });
        Object.assign(existing, nb);
        existing.pages = preservedStrokes;
        this.emit('notebooks-changed');
      } catch (_) {}
      return;
    }

    if (type === 'modify') {
      try {
        const raw = await this.app.vault.adapter.read(path);
        const nb = JSON.parse(raw);
        if (!nb.id) return;
        const existing = this.notebooks.find((n) => n.id === nb.id);
        if (!existing) return;
        if (!nb.updatedAt) nb.updatedAt = Date.now();
        if ((existing as any).updatedAt && nb.updatedAt < (existing as any).updatedAt) return;
        nb.updatedAt = Date.now();
        // Fix 4: 只合并元数据，保护 strokes 不被 file overwrite 覆盖
        const preservedStrokes = existing.pages.map(p => {
          const nbPage = nb.pages?.find((np: Page) => np.id === p.id);
          return nbPage ? { ...nbPage, strokes: p.strokes } : p;
        });
        Object.assign(existing, nb);
        existing.pages = preservedStrokes;
        this.emit('notebooks-changed');
      } catch (_) {}
      return;
    }
  }

  async addNotebook(nb: Notebook) { this.notebooks.push(nb); await this.fileGateway.saveNotebook(nb); this.emit('notebooks-changed'); }

  async deleteNotebook(id: string) {
    const nb = this.notebooks.find((n) => n.id === id); if (!nb) return;
    const activeCanvas = this.layoutManager?.getActiveCanvas();
    console.log('[ENGINE LIFECYCLE]', {
      action: 'DELETE_NOTEBOOK',
      notebookId: id,
      activeEngineId: (activeCanvas?.session?.engine as any)?.id ?? 'none',
      activeEngineNotebookId: (activeCanvas?.session?.engine as any)?.notebookId ?? 'none',
    });
    await this.fileGateway.deleteNotebook(nb);
    this.notebooks = this.notebooks.filter((n) => n.id !== id);
    if (this.selectedNotebookId === id) { this.selectedNotebookId = null; this.emit('selection-changed'); }
    this.emit('notebooks-changed');
  }

  async renamePage(nbId: string, pId: string, title: string) {
    this.pageManager.updatePage(nbId, pId, { title });
  }

  async deletePage(nbId: string, pId: string) {
    this.pageManager.deletePage(nbId, pId);
  }

  recordLastPage(nbId: string, pId: string) { const nb = this.notebooks.find((n) => n.id === nbId); if (!nb) return; nb.lastPageId = pId; this.fileGateway.saveNotebook(nb); }

  /**
   * 单向调度：Page 数据变更 → Session 状态重建。
   * PageManager / UI 不直接接触 CanvasSession，统一走此入口。
   */
  requestPageChange(notebookId: string, pageId: string): void {
    const canvas = this.layoutManager?.getActiveCanvas();
    if (!canvas?.session?.isAlive()) return;

    // No page → clear canvas
    if (!pageId) {
      canvas.session.setStrokes([]);
      this.emit('selection-changed');
      return;
    }

    const nb = this.notebooks.find(n => n.id === notebookId);
    const page = nb?.pages.find(p => p.id === pageId);
    if (!page) return;

    canvas.session.loadPage(notebookId, page);
    this.emit('selection-changed');
  }

  createEngine(): CanvasRuntimeEngine {
    return new CanvasRuntimeEngine();
  }

  // ==========================================================
  //  Canvas entry — delegates to LayoutManager
  // ==========================================================

  async openCanvasForPage(notebookId: string, pageId: string) {
    this.recordLastPage(notebookId, pageId);
    // 更新 Notebook.activePageId
    const nb = this.notebooks.find(n => n.id === notebookId);
    if (nb) nb.activePageId = pageId;
    // 委托 mountCanvas（内部 createSession 会判断是切页还是重建）
    await this.layoutManager.mountCanvas(notebookId, pageId, 'main');
  }

  // --- Lifecycle ---

  // --- Lifecycle ---

  async onload() {
    console.log('[PLUGIN INSTANCE]', this);

    if (this._initialized) {
      console.warn('[BOOT] blocked duplicate init');
      return;
    }

    this._initialized = true;
    console.log('[BOOT] init start');

    await this._boot();
  }

  private async _boot() {
    console.log('[BOOT] running core init');

    this.fileGateway = new FileGateway(this.app);
    this.layoutManager = new CanvasLayoutManager(this.app, this);
    this.pageManager = new PageManager(this);
    this.notebooks = await this.fileGateway.loadNotebooks();
    console.log('[BOOT] gnnote files hydrated:', this.notebooks.length);

    this.registerView(NOTEBOOK_VIEW_TYPE, (leaf) => new NotebookView(leaf, this));
    this.registerView(PAGE_VIEW_TYPE, (leaf) => new PageView(leaf, this));
    this.registerView(CANVAS_VIEW_TYPE, (leaf) => new CanvasView(leaf, this));

    this.addRibbonIcon('pen-tool', 'GoodNote Max', () => this.openBothViews());

    this.app.workspace.onLayoutReady(() => {
      this.openBothViews();
      this.emit('notebooks-changed');
    });

    const vault = this.app.vault;
    vault.on('create', (file) => this.handleVaultEvent('create', file));
    vault.on('delete', (file) => this.handleVaultEvent('delete', file));
    vault.on('rename', (file, oldPath) => this.handleVaultEvent('rename', file, oldPath));
    vault.on('modify', (file) => this.handleVaultEvent('modify', file));

    // ==========================================================
    //  🩺 Runtime Stability Health Check（每 5s）
    // ==========================================================
    window.setInterval(() => {
      const registry = CanvasSessionRegistry.getInstance();
      const canvasCount = document.querySelectorAll('canvas').length;
      const sessionAlive = !!(registry.activeSession && !registry.activeSession.destroyed);

      console.assert(sessionAlive || canvasCount === 0,
        '❌ [HEALTH] No active session but canvases exist in DOM');
      if (sessionAlive) {
        console.assert(canvasCount === 1,
          `❌ [HEALTH] Canvas count ≠ 1 (actual: ${canvasCount})`);
      }

      console.log('[SESSION HEALTH]', {
        canvasCount,
        sessionAlive,
        sessionDestroyed: registry.activeSession?.destroyed ?? null,
        sessionId: registry.sessionId || 'none',
        timestamp: new Date().toISOString(),
      });
    }, 5000);
  }

  private async openBothViews() {
    if (!this.safeBootCheck('openBothViews')) return;
    const { workspace } = this.app;
    let l = workspace.getLeavesOfType(NOTEBOOK_VIEW_TYPE)[0];
    if (!l) { const leaf = workspace.getLeftLeaf(false); if (leaf) await leaf.setViewState({ type: NOTEBOOK_VIEW_TYPE, active: true }); }
    else workspace.revealLeaf(l);
    let r = workspace.getLeavesOfType(PAGE_VIEW_TYPE)[0];
    if (!r) { const leaf = workspace.getRightLeaf(false); if (leaf) await leaf.setViewState({ type: PAGE_VIEW_TYPE, active: true }); }
    else workspace.revealLeaf(r);
  }
}

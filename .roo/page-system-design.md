# Page System Design — GoodNote Max

## 架构现状分析

### 现有问题

| 问题 | 当前行为 | 期望行为 |
|------|----------|----------|
| [`Page`](main.ts:78) 数据结构极简 | 仅 `id/title/content` | 需要 timestamps / thumbnail / background |
| [`Notebook`](main.ts:285) 无 `activePageId` | 依赖外部 `UIState` 追踪 | Notebook 自身持有当前页引用 |
| [`CanvasSession.createSession()`](main.ts:1383) 切页时销毁重建 | destroy + new CanvasSession | 仅切换 engine 数据引用 |
| [`CanvasRuntimeEngine.load()`](main.ts:632) 无切换机制 | 只有初始 load | 需要 `switchPage()` 零开销切换 |
| Engine commit 写回 page | 有，但耦合在 setTimeout | 应显式 sync |
| 无 PageManager | 操作散落在 Plugin | 集中管理 |

---

## 1. 核心数据结构（TS）

### 1.1 Page

```ts
interface PageData {
  /** 全局唯一 ID，持久化到文件 */
  id: string;

  /** 页面标题（可编辑） */
  title: string;

  /** 页面索引（在 notebook 中的顺序，0-based） */
  index: number;

  /** --- 核心数据 --- */

  /** 笔迹数据 — 这是 Page 的唯一数据源 */
  strokes: Stroke[];

  /** 页面背景配置 */
  background: PageBackground;

  /** --- 元数据 --- */

  /** ISO 8601 创建时间 */
  createdAt: string;

  /** ISO 8601 最后修改时间 */
  updatedAt: string;

  /** --- 可选数据 --- */

  /** 缩略图（base64 png，用于 page 预览） */
  thumbnail?: string;

  /** 页面自定义尺寸（默认继承 notebook） */
  size?: { width: number; height: number };

  /** 页面级视口偏移（滚动位置记忆） */
  viewportOffset?: { x: number; y: number; scale: number };
}

interface PageBackground {
  type: 'blank' | 'ruled' | 'grid' | 'dot' | 'custom';
  color: string;        // '#ffffff'
  lineColor?: string;   // 线条颜色
  spacing?: number;     // 行间距 / 网格间距
}
```

### 1.2 Notebook

```ts
interface NotebookData {
  /** 全局唯一 ID */
  id: string;

  /** 笔记本名称 */
  name: string;

  /** --- Page 管理 --- */

  /** 所有 page 的有序列表 */
  pages: PageData[];

  /** 当前活跃 page ID */
  activePageId: string | null;

  /** 下次新建 page 的 index（用于插入位置） */
  nextPageIndex: number;

  /** --- 元数据 --- */

  createdAt: string;
  updatedAt: string;

  /** --- UI 状态（不持久化到数据层，仅内存） --- */

  isPinned?: boolean;
  lastPageId?: string;          // 上次打开的 page（用于恢复）
}

/** 序列化到 .gnnote 文件的结构 */
interface NotebookPersisted {
  id: string;
  name: string;
  pages: PageData[];
  activePageId: string | null;
  nextPageIndex: number;
  createdAt: string;
  updatedAt: string;
}
```

### 1.3 Stroke 绑定规则（关键）

```
┌─────────────────────────────────────────────────┐
│                  Notebook                       │
│  ┌───────────────────────────────────────────┐  │
│  │             NotebookData                  │  │
│  │  pages: PageData[]                       │  │
│  │    ├─ PageData { strokes: Stroke[] }     │  │  ← 唯一数据源
│  │    ├─ PageData { strokes: Stroke[] }     │  │
│  │    └─ PageData { strokes: Stroke[] }     │  │
│  │  activePageId ─────────────────────┐      │  │
│  └────────────────────────────────────┼──────┘  │
└───────────────────────────────────────┼─────────┘
                                        │ 引用
                                        ▼
┌─────────────────────────────────────────────────┐
│            CanvasSession (Renderer)             │
│  ┌───────────────────────────────────────────┐  │
│  │         CanvasRuntimeEngine               │  │
│  │  strokes: Stroke[]  ← 指向 activePage    │  │  ← 运行时引用
│  │  notebookId: string                       │  │
│  │  pageId: string                           │  │
│  └───────────────────────────────────────────┘  │
│  canvasEl (HTMLCanvasElement)  ← 单例         │
└─────────────────────────────────────────────────┘
```

**规则**：
1. Stroke 永远只属于 Page，不属于 Canvas / Engine
2. Engine 的 `strokes` 是指向当前 activePage 的**引用**（或浅拷贝）
3. 写入路径：`User Input → Engine.strokes.push() → Page.strokes`
4. Engine.commit() 是同步写回：`page.strokes = engine.strokes`

---

## 2. 状态流设计

### 2.1 切 Page（核心路径）

```
User Action (点击 page 列表)
    │
    ▼
AppState.setActivePage(notebookId, pageId)
    │
    ├─ ① NotebookData.activePageId = pageId
    │
    ├─ ② Engine.switchPage(notebookId, pageId)
    │      ├─ commitPending()          // 先保存当前 page 的脏数据
    │      ├─ this.notebookId = nid
    │      ├─ this.pageId = pid
    │      ├─ this.strokes = page.strokes  // 指针切换，非深拷贝
    │      └─ this.isDrawing = false
    │
    └─ ③ CanvasSession.markDirty()
           └─ renderFrame()            // 重新绘制新 page 的 strokes
```

**关键**：不销毁 CanvasSession，不重建 canvas DOM，不重建 engine。

### 2.2 写 Stroke

```
User pointer events
    │
    ▼
ToolSystem.onPointerDown/Move/Up
    │
    ▼
Engine.startStroke(pt)  →  this.currentStroke = new Stroke(...)
    │                       this.strokes.push(this.currentStroke)
    ▼
Engine.addPoint(pt)     →  this.currentStroke.points.push(...)
    │
    ▼
Engine.endStroke()      →  this.currentStroke = null
    │
    ▼
Engine.commit()         →  PageData.strokes = this.strokes  (引用赋值)
    │                       NotebookData.updatedAt = now
    │
    ▼
FileGateway.saveNotebook(notebook)  (debounced 80ms)
```

### 2.3 删除 Page

```
User Action (删除 page)
    │
    ▼
PageManager.deletePage(notebookId, pageId)
    │
    ├─ ① 检查是否是 activePage
    │      ├─ 是 → 先 switch 到相邻 page（或 null）
    │      └─ 否 → 跳过
    │
    ├─ ② NotebookData.pages.splice(index, 1)
    │
    ├─ ③ 重新计算所有 page.index
    │
    ├─ ④ NotebookData.updatedAt = now
    │
    └─ ⑤ FileGateway.saveNotebook(notebook)
           └─ emit('notebooks-changed')
```

### 2.4 新建 Page

```
User Action (新建 page)
    │
    ▼
PageManager.createPage(notebookId, title?)
    │
    ├─ ① 创建 PageData
    │      page = {
    │        id: genId(),
    │        title: title || `Page ${notebook.nextPageIndex + 1}`,
    │        index: notebook.nextPageIndex,
    │        strokes: [],
    │        background: { type: 'blank', color: '#ffffff' },
    │        createdAt: new Date().toISOString(),
    │        updatedAt: new Date().toISOString(),
    │      }
    │
    ├─ ② NotebookData.pages.push(page)
    │      NotebookData.nextPageIndex++
    │
    ├─ ③ AppState.setActivePage(notebookId, page.id)
    │      → 自动触发切页渲染
    │
    └─ ④ FileGateway.saveNotebook(notebook)
```

---

## 3. CanvasSession 与 Page 的绑定方式

### 3.1 当前问题

当前 [`CanvasSession`](main.ts:1065) 构造函数接收 `notebookId` 和 `pageId`，内部创建 engine 并 load。切页时 [`CanvasView.createSession()`](main.ts:1383) 调用 `destroySession()` + `new CanvasSession()`，这导致：

- canvas DOM 被销毁再创建
- 所有事件监听器重新绑定
- 视口状态丢失
- 不必要的 GC 压力

### 3.2 新设计：Session 持久化 + Engine 切换

```ts
class CanvasSession {
  // ... 现有字段 ...

  /**
   * 切换 page — 仅更新 engine 数据引用，不重建任何 DOM
   *
   * @returns true 表示切换成功，false 表示 page 不存在
   */
  switchPage(notebookId: string, pageId: string): boolean {
    this.assertAlive();

    // ① 提交当前脏数据
    this.engine.commitNow();

    // ② 重新加载目标 page
    const loaded = this.engine.load(notebookId, pageId);
    if (!loaded) return false;

    // ③ 更新内部引用
    this.notebookId = notebookId;
    this.pageId = pageId;

    // ④ 触发重绘
    this.markDirty();

    return true;
  }
}
```

### 3.3 CanvasSession 绑定契约

```
CanvasSession
  ├── canvasEl: HTMLCanvasElement        ← 永久单例，绝不重建
  ├── ctx: CanvasRenderingContext2D       ← 同上
  ├── viewport: Viewport                  ← 持久化（可被 page.viewportOffset 覆盖）
  ├── engine: CanvasRuntimeEngine         ← 存活，仅数据引用切换
  │     ├── notebookId: string
  │     ├── pageId: string
  │     └── strokes: Stroke[]             ← 指向 activePage.strokes
  └── toolInstance: ITool                 ← 不随 page 变化
```

---

## 4. Page 操作 API 设计

### 4.1 PageManager 类

```ts
class PageManager {
  constructor(private plugin: GoodNoteMaxPlugin) {}

  // ============ CRUD ============

  /**
   * 创建新 page 并自动设为 active
   * @returns 新创建的 PageData
   */
  createPage(notebookId: string, title?: string): PageData | null;

  /**
   * 删除 page，如果删除的是 activePage 则自动切换到相邻 page
   * @returns 是否删除成功
   */
  deletePage(notebookId: string, pageId: string): boolean;

  /**
   * 切换 active page（零开销，不重建 canvas）
   * @returns 是否切换成功
   */
  switchPage(notebookId: string, pageId: string): boolean;

  /**
   * 更新 page 元数据（title / background 等），不影响 strokes
   */
  updatePage(notebookId: string, pageId: string, patch: Partial<Pick<PageData, 'title' | 'background' | 'thumbnail'>>): boolean;

  // ============ 排序 ============

  /**
   * 移动 page 到指定 index（拖拽排序）
   */
  movePage(notebookId: string, pageId: string, targetIndex: number): boolean;

  /**
   * 复制 page（深拷贝 strokes）
   */
  duplicatePage(notebookId: string, pageId: string): PageData | null;

  // ============ 查询 ============

  /** 获取当前 active page */
  getActivePage(notebookId: string): PageData | null;

  /** 获取 notebook 的所有 pages */
  getPages(notebookId: string): PageData[];

  /** 获取 page 的 strokes 总数（用于 UI 信息展示） */
  getStrokeCount(notebookId: string, pageId: string): number;

  // ============ 缩略图 ============

  /**
   * 生成当前 page 的缩略图（调用 canvas.toDataURL）
   */
  generateThumbnail(notebookId: string, pageId: string): string | null;
}
```

### 4.2 调用示例（在 Plugin 中）

```ts
// 在 GoodNoteMaxPlugin 中：
private pageManager!: PageManager;

async onload() {
  // ...
  this.pageManager = new PageManager(this);
}

// 新建 page
newPage() {
  const nb = this.getSelectedNotebook();
  if (!nb) return;
  this.pageManager.createPage(nb.id);
}

// 切页
switchToPage(pageId: string) {
  const nb = this.getSelectedNotebook();
  if (!nb) return;
  this.pageManager.switchPage(nb.id, pageId);
}

// 删页
deletePage(pageId: string) {
  const nb = this.getSelectedNotebook();
  if (!nb) return;
  this.pageManager.deletePage(nb.id, pageId);
}
```

### 4.3 Engine 改造（最小侵入）

```ts
class CanvasRuntimeEngine {
  // 现有字段保持不变...

  /**
   * 加载 page 数据 — 返回是否成功
   * 如果 notebookId/pageId 与当前相同，跳过（幂等）
   */
  load(notebookId: string, pageId: string): boolean {
    // 先提交当前脏数据
    this.commitNow();

    const nb = this.plugin?.getNotebooks()?.find(n => n.id === notebookId);
    const page = nb?.pages.find(p => p.id === pageId);
    if (!page) return false;

    this.notebookId = notebookId;
    this.pageId = pageId;

    // 确保 page 有 strokes 数组
    if (!page.strokes) page.strokes = [];

    // 直接引用 page 的 strokes（非拷贝）
    this.strokes = page.strokes;

    return true;
  }

  /**
   * 同步提交（替代 setTimeout 版本）
   */
  commitNow(): void {
    if (this.commitTimer) {
      clearTimeout(this.commitTimer);
      this.commitTimer = null;
    }
    this.syncToPage();
  }

  /** 异步提交（保留用于 debounce） */
  commit(): void {
    if (this.commitTimer) clearTimeout(this.commitTimer);
    this.commitTimer = window.setTimeout(() => this.syncToPage(), 80);
  }

  private syncToPage(): void {
    if (!this.plugin) return;
    const nb = this.plugin.getNotebooks().find(n => n.id === this.notebookId);
    const page = nb?.pages.find(p => p.id === this.pageId);
    if (!page) return;

    // 🔑 关键：直接引用赋值（engine.strokes 就是 page.strokes 的引用）
    // 只有当 engine 创建了新的 strokes 数组时才需要赋值
    page.strokes = this.strokes;
    page.updatedAt = new Date().toISOString();

    // 异步持久化
    this.plugin.fileGateway.saveNotebook(nb);
  }
}
```

---

## 5. 为什么 "canvas 不存 page 数据" 是正确设计

### 5.1 架构对比

```
❌ 错误：Canvas = Data Owner
┌───────────────────────┐
│    Canvas (Data)      │  ← stroke 存在 canvas 里
│  ┌─────────────────┐  │
│  │ strokes[]       │  │
│  │ render()        │  │
│  └─────────────────┘  │
└───────────────────────┘
切页 = 销毁 canvas → 丢失数据 → 需要序列化 → 重建 canvas → 反序列化

✅ 正确：Page = Data Owner, Canvas = Renderer
┌──────────────┐     ┌──────────────────────┐
│  PageData    │────▶│  CanvasSession       │
│  strokes[]   │     │  engine.strokes (ref)│
│  metadata    │     │  canvasEl (DOM)      │
└──────────────┘     │  render()            │
                     └──────────────────────┘
切页 = page.strokes 引用切换 → markDirty() → renderFrame()
```

### 5.2 五个关键理由

| # | 理由 | 说明 |
|---|------|------|
| 1 | **数据生命周期独立于渲染** | Page 数据持久化到 `.gnnote` 文件，canvas DOM 随时可销毁重建。如果数据在 canvas 里，关闭视图 = 数据丢失。 |
| 2 | **零开销切换** | 不重建 canvas DOM 就能切换 page，仅改变 engine.strokes 引用 + 触发 renderFrame。GoodNotes 能做到无缝翻页正是这个原因。 |
| 3 | **Undo/Redo 天然支持** | 每个 page 独立持有 strokes 历史快照。undo = 回退当前 page 的 strokes 数组。不需要 canvas 参与。 |
| 4 | **多视图兼容（未来）** | 如果将来需要缩略图预览、导出 PDF、OCR 识别，都直接从 PageData 读取 strokes，不需要访问 canvas。 |
| 5 | **测试友好** | PageData 是纯数据，可以脱离 DOM 进行单元测试。Canvas 渲染逻辑可以 mock strokes 数组独立测试。 |

### 5.3 禁止事项

```
🚫 page = canvas          — Page 是数据，Canvas 是渲染器
🚫 多个 canvas DOM         — 全局唯一 canvas，通过 CanvasSessionRegistry 强制
🚫 UI 驱动数据             — 数据流是从 User → ToolSystem → Engine → PageData → File
🚫 stroke 脱离 page        — stroke 只存在于 page.strokes，engine.strokes 是指向它的引用
```

---

## 6. 迁移方案（从当前代码到新设计的改动清单）

### 6.1 改动范围

| 文件 | 改动 | 影响 |
|------|------|------|
| [`main.ts`](main.ts:78) `Page` | 扩展为 `PageData` | 新增字段，向后兼容 |
| [`main.ts`](main.ts:285) `Notebook` → `NotebookData` | 新增 `activePageId`, `nextPageIndex`, `createdAt`, `updatedAt` | 修改 |
| [`main.ts`](main.ts:614) `CanvasRuntimeEngine` | 新增 `commitNow()`, 改造 `load()` 返回 boolean | 修改 |
| [`main.ts`](main.ts:1065) `CanvasSession` | 新增 `switchPage()` | 新增方法 |
| [`main.ts`](main.ts:1340) `CanvasView` | `createSession` 不再销毁重建 | 关键修改 |
| **新增** `PageManager` 类 | 集中 page 操作 | 新增 80 行 |
| [`main.ts`](main.ts:1960) Plugin | 委托给 PageManager | 修改 |

### 6.2 向后兼容

```ts
// 旧数据迁移：加载时自动补全缺失字段
function migratePage(raw: any): PageData {
  return {
    id: raw.id || genId(),
    title: raw.title || 'Untitled',
    index: raw.index ?? 0,
    strokes: raw.strokes || raw.content?.strokes || [],
    background: raw.background || { type: 'blank', color: '#ffffff' },
    createdAt: raw.createdAt || new Date().toISOString(),
    updatedAt: raw.updatedAt || new Date().toISOString(),
    thumbnail: raw.thumbnail,
    size: raw.size,
    viewportOffset: raw.viewportOffset,
  };
}
```

---

## 7. 数据流总览图

```
┌──────────────────────────────────────────────────────────────────┐
│                        USER INPUT                                 │
│                  PointerEvent (pen/eraser/hand)                   │
└──────────────────────────┬───────────────────────────────────────┘
                           │
                           ▼
┌──────────────────────────────────────────────────────────────────┐
│                      TOOL SYSTEM                                  │
│  PenTool / EraserTool / HandTool                                  │
│  └─ onPointerDown/Move/Up(session)                               │
└──────────────────────────┬───────────────────────────────────────┘
                           │ session.engine.startStroke / addPoint / endStroke
                           ▼
┌──────────────────────────────────────────────────────────────────┐
│                 CanvasRuntimeEngine                                │
│  strokes: Stroke[]  ────────────── 指向 ─────────────┐           │
│  commit() / commitNow()                              │           │
└──────────────────────────┬───────────────────────────┼───────────┘
                           │ markDirty()               │
                           ▼                           │
┌──────────────────────────────────────────────────────┼───────────┐
│                 CanvasSession                         │           │
│  canvasEl (单例 DOM)                                 │           │
│  renderFrame() ← 读取 engine.strokes                 │           │
└──────────────────────────────────────────────────────┼───────────┘
                                                       │
                                                       ▼
┌──────────────────────────────────────────────────────────────────┐
│                    PAGE DATA (唯一数据源)                          │
│  PageData {                                                       │
│    id, title, index,                                              │
│    strokes: Stroke[]  ◀──────── engine.strokes 指向这里           │
│    background, createdAt, updatedAt, thumbnail                    │
│  }                                                                │
└──────────────────────────┬───────────────────────────────────────┘
                           │ PageManager.switchPage()
                           │ PageManager.createPage()
                           │ PageManager.deletePage()
                           ▼
┌──────────────────────────────────────────────────────────────────┐
│                    NOTEBOOK DATA                                   │
│  NotebookData {                                                   │
│    pages: PageData[],                                             │
│    activePageId,                                                  │
│    name, createdAt, updatedAt                                     │
│  }                                                                │
└──────────────────────────┬───────────────────────────────────────┘
                           │ FileGateway.saveNotebook()
                           ▼
┌──────────────────────────────────────────────────────────────────┐
│                   FILE SYSTEM (.gnnote)                            │
│  GoodNoteMax/notebook-name.gnnote                                 │
└──────────────────────────────────────────────────────────────────┘
```

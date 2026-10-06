# 日程管家合并到项目管理 — 设计文档

日期：2026-09-15
状态：已确认（导航层合并 + 项目任务 DDL 上日历）

## 背景

左侧工作模块导航中的「日程管家」（`CalendarModuleView`，含 ScheduleView 日程视图 + CalendarSyncView 日历同步）是独立核心模块。用户要求合并进「项目管理」，同时日程视图除系统日程同步外，还要展示项目任务的截止日期（DDL）。

现状：
- 日程数据独立存储（`~/.proma/schedule-*.jsonl`），IPC 为 `paa.schedule.*` / `paa.calendarSync.*`
- 项目任务存 SQLite `tasks` 表，`dueDate` 字段已存在（本日刚完成 DDL 徽标展示）
- 跨项目任务聚合已有先例：`listTasksCreatedBy`（project-sqlite-store.ts:1657）

## 需求（用户已确认）

1. 合并深度：**导航层合并**（数据不动，不做 ScheduleTask 与项目 Task 的数据层统一）
2. 入口位置：**模块顶层子视图**（项目管理顶层切换：项目 | 我的工作 | 看板 | 团队 | 日程管家 | 日历同步）
3. 日程视图新增展示**项目任务 DDL**（按 dueDate 落在当日）

## 设计

### Part 1：导航层合并

**1.1 左侧导航移除「日程管家」**（`work-module-registry.ts`）
- `calendar` 条目从 `WORK_MODULE_REGISTRY` 删除
- `WORK_MODULE_VIEWS` **保留** `calendar: CalendarModuleView` 映射（防止旧的持久化 activeView 值跳转白屏）
- `ActiveView` 类型**保留** `'calendar'` 成员（删除会波及设置面板等多处，收益小）

**1.2 项目管理顶层加子视图**（`ProjectView.tsx`）
- `activeTab` 类型扩展：`'projects' | 'my-work' | 'board' | 'team' | 'schedule' | 'sync'`
- `ProjectHeader` tab 列表追加：`{ key: 'schedule', label: '日程管家' }`、`{ key: 'sync', label: '日历同步' }`
- 渲染区追加两个分支，组件从 `calendar/` 目录直接 import（**原地复用，不搬目录**）：
  - `activeTab === 'schedule'` → `<ScheduleView hideHeader />`
  - `activeTab === 'sync'` → `<CalendarSyncView hideHeader />`
- 两个 tab 仅在**项目列表层**（未选中具体项目时）显示；项目详情内不加

**1.3 ScheduleView / CalendarSyncView 加 `hideHeader` prop**
- ScheduleView 自带顶栏（返回对话 + 日程/同步切换），合并后与项目管理 header 重复
- 加可选 prop `hideHeader?: boolean`（默认 false，不影响潜在其他调用方），为 true 时不渲染顶栏
- CalendarSyncView 若有同类顶栏同样处理；若无则不加

### Part 2：项目任务 DDL 上日程视图

**2.1 新 IPC：`listAllProjectTasksLite`**
- 主进程 `project-service.ts` 新增 `listAllProjectTasksLite(): ProjectTaskLite[]`
- 聚合模式复用 `listTasksCreatedBy`：遍历 `listProjects()` → 每项目 `listTasks`（含语义组解析 `listTaskStatuses`）
- 过滤：剔除 draft 状态；剔除 completed/cancelled 语义组；只保留**有 dueDate** 的任务
- 返回轻量结构（不传 assignee/依赖/权限等大字段）：
  ```ts
  interface ProjectTaskLite {
    id: string
    projectId: string
    projectTitle: string
    title: string
    status: string          // 原始状态 id
    stateGroup: string      // 语义组（started/unstarted 等）
    priority: 'low' | 'medium' | 'high' | 'critical'
    dueDate: number         // 已过滤，必有
  }
  ```
- preload `paa.project.listAllProjectTasksLite` + IPC 通道常量 + handler 四处同步（仓库 IPC 惯例）

**2.2 渲染层适配（ScheduleView 内）**
- 新增加载逻辑（ScheduleView 文件内的 `useProjectTasksLite` 小 hook 或就地 useEffect）：
  - 挂载时拉取一次；日程视图手动刷新按钮触发重拉；**不做实时订阅**
- 映射为 `ScheduleTask` 形状与现有任务合流：
  - `status`: started→`'in-progress'`，unstarted/backlog/triage→`'todo'`
  - `dueDate`: `dueDate` 时间戳 → `YYYY-MM-DD`（本地时区，注意 zh-CN locale 斜杠坑，用 padStart 手工拼）
  - `id` 加前缀 `project-<id>` 防与 ScheduleTask id 冲突
- **月历网格（CalendarGrid）与右侧日详情**：项目任务与日程任务合并渲染；项目任务卡片加项目名前缀徽标（`📁 <项目名>`）区分；第一版点击仅 tooltip 展示项目名，不做跨模块跳转
- **任务看板（TaskBoard）不合并**项目任务——四列状态流是日程任务自有语义，混入会语义混乱
- 任务看板上方或日详情中项目任务数量如有需要可后续加角标，第一版不做

### 错误处理

- `listAllProjectTasksLite` 失败：项目任务区静默降级为空（日历仍显示日程事件），console.error 记录
- `hideHeader` 缺省时行为与现状完全一致（向后兼容）

### 不改动

- SQLite schema、schedule JSONL 存储、现有 schedule/calendarSync IPC
- TaskBoard 四列逻辑、自然语言创建、多日历同步流程
- 设置面板「日历同步」tab（系统日历授权设置，与视图无关）

## 测试（BDD）

- 主进程：`listAllProjectTasksLite` 过滤逻辑（draft 剔除/完成组剔除/无 dueDate 剔除/projectTitle 拼装）——bun test，sql.js 分支注意逐次 prepare（sqljs-statement-closed skill）
- 渲染层映射：语义组→ScheduleTask.status 映射、时间戳→YYYY-MM-DD 本地时区转换——纯函数 + bun test
- `hideHeader`：typecheck + 手工验证（默认渲染顶栏、传 true 隐藏）

## 版本

`@proma/electron` patch +1（提交时递增）。

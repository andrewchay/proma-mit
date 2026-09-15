# 日程管家合并到项目管理 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 左侧导航移除「日程管家」，日程/日历同步并入项目管理顶层子视图；日程视图新增展示项目任务 DDL。

**Architecture:** 导航层合并（注册表删除 calendar 条目、ProjectView 加 tab、ScheduleView/CalendarSyncView 加 hideHeader prop）。项目任务 DDL 走适配层：新 IPC `listAllProjectTasksLite`（跨项目聚合轻量结构）→ 渲染层映射为 ScheduleTask 形状合流渲染；数据存储零迁移。

**Tech Stack:** React 18 + Jotai + Electron IPC + bun:test（BDD）

**Spec:** `docs/superpowers/specs/2026-09-15-merge-schedule-into-projects-design.md`

---

### Task 1: `listAllProjectTasksLite` 主进程聚合函数（TDD）

**Files:**
- Modify: `apps/electron/src/main/lib/project-service.ts`（`listTaskStatuses` 后追加）
- Test: `apps/electron/src/main/lib/project-service.test.ts`（已存在，追加 describe；若无此文件则在同目录新建并参考 `project-agent-service.test.ts` 的 sql.js 测试基建）

- [ ] **Step 1: 写失败测试**

在 `project-service.test.ts` 追加（若新建文件，先复制 `project-agent-service.test.ts` 头部的 sql.js 初始化段——注意 bun test 分支 SqlJsStmt 每次循环内必须逐次 prepare）：

```ts
describe('listAllProjectTasksLite', () => {
  test('过滤 draft / 完成组 / 无 dueDate，拼装 projectTitle 与 stateGroup', () => {
    // 建两个项目 + 各自任务：
    // p1: t-overdue（dueDate 昨天，in_progress）、t-no-due（无 dueDate，pending）、t-done（dueDate 明天，completed）
    // p2: t-draft（dueDate 明天，draft）、t-future（dueDate 后天，pending）
    // 期望返回 [t-overdue(p1), t-future(p2)]，projectTitle 正确，stateGroup 分别 started/unstarted
    const result = listAllProjectTasksLite()
    const ids = result.map((t) => t.id)
    expect(ids).toContain('t-overdue')
    expect(ids).toContain('t-future')
    expect(ids).not.toContain('t-no-due')   // 无 dueDate
    expect(ids).not.toContain('t-done')     // 完成组
    expect(ids).not.toContain('t-draft')    // draft
    const overdue = result.find((t) => t.id === 't-overdue')!
    expect(overdue.projectTitle).toBe('项目一')
    expect(overdue.stateGroup).toBe('started')
    expect(overdue.dueDate).toBeTypeOf('number')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /Users/chaihao/.proma/agent-workspaces/proma-mit/project && bun test apps/electron/src/main/lib/project-service.test.ts`
Expected: FAIL（`listAllProjectTasksLite` 未导出）

- [ ] **Step 3: 最小实现**

`project-service.ts` 在 `listTaskStatuses`（约 387 行）后追加。需确认顶部 import 补 `resolveStateGroup`（自 `./task-status-logic`）与 `TaskStateGroup` 类型（自 `@gravitas/shared` 或既有 import 路径——跟随文件内已有 import）：

```ts
/** 日程视图用：跨项目轻量任务（仅有 dueDate 且未完成、非 draft） */
export interface ProjectTaskLite {
  id: string
  projectId: string
  projectTitle: string
  title: string
  status: string
  stateGroup: string
  priority: 'low' | 'medium' | 'high' | 'critical'
  dueDate: number
}

export async function listAllProjectTasksLite(): Promise<ProjectTaskLite[]> {
  const projects = await listProjects()
  const result: ProjectTaskLite[] = []
  for (const project of projects) {
    const statuses = await store.listTaskStatuses(project.id)
    const tasks = await store.listTasks(project.id, { includeSubTasks: false, includeDrafts: true })
    for (const task of tasks) {
      if (task.dueDate === undefined) continue
      const group = resolveStateGroup(task.status, statuses)
      if (group === 'completed' || group === 'cancelled') continue
      // includeDrafts: true 拿到全量后在这里显式剔 draft（draft 组不上日历）
      if (resolveStateGroup(task.status, statuses) === ('draft' as TaskStateGroup)) continue
      result.push({
        id: task.id,
        projectId: task.projectId,
        projectTitle: project.title,
        title: task.title,
        status: task.status,
        stateGroup: group,
        priority: task.priority,
        dueDate: task.dueDate,
      })
    }
  }
  return result.sort((a, b) => a.dueDate - b.dueDate)
}
```

注意：draft 的语义组是 `'backlog'` 不是 `'draft'`（见 task-status-logic `BUILTIN_STATUS_GROUPS`）。draft 判定直接用已导出的 `isDraftStatusId(task.status)`（自 `./task-status-logic`），比语义组更直白。上面 `if (... === 'draft')` 一行应写成：

```ts
      if (isDraftStatusId(task.status)) continue
```

（`store.listTasks` 的 `includeDrafts: false` 默认已剔 draft，因此更简单的做法是传 `{ includeSubTasks: false }` 用默认过滤，删掉 draft 判断——以实测为准，二选一保持最简。）

- [ ] **Step 4: 跑测试确认通过**

Run: `cd /Users/chaihao/.proma/agent-workspaces/proma-mit/project && bun test apps/electron/src/main/lib/project-service.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
cd /Users/chaihao/.proma/agent-workspaces/proma-mit/project
git add apps/electron/src/main/lib/project-service.ts apps/electron/src/main/lib/project-service.test.ts
git commit -m "feat: 跨项目轻量任务聚合 listAllProjectTasksLite"
```

---

### Task 2: IPC 四件套接线

**Files:**
- Modify: `packages/shared/src/types/work-module.ts:203-205`（`PROJECT_IPC_CHANNELS`）
- Modify: `apps/electron/src/main/lib/work-module-ipc-handlers.ts`（`LIST_MY_WORK` handler 附近）
- Modify: `apps/electron/src/preload/index.ts:3888` 附近（`project` API 段）+ `:1651` 附近（类型声明段）

- [ ] **Step 1: 通道常量**

`work-module.ts` 的 `PROJECT_IPC_CHANNELS` 中 `LIST_TASKS_CREATED_BY` 行后加：

```ts
  /** 日程视图：跨项目轻量任务（有 dueDate 且未完成） */
  LIST_ALL_PROJECT_TASKS_LITE: 'project:list-all-project-tasks-lite',
```

- [ ] **Step 2: 主进程 handler**

`work-module-ipc-handlers.ts` 在 `LIST_MY_WORK` handler（679 行）后加（确认该文件已 import `listAllProjectTasksLite`——跟随 `listMyWork` 的动态 import 或顶部静态 import 风格）：

```ts
  ipcMain.handle(PROJECT_IPC_CHANNELS.LIST_ALL_PROJECT_TASKS_LITE, async () => {
    return listAllProjectTasksLite()
  })
```

- [ ] **Step 3: preload 类型声明 + 实现**

`preload/index.ts` 类型声明段（`project:` 内，`listTasksCreatedBy` 声明后）加：

```ts
      listAllProjectTasksLite: () => Promise<import('@gravitas/shared').ProjectTaskLite[]>
```

（若 `ProjectTaskLite` 不便从 shared 导出，就地声明结构相同的内联类型亦可——保持与文件内其他声明的风格一致。）

实现段（`listTasksCreatedBy` 实现行后）加：

```ts
      listAllProjectTasksLite: () => ipcRenderer.invoke(PROJECT_IPC_CHANNELS.LIST_ALL_PROJECT_TASKS_LITE),
```

- [ ] **Step 4: 类型检查**

Run: `cd /Users/chaihao/.proma/agent-workspaces/proma-mit/project/apps/electron && bun run typecheck`
Expected: 无错误

- [ ] **Step 5: 提交**

```bash
cd /Users/chaihao/.proma/agent-workspaces/proma-mit/project
git add packages/shared/src/types/work-module.ts apps/electron/src/main/lib/work-module-ipc-handlers.ts apps/electron/src/preload/index.ts
git commit -m "feat: listAllProjectTasksLite IPC 四件套接线"
```

---

### Task 3: ScheduleView 加 `hideHeader` prop + 项目任务 DDL 合流（TDD）

**Files:**
- Modify: `apps/electron/src/renderer/components/calendar/ScheduleView.tsx`
- Test: `apps/electron/src/renderer/components/projects/schedule-task-mapping.test.ts`（新建）

- [ ] **Step 1: 映射纯函数（TDD）**

新建 `apps/electron/src/renderer/components/projects/schedule-task-mapping.ts`：

```ts
/**
 * 项目任务 → 日程视图映射（schedule-task-mapping）
 *
 * listAllProjectTasksLite 的轻量结构 → ScheduleTask 形状，供月历/日详情合流渲染。
 * 纯展示适配：TaskBoard 四列看板不消费项目任务（状态流语义不同）。
 */
import type { ProjectTaskLite } from './project-task-lite'
import type { ScheduleTask } from '@/atoms/paa-atoms'

/** 语义组 → 日程任务状态（started→in-progress，其余→todo；完成组已被主进程过滤） */
export function projectStateGroupToScheduleStatus(stateGroup: string): ScheduleTask['status'] {
  return stateGroup === 'started' ? 'in-progress' : 'todo'
}

/** 时间戳 → 本地 YYYY-MM-DD（手工 padStart 拼，勿用 toLocaleDateString——zh-CN 输出斜杠） */
export function timestampToDueDate(timestamp: number): string {
  const d = new Date(timestamp)
  return `${String(d.getFullYear()).padStart(4, '0')}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** 优先级映射：项目 critical → 日程 urgent，其余同名直过 */
export function projectPriorityToSchedulePriority(priority: ProjectTaskLite['priority']): ScheduleTask['priority'] {
  return priority === 'critical' ? 'urgent' : priority
}

/** 轻量项目任务 → ScheduleTask 形状（id 加 project- 前缀防冲突） */
export function projectTaskToScheduleTask(task: ProjectTaskLite): ScheduleTask {
  return {
    id: `project-${task.id}`,
    title: task.title,
    status: projectStateGroupToScheduleStatus(task.stateGroup),
    priority: projectPriorityToSchedulePriority(task.priority),
    dueDate: timestampToDueDate(task.dueDate),
    category: `project:${task.projectTitle}`,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
}
```

（`ProjectTaskLite` interface 从 Task 1 的 `project-service.ts` 迁到 `packages/shared/src/types/work-module.ts` 导出，`apps/electron/src/renderer/components/projects/project-task-lite.ts` 仅 `export type { ProjectTaskLite } from '@gravitas/shared'` 转发——跟随本仓「shared 定义类型」惯例；若 Task 2 已把类型放 shared，这里直接 import。）

新建测试 `schedule-task-mapping.test.ts`：

```ts
import { describe, expect, test } from 'bun:test'
import { projectStateGroupToScheduleStatus, timestampToDueDate, projectPriorityToSchedulePriority, projectTaskToScheduleTask } from './schedule-task-mapping'

describe('项目任务映射到日程视图', () => {
  test('语义组 → 日程状态', () => {
    expect(projectStateGroupToScheduleStatus('started')).toBe('in-progress')
    expect(projectStateGroupToScheduleStatus('unstarted')).toBe('todo')
    expect(projectStateGroupToScheduleStatus('backlog')).toBe('todo')
  })

  test('时间戳 → 本地 YYYY-MM-DD（横杠）', () => {
    // 2026-09-20 12:00 本地
    expect(timestampToDueDate(new Date(2026, 8, 20, 12).getTime())).toBe('2026-09-20')
    expect(timestampToDueDate(new Date(2026, 0, 3, 8).getTime())).toBe('2026-01-03')
  })

  test('优先级 critical → urgent', () => {
    expect(projectPriorityToSchedulePriority('critical')).toBe('urgent')
    expect(projectPriorityToSchedulePriority('high')).toBe('high')
  })

  test('完整映射：id 前缀 + category 带项目名', () => {
    const mapped = projectTaskToScheduleTask({
      id: 't1', projectId: 'p1', projectTitle: '官网改版', title: '写周报',
      status: 'in_progress', stateGroup: 'started', priority: 'critical',
      dueDate: new Date(2026, 8, 20, 12).getTime(),
    })
    expect(mapped.id).toBe('project-t1')
    expect(mapped.status).toBe('in-progress')
    expect(mapped.priority).toBe('urgent')
    expect(mapped.dueDate).toBe('2026-09-20')
    expect(mapped.category).toBe('project:官网改版')
  })
})
```

- [ ] **Step 2: 跑测试确认失败 → 实现 → 通过**

Run: `cd /Users/chaihao/.proma/agent-workspaces/proma-mit/project && bun test apps/electron/src/renderer/components/projects/schedule-task-mapping.test.ts`
Expected: 先 FAIL（文件不存在）→ 创建映射文件后 PASS

- [ ] **Step 3: ScheduleView 接入**

`ScheduleView.tsx`：
(a) 组件签名加 prop（`export function ScheduleView()` → 接收 `{ hideHeader?: boolean }`）；
(b) 顶栏 JSX（组件 return 内第一个 div，含「返回对话」按钮与日程/同步切换）包进 `{!hideHeader && (...)}`；
(c) 顶栏内「日历同步」切换按钮在 hideHeader 模式下也不该出现（项目管理 header 已有该 tab）——整块顶栏隐藏即满足；
(d) 数据接入：组件内加

```tsx
  const [projectTasks, setProjectTasks] = React.useState<ScheduleTask[]>([])
  const refreshProjectTasks = React.useCallback(() => {
    void window.electronAPI.paa.project.listAllProjectTasksLite()
      .then((lite) => setProjectTasks(lite.map(projectTaskToScheduleTask)))
      .catch((err) => console.error('加载项目任务失败:', err))
  }, [])
  React.useEffect(() => { refreshProjectTasks() }, [refreshProjectTasks])
```

(e) 合流渲染：原 `const [tasks, setTasks] = useAtom(scheduleTasksAtom)` 的任务流。找到 CalendarGrid 的调用处，把 `tasks` 改为 `mergedTasks`：

```tsx
  // 项目任务合流：仅月历/日详情展示；TaskBoard 保持只用日程任务
  const mergedTasks = React.useMemo(() => [...tasks, ...projectTasks], [tasks, projectTasks])
```

CalendarGrid 的 `tasks={tasks}` 改 `tasks={mergedTasks}`；右侧日详情若有独立 tasks 渲染同样改 mergedTasks；**TaskBoard 的 `tasks={tasks}` 保持不变**。
(f) 项目任务卡片徽标：CalendarGrid 内任务条渲染处，判断 `task.id.startsWith('project-')` 或 `task.category?.startsWith('project:')`，是则加前缀徽标：

```tsx
{task.category?.startsWith('project:') && (
  <span className="mr-1 text-[10px] px-1 rounded bg-primary/10 text-primary">📁 {task.category.slice('project:'.length)}</span>
)}
```

（以 CalendarGrid 实际渲染结构为准插入，保持行内紧凑不换行。）

- [ ] **Step 4: typecheck + 全量测试**

Run: `cd /Users/chaihao/.proma/agent-workspaces/proma-mit/project/apps/electron && bun run typecheck && cd ../.. && bun test apps/electron/src/renderer/components/projects/`
Expected: typecheck 无错误；测试全绿（23 + 新增 4 条）

- [ ] **Step 5: 提交**

```bash
cd /Users/chaihao/.proma/agent-workspaces/proma-mit/project
git add apps/electron/src/renderer/components/calendar/ScheduleView.tsx apps/electron/src/renderer/components/projects/schedule-task-mapping.ts apps/electron/src/renderer/components/projects/schedule-task-mapping.test.ts
git commit -m "feat: 日程视图合流项目任务 DDL 并支持隐藏顶栏"
```

---

### Task 4: 左侧导航移除 + 项目管理顶层加 tab

**Files:**
- Modify: `apps/electron/src/renderer/atoms/work-module-registry.ts:52-57`
- Modify: `apps/electron/src/renderer/components/projects/ProjectView.tsx:482-577`（ProjectView + ProjectHeader）
- Modify: `apps/electron/src/renderer/components/calendar/CalendarSyncView.tsx:487,643-673`

- [ ] **Step 1: 注册表移除 calendar 条目**

`work-module-registry.ts`：删除 `WORK_MODULE_REGISTRY` 中 `{ id: 'calendar', ... }` 整个条目；`WORK_MODULE_VIEWS` 保留 `calendar: CalendarModuleView`；`CalendarModuleView` 的 lazy import 保留（views 映射仍引用）。若 `CalendarDays` 图标 import 因此未使用，同步从 import 列表移除（biome 会报 unused）。

- [ ] **Step 2: CalendarSyncView 加 hideHeader**

`CalendarSyncView.tsx` 的 `CalendarView`（487 行）签名改为接收 `{ hideHeader?: boolean } = {}`；645-673 行的头部 div（含「日历同步」标题 + 全部同步/添加源按钮）包进 `{!hideHeader && (...)}`。注意：「全部同步」「添加源」按钮在头部内——隐藏顶栏后这两个操作入口会消失，因此 hideHeader 模式下需把这两个按钮**移到标签页导航行右侧**（730 行 `<div className="px-6 py-2 border-b shrink-0">` 的 Tabs 同行 flex 尾部），保证功能不丢失。实现：抽 `const actions = (<>...按钮...</>)`，头部内非 hideHeader 时渲染 `actions`，hideHeader 时渲染到 Tabs 行。

- [ ] **Step 3: ProjectView 顶层 tab**

`ProjectView.tsx`：
(a) import 区加：

```tsx
import { ScheduleView } from '../calendar/ScheduleView'
import { CalendarView } from '../calendar/CalendarSyncView'
```

（这两个组件已在本 bundle，无需 lazy；若 typecheck 报循环引用则改 lazy。）
(b) `ProjectView` 的 activeTab state 类型（934 行是 ProjectDetail 的，**顶层在 485 行**）：

```tsx
const [selectedProject, setSelectedProject] = useState<Project | null>(null)
const [activeTab, setActiveTab] = useState<'projects' | 'my-work' | 'board' | 'team' | 'schedule' | 'sync'>('projects')
```

(c) `ProjectHeader` 的 `onTabChange` prop 类型与 tab 数组（563 行）追加：

```tsx
  { key: 'schedule', label: '日程管家' },
  { key: 'sync', label: '日历同步' },
```

`ProjectHeader` props 类型同步为 `'projects' | 'my-work' | 'board' | 'team' | 'schedule' | 'sync'`。
(d) 渲染区（520-522 行 MyWorkPanel/BoardOverview/AgentTeamPanel 同级）追加：

```tsx
          {activeTab === 'schedule' && <ScheduleView hideHeader />}
          {activeTab === 'sync' && <CalendarView hideHeader />}
```

注意容器：日程视图是 `flex flex-col h-full` 全高布局，外层 `<div className="flex-1 overflow-auto p-6">` 的 p-6/overflow-auto 会挤压它——schedule/sync 两个分支需要**无 padding 的全高容器**。实现：把渲染区改为

```tsx
        <div className={activeTab === 'schedule' || activeTab === 'sync' ? 'flex-1 min-h-0' : 'flex-1 overflow-auto p-6'}>
```

- [ ] **Step 4: typecheck + 全量测试**

Run: `cd /Users/chaihao/.proma/agent-workspaces/proma-mit/project/apps/electron && bun run typecheck && cd ../.. && bun test apps/electron/src/renderer/components/projects/`
Expected: 无错误；全绿

- [ ] **Step 5: 提交**

```bash
cd /Users/chaihao/.proma/agent-workspaces/proma-mit/project
git add apps/electron/src/renderer/atoms/work-module-registry.ts apps/electron/src/renderer/components/projects/ProjectView.tsx apps/electron/src/renderer/components/calendar/CalendarSyncView.tsx
git commit -m "feat: 日程管家并入项目管理顶层子视图"
```

---

### Task 5: 版本递增 + 收尾验证

**Files:**
- Modify: `apps/electron/package.json`

- [ ] **Step 1: 递增版本**

`apps/electron/package.json` version patch +1（读当前值 +0.0.1）。

- [ ] **Step 2: 全量验证**

Run: `cd /Users/chaihao/.proma/agent-workspaces/proma-mit/project && bun test apps/electron/src/main/lib/project-service.test.ts apps/electron/src/renderer/components/projects/ && cd apps/electron && bun run typecheck`
Expected: 全绿，typecheck 干净

- [ ] **Step 3: 提交**

```bash
cd /Users/chaihao/.proma/agent-workspaces/proma-mit/project
git add apps/electron/package.json
git commit -m "chore: 递增 electron 包版本"
```

---

## 手工验证清单（实施完成后）

1. 左侧工作模块导航不再显示「日程管家」；「项目管理」进入后顶层 tab 有：项目 | 我的工作 | 看板 | 团队 | 日程管家 | 日历同步
2. 「日程管家」tab：月历上除日程事件外，能看到有 DDL 的项目任务（带 📁 项目名前缀）；无 DDL / 已完成 / 草稿项目任务不出现
3. 任务看板（右侧）仍只有日程任务自己的四列，无项目任务混入
4. 「日历同步」tab：功能完整（全部同步/添加源按钮可见可用）
5. 项目详情（点进某个项目）内无日程 tab，返回后顶层 tab 状态保持

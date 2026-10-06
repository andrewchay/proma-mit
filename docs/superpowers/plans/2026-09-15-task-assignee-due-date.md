# 任务列表展示负责人与 DDL 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 任务列表 tab 与看板卡片展示负责人徽标（统一风格）与截止日期（DDL）紧迫感徽标。

**Architecture:** 共享紧迫感纯函数 `dueDateUrgency`（`project-flow-metrics.ts`）+ 共享徽标组件 `DueDateBadge`（新文件），两视图复用规则只写一份。数据链路已通（`Task.dueDate` → `getKanbanBoard` → Jotai），仅渲染层改动，零 IPC 变更。

**Tech Stack:** React 18 + Jotai + Tailwind + bun:test（BDD）

**Spec:** `docs/superpowers/specs/2026-09-15-task-assignee-due-date-design.md`

---

### Task 1: `dueDateUrgency` 纯函数（TDD）

**Files:**
- Modify: `apps/electron/src/renderer/components/projects/project-flow-metrics.ts`（文件末尾追加）
- Test: `apps/electron/src/renderer/components/projects/project-flow-metrics.test.ts`

- [ ] **Step 1: 写失败测试**

在 `project-flow-metrics.test.ts` 顶部 import 行加入 `dueDateUrgency`：

```ts
import { calculateProjectFlowMetrics, ganttBarColor, dueDateUrgency } from './project-flow-metrics'
```

文件末尾追加：

```ts
describe('截止日期紧迫感 dueDateUrgency', () => {
  // 固定"现在"：2026-09-15 12:00 本地时间
  const now = new Date(2026, 8, 15, 12, 0, 0).getTime()
  const day = (offset: number, hour = 12) => new Date(2026, 8, 15 + offset, hour, 0, 0).getTime()

  test('无 DDL 返回 null', () => {
    expect(dueDateUrgency(undefined, false, now)).toBeNull()
    expect(dueDateUrgency(NaN, false, now)).toBeNull()
  })

  test('已完成任务不展示（即使已逾期）', () => {
    expect(dueDateUrgency(day(-3), true, now)).toBeNull()
  })

  test('逾期返回 red + 逾期文案', () => {
    const result = dueDateUrgency(day(-2), false, now)
    expect(result?.tone).toBe('red')
    expect(result?.text).toContain('逾期 2 天')
  })

  test('今天截止返回 amber + 今天文案', () => {
    const result = dueDateUrgency(day(0), false, now)
    expect(result?.tone).toBe('amber')
    expect(result?.text).toContain('今天')
  })

  test('3 天内返回 amber', () => {
    const result = dueDateUrgency(day(3), false, now)
    expect(result?.tone).toBe('amber')
    expect(result?.text).toContain('剩 3 天')
  })

  test('宽裕返回 gray', () => {
    const result = dueDateUrgency(day(10), false, now)
    expect(result?.tone).toBe('gray')
    expect(result?.text).toContain('剩 10 天')
  })

  test('半夜边界：23:59 与 00:01 同日天数差一致', () => {
    const lateNight = new Date(2026, 8, 15, 23, 59, 0).getTime()
    const earlyMorning = new Date(2026, 8, 15, 0, 1, 0).getTime()
    const a = dueDateUrgency(day(5), false, lateNight)
    const b = dueDateUrgency(day(5), false, earlyMorning)
    expect(a?.tone).toBe(b?.tone)
    expect(a?.text).toBe(b?.text)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /Users/chaihao/.proma/agent-workspaces/proma-mit/project && bun test apps/electron/src/renderer/components/projects/project-flow-metrics.test.ts`
Expected: FAIL（`dueDateUrgency` 未导出）

- [ ] **Step 3: 最小实现**

在 `project-flow-metrics.ts` 文件末尾追加：

```ts
// ===== 截止日期紧迫感（任务列表 / 看板卡片共用） =====

export interface DueDateUrgency {
  /** 展示文本，如「09-20 · 剩 5 天」 */
  text: string
  /** 逾期=red，今天或 3 天内=amber，其余=gray */
  tone: 'red' | 'amber' | 'gray'
}

/** 本地当日零点（天级比较基准，避免半夜边界抖动） */
function localMidnight(timestamp: number): number {
  const date = new Date(timestamp)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

const DAY_MS = 86_400_000

/**
 * DDL 紧迫感：已完成/已取消返回 null（不展示）；
 * 逾期 → red「逾期 N 天」，今天 → amber「今天截止」，3 天内 → amber「剩 N 天」，其余 → gray「剩 N 天」。
 */
export function dueDateUrgency(
  dueDate: number | undefined,
  isDone: boolean,
  now = Date.now(),
): DueDateUrgency | null {
  if (isDone || dueDate === undefined || Number.isNaN(dueDate) || dueDate <= 0) return null
  const remainingDays = Math.round((localMidnight(dueDate) - localMidnight(now)) / DAY_MS)
  const dateText = new Date(dueDate).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' })
  if (remainingDays < 0) return { text: `${dateText} · 逾期 ${Math.abs(remainingDays)} 天`, tone: 'red' }
  if (remainingDays === 0) return { text: `${dateText} · 今天截止`, tone: 'amber' }
  return { text: `${dateText} · 剩 ${remainingDays} 天`, tone: remainingDays <= 3 ? 'amber' : 'gray' }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd /Users/chaihao/.proma/agent-workspaces/proma-mit/project && bun test apps/electron/src/renderer/components/projects/project-flow-metrics.test.ts`
Expected: PASS（原有用例 + 新增 7 条全绿）

- [ ] **Step 5: 提交**

```bash
cd /Users/chaihao/.proma/agent-workspaces/proma-mit/project
git add apps/electron/src/renderer/components/projects/project-flow-metrics.ts apps/electron/src/renderer/components/projects/project-flow-metrics.test.ts
git commit -m "feat: 截止日期紧迫感纯函数 dueDateUrgency"
```

---

### Task 2: `DueDateBadge` 组件 + 类型透传

**Files:**
- Create: `apps/electron/src/renderer/components/projects/DueDateBadge.tsx`
- Modify: `apps/electron/src/renderer/atoms/project-atoms.ts:12-25`（`ProjectTaskAtom` 接口）

- [ ] **Step 1: `ProjectTaskAtom` 补 `dueDate` 字段**

`project-atoms.ts` 的 `ProjectTaskAtom` 接口（`updatedAt: number` 前）插入：

```ts
  dueDate?: number
```

- [ ] **Step 2: 创建 `DueDateBadge.tsx`**

```tsx
/**
 * 截止日期徽标 — Due Date Badge
 *
 * 展示 DDL + 紧迫感（逾期红 / 今天与 3 天内琥珀 / 其余灰）。
 * 已完成或无 DDL 不渲染；规则见 project-flow-metrics.dueDateUrgency。
 */
import * as React from 'react'
import { dueDateUrgency } from './project-flow-metrics'

/** tone → 底色（与项目模块既有徽标色系一致） */
const TONE_CLASS: Record<'red' | 'amber' | 'gray', string> = {
  red: 'bg-red-100 text-red-700',
  amber: 'bg-amber-100 text-amber-700',
  gray: 'bg-gray-100 text-gray-600',
}

interface DueDateBadgeProps {
  dueDate?: number
  /** 任务处于 completed/cancelled 语义组时传 true，徽标不渲染 */
  isDone: boolean
}

export function DueDateBadge({ dueDate, isDone }: DueDateBadgeProps): React.ReactElement | null {
  const urgency = dueDateUrgency(dueDate, isDone)
  if (!urgency) return null
  return (
    <span className={`text-xs px-1.5 py-0.5 rounded ${TONE_CLASS[urgency.tone]}`} title={`截止日期：${urgency.text}`}>
      📅 {urgency.text}
    </span>
  )
}
```

- [ ] **Step 3: 类型检查**

Run: `cd /Users/chaihao/.proma/agent-workspaces/proma-mit/project/apps/electron && bun run typecheck`
Expected: 无错误

- [ ] **Step 4: 提交**

```bash
cd /Users/chaihao/.proma/agent-workspaces/proma-mit/project
git add apps/electron/src/renderer/components/projects/DueDateBadge.tsx apps/electron/src/renderer/atoms/project-atoms.ts
git commit -m "feat: DueDateBadge 组件与 ProjectTaskAtom.dueDate 透传"
```

---

### Task 3: 看板卡片接入

**Files:**
- Modify: `apps/electron/src/renderer/components/projects/kanban/KanbanColumn.tsx:52`
- Modify: `apps/electron/src/renderer/components/projects/kanban/TaskCard.tsx`

- [ ] **Step 1: `KanbanColumn` 传 `stateGroup` 给 `TaskCard`**

`KanbanColumn.tsx:52` 的渲染行改为：

```tsx
            tasks.map((task) => <TaskCard key={task.id} task={task} columnStateGroup={status.stateGroup} onClick={onTaskClick} />)
```

- [ ] **Step 2: `TaskCard` 接入 DDL 徽标**

`TaskCard.tsx` 顶部 import 区新增：

```ts
import { DueDateBadge } from '../DueDateBadge'
```

`TaskCardProps` 接口增加：

```ts
  /** 所在列的语义组（任务列即其状态，拖拽乐观更新时天然一致） */
  columnStateGroup: ProjectTaskStatusAtom['stateGroup']
```

import 行补 `ProjectTaskStatusAtom`：

```ts
import type { ProjectTaskAtom, ProjectTaskStatusAtom } from '@/atoms/project-atoms'
```

组件签名改为：

```tsx
export function TaskCard({ task, columnStateGroup, onClick }: TaskCardProps): React.ReactElement {
```

在 `const isAgent = ...` 行后新增：

```ts
  const isDone = columnStateGroup === 'completed' || columnStateGroup === 'cancelled'
```

元信息行（`{task.assignee && (` 块之前）插入 DDL 徽标，并把外层条件改为「负责人、执行状态、DDL 任一存在即渲染行」：

```tsx
      {(task.assignee || execStatus || task.dueDate !== undefined) && (
        <div className="mt-2 flex items-center gap-1 flex-wrap">
          <DueDateBadge dueDate={task.dueDate} isDone={isDone} />
          {task.assignee && (
```

（`{task.assignee && (` 块与 `execStatus` 块保持原样，仅在其前面插入 `<DueDateBadge .../>` 一行、并替换外层条件）

- [ ] **Step 3: 类型检查**

Run: `cd /Users/chaihao/.proma/agent-workspaces/proma-mit/project/apps/electron && bun run typecheck`
Expected: 无错误

- [ ] **Step 4: 提交**

```bash
cd /Users/chaihao/.proma/agent-workspaces/proma-mit/project
git add apps/electron/src/renderer/components/projects/kanban/KanbanColumn.tsx apps/electron/src/renderer/components/projects/kanban/TaskCard.tsx
git commit -m "feat: 看板卡片展示截止日期紧迫感徽标"
```

---

### Task 4: 任务列表 tab 接入

**Files:**
- Modify: `apps/electron/src/renderer/components/projects/ProjectView.tsx:2420-2422`（TaskItem 负责人行）、`ProjectView.tsx:2030-2040`（TaskList 渲染 TaskItem 传 statuses——已有，无需改）

- [ ] **Step 1: import `DueDateBadge` 与语义组判断**

`ProjectView.tsx` 顶部 import 区（`import { GANTT_GROUP_BAR_COLORS, ganttBarColor } from './project-flow-metrics'` 后）新增：

```ts
import { DueDateBadge } from './DueDateBadge'
```

- [ ] **Step 2: TaskItem 负责人行升级为徽标 + DDL**

TaskItem 内（`const needsCompletionNotes = ...` 附近）新增语义组判断（statuses 已通过 props 传入）：

```ts
  const assigneeStatusGroup = statuses.find((s) => s.id === task.status)?.stateGroup
  const isTaskDone = assigneeStatusGroup === 'completed' || assigneeStatusGroup === 'cancelled'
  const isAgentAssignee = task.assignee?.userId?.startsWith('agent-') ?? false
```

替换原负责人灰字（`{task.assignee && (<p ...>负责人: {task.assignee.displayName}</p>)}`，位于 2420-2422 行）为徽标行：

```tsx
          {(task.assignee || task.dueDate !== undefined) && (
            <div className="mt-1 flex items-center gap-1 flex-wrap">
              {task.assignee && (
                <span
                  className={`text-xs px-1.5 py-0.5 rounded ${isAgentAssignee ? 'bg-blue-100 text-blue-700' : 'bg-gray-100 text-gray-600'}`}
                >
                  {isAgentAssignee ? '🤖' : '👤'} {task.assignee.displayName}
                </span>
              )}
              <DueDateBadge dueDate={task.dueDate} isDone={isTaskDone} />
            </div>
          )}
```

- [ ] **Step 3: 类型检查 + 全量测试**

Run: `cd /Users/chaihao/.proma/agent-workspaces/proma-mit/project/apps/electron && bun run typecheck && cd .. && cd .. && bun test apps/electron/src/renderer/components/projects/`
Expected: typecheck 无错误；测试全绿

- [ ] **Step 4: 提交**

```bash
cd /Users/chaihao/.proma/agent-workspaces/proma-mit/project
git add apps/electron/src/renderer/components/projects/ProjectView.tsx
git commit -m "feat: 任务列表负责人徽标化并展示 DDL 紧迫感"
```

---

### Task 5: 版本递增 + 收尾验证

**Files:**
- Modify: `apps/electron/package.json:3`

- [ ] **Step 1: 递增版本**

`apps/electron/package.json` 的 `"version": "0.11.83"` → `"version": "0.11.84"`。

- [ ] **Step 2: 全量验证**

Run: `cd /Users/chaihao/.proma/agent-workspaces/proma-mit/project && bun test apps/electron/src/renderer/components/projects/ && cd apps/electron && bun run typecheck`
Expected: 测试全绿，typecheck 无错误

- [ ] **Step 3: 提交**

```bash
cd /Users/chaihao/.proma/agent-workspaces/proma-mit/project
git add apps/electron/package.json
git commit -m "chore: 递增 electron 包版本至 0.11.84"
```

---

## 手工验证清单（实施完成后）

1. `bun run dev` 启动应用，进入任一项目的看板：有 DDL 的卡片出现「📅 MM-DD · 剩/逾期 N 天」徽标，逾期红、临近琥珀
2. 已完成/已取消列的卡片不显示 DDL 徽标
3. 切到任务列表 tab：负责人显示为徽标（👤/🤖），旁有 DDL 徽标
4. 无 DDL、无负责人的卡片不出现空行

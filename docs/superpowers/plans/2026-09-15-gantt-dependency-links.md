# 甘特图依赖连线 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 甘特图上以 SVG 贝塞尔连线渲染任务间依赖（四种类型全覆盖），阻塞中的依赖标红。

**Architecture:** 坐标计算收敛为 `project-flow-metrics.ts` 纯函数 `ganttDependencyPath`（百分比时间轴 × 固定 32px 行高网格），渲染端在甘特行列表上叠 `absolute` SVG 覆盖层，用 `preserveAspectRatio="none"` + viewBox 让路径 x 直接复用时间条百分比、y 用像素。数据零改动。

**Tech Stack:** React 18 + SVG + bun:test（BDD）

**Spec:** `docs/superpowers/specs/2026-09-15-gantt-dependency-links-design.md`

---

### Task 1: `ganttDependencyPath` 纯函数（TDD）

**Files:**
- Modify: `apps/electron/src/renderer/components/projects/project-flow-metrics.ts`（文件末尾追加）
- Test: `apps/electron/src/renderer/components/projects/project-flow-metrics.test.ts`（末尾追加 describe）

- [ ] **Step 1: 写失败测试**

`project-flow-metrics.test.ts` 顶部 import 行加入 `ganttDependencyPath`：

```ts
import { calculateProjectFlowMetrics, ganttBarColor, dueDateUrgency, sortTasksByUrgency, ganttDependencyPath, type SortTask } from './project-flow-metrics'
```

文件末尾追加：

```ts
describe('甘特依赖连线 ganttDependencyPath', () => {
  const pts = (fromIndex: number, toIndex: number) => ({
    from: { index: fromIndex, startPct: 10, endPct: 80 },
    to: { index: toIndex, startPct: 30, endPct: 90 },
  })

  test('FS 跨行：from 条尾 → to 条头，含贝塞尔控制点', () => {
    const p = ganttDependencyPath(pts(0, 2), 'finish_to_start')
    expect(p.d).toContain('C')            // 贝塞尔
    expect(p.d.startsWith('M 80 16')).toBe(true)   // 起点：from 条尾（index 0 中心 y=16）
    expect(p.d.endsWith(' 30 80')).toBe(true)      // 终点：to 条头（index 2 中心 y=2*32+16=80）
  })

  test('SS：from 条头 → to 条头', () => {
    const p = ganttDependencyPath(pts(0, 1), 'start_to_start')
    expect(p.d.startsWith('M 10 16')).toBe(true)
    expect(p.d.endsWith(' 30 48')).toBe(true)
  })

  test('FF：from 条尾 → to 条尾', () => {
    const p = ganttDependencyPath(pts(0, 1), 'finish_to_finish')
    expect(p.d.startsWith('M 80 16')).toBe(true)
    expect(p.d.endsWith(' 90 48')).toBe(true)
  })

  test('SF：from 条头 → to 条尾', () => {
    const p = ganttDependencyPath(pts(0, 1), 'start_to_finish')
    expect(p.d.startsWith('M 10 16')).toBe(true)
    expect(p.d.endsWith(' 90 48')).toBe(true)
  })

  test('同行：水平直线，无贝塞尔', () => {
    const p = ganttDependencyPath(pts(1, 1), 'finish_to_start')
    expect(p.d).not.toContain('C')
    expect(p.d.startsWith('M 80 48')).toBe(true)
    expect(p.d.endsWith(' 30 48')).toBe(true)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /Users/chaihao/.proma/agent-workspaces/proma-mit/project && bun test apps/electron/src/renderer/components/projects/project-flow-metrics.test.ts`
Expected: FAIL（`ganttDependencyPath` 未导出）

- [ ] **Step 3: 最小实现**

`project-flow-metrics.ts` 文件末尾追加：

```ts
// ===== 甘特依赖连线（SVG 覆盖层坐标计算） =====

export interface GanttLinkEndpoints {
  from: { index: number; startPct: number; endPct: number }
  to: { index: number; startPct: number; endPct: number }
}

export type GanttDependencyType = 'finish_to_start' | 'start_to_start' | 'finish_to_finish' | 'start_to_finish'

/** 行高 24px（h-6）+ 行距 8px（space-y-2）= 32px 步进；条 h-4（16px）行内居中 → 行中心 y = index*32+16 */
export const GANTT_ROW_STEP = 32

/** y 单位像素；x 单位为百分比数值（0-100），由 SVG viewBox(0 0 100 行数*32) + preserveAspectRatio="none" 换算 */
export function ganttDependencyPath(
  endpoints: GanttLinkEndpoints,
  type: GanttDependencyType,
  rowStep = GANTT_ROW_STEP,
): GanttDependencyPathResult {
  const centerY = (index: number) => index * rowStep + rowStep / 2
  const fromTail = { x: endpoints.from.endPct, y: centerY(endpoints.from.index) }
  const fromHead = { x: endpoints.from.startPct, y: centerY(endpoints.from.index) }
  const toHead = { x: endpoints.to.startPct, y: centerY(endpoints.to.index) }
  const toTail = { x: endpoints.to.endPct, y: centerY(endpoints.to.index) }

  let start: { x: number; y: number }
  let end: { x: number; y: number }
  switch (type) {
    case 'start_to_start': start = fromHead; end = toHead; break
    case 'finish_to_finish': start = fromTail; end = toTail; break
    case 'start_to_finish': start = fromHead; end = toTail; break
    case 'finish_to_start':
    default: start = fromTail; end = toHead; break
  }

  if (start.y === end.y) {
    // 同行：水平直线
    return { d: `M ${start.x} ${start.y} L ${end.x} ${end.y}` }
  }
  // 端点水平伸出 6px（x 用百分比的 6%，足够视觉出条）再贝塞尔跨行
  const dir = end.x >= start.x ? 1 : -1
  const c1x = start.x + 6 * dir
  const c2x = end.x - 6 * dir
  return { d: `M ${start.x} ${start.y} C ${c1x} ${start.y}, ${c2x} ${end.y}, ${end.x} ${end.y}` }
}

export interface GanttDependencyPathResult {
  d: string
}
```

（注意：`GanttDependencyPathResult` interface 需在 `ganttDependencyPath` 之前声明——TS interface 可后置，但按文件惯例把 interface 放函数前。）

- [ ] **Step 4: 跑测试确认通过**

Run: `cd /Users/chaihao/.proma/agent-workspaces/proma-mit/project && bun test apps/electron/src/renderer/components/projects/project-flow-metrics.test.ts`
Expected: PASS（28 + 新 5 = 33 条）

- [ ] **Step 5: 提交**

```bash
cd /Users/chaihao/.proma/agent-workspaces/proma-mit/project
git add apps/electron/src/renderer/components/projects/project-flow-metrics.ts apps/electron/src/renderer/components/projects/project-flow-metrics.test.ts
git commit -m "feat: 甘特依赖连线坐标纯函数 ganttDependencyPath"
```

提交信息末尾加 `Co-Authored-By: Claude Code <noreply@anthropic.com>`。

---

### Task 2: GanttView SVG 覆盖层渲染

**Files:**
- Modify: `apps/electron/src/renderer/components/projects/ProjectView.tsx:1612-1710`（GanttView）

- [ ] **Step 1: import 与数据准备**

`ProjectView.tsx` 顶部 `project-flow-metrics` import 行加 `ganttDependencyPath, GANTT_ROW_STEP`。

GanttView 内（`sortedTasks` 计算后）加：

```tsx
  // 依赖连线数据：任务 id → 行号/端点；阻塞依赖集合（taskId 维度）
  const taskIndexById = new Map(sortedTasks.map((task, index) => [task.id, index]))
  const taskSpanById = new Map(sortedTasks.map((task) => {
    const start = task.startDate ?? task.createdAt
    const end = Math.max(task.dueDate ?? start + day, start + day)
    const left = Math.max(0, ((start - rangeStart) / range) * 100)
    const width = Math.max(1.5, ((end - start) / range) * 100)
    return [task.id, { left, right: left + width }] as const
  }))
  const blockedTaskIds = new Set(blockers.map((b) => b.taskId))
  const links = dependencies
    .map((dep) => {
      const fromIdx = taskIndexById.get(dep.taskId)
      const toIdx = taskIndexById.get(dep.dependsOnTaskId)
      const fromSpan = taskSpanById.get(dep.taskId)
      const toSpan = taskSpanById.get(dep.dependsOnTaskId)
      if (fromIdx === undefined || toIdx === undefined || !fromSpan || !toSpan) return null
      const { d } = ganttDependencyPath(
        {
          from: { index: fromIdx, startPct: fromSpan.left, endPct: fromSpan.right },
          to: { index: toIdx, startPct: toSpan.left, endPct: toSpan.right },
        },
        dep.type,
      )
      return { id: dep.id, d, blocked: blockedTaskIds.has(dep.taskId) }
    })
    .filter((link): link is NonNullable<typeof link> => link !== null)
```

- [ ] **Step 2: JSX 改造**

(a) 行列表容器 `<div className="space-y-2">{sortedTasks.map(...)}</div>` 外包一层 relative 容器并叠加 SVG：

```tsx
        <div className="relative">
          <div className="space-y-2" style={{ minHeight: sortedTasks.length * GANTT_ROW_STEP }}>{sortedTasks.map((task) => {
            /* 原行渲染 JSX 保持不变 */
          })}</div>
          {links.length > 0 && (
            <svg
              className="pointer-events-none absolute inset-0"
              width="100%"
              height={sortedTasks.length * GANTT_ROW_STEP}
              viewBox={`0 0 100 ${sortedTasks.length * GANTT_ROW_STEP}`}
              preserveAspectRatio="none"
            >
              <defs>
                <marker id="gantt-arrow" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
                  <path d="M 0 0 L 6 3 L 0 6 z" className="fill-gray-400" />
                </marker>
              </defs>
              {links.map((link) => (
                <path
                  key={link.id}
                  d={link.d}
                  fill="none"
                  className={link.blocked ? 'stroke-red-500' : 'stroke-gray-400 opacity-60'}
                  strokeWidth={link.blocked ? 1.5 : 1}
                  markerEnd={link.blocked ? undefined : 'url(#gantt-arrow)'}
                  vectorEffect="non-scaling-stroke"
                />
              ))}
            </svg>
          )}
        </div>
```

**关键坑**：`preserveAspectRatio="none"` 会把 marker（箭头）也非均匀拉伸变形；`vectorEffect="non-scaling-stroke"` 只保线宽不保 marker。若箭头视觉明显变形，接受该瑕疵（第一版）并在报告中注明——**不要**为此引入 DOM 测量。

(b) 头部统计行（`{dependencies.length} 条依赖 · {blockers.length} 项阻塞` 后）追加图例：

```tsx
          <span className="inline-flex items-center gap-1 ml-2"><span className="inline-block w-4 border-t border-gray-400" />依赖</span>
          <span className="inline-flex items-center gap-1"><span className="inline-block w-4 border-t-2 border-red-500" />阻塞生效中</span>
```

- [ ] **Step 3: typecheck + 全量测试**

Run: `cd /Users/chaihao/.proma/agent-workspaces/proma-mit/project/apps/electron && bun run typecheck && cd ../.. && bun test apps/electron/src/renderer/components/projects/`
Expected: typecheck 无错误；33 条测试全绿

- [ ] **Step 4: 提交**

```bash
cd /Users/chaihao/.proma/agent-workspaces/proma-mit/project
git add apps/electron/src/renderer/components/projects/ProjectView.tsx
git commit -m "feat: 甘特图渲染任务依赖连线（SVG 覆盖层）"
```

提交信息末尾加 `Co-Authored-By: Claude Code <noreply@anthropic.com>`。

---

### Task 3: 版本递增 + 收尾验证

**Files:**
- Modify: `apps/electron/package.json`

- [ ] **Step 1: 递增版本**

`apps/electron/package.json` version patch +1（读当前值）。

- [ ] **Step 2: 全量验证**

Run: `cd /Users/chaihao/.proma/agent-workspaces/proma-mit/project && bun test apps/electron/src/renderer/components/projects/ && cd apps/electron && bun run typecheck`
Expected: 全绿，typecheck 干净

- [ ] **Step 3: 提交**

```bash
cd /Users/chaihao/.proma/agent-workspaces/proma-mit/project
git add apps/electron/package.json
git commit -m "chore: 递增 electron 包版本"
```

---

## 手工验证清单（实施完成后）

1. 进项目详情 → 甘特 tab：有依赖的任务间出现灰色贝塞尔连线（箭头指向后置任务）
2. 被阻塞任务（依赖 tab 中「当前阻塞」命中的）的依赖连线为红色加粗
3. 头部图例出现「— 依赖 / — 阻塞生效中」
4. 无依赖的项目：无 SVG、无报错
5. 月历/看板/任务列表不受影响

# 任务列表展示负责人与 DDL — 设计文档

日期：2026-09-15
状态：已确认（方案 A）

## 背景

项目模块的两个任务视图都缺少截止日期（DDL）展示，负责人展示形式不统一：

| 视图 | 负责人 | DDL |
|------|--------|-----|
| 任务列表 tab（TaskItem，`ProjectView.tsx`） | 灰字「负责人: xxx」 | 无（仅编辑弹窗可改） |
| 看板卡片（TaskCard） | 徽标（👤真人/🤖AI） | 无 |

数据链路已通：主进程 `Task.dueDate`（`project-types.ts:104`）→ `getKanbanBoard` → Jotai `projectTasksAtom`，仅渲染层 `ProjectTaskAtom` 类型未声明 `dueDate` 字段。**无需改动主进程/IPC**。

## 需求（用户已确认）

- 展示范围：任务列表 tab + 看板卡片
- DDL 风格：日期 + 紧迫感（如「截止 09-20 · 剩 5 天」，逾期变红）
- 负责人：任务列表升级为与看板一致的徽标（👤/🤖 + 底色）

## 方案

共享紧迫感纯函数 + 共享徽标组件，两视图复用，规则只写一份。

### 1. 纯函数 `dueDateUrgency`（`project-flow-metrics.ts`）

```ts
export interface DueDateUrgency {
  /** 展示文本，如「截止 09-20 · 剩 5 天」 */
  text: string
  /** 逾期=red，今天或 3 天内=amber，其余=gray */
  tone: 'red' | 'amber' | 'gray'
}

export function dueDateUrgency(
  dueDate: number,
  isDone: boolean,
  now = Date.now(),
): DueDateUrgency | null
```

规则：
- `isDone`（任务处于 completed/cancelled 语义组）→ 返回 `null`，不展示
- 无 `dueDate` → 返回 `null`
- 天数差按**本地当日零点**做差（`new Date(x); d.setHours(0,0,0,0)`），避免半夜边界抖动
- `remaining < 0`：`逾期 N 天`，tone=red；`remaining === 0`：`今天截止`，tone=amber；`1 ≤ remaining ≤ 3`：`剩 N 天`，tone=amber；其余：`剩 N 天`，tone=gray
- 日期段统一 `MM-DD`（`toLocaleDateString('zh-CN')` 截取）

### 2. 徽标组件 `DueDateBadge`（新文件 `projects/DueDateBadge.tsx`，约 40 行）

- 输入 `dueDate?: number` + `isDone: boolean`，内部调用 `dueDateUrgency`
- null 时不渲染；否则渲染小徽标，`tone` 映射底色（red/amber/gray 与现有 `bg-red-100 text-red-700` 等类一致）

### 3. 类型补齐（`project-atoms.ts`）

`ProjectTaskAtom` 增加 `dueDate?: number`（数据运行时已带，纯类型声明）。

### 4. 看板卡片（`KanbanColumn.tsx` / `TaskCard.tsx`）

- `KanbanColumn` 把列的 `stateGroup` 传给 `TaskCard`（任务所在列即其状态，拖拽乐观更新时天然一致），`isDone = stateGroup === 'completed' || stateGroup === 'cancelled'`
- 卡片元信息行 = 负责人徽标 + DDL 徽标（flex-wrap，已有）

### 5. 任务列表（`ProjectView.tsx` TaskItem）

- 「负责人: xxx」灰字升级为徽标（👤/🤖 + 底色，与 TaskCard 同规则）
- 旁边放 `DueDateBadge`；`isDone` 用已加载的 `statuses` 语义组判断（`task-status-logic` 同口径，渲染层已有 `groupOf` 类似逻辑可参考 `project-flow-metrics.ts`）
- 徽标行与现有徽标（风险/飞书/钉钉/纪要）同一行排开或紧邻，不新增层级

### 不改动

- 甘特图已有「超期」标注（独立标注体系，保留）
- 任务详情弹窗、编辑弹窗（不在选定范围）
- 主进程、IPC、数据库（零变更）

## 错误处理

- `dueDate` 为 NaN/0 等非法值：`dueDateUrgency` 视为无 DDL 返回 null
- 渲染层 `statuses` 缺失时 `isDone` 按非完成处理，徽标照常展示

## 测试（BDD）

`project-flow-metrics.test.ts` 追加 `dueDateUrgency` 用例：
1. 无 DDL → null
2. 已完成任务 → null（即使已逾期）
3. 逾期 → red + 「逾期 N 天」
4. 今天截止 → amber + 「今天截止」
5. 3 天内 → amber + 「剩 N 天」
6. 宽裕 → gray + 「剩 N 天」
7. 半夜边界：23:59 与 00:01 同日 → 天数差一致

验证：`bun test`（projects 目录）+ `cd apps/electron && bun run typecheck`。

## 版本

`@proma/electron` patch +1（提交时递增）。

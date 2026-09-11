/**
 * 看板拖拽编排 — Kanban Board
 *
 * DndContext 统一编排跨列拖拽：落点 → 计算 sortOrder（中点法，与主进程
 * task-reorder-logic 一致）→ 乐观更新 atoms → IPC reorderTask → 失败回滚 + 提示原因
 * （如拖入完成列被 DoD/依赖校验拒绝）。
 */
import * as React from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  closestCorners,
  type DragStartEvent,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  kanbanColumnsAtom,
  activeKanbanProjectIdAtom,
  optimisticMoveTaskAtom,
  rollbackTasksAtom,
  applyReorderResultAtom,
} from '@/atoms/project-atoms'
import type { ProjectTaskAtom } from '@/atoms/project-atoms'
import { KanbanColumn } from './KanbanColumn'
import { TaskCard } from './TaskCard'
import { KanbanColumnSettings } from './KanbanColumnSettings'

interface KanbanBoardProps {
  projectId: string
  /** 拖拽/设置变更后回调宿主刷新（重拉任务列表等） */
  onChanged?: () => void
}

/** 中点法计算落点 sortOrder：邻居取中点，头插/尾插用步长，空列用首档 */
function computeDropSortOrder(columnTasks: Array<{ sortOrder: number }>, targetIndex: number): number {
  const prev = targetIndex > 0 ? columnTasks[targetIndex - 1]?.sortOrder : undefined
  const next = targetIndex < columnTasks.length ? columnTasks[targetIndex]?.sortOrder : undefined
  if (prev !== undefined && next !== undefined) return (prev + next) / 2
  if (prev === undefined && next !== undefined) return next - 65536
  if (prev !== undefined && next === undefined) return prev + 65536
  return 65536
}

export function KanbanBoard({ projectId, onChanged }: KanbanBoardProps): React.ReactElement {
  const columns = useAtomValue(kanbanColumnsAtom)
  const setActiveKanbanProjectId = useSetAtom(activeKanbanProjectIdAtom)
  const optimisticMove = useSetAtom(optimisticMoveTaskAtom)
  const rollback = useSetAtom(rollbackTasksAtom)
  const applyReorderResult = useSetAtom(applyReorderResultAtom)
  const [activeTask, setActiveTask] = React.useState<ProjectTaskAtom | null>(null)
  const [settingsOpen, setSettingsOpen] = React.useState(false)
  const [notice, setNotice] = React.useState('')

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  )

  // 挂载登记看板项目，卸载清除
  React.useEffect(() => {
    setActiveKanbanProjectId(projectId)
    return () => setActiveKanbanProjectId(null)
  }, [projectId, setActiveKanbanProjectId])

  const handleDragStart = (event: DragStartEvent): void => {
    const taskId = String(event.active.id)
    setActiveTask(columns.flatMap((col) => col.tasks).find((task) => task.id === taskId) ?? null)
  }

  const handleDragEnd = (event: DragEndEvent): void => {
    setActiveTask(null)
    const { active, over } = event
    if (!over) return

    const taskId = String(active.id)
    const sourceColumn = columns.find((col) => col.tasks.some((task) => task.id === taskId))
    if (!sourceColumn) return

    // 落点解析：卡片 id → 按指针在卡片中线之上/之下决定插其前/后；列容器 id（column:<statusId>）→ 追加到列尾
    const overId = String(over.id)
    let targetStatusId: string
    let targetIndex: number
    if (overId.startsWith('column:')) {
      targetStatusId = overId.slice('column:'.length)
      const targetCol = columns.find((col) => col.status.id === targetStatusId)
      targetIndex = targetCol ? targetCol.tasks.length : 0
    } else {
      const targetColumn = columns.find((col) => col.tasks.some((task) => task.id === overId))
      if (!targetColumn) return
      targetStatusId = targetColumn.status.id
      const overIndex = targetColumn.tasks.findIndex((task) => task.id === overId)
      // 指针相对悬停卡片中线：上半 → 插其前（占其位），下半 → 插其后
      const overRect = over.rect
      const pointerY = active.rect.current.translated?.top ?? overRect.top
      const dropBelow = pointerY > overRect.top + overRect.height / 2
      targetIndex = overIndex + (dropBelow ? 1 : 0)
      // 同列向下拖时移除自身后的索引补偿：目标下标若越过原位需减一
      const sameColumn = sourceColumn.status.id === targetStatusId
      const currentIndex = sourceColumn.tasks.findIndex((task) => task.id === taskId)
      if (sameColumn && currentIndex < targetIndex) targetIndex -= 1
    }

    // 位置未变则跳过
    const currentIndexFinal = sourceColumn.tasks.findIndex((task) => task.id === taskId)
    if (targetStatusId === sourceColumn.status.id && targetIndex === currentIndexFinal) return

    const targetTasks = columns.find((col) => col.status.id === targetStatusId)?.tasks ?? []
    const sortOrder = computeDropSortOrder(targetTasks, targetIndex)

    // 邻居参数：after=落点上方邻居（targetIndex-1），before=落点下方邻居（targetIndex）
    const afterNeighbor = targetIndex > 0 ? targetTasks[targetIndex - 1]?.id : undefined
    const beforeNeighbor = targetIndex < targetTasks.length ? targetTasks[targetIndex]?.id : undefined

    // 乐观更新（atoms）：状态 + 排序一并生效，失败按快照回滚
    const snapshot = optimisticMove({ projectId, taskId, newStatusId: targetStatusId, newSortOrder: sortOrder })
    void window.electronAPI.paa.project
      .reorderTask(taskId, {
        ...(targetStatusId !== sourceColumn.status.id ? { newStatusId: targetStatusId } : {}),
        ...(afterNeighbor ? { afterTaskId: afterNeighbor } : {}),
        ...(beforeNeighbor ? { beforeTaskId: beforeNeighbor } : {}),
      })
      .then((result) => {
        // IPC 返回落盘后的权威值（含重编号波及任务）直接更新 atom，免整列重拉
        applyReorderResult({ projectId, result: result as { task?: ProjectTaskAtom; rewrittenTasks?: ProjectTaskAtom[] } })
      })
      .catch((error: unknown) => {
        if (snapshot) rollback({ projectId, snapshot })
        setNotice(`移动失败：${error instanceof Error ? error.message : String(error)}`)
      })
    onChanged?.()
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-medium">任务看板</h2>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">拖拽卡片调整状态与顺序</span>
          <button
            onClick={() => setSettingsOpen(true)}
            className="px-2.5 py-1 rounded-md text-xs border hover:bg-muted"
            data-testid="kanban-settings-btn"
          >
            列设置
          </button>
        </div>
      </div>
      {notice && (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">{notice}</div>
      )}
      <DndContext
        sensors={sensors}
        collisionDetection={closestCorners}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
      >
        <div className="flex gap-4 overflow-x-auto pb-2">
          {columns.map((col) => (
            <KanbanColumn key={col.status.id} status={col.status} tasks={col.tasks} />
          ))}
          {columns.length === 0 && (
            <div className="text-sm text-muted-foreground py-12">暂无状态定义，请先在列设置中添加。</div>
          )}
        </div>
        <DragOverlay>
          {activeTask ? (
            <div className="w-64">
              <TaskCard task={activeTask} />
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>
      {settingsOpen && (
        <KanbanColumnSettings
          projectId={projectId}
          statuses={columns.map((col) => col.status)}
          onChanged={() => {
            onChanged?.()
          }}
          onClose={() => setSettingsOpen(false)}
        />
      )}
    </div>
  )
}

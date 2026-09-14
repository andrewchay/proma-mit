/**
 * 看板列 — Kanban Column
 *
 * 一列 = 一个状态定义 + 该状态下的任务（sortable 容器）。
 * 列头显示任务计数与 WIP 上限（超限标红；仅展示提醒，不强制拦截）。
 */
import * as React from 'react'
import { useDroppable } from '@dnd-kit/core'
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable'
import type { ProjectTaskAtom, ProjectTaskStatusAtom } from '@/atoms/project-atoms'
import { TaskCard } from './TaskCard'

interface KanbanColumnProps {
  status: ProjectTaskStatusAtom
  tasks: ProjectTaskAtom[]
  /** 透传给 TaskCard：点击打开详情 */
  onTaskClick?: (task: ProjectTaskAtom) => void
}

/** 语义组 → 默认列色（项目自定义状态可用 status.color 覆盖） */
const GROUP_COLORS: Record<ProjectTaskStatusAtom['stateGroup'], string> = {
  backlog: 'bg-stone-50',
  unstarted: 'bg-gray-50',
  started: 'bg-blue-50',
  completed: 'bg-green-50',
  cancelled: 'bg-zinc-100',
  triage: 'bg-amber-50',
}

export function KanbanColumn({ status, tasks, onTaskClick }: KanbanColumnProps): React.ReactElement {
  const { setNodeRef, isOver } = useDroppable({ id: `column:${status.id}` })

  const overWip = status.wipLimit !== undefined && tasks.length > status.wipLimit

  return (
    <div className={`${status.color ?? GROUP_COLORS[status.stateGroup]} rounded-lg p-4 border shrink-0 w-64`}>
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-medium truncate" title={status.name}>{status.name}</h3>
        <span className={`text-xs shrink-0 ${overWip ? 'font-medium text-red-600' : 'text-muted-foreground'}`}>
          {tasks.length}{status.wipLimit !== undefined ? ` / WIP ${status.wipLimit}` : ''}
        </span>
      </div>
      <SortableContext items={tasks.map((t) => t.id)} strategy={verticalListSortingStrategy}>
        <div
          ref={setNodeRef}
          className={`space-y-2 min-h-[200px] rounded-md transition-colors ${isOver ? 'ring-2 ring-blue-300 ring-offset-1' : ''}`}
          data-testid={`kanban-column-${status.id}`}
        >
          {tasks.length === 0 ? (
            <div className="text-sm text-muted-foreground text-center py-8">暂无任务</div>
          ) : (
            tasks.map((task) => <TaskCard key={task.id} task={task} columnStateGroup={status.stateGroup} onClick={onTaskClick} />)
          )}
        </div>
      </SortableContext>
    </div>
  )
}

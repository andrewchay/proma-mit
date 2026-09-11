/**
 * 看板任务卡片 — Task Card
 *
 * 可拖拽卡片（@dnd-kit/sortable）：显示标题/描述/负责人 + AI 员工徽标。
 */
import * as React from 'react'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import type { ProjectTaskAtom } from '@/atoms/project-atoms'

interface TaskCardProps {
  task: ProjectTaskAtom
}

export function TaskCard({ task }: TaskCardProps): React.ReactElement {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: task.id })

  const isAgent = task.assignee?.userId?.startsWith('agent-') ?? false

  const style: React.CSSProperties = {
    transform: CSS.Translate.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      className="p-3 bg-white rounded-lg border shadow-sm cursor-grab active:cursor-grabbing hover:shadow-md transition-shadow select-none"
      data-testid={`kanban-card-${task.id}`}
    >
      <p className="text-sm font-medium pointer-events-none">{task.title}</p>
      {task.description && (
        <p className="text-xs text-muted-foreground mt-1 line-clamp-2 pointer-events-none">{task.description}</p>
      )}
      {task.assignee && (
        <div className="mt-2 flex items-center gap-1">
          <span
            className={`text-xs px-1.5 py-0.5 rounded ${isAgent ? 'bg-blue-100 text-blue-700' : 'bg-gray-100 text-gray-600'}`}
          >
            {isAgent ? '🤖' : '👤'} {task.assignee.displayName}
          </span>
        </div>
      )}
    </div>
  )
}

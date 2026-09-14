/**
 * 看板任务卡片 — Task Card
 *
 * 可拖拽卡片（@dnd-kit/sortable）：显示标题/描述/负责人/截止日期紧迫感徽标（completed/cancelled 语义组不展示）+ AI 员工徽标。
 * Agent 负责人的卡片拉取最新执行记录，live 显示 running/failed 等状态（Linear Agent Session 模式）。
 */
import * as React from 'react'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import type { ProjectTaskAtom, ProjectTaskStatusAtom } from '@/atoms/project-atoms'
import { AgentExecutionBadge } from '../AgentTeamPanel'
import { DueDateBadge } from '../DueDateBadge'

interface TaskCardProps {
  task: ProjectTaskAtom
  /** 所在列的语义组（任务列即其状态，拖拽乐观更新时天然一致） */
  columnStateGroup: ProjectTaskStatusAtom['stateGroup']
  /** 点击（未触发拖拽阈值）时打开任务详情 */
  onClick?: (task: ProjectTaskAtom) => void
}

export function TaskCard({ task, columnStateGroup, onClick }: TaskCardProps): React.ReactElement {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: task.id })
  const isAgent = task.assignee?.userId?.startsWith('agent-') ?? false
  const isDone = columnStateGroup === 'completed' || columnStateGroup === 'cancelled'
  const [execStatus, setExecStatus] = React.useState<string | null>(null)

  // Agent 负责人：拉取最新一条执行记录的状态（仅 running/queued/failed/stale 需要展示；完成态由任务状态表达）
  React.useEffect(() => {
    if (!isAgent) return
    let cancelled = false
    const fetchStatus = () => {
      void window.electronAPI.paa.agentEmployees
        .listExecutionsByEntity('task', task.id)
        .then((executions) => {
          if (cancelled) return
          const latest = executions[0]
          setExecStatus(latest?.status ?? null)
        })
        .catch(() => {
          if (!cancelled) setExecStatus(null)
        })
    }
    fetchStatus()
    // running/queued 的执行每 15s 轻量轮询心跳状态（TASK_ACTIVITY_CHANGED 已触发父级刷新，这里兜底）
    const timer = window.setInterval(fetchStatus, 15_000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [isAgent, task.id])

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
      onClick={onClick ? () => onClick(task) : undefined}
      className={`p-3 bg-white rounded-lg border shadow-sm cursor-grab active:cursor-grabbing hover:shadow-md transition-shadow select-none ${execStatus === 'running' ? 'border-blue-300' : ''}`}
      data-testid={`kanban-card-${task.id}`}
    >
      <p className="text-sm font-medium pointer-events-none">{task.title}</p>
      {task.description && (
        <p className="text-xs text-muted-foreground mt-1 line-clamp-2 pointer-events-none">{task.description}</p>
      )}
      {(task.assignee || execStatus || (!isDone && !!task.dueDate)) && (
        <div className="mt-2 flex items-center gap-1 flex-wrap">
          <DueDateBadge dueDate={task.dueDate} isDone={isDone} />
          {task.assignee && (
            <span
              className={`text-xs px-1.5 py-0.5 rounded ${isAgent ? 'bg-blue-100 text-blue-700' : 'bg-gray-100 text-gray-600'}`}
            >
              {isAgent ? '🤖' : '👤'} {task.assignee.displayName}
            </span>
          )}
          {isAgent && execStatus && (
            <AgentExecutionBadge status={execStatus as 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'stale'} />
          )}
        </div>
      )}
    </div>
  )
}

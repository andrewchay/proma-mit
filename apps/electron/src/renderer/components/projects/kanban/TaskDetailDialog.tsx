/**
 * 看板任务详情弹窗 — Task Detail Dialog
 *
 * 点击任务卡片打开：展示标题/描述/负责人/优先级，并支持状态更新。
 * 保存走 updateTask IPC（主进程含草稿规则 / DoD 完成校验），成功后用
 * applyReorderResult 把权威 Task 写回 Jotai（复用其按 id 补丁逻辑）。
 */
import * as React from 'react'
import { useSetAtom } from 'jotai'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { applyReorderResultAtom } from '@/atoms/project-atoms'
import type { ProjectTaskAtom, ProjectTaskStatusAtom } from '@/atoms/project-atoms'
import { priorityLabel } from '../ProjectView'

interface TaskDetailDialogProps {
  projectId: string
  task: ProjectTaskAtom
  statuses: ProjectTaskStatusAtom[]
  /** 保存成功或关闭后回调宿主（如需刷新任务表/指标） */
  onChanged?: () => void
  onClose: () => void
}

/** 主进程 API 调用（与 ProjectView.callProjectAPI 同一通道；就地声明避免循环引用） */
async function callProjectAPI<T>(method: string, ...args: unknown[]): Promise<T> {
  const api = (window as unknown as { electronAPI?: { paa?: { project?: Record<string, (...args: unknown[]) => Promise<unknown>> } } }).electronAPI?.paa?.project
  if (!api) throw new Error('Project API 未初始化')
  const fn = api[method]
  if (!fn) throw new Error(`Project API 方法不存在: ${method}`)
  return fn(...args) as Promise<T>
}

export function TaskDetailDialog({ projectId, task, statuses, onChanged, onClose }: TaskDetailDialogProps): React.ReactElement {
  const applyTaskPatch = useSetAtom(applyReorderResultAtom)
  const [status, setStatus] = React.useState(task.status)
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState('')

  // 弹窗复用时同步最新任务状态（切换卡片不残留上一张的选中值）
  React.useEffect(() => {
    setStatus(task.status)
    setError('')
  }, [task.status])

  const currentStatus = statuses.find((s) => s.id === task.status)
  const dirty = status !== task.status

  const handleSave = async (): Promise<void> => {
    if (!dirty) {
      onClose()
      return
    }
    setSaving(true)
    setError('')
    try {
      const updated = await callProjectAPI<ProjectTaskAtom>('updateTask', task.id, { status })
      // 用落盘后的权威 Task 直接补丁 Jotai（含 updatedAt / completedAt 语义）
      applyTaskPatch({ projectId, result: { task: updated } })
      onChanged?.()
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="max-w-md" data-testid="kanban-task-detail-dialog">
        <DialogHeader>
          <DialogTitle className="text-base">{task.title}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 text-sm">
          {task.description && (
            <p className="text-muted-foreground whitespace-pre-wrap">{task.description}</p>
          )}
          <div className="flex items-center gap-2 flex-wrap text-xs">
            {task.assignee && (
              <span className={`px-1.5 py-0.5 rounded ${task.assignee.userId.startsWith('agent-') ? 'bg-blue-100 text-blue-700' : 'bg-gray-100 text-gray-600'}`}>
                {task.assignee.userId.startsWith('agent-') ? '🤖' : '👤'} {task.assignee.displayName}
              </span>
            )}
            <span className="px-1.5 py-0.5 rounded bg-gray-100 text-gray-600">优先级：{priorityLabel(task.priority)}</span>
            {currentStatus && (
              <span
                className="px-1.5 py-0.5 rounded text-white"
                style={{ backgroundColor: currentStatus.color ?? '#64748b' }}
              >
                {currentStatus.name}
              </span>
            )}
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">状态</label>
            <Select value={status} onValueChange={setStatus}>
              <SelectTrigger className="w-full" data-testid="kanban-task-status-select">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {statuses.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {error && (
            <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900" data-testid="kanban-task-detail-error">
              {error}
            </div>
          )}
        </div>
        <DialogFooter>
          <button
            onClick={() => onClose()}
            className="px-3 py-1.5 text-sm rounded-md border hover:bg-muted"
            disabled={saving}
          >
            取消
          </button>
          <button
            onClick={() => void handleSave()}
            disabled={saving || !dirty}
            className="px-3 py-1.5 text-sm rounded-md bg-primary text-primary-foreground disabled:opacity-50"
            data-testid="kanban-task-detail-save"
          >
            {saving ? '保存中...' : '保存'}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

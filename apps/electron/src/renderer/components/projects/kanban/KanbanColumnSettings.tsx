/**
 * 看板列设置 — Kanban Column Settings
 *
 * 状态 CRUD 弹层：新建/改名/颜色/WIP 上限/组归属/删除（预置五态不可删）。
 * 删除自定义状态时任务迁移到指定状态。
 */
import * as React from 'react'
import type { ProjectTaskStatusAtom } from '@/atoms/project-atoms'

interface KanbanColumnSettingsProps {
  projectId: string
  statuses: ProjectTaskStatusAtom[]
  onChanged: () => void
  onClose: () => void
}

const STATE_GROUPS: Array<{ value: ProjectTaskStatusAtom['stateGroup']; label: string }> = [
  { value: 'backlog', label: 'Backlog（待规划）' },
  { value: 'unstarted', label: '未开始' },
  { value: 'started', label: '进行中' },
  { value: 'completed', label: '已完成' },
  { value: 'cancelled', label: '已取消' },
  { value: 'triage', label: 'Triage（分诊）' },
]

const PRESET_COLORS = ['#64748b', '#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6']

export function KanbanColumnSettings({ projectId, statuses, onChanged, onClose }: KanbanColumnSettingsProps): React.ReactElement {
  const [creating, setCreating] = React.useState(false)
  const [name, setName] = React.useState('')
  const [stateGroup, setStateGroup] = React.useState<ProjectTaskStatusAtom['stateGroup']>('unstarted')
  const [color, setColor] = React.useState<string>(PRESET_COLORS[1]!)
  const [wipLimit, setWipLimit] = React.useState<string>('')
  const [error, setError] = React.useState('')

  /** 删除目标（statusId → 迁移目标） */
  const [migrateTarget, setMigrateTarget] = React.useState<Record<string, string>>({})

  const createStatus = async () => {
    if (!name.trim()) {
      setError('名称不能为空')
      return
    }
    try {
      await callProjectAPI('createTaskStatus', projectId, {
        name: name.trim(),
        stateGroup,
        color,
        ...(wipLimit ? { wipLimit: Number(wipLimit) } : {}),
      })
      setCreating(false)
      setName('')
      setWipLimit('')
      setError('')
      onChanged()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const patchStatus = async (statusId: string, patch: Record<string, unknown>) => {
    try {
      await callProjectAPI('updateTaskStatusDef', projectId, statusId, patch)
      onChanged()
    } catch (err) {
      alert('更新状态失败: ' + (err instanceof Error ? err.message : String(err)))
    }
  }

  const removeStatus = async (statusId: string) => {
    const target = migrateTarget[statusId]
    if (!target) return
    try {
      await callProjectAPI('deleteTaskStatus', projectId, statusId, target)
      onChanged()
    } catch (err) {
      alert('删除状态失败: ' + (err instanceof Error ? err.message : String(err)))
    }
  }

  /** 列排序：与相邻列交换 position（后端按 orderedIds 全量重排） */
  const moveColumn = async (index: number, direction: -1 | 1) => {
    const targetIndex = index + direction
    if (targetIndex < 0 || targetIndex >= statuses.length) return
    const orderedIds = [...statuses.map((s) => s.id)]
    const temp = orderedIds[index]!
    orderedIds[index] = orderedIds[targetIndex]!
    orderedIds[targetIndex] = temp
    try {
      await callProjectAPI('reorderTaskStatuses', projectId, orderedIds)
      onChanged()
    } catch (err) {
      alert('调整列顺序失败: ' + (err instanceof Error ? err.message : String(err)))
    }
  }

  const customStatuses = statuses.filter((s) => !s.isBuiltin)

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div
        className="bg-card rounded-xl border shadow-xl w-[420px] max-h-[80vh] overflow-y-auto p-5 space-y-4"
        onClick={(e) => e.stopPropagation()}
        data-testid="kanban-column-settings"
      >
        <div className="flex items-center justify-between">
          <h3 className="font-medium">看板列设置</h3>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground text-sm">✕</button>
        </div>

        {/* 现有状态列表（预置可改名换色，自定义可删） */}
        <div className="space-y-2">
          {statuses.map((status, index) => (
            <div key={status.id} className="p-2.5 rounded-lg border bg-background/60 space-y-2">
              <div className="flex items-center gap-2">
                <div className="flex flex-col shrink-0">
                  <button
                    onClick={() => void moveColumn(index, -1)}
                    disabled={index === 0}
                    className="text-[10px] leading-none text-muted-foreground hover:text-foreground disabled:opacity-25"
                    title="上移"
                  >▲</button>
                  <button
                    onClick={() => void moveColumn(index, 1)}
                    disabled={index === statuses.length - 1}
                    className="text-[10px] leading-none text-muted-foreground hover:text-foreground disabled:opacity-25"
                    title="下移"
                  >▼</button>
                </div>
                <input
                  type="color"
                  value={status.color ?? PRESET_COLORS[0]!}
                  onChange={(e) => void patchStatus(status.id, { color: e.target.value })}
                  className="w-6 h-6 rounded cursor-pointer border-0 bg-transparent p-0"
                  title="列颜色"
                />
                <input
                  defaultValue={status.name}
                  onBlur={(e) => {
                    const next = e.target.value.trim()
                    if (next && next !== status.name) void patchStatus(status.id, { name: next })
                  }}
                  className="flex-1 text-sm bg-transparent border-b border-transparent focus:border-foreground/30 outline-none"
                />
                <span className="text-xs text-muted-foreground shrink-0">
                  {STATE_GROUPS.find((g) => g.value === status.stateGroup)?.label.split('（')[0]}
                </span>
              </div>
              <div className="flex items-center gap-2 text-xs">
                <label className="text-muted-foreground">WIP 上限</label>
                <input
                  type="number"
                  min={1}
                  defaultValue={status.wipLimit ?? ''}
                  placeholder="不限"
                  onBlur={(e) => {
                    const raw = e.target.value.trim()
                    const next = raw ? Number(raw) : undefined
                    if (next !== status.wipLimit) void patchStatus(status.id, { wipLimit: next })
                  }}
                  className="w-16 px-1.5 py-0.5 rounded border bg-transparent"
                />
                {!status.isBuiltin && (
                  <div className="ml-auto flex items-center gap-1">
                    <select
                      value={migrateTarget[status.id] ?? ''}
                      onChange={(e) => setMigrateTarget((prev) => ({ ...prev, [status.id]: e.target.value }))}
                      className="px-1 py-0.5 rounded border bg-transparent"
                    >
                      <option value="">删除时任务迁移到…</option>
                      {statuses.filter((s) => s.id !== status.id).map((s) => (
                        <option key={s.id} value={s.id}>{s.name}</option>
                      ))}
                    </select>
                    <button
                      onClick={() => void removeStatus(status.id)}
                      disabled={!migrateTarget[status.id]}
                      className="px-1.5 py-0.5 rounded border text-red-600 hover:bg-red-50 disabled:opacity-40"
                    >
                      删除
                    </button>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>

        {/* 新建状态 */}
        {creating ? (
          <div className="p-3 rounded-lg border space-y-2">
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="状态名称"
              className="w-full px-2 py-1 rounded border bg-transparent text-sm"
            />
            <div className="flex items-center gap-2">
              <select
                value={stateGroup}
                onChange={(e) => setStateGroup(e.target.value as ProjectTaskStatusAtom['stateGroup'])}
                className="flex-1 px-2 py-1 rounded border bg-transparent text-xs"
              >
                {STATE_GROUPS.map((g) => <option key={g.value} value={g.value}>{g.label}</option>)}
              </select>
              <div className="flex gap-1">
                {PRESET_COLORS.map((c) => (
                  <button
                    key={c}
                    onClick={() => setColor(c)}
                    style={{ backgroundColor: c }}
                    className={`w-5 h-5 rounded-full ${color === c ? 'ring-2 ring-offset-1 ring-foreground/50' : ''}`}
                  />
                ))}
              </div>
            </div>
            <div className="flex items-center gap-2">
              <input
                type="number"
                min={1}
                value={wipLimit}
                onChange={(e) => setWipLimit(e.target.value)}
                placeholder="WIP 上限（不限）"
                className="w-32 px-2 py-1 rounded border bg-transparent text-xs"
              />
              <button onClick={() => void createStatus()} className="ml-auto px-3 py-1 rounded bg-blue-600 text-white text-xs">创建</button>
              <button onClick={() => setCreating(false)} className="px-3 py-1 rounded border text-xs">取消</button>
            </div>
            {error && <p className="text-xs text-red-600">{error}</p>}
          </div>
        ) : (
          <button
            onClick={() => setCreating(true)}
            className="w-full py-2 rounded-lg border border-dashed text-sm text-muted-foreground hover:text-foreground hover:border-foreground/40"
          >
            + 新增状态列
          </button>
        )}

        {customStatuses.length === 0 && !creating && (
          <p className="text-xs text-muted-foreground">预置五态（草稿/待处理/进行中/已暂停/已完成）不可删除，可改名换色。</p>
        )}
      </div>
    </div>
  )
}

/** 主进程 API 调用（与 ProjectView.callProjectAPI 同一通道；就地声明避免循环引用） */
async function callProjectAPI<T>(method: string, ...args: unknown[]): Promise<T> {
  const api = (window as unknown as { electronAPI?: { paa?: { project?: Record<string, (...args: unknown[]) => Promise<unknown>> } } }).electronAPI?.paa?.project
  if (!api) throw new Error('Project API 未初始化')
  const fn = api[method]
  if (!fn) throw new Error(`Project API 方法不存在: ${method}`)
  return fn(...args) as Promise<T>
}

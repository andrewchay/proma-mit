/**
 * GoalsSettings — 目标（Goal）状态层看板（P0）
 *
 * 展示/管理长生命周期 Goal：目标、todos、用户门控（gates）、evidence。
 * 借鉴 LoopX 的 Goal 控制平面思想，本地 JSON 存储，后台只读投影 + 用户操作。
 */

import * as React from 'react'
import { Target, Plus, Trash2, ChevronRight, ChevronDown, CircleDot, Check, Lock, Unlock, FileText, GitBranch } from 'lucide-react'
import { toast } from 'sonner'
import { SettingsSection } from './primitives/SettingsSection'
import { SettingsCard } from './primitives/SettingsCard'
import { Button } from '@/components/ui/button'
import type {
  Goal,
  GoalGate,
  GoalPhase,
  GoalTodo,
  GoalTodoStatus,
} from '@proma/shared'

const PHASE_LABEL: Record<GoalPhase, { label: string; className: string }> = {
  draft: { label: '草稿', className: 'bg-foreground/[0.06] text-foreground/60' },
  active: { label: '进行中', className: 'bg-blue-500/10 text-blue-500' },
  waiting_user: { label: '等待用户', className: 'bg-amber-500/10 text-amber-600' },
  blocked: { label: '被阻塞', className: 'bg-red-500/10 text-red-600' },
  completed: { label: '已完成', className: 'bg-green-500/10 text-green-600' },
  archived: { label: '已归档', className: 'bg-foreground/[0.05] text-foreground/40' },
}

const TODO_STATUS_LABEL: Record<GoalTodoStatus, string> = {
  open: '待办',
  claimed: '已领取',
  in_progress: '进行中',
  blocked: '被阻塞',
  done: '已完成',
  deferred: '已推迟',
}

const TODO_CLASS_LABEL: Record<string, string> = {
  user_gate: '用户判断',
  agent_work: 'Agent 执行',
  monitor: '监控',
  checkpoint: '检查点',
}

function formatTime(ts: number): string {
  const d = new Date(ts)
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

// ===== Goal 详情 =====

interface GoalDetailProps {
  goal: Goal
  onChange: (goal: Goal) => void
}

function GoalDetail({ goal, onChange }: GoalDetailProps): React.ReactElement {
  const [newTodo, setNewTodo] = React.useState('')
  const [newGate, setNewGate] = React.useState('')
  const [newEvidence, setNewEvidence] = React.useState('')
  /** A2：关联的会话列表 */
  const [boundSessions, setBoundSessions] = React.useState<Array<{ sessionId: string; title: string }>>([])
  const [bindSessionId, setBindSessionId] = React.useState('')
  /** E1：编辑态 */
  const [editing, setEditing] = React.useState(false)
  const [editTitle, setEditTitle] = React.useState(goal.title)
  const [editObjective, setEditObjective] = React.useState(goal.objective)
  const [editScope, setEditScope] = React.useState(goal.scope.join(','))
  const [editBudget, setEditBudget] = React.useState(goal.quota?.maxBudgetUsd?.toString() ?? '')
  /** E6：证据折叠 */
  const [evidenceExpanded, setEvidenceExpanded] = React.useState(false)

  React.useEffect(() => {
    void window.electronAPI.goalListSessions(goal.id).then(setBoundSessions).catch(() => {})
  }, [goal.id])
  const handle = async <T,>(fn: () => Promise<T>): Promise<void> => {
    try {
      await fn()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '操作失败')
    }
  }

  const reload = async (): Promise<void> => {
    const updated = await window.electronAPI.getGoal(goal.id)
    if (updated) onChange(updated)
  }

  return (
    <div className="space-y-4">
      {/* 目标头部（E1：支持编辑） */}
      {editing ? (
        <div className="space-y-3 p-3 rounded-xl bg-muted/40 border border-border/40">
          <input
            type="text"
            value={editTitle}
            onChange={(e) => setEditTitle(e.target.value)}
            placeholder="目标标题"
            className="w-full bg-transparent text-base font-semibold outline-none placeholder:text-muted-foreground/50"
          />
          <textarea
            value={editObjective}
            onChange={(e) => setEditObjective(e.target.value)}
            placeholder="目标描述"
            rows={3}
            className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground/50 resize-none"
          />
          <input
            type="text"
            value={editScope}
            onChange={(e) => setEditScope(e.target.value)}
            placeholder="作用域（逗号分隔）"
            className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground/50 border-b border-border/40 pb-1"
          />
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground shrink-0">配额上限 (USD)</span>
            <input
              type="number"
              min="0"
              step="0.01"
              value={editBudget}
              onChange={(e) => setEditBudget(e.target.value)}
              placeholder="留空不限制"
              className="w-28 bg-transparent text-sm outline-none placeholder:text-muted-foreground/50 border-b border-border/40 pb-1"
            />
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setEditing(false)}>取消</Button>
            <Button size="sm" onClick={() => {
              void handle(async () => {
                const scope = editScope.split(',').map((s) => s.trim()).filter(Boolean)
                const quota = editBudget.trim() && Number(editBudget) > 0
                  ? { maxBudgetUsd: Number(editBudget), spentUsd: goal.quota?.spentUsd ?? 0 }
                  : undefined
                const updated = await window.electronAPI.updateGoal(goal.id, {
                  title: editTitle.trim() || goal.title,
                  objective: editObjective.trim(),
                  scope,
                  ...(quota ? { quota } : {}),
                } as import('@proma/shared').GoalUpdateInput)
                onChange(updated)
                setEditing(false)
              })
            }}>保存</Button>
          </div>
        </div>
      ) : (
        <div className="flex items-start justify-between">
          <div className="space-y-1">
            <h3 className="text-base font-semibold text-foreground">{goal.title}</h3>
            <p className="text-sm text-muted-foreground whitespace-pre-wrap">{goal.objective}</p>
            {goal.scope.length > 0 && (
              <div className="flex flex-wrap gap-1 pt-1">
                {goal.scope.map((scope) => (
                  <span key={scope} className="px-1.5 py-0.5 rounded bg-foreground/[0.05] text-[11px] text-muted-foreground">
                    {scope}
                  </span>
                ))}
              </div>
            )}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => { setEditTitle(goal.title); setEditObjective(goal.objective); setEditScope(goal.scope.join(',')); setEditBudget(goal.quota?.maxBudgetUsd?.toString() ?? ''); setEditing(true) }}
              className="px-2 py-0.5 rounded bg-foreground/[0.05] text-[11px] text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
            >
              编辑
            </button>
            <span className={`px-2 py-0.5 rounded text-xs font-medium ${(PHASE_LABEL[goal.phase] ?? PHASE_LABEL.draft).className}`}>
              {(PHASE_LABEL[goal.phase] ?? PHASE_LABEL.draft).label}
            </span>
          </div>
        </div>
      )}

      {/* 配额展示（P1） */}
      {goal.quota?.maxBudgetUsd !== undefined && (
        <div className="flex items-center gap-2 text-[11px] text-muted-foreground px-1">
          <span>配额</span>
          <div className="flex-1 h-1.5 rounded-full bg-foreground/10 overflow-hidden">
            <div
              className="h-full rounded-full bg-blue-500/60"
              style={{
                width: `${Math.min(100, ((goal.quota.spentUsd ?? 0) / goal.quota.maxBudgetUsd) * 100)}%`,
              }}
            />
          </div>
          <span className="tabular-nums">
            ${(goal.quota.spentUsd ?? 0).toFixed(3)} / ${goal.quota.maxBudgetUsd.toFixed(3)}
          </span>
        </div>
      )}

      {/* Todos */}
      <SettingsCard>
        <div className="px-4 py-2 text-sm font-medium text-foreground/80 border-b border-border/30 flex items-center gap-2">
          <CircleDot size={14} />
          Todos
          <span className="text-[11px] text-muted-foreground">
            {goal.todos.filter((t) => !['done', 'deferred'].includes(t.status)).length} 待办
          </span>
        </div>
        <div className="flex flex-col">
          {goal.todos.map((todo) => (
            <div key={todo.id} className="flex items-center gap-2.5 px-4 py-2 border-b border-border/30 last:border-b-0 text-[12.5px]">
              <button
                type="button"
                onClick={() => {
                  const next = todo.status === 'done' ? 'open' : 'done'
                  void handle(async () => {
                    const updated = await window.electronAPI.updateGoalTodoStatus(goal.id, todo.id, next)
                    onChange(updated)
                  })
                }}
                className={`w-4 h-4 shrink-0 rounded-full border flex items-center justify-center transition-colors ${
                  todo.status === 'done' ? 'bg-green-500/20 border-green-500 text-green-500' : 'border-foreground/30 text-transparent hover:border-foreground/60'
                }`}
                title={todo.status === 'done' ? '标记为未完成' : '标记完成'}
              >
                <Check size={11} />
              </button>
              <span className={`flex-1 ${todo.status === 'done' ? 'line-through text-muted-foreground/60' : 'text-foreground/85'}`}>
                {todo.text}
              </span>
              <span className="shrink-0 px-1.5 py-0.5 rounded bg-foreground/[0.05] text-[10px] text-muted-foreground">
                {TODO_CLASS_LABEL[todo.class] ?? todo.class}
              </span>
              {todo.claimedBy && (
                <span className="shrink-0 px-1.5 py-0.5 rounded bg-blue-500/10 text-[10px] text-blue-500">
                  {todo.claimedBy}
                </span>
              )}
              <span className="shrink-0 text-[10px] text-muted-foreground/60 w-[42px] text-right">
                {TODO_STATUS_LABEL[todo.status] ?? todo.status}
              </span>
            </div>
          ))}
          {goal.todos.length === 0 && (
            <div className="px-4 py-6 text-center text-sm text-muted-foreground">暂无 todo</div>
          )}
        </div>
        <div className="flex items-center gap-2 px-4 py-2">
          <input
            type="text"
            value={newTodo}
            onChange={(e) => setNewTodo(e.target.value)}
            placeholder="添加 todo…"
            className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground/50"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && newTodo.trim()) {
                void handle(async () => {
                  const updated = await window.electronAPI.upsertGoalTodo(goal.id, { text: newTodo.trim() })
                  onChange(updated)
                  setNewTodo('')
                })
              }
            }}
          />
          <Button
            variant="ghost"
            size="sm"
            disabled={!newTodo.trim()}
            onClick={() => {
              void handle(async () => {
                const updated = await window.electronAPI.upsertGoalTodo(goal.id, { text: newTodo.trim() })
                onChange(updated)
                setNewTodo('')
              })
            }}
          >
            <Plus size={14} />
          </Button>
        </div>
      </SettingsCard>

      {/* 用户门控 Gates */}
      <SettingsCard>
        <div className="px-4 py-2 text-sm font-medium text-foreground/80 border-b border-border/30 flex items-center gap-2">
          <Lock size={14} />
          用户门控（Gate）
          <span className="text-[11px] text-muted-foreground">
            {goal.gates.filter((g) => g.status === 'open').length} 待处理
          </span>
        </div>
        <div className="flex flex-col">
          {goal.gates.map((gate: GoalGate) => (
            <div key={gate.id} className="flex items-start gap-2.5 px-4 py-2 border-b border-border/30 last:border-b-0 text-[12.5px]">
              {gate.status === 'open' ? (
                <Lock size={13} className="mt-0.5 shrink-0 text-amber-500" />
              ) : (
                <Unlock size={13} className="mt-0.5 shrink-0 text-green-500" />
              )}
              <div className="flex-1">
                <div className={gate.status === 'resolved' ? 'line-through text-muted-foreground/60' : 'text-foreground/85'}>
                  {gate.question}
                </div>
                {gate.resolution && <div className="text-[11px] text-muted-foreground mt-0.5">→ {gate.resolution}</div>}
              </div>
              {gate.status === 'open' && (
                <ResolveGateButton goalId={goal.id} gateId={gate.id} onChange={reload} />
              )}
            </div>
          ))}
          {goal.gates.length === 0 && (
            <div className="px-4 py-6 text-center text-sm text-muted-foreground">暂无用户门控</div>
          )}
        </div>
        <div className="flex items-center gap-2 px-4 py-2">
          <input
            type="text"
            value={newGate}
            onChange={(e) => setNewGate(e.target.value)}
            placeholder="提出需要用户判断的问题…"
            className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground/50"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && newGate.trim()) {
                void handle(async () => {
                  const updated = await window.electronAPI.addGoalGate(goal.id, newGate.trim())
                  onChange(updated)
                  setNewGate('')
                })
              }
            }}
          />
          <Button
            variant="ghost"
            size="sm"
            disabled={!newGate.trim()}
            onClick={() => {
              void handle(async () => {
                const updated = await window.electronAPI.addGoalGate(goal.id, newGate.trim())
                onChange(updated)
                setNewGate('')
              })
            }}
          >
            <Plus size={14} />
          </Button>
        </div>
      </SettingsCard>

      {/* 证据 Evidence（E6：折叠 + 导出） */}
      <SettingsCard>
        <div className="px-4 py-2 text-sm font-medium text-foreground/80 border-b border-border/30 flex items-center gap-2">
          <FileText size={14} />
          证据
          <span className="text-[11px] text-muted-foreground flex-1">{goal.evidence.length} 条</span>
          {goal.evidence.length > 0 && (
            <button
              type="button"
              onClick={() => {
                const text = [...goal.evidence].reverse().join('\n')
                void navigator.clipboard.writeText(text).then(() => toast.success('证据已复制')).catch(() => toast.error('复制失败'))
              }}
              className="shrink-0 px-2 py-0.5 rounded bg-foreground/[0.05] text-[11px] text-muted-foreground hover:bg-foreground/10"
            >
              导出
            </button>
          )}
        </div>
        <div className="flex flex-col">
          {[...goal.evidence].reverse().map((ev, idx) => {
            if (!evidenceExpanded && idx >= 20) return null
            return (
              <div key={idx} className="px-4 py-2 border-b border-border/30 last:border-b-0 text-[12px] text-muted-foreground/85 whitespace-pre-wrap">
                {ev}
              </div>
            )
          })}
          {!evidenceExpanded && goal.evidence.length > 20 && (
            <button
              type="button"
              onClick={() => setEvidenceExpanded(true)}
              className="px-4 py-2 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
            >
              展开全部 {goal.evidence.length - 20} 条 ↓
            </button>
          )}
          {goal.evidence.length === 0 && (
            <div className="px-4 py-6 text-center text-sm text-muted-foreground">暂无证据</div>
          )}
        </div>
        <div className="flex items-center gap-2 px-4 py-2">
          <input
            type="text"
            value={newEvidence}
            onChange={(e) => setNewEvidence(e.target.value)}
            placeholder="追加证据（做了什么、改了什么、结果如何）…"
            className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground/50"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && newEvidence.trim()) {
                void handle(async () => {
                  const updated = await window.electronAPI.appendGoalEvidence(goal.id, newEvidence.trim())
                  onChange(updated)
                  setNewEvidence('')
                })
              }
            }}
          />
          <Button
            variant="ghost"
            size="sm"
            disabled={!newEvidence.trim()}
            onClick={() => {
              void handle(async () => {
                const updated = await window.electronAPI.appendGoalEvidence(goal.id, newEvidence.trim())
                onChange(updated)
                setNewEvidence('')
              })
            }}
          >
            <Plus size={14} />
          </Button>
        </div>
      </SettingsCard>

      {/* 关联会话（A2） */}
      <SettingsCard>
        <div className="px-4 py-2 text-sm font-medium text-foreground/80 border-b border-border/30 flex items-center gap-2">
          <Target size={14} />
          关联会话
          <span className="text-[11px] text-muted-foreground">{boundSessions.length} 个会话</span>
        </div>
        <div className="flex flex-col">
          {boundSessions.map((s) => (
            <div key={s.sessionId} className="flex items-center gap-2.5 px-4 py-2 border-b border-border/30 last:border-b-0 text-[12px]">
              <span className="flex-1 truncate text-foreground/85" title={s.sessionId}>{s.title || s.sessionId}</span>
              <span className="shrink-0 text-[10px] text-muted-foreground/60 tabular-nums">{s.sessionId.slice(0, 8)}</span>
              <button
                type="button"
                onClick={async () => {
                  await window.electronAPI.goalUnbindSession(s.sessionId)
                  setBoundSessions((prev) => prev.filter((x) => x.sessionId !== s.sessionId))
                  void reload()
                }}
                className="shrink-0 px-2 py-0.5 rounded bg-foreground/[0.05] text-[11px] text-muted-foreground hover:bg-red-500/10 hover:text-red-500"
              >
                解绑
              </button>
            </div>
          ))}
          {boundSessions.length === 0 && (
            <div className="px-4 py-6 text-center text-sm text-muted-foreground">尚未绑定任何会话</div>
          )}
        </div>
        <div className="flex items-center gap-2 px-4 py-2">
          <input
            type="text"
            value={bindSessionId}
            onChange={(e) => setBindSessionId(e.target.value)}
            placeholder="输入 Agent 会话 ID 绑定到本目标…"
            className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground/50"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && bindSessionId.trim()) {
                void (async () => {
                  try {
                    await window.electronAPI.goalBindSession(bindSessionId.trim(), goal.id)
                    setBindSessionId('')
                    setBoundSessions(await window.electronAPI.goalListSessions(goal.id))
                    toast.success('会话已绑定')
                    void reload()
                  } catch (err) {
                    toast.error(err instanceof Error ? err.message : '绑定失败')
                  }
                })()
              }
            }}
          />
          <Button
            variant="ghost"
            size="sm"
            disabled={!bindSessionId.trim()}
            onClick={() => {
              void (async () => {
                try {
                  await window.electronAPI.goalBindSession(bindSessionId.trim(), goal.id)
                  setBindSessionId('')
                  setBoundSessions(await window.electronAPI.goalListSessions(goal.id))
                  toast.success('会话已绑定')
                  void reload()
                } catch (err) {
                  toast.error(err instanceof Error ? err.message : '绑定失败')
                }
              })()
            }}
          >
            <Plus size={14} />
          </Button>
        </div>
      </SettingsCard>
    </div>
  )
}

function ResolveGateButton({ goalId, gateId, onChange }: { goalId: string; gateId: string; onChange: () => Promise<void> | void }): React.ReactElement {
  const [open, setOpen] = React.useState(false)
  const [resolution, setResolution] = React.useState('')

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="shrink-0 px-2 py-0.5 rounded bg-green-500/10 text-green-600 text-[11px] hover:bg-green-500/20"
      >
        解决
      </button>
    )
  }

  return (
    <div className="flex items-center gap-1.5 shrink-0">
      <input
        type="text"
        value={resolution}
        onChange={(e) => setResolution(e.target.value)}
        placeholder="解决结果…"
        className="w-40 bg-transparent border-b border-border/40 text-[12px] outline-none placeholder:text-muted-foreground/50"
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            void (async () => {
              await window.electronAPI.resolveGoalGate(goalId, gateId, resolution || '已确认')
              setOpen(false)
              setResolution('')
              await onChange()
            })()
          }
          if (e.key === 'Escape') setOpen(false)
        }}
        autoFocus
      />
    </div>
  )
}

// ===== 主组件 =====

export function GoalsSettings(): React.ReactElement {
  const [goals, setGoals] = React.useState<Goal[]>([])
  const [selectedId, setSelectedId] = React.useState<string | null>(null)
  const [selectedGoal, setSelectedGoal] = React.useState<Goal | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [creating, setCreating] = React.useState(false)
  const [title, setTitle] = React.useState('')
  const [objective, setObjective] = React.useState('')
  /** E1: 创建表单增强 */
  const [scopeText, setScopeText] = React.useState('')
  const [maxBudgetUsd, setMaxBudgetUsd] = React.useState('')
  /** 概览聚合数据（P2-4） */
  const [overview, setOverview] = React.useState<{
    activeGoals: number
    openGates: number
    todayTokens: number
    totalCost: number
  }>({ activeGoals: 0, openGates: 0, todayTokens: 0, totalCost: 0 })

  const load = React.useCallback(async (): Promise<void> => {
    setLoading(true)
    try {
      const list = await window.electronAPI.listGoals()
      setGoals(list)

      // 概览：活跃 goag、未处理 gate、今日 token、总费用
      const activeGoals = list.filter((g) => ['active', 'waiting_user', 'blocked'].includes(g.phase)).length
      const openGates = list.reduce((acc, g) => acc + g.gates.filter((gate) => gate.status === 'open').length, 0)

      let todayTokens = 0
      let totalCost = 0
      try {
        const dayStart = new Date()
        dayStart.setHours(0, 0, 0, 0)
        const agg = await window.electronAPI.aggregateTokenUsage({ from: dayStart.getTime() })
        todayTokens = agg.totalTokens
        totalCost = agg.totalCost
      } catch (_err) {
        // token 统计可能未启用，忽略
      }
      setOverview({ activeGoals, openGates, todayTokens, totalCost })
    } catch (err) {
      console.error('[目标] 加载失败:', err)
      toast.error('加载目标失败')
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    void load()
  }, [load])

  React.useEffect(() => {
    if (!selectedId) {
      setSelectedGoal(null)
      return
    }
    void (async () => {
      const goal = await window.electronAPI.getGoal(selectedId)
      setSelectedGoal(goal)
    })()
  }, [selectedId])

  const handleCreate = async (): Promise<void> => {
    if (!title.trim() || !objective.trim()) {
      toast.error('目标标题和描述不能为空')
      return
    }
    try {
      const scope = scopeText.split(',').map((s) => s.trim()).filter(Boolean)
      const quota = maxBudgetUsd.trim() && Number(maxBudgetUsd) > 0
        ? { maxBudgetUsd: Number(maxBudgetUsd) }
        : undefined
      const goal = await window.electronAPI.createGoal({
        title: title.trim(),
        objective: objective.trim(),
        ...(scope.length > 0 ? { scope } : {}),
        ...(quota ? { quota } : {}),
      } as import('@proma/shared').GoalCreateInput)
      setCreating(false)
      setTitle('')
      setObjective('')
      setScopeText('')
      setMaxBudgetUsd('')
      setGoals((prev) => [goal, ...prev])
      setSelectedId(goal.id)
      toast.success('目标已创建')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '创建失败')
    }
  }

  const archiveSelected = async (): Promise<void> => {
    if (!selectedGoal) return
    try {
      const updated = await window.electronAPI.updateGoal(selectedGoal.id, { phase: 'archived' })
      setSelectedGoal(updated)
      await load()
      toast.success('目标已归档')
    } catch (_err) {
      toast.error('归档失败')
    }
  }

  const deleteSelected = async (): Promise<void> => {
    if (!selectedGoal) return
    try {
      await window.electronAPI.deleteGoal(selectedGoal.id)
      setSelectedId(null)
      setSelectedGoal(null)
      await load()
      toast.success('目标已删除')
    } catch (_err) {
      toast.error('删除失败')
    }
  }

  return (
    <SettingsSection
      title="目标（Goals）"
      description="长生命周期工作目标：跨会话追踪目标、todos、用户门控与证据（借鉴 LoopX 控制平面，本地存储）"
      action={
        <Button variant="outline" size="sm" onClick={() => setCreating((v) => !v)}>
          <Plus size={14} className="mr-1.5" />
          新建目标
        </Button>
      }
    >
      {loading ? null : (
        // P2-4 Goal Dashboard 首屏：概览卡片
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-2">
          <div className="rounded-xl bg-card border border-border/40 p-3 shadow-sm">
            <div className="text-[11px] text-muted-foreground mb-1">活跃目标</div>
            <div className="text-xl font-semibold tabular-nums">{overview.activeGoals}</div>
          </div>
          <div className="rounded-xl bg-card border border-border/40 p-3 shadow-sm">
            <div className="text-[11px] text-muted-foreground mb-1">待处理门控</div>
            <div className="text-xl font-semibold tabular-nums text-amber-600">{overview.openGates}</div>
          </div>
          <div className="rounded-xl bg-card border border-border/40 p-3 shadow-sm">
            <div className="text-[11px] text-muted-foreground mb-1">今日 Token</div>
            <div className="text-xl font-semibold tabular-nums">{overview.todayTokens.toLocaleString()}</div>
          </div>
          <div className="rounded-xl bg-card border border-border/40 p-3 shadow-sm">
            <div className="text-[11px] text-muted-foreground mb-1">总费用</div>
            <div className="text-xl font-semibold tabular-nums">
              {overview.totalCost === 0 ? '$0.00' : `$${overview.totalCost.toFixed(4)}`}
            </div>
          </div>
        </div>
      )}

      {/* 新建表单 */}
      {creating && (
        <SettingsCard className="mb-3">
          <div className="p-4 space-y-3">
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="目标标题（如：实现 Token 统计功能）"
              className="w-full bg-transparent text-sm font-medium outline-none placeholder:text-muted-foreground/50 border-b border-border/40 pb-1.5"
            />
            <textarea
              value={objective}
              onChange={(e) => setObjective(e.target.value)}
              placeholder="目标描述 / Objective（这个目标要达成什么、成功标准是什么）"
              rows={3}
              className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground/50 resize-none"
            />
            <input
              type="text"
              value={scopeText}
              onChange={(e) => setScopeText(e.target.value)}
              placeholder="作用域 / 允许操作的路径（逗号分隔，可选）"
              className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground/50 border-b border-border/40 pb-1.5"
            />
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground shrink-0">配额上限 (USD)</span>
              <input
                type="number"
                min="0"
                step="0.01"
                value={maxBudgetUsd}
                onChange={(e) => setMaxBudgetUsd(e.target.value)}
                placeholder="留空不限制"
                className="w-28 bg-transparent text-sm outline-none placeholder:text-muted-foreground/50 border-b border-border/40 pb-1"
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setCreating(false)}>
                取消
              </Button>
              <Button size="sm" onClick={() => void handleCreate()}>
                创建
              </Button>
            </div>
          </div>
        </SettingsCard>
      )}

      <div className="grid grid-cols-1 md:grid-cols-[280px_1fr] gap-4">
        {/* Goal 列表 */}
        <SettingsCard divided={false}>
          {loading ? (
            <div className="px-4 py-8 text-center text-sm text-muted-foreground">加载中…</div>
          ) : goals.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm text-muted-foreground">
              暂无目标
              <div className="mt-1 text-xs">点击右上角「新建目标」开始</div>
            </div>
          ) : (
            <div className="flex flex-col max-h-[70vh] overflow-y-auto">
              {goals.map((goal) => {
                const isSelected = goal.id === selectedId
                const meta = PHASE_LABEL[goal.phase] ?? PHASE_LABEL.draft
                return (
                  <button
                    key={goal.id}
                    type="button"
                    onClick={() => setSelectedId(goal.id)}
                    className={`flex items-center gap-2 px-3 py-2.5 text-left transition-colors ${
                      isSelected ? 'bg-primary/10' : 'hover:bg-muted/50'
                    }`}
                  >
                    <span className={`shrink-0 w-2 h-2 rounded-full ${meta.className.includes('bg-red') ? 'bg-red-500' : meta.className.includes('bg-amber') ? 'bg-amber-500' : meta.className.includes('bg-blue') ? 'bg-blue-500' : meta.className.includes('bg-green') ? 'bg-green-500' : 'bg-foreground/30'}`} />
                    <div className="flex-1 min-w-0">
                      <div className="truncate text-[13px] font-medium text-foreground/90">{goal.title}</div>
                      <div className="text-[11px] text-muted-foreground">
                        {formatTime(goal.updatedAt)}
                      </div>
                    </div>
                    {goal.gates.some((g) => g.status === 'open') && (
                      <Lock size={11} className="shrink-0 text-amber-500" />
                    )}
                    {isSelected ? <ChevronDown size={14} className="shrink-0 text-muted-foreground" /> : <ChevronRight size={14} className="shrink-0 text-muted-foreground/40" />}
                  </button>
                )
              })}
            </div>
          )}
        </SettingsCard>

        {/* Goal 详情 */}
        {selectedGoal ? (
          <div>
            <div className="flex items-center justify-end gap-2 mb-2">
              <Button variant="ghost" size="sm" onClick={() => void archiveSelected()}>
                归档
              </Button>
              <Button variant="ghost" size="sm" className="text-red-500 hover:text-red-600" onClick={() => void deleteSelected()}>
                <Trash2 size={14} className="mr-1" />
                删除
              </Button>
            </div>
            <GoalDetail goal={selectedGoal} onChange={(updated) => setSelectedGoal(updated)} />
          </div>
        ) : (
          <SettingsCard divided={false}>
            <div className="px-4 py-16 text-center text-sm text-muted-foreground">
              <GitBranch size={32} className="mx-auto mb-3 text-muted-foreground/30" />
              选择左侧一个目标查看详情
            </div>
          </SettingsCard>
        )}
      </div>

      {selectedGoal && (
        <div className="mt-3 text-[11px] text-muted-foreground/60 flex items-center gap-1">
          <Target size={12} />
          引用了 LoopX 的 Goal 控制平面理念：状态与执行解耦，人类判断永不外包。
        </div>
      )}
    </SettingsSection>
  )
}

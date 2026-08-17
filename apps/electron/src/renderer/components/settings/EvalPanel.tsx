/**
 * EvalPanel — 评测 / 自演化面板。
 *
 * 能力：查看 Benchmark 列表与 scoreboard、新建 Benchmark（含 Cases + Rubric）、
 * 触发真实评测（Baseline / Improve）、审阅与消除内置 sub-agent 的持久化覆盖（采纳写回）。
 *
 * 数据全部来自主进程 IPC（window.electronAPI.eval*）。
 */

import * as React from 'react'
import {
  Play,
  TrendingUp,
  Plus,
  Trash2,
  RefreshCw,
  RotateCcw,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { SettingsSection, SettingsCard, SettingsRow, SettingsInput } from './primitives'

const BUILTIN_TARGETS = ['code-reviewer', 'explorer', 'researcher'] as const

const TARGET_LABELS: Record<string, string> = {
  'code-reviewer': 'Code Reviewer',
  explorer: 'Explorer',
  researcher: 'Researcher',
}

interface EvalBench {
  id: string
  title: string
  description: string
  targetAgentId: string
  targetScore: number
  latestScore: number | null
  lastEvaluationTime: string | null
  createdAt: string
  updatedAt: string
  cases: string[]
}

interface EvalDetail {
  config: { id: string; title: string; targetAgentId: string; targetScore: number; cases: string[] }
  scoreboard: {
    evaluations: Array<{ time: string; agentVersion: number; score: number; costUsd?: number | null; durationMs?: number | null }>
  }
  cases: Array<{ caseId: string; statement: string | null }>
}

export function EvalPanel(): React.ReactElement {
  const [benchmarks, setBenchmarks] = React.useState<EvalBench[]>([])
  const [selected, setSelected] = React.useState<string | null>(null)
  const [detail, setDetail] = React.useState<EvalDetail | null>(null)
  const [busy, setBusy] = React.useState<string | null>(null)
  const [notice, setNotice] = React.useState<string | null>(null)
  const [prompts, setPrompts] = React.useState<Record<string, { prompt?: string }>>({})
  const [pendingAdopt, setPendingAdopt] = React.useState<{ agentId: string; prompt: string } | null>(null)

  const [showCreate, setShowCreate] = React.useState(false)

  const refresh = React.useCallback(async () => {
    try {
      const [benches, overrides] = await Promise.all([
        window.electronAPI.listEvalBenchmarks(),
        window.electronAPI.listEvalPrompts(),
      ])
      setBenchmarks(benches)
      setPrompts(overrides)
    } catch (error) {
      setNotice(`载入评测数据失败: ${String(error)}`)
    }
  }, [])

  React.useEffect(() => {
    void refresh()
  }, [refresh])

  const loadDetail = React.useCallback(async (id: string) => {
    setBusy(`load-${id}`)
    try {
      setDetail(await window.electronAPI.getEvalBenchmark(id))
      setSelected(id)
    } catch (error) {
      setNotice(`读取 Benchmark 失败: ${String(error)}`)
    } finally {
      setBusy(null)
    }
  }, [])

  const runBaseline = async (id: string): Promise<void> => {
    setBusy(`baseline-${id}`)
    setNotice(null)
    try {
      const r = await window.electronAPI.runEvalBaseline(id)
      setNotice(`Baseline 完成：score=${r.score}`)
      await refresh()
      await loadDetail(id)
    } catch (error) {
      setNotice(`Baseline 失败: ${String(error)}`)
    } finally {
      setBusy(null)
    }
  }

  const runImprove = async (id: string): Promise<void> => {
    setBusy(`improve-${id}`)
    setNotice(null)
    setPendingAdopt(null)
    try {
      const r = await window.electronAPI.runEvalImprove(id)
      setNotice(`Improve 完成：baseline=${r.baselineScore} → final=${r.finalScore}，接受候选 ${r.acceptedRounds} 轮（未自动写回）`)
      // 若存在被接受候选，展示供「审查并采纳」
      const bench = benchmarks.find((b) => b.id === id)
      if (r.bestAcceptedPrompt && bench) {
        setPendingAdopt({ agentId: bench.targetAgentId, prompt: r.bestAcceptedPrompt })
      }
      await refresh()
      await loadDetail(id)
    } catch (error) {
      setNotice(`Improve 失败: ${String(error)}`)
    } finally {
      setBusy(null)
    }
  }

  const doAdopt = async (agentId: string, prompt: string): Promise<void> => {
    setBusy(`adopt-${agentId}`)
    try {
      const r = await window.electronAPI.adoptEvalPrompt(agentId, prompt)
      setPendingAdopt(null)
      setNotice(r.applied ? `已采纳写回 ${agentId}（写入 AGENTS.md，后续 sub-agent 生效）` : `采纳失败：${r.reason}`)
      await refresh()
    } catch (error) {
      setNotice(`采纳失败: ${String(error)}`)
    } finally {
      setBusy(null)
    }
  }

  const clearAdopt = async (agentId: string): Promise<void> => {
    setBusy(`clear-${agentId}`)
    try {
      await window.electronAPI.clearEvalPrompt(agentId)
      setNotice(`已清除 ${agentId} 的覆盖，恢复代码默认`)
      await refresh()
    } catch (error) {
      setNotice(`清除失败: ${String(error)}`)
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="space-y-4">
      {/* 采纳写回状态 */}
      <SettingsSection title="始终允许 / 已采纳的 sub-agent 覆盖" description="被采纳、持久化的内置 sub-agent prompt（会影响真实 sub-agent 运行）。">
        <SettingsCard divided={false}>
          <div className="space-y-2 p-3">
            {BUILTIN_TARGETS.map((agentId) => {
              const overridden = prompts[agentId]?.prompt
              return (
                <SettingsRow
                  key={agentId}
                  label={`${TARGET_LABELS[agentId] ?? agentId}`}
                  description={overridden ? '已采纳自定义 prompt（覆盖代码默认）' : '使用代码默认 prompt'}
                >
                  <Button variant="outline" size="sm" disabled={!overridden || busy !== null} onClick={() => void clearAdopt(agentId)}>
                    <RotateCcw className="size-3 mr-1" />恢复默认
                  </Button>
                </SettingsRow>
              )
            })}
          </div>
        </SettingsCard>
      </SettingsSection>

      {/* Benchmark 列表 */}
      <SettingsSection
        title="Benchmarks"
        description="对内置 sub-agent 的能力评测基准"
        action={
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={() => { setShowCreate(true); setNotice(null) }}>
              <Plus size={14} /><span>新建</span>
            </Button>
            <Button size="sm" variant="outline" onClick={() => void refresh()}>
              <RefreshCw size={14} /><span>刷新</span>
            </Button>
          </div>
        }
      >
        {benchmarks.length === 0 ? (
          <SettingsCard divided={false}>
            <div className="text-sm text-muted-foreground p-6 text-center">还没有 Benchmark，点「新建」创建一个。</div>
          </SettingsCard>
        ) : (
          <SettingsCard divided>
            {benchmarks.map((b) => {
              const selectedBench = selected === b.id
              return (
                <button
                  key={b.id}
                  type="button"
                  onClick={() => void loadDetail(b.id)}
                  className={`w-full text-left px-4 py-3 hover:bg-muted/40 transition-colors ${selectedBench ? 'bg-primary/5' : ''}`}
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-sm font-semibold text-foreground">{b.title}</div>
                      <div className="text-xs text-muted-foreground mt-0.5">
                        {TARGET_LABELS[b.targetAgentId] ?? b.targetAgentId} · {b.cases?.length ?? 0} 个 Case · 目标 {b.targetScore}
                      </div>
                      {b.description && <div className="text-xs text-muted-foreground/70 mt-0.5 line-clamp-1">{b.description}</div>}
                    </div>
                    <div className="text-right shrink-0">
                      <div className={`text-base font-bold ${b.latestScore == null ? 'text-muted-foreground' : b.latestScore >= b.targetScore ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400'}`}>
                        {b.latestScore == null ? '—' : b.latestScore.toFixed(1)}
                      </div>
                      {b.lastEvaluationTime && <div className="text-[10px] text-muted-foreground/50">{new Date(b.lastEvaluationTime).toLocaleDateString()}</div>}
                    </div>
                  </div>
                  {selectedBench && (
                    <div className="mt-2 flex flex-wrap gap-2">
                      <Button size="sm" variant="outline" disabled={busy !== null} onClick={(e) => { e.stopPropagation(); void runBaseline(b.id) }}>
                        <Play className="size-3 mr-1" />Baseline
                      </Button>
                      <Button size="sm" variant="outline" disabled={busy !== null} onClick={(e) => { e.stopPropagation(); void runImprove(b.id) }}>
                        <TrendingUp className="size-3 mr-1" />Improve
                      </Button>
                    </div>
                  )}
                  {selectedBench && detail && (
                    <div className="mt-3 border-t border-border/50 pt-2">
                      <ScoreTrend detail={detail} />
                    </div>
                  )}
                </button>
              )
            })}
          </SettingsCard>
        )}
      </SettingsSection>

      {notice && (
        <div className="text-xs text-muted-foreground bg-muted/30 border border-border/50 rounded-lg px-3 py-2">{notice}</div>
      )}

      {pendingAdopt && (
        <SettingsCard divided={false}>
          <div className="p-4 space-y-3">
            <div className="flex items-center justify-between">
              <div className="text-sm font-semibold text-foreground">审查并采纳 {TARGET_LABELS[pendingAdopt.agentId] ?? pendingAdopt.agentId}</div>
              <Button variant="ghost" size="sm" onClick={() => setPendingAdopt(null)} disabled={busy !== null}>放弃</Button>
            </div>
            <p className="text-xs text-muted-foreground">Improve 中评测分数最高且被接受的改进候选（未自动写回）。审阅后决定是否采纳为内置 sub-agent 行为。</p>
            <pre className="whitespace-pre-wrap break-all text-xs bg-muted/40 border border-border/50 rounded-lg p-3 max-h-40 overflow-y-auto text-foreground/90">{pendingAdopt.prompt}</pre>
            <div className="flex justify-end gap-2">
              <Button size="sm" onClick={() => { void doAdopt(pendingAdopt.agentId, pendingAdopt.prompt) }} disabled={busy !== null}>
                采纳写回
              </Button>
            </div>
          </div>
        </SettingsCard>
      )}

      {showCreate && <CreateBenchmarkForm onCancelled={() => setShowCreate(false)} onCreated={(id) => { setShowCreate(false); void loadDetail(id); void refresh() }} />}
    </div>
  )
}

/** scoreboard 趋势小图（纯文字/条）。 */
function ScoreTrend({ detail }: { detail: EvalDetail }): React.ReactElement {
  const evals = detail.scoreboard.evaluations
  if (evals.length === 0) {
    return <div className="text-xs text-muted-foreground/60">暂无评测记录</div>
  }
  const max = Math.max(...evals.map((e) => e.score), 1)
  return (
    <div className="space-y-1">
      {evals.slice(-8).map((e) => (
        <div key={e.time + e.agentVersion} className="flex items-center gap-2 text-xs">
          <span className="text-muted-foreground/60 w-10 shrink-0 text-right">v{e.agentVersion}</span>
          <div className="flex-1 h-2 rounded bg-muted/50 overflow-hidden">
            <div className="h-full bg-primary/70" style={{ width: `${(e.score / max) * 100}%` }} />
          </div>
          <span className="w-10 shrink-0 text-foreground/80">{e.score.toFixed(1)}</span>
        </div>
      ))}
    </div>
  )
}

/** 新建 Benchmark 表单。 */
function CreateBenchmarkForm({ onCancelled, onCreated }: { onCancelled: () => void; onCreated: (id: string) => void }): React.ReactElement {
  const [id, setId] = React.useState(`bench-${Date.now().toString(36)}`)
  const [title, setTitle] = React.useState('')
  const [description, setDescription] = React.useState('')
  const [targetAgentId, setTargetAgentId] = React.useState<string>('code-reviewer')
  const [provider, setProvider] = React.useState('deepseek')
  const [modelId, setModelId] = React.useState('')
  const [targetScore, setTargetScore] = React.useState('80')
  const [caseId, setCaseId] = React.useState('CASE-001')
  const [statement, setStatement] = React.useState('')
  const [rubricItems, setRubricItems] = React.useState([{ name: '定位修复点', points: 50, check: '找到缺陷位置' }, { name: '修复建议', points: 50, check: '给出行之有效的修复' }])
  const [error, setError] = React.useState<string | null>(null)
  const [creating, setCreating] = React.useState(false)

  const submit = async (): Promise<void> => {
    if (!title.trim() || !statement.trim()) {
      setError('标题 与 Case 内容必填')
      return
    }
    const total = rubricItems.reduce((s, i) => s + (Number(i.points) || 0), 0)
    if (total !== 100) {
      setError(`Rubric 总分应为 100，当前 ${total}`)
      return
    }
    setCreating(true)
    setError(null)
    try {
      const res = await window.electronAPI.createEvalBenchmark({
        id: id.trim(),
        title: title.trim(),
        description: description.trim(),
        targetAgentId,
        provider,
        modelId: modelId.trim(),
        targetScore: Number(targetScore) || 80,
        cases: [{
          caseId: caseId.trim(),
          statement: statement.trim(),
          rubricItems: rubricItems.map((i) => ({ name: i.name, points: Number(i.points) || 0, check: i.check })),
        }],
      })
      if (!res.ok || !res.benchmarkId) {
        setError(res.error ?? '创建失败')
        return
      }
      onCreated(res.benchmarkId)
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e))
    } finally {
      setCreating(false)
    }
  }

  return (
    <SettingsSection title="新建 Benchmark" description="创建针对内置 sub-agent 的能力评测基准（首个 Case 直接在此填写）。">
      <SettingsCard divided={false}>
        <div className="space-y-3 p-4">
          <SettingsInput label="ID" value={id} onChange={setId} disabled={creating} placeholder="bench-xxx" />
          <SettingsInput label="标题" value={title} onChange={setTitle} disabled={creating} placeholder="例如：代码审查能力评测" />
          <SettingsInput label="描述" value={description} onChange={setDescription} disabled={creating} placeholder="可选" />

          <SettingsRow label="被测子代理">
            <select
              value={targetAgentId}
              onChange={(e) => setTargetAgentId(e.target.value)}
              className="h-8 rounded-md border border-border bg-background text-sm px-2"
              disabled={creating}
            >
              {BUILTIN_TARGETS.map((t) => (
                <option key={t} value={t}>{TARGET_LABELS[t] ?? t}</option>
              ))}
            </select>
          </SettingsRow>

          <div className="grid grid-cols-3 gap-2">
            <SettingsInput label="Provider" value={provider} onChange={setProvider} disabled={creating} />
            <SettingsInput label="Model" value={modelId} onChange={setModelId} disabled={creating} placeholder="deepseek-v4-flash" />
            <SettingsInput label="目标分" value={targetScore} onChange={setTargetScore} disabled={creating} />
          </div>

          <div className="border-t border-border/40 pt-3">
            <div className="text-xs font-medium text-foreground mb-2">Case</div>
            <div className="grid grid-cols-2 gap-2">
              <SettingsInput label="Case ID" value={caseId} onChange={setCaseId} disabled={creating} />
            </div>
            <label className="block text-xs text-muted-foreground mt-2 mb-1">Statement（被测方看到的任务）</label>
            <textarea
              className="w-full h-28 rounded-lg border border-border bg-background text-sm p-2"
              value={statement}
              onChange={(e) => setStatement(e.target.value)}
              disabled={creating}
            />
            <div className="text-xs font-medium text-foreground mt-3 mb-1">Rubric（私有评分项，总和须为 100）</div>
            {rubricItems.map((item, idx) => (
              <div key={idx} className="flex items-center gap-2 mb-2">
                <input className="flex-1 h-8 rounded-md border border-border bg-background text-sm px-2" value={item.name}
                  onChange={(e) => setRubricItems((prev) => prev.map((v, i) => (i === idx ? { ...v, name: e.target.value } : v)))}
                  placeholder="评分项名" disabled={creating} />
                <input className="w-16 h-8 rounded-md border border-border bg-background text-sm px-2" value={item.points}
                  onChange={(e) => setRubricItems((prev) => prev.map((v, i) => (i === idx ? { ...v, points: Number(e.target.value) || 0 } : v)))}
                  placeholder="分" disabled={creating} />
                <Button variant="ghost" size="sm" disabled={creating || rubricItems.length <= 1}
                  onClick={() => setRubricItems((prev) => prev.filter((_, i) => i !== idx))}>
                  <Trash2 className="size-3.5" />
                </Button>
              </div>
            ))}
            <Button variant="outline" size="sm" disabled={creating}
              onClick={() => setRubricItems((prev) => [...prev, { name: `评分项${prev.length + 1}`, points: 0, check: '' }])}>
              <Plus className="size-3 mr-1" />添加评分项
            </Button>
          </div>

          {error && <div className="text-xs text-red-600 dark:text-red-400 bg-red-500/5 border border-red-500/20 rounded-lg px-3 py-2">{error}</div>}

          <div className="flex justify-end gap-2 pt-2">
            <Button variant="ghost" size="sm" onClick={onCancelled} disabled={creating}>取消</Button>
            <Button size="sm" onClick={() => void submit()} disabled={creating}>
              {creating ? '创建中…' : '创建 Benchmark'}
            </Button>
          </div>
        </div>
      </SettingsCard>
    </SettingsSection>
  )
}

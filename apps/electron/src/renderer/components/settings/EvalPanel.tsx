/**
 * EvalPanel — 评测 / 自演化面板。
 *
 * 能力：查看 Benchmark 列表与 scoreboard、新建 Benchmark（含 Cases + Rubric）、
 * 从预置模板一键创建、触发真实评测（Baseline / Improve）、审阅与消除内置 sub-agent 的持久化覆盖（采纳写回）。
 *
 * 数据全部来自主进程 IPC（window.electronAPI.eval*）。
 */

import * as React from 'react'
import type { Channel } from "@gravitas/shared"
import {
  Play,
  TrendingUp,
  Plus,
  Trash2,
  RefreshCw,
  RotateCcw,
  LayoutTemplate,
  Sparkles,
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

interface EvalCaseResult {
  caseId: string
  score: number
  scoreStd?: number | null
  runs: Array<{ score: number; sessionId: string; tracePath?: string }>
}

interface EvalDetail {
  config: {
    id: string
    title: string
    targetAgentId: string
    targetScore: number
    cases: string[]
  }
  scoreboard: {
    evaluations: Array<{
      time: string
      agentVersion: number
      score: number
      scoreStd?: number | null
      costUsd?: number | null
      durationMs?: number | null
      judge?: { kind: "rule" | "llm" | "injected"; independent: boolean; modelId?: string } | null
      cases: EvalCaseResult[]
    }>
  }
  cases: Array<{
    caseId: string
    statement: string | null
    rubric: { version: number; items: Array<{ name: string; points: number; check: string }> } | null
  }>
}

interface BenchmarkTemplate {
  id: string
  title: string
  description: string
  targetAgentId: string
}

export function EvalPanel(): React.ReactElement {
  const [benchmarks, setBenchmarks] = React.useState<EvalBench[]>([])
  const [templates, setTemplates] = React.useState<BenchmarkTemplate[]>([])
  const [selected, setSelected] = React.useState<string | null>(null)
  const [detail, setDetail] = React.useState<EvalDetail | null>(null)
  const [busy, setBusy] = React.useState<string | null>(null)
  const [runningEval, setRunningEval] = React.useState<{ benchmarkId: string; caseId: string; completedCases: number; totalCases: number; startedAt: number; lastScore?: number } | null>(null)
  const [elapsedSeconds, setElapsedSeconds] = React.useState(0)
  const [notice, setNotice] = React.useState<string | null>(null)
  const [prompts, setPrompts] = React.useState<Record<string, { prompt?: string }>>({})
  const [pendingAdopt, setPendingAdopt] = React.useState<{ agentId: string; prompt: string } | null>(null)

  const [showCreate, setShowCreate] = React.useState(false)
  const [showTemplates, setShowTemplates] = React.useState(false)

  const [costEstimate, setCostEstimate] = React.useState<{
    benchmarkId: string
    type: 'baseline' | 'improve'
    cost: { totalUsd: number; inputTokens: number; outputTokens: number; callCount: number; hasPricing: boolean; pricing?: { input: number; output: number }; fallbackUsd?: number }
  } | null>(null)

  const [autoSchedules, setAutoSchedules] = React.useState<Record<string, { benchmarkId: string; enabled: boolean; intervalDays: number; lastRunAt?: string; nextRunAt?: string; proactiveScheduleId?: string }>>({})

  const refresh = React.useCallback(async () => {
    try {
      const [benches, overrides, templateList, schedules] = await Promise.all([
        window.electronAPI.listEvalBenchmarks(),
        window.electronAPI.listEvalPrompts(),
        window.electronAPI.listEvalTemplates(),
        window.electronAPI.listBenchmarkAutoSchedules(),
      ])
      setBenchmarks(benches)
      setPrompts(overrides)
      setTemplates(templateList)
      const scheduleMap: Record<string, { benchmarkId: string; enabled: boolean; intervalDays: number; lastRunAt?: string; nextRunAt?: string; proactiveScheduleId?: string }> = {}
      for (const s of schedules) {
        scheduleMap[s.benchmarkId] = s
      }
      setAutoSchedules(scheduleMap)
    } catch (error) {
      setNotice(`载入评测数据失败: ${String(error)}`)
    }
  }, [])

  React.useEffect(() => {
    void refresh()
  }, [refresh])

  React.useEffect(() => {
    const unsubscribe = window.electronAPI.onEvalProgress((progress) => {
      setRunningEval((current) => ({
        benchmarkId: progress.benchmarkId,
        caseId: progress.caseId,
        completedCases: progress.completedCases,
        totalCases: progress.totalCases,
        startedAt: current?.benchmarkId === progress.benchmarkId ? current.startedAt : Date.now(),
        lastScore: progress.score,
      }))
    })
    return unsubscribe
  }, [])

  React.useEffect(() => {
    if (!runningEval) {
      setElapsedSeconds(0)
      return
    }
    const tick = () => setElapsedSeconds(Math.floor((Date.now() - runningEval.startedAt) / 1000))
    tick()
    const timer = window.setInterval(tick, 1000)
    return () => window.clearInterval(timer)
  }, [runningEval])

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
    // 先估算成本
    setBusy(`estimate-baseline-${id}`)
    try {
      const estimate = await window.electronAPI.estimateBaselineCost(id)
      if (estimate && estimate.totalUsd > 0.05) {
        setCostEstimate({ benchmarkId: id, type: 'baseline', cost: estimate })
        setBusy(null)
        return // 等待用户确认
      }
    } catch {
      // 估算失败继续执行
    }
    setBusy(null)
    await executeBaseline(id)
  }

  const executeBaseline = async (id: string): Promise<void> => {
    setBusy(`baseline-${id}`)
    setRunningEval({ benchmarkId: id, caseId: '', completedCases: 0, totalCases: 0, startedAt: Date.now() })
    setNotice('Baseline 正在启动…')
    try {
      const r = await window.electronAPI.runEvalBaseline(id)
      setNotice(`Baseline 完成：score=${r.score}`)
      await refresh()
      await loadDetail(id)
    } catch (error) {
      setNotice(`Baseline 失败: ${String(error)}`)
    } finally {
      setBusy(null)
      setRunningEval(null)
    }
  }

  const runImprove = async (id: string): Promise<void> => {
    // 先估算成本
    setBusy(`estimate-improve-${id}`)
    try {
      const estimate = await window.electronAPI.estimateImproveCost(id, 2)
      if (estimate && estimate.totalUsd > 0.1) {
        setCostEstimate({ benchmarkId: id, type: 'improve', cost: estimate })
        setBusy(null)
        return // 等待用户确认
      }
    } catch {
      // 估算失败继续执行
    }
    setBusy(null)
    await executeImprove(id)
  }

  const executeImprove = async (id: string): Promise<void> => {
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
      const result = await window.electronAPI.clearEvalPrompt(agentId)
      setNotice(result.applied
        ? `已恢复 ${agentId} 的内置默认 prompt`
        : `恢复失败：${result.reason ?? "未知原因"}`)
      await refresh()
    } catch (error) {
      setNotice(`清除失败: ${String(error)}`)
    } finally {
      setBusy(null)
    }
  }

  const toggleAutoSchedule = async (benchmarkId: string, enabled: boolean): Promise<void> => {
    setBusy(`auto-schedule-${benchmarkId}`)
    try {
      const updated = await window.electronAPI.setBenchmarkAutoSchedule(benchmarkId, enabled)
      setAutoSchedules((prev) => ({ ...prev, [benchmarkId]: updated }))
      setNotice(`${enabled ? '已启用' : '已禁用'} ${benchmarkId} 的自动评测`)
    } catch (error) {
      setNotice(`自动评测设置失败: ${String(error)}`)
    } finally {
      setBusy(null)
    }
  }

  const createFromTemplate = async (templateId: string, useLlmJudge: boolean): Promise<void> => {
    setBusy(`template-${templateId}`)
    setNotice(null)
    try {
      const judgeRuntime = useLlmJudge ? { provider: "", modelId: "" } : undefined
      const res = await window.electronAPI.createEvalBenchmarkFromTemplate(templateId, judgeRuntime)
      if (!res.ok || !res.benchmarkId) {
        setNotice(`从模板创建失败: ${res.error ?? '未知错误'}`)
        return
      }
      setNotice(`已从模板创建 Benchmark: ${res.benchmarkId}`)
      setShowTemplates(false)
      await refresh()
      await loadDetail(res.benchmarkId)
    } catch (error) {
      setNotice(`从模板创建失败: ${String(error)}`)
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="space-y-4">
      {/* 采纳写回状态 */}
      <SettingsSection title="内置 sub-agent 提示词" description="查看评测改进后已写入并正在生效的提示词；可随时恢复内置默认。">
        <SettingsCard divided={false}>
          <div className="space-y-2 p-3">
            {BUILTIN_TARGETS.map((agentId) => {
              const overridden = prompts[agentId]?.prompt
              return (
                <SettingsRow
                  key={agentId}
                  label={`${TARGET_LABELS[agentId] ?? agentId}`}
                  description={overridden ? '自定义 prompt 正在生效' : '使用代码默认 prompt'}
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
            <Button size="sm" variant="secondary" onClick={() => { setShowTemplates(true); setShowCreate(false); setNotice(null) }}>
              <LayoutTemplate size={14} /><span>从模板创建</span>
            </Button>
            <Button size="sm" onClick={() => { setShowCreate(true); setShowTemplates(false); setNotice(null) }}>
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
            <div className="text-sm text-muted-foreground p-6 text-center space-y-4">
              <div className="flex justify-center">
                <Sparkles className="size-8 text-primary/40" />
              </div>
              <div className="space-y-1">
                <div className="font-medium text-foreground">还没有 Benchmark</div>
                <div className="text-xs">评测内置 sub-agent 的能力，持续优化它们的 prompt 和表现</div>
              </div>
              <div className="bg-muted/30 rounded-lg p-3 text-left space-y-2">
                <div className="text-xs font-medium text-foreground">💡 什么时候该创建 Benchmark？</div>
                <div className="text-xs text-muted-foreground space-y-1">
                  <div>• 刚完成一次代码审查任务 → 评测 <span className="text-primary">code-reviewer</span> 的审查能力</div>
                  <div>• 让 Agent 探索了代码库 → 评测 <span className="text-primary">explorer</span> 的信息收集能力</div>
                  <div>• 做了技术方案调研 → 评测 <span className="text-primary">researcher</span> 的分析推荐能力</div>
                </div>
              </div>
              <div className="flex justify-center gap-2">
                <Button size="sm" variant="secondary" onClick={() => setShowTemplates(true)}>
                  <Sparkles className="size-3 mr-1" />从模板创建
                </Button>
                <Button size="sm" variant="outline" onClick={() => setShowCreate(true)}>
                  <Plus className="size-3 mr-1" />手动创建
                </Button>
              </div>
            </div>
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
                        <Play className="size-3 mr-1" />测试当前版本
                      </Button>
                      <Button size="sm" variant="outline" disabled={busy !== null} onClick={(e) => { e.stopPropagation(); void runImprove(b.id) }}>
                        <TrendingUp className="size-3 mr-1" />生成改进方案
                      </Button>
                    </div>
                  )}
                  {selectedBench && (
                    <div className="mt-2 flex items-center gap-2">
                      <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer">
                        <input
                          type="checkbox"
                          checked={autoSchedules[b.id]?.enabled ?? false}
                          onChange={(e) => {
                            e.stopPropagation()
                            void toggleAutoSchedule(b.id, e.target.checked)
                          }}
                          disabled={busy !== null}
                          className="rounded border-border"
                        />
                        自动评测（每{autoSchedules[b.id]?.intervalDays ?? 7}天）
                      </label>
                      {autoSchedules[b.id]?.enabled && autoSchedules[b.id]?.nextRunAt && (
                        <span className="text-[10px] text-muted-foreground/60">
                          下次: {new Date(autoSchedules[b.id]!.nextRunAt!).toLocaleDateString()}
                        </span>
                      )}
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

      {runningEval && (
        <div className="text-xs bg-primary/10 border border-primary/20 rounded-lg px-3 py-2 text-foreground">
          <div className="flex items-center gap-2">
            <RefreshCw className="size-3 animate-spin text-primary" />
            <span>正在运行 {benchmarks.find((benchmark) => benchmark.id === runningEval.benchmarkId)?.title ?? runningEval.benchmarkId}</span>
            <span className="text-muted-foreground">已耗时 {elapsedSeconds}s</span>
          </div>
          {runningEval.totalCases > 0 && (
            <div className="mt-1 text-muted-foreground">
              已完成 {runningEval.completedCases}/{runningEval.totalCases}{runningEval.caseId ? `，当前或最近 Case：${runningEval.caseId}` : ""}
              {runningEval.lastScore != null ? `，刚完成得分 ${runningEval.lastScore}` : ''}
            </div>
          )}
        </div>
      )}

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

      {costEstimate && (
        <SettingsCard divided={false}>
          <div className="p-4 space-y-3">
            <div className="flex items-center justify-between">
              <div className="text-sm font-semibold text-foreground">
                确认运行 {costEstimate.type === 'baseline' ? 'Baseline' : 'Improve'} 评测？
              </div>
              <Button variant="ghost" size="sm" onClick={() => setCostEstimate(null)} disabled={busy !== null}>取消</Button>
            </div>
            <div className="bg-muted/30 rounded-lg p-3 space-y-2">
              <div className="flex justify-between text-xs">
                <span className="text-muted-foreground">预估成本</span>
                <span className="font-medium text-foreground">${costEstimate.cost.totalUsd.toFixed(2)} USD</span>
              </div>
              <div className="flex justify-between text-xs">
                <span className="text-muted-foreground">调用次数</span>
                <span className="text-foreground">{costEstimate.cost.callCount} 次</span>
              </div>
              {!costEstimate.cost.hasPricing && (
                <div className="text-xs text-amber-600 dark:text-amber-400">
                  ⚠️ 该模型暂无定价数据，以上为保守估算
                </div>
              )}
            </div>
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="outline" onClick={() => setCostEstimate(null)} disabled={busy !== null}>取消</Button>
              <Button size="sm" onClick={() => {
                const { benchmarkId, type } = costEstimate
                setCostEstimate(null)
                if (type === 'baseline') {
                  void executeBaseline(benchmarkId)
                } else {
                  void executeImprove(benchmarkId)
                }
              }} disabled={busy !== null}>
                确认运行
              </Button>
            </div>
          </div>
        </SettingsCard>
      )}

      {showTemplates && <TemplateSelector templates={templates} onSelect={(id, useLlmJudge) => void createFromTemplate(id, useLlmJudge)} onCancel={() => setShowTemplates(false)} busy={busy !== null} />}
      {showCreate && <CreateBenchmarkForm onCancelled={() => setShowCreate(false)} onCreated={(id) => { setShowCreate(false); void loadDetail(id); void refresh() }} />}
    </div>
  )
}

/** scoreboard 趋势小图（纯文字/条）。 */
function ScoreTrend({ detail }: { detail: EvalDetail }): React.ReactElement {
  const evals = detail.scoreboard.evaluations
  if (evals.length === 0) {
    return <div className="text-xs text-muted-foreground/60">暂无评测记录。先运行“测试当前版本”。</div>
  }
  const latest = evals[evals.length - 1]
  const judgeLabel = latest?.judge?.kind === "llm"
    ? `LLM 评判 · ${latest.judge.modelId ?? "未记录模型"}${latest.judge.independent ? " · 独立" : " · 同源"}`
    : latest?.judge?.kind === "injected"
      ? "外部评判器"
      : "规则关键词评分"
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
        <span className="font-medium text-foreground">最近一次结果</span>
        <span className="rounded-full bg-muted px-2 py-0.5 text-muted-foreground">{judgeLabel}</span>
      </div>
      <div className="space-y-1.5">
        {latest?.cases.map((item) => {
          const definition = detail.cases.find((candidate) => candidate.caseId === item.caseId)
          return (
            <details key={item.caseId} className="rounded-md bg-muted/30 px-2 py-1.5">
              <summary className="cursor-pointer text-xs">
                <span className="ml-1 text-muted-foreground">{item.caseId}</span>
                <span className={`float-right ${item.score >= detail.config.targetScore ? "text-emerald-600 dark:text-emerald-400" : "text-amber-600 dark:text-amber-400"}`}>
                  {item.score.toFixed(1)}
                </span>
              </summary>
              <div className="mt-2 space-y-1 border-t border-border/40 pt-2">
                {definition?.rubric?.items.map((rubricItem) => (
                  <div key={rubricItem.name} className="grid grid-cols-[1fr_auto] gap-x-3 text-[11px]">
                    <span className="text-foreground/80">{rubricItem.name}</span>
                    <span className="text-muted-foreground">{rubricItem.points} 分</span>
                    <span className="col-span-2 text-muted-foreground">{rubricItem.check}</span>
                  </div>
                ))}
              </div>
            </details>
          )
        })}
      </div>
      <details className="text-xs text-muted-foreground">
        <summary className="cursor-pointer">查看历史趋势</summary>
        <div className="mt-2 space-y-1">
          {evals.slice(-8).map((item) => (
            <div key={item.time + item.agentVersion} className="flex justify-between gap-3">
              <span>{new Date(item.time).toLocaleString()} · v{item.agentVersion}</span>
              <span>{item.score.toFixed(1)}{item.scoreStd != null ? ` ± ${item.scoreStd.toFixed(1)}` : ""}</span>
            </div>
          ))}
        </div>
      </details>
    </div>
  )
}

/** 预置模板选择器 */
function TemplateSelector({
  templates,
  onSelect,
  onCancel,
  busy,
}: {
  templates: BenchmarkTemplate[]
  onSelect: (templateId: string, useLlmJudge: boolean) => void
  onCancel: () => void
  busy: boolean
}): React.ReactElement {
  const [useLlmJudge, setUseLlmJudge] = React.useState(false)
  return (
    <SettingsSection title="从预置模板创建" description="选择内置 sub-agent 的评测模板，一键创建 Benchmark。">
      <SettingsCard divided={false}>
        <div className="space-y-3 p-4">
          {templates.length === 0 ? (
            <div className="text-sm text-muted-foreground text-center py-4">加载模板中…</div>
          ) : (
            <div className="space-y-2">
              {templates.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => onSelect(t.id, useLlmJudge)}
                  disabled={busy}
                  className="w-full text-left p-3 rounded-lg border border-border/50 hover:bg-muted/40 transition-colors disabled:opacity-50"
                >
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="text-sm font-medium text-foreground">{t.title}</div>
                      <div className="text-xs text-muted-foreground mt-0.5">{t.description}</div>
                      <div className="text-xs text-muted-foreground/60 mt-1">
                        目标: {TARGET_LABELS[t.targetAgentId] ?? t.targetAgentId}
                      </div>
                    </div>
                    <Sparkles className="size-4 text-primary/60 shrink-0 ml-2" />
                  </div>
                </button>
              ))}
            </div>
          )}
          <label className="flex items-start gap-2 rounded-lg bg-muted/30 p-3 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={useLlmJudge}
              onChange={(event) => setUseLlmJudge(event.target.checked)}
              disabled={busy}
              className="mt-0.5 rounded border-border"
            />
            <span>使用 LLM 语义评分：会将测试题、Agent 输出和私有评分标准发送到默认 Agent 渠道并产生模型费用。未勾选时使用本地规则关键词评分。</span>
          </label>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="ghost" size="sm" onClick={onCancel} disabled={busy}>取消</Button>
          </div>
        </div>
      </SettingsCard>
    </SettingsSection>
  )
}

/** 新建 Benchmark 表单。 */
function CreateBenchmarkForm({ onCancelled, onCreated }: { onCancelled: () => void; onCreated: (id: string) => void }): React.ReactElement {
  const [id, setId] = React.useState(`bench-${Date.now().toString(36)}`)
  const [title, setTitle] = React.useState('')
  const [description, setDescription] = React.useState('')
  const [targetAgentId, setTargetAgentId] = React.useState<string>('code-reviewer')
  const [channels, setChannels] = React.useState<Channel[]>([])
  const [channelId, setChannelId] = React.useState("")
  const [modelId, setModelId] = React.useState("")
  const [useLlmJudge, setUseLlmJudge] = React.useState(false)
  const [targetScore, setTargetScore] = React.useState('80')
  const [caseId, setCaseId] = React.useState('CASE-001')
  const [statement, setStatement] = React.useState('')
  const [rubricItems, setRubricItems] = React.useState([{ name: '定位修复点', points: 50, check: '找到缺陷位置' }, { name: '修复建议', points: 50, check: '给出行之有效的修复' }])
  const [error, setError] = React.useState<string | null>(null)
  const [creating, setCreating] = React.useState(false)

  React.useEffect(() => {
    void window.electronAPI.listChannels().then((items) => {
      const enabled = items.filter((item) => item.enabled)
      setChannels(enabled)
      const first = enabled[0]
      if (first) {
        setChannelId(first.id)
        setModelId(first.models.find((model) => model.enabled)?.id ?? "")
      }
    }).catch((cause: unknown) => setError(`载入渠道失败：${String(cause)}`))
  }, [])

  const selectedChannel = channels.find((channel) => channel.id === channelId)

  const submit = async (): Promise<void> => {
    if (!title.trim() || !statement.trim()) {
      setError("标题、Case 内容必填")
      return
    }
    if (!selectedChannel || !modelId) {
      setError("请先选择可用的 Agent 渠道和模型")
      return
    }
    const total = rubricItems.reduce((s, i) => s + (Number(i.points) || 0), 0)
    if (rubricItems.some((item) => !item.name.trim() || !item.check.trim())) {
      setError("每个评分项都要填写名称和明确的得分条件")
      return
    }
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
        provider: selectedChannel.provider,
        channelId: selectedChannel.id,
        modelId,
        ...(useLlmJudge ? {
          judgeRuntime: {
            provider: selectedChannel.provider,
            channelId: selectedChannel.id,
            modelId,
          },
        } : {}),
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

          <div className="grid gap-3 md:grid-cols-2">
            <SettingsRow label="运行渠道" description="使用该渠道实际执行被测 Agent">
              <select
                value={channelId}
                onChange={(event) => {
                  const nextId = event.target.value
                  const nextChannel = channels.find((channel) => channel.id === nextId)
                  setChannelId(nextId)
                  setModelId(nextChannel?.models.find((model) => model.enabled)?.id ?? "")
                }}
                className="h-8 max-w-52 rounded-md border border-border bg-background px-2 text-sm"
                disabled={creating}
              >
                {channels.length === 0 && <option value="">暂无可用渠道</option>}
                {channels.map((channel) => <option key={channel.id} value={channel.id}>{channel.name}</option>)}
              </select>
            </SettingsRow>
            <SettingsRow label="运行模型" description="只显示所选渠道中已启用的模型">
              <select
                value={modelId}
                onChange={(event) => setModelId(event.target.value)}
                className="h-8 max-w-52 rounded-md border border-border bg-background px-2 text-sm"
                disabled={creating || !selectedChannel}
              >
                {(selectedChannel?.models.filter((model) => model.enabled) ?? []).map((model) => (
                  <option key={model.id} value={model.id}>{model.name || model.id}</option>
                ))}
              </select>
            </SettingsRow>
          </div>
          <SettingsInput label="目标分" value={targetScore} onChange={setTargetScore} disabled={creating} />

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
            <label className="mb-2 flex items-start gap-2 rounded-md bg-muted/30 p-2 text-[11px] text-muted-foreground">
              <input
                type="checkbox"
                checked={useLlmJudge}
                onChange={(event) => setUseLlmJudge(event.target.checked)}
                disabled={creating}
                className="mt-0.5 rounded border-border"
              />
              <span>使用 LLM 按完整语义评判（推荐）。当前使用同一渠道和模型，适合调试；结果会标记“同源”。关闭后改用成本更低的规则关键词评分。</span>
            </label>
            {rubricItems.map((item, idx) => (
              <div key={idx} className="mb-2 rounded-lg bg-muted/30 p-2">
                <div className="flex items-center gap-2">
                  <input className="flex-1 h-8 rounded-md border border-border bg-background text-sm px-2" value={item.name}
                    onChange={(event) => setRubricItems((prev) => prev.map((value, index) => index === idx ? { ...value, name: event.target.value } : value))}
                    placeholder="评分项名称" disabled={creating} />
                  <input className="w-16 h-8 rounded-md border border-border bg-background text-sm px-2" type="number" min={0} max={100} value={item.points}
                    onChange={(event) => setRubricItems((prev) => prev.map((value, index) => index === idx ? { ...value, points: Number(event.target.value) || 0 } : value))}
                    placeholder="分值" disabled={creating} />
                  <Button variant="ghost" size="sm" disabled={creating || rubricItems.length <= 1}
                    onClick={() => setRubricItems((prev) => prev.filter((_, index) => index !== idx))}>
                    <Trash2 className="size-3.5" />
                  </Button>
                </div>
                <textarea
                  className="mt-2 h-16 w-full rounded-md border border-border bg-background p-2 text-sm"
                  value={item.check}
                  onChange={(event) => setRubricItems((prev) => prev.map((value, index) => index === idx ? { ...value, check: event.target.value } : value))}
                  placeholder="明确写出得分条件，例如：指出缺少 JWT 签名验证，并说明伪造风险"
                  disabled={creating}
                />
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

/**
 * Campaign 工作流步骤列表组件
 *
 * 展示 15 步标准工作流进度，支持状态跟踪和 Agent 执行。
 * 新策略顺序：市场分析→竞品分析→用户分析→品牌DNA+品牌诊断→品牌信息核实→品牌概念→目标设定→Big Idea→平台矩阵→KOL金字塔→搜索KOL→加入候选池→生成Briefs→A/B测试→视频素材
 */
import * as React from 'react'
import {
  Circle,
  CheckCircle2,
  Loader2,
  SkipForward,
  AlertTriangle,
  Play,
  RotateCcw,
  ChevronDown,
  ChevronUp,
  Bot,
  Pencil,
  RefreshCw,
} from 'lucide-react'

const STEP_DIR_MAP: Record<string, string> = {
  market_analysis: 'market-analysis',
  competitor_analysis: 'competitor-analysis',
  user_analysis: 'user-analysis',
  brand_dna: 'brand-dna',
  brand_fact_check: 'brand-fact-check',
  brand_concept: 'brand-concept',
  goal_setting: 'goal-setting',
  creative_concept: 'creative-concept',
  platform_matrix: 'platform-matrix',
  kol_pyramid: 'kol-pyramid',
  search_kols: 'kol-search',
  add_to_pool: 'kol-search',
  generate_briefs: 'briefs',
  ab_test: 'ab-test',
  generate_video_assets: 'video-assets',
}

function getArtifactDir(stepId: string): string {
  return STEP_DIR_MAP[stepId] ?? 'workspace-files'
}
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import type {
  CampaignWorkflow,
  CampaignWorkflowStep,
  CampaignWorkflowStepId,
  UpdateWorkflowStepInput,
} from '@gravitas/shared'
import { buildArtifactPersistenceDirective } from '@gravitas/shared'

interface CampaignWorkflowStepsProps {
  campaignId: string
  campaignName: string
  campaignContext: Record<string, string>
  onOpenInAgent: (prompt: string) => void
}

const STATUS_CONFIG: Record<string, { label: string; color: string; icon: React.ReactNode }> = {
  pending: { label: '待开始', color: 'text-muted-foreground', icon: <Circle size={14} /> },
  in_progress: { label: '进行中', color: 'text-blue-500', icon: <Loader2 size={14} className="animate-spin" /> },
  completed: { label: '已完成', color: 'text-emerald-500', icon: <CheckCircle2 size={14} /> },
  skipped: { label: '已跳过', color: 'text-amber-500', icon: <SkipForward size={14} /> },
  failed: { label: '失败', color: 'text-red-500', icon: <AlertTriangle size={14} /> },
}

export function CampaignWorkflowSteps({
  campaignId,
  campaignName,
  campaignContext,
  onOpenInAgent,
}: CampaignWorkflowStepsProps): React.ReactElement {
  const [workflow, setWorkflow] = React.useState<CampaignWorkflow | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [loadError, setLoadError] = React.useState<string | null>(null)
  const [expandedSteps, setExpandedSteps] = React.useState<Set<string>>(new Set())
  const [executingStep, setExecutingStep] = React.useState<string | null>(null)
  const [updatingStep, setUpdatingStep] = React.useState<string | null>(null)
  const hasInProgressStep = workflow?.steps.some((step) => step.status === 'in_progress') ?? false

  // 加载工作流
  const loadWorkflow = React.useCallback(
    async (opts?: { silent?: boolean; keepExpanded?: boolean }) => {
      if (!opts?.silent) {
        setLoading(true)
      }
      setLoadError(null)
      try {
        const wf = await window.electronAPI.getCampaignWorkflow(campaignId)
        setWorkflow((prev) => {
          // 静默刷新时保持用户已展开的状态；首次加载时自动展开当前步骤
          if (opts?.keepExpanded && prev) {
            return wf
          }
          if (wf.currentStepIndex >= 0) {
            const currentStepId = wf.steps[wf.currentStepIndex]?.id
            if (currentStepId) {
              setExpandedSteps(new Set([currentStepId]))
            }
          }
          return wf
        })
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err)
        if (!opts?.silent) {
          setLoadError(message)
        }
        console.error('[WorkflowSteps] 加载工作流失败:', err)
      } finally {
        if (!opts?.silent) {
          setLoading(false)
        }
      }
    },
    [campaignId],
  )

  React.useEffect(() => {
    loadWorkflow()
  }, [loadWorkflow])

  // Agent 完成后主进程会回写 workflow 文件；这里在步骤进行中时轻量刷新，避免 UI 停在"进行中"。
  React.useEffect(() => {
    if (!hasInProgressStep) return

    let cancelled = false
    const refreshWorkflow = () => {
      loadWorkflow({ silent: true, keepExpanded: true }).catch(console.error)
    }

    const timer = window.setInterval(refreshWorkflow, 2000)
    refreshWorkflow()

    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [campaignId, hasInProgressStep, loadWorkflow])

  // 用户切回窗口时自动刷新工作流，捕获外部修改或 Agent 后台更新
  React.useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        loadWorkflow({ silent: true, keepExpanded: true }).catch(console.error)
      }
    }
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange)
  }, [loadWorkflow])

  // 切换步骤展开
  const toggleExpand = (stepId: string) => {
    setExpandedSteps((prev) => {
      const next = new Set(prev)
      if (next.has(stepId)) {
        next.delete(stepId)
      } else {
        next.add(stepId)
      }
      return next
    })
  }

  // 更新步骤状态
  const handleUpdateStep = async (stepId: CampaignWorkflowStepId, status: CampaignWorkflowStep['status']) => {
    setUpdatingStep(stepId)
    try {
      const input: UpdateWorkflowStepInput = {
        campaignId,
        stepId,
        status,
      }
      const updated = await window.electronAPI.updateCampaignWorkflowStep(input)
      setWorkflow(updated)
    } catch (err) {
      console.error('[WorkflowSteps] 更新步骤失败:', err)
    } finally {
      setUpdatingStep(null)
    }
  }

  // 执行步骤（发送到 Agent）
  const handleExecuteStep = (step: CampaignWorkflowStep) => {
    setExecutingStep(step.id)
    // 先标记为进行中
    handleUpdateStep(step.id, 'in_progress').catch(console.error)

    // 替换提示词模板
    let prompt = step.agentPrompt
    for (const [key, value] of Object.entries(campaignContext)) {
      prompt = prompt.replace(new RegExp(`\\{${key}\\}`, 'g'), value)
    }

    // 带 requiredFiles 的步骤：追加「落盘硬约束」，强制模型真实调用 Write 工具写文件
    if (step.requiredFiles && step.requiredFiles.length > 0) {
      prompt += `\n\n${buildArtifactPersistenceDirective(getArtifactDir(step.id), step.requiredFiles)}`
    }

    // 发送到 Agent
    onOpenInAgent(prompt)

    setTimeout(() => setExecutingStep(null), 500)
  }

  // 调整步骤（带上已有产物上下文）
  const handleAdjustStep = (step: CampaignWorkflowStep) => {
    if (!workflow) return
    setExecutingStep(step.id)

    // 构建调整提示词：带上已有产物上下文
    const artifactDir = getArtifactDir(step.id)
    let prompt = `## 调整 Campaign 工作流步骤：${step.title}\n\n`
    prompt += `这是第 ${workflow.steps.indexOf(step) + 1} 步（共 ${workflow.steps.length} 步）。\n\n`

    // 注入已完成步骤的上下文（作为前置依赖）
    const completedSteps = workflow.steps.filter(
      (s) => s.status === 'completed' && s.id !== step.id
    )
    if (completedSteps.length > 0) {
      prompt += `### 已完成的前置步骤\n\n`
      for (const s of completedSteps) {
        prompt += `- **${s.title}**: ${s.outputSummary ?? '已完成'}\n`
      }
      prompt += `\n`
    }

    // 注入该步骤已有产物
    prompt += `### 当前步骤已有产物\n\n`
    prompt += `步骤: ${step.title}\n`
    prompt += `工具: ${step.toolName}\n`
    prompt += `产物目录: \`${artifactDir}/\`\n`
    if (step.outputSummary) {
      prompt += `已有产出摘要: ${step.outputSummary}\n`
    }
    prompt += `\n`

    // 注入 Campaign 上下文
    prompt += `### Campaign 上下文\n\n`
    for (const [key, value] of Object.entries(campaignContext)) {
      prompt += `- ${key}: ${value}\n`
    }
    prompt += `\n`

    // 调整指令
    prompt += `### 调整指令\n\n`
    prompt += `请基于上述已有产物和上下文，对"${step.title}"进行调整或完善。\n`
    prompt += `如果需要修改文件，请保存到 \`${artifactDir}/\` 目录。\n`
    prompt += `完成后请更新产物摘要。\n\n`
    prompt += `请告诉我你想调整的具体内容：`

    // 带 requiredFiles 的步骤：调整后同样必须真实写入对应文件
    if (step.requiredFiles && step.requiredFiles.length > 0) {
      prompt += `\n\n${buildArtifactPersistenceDirective(getArtifactDir(step.id), step.requiredFiles)}`
    }

    onOpenInAgent(prompt)
    setTimeout(() => setExecutingStep(null), 500)
  }

  // 重置工作流
  const handleReset = async () => {
    if (!confirm('确定要重置工作流吗？所有步骤状态将清空。')) return
    try {
      const updated = await window.electronAPI.resetCampaignWorkflow(campaignId)
      setWorkflow(updated)
      setExpandedSteps(new Set())
    } catch (err) {
      console.error('[WorkflowSteps] 重置失败:', err)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8 text-muted-foreground">
        <Loader2 size={16} className="animate-spin mr-2" />
        <span className="text-xs">加载工作流...</span>
      </div>
    )
  }

  if (!workflow) {
    return (
      <div className="text-center py-6 text-muted-foreground text-xs">
        <div>工作流加载失败</div>
        {loadError && (
          <div className="mt-2 px-3 py-2 rounded bg-muted/50 text-[11px] text-red-500 break-all leading-relaxed">
            {loadError}
          </div>
        )}
      </div>
    )
  }

  const completedCount = workflow.steps.filter(
    (s) => s.status === 'completed' || s.status === 'skipped'
  ).length
  const progress = Math.round((completedCount / workflow.steps.length) * 100)

  return (
    <div className="space-y-4">
      {/* 进度条头部 */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
            工作流进度
          </h3>
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
            {completedCount}/{workflow.steps.length}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-muted-foreground">{progress}%</span>
          <Button
            size="sm"
            variant="ghost"
            className="h-6 w-6 p-0 text-muted-foreground hover:text-foreground"
            title="刷新工作流"
            onClick={() => loadWorkflow({ silent: true, keepExpanded: true })}
            disabled={loading}
          >
            <RefreshCw size={11} className={cn(loading && 'animate-spin')} />
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-2 text-[10px] text-muted-foreground hover:text-red-500"
            onClick={handleReset}
          >
            <RotateCcw size={11} className="mr-1" />
            重置
          </Button>
        </div>
      </div>

      {/* 进度条 */}
      <div className="h-1.5 w-full bg-muted rounded-full overflow-hidden">
        <div
          className="h-full bg-primary rounded-full transition-all duration-500"
          style={{ width: `${progress}%` }}
        />
      </div>

      {/* 步骤列表 */}
      <div className="space-y-2">
        {workflow.steps.map((step, index) => {
          const isCurrent = index === workflow.currentStepIndex
          const isExpanded = expandedSteps.has(step.id)
          const status = STATUS_CONFIG[step.status] ?? { label: '未知', color: 'text-gray-500', icon: <Circle size={14} /> }
          const isExecuting = executingStep === step.id
          const isUpdating = updatingStep === step.id

          return (
            <div
              key={step.id}
              className={cn(
                'rounded-xl border transition-all',
                isCurrent
                  ? 'border-primary/30 bg-primary/5'
                  : step.status === 'completed'
                    ? 'border-border/60 bg-muted/20'
                    : 'border-border bg-background'
              )}
            >
              {/* 步骤头部 - 可点击展开 */}
              <button
                className="w-full flex items-center gap-3 p-3 text-left"
                onClick={() => toggleExpand(step.id)}
              >
                {/* 序号/状态图标 */}
                <div
                  className={cn(
                    'flex-shrink-0 w-6 h-6 rounded-full flex items-center justify-center',
                    step.status === 'completed'
                      ? 'bg-emerald-500/10'
                      : step.status === 'in_progress'
                        ? 'bg-blue-500/10'
                        : 'bg-muted'
                  )}
                >
                  <span className={cn('text-[11px] font-bold', status.color)}>
                    {step.status === 'completed' ? (
                      <CheckCircle2 size={14} />
                    ) : step.status === 'in_progress' ? (
                      <Loader2 size={14} className="animate-spin" />
                    ) : (
                      index + 1
                    )}
                  </span>
                </div>

                {/* 标题和描述 */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span
                      className={cn(
                        'text-sm font-medium',
                        step.status === 'completed'
                          ? 'text-foreground/70'
                          : 'text-foreground'
                      )}
                    >
                      {step.title}
                    </span>
                    <span className={cn('text-[10px] px-1.5 py-0.5 rounded font-medium', status.color)}>
                      {status.label}
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground mt-0.5 truncate">
                    {step.description}
                  </p>
                </div>

                {/* 展开箭头 */}
                <div className="flex-shrink-0 text-muted-foreground">
                  {isExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                </div>
              </button>

              {/* 展开内容 */}
              {isExpanded && (
                <div className="px-3 pb-3 pt-0 border-t border-border/50">
                  {/* 工具信息 */}
                  <div className="mt-2 flex items-center gap-2 text-[10px] text-muted-foreground">
                    <Bot size={11} />
                    <span>工具：{step.toolName}</span>
                    {step.completedAt && (
                      <span>
                        · 完成于 {new Date(step.completedAt).toLocaleDateString()}
                      </span>
                    )}
                  </div>

                  {/* 输出摘要 */}
                  {step.outputSummary && (
                    <div className="mt-2 p-2 rounded-md bg-muted/50 text-xs text-muted-foreground">
                      {step.outputSummary}
                    </div>
                  )}

                  {/* 用户备注 */}
                  {step.notes && (
                    <div className="mt-2 text-[10px] text-muted-foreground">
                      备注：{step.notes}
                    </div>
                  )}

                  {/* 操作按钮 */}
                  <div className="mt-3 flex items-center gap-2">
                    {step.status === 'pending' || step.status === 'failed' ? (
                      <Button
                        size="sm"
                        variant="default"
                        className="h-7 text-xs"
                        onClick={() => handleExecuteStep(step)}
                        disabled={isExecuting || isUpdating}
                      >
                        {isExecuting ? (
                          <Loader2 size={12} className="mr-1 animate-spin" />
                        ) : (
                          <Play size={12} className="mr-1" />
                        )}
                        执行此步骤
                      </Button>
                    ) : step.status === 'in_progress' ? (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 text-xs border-emerald-500/30 text-emerald-600 hover:bg-emerald-500/5"
                        onClick={() => handleUpdateStep(step.id, 'completed')}
                        disabled={isUpdating}
                      >
                        <CheckCircle2 size={12} className="mr-1" />
                        标记完成
                      </Button>
                    ) : step.status === 'completed' ? (
                      <>
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 text-xs"
                          onClick={() => handleExecuteStep(step)}
                          disabled={isExecuting || isUpdating}
                        >
                          <RotateCcw size={12} className="mr-1" />
                          重新执行
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 text-xs border-blue-500/30 text-blue-600 hover:bg-blue-500/5"
                          onClick={() => handleAdjustStep(step)}
                          disabled={isExecuting || isUpdating}
                        >
                          <Pencil size={12} className="mr-1" />
                          调整此步骤
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 text-xs text-muted-foreground hover:text-amber-500"
                          onClick={() => handleUpdateStep(step.id, 'pending')}
                          disabled={isUpdating}
                        >
                          <SkipForward size={12} className="mr-1" />
                          撤销
                        </Button>
                      </>
                    ) : null}

                    {/* 跳过按钮（仅 pending 状态） */}
                    {step.status === 'pending' && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 text-xs text-muted-foreground hover:text-amber-500"
                        onClick={() => handleUpdateStep(step.id, 'skipped')}
                        disabled={isUpdating}
                      >
                        <SkipForward size={12} className="mr-1" />
                        跳过
                      </Button>
                    )}
                  </div>
                </div>
              )}
            </div>
          )
        })}
        {/* 整合方案（全部完成后显示） */}
        {completedCount === workflow.steps.length && (
          <div className="mt-5 p-4 rounded-xl border border-primary/20 bg-primary/5">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-sm font-semibold text-foreground">🎉 工作流全部完成</h3>
                <p className="text-xs text-muted-foreground mt-1">
                  所有 {workflow.steps.length} 个步骤已完成。生成完整整合方案文档。
                </p>
              </div>
              <Button
                size="sm"
                variant="default"
                className="h-8 text-xs"
                onClick={() => {
                  const prompt = `## 生成 Campaign 完整整合方案

请基于以下已完成的工作流步骤，生成一份完整的 Campaign 整合方案文档。

已完成步骤：
${workflow.steps
  .map((s, i) => `${i + 1}. ${s.title} — ${s.outputSummary ?? '已完成'}`)
  .join('\n')}

要求：
1. 汇总所有步骤的关键产出
2. 形成一份结构清晰的 Campaign 执行手册
3. 包含：品牌定位、TA 画像、创意概念、平台策略、KOL 方案、Brief 汇总、测试计划
4. 保存到 \`campaign-summary.md\`

请生成整合方案。`
                  onOpenInAgent(prompt)
                }}
              >
                生成整合方案
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

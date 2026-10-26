import { useMemo, useState } from 'react'
import { atom, useAtom, useAtomValue } from 'jotai'
import { getOwnerGoalEditor, ownerGoalEditorsAtom } from '../../atoms/project-owner-goal-atoms'
import { getOwnerPlanEditor, ownerPlanEditorsAtom } from '../../atoms/project-owner-plan-atoms'
import { getOwnerRuntimeEditor, ownerRuntimeEditorsAtom } from '../../atoms/project-owner-runtime-atoms'
import type { ProjectOwnerPlanDraft } from '@gravitas/shared'
import { isLatestOwnerRunCurrent } from './project-owner-run-current'
import { ProjectOwnerGoalPanel } from './ProjectOwnerGoalPanel'
import { ProjectOwnerPlanPanel } from './ProjectOwnerPlanPanel'
import { ProjectOwnerRuntimePanel } from './ProjectOwnerRuntimePanel'
import { ProjectOwnerConversation } from './ProjectOwnerConversation'

const outcomeLabels = {
  proposed: '已生成待审提案',
  needs_clarification: '需要补充信息',
  stale: '来源已变化，需重新核对',
  failed: '规划失败，未补发',
  unknown: '终态未知，未补发',
  stopped: '已请求停止，费用仍需核对',
} as const
const executionLabels = {
  queued: '已排队，尚不代表模型已发送',
  running: '正在处理',
  completed: '已完成，内容仍需审阅',
  failed: '执行失败',
  cancelled: '已取消',
  stale: '状态未知，已暂停',
} as const

function planLabel(state: string | undefined): string {
  if (state === 'proposed') return '待审阅'
  if (state === 'confirmed') return '已确认内容'
  if (state === 'stale') return '来源变化，需重新审阅'
  return '尚无计划提案'
}

export function ProjectOwnerHome({ projectId }: { projectId: string }): React.ReactElement {
  const subject = useMemo(() => ({ projectId }), [projectId])
  const stateAtom = useMemo(() => atom(get => ({
    goal: getOwnerGoalEditor(get(ownerGoalEditorsAtom), subject),
    runtime: getOwnerRuntimeEditor(get(ownerRuntimeEditorsAtom), subject),
    plan: getOwnerPlanEditor(get(ownerPlanEditorsAtom), subject),
  })), [subject])
  const { goal, runtime, plan } = useAtomValue(stateAtom)
  const [goalOpen, setGoalOpen] = useState(false)
  const [runtimeOpen, setRuntimeOpen] = useState(false)
  const [planOpen, setPlanOpen] = useState(false)
  // biome-ignore lint/correctness/useExhaustiveDependencies: 切换项目时重建折叠状态，避免隐式挂载上个项目的高级表单。
  const advancedAtom = useMemo(() => atom(false), [projectId])
  const [advancedOpen, setAdvancedOpen] = useAtom(advancedAtom)

  const latestRun = runtime.runs[0]
  const latestExecution = latestRun?.executions[0]
  const latestOutcome = latestExecution
    ? latestRun?.outcomes.find(outcome => outcome.executionId === latestExecution.id)
    : undefined
  const latestReceipt = latestExecution
    ? latestRun?.receipts.find(receipt => receipt.executionId === latestExecution.id)
    : undefined
  const latestRunCurrent = Boolean(latestRun && !runtime.loading && runtime.context && runtime.binding
    && isLatestOwnerRunCurrent({ link: latestRun.link, executionId: latestExecution?.id, outcome: latestOutcome,
      goalRevision: goal.snapshot?.revision, plan: plan.snapshot, bindingRevision: runtime.binding.revision,
      contextFingerprint: runtime.context.fingerprint }))
  const needsReconciliation = latestOutcome?.state === 'unknown' || latestOutcome?.state === 'failed'
    || latestOutcome?.state === 'stopped' || latestReceipt?.cost.source === 'unknown'
  const projectStage = !goal.snapshot ? '目标待保存'
    : !runtime.binding ? '规划配置待确认'
    : needsReconciliation ? '上次规划需核对'
    : latestRun && !latestRunCurrent ? '历史规划来源已变化'
    : latestOutcome ? outcomeLabels[latestOutcome.state]
    : latestExecution ? executionLabels[latestExecution.status]
    : latestRun ? '规划准备已就绪'
    : plan.snapshot ? planLabel(plan.snapshot.state)
    : '规划提案待准备'
  const nextAction = !goal.snapshot ? '先记录项目目标'
    : goal.conflict || goal.requiresReview ? '比较最新目标版本'
    : !runtime.binding ? '确认 Owner 规划配置'
    : needsReconciliation ? '先核对上次规划请求'
    : latestRun && !latestRunCurrent ? '核对规划来源是否仍匹配'
    : plan.snapshot?.state === 'proposed' ? '审阅规划提案'
    : plan.snapshot?.state === 'stale' ? '检查已变化的计划来源'
    : !plan.snapshot ? latestRun ? '确认本次规划范围与费用' : '准备一次目标规划'
    : '检查已确认计划，再准备执行授权'
  const nextDetail = !goal.snapshot
    ? '保存目标草案只记录本地内容，不会调用模型、扣费或派发任务。'
    : needsReconciliation
      ? '上次请求的费用或终态仍需核对；系统不自动重试，也不会把未知费用当作零。'
      : !runtime.binding
        ? '绑定仅复用已配置的 AI SDK 员工和双方授权的工作区；不会自动创建员工。'
        : latestRun && !latestRunCurrent
          ? '最近一条规划记录与当前目标、计划或配置来源不一致；先核对新旧来源，不把旧提案当作当前计划。'
        : plan.snapshot?.state === 'proposed'
          ? '提案是待审阅的工作方案，不是已经创建的任务或实际员工分配。'
          : '配置、准备与审阅均不等于执行授权；每个后续动作仍有独立门禁。'

  return <section className="space-y-4" aria-label="Owner 项目主页" data-project-id={projectId}>
    <header className="rounded-2xl bg-card p-5 shadow-sm sm:p-6">
      <p className="text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground">Project Owner · 项目主页</p>
      <div className="mt-2 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">先看目标，再决定下一步</h1>
          <p className="mt-1 text-sm text-muted-foreground">目标、规划与执行准备分开呈现；只有缺少信息时才展开设置。</p>
        </div>
        <span className="rounded-full bg-muted px-3 py-1.5 text-xs" role="status" aria-label="当前项目阶段">{projectStage}</span>
      </div>
    </header>

    <ProjectOwnerConversation projectId={projectId} />
    <details className="rounded-2xl bg-card p-5 shadow-sm" open={advancedOpen} onToggle={event => setAdvancedOpen(event.currentTarget.open)}>
    <summary className="cursor-pointer text-sm font-medium text-muted-foreground">项目详情与高级设置</summary>
    {advancedOpen && <div className="mt-4 grid min-w-0 items-start gap-4 xl:grid-cols-[minmax(0,1.6fr)_minmax(280px,.9fr)]">
      <div className="min-w-0 space-y-4">
        <article className="rounded-2xl bg-card p-5 shadow-sm sm:p-6" aria-label="项目目标摘要">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-xs text-muted-foreground">{goal.snapshot ? `已保存目标 · v${goal.snapshot.goal.goalVersion}` : '项目目标'}</p>
              <h2 className="mt-1 text-lg font-semibold">{goal.snapshot ? '这个项目希望得到什么结果？' : '先明确希望项目达到什么结果'}</h2>
            </div>
            <button type="button" className="rounded-lg bg-muted px-3 py-2 text-sm" onClick={() => setGoalOpen(true)}>
              {goal.snapshot ? '编辑目标' : '记录目标'}
            </button>
          </div>
          {goal.snapshot
            ? <p className="mt-4 whitespace-pre-wrap text-base leading-7">{goal.snapshot.goal.objective}</p>
            : <p className="mt-3 text-sm text-muted-foreground">还没有保存目标。先用一句话描述预期结果；约束和完成标准可以之后补充。</p>}
          {goal.snapshot && <div className="mt-4 flex flex-wrap gap-2 text-xs text-muted-foreground">
            <span className="rounded-full bg-muted px-3 py-1.5">约束 {goal.snapshot.goal.constraints.length} 条</span>
            <span className="rounded-full bg-muted px-3 py-1.5">完成标准 {goal.snapshot.goal.acceptanceCriteria.length} 条</span>
            {goal.dirty && <span className="rounded-full bg-amber-500/10 px-3 py-1.5 text-amber-700 dark:text-amber-300">有未保存修改</span>}
            {(goal.conflict || goal.requiresReview) && <span className="rounded-full bg-destructive/10 px-3 py-1.5 text-destructive">需要比较最新版本</span>}
          </div>}
          <div className="mt-5 grid gap-2 sm:grid-cols-3" aria-label="项目流程阶段">
            <div className={`rounded-xl p-3 text-sm ${goal.snapshot ? 'bg-primary/10' : 'bg-muted'}`}><strong className="block font-medium">01 · 项目目标</strong><span className="mt-1 block text-xs text-muted-foreground">{goal.snapshot ? '已保存草案，不会触发模型' : '先记录预期结果'}</span></div>
            <div className={`rounded-xl p-3 text-sm ${plan.snapshot ? 'bg-primary/10' : 'bg-muted'}`}><strong className="block font-medium">02 · 规划提案</strong><span className="mt-1 block text-xs text-muted-foreground">{planLabel(plan.snapshot?.state)}</span></div>
            <div className="rounded-xl bg-muted p-3 text-sm"><strong className="block font-medium">03 · 实际执行</strong><span className="mt-1 block text-xs text-muted-foreground">审阅并另行授权后进行</span></div>
          </div>
          <details open={goalOpen} onToggle={event => setGoalOpen(event.currentTarget.open)} className="mt-5 border-t pt-4">
            <summary className="cursor-pointer text-sm font-medium text-muted-foreground">{goal.snapshot ? '编辑目标、约束与完成标准' : '填写项目目标'}</summary>
            <div className="mt-4"><ProjectOwnerGoalPanel projectId={projectId} includePlanningPanels={false} /></div>
          </details>
        </article>

        <article className="rounded-2xl bg-card p-5 shadow-sm sm:p-6" aria-label="规划提案说明">
          <h2 className="text-lg font-semibold">规划提案是什么？</h2>
          <p className="mt-1 text-sm text-muted-foreground">它是待审阅的工作方案，不是已经派出的团队。</p>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <div className="rounded-xl bg-muted p-4"><p className="text-xs text-muted-foreground">规划阶段</p><p className="mt-1 text-sm font-medium">Owner 提出步骤、成果、依赖和岗位建议</p></div>
            <div className="rounded-xl bg-muted p-4"><p className="text-xs text-muted-foreground">执行准备阶段</p><p className="mt-1 text-sm font-medium">你确认实际员工、评审人、工作区与预算</p></div>
          </div>
          <details className="mt-4 border-t pt-3">
            <summary className="cursor-pointer text-sm font-medium">多角色如何分工，预算如何设置？</summary>
            <div className="mt-3 space-y-2 text-sm leading-6 text-muted-foreground">
              <p><strong className="text-foreground">分工：</strong>岗位是提案建议，不是员工分配。执行准备时再把每个岗位映射到员工，并指定评审人。</p>
              <p><strong className="text-foreground">预算：</strong>共享总额是全局上限；可选岗位上限只会进一步收紧。Reviewer 费用归入所评任务的岗位。未知费用继续占用预留额。</p>
              <p><strong className="text-foreground">账本单位：</strong>USD 微美元，不自动换汇。保存目标、准备规划和审阅提案不会自动授权或运行任务。</p>
            </div>
          </details>
        </article>

        <article className={`rounded-2xl p-5 shadow-sm sm:p-6 ${needsReconciliation ? 'bg-destructive/10' : 'bg-card'}`} aria-label="下一步">
          <p className="text-xs font-medium text-muted-foreground">下一步</p>
          <h2 className="mt-1 text-lg font-semibold">{nextAction}</h2>
          <p className="mt-2 text-sm text-muted-foreground">{nextDetail}</p>
          {latestOutcome && <div className="mt-4 rounded-xl bg-background/70 p-4" role={needsReconciliation ? 'alert' : 'status'}>
            <p className="font-medium">{latestRunCurrent ? outcomeLabels[latestOutcome.state] : `历史记录 · 来源已变化 · ${outcomeLabels[latestOutcome.state]}`}</p>
            <p className="mt-1 whitespace-pre-wrap text-sm text-muted-foreground">{latestOutcome.detail}</p>
            {needsReconciliation && <p className="mt-2 text-xs text-muted-foreground">usage、费用或完整停止状态缺失时保持 unknown；本页不会提供自动重试。</p>}
          </div>}
          <div className="mt-4 flex flex-wrap gap-2">
            {!goal.snapshot || goal.conflict || goal.requiresReview
              ? <button type="button" className="rounded-lg bg-primary px-3 py-2 text-sm text-primary-foreground" onClick={() => setGoalOpen(true)}>{goal.snapshot ? '比较最新目标' : '开始记录目标'}</button>
              : !runtime.binding
                ? <button type="button" className="rounded-lg bg-primary px-3 py-2 text-sm text-primary-foreground" onClick={() => setRuntimeOpen(true)}>配置规划载体</button>
                : needsReconciliation
                  ? <button type="button" className="rounded-lg bg-muted px-3 py-2 text-sm" onClick={() => setRuntimeOpen(true)}>查看调用记录</button>
                  : plan.snapshot
                    ? <button type="button" className="rounded-lg bg-primary px-3 py-2 text-sm text-primary-foreground" onClick={() => setPlanOpen(true)}>打开计划审阅</button>
                    : <button type="button" className="rounded-lg bg-primary px-3 py-2 text-sm text-primary-foreground" onClick={() => setRuntimeOpen(true)}>打开规划准备</button>}
          </div>
        </article>
      </div>

      <aside className="min-w-0 space-y-4" aria-label="配置与调用记录">
        <article className="rounded-2xl bg-card p-5 shadow-sm" aria-label="Owner规划配置摘要">
          <div className="flex items-start justify-between gap-3"><div><h2 className="font-semibold">Owner 规划配置</h2><p className="mt-1 text-xs text-muted-foreground">只在需要时展开修改</p></div><span className="rounded-full bg-muted px-2.5 py-1 text-xs">{runtime.binding ? '已配置' : runtime.loading ? '读取中' : '待配置'}</span></div>
          {runtime.binding
            ? <div className="mt-4 space-y-2 text-sm">
              <p>{runtime.employees.find(employee => employee.id === runtime.binding?.carrierId)?.name ?? '既有 AI 员工'}</p>
              <p className="text-xs text-muted-foreground">AI SDK · {runtime.binding.modelId} · 工作区 {runtime.workspaces.find(workspace => workspace.id === runtime.binding?.workspaceId)?.name ?? '已绑定'}</p>
            </div>
            : <p className="mt-3 text-sm text-muted-foreground">规划需要一名已配置的 AI SDK 员工和共同授权的工作区；不会自动创建或启用员工。</p>}
          <details open={runtimeOpen} onToggle={event => setRuntimeOpen(event.currentTarget.open)} className="mt-4 border-t pt-3">
            <summary className="cursor-pointer text-sm font-medium text-muted-foreground">配置载体、准备规划与查看调用记录</summary>
            <div className="mt-4"><ProjectOwnerRuntimePanel projectId={projectId} /></div>
          </details>
        </article>

        <article className="rounded-2xl bg-card p-5 shadow-sm" aria-label="最新模型调用摘要">
          <div className="flex items-start justify-between gap-3"><div><h2 className="font-semibold">最近一次规划</h2><p className="mt-1 text-xs text-muted-foreground">费用信息只显示可信回执；缺失时保持未知</p></div><span className={`rounded-full px-2.5 py-1 text-xs ${needsReconciliation ? 'bg-amber-500/10 text-amber-700 dark:text-amber-300' : 'bg-muted'}`}>{latestReceipt?.cost.source === 'runtime_reported' && latestReceipt.cost.usd !== null ? `Runtime 报告 USD ${latestReceipt.cost.usd}` : latestReceipt ? '费用 unknown' : '尚无请求记录'}</span></div>
          {latestExecution
            ? <div className="mt-4 space-y-2 text-sm"><p>{latestOutcome ? latestRunCurrent ? outcomeLabels[latestOutcome.state] : `历史记录 · 来源已变化 · ${outcomeLabels[latestOutcome.state]}` : executionLabels[latestExecution.status]}</p><p className="break-all text-xs text-muted-foreground">Run {latestExecution.id}</p>{latestReceipt && <p className="break-all text-xs text-muted-foreground">输入 token {latestReceipt.usage?.inputTokens ?? '未知'} · 输出 token {latestReceipt.usage?.outputTokens ?? '未知'} · Provider request ID {latestReceipt.providerRequestId ?? '未提供'}{latestReceipt.providerResponseId ? ` · Provider response ID ${latestReceipt.providerResponseId}` : ''}</p>}</div>
            : <p className="mt-3 text-sm text-muted-foreground">{latestRun ? '已准备规划承载任务，尚无模型调用回执。' : '尚无规划请求。保存目标和配置不会发送模型请求。'}</p>}
          {latestOutcome && <p className="mt-3 text-sm text-muted-foreground">{latestOutcome.detail}</p>}
        </article>

        <article className="rounded-2xl bg-card p-5 shadow-sm" aria-label="规划提案与执行准备">
          <div className="flex items-start justify-between gap-3"><div><h2 className="font-semibold">计划提案</h2><p className="mt-1 text-xs text-muted-foreground">{planLabel(plan.snapshot?.state)}</p></div><button type="button" className="rounded-lg bg-muted px-2.5 py-1.5 text-xs" onClick={() => setPlanOpen(true)}>{plan.snapshot ? '查看' : '打开'}</button></div>
          {plan.snapshot && <p className="mt-3 line-clamp-3 text-sm text-muted-foreground">{plan.snapshot.proposal.summary}</p>}
          <details open={planOpen} onToggle={event => setPlanOpen(event.currentTarget.open)} className="mt-4 border-t pt-3">
            <summary className="cursor-pointer text-sm font-medium text-muted-foreground">审阅提案与准备执行授权</summary>
            <div className="mt-4"><ProjectOwnerPlanPanel projectId={projectId} /></div>
          </details>
        </article>
      </aside>
    </div>}
    </details>
  </section>
}

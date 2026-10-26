import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { atom, useAtomValue, useSetAtom } from 'jotai'
import type { ProjectOwnerRunView } from '@gravitas/shared'
import { getOwnerGoalEditor, ownerGoalEditorsAtom, type OwnerGoalEditor } from '@/atoms/project-owner-goal-atoms'
import { applyOwnerClarificationAnswersToGoalAtom, type OwnerClarificationAnswerResult } from './project-owner-clarification-answers'
import { deriveOwnerPlanningNextStep } from './project-owner-planning-flow'
import { resumeOwnerClarificationAfterSaveAtom } from './project-owner-clarification-continuation'
import { getOwnerPlanEditor, loadOwnerPlanAtom, ownerPlanEditorsAtom, ownerPlanGoalReady } from '@/atoms/project-owner-plan-atoms'
import { editOwnerRuntimeAtom, getOwnerRuntimeEditor, loadOwnerRuntimeAtom, ownerRuntimeEditorsAtom, prepareOwnerRuntimeAtom, saveOwnerRuntimeAtom } from '@/atoms/project-owner-runtime-atoms'
import { isLatestOwnerRunCurrent } from './project-owner-run-current'
import { ControlledTaskStartButton } from './ControlledTaskStartButton'
import { AgentExecutionStopButton } from './AgentExecutionStopButton'
const field = 'mt-1 w-full min-w-0 rounded-md border bg-background p-2 text-sm focus-visible:ring-2 focus-visible:ring-ring'
const button = 'rounded-md bg-muted px-3 py-2 text-sm disabled:opacity-50'
const states = { proposed: '已生成待审提案', needs_clarification: '需要人工澄清', stale: '来源变化，未覆盖计划', failed: '规划失败，未补发', unknown: '终态未知，未补发', stopped: '已请求停止，远端费用未保证结清' }
function OwnerClarificationAnswers({ subject, executionId, linkId, clarification, goal }: {
  subject: { projectId: string; taskId?: string }
  executionId: string
  linkId: string
  clarification: NonNullable<ProjectOwnerRunView['outcomes'][number]['clarification']>
  goal: OwnerGoalEditor
}): React.ReactElement {
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [error, setError] = useState('')
  const [applied, setApplied] = useState(false)
  const answerId = useId()
  const applyAnswersToGoal = useSetAtom(applyOwnerClarificationAnswersToGoalAtom)
  const questions = clarification.questions
  const canApply = goal.loaded && !!goal.snapshot && !goal.loading && !goal.saving && !goal.conflict && !goal.requiresReview
    && questions.every(question => Boolean(answers[question.key]?.trim()))
  const answerLabels: Record<Extract<OwnerClarificationAnswerResult, { ok: false }>['reason'], string> = { invalid: '澄清问题无效，不能写入目标草案。', incomplete: '请先回答全部必要问题。', too_long: '单条答复超过目标约束长度，请缩短后再试。', too_many: '目标约束已达上限；请先合并或删除草案中的约束。', goal_unavailable: '目标尚未加载或正在冲突处理中，请先核对最新目标。', source_stale: '提问对应的目标、计划或规划来源已变化；刷新后重新检查，不会应用旧答复。' }
  const apply = () => {
    const result = applyAnswersToGoal({ subject, executionId, linkId, questions, answers })
    if (!result.ok) { setError(answerLabels[result.reason]); setApplied(false); return }
    setError('')
    setAnswers({})
    setApplied(true)
  }
  return <section className="mt-3 space-y-3 rounded-lg bg-background/70 p-3" aria-label="Owner必要澄清答复">
    <h4 className="font-medium">回答并修订目标</h4>
    {questions.map((question, index) => {
      const id = `${answerId}-question-${index}`
      return <div key={question.key} className="space-y-1">
        <label className="block text-sm font-medium" htmlFor={id}>{question.question}</label>
        {question.reasonType === 'source_conflict' && <p className="text-xs font-medium text-amber-700">来源冲突：请决定采用或如何协调以下来源；系统不替它们排序。</p>}
        <p className="text-xs text-muted-foreground">原因：{question.why}</p>
        {question.sourceReferences && <div className="rounded-md bg-amber-500/10 p-2 text-xs" aria-label="澄清涉及的来源冲突">
          <p>模型指出以下来源存在分歧；系统不替它们判定优先级：</p>
          <ul className="mt-1 list-disc pl-5">{question.sourceReferences.map((reference) => <li key={reference.sourceId}>
            <code>{reference.sourceId}</code>：“{reference.quote}”
          </li>)}</ul>
        </div>}
        {question.options.length > 0 && <p className="text-xs text-muted-foreground">可选建议：{question.options.join(' / ')}</p>}
        {question.recommended && <p className="text-xs text-muted-foreground">推荐：{question.recommended}（可自行修改）</p>}
        <textarea id={id} className={field} rows={2} maxLength={2000} value={answers[question.key] ?? ''} onChange={event => { setAnswers(current => ({ ...current, [question.key]: event.target.value })); setApplied(false); setError('') }} />
      </div>
    })}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {applied && <p role="status" className="text-sm">答复已加入当前未保存目标草案。请检查并保存；保存后会无费准备续跑，模型请求仍需单独确认费用。</p>}
    <button type="button" className={button} disabled={!canApply} onClick={apply}>加入目标约束草案</button>
    <p className="text-xs text-muted-foreground">答复不会自动保存。检查并保存新目标版本后，系统仅自动无费准备续跑；发送模型请求前仍需再次确认本次费用。</p>
  </section>
}
/** 保存职责配置、无费用准备和逐次模型确认分开；不会创建/启用员工或升级权限。 */
export function ProjectOwnerRuntimePanel({ projectId, taskId, showConfiguration = true }: { projectId: string; taskId?: string; showConfiguration?: boolean }): React.ReactElement {
  const subject = useMemo(() => ({ projectId, ...(taskId === undefined ? {} : { taskId }) }), [projectId, taskId])
  const view = useMemo(() => atom(get => ({ editor: getOwnerRuntimeEditor(get(ownerRuntimeEditorsAtom), subject), goal: getOwnerGoalEditor(get(ownerGoalEditorsAtom), subject), plan: getOwnerPlanEditor(get(ownerPlanEditorsAtom), subject), goalReady: ownerPlanGoalReady(get, subject) })), [subject])
  const { editor, goal, plan, goalReady } = useAtomValue(view)
  const load = useSetAtom(loadOwnerRuntimeAtom), edit = useSetAtom(editOwnerRuntimeAtom), save = useSetAtom(saveOwnerRuntimeAtom), prepare = useSetAtom(prepareOwnerRuntimeAtom), loadPlan = useSetAtom(loadOwnerPlanAtom)
  const id = useId(), busy = editor.loading || editor.saving
  const resumedClarificationKeys = useRef(new Set<string>())
  const resumeClarification = useSetAtom(resumeOwnerClarificationAfterSaveAtom)
  const revision = goal.snapshot?.revision
  // biome-ignore lint/correctness/useExhaustiveDependencies: 目标保存后必须重新获取冻结来源，不沿用上一目标的准备预检。
  useEffect(() => { void load(subject) }, [load, subject, revision])
  const carriers = editor.employees.filter(item => item.enabled && item.executionProfile === 'controlled' && item.runtime === 'ai-sdk')
  const carrier = carriers.find(item => item.id === editor.carrierId)
  const workspaces = editor.workspaces.filter(item => editor.boundWorkspaceIds.includes(item.id) && (carrier?.workspaceIds?.includes(item.id) || carrier?.workspaceId === item.id))
  const latestRun = editor.runs[0]
  const latestExecution = latestRun?.executions[0] ?? null
  const executionId = latestExecution?.id
  const executionPending = latestExecution?.status === 'queued' || latestExecution?.status === 'running'
  // biome-ignore lint/correctness/useExhaustiveDependencies: 执行主体切换时清理旧计时器和在途保护。
  useEffect(() => {
    if (!executionPending) return
    let reading = false
    const refresh = async () => {
      if (reading) return
      reading = true
      try { await load(subject); await loadPlan(subject) }
      finally { reading = false }
    }
    const timer = window.setInterval(() => void refresh(), 4000)
    window.addEventListener('focus', refresh)
    return () => { window.clearInterval(timer); window.removeEventListener('focus', refresh) }
  }, [load, loadPlan, subject, executionId, executionPending])
  const latestOutcome = latestExecution ? latestRun?.outcomes.find(item => item.executionId === latestExecution.id) ?? null : null
  const latestRunCurrent = Boolean(latestRun && !editor.loading && editor.context && editor.binding
    && isLatestOwnerRunCurrent({ link: latestRun.link, executionId: latestExecution?.id, outcome: latestOutcome ?? undefined,
      goalRevision: goal.snapshot?.revision, plan: plan.snapshot, bindingRevision: editor.binding.revision,
      contextFingerprint: editor.context.fingerprint }))
  const priorClarification = latestRun?.outcomes.find(outcome => outcome.state === 'needs_clarification')?.clarification
  const clarificationResumeKey = latestRun && latestExecution && priorClarification && goal.snapshot
    ? `${latestRun.link.id}:${latestExecution.id}:${goal.snapshot.revision}` : null
  const canResumeClarification = goalReady && !goal.loading && !goal.saving
    && plan.loaded && !plan.loading && !plan.saving && !plan.dirty && !plan.conflict && !plan.requiresReview
    && !busy && !editor.dirty && editor.context?.goal.revision === revision
  useEffect(() => {
    if (!canResumeClarification || !clarificationResumeKey || !latestRun || !latestExecution || resumedClarificationKeys.current.has(clarificationResumeKey)) return
    resumedClarificationKeys.current.add(clarificationResumeKey)
    void resumeClarification({ ...subject, linkId: latestRun.link.id, executionId: latestExecution.id })
  }, [resumeClarification, subject, latestRun, latestExecution, clarificationResumeKey, canResumeClarification])
  const nextStep = deriveOwnerPlanningNextStep({
    goal: { exists: goal.snapshot !== null, dirty: goal.dirty, requiresReview: goal.requiresReview, conflict: goal.conflict },
    binding: { exists: editor.binding !== null, available: Boolean(editor.binding && carrier && workspaces.some(item => item.id === editor.binding?.workspaceId)) },
    plan: { state: plan.snapshot?.state ?? 'none', dirty: plan.dirty, requiresReview: plan.requiresReview, conflict: plan.conflict },
    prepared: Boolean(latestRun && latestRun.executions.length === 0),
    executionStatus: latestExecution?.status ?? null,
    outcomeState: latestRun && !latestRunCurrent ? 'stale' : latestOutcome?.state ?? null,
  })
  const canPrepare = !busy && !editor.dirty && Boolean(editor.binding && editor.context && goalReady && plan.loaded && !plan.loading && !plan.saving && !plan.dirty && !plan.conflict && !plan.requiresReview && editor.context.goal.revision === revision)
  const changed = async () => { await Promise.all([load(subject), loadPlan(subject)]) }
  return <section className="mt-4 min-w-0 rounded-xl bg-card p-5 shadow-sm [overflow-wrap:anywhere]" aria-label="Owner受控模型规划">
    <div className="flex flex-wrap items-center justify-between gap-3"><h2 className="text-lg font-semibold">Owner 模型规划</h2><button type="button" className={button} disabled={busy} onClick={() => void changed()}>刷新配置、Run与提案</button></div>
    <p className="mt-2 text-xs leading-relaxed text-muted-foreground">Owner是项目治理职责，下面的既有AI员工只是模型调用载体，不会被改名、激活或升级权限。配置与准备均不收费；真正调用前另行确认本次模型费用。规划只生成待审内容或必要澄清，不自动派工或完成业务任务。</p>
    {editor.error && <p role="alert" className="mt-3 text-sm text-destructive">{editor.error}。未自动重试，请比较最新来源。</p>}
    <section className="mt-4 rounded-lg bg-muted/40 p-3" aria-label="Owner规划下一步" data-stage={nextStep.stage}>
      <h3 className="text-sm font-semibold">{nextStep.title}</h3>
      <p className="mt-1 text-xs text-muted-foreground">{nextStep.detail}</p>
    </section>
    {showConfiguration && <><form className="mt-4 space-y-3" onSubmit={event => { event.preventDefault(); void save(subject) }}>
      <label className="block text-sm" htmlFor={`${id}-name`}>Owner职责名称<input id={`${id}-name`} className={field} required maxLength={200} value={editor.ownerName} disabled={busy} onChange={event => edit({ subject, patch: { ownerName: event.target.value } })} /></label>
      <label className="block text-sm" htmlFor={`${id}-carrier`}>实际规划载体（仅既有受控AI SDK员工）<select id={`${id}-carrier`} className={field} disabled={busy} value={editor.carrierId} onChange={event => edit({ subject, patch: { carrierId: event.target.value, workspaceId: '' } })}><option value="">请选择已有员工，不默认创建</option>{!carriers.some(item => item.id === editor.carrierId) && editor.carrierId && <option value={editor.carrierId}>原载体不可用（{editor.carrierId}）</option>}{carriers.map(item => <option key={item.id} value={item.id}>{item.name} · {item.role} · {item.modelId ?? '模型未明确'}</option>)}</select></label>
      {!carriers.length && !busy && <p className="text-xs text-muted-foreground">尚无已启用的受控AI SDK载体。请在团队中由用户配置合适员工；此处不会自动创建或启用。</p>}
      <label className="block text-sm" htmlFor={`${id}-workspace`}>双方明确授权的项目工作区<select id={`${id}-workspace`} className={field} disabled={busy} value={editor.workspaceId} onChange={event => edit({ subject, patch: { workspaceId: event.target.value } })}><option value="">请选择共同授权工作区，不回退主目录</option>{!workspaces.some(item => item.id === editor.workspaceId) && editor.workspaceId && <option value={editor.workspaceId}>原工作区不可用（{editor.workspaceId}）</option>}{workspaces.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      <label className="block text-sm" htmlFor={`${id}-reason`}>配置变更原因<input id={`${id}-reason`} className={field} required maxLength={2000} disabled={busy} value={editor.changeReason} onChange={event => edit({ subject, patch: { changeReason: event.target.value } })} /></label>
      <button type="submit" className={button} disabled={busy || !editor.dirty || !editor.ownerName.trim() || !carrier || !workspaces.some(item => item.id === editor.workspaceId) || !editor.changeReason.trim()}>保存Owner与载体绑定（不收费）</button>
      {editor.binding && <p className="text-xs text-muted-foreground">已保存配置 v{editor.binding.revision} · 载体 {editor.binding.carrierId} · 渠道 {editor.binding.channelId} · 模型 {editor.binding.modelId}。不代表本次调用费用已同意。</p>}
    </form>
    <div className="mt-4 space-y-2"><button type="button" className="rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-50" disabled={!canPrepare} onClick={() => void prepare(subject)}>准备一次目标规划（不收费）</button><p className="text-xs text-muted-foreground">请先保存目标、绑定配置并解决目标/计划冲突。准备会创建可见暂停承载任务，冻结当前目标和计划版本；不会发送模型请求。未保存计划编辑不作为AI输入。</p></div></>}
    <div className="mt-4 space-y-3" aria-label="Owner规划Run记录"><p className="text-xs text-muted-foreground">本主体最近最多50份准备。费用来自Runtime报告或保持未知；这些本机回执不宣称Provider请求ID或外部验收证明。</p>{!editor.runs.length && <p className="text-sm text-muted-foreground">尚无暂停准备或规划Run。</p>}{editor.runs.map(run => <article key={run.link.id} className="space-y-2 rounded-lg bg-muted/40 p-3 text-sm">
      <p className="font-medium">目标 v{run.link.goalVersion} · 目标修订 {run.link.goalRevision} · 计划修订 {run.link.planRevision} · 配置 v{run.link.bindingRevision}</p>
      <p className="text-xs text-muted-foreground">暂停承载任务：{run.link.planningTaskId}；用途 owner_planning，最多1请求/{run.link.maxOutputTokens}输出token（协议v{run.link.protocolVersion}）。</p>
      {!run.executions.length && goalReady && !editor.dirty && !plan.dirty && run.link.goalRevision === revision && run.link.planRevision === (plan.snapshot?.revision ?? 0) && run.link.bindingRevision === editor.binding?.revision && <ControlledTaskStartButton taskId={run.link.planningTaskId} revision={JSON.stringify([run.link.goalRevision, run.link.planRevision, run.link.bindingRevision])} onChanged={changed} />}
      {run.executions.map(execution => <div key={execution.id} className="space-y-1"><p>Run {execution.id} · {execution.status}</p><p className="text-xs text-muted-foreground">{execution.summary ?? '尚无处理终态；排队不证明模型已发送。'}</p><AgentExecutionStopButton execution={{ id: execution.id, status: execution.status, entityType: 'task', entityId: run.link.planningTaskId }} onChanged={changed} /></div>)}
      {run.outcomes.map(outcome => <div key={outcome.executionId}>
        <p>{states[outcome.state]}：{outcome.detail}</p>
        {outcome.clarification && <div className="mt-2 space-y-1">
          <p className="font-medium">必要澄清：{outcome.clarification.reason}</p>
          {run.link.id === latestRun?.link.id && latestRunCurrent && latestExecution?.id === outcome.executionId
            ? <OwnerClarificationAnswers key={outcome.executionId} subject={subject} executionId={outcome.executionId} linkId={run.link.id} clarification={outcome.clarification} goal={goal} />
            : <p className="text-xs text-muted-foreground">这是历史或来源已变化的澄清记录；请核对当前目标，不会自动续跑。</p>}
        </div>}
      </div>)}
      {run.receipts.map(receipt => <details key={receipt.id} className="text-xs"><summary className="cursor-pointer">Run原文与费用证据 · {receipt.cost.source === 'unknown' ? '费用未知（不是零元）' : `Runtime报告USD ${receipt.cost.usd}`} · {new Date(receipt.capturedAt).toLocaleString()}</summary><p className="mt-2">输入token {receipt.usage?.inputTokens ?? '未知'} / 输出token {receipt.usage?.outputTokens ?? '未知'}；终态 {receipt.validTerminal ? '完整stop（内容仍需协议校验/人工确认）' : '未证实完整stop'}；{receipt.stopped ? '停止不保证远端已终止。' : ''}</p><p>{receipt.error}</p><pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-words">{receipt.responseText || '没有收到可保存文本；不补发。'}</pre><p className="break-all">原文摘要 {receipt.responseHash}；回执 {receipt.id}</p></details>)}
    </article>)}</div>
  </section>
}

import { useEffect, useId, useMemo, useRef } from 'react'
import { atom, useAtomValue, useSetAtom } from 'jotai'
import type { ProjectOwnerPlanDraft, ProjectOwnerPlanSources } from '@gravitas/shared'
import { getOwnerGoalEditor, ownerGoalEditorsAtom } from '../../atoms/project-owner-goal-atoms'
import { acknowledgeOwnerPlanComparisonAtom, canRemoveOwnerPlanStep, removeOwnerPlanStepAtom, canConfirmOwnerPlan, canSaveOwnerPlan, confirmOwnerPlanAtom, editOwnerPlanAtom, getOwnerPlanEditor, loadOwnerPlanAtom, loadOwnerPlanHistoryAtom, ownerPlanEditorsAtom, ownerPlanGoalReady, saveOwnerPlanAtom } from '../../atoms/project-owner-plan-atoms'

import { ProjectOwnerExecutionConversation } from './ProjectOwnerExecutionConversation'
import { OwnerModuleStatus } from './OwnerModuleStatus'

const fieldClass = 'mt-1 w-full min-w-0 rounded-md border bg-background p-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
const buttonClass = 'rounded-md bg-muted px-3 py-2 text-sm disabled:opacity-50'
const stateLabel = (state: ProjectOwnerPlanDraft['state']) => state === 'stale' ? '已过期' : state === 'confirmed' ? '已确认内容' : '待审阅'
const feedbackAuthorizationLabel = (impact: NonNullable<ProjectOwnerPlanDraft['proposal']['deliveryFeedbackAssessment']>['authorizationImpact']) => impact === 'within_confirmed_boundary' ? '未发现超出当前确认范围' : impact === 'additional_confirmation' ? '包含需要你确认的新增范围' : '影响尚不能确定'
const feedbackDispositionLabel = (disposition: NonNullable<ProjectOwnerPlanDraft['proposal']['deliveryFeedbackAssessment']>['changes'][number]['disposition']) => disposition === 'addressed' ? '本方案拟处理' : disposition === 'still_open' ? '仍未解决' : '不适用'
function feedbackApprovalInstruction(plan: ProjectOwnerPlanDraft): string {
  if (plan.state === 'stale') return '方案依据已变化，这份修订方案已失效，不能直接确认；Owner需要按最新信息重新整理。旧执行许可不会沿用。'
  if (plan.proposal.deliveryFeedbackAssessment?.authorizationImpact !== 'within_confirmed_boundary') {
    return plan.state === 'confirmed'
      ? '方案内容已确认，但新增或未能确认的范围仍需你确认；完成前Owner不会启动员工。旧执行许可不会沿用。'
      : '这份修订方案仍待你审阅；新增或未能确认的范围还需你确认，完成前Owner不会启动员工。旧执行许可不会沿用。'
  }
  if (plan.state === 'confirmed') return '你已确认这份修订方案；Owner正在核对剩余额度和来源，未完成核对前不会启动员工。旧执行许可不会沿用。'
  return '这份修订方案仍待你审阅；确认方案并开始执行前，Owner会核对剩余额度和来源，旧执行许可不会沿用。'
}
interface PlanTextFieldProps {
  id: string
  label: string
  value: string
  onChange: (value: string) => void
  required?: boolean
  rows?: number
  maxLength?: number
}
function PlanTextField({ id, label, value, onChange, required, rows = 2, maxLength }: PlanTextFieldProps): React.ReactElement {
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  // biome-ignore lint/correctness/useExhaustiveDependencies: 文本变化时必须重新测量高度，内容通过 ref 从 DOM 读取。
  useEffect(() => {
    const textarea = textareaRef.current
    if (!textarea) return
    textarea.style.height = 'auto'
    textarea.style.height = `${textarea.scrollHeight}px`
  }, [value])
  return <div><label className="block text-sm font-medium" htmlFor={id}>{label}</label>
    <textarea ref={textareaRef} id={id} className={`${fieldClass} resize-y overflow-y-hidden`} rows={rows} required={required} maxLength={maxLength} value={value} onChange={event => onChange(event.target.value)} />
  </div>
}
function PlanSourceFacts({ sources }: { sources: ProjectOwnerPlanSources }): React.ReactElement {
  return <div className="space-y-1 whitespace-pre-wrap text-xs text-muted-foreground">
    <p>项目来源：{sources.project.title}（{sources.project.id}）<br />{sources.project.description || '无项目描述'}</p>
    {sources.task && <p>任务来源：{sources.task.title}（{sources.task.id}）<br />{sources.task.description || '无任务描述'}</p>}
    <p>岗位来源：{sources.roles.map(role => `${role.name} [${role.key}] v${role.version}`).join('；') || '无'}</p>
    <details><summary className="cursor-pointer">岗位来源校验值（仅标识来源，不是授权）</summary>{sources.roles.map(role => <p key={role.key} className="mt-1">{role.key}<br />source: {role.sourceSha256}<br />rules: {role.rulesSha256}</p>)}</details>
    {sources.code && <details><summary className="cursor-pointer">源码检索证据 · {sources.code.files.length} 个候选 / 扫描 {sources.code.filesScanned} 个文件{sources.code.truncated ? ' · 结果已截断' : ''}</summary>
      <p>工作区 {sources.code.workspaceId} · 根目录指纹 {sources.code.rootFingerprint}</p>
      {sources.code.files.map(file => <div key={file.path} className="mt-2 rounded bg-background/60 p-2"><p>{file.path} · SHA-256 {file.sha256}</p>
        {file.excerpts.map(excerpt => <pre key={`${excerpt.path}:${excerpt.line}`} className="mt-1 overflow-auto whitespace-pre-wrap">L{excerpt.line}: {excerpt.text}</pre>)}</div>)}
      {!sources.code.files.length && <p>未找到匹配源码片段；提案不得虚构文件位置。</p>}
    </details>}
    {sources.delivery?.map(item => <details key={item.commandId}><summary className="cursor-pointer">反馈交付证据 · 命令 {item.commandId} · {item.state}</summary>
      <p>冻结验收标准：{item.acceptanceCriteria.join('；')}</p><p>执行回报（执行者自述）：{item.executionResultSummary ?? '无'}</p>
      {item.technicalReview && <p>技术评审：{item.technicalReview.verdict} · {item.technicalReview.summary} · {item.technicalReview.findings.map(finding => finding.requestedChange).join('；') || '无修改要求'}</p>}
      <p>人工反馈：{item.feedback}</p><p>原授权快照（仅历史上限）：{item.priorAuthorization.grantState} · {item.priorAuthorization.dispatchMode} · 最高费用 {item.priorAuthorization.maxCostMicros} 微单位 · 最多 {item.priorAuthorization.maxRuns} 次运行 / {item.priorAuthorization.maxRework} 次返工 · 截止 {new Date(item.priorAuthorization.expiresAt).toLocaleString()}</p><p>岗位预算上限：{item.priorAuthorization.roleBudgetCaps.map(cap => `${cap.roleKey} ${cap.maxCostMicros}`).join("；") || "无"}</p><p>授权引用 {item.grantId}；仅识别历史来源，不代表当前有效、剩余额度或许可继承。</p>
    </details>)}
  </div>
}
/** 完整只读事实用于冲突比较和历史；不允许把历史版本恢复成当前确认。 */
function PlanFacts({ plan }: { plan: ProjectOwnerPlanDraft }): React.ReactElement {
  return <div className="space-y-2 whitespace-pre-wrap text-sm">
    <p>计划 v{plan.planVersion} · {stateLabel(plan.state)} · 目标 v{plan.goalVersion} · {plan.origin === 'generated' ? 'AI生成（可信Run）' : '人工记录'}</p>
    {plan.sourceRun && <p className="text-xs text-muted-foreground break-all">来源Run：{plan.sourceRun.executionId}；回执 {plan.sourceRun.receiptId}；原文摘要 {plan.sourceRun.responseHash}</p>}
    <p>{plan.proposal.summary}</p>
    <p>假设：{plan.proposal.assumptions.join('；') || '无'}</p><p>风险：{plan.proposal.risks.join('；') || '无'}</p>
    {plan.proposal.deliveryChangeAssessment && <section className="space-y-2 rounded-md bg-muted/40 p-3" aria-label="交付改动与授权影响">
      <h4 className="font-medium">交付改动与授权影响建议</h4><p>{plan.proposal.deliveryChangeAssessment.summary}</p>
      {plan.proposal.deliveryChangeAssessment.commands.map(command => <div key={command.commandId} className="rounded bg-background/60 p-2">
        <p className="font-medium">命令 {command.commandId} · 授权影响：{command.authorizationImpact}</p><p>{command.authorizationRationale}</p>
        <ul className="list-disc pl-5">{command.changes.map((change, index) => <li key={`${index}-${change.criterion}`}>{change.criterion} · {change.disposition}：{change.proposedChange}</li>)}</ul>
      </div>)}
      <p className="text-xs text-muted-foreground">这是规划建议，不代表已实施或已获授权。执行、写回与外发须走各自的授权确认。</p>
    </section>}
    {plan.proposal.deliveryFeedbackAssessment && <section className="space-y-2 rounded-md bg-muted/40 p-3" aria-label="成果反馈改动与授权影响">
      <h4 className="font-medium">成果修改建议与范围判断</h4><p>{plan.proposal.deliveryFeedbackAssessment.summary}</p>
      <p>{feedbackAuthorizationLabel(plan.proposal.deliveryFeedbackAssessment.authorizationImpact)}：{plan.proposal.deliveryFeedbackAssessment.authorizationRationale}</p>
      <ul className="list-disc pl-5">{plan.proposal.deliveryFeedbackAssessment.changes.map((change, index) => <li key={`${index}-${change.criterion}`}>{change.criterion} · {feedbackDispositionLabel(change.disposition)}：{change.proposedChange}</li>)}</ul>
      <p className="text-xs text-muted-foreground">这是基于所选已验收版本的建议。旧执行许可不会沿用；本方案仍待你审阅，确认后才会开始。</p>
    </section>}
    <ol className="space-y-2">{plan.proposal.steps.map(step => <li key={step.key} className="rounded-md bg-background/60 p-2">
      <p className="font-medium">{step.key} · {step.title}</p><p>成果：{step.outcome}</p><p>完成标准：{step.acceptanceCriteria.join('；')}</p>
      <p>岗位建议：{plan.sources.roles.find(role => role.key === step.roleKey)?.name ?? step.roleKey} · 依赖：{step.dependencies.join('、') || '无'}</p>
      {step.sourceReferences?.map(reference => <p key={`${reference.path}:${reference.line}`} className="text-xs text-muted-foreground">源码依据：{reference.path}:{reference.line} · SHA-256 {reference.sha256}</p>)}
    </li>)}</ol>
    <p className="text-xs text-muted-foreground">修订原因：{plan.changeReason} · 本机登记人：{plan.actor}</p>
    <PlanSourceFacts sources={plan.sources} />
    <details className="text-xs text-muted-foreground"><summary className="cursor-pointer">计划与来源指纹</summary><p>context: {plan.contextFingerprint}<br />plan: {plan.planFingerprint}</p></details>
  </div>
}
interface ConversationPlanSummaryProps {
  plan: ProjectOwnerPlanDraft
  dirty: boolean
}
function ConversationPlanSummary({ plan, dirty }: ConversationPlanSummaryProps): React.ReactElement {
  return <div className="mt-4 space-y-3 text-sm" aria-label="Owner方案摘要">
    <p className="leading-6">{plan.proposal.summary}</p>
    {plan.proposal.deliveryFeedbackAssessment && <section className="space-y-2 rounded-xl bg-primary/5 p-3" aria-label="针对本次修改意见的评估">
      <p className="font-medium">针对这次修改意见</p><p>{plan.proposal.deliveryFeedbackAssessment.summary}</p>
      <p className="text-xs text-muted-foreground">范围判断：{feedbackAuthorizationLabel(plan.proposal.deliveryFeedbackAssessment.authorizationImpact)}。{plan.proposal.deliveryFeedbackAssessment.authorizationRationale}。{feedbackApprovalInstruction(plan)}</p>
      <details><summary className="cursor-pointer text-xs">逐项查看原完成标准如何处理</summary><ul className="mt-2 list-disc space-y-1 pl-5 text-xs">{plan.proposal.deliveryFeedbackAssessment.changes.map((change, index) => <li key={`${index}-${change.criterion}`}>{change.criterion}：{feedbackDispositionLabel(change.disposition)}；{change.proposedChange}</li>)}</ul></details>
    </section>}
    <details className="rounded-lg bg-muted/30 px-3 py-2">
      <summary className="cursor-pointer text-sm">查看交付明细与重要条件</summary>
      <div className="mt-3 space-y-3">
      <div><p className="font-medium">交付内容</p><ul className="list-disc pl-5">{plan.proposal.steps.map(step => <li key={step.key}>{step.outcome}</li>)}</ul></div>
      <div><p className="font-medium">完成标准</p><ul className="list-disc pl-5">{plan.proposal.steps.flatMap(step => step.acceptanceCriteria).map((criterion, index) => <li key={`${index}-${criterion}`}>{criterion}</li>)}</ul></div>
      {plan.proposal.assumptions.length > 0 && <p>方案前提：{plan.proposal.assumptions.join('；')}</p>}
      {plan.proposal.risks.length > 0 && <p>需留意：{plan.proposal.risks.join('；')}</p>}
      </div>
    </details>
    <p className="text-xs text-muted-foreground">想调整结果、标准或限制，直接在下方对话告诉 Owner；无需拆解步骤或选择岗位。</p>
    {dirty && <p role="status">方案存在未保存修改；请通过下方对话说明希望的结果变化，Owner 会整理新的方案供你确认。</p>}
  </div>
}
export function ProjectOwnerPlanPanel({ projectId, taskId, conversational = false }: { projectId: string; taskId?: string; conversational?: boolean }): React.ReactElement {
  const subject = useMemo(() => ({ projectId, ...(taskId === undefined ? {} : { taskId }) }), [projectId, taskId])
  const viewAtom = useMemo(() => atom(get => ({ editor: getOwnerPlanEditor(get(ownerPlanEditorsAtom), subject), goalRevision: getOwnerGoalEditor(get(ownerGoalEditorsAtom), subject).snapshot?.revision, goalReady: ownerPlanGoalReady(get, subject), canSave: canSaveOwnerPlan(get, subject), canConfirm: canConfirmOwnerPlan(get, subject) })), [subject])
  const { editor, goalRevision, goalReady, canSave, canConfirm } = useAtomValue(viewAtom)
  const load = useSetAtom(loadOwnerPlanAtom); const edit = useSetAtom(editOwnerPlanAtom)
  const save = useSetAtom(saveOwnerPlanAtom); const confirm = useSetAtom(confirmOwnerPlanAtom)
  const acknowledge = useSetAtom(acknowledgeOwnerPlanComparisonAtom); const history = useSetAtom(loadOwnerPlanHistoryAtom)
  const removeStep = useSetAtom(removeOwnerPlanStepAtom)
  const id = useId()
  // biome-ignore lint/correctness/useExhaustiveDependencies: 已保存目标版本变化时刷新派生 stale 与来源；未保存目标仍由 atom 门禁阻止写入。
  useEffect(() => { void load(subject) }, [load, subject, goalRevision])
  const snapshot = editor.snapshot
  const roles = editor.context?.sources.roles ?? snapshot?.sources.roles ?? []
  const editStep = (index: number, patch: Partial<(typeof editor.steps)[number]>) => edit({ subject, patch: { steps: editor.steps.map((step, i) => i === index ? { ...step, ...patch } : step) } })
  const conversationalState = editor.loading ? '正在整理方案' : snapshot?.state === 'confirmed' ? '方案已确认' : snapshot?.state === 'stale' ? '方案需要更新' : snapshot ? '待你审阅' : '尚无方案'
  return <section className="mt-4 min-w-0 rounded-xl bg-card p-5 shadow-sm [overflow-wrap:anywhere]" aria-label={conversational ? 'Owner方案' : taskId ? '任务计划审阅' : '项目计划审阅'}>
    <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-lg font-semibold">{conversational ? 'Owner 的方案' : 'Owner 计划审阅'}</h2>{snapshot && !conversational && <p className="mt-1 text-xs text-muted-foreground">计划 v{snapshot.planVersion} · {snapshot.origin === 'generated' ? 'AI生成（可信Run）' : '人工记录'}</p>}</div>
      <OwnerModuleStatus tone={editor.loading ? 'muted' : snapshot?.state === 'confirmed' ? 'accent' : snapshot?.state === 'stale' ? 'danger' : snapshot ? 'warn' : 'muted'}>{conversational ? conversationalState : editor.loading ? '正在加载' : snapshot ? stateLabel(snapshot.state) : '尚无计划'}</OwnerModuleStatus></div>
    <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{conversational ? '你可以在对话里补充目标和修改意见。首次执行时，在同一次最终确认中确认方案范围与必要边界，Owner随后按方案推进；对已交付成果的修改，Owner会先给出修订方案，等你确认后再继续。' : '这里只审阅和确认内容，不会调用模型，不会收费或派工。岗位建议不是员工实例，步骤不是已创建任务；旧版本确认不沿用到新版本。'}</p>
    {editor.error && (conversational ? <div className="mt-3 space-y-2"><p className="text-sm text-destructive" role="alert">暂时无法读取最新方案；你的对话和修改意见仍会保留。</p><button type="button" className={buttonClass} disabled={editor.loading || editor.saving} onClick={() => void load(subject)}>重新读取方案</button></div> : <p className="mt-3 text-sm text-destructive" role="alert">计划接口：{editor.error}。本地输入仍保留，目标保存不受影响。</p>)}
    {!snapshot && <p className="mt-4 text-sm text-muted-foreground">{editor.loaded ? conversational ? 'Owner 正在根据目标和项目现状整理方案。' : '尚无可审阅计划。可在上方绑定既有载体并准备目标规划，不需要默认手工拆任务。' : conversational ? '方案仍在加载；你的目标和对话会保留。' : '计划尚未加载完成；不会创建或生成计划。'}</p>}
    {snapshot && <>
      {!goalReady && <p className="mt-3 text-sm text-muted-foreground">请先保存目标并解决目标冲突，再加载最新计划来源。未保存的目标不视为已保存，计划写入与确认已禁用。</p>}
      {snapshot.state === 'stale' && <p className="mt-3 text-sm text-muted-foreground">{conversational ? '目标或项目现状有变化，旧方案不能继续确认。Owner 会按最新信息整理；你也可以直接在对话补充修改。' : '目标或规划来源已变化，不能确认这个旧版本。请比较最新来源，填写修订原因后重新保存为待审阅新版本。'}</p>}
      {editor.conflict && <p className="mt-3 text-sm text-destructive">版本冲突：请加载最新计划并显式比较。本地输入保留，不会自动重试。</p>}
      {editor.requiresReview && <div className="mt-4 rounded-lg bg-muted p-3" aria-label="计划版本比较">
        {conversational ? <p className="text-sm leading-6">项目资料或方案依据已更新，Owner正在核对最新信息。当前方案暂不能确认；请在对话里告诉 Owner 你关心的结果变化。</p> : <><p className="mb-3 text-sm font-medium">服务器最新计划与来源（下方编辑区仍是你的输入）</p><PlanFacts plan={snapshot} />
          {editor.context && <div className="mt-3 space-y-2"><p className="whitespace-pre-wrap text-xs text-muted-foreground">最新目标 v{editor.context.goal.goal.goalVersion}：{editor.context.goal.goal.objective}<br />约束：{editor.context.goal.goal.constraints.join('；') || '无'}<br />目标标准：{editor.context.goal.goal.acceptanceCriteria.join('；') || '无'}<br />最新来源指纹：{editor.context.fingerprint}</p><PlanSourceFacts sources={editor.context.sources} /></div>}
          <button type="button" className={`${buttonClass} mt-3`} disabled={editor.loading || editor.saving || editor.conflict || !editor.loaded} onClick={() => acknowledge(subject)}>已比较最新计划，保留我的输入继续编辑</button></>}
      </div>}
      {conversational && <ConversationPlanSummary plan={snapshot} dirty={editor.dirty} />}
      {!conversational && <div className="mt-4">
      <form className="mt-4 space-y-3" onSubmit={event => { event.preventDefault(); void save(subject) }}>
        <PlanTextField id={`${id}-summary`} label="计划摘要" rows={3} required maxLength={2000} value={editor.summary} onChange={summary => edit({ subject, patch: { summary } })} />
        {(['assumptions', 'risks'] as const).map(key => <PlanTextField key={key} id={`${id}-${key}`} label={key === 'assumptions' ? '计划假设（每行一条）' : '计划风险（每行一条）'} value={editor[key].join('\n')} onChange={value => edit({ subject, patch: { [key]: value.split('\n') } })} />)}
        <div className="min-w-0 space-y-3" aria-label="计划步骤编辑">
          {editor.steps.map((step, index) => <fieldset key={step.key} className="min-w-0 rounded-lg bg-muted/40 p-3">
            <legend className="text-sm font-medium">步骤 {index + 1} · {step.key}</legend>
            <div className="mt-2 space-y-2">{(['title', 'outcome'] as const).map(key => <PlanTextField key={key} id={`${id}-${index}-${key}`} label={key === 'title' ? '步骤标题' : '预期成果'} required maxLength={key === 'title' ? 300 : 2000} value={step[key]} onChange={value => editStep(index, { [key]: value })} />)}</div>
            <div className="mt-2"><PlanTextField id={`${id}-${index}-criteria`} label="步骤完成标准（每行一条）" required value={step.acceptanceCriteria.join('\n')} onChange={value => editStep(index, { acceptanceCriteria: value.split('\n') })} /></div>
            <div className="mt-2"><label className="block text-sm font-medium" htmlFor={`${id}-${index}-role`}>岗位能力建议</label><select id={`${id}-${index}-role`} className={fieldClass} value={step.roleKey} onChange={event => editStep(index, { roleKey: event.target.value })}>
              {!roles.some(role => role.key === step.roleKey) && <option value={step.roleKey}>{step.roleKey}（当前来源不可用，请重新选择）</option>}
              {roles.map(role => <option key={role.key} value={role.key}>{role.name} · v{role.version}</option>)}</select></div>
            <fieldset className="mt-2 space-y-1"><legend className="text-sm font-medium">依赖步骤</legend>
              {editor.steps.filter(other => other.key !== step.key).map(other => <label key={other.key} className="flex items-start gap-2 text-sm">
                <input type="checkbox" className="mt-1 shrink-0" checked={step.dependencies.includes(other.key)} onChange={event => editStep(index, { dependencies: event.target.checked ? [...step.dependencies, other.key] : step.dependencies.filter(key => key !== other.key) })} />
                <span>{other.title}</span>
              </label>)}
              {editor.steps.length === 1 && <p className="text-xs text-muted-foreground">没有其他步骤，无需填写依赖。</p>}
            </fieldset>
            <div className="mt-3 flex flex-wrap items-center gap-2"><button type="button" className={buttonClass} disabled={editor.loading || editor.saving || !canRemoveOwnerPlanStep(editor.steps, step.key)} onClick={() => removeStep({ subject, stepKey: step.key })}>移除此步骤</button><span className="text-xs text-muted-foreground">{editor.steps.length === 1 ? '至少保留一个交付步骤。' : editor.steps.some(other => other.dependencies.includes(step.key)) ? '其他步骤依赖本步骤，请先调整依赖。' : '只调整未保存计划；保存并重新确认后才生效。'}</span></div>
          </fieldset>)}
        </div>
        <PlanTextField id={`${id}-reason`} label="修订原因（必填）" required maxLength={2000} value={editor.changeReason} onChange={changeReason => edit({ subject, patch: { changeReason } })} />
        <div className="flex flex-wrap gap-3"><button type="submit" disabled={!canSave} className="rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-50">{editor.saving ? '正在提交…' : '保存计划新版本'}</button>
          <button type="button" className={buttonClass} disabled={!canConfirm} onClick={() => void confirm(subject)}>确认当前计划内容</button></div>
        <p className="text-xs text-muted-foreground">保存后成为待审阅新版本。确认只针对已保存且未过期的当前版本；不会创建授权、执行或扣费。{editor.dirty ? '当前输入尚未保存。' : '当前编辑内容与已保存快照一致。'}标题、成果、完成标准、当前来源中的岗位和修订原因必填；依赖只能引用其他已有步骤，不能形成循环。</p>
        {editor.archiveWarning && <p role="alert" className="text-sm text-destructive">{editor.archiveWarning}</p>}
      </form></div>}
      {!conversational && <details className="mt-4 rounded-lg bg-muted/40 p-3"><summary className="cursor-pointer text-sm">已保存版本事实</summary><div className="mt-3"><PlanFacts plan={snapshot} /></div></details>}
    </>}
    {!conversational && <details className="mt-4"><summary className="cursor-pointer">方案记录与诊断</summary><div className="mt-3 flex flex-wrap gap-3"><button type="button" className={buttonClass} disabled={editor.loading || editor.saving} onClick={() => void load(subject)}>重新加载计划（保留输入）</button>
      {snapshot && <button type="button" className={buttonClass} disabled={editor.historyLoading} onClick={() => void history(subject)}>{editor.historyLoading ? '正在加载历史…' : '查看计划历史'}</button>}</div>
    {editor.historyError && <p className="mt-2 text-sm text-destructive" role="alert">历史：{editor.historyError}</p>}
    {editor.historyLoaded && <div className="mt-4 max-h-[40vh] space-y-3 overflow-y-auto" aria-label="计划历史"><p className="text-xs text-muted-foreground">历史仅供查阅，不代表当前目标或来源已确认。</p>{editor.history.length ? editor.history.map(plan => <details key={plan.revision} className="rounded-lg bg-muted/40 p-3"><summary className="cursor-pointer text-sm">历史计划 v{plan.planVersion} · {stateLabel(plan.state)}</summary><div className="mt-3"><PlanFacts plan={plan} /></div></details>) : <p className="text-sm">暂无历史版本</p>}</div>}
    </details>}
    {conversational ? (snapshot?.state === 'proposed' || snapshot?.state === 'confirmed') && <ProjectOwnerExecutionConversation projectId={projectId} taskId={taskId} ownerConversation /> : <ProjectOwnerExecutionConversation projectId={projectId} taskId={taskId} />}
  </section>
}

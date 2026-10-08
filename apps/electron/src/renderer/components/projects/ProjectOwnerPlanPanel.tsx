import { useEffect, useId, useMemo } from 'react'
import { atom, useAtomValue, useSetAtom } from 'jotai'
import type { ProjectOwnerPlanDraft, ProjectOwnerPlanSources } from '@gravitas/shared'
import { getOwnerGoalEditor, ownerGoalEditorsAtom } from '../../atoms/project-owner-goal-atoms'
import { acknowledgeOwnerPlanComparisonAtom, canConfirmOwnerPlan, canSaveOwnerPlan, confirmOwnerPlanAtom, editOwnerPlanAtom, getOwnerPlanEditor, loadOwnerPlanAtom, loadOwnerPlanHistoryAtom, ownerPlanEditorsAtom, ownerPlanGoalReady, saveOwnerPlanAtom } from '../../atoms/project-owner-plan-atoms'

const fieldClass = 'mt-1 w-full min-w-0 rounded-md border bg-background p-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
const buttonClass = 'rounded-md bg-muted px-3 py-2 text-sm disabled:opacity-50'
const stateLabel = (state: ProjectOwnerPlanDraft['state']) => state === 'stale' ? '已过期' : state === 'confirmed' ? '已确认内容' : '待审阅'
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
  return <div><label className="block text-sm font-medium" htmlFor={id}>{label}</label>
    <textarea id={id} className={fieldClass} rows={rows} required={required} maxLength={maxLength} value={value} onChange={event => onChange(event.target.value)} />
  </div>
}
function PlanSourceFacts({ sources }: { sources: ProjectOwnerPlanSources }): React.ReactElement {
  return <div className="space-y-1 whitespace-pre-wrap text-xs text-muted-foreground">
    <p>项目来源：{sources.project.title}（{sources.project.id}）<br />{sources.project.description || '无项目描述'}</p>
    {sources.task && <p>任务来源：{sources.task.title}（{sources.task.id}）<br />{sources.task.description || '无任务描述'}</p>}
    <p>岗位来源：{sources.roles.map(role => `${role.name} [${role.key}] v${role.version}`).join('；') || '无'}</p>
    <details><summary className="cursor-pointer">岗位来源校验值（仅标识来源，不是授权）</summary>{sources.roles.map(role => <p key={role.key} className="mt-1">{role.key}<br />source: {role.sourceSha256}<br />rules: {role.rulesSha256}</p>)}</details>
  </div>
}
/** 完整只读事实用于冲突比较和历史；不允许把历史版本恢复成当前确认。 */
function PlanFacts({ plan }: { plan: ProjectOwnerPlanDraft }): React.ReactElement {
  return <div className="space-y-2 whitespace-pre-wrap text-sm">
    <p>计划 v{plan.planVersion} · {stateLabel(plan.state)} · 目标 v{plan.goalVersion} · 人工记录</p>
    <p>{plan.proposal.summary}</p>
    <p>假设：{plan.proposal.assumptions.join('；') || '无'}</p><p>风险：{plan.proposal.risks.join('；') || '无'}</p>
    <ol className="space-y-2">{plan.proposal.steps.map(step => <li key={step.key} className="rounded-md bg-background/60 p-2">
      <p className="font-medium">{step.key} · {step.title}</p><p>成果：{step.outcome}</p><p>完成标准：{step.acceptanceCriteria.join('；')}</p>
      <p>岗位建议：{plan.sources.roles.find(role => role.key === step.roleKey)?.name ?? step.roleKey} · 依赖：{step.dependencies.join('、') || '无'}</p>
    </li>)}</ol>
    <p className="text-xs text-muted-foreground">修订原因：{plan.changeReason} · 本机登记人：{plan.actor}</p>
    <PlanSourceFacts sources={plan.sources} />
    <details className="text-xs text-muted-foreground"><summary className="cursor-pointer">计划与来源指纹</summary><p>context: {plan.contextFingerprint}<br />plan: {plan.planFingerprint}</p></details>
  </div>
}
export function ProjectOwnerPlanPanel({ projectId, taskId }: { projectId: string; taskId?: string }): React.ReactElement {
  const subject = useMemo(() => ({ projectId, ...(taskId === undefined ? {} : { taskId }) }), [projectId, taskId])
  const viewAtom = useMemo(() => atom(get => ({ editor: getOwnerPlanEditor(get(ownerPlanEditorsAtom), subject), goalRevision: getOwnerGoalEditor(get(ownerGoalEditorsAtom), subject).snapshot?.revision, goalReady: ownerPlanGoalReady(get, subject), canSave: canSaveOwnerPlan(get, subject), canConfirm: canConfirmOwnerPlan(get, subject) })), [subject])
  const { editor, goalRevision, goalReady, canSave, canConfirm } = useAtomValue(viewAtom)
  const load = useSetAtom(loadOwnerPlanAtom); const edit = useSetAtom(editOwnerPlanAtom)
  const save = useSetAtom(saveOwnerPlanAtom); const confirm = useSetAtom(confirmOwnerPlanAtom)
  const acknowledge = useSetAtom(acknowledgeOwnerPlanComparisonAtom); const history = useSetAtom(loadOwnerPlanHistoryAtom)
  const id = useId()
  // biome-ignore lint/correctness/useExhaustiveDependencies: 已保存目标版本变化时刷新派生 stale 与来源；未保存目标仍由 atom 门禁阻止写入。
  useEffect(() => { void load(subject) }, [load, subject, goalRevision])
  const snapshot = editor.snapshot
  const roles = editor.context?.sources.roles ?? snapshot?.sources.roles ?? []
  const editStep = (index: number, patch: Partial<(typeof editor.steps)[number]>) => edit({ subject, patch: { steps: editor.steps.map((step, i) => i === index ? { ...step, ...patch } : step) } })
  return <section className="mt-4 min-w-0 rounded-xl bg-card p-5 shadow-sm [overflow-wrap:anywhere]" aria-label={taskId ? '任务计划审阅' : '项目计划审阅'}>
    <div className="flex flex-wrap items-start justify-between gap-3"><h2 className="text-lg font-semibold">Owner 计划审阅</h2>
      <span className="rounded-md bg-muted px-2 py-1 text-xs" role="status">{editor.loading ? '正在加载计划' : snapshot ? `计划 v${snapshot.planVersion} · ${stateLabel(snapshot.state)} · 人工记录` : '尚无计划'}</span></div>
    <p className="mt-2 text-xs leading-relaxed text-muted-foreground">这里只审阅和确认内容，不会调用模型，不会收费或派工。岗位建议不是员工实例，步骤不是已创建任务；旧版本确认不沿用到新版本。</p>
    {editor.error && <p className="mt-3 text-sm text-destructive" role="alert">计划接口：{editor.error}。本地输入仍保留，目标保存不受影响。</p>}
    {!snapshot && <p className="mt-4 text-sm text-muted-foreground">{editor.loaded ? 'Owner主动规划尚未接入。尚无可审阅计划，不需要手工拆任务。' : '计划尚未加载完成；不会创建或生成计划。'}</p>}
    {snapshot && <>
      {!goalReady && <p className="mt-3 text-sm text-muted-foreground">请先保存目标并解决目标冲突，再加载最新计划来源。未保存的目标不视为已保存，计划写入与确认已禁用。</p>}
      {snapshot.state === 'stale' && <p className="mt-3 text-sm text-muted-foreground">目标或规划来源已变化，不能确认这个旧版本。请比较最新来源，填写修订原因后重新保存为待审阅新版本。</p>}
      {editor.conflict && <p className="mt-3 text-sm text-destructive">版本冲突：请加载最新计划并显式比较。本地输入保留，不会自动重试。</p>}
      {editor.requiresReview && <div className="mt-4 rounded-lg bg-muted p-3" aria-label="计划版本比较">
        <p className="mb-3 text-sm font-medium">服务器最新计划与来源（下方编辑区仍是你的输入）</p><PlanFacts plan={snapshot} />
        {editor.context && <div className="mt-3 space-y-2"><p className="whitespace-pre-wrap text-xs text-muted-foreground">最新目标 v{editor.context.goal.goal.goalVersion}：{editor.context.goal.goal.objective}<br />约束：{editor.context.goal.goal.constraints.join('；') || '无'}<br />目标标准：{editor.context.goal.goal.acceptanceCriteria.join('；') || '无'}<br />最新来源指纹：{editor.context.fingerprint}</p><PlanSourceFacts sources={editor.context.sources} /></div>}
        <button type="button" className={`${buttonClass} mt-3`} disabled={editor.loading || editor.saving || editor.conflict || !editor.loaded} onClick={() => acknowledge(subject)}>已比较最新计划，保留我的输入继续编辑</button>
      </div>}
      <form className="mt-4 space-y-3" onSubmit={event => { event.preventDefault(); void save(subject) }}>
        <PlanTextField id={`${id}-summary`} label="计划摘要" rows={3} required maxLength={2000} value={editor.summary} onChange={summary => edit({ subject, patch: { summary } })} />
        {(['assumptions', 'risks'] as const).map(key => <PlanTextField key={key} id={`${id}-${key}`} label={key === 'assumptions' ? '计划假设（每行一条）' : '计划风险（每行一条）'} value={editor[key].join('\n')} onChange={value => edit({ subject, patch: { [key]: value.split('\n') } })} />)}
        <div className="max-h-[50vh] min-w-0 space-y-3 overflow-y-auto overscroll-contain pr-1" aria-label="计划步骤编辑">
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
          </fieldset>)}
        </div>
        <PlanTextField id={`${id}-reason`} label="修订原因（必填）" required maxLength={2000} value={editor.changeReason} onChange={changeReason => edit({ subject, patch: { changeReason } })} />
        <div className="flex flex-wrap gap-3"><button type="submit" disabled={!canSave} className="rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-50">{editor.saving ? '正在提交…' : '保存计划新版本'}</button>
          <button type="button" className={buttonClass} disabled={!canConfirm} onClick={() => void confirm(subject)}>确认当前计划内容</button></div>
        <p className="text-xs text-muted-foreground">保存后成为待审阅新版本。确认只针对已保存且未过期的当前版本；不会创建授权、执行或扣费。{editor.dirty ? '当前输入尚未保存。' : '当前编辑内容与已保存快照一致。'}标题、成果、完成标准、当前来源中的岗位和修订原因必填；依赖只能引用其他已有步骤，不能形成循环。</p>
      </form>
      <details className="mt-4 rounded-lg bg-muted/40 p-3"><summary className="cursor-pointer text-sm">已保存版本事实</summary><div className="mt-3"><PlanFacts plan={snapshot} /></div></details>
    </>}
    <div className="mt-4 flex flex-wrap gap-3"><button type="button" className={buttonClass} disabled={editor.loading || editor.saving} onClick={() => void load(subject)}>重新加载计划（保留输入）</button>
      {snapshot && <button type="button" className={buttonClass} disabled={editor.historyLoading} onClick={() => void history(subject)}>{editor.historyLoading ? '正在加载历史…' : '查看计划历史'}</button>}</div>
    {editor.historyError && <p className="mt-2 text-sm text-destructive" role="alert">历史：{editor.historyError}</p>}
    {editor.historyLoaded && <div className="mt-4 max-h-[40vh] space-y-3 overflow-y-auto" aria-label="计划历史"><p className="text-xs text-muted-foreground">历史仅供查阅，不代表当前目标或来源已确认。</p>{editor.history.length ? editor.history.map(plan => <details key={plan.revision} className="rounded-lg bg-muted/40 p-3"><summary className="cursor-pointer text-sm">历史计划 v{plan.planVersion} · {stateLabel(plan.state)}</summary><div className="mt-3"><PlanFacts plan={plan} /></div></details>) : <p className="text-sm">暂无历史版本</p>}</div>}
  </section>
}

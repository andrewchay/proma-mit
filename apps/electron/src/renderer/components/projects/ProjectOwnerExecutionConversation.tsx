import { useEffect, useId, useMemo } from 'react'
import { atom, useAtom, useAtomValue, useSetAtom, useStore } from 'jotai'
import { getOwnerPlanEditor, ownerPlanEditorsAtom } from '../../atoms/project-owner-plan-atoms'
import { canPreviewOwnerExecution, canSaveOwnerExecution, compareOwnerExecutionAtom, editOwnerExecutionAtom, getOwnerExecutionEditor, loadOwnerExecutionAtom, ownerExecutionEditorsAtom, ownerExecutionPlanReady, previewOwnerExecutionAtom, saveOwnerExecutionAtom, type OwnerExecutionEdit } from '../../atoms/project-owner-execution-atoms'
import { ownerDollarsToMicros, ownerExecutionPeopleReady, ownerExecutionSetupSuggestion, ownerMicrosToDollars } from '../../atoms/owner-execution-setup'
import { PreviewFacts, ProjectOwnerExecutionPreparationPanel, SavedFacts } from './ProjectOwnerExecutionPreparationPanel'
import { ProjectOwnerDeliveryConversation } from './ProjectOwnerDeliveryConversation'

const field = 'mt-2 w-full min-w-0 rounded-lg bg-background p-3 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
const button = 'rounded-lg bg-primary px-4 py-2 text-sm text-primary-foreground disabled:opacity-50'

/** 对话只编排既有暂停准备接口，模型调用、业务授权和派工仍由各自门禁负责。 */
export function ProjectOwnerExecutionConversation({ projectId, taskId }: { projectId: string; taskId?: string }): React.ReactElement {
  const subject = useMemo(() => ({ projectId, ...(taskId === undefined ? {} : { taskId }) }), [projectId, taskId])
  // biome-ignore lint/correctness/useExhaustiveDependencies: 主体切换时重建对话展示状态，业务草案仍按主体保留。
  const localAtom = useMemo(() => atom({ started: false, budget: false, dollars: null as string | null, advanced: false, editing: false }), [subject])
  const [local, setLocal] = useAtom(localAtom)
  const stateAtom = useMemo(() => atom(get => ({
    editor: getOwnerExecutionEditor(get(ownerExecutionEditorsAtom), subject),
    plan: getOwnerPlanEditor(get(ownerPlanEditorsAtom), subject).snapshot,
    ready: ownerExecutionPlanReady(get, subject),
    canPreview: canPreviewOwnerExecution(get, subject), canSave: canSaveOwnerExecution(get, subject),
  })), [subject])
  const { editor: e, plan, ready, canPreview, canSave } = useAtomValue(stateAtom)
  const load = useSetAtom(loadOwnerExecutionAtom); const edit = useSetAtom(editOwnerExecutionAtom)
  const preview = useSetAtom(previewOwnerExecutionAtom); const save = useSetAtom(saveOwnerExecutionAtom)
  const compare = useSetAtom(compareOwnerExecutionAtom)
  const store = useStore()
  const id = useId()
  useEffect(() => { void load(subject) }, [load, subject])
  const busy = e.loading || e.previewing || e.saving
  const patch = (value: OwnerExecutionEdit) => edit({ subject, patch: value })
  const workspaceId = e.workspaceId || e.view?.workspaceRecommendation.workspaceId || ''
  const roles = [...new Set(plan?.proposal.steps.filter(step => e.selectedStepKeys.includes(step.key)).map(step => step.roleKey) ?? [])]
  const peopleReady = Boolean(plan && ownerExecutionPeopleReady(e, plan))
  const employees = e.view?.choices.employees.filter(employee => employee.executionProfile === e.executionKind && employee.workspaceIds.includes(workspaceId)) ?? []
  const selected = roles.map(role => employees.find(employee => employee.id === e.roleAssignments[role]))
  const reviewer = employees.find(employee => employee.id === e.reviewerEmployeeId)
  const config = e.view?.executionConfigurationRecommendation
  const configurationConflict = Boolean(config && [...selected, reviewer].some(employee => employee && (employee.channelId !== config.channelId || employee.modelId !== config.modelId || employee.runtime !== config.runtime)))
  const workspaceConflict = e.view?.workspaceRecommendation.source === 'owner_binding' && workspaceId !== e.view.workspaceRecommendation.workspaceId
  const saved = e.view?.preparation
  const savedCurrent = e.view?.status === 'current' && saved?.source.planFingerprint === plan?.planFingerprint && ready && !e.dirty
  const editing = local.editing && !(savedCurrent && saved?.input.requestId === e.requestId)
  useEffect(() => {
    if (savedCurrent && saved?.input.requestId === e.requestId)
      setLocal(value => ({ ...value, editing: false, started: false, budget: false }))
  }, [savedCurrent, saved?.input.requestId, e.requestId, setLocal])
  const begin = () => {
    if (!plan || !e.view || !ready || !e.loaded || e.requiresReview || busy) return
    patch(ownerExecutionSetupSuggestion(e.view, plan, e))
    setLocal(value => ({ ...value, started: true, editing: true, budget: false }))
  }
  const saveReviewed = async () => {
    const requestId = e.preview?.input.requestId
    await save(subject)
    const current = getOwnerExecutionEditor(store.get(ownerExecutionEditorsAtom), subject)
    if (!requestId || current.error || current.dirty || current.view?.preparation?.input.requestId !== requestId) return
    setLocal(value => ({ ...value, editing: false, started: false, budget: false }))
    await load(subject)
  }
  return <section className="mt-5 min-w-0 space-y-4 rounded-xl bg-muted/30 p-4 shadow-sm [overflow-wrap:anywhere]" aria-label="执行配置对话">
    <h3 className="font-semibold">接下来，安排计划如何执行</h3>
    {!ready && <p className="text-sm text-muted-foreground">先确认当前计划内容，再核对执行配置。</p>}
    {e.error && <p role="alert" className="text-sm text-destructive">{e.error}。输入已保留，请重新读取来源后核对。</p>}
    {e.loading && <p role="status" className="text-sm">正在读取本项目可用配置…</p>}
    {saved && <><p className="text-sm">{savedCurrent ? '已有当前计划的暂停执行准备，可继续核对任务和执行授权。' : '已有暂停准备记录，当前来源是否有效需重新核对。'}</p><SavedFacts record={saved} /></>}
    {ready && (!savedCurrent || editing) && !local.started && <div className="space-y-3 rounded-xl bg-card p-4 shadow-sm">
      <p className="text-sm">我会按已确认计划的全部步骤准备，沿用本项目有效工作区和唯一匹配的岗位配置。请补充独立评审人及本次预算。</p>
      <button type="button" className={button} disabled={!e.loaded || busy || e.requiresReview} onClick={begin}>按已确认计划继续</button>
    </div>}
    {ready && local.started && !local.advanced && (!savedCurrent || editing) && <>
      <div className="space-y-3 rounded-xl bg-card p-4 shadow-sm">
        <h4 className="text-sm font-medium">哪些步骤、由谁执行？</h4>
        <p className="text-xs text-muted-foreground">已填入唯一有效模板匹配；缺失或有多个候选时请明确选择。改变人员或步骤后，配置覆盖确认会失效。</p>
        <fieldset disabled={busy} className="space-y-3">
          <details><summary className="cursor-pointer text-sm">本次范围 · {e.selectedStepKeys.length} 个步骤（可调整）</summary>
            {plan?.proposal.steps.map(step => <label className="mt-2 flex gap-2 text-sm" key={step.key}><input type="checkbox" checked={e.selectedStepKeys.includes(step.key)} onChange={event => patch({ selectedStepKeys: event.target.checked ? [...e.selectedStepKeys, step.key] : e.selectedStepKeys.filter(key => key !== step.key) })} /><span>{step.title} · 成果：{step.outcome} · 依赖：{step.dependencies.join('、') || '无'}</span></label>)}
          </details>
          <label className="block text-sm">执行方式<select className={field} value={e.executionKind} onChange={event => { patch({ executionKind: event.target.value === 'development' ? 'development' : 'controlled', roleAssignments: {}, reviewerEmployeeId: '' }); setLocal(value => ({ ...value, budget: false })) }}><option value="controlled">受控非研发</option><option value="development">研发（需核验 Git 和路径范围）</option></select></label>
          <label className="block text-sm">本项目工作区<select className={field} value={workspaceId} onChange={event => { patch({ workspaceId: event.target.value, roleAssignments: {}, reviewerEmployeeId: '' }); setLocal(value => ({ ...value, budget: false })) }}><option value="">请选择项目已绑定的工作区</option>{e.view?.choices.workspaces.map(workspace => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}</select></label>
          {!e.view?.choices.workspaces.length && <p className="text-sm text-destructive">项目没有可用工作区，请先在规划配置中建立项目绑定，再重新读取来源。</p>}
          {roles.map(role => <label key={role} className="block text-sm">{plan?.sources.roles.find(item => item.key === role)?.name ?? role} · 执行人员<select className={field} value={e.roleAssignments[role] ?? ''} onChange={event => patch({ roleAssignments: { ...e.roleAssignments, [role]: event.target.value } })}><option value="">请补充执行人员</option>{employees.filter(employee => employee.id !== e.reviewerEmployeeId).map(employee => <option key={employee.id} value={employee.id}>{employee.name} · {employee.modelId} {employee.isOwnerCarrier ? '（规划载体，需明确选择）' : ''}</option>)}</select></label>)}
          <label className="block text-sm">谁独立评审成果？<select className={field} value={e.reviewerEmployeeId} onChange={event => patch({ reviewerEmployeeId: event.target.value })}><option value="">请明确选择评审人员</option>{employees.filter(employee => !Object.values(e.roleAssignments).includes(employee.id)).map(employee => <option key={employee.id} value={employee.id}>{employee.name} · {employee.modelId}</option>)}</select></label>
          {!employees.length && <p className="text-sm text-destructive">此工作区没有当前模式可用的员工，请在员工配置中补齐渠道、模型、执行方式及工作区后刷新。</p>}
          {selected.filter(Boolean).length > 0 && <p className="text-xs text-muted-foreground">执行配置：{[...new Set([...selected, reviewer].filter(Boolean).map(employee => `${employee!.channelId} / ${employee!.modelId} / ${employee!.runtime}`))].join('；')}。执行人员与评审人员须使用一致配置。</p>}
          {workspaceConflict && <label className="flex gap-2 text-sm"><input type="checkbox" checked={e.acknowledgeOwnerWorkspaceOverride} onChange={event => patch({ acknowledgeOwnerWorkspaceOverride: event.target.checked })} />我已核对并确认改用与 Owner 规划绑定不同的工作区</label>}
          {configurationConflict && <label className="flex gap-2 text-sm"><input type="checkbox" checked={e.acknowledgeOwnerConfigurationOverride} onChange={event => patch({ acknowledgeOwnerConfigurationOverride: event.target.checked })} />我已核对并确认使用与 Owner 规划绑定不同的执行模型配置</label>}
          <button type="button" className={button} disabled={!peopleReady} onClick={() => setLocal(value => ({ ...value, budget: true }))}>核对完成，设置预算与范围</button>
          {!peopleReady && <p className="text-xs text-muted-foreground">请补齐人员、独立评审和一致配置；步骤必须包含全部依赖。来源失效时需重新读取并比较。</p>}
        </fieldset>
      </div>
      {local.budget && <form className="space-y-3 rounded-xl bg-card p-4 shadow-sm" onSubmit={event => { event.preventDefault(); void preview(subject) }}>
        <h4 className="text-sm font-medium">这次最多投入多少，允许访问哪些资料？</h4>
        <fieldset disabled={busy || !peopleReady} className="space-y-3">
          <label className="block text-sm" htmlFor={`${id}-budget`}>项目共享费用上限（美元 USD）<input id={`${id}-budget`} className={field} inputMode="decimal" value={local.dollars ?? ownerMicrosToDollars(e.maxCostMicrosText)} onChange={event => { setLocal(value => ({ ...value, dollars: event.target.value })); patch({ maxCostMicrosText: ownerDollarsToMicros(event.target.value) }) }} /></label>
          {local.dollars !== null && (!ownerDollarsToMicros(local.dollars) || ownerDollarsToMicros(local.dollars) === '0') && <p className="text-xs text-destructive">请输入大于零、最多六位小数的美元金额。</p>}
          {([['maxRunsText', '最多运行次数'], ['maxReworkText', '最多返工次数'], ['expiresAtText', '有效期至'], ['changeReason', '本次准备说明']] as const).map(([key, label]) => <label className="block text-sm" key={key}>{label}<input className={field} type={key === 'expiresAtText' ? 'datetime-local' : 'text'} inputMode={key.startsWith('max') ? 'numeric' : undefined} value={e[key]} onChange={event => patch({ [key]: event.target.value })} /></label>)}
          {e.executionKind === 'development' && (['targetPathsText', 'allowedPathsText', 'verificationCommandsText'] as const).map(key => <label className="block text-sm" key={key}>{key === 'targetPathsText' ? '目标路径（仓库相对路径，每行一条）' : key === 'allowedPathsText' ? '允许修改的路径（每行一条）' : '验证命令（每行一条）'}<textarea className={field} value={e[key]} onChange={event => patch({ [key]: event.target.value })} /></label>)}
          <fieldset><legend className="text-sm">可用知识资料（由你选择）</legend>{e.view?.choices.knowledgeSources.length ? e.view.choices.knowledgeSources.map(source => <label className="mt-2 flex gap-2 text-sm" key={source.id}><input type="checkbox" checked={e.knowledgeSourceIds.includes(source.id)} onChange={event => patch({ knowledgeSourceIds: event.target.checked ? [...e.knowledgeSourceIds, source.id] : e.knowledgeSourceIds.filter(value => value !== source.id) })} />{source.name}</label>) : <p className="mt-2 text-xs text-muted-foreground">当前项目没有可选知识资料。</p>}</fieldset>
          {e.roleBudgetCapsEnabled && <p className="text-sm">已有岗位单独上限，将一并保留；请在高级设置中调整，并核对下方完整预览。</p>}
          <p className="text-xs text-muted-foreground">这里登记预算方案，不预留额度。独立执行授权仍需后续确认；费用未知时会占用预留额度。运行次数包含执行及评审请求。</p>
          <button type="submit" className={button} disabled={!canPreview}>{e.previewing ? '正在核验来源…' : '生成执行准备摘要'}</button>
        </fieldset>
      </form>}
      {e.preview && peopleReady && <div className="space-y-3"><PreviewFacts preview={e.preview} /><button type="button" className={button} disabled={!canSave} onClick={() => void saveReviewed()}>{e.saving ? '正在保存…' : '确认摘要，保存暂停准备'}</button></div>}
    </>}
    {savedCurrent && !editing && <button type="button" className={button} disabled={busy} onClick={begin}>调整执行准备</button>}
    {e.requiresReview && <div className="space-y-2 rounded-xl bg-card p-4 text-sm shadow-sm">
      <p>来源需要重新核对。当前工作区：{e.view?.choices.workspaces.map(workspace => workspace.name).join('、') || '无可用工作区'}；Owner 模型建议：{config ? `${config.channelId} / ${config.modelId} / ${config.runtime}` : '无有效建议'}。</p>
      <p>已保留你的人员和预算输入。比较已登记快照与当前来源；确认后仍须生成新摘要，旧预览不会沿用。</p>
      <button type="button" className={button} disabled={!e.loaded || busy} onClick={() => compare(subject)}>已核对当前来源，保留输入继续</button>
    </div>}
    <div className="flex flex-wrap gap-3 text-sm"><button type="button" disabled={busy} className="disabled:opacity-50" onClick={() => void load(subject)}>重新读取执行配置</button><button type="button" className="underline underline-offset-4" onClick={() => setLocal(value => ({ ...value, advanced: !value.advanced, dollars: null }))}>{local.advanced ? '返回配置对话' : '执行准备高级设置与历史'}</button></div>
    {local.advanced && <ProjectOwnerExecutionPreparationPanel projectId={projectId} taskId={taskId} showDownstream={false} />}
    {saved && <ProjectOwnerDeliveryConversation projectId={projectId} taskId={taskId} />}
  </section>
}

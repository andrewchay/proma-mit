import { useEffect, useId, useMemo } from 'react'
import { atom, useAtomValue, useSetAtom } from 'jotai'
import { Check, MessageCircle, Sparkles } from 'lucide-react'
import { canSaveOwnerGoal, editOwnerGoalAtom, getOwnerGoalEditor, loadOwnerGoalAtom, ownerGoalEditorsAtom } from '@/atoms/project-owner-goal-atoms'
import { confirmOwnerSetupAtom, editOwnerSetupAtom, getOwnerSetupState, loadOwnerSetupAtom, ownerSetupBindingAvailable, ownerSetupCarriers, ownerSetupModels, ownerSetupStatesAtom, saveOwnerSetupGoalAtom } from '@/atoms/owner-setup-atoms'
import { getOwnerPlanEditor, loadOwnerPlanAtom, ownerPlanEditorsAtom } from '@/atoms/project-owner-plan-atoms'
import { settingsOpenAtom, settingsTabAtom } from '@/atoms/settings-tab'
import { ProjectOwnerGoalPanel } from './ProjectOwnerGoalPanel'
import { ProjectOwnerRuntimePanel } from './ProjectOwnerRuntimePanel'
import { ProjectOwnerPlanPanel } from './ProjectOwnerPlanPanel'

const actionClass = 'rounded-xl bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50'
const choiceClass = 'rounded-xl bg-background p-3 text-left text-sm shadow-sm ring-1 ring-transparent transition-colors hover:bg-primary/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50'

/** 对话由已保存的目标/配置/Run重建；未保存输入沿用按主体隔离的Jotai草案。 */
export function ProjectOwnerConversation({ projectId, taskId }: { projectId: string; taskId?: string }): React.ReactElement {
  const subject = useMemo(() => ({ projectId, ...(taskId ? { taskId } : {}) }), [projectId, taskId])
  const view = useMemo(() => atom(get => ({ goal: getOwnerGoalEditor(get(ownerGoalEditorsAtom), subject), setup: getOwnerSetupState(get(ownerSetupStatesAtom), subject), plan: getOwnerPlanEditor(get(ownerPlanEditorsAtom), subject) })), [subject])
  const { goal, setup, plan } = useAtomValue(view)
  const loadGoal = useSetAtom(loadOwnerGoalAtom), editGoal = useSetAtom(editOwnerGoalAtom), saveGoal = useSetAtom(saveOwnerSetupGoalAtom)
  const loadSetup = useSetAtom(loadOwnerSetupAtom), editSetup = useSetAtom(editOwnerSetupAtom), confirm = useSetAtom(confirmOwnerSetupAtom), loadPlan = useSetAtom(loadOwnerPlanAtom)
  const settingsOpen = useAtomValue(settingsOpenAtom), setSettingsOpen = useSetAtom(settingsOpenAtom), setSettingsTab = useSetAtom(settingsTabAtom)
  const id = useId()
  useEffect(() => { void loadGoal(subject) }, [loadGoal, subject])
  useEffect(() => { if (!settingsOpen) void loadSetup(subject) }, [loadSetup, subject, settingsOpen])
  const goalRevision = goal.snapshot?.revision
  useEffect(() => { if (goalRevision) void loadPlan(subject) }, [loadPlan, subject, goalRevision])
  const needsPlanning = !plan.snapshot || plan.snapshot.state === 'stale'
  const facts = setup.facts
  const models = facts ? ownerSetupModels(facts) : []
  const selectedModel = models.find(item => item.key === setup.modelKey)
  const workspace = facts?.workspaces.find(item => item.id === setup.workspaceId)
  const workspaceBound = Boolean(workspace && facts?.bindings.some(item => item.workspaceId === workspace.id))
  const carriers = facts ? ownerSetupCarriers(facts, setup.modelKey, setup.newWorkspace ? '' : setup.workspaceId) : []
  const selectedCarrier = carriers.find(item => item.id === setup.carrierId) ?? (!setup.carrierId && carriers.length === 1 ? carriers[0] : undefined)
  const configured = Boolean(facts && ownerSetupBindingAvailable(facts) && !setup.dirty)
  const busy = setup.loading || setup.saving || goal.saving
  const goalReady = Boolean(goal.loaded && !goal.loading && goal.snapshot && !goal.dirty && !goal.conflict && !goal.requiresReview)
  const needsWorkspaceApproval = setup.newWorkspace || !workspaceBound
  const canConfirm = goalReady && !busy && !setup.needsRefresh && !!selectedModel && (setup.newWorkspace || !!workspace)
    && (!needsWorkspaceApproval || setup.authorizeWorkspace) && (carriers.length < 2 || !!selectedCarrier)
  const change = (patch: Parameters<typeof editSetup>[0]['patch']) => editSetup({ subject, patch })
  const submitGoal = async () => {
    await saveGoal(subject)
  }
  return <section className="min-w-0 space-y-5 rounded-2xl bg-card p-5 shadow-sm sm:p-6" aria-label="Owner对话式配置">
    <div className="flex items-center gap-3">
      <span className="flex size-10 items-center justify-center rounded-2xl bg-primary/10 text-primary"><MessageCircle className="size-5" aria-hidden="true" /></span>
      <div><h2 className="text-lg font-semibold">和 Owner 一起开始</h2><p className="text-xs text-muted-foreground">描述目标，确认必要选择，然后审阅计划。</p></div>
    </div>
    <div className="max-w-3xl space-y-5">
      <div className="rounded-2xl rounded-tl-sm bg-muted/60 px-4 py-3 text-sm leading-6">
        {taskId ? '这项任务完成后，你希望得到什么结果？' : '你希望这个项目达成什么结果？'}已有的限制和完成标准也可以一起告诉我。
      </div>
      {goal.snapshot && !setup.editingGoal && !goal.dirty ? <div className="ml-6 rounded-2xl rounded-tr-sm bg-primary/10 px-4 py-3">
        <p className="whitespace-pre-wrap text-sm leading-6">{goal.snapshot.goal.objective}</p>
        {goal.snapshot.goal.constraints.length > 0 && <p className="mt-2 whitespace-pre-wrap text-xs text-muted-foreground">约束：{goal.snapshot.goal.constraints.join('；')}</p>}
        {goal.snapshot.goal.acceptanceCriteria.length > 0 && <p className="mt-2 whitespace-pre-wrap text-xs text-muted-foreground">完成标准：{goal.snapshot.goal.acceptanceCriteria.join('；')}</p>}
        <div className="mt-3 flex items-center justify-between text-xs"><span role="status" className="flex items-center gap-1 text-muted-foreground"><Check className="size-3.5" />已保存 v{goal.snapshot.goal.goalVersion}</span><button type="button" className="text-primary underline-offset-4 hover:underline" onClick={() => change({ editingGoal: true })}>调整目标</button></div>
      </div> : <form className="space-y-3" onSubmit={event => { event.preventDefault(); void submitGoal() }}>
        <p role="status" className="text-xs text-muted-foreground">{goal.loading ? '正在加载目标…' : goal.dirty ? '有未保存更改' : goal.snapshot ? '目标已同步' : '尚未保存'}</p>
        <label className="sr-only" htmlFor={`${id}-goal`}>希望达成的目标</label>
        <textarea id={`${id}-goal`} className="w-full resize-y rounded-xl bg-background p-4 text-sm leading-6 shadow-sm ring-1 ring-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" rows={3} maxLength={12000} required disabled={busy || goal.loading}
          placeholder="例如：梳理我们产品的定位，形成可供评审的建议，并解释取舍。"
          value={goal.objective} onChange={event => editGoal({ subject, patch: { objective: event.target.value } })} />
        <details className="rounded-xl bg-muted/30 p-3"><summary className="cursor-pointer text-xs text-muted-foreground">补充约束与完成标准（可选）</summary><div className="mt-3 space-y-3">
          {([{ key: 'constraintsText', label: '必须遵守的约束' }, { key: 'criteriaText', label: '怎样算完成' }] as const).map(item => <label key={item.key} className="block text-xs" htmlFor={`${id}-${item.key}`}>{item.label}<textarea id={`${id}-${item.key}`} className="mt-1 w-full rounded-lg bg-background p-2 text-sm" rows={2} value={goal[item.key]} onChange={event => editGoal({ subject, patch: { [item.key]: event.target.value } })} /></label>)}
        </div></details>
        {taskId && <label className="flex items-start gap-2 text-xs leading-5"><input type="checkbox" className="mt-1" checked={goal.codeSourceAccess === 'bound_workspace'} onChange={event => editGoal({ subject, patch: { codeSourceAccess: event.target.checked ? 'bound_workspace' : 'none' } })} />允许在当前绑定工作区检索有限源码片段；片段将在单次规划费用确认后发送给所选模型。</label>}
        {goal.error && <div className="space-y-2"><p role="alert" className="text-sm text-destructive">{goal.error}</p><button type="button" className="text-sm text-primary underline" disabled={busy || goal.loading} onClick={() => void loadGoal(subject)}>重新读取目标（保留输入）</button></div>}
        {(goal.conflict || goal.requiresReview) && <ProjectOwnerGoalPanel projectId={projectId} taskId={taskId} includePlanningPanels={false} />}
        <div className="flex flex-wrap items-center gap-3"><button className={actionClass} type="submit" disabled={!canSaveOwnerGoal(goal) || busy}>保存目标，继续</button><span className="text-xs text-muted-foreground">本地保存，不收费。</span></div>
      </form>}
      {goalReady && <>
        <div className="space-y-3 rounded-2xl rounded-tl-sm bg-muted/60 p-4">
          <p className="text-sm leading-6">{configured ? '可以沿用这个项目已确认的规划配置。' : '目标已保存。接下来确认规划模型和可使用的工作区，我会复用匹配的现有配置。'}</p>
          {setup.loading && <p role="status" className="text-xs text-muted-foreground">正在核对项目配置…</p>}
          {setup.error && <p role="alert" className="text-sm text-destructive">{setup.error}</p>}
          {(!facts || setup.needsRefresh) && <button type="button" className="text-sm text-primary underline underline-offset-4" disabled={busy} onClick={() => void loadSetup(subject)}>重新读取可用配置</button>}
          {facts && !setup.loading && <>
            {configured && !setup.editingConfiguration && <div className="rounded-xl bg-background/70 p-3 text-sm"><p>{selectedModel?.label} · {workspace?.name}</p><p className="mt-1 text-xs text-muted-foreground">来源：本项目已确认配置与工作区授权</p><button type="button" className="mt-2 text-xs text-primary underline underline-offset-4" disabled={busy} onClick={() => change({ editingConfiguration: true })}>调整规划配置</button></div>}
            {(!configured || setup.editingConfiguration) && <><fieldset disabled={busy} className="space-y-2"><legend className="text-sm font-medium">用哪个模型规划？</legend>
              {!models.length && <div className="space-y-2"><p className="text-sm text-muted-foreground">尚无启用的模型。添加模型后会回到这里核对；已保存的目标会保留。</p><button type="button" className="text-sm text-primary underline underline-offset-4" onClick={() => { setSettingsTab('channels'); setSettingsOpen(true) }}>配置模型供应商</button></div>}
              <div className="grid gap-2 sm:grid-cols-2">{models.map(model => <button type="button" key={model.key} aria-pressed={setup.modelKey === model.key} className={`${choiceClass} ${setup.modelKey === model.key ? 'bg-primary/10 ring-primary/40' : ''}`} onClick={() => change({ modelKey: model.key })}>{model.label}{setup.modelKey === model.key && <Check className="ml-2 inline size-3.5 text-primary" aria-hidden="true" />}</button>)}</div>
            </fieldset>
            <fieldset disabled={busy} className="space-y-2"><legend className="text-sm font-medium">可以使用哪个工作区？</legend>
              <div className="flex flex-wrap gap-2">{facts.workspaces.filter(item => facts.bindings.some(binding => binding.workspaceId === item.id)).map(item => <button key={item.id} type="button" aria-pressed={!setup.newWorkspace && setup.workspaceId === item.id} className={`${choiceClass} ${!setup.newWorkspace && setup.workspaceId === item.id ? 'bg-primary/10 ring-primary/40' : ''}`} onClick={() => change({ workspaceId: item.id, newWorkspace: false })}>{item.name}<span className="mt-1 block text-xs text-muted-foreground">项目已授权</span></button>)}
                <button type="button" aria-pressed={setup.newWorkspace} className={`${choiceClass} ${setup.newWorkspace ? 'bg-primary/10 ring-primary/40' : ''}`} onClick={() => change({ workspaceId: '', newWorkspace: true })}>新建独立工作区<span className="mt-1 block text-xs text-muted-foreground">由应用管理，无需填写路径</span></button>
              </div>
              <details><summary className="cursor-pointer text-xs text-muted-foreground">选择其他已有工作区并授权</summary><div className="mt-2 flex flex-wrap gap-2">{facts.workspaces.filter(item => !facts.bindings.some(binding => binding.workspaceId === item.id)).map(item => <button key={item.id} type="button" aria-pressed={!setup.newWorkspace && setup.workspaceId === item.id} className={`${choiceClass} ${!setup.newWorkspace && setup.workspaceId === item.id ? 'bg-primary/10 ring-primary/40' : ''}`} onClick={() => change({ workspaceId: item.id, newWorkspace: false })}>{item.name}{item.rootPath && <span className="mt-1 block break-all text-xs text-muted-foreground">{item.rootPath}</span>}</button>)}</div></details>
              {workspace && !workspaceBound && <p className="text-xs">选中：{workspace.name}{workspace.rootPath ? ` · ${workspace.rootPath}` : ''}</p>}
              {needsWorkspaceApproval && (workspace || setup.newWorkspace) && <label className="flex items-start gap-2 rounded-lg bg-amber-500/10 p-3 text-xs leading-5"><input type="checkbox" className="mt-1" checked={setup.authorizeWorkspace} onChange={event => change({ authorizeWorkspace: event.target.checked })} />允许此项目使用{setup.newWorkspace ? '新建的独立工作区' : `“${workspace?.name}”工作区`}。规划可使用其中已授权的上下文；业务执行仍须另行授权。</label>}
            </fieldset>
            {carriers.length > 1 && <fieldset disabled={busy} className="space-y-2"><legend className="text-sm font-medium">这个组合有多个现有配置，要沿用哪一个？</legend><div className="flex flex-wrap gap-2">{carriers.map(carrier => <button key={carrier.id} type="button" aria-pressed={setup.carrierId === carrier.id} className={`${choiceClass} ${setup.carrierId === carrier.id ? 'ring-primary/40' : ''}`} onClick={() => change({ carrierId: carrier.id })}>{carrier.name}</button>)}</div></fieldset>}
            {selectedModel && (workspace || setup.newWorkspace) && <p className="text-xs leading-5 text-muted-foreground">{selectedCarrier ? `沿用“${selectedCarrier.name}”的受控规划配置。` : carriers.length === 0 ? '确认后会为这个项目创建 safe 权限的 AI SDK 受控规划员工，不必先去团队页配置。' : '请明确选择现有配置。'}配置适用于项目及其任务；不会启用或扩大现有员工权限。</p>}
            </>}
            <div className="flex flex-wrap items-center gap-3">{(needsPlanning || !configured) && <button type="button" className={actionClass} disabled={!canConfirm} onClick={() => void confirm(subject)}><Sparkles className="mr-2 inline size-4" aria-hidden="true" />{setup.saving ? '正在核对并准备…' : !needsPlanning ? '确认更新配置' : configured ? (plan.snapshot ? '沿用配置，准备新规划' : '沿用配置，准备规划') : '确认选择，准备规划'}</button>}<button type="button" className="text-xs text-muted-foreground underline underline-offset-4" disabled={busy} onClick={() => void loadSetup(subject)}>刷新可用配置</button></div>
            <p className="text-xs leading-5 text-muted-foreground">这里只保存配置并准备规划。发送目标与已授权资料给模型前，会再次展示范围并单独确认本次费用。</p>
          </>}
        </div>
        {facts?.binding && !setup.saving && <ProjectOwnerRuntimePanel projectId={projectId} taskId={taskId} showConfiguration={false} />}
        {plan.snapshot && <ProjectOwnerPlanPanel projectId={projectId} taskId={taskId} />}
      </>}
    </div>
  </section>
}

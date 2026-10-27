import { OwnerManagementDelegationCard } from './OwnerManagementDelegationCard'
import { OwnerManagementConversation } from './OwnerManagementConversation'
import { useEffect, useId, useMemo, useRef } from 'react'
import { atom, useAtomValue, useSetAtom } from 'jotai'
import { MessageCircle } from 'lucide-react'
import { canSaveOwnerGoal, editOwnerGoalAtom, getOwnerGoalEditor, loadOwnerGoalAtom, ownerGoalEditorsAtom } from '@/atoms/project-owner-goal-atoms'
import { confirmOwnerSetupAtom, editOwnerSetupAtom, getOwnerSetupState, loadOwnerSetupAtom, ownerSetupBindingAvailable, ownerSetupModels, ownerSetupStatesAtom, saveOwnerSetupGoalAtom } from '@/atoms/owner-setup-atoms'
import { getOwnerDelegationEditor, loadOwnerDelegationAtom, ownerDelegationEditorsAtom } from '@/atoms/owner-management-delegation-atoms'
import { getOwnerPlanEditor, loadOwnerPlanAtom, ownerPlanEditorsAtom } from '@/atoms/project-owner-plan-atoms'
import { settingsOpenAtom, settingsTabAtom } from '@/atoms/settings-tab'
import { ProjectOwnerGoalPanel } from './ProjectOwnerGoalPanel'
import { ProjectOwnerPlanPanel } from './ProjectOwnerPlanPanel'
import { OwnerModuleStatus } from './OwnerModuleStatus'
import { ProjectOwnerConversationProgress } from './ProjectOwnerConversationProgress'

const actionClass = 'rounded-xl bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50'
/** 对话由已保存的目标/配置/Run重建；未保存输入沿用按主体隔离的Jotai草案。 */
export function ProjectOwnerConversation({ projectId, taskId }: { projectId: string; taskId?: string }): React.ReactElement {
  const subject = useMemo(() => ({ projectId, ...(taskId ? { taskId } : {}) }), [projectId, taskId])
  const view = useMemo(() => atom(get => ({ goal: getOwnerGoalEditor(get(ownerGoalEditorsAtom), subject), setup: getOwnerSetupState(get(ownerSetupStatesAtom), subject), plan: getOwnerPlanEditor(get(ownerPlanEditorsAtom), subject), delegation: getOwnerDelegationEditor(get(ownerDelegationEditorsAtom), subject) })), [subject])
  const { goal, setup, plan, delegation } = useAtomValue(view)
  const loadGoal = useSetAtom(loadOwnerGoalAtom), editGoal = useSetAtom(editOwnerGoalAtom), saveGoal = useSetAtom(saveOwnerSetupGoalAtom)
  const loadSetup = useSetAtom(loadOwnerSetupAtom), editSetup = useSetAtom(editOwnerSetupAtom), confirm = useSetAtom(confirmOwnerSetupAtom), loadPlan = useSetAtom(loadOwnerPlanAtom)
  const loadDelegation = useSetAtom(loadOwnerDelegationAtom)
  const settingsOpen = useAtomValue(settingsOpenAtom), setSettingsOpen = useSetAtom(settingsOpenAtom), setSettingsTab = useSetAtom(settingsTabAtom)
  const id = useId()
  const autoPreparedGoals = useRef(new Set<string>())
  useEffect(() => { void loadGoal(subject) }, [loadGoal, subject])
  useEffect(() => { if (!settingsOpen) void loadSetup(subject) }, [loadSetup, subject, settingsOpen])
  useEffect(() => { void loadDelegation(subject) }, [loadDelegation, subject])
  const goalRevision = goal.snapshot?.revision
  useEffect(() => { if (goalRevision) void loadPlan(subject) }, [loadPlan, subject, goalRevision])
  const facts = setup.facts
  const models = facts ? ownerSetupModels(facts) : []
  const selectedModel = models.find(item => item.key === setup.modelKey)
  const workspace = facts?.workspaces.find(item => item.id === setup.workspaceId)
  const workspaceBound = Boolean(workspace && facts?.bindings.some(item => item.workspaceId === workspace.id))
  const configured = Boolean(facts && ownerSetupBindingAvailable(facts) && !setup.dirty)
  const busy = setup.loading || setup.saving || goal.saving || delegation.busy
  const goalReady = Boolean(goal.loaded && !goal.loading && goal.snapshot && !goal.dirty && !goal.conflict && !goal.requiresReview)
  const currentGoal = goal.snapshot
  const goalFormOpen = !goal.snapshot || setup.editingGoal || goal.dirty || goal.conflict || goal.requiresReview
  const needsWorkspaceApproval = setup.newWorkspace || !workspaceBound
  const canConfirm = goalReady && !busy && !setup.needsRefresh && !!selectedModel && (setup.newWorkspace || !!workspace)
    && (!needsWorkspaceApproval || setup.authorizeWorkspace)
  const canSubmitGoal = !busy && !goal.loading && !goal.conflict && !goal.requiresReview && canSaveOwnerGoal(goal)
  const showSetupSummary = !configured || setup.editingConfiguration
  const canAutoPrepare = goalReady && Boolean(facts) && !setup.needsRefresh && !setup.dirty && !setup.editingConfiguration
    && !setup.newWorkspace && Boolean(selectedModel && workspace && workspaceBound)
  const autoPrepareKey = `${projectId}:${taskId ?? ''}:${goal.snapshot?.revision ?? 0}`
  useEffect(() => {
    if (!canAutoPrepare || busy || autoPreparedGoals.current.has(autoPrepareKey)) return
    autoPreparedGoals.current.add(autoPrepareKey)
    void confirm(subject)
  }, [autoPrepareKey, busy, canAutoPrepare, confirm, subject])
  const change = (patch: Parameters<typeof editSetup>[0]['patch']) => editSetup({ subject, patch })
  const submitGoal = () => saveGoal(subject)
  return <section className="min-w-0 space-y-5 rounded-2xl bg-card p-5 shadow-sm sm:p-6" aria-label="Owner对话式配置">
    <div className="flex items-center gap-3">
      <span className="flex size-10 items-center justify-center rounded-2xl bg-primary/10 text-primary"><MessageCircle className="size-5" aria-hidden="true" /></span>
      <div><h2 className="text-lg font-semibold">项目 Owner</h2><p className="text-xs text-muted-foreground">告诉我目标和约束，我会与你讨论方案并组织推进。</p></div>
    </div>
    <div className="space-y-5">
      {!goal.snapshot && <div className="rounded-2xl rounded-tl-sm bg-muted/60 px-4 py-3 text-sm leading-6">
        {taskId ? '这项任务完成后，你希望得到什么结果？' : '你希望这个项目达成什么结果？'}已有的限制和完成标准也可以一起告诉我。
      </div>}
      {goal.snapshot && !setup.editingGoal && !goal.dirty && !goal.requiresReview && !goal.conflict && !goalReady ? <div className="ml-6 rounded-2xl rounded-tr-sm bg-primary/10 px-4 py-3">
        <p className="whitespace-pre-wrap text-sm leading-6">{goal.snapshot.goal.objective}</p>
        {goal.snapshot.goal.constraints.length > 0 && <p className="mt-2 whitespace-pre-wrap text-xs text-muted-foreground">约束：{goal.snapshot.goal.constraints.join('；')}</p>}
        {goal.snapshot.goal.acceptanceCriteria.length > 0 && <p className="mt-2 whitespace-pre-wrap text-xs text-muted-foreground">完成标准：{goal.snapshot.goal.acceptanceCriteria.join('；')}</p>}
        <div className="mt-3 flex items-center justify-between gap-3"><button type="button" className="text-xs text-primary underline-offset-4 hover:underline" onClick={() => change({ editingGoal: true })}>调整目标</button><OwnerModuleStatus tone="accent">已保存 · v{goal.snapshot.goal.goalVersion}</OwnerModuleStatus></div>
      </div> : goalFormOpen && <form className="space-y-3" onSubmit={event => { event.preventDefault(); void submitGoal() }}>
        <div className="flex justify-end"><OwnerModuleStatus tone={goal.loading ? 'muted' : goal.dirty ? 'warn' : goal.snapshot ? 'accent' : 'muted'}>{goal.loading ? '正在加载' : goal.dirty ? '有未保存修改' : goal.snapshot ? '已保存' : '未保存'}</OwnerModuleStatus></div>
        <label className="sr-only" htmlFor={`${id}-goal`}>希望达成的目标</label>
        <textarea id={`${id}-goal`} className="w-full resize-y rounded-xl bg-background p-4 text-sm leading-6 shadow-sm ring-1 ring-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" rows={3} maxLength={12000} required disabled={busy || goal.loading}
          placeholder="例如：梳理我们产品的定位，形成可供评审的建议，并解释取舍。"
          value={goal.objective} onChange={event => editGoal({ subject, patch: { objective: event.target.value } })} />
        <details className="rounded-xl bg-muted/30 p-3"><summary className="cursor-pointer text-xs text-muted-foreground">补充约束与完成标准（可选）</summary><div className="mt-3 space-y-3">
          {([{ key: 'constraintsText', label: '必须遵守的约束' }, { key: 'criteriaText', label: '怎样算完成' }] as const).map(item => <label key={item.key} className="block text-xs" htmlFor={`${id}-${item.key}`}>{item.label}<textarea id={`${id}-${item.key}`} className="mt-1 w-full rounded-lg bg-background p-2 text-sm" rows={2} value={goal[item.key]} onChange={event => editGoal({ subject, patch: { [item.key]: event.target.value } })} /></label>)}
        </div></details>
        {taskId && <label className="flex items-start gap-2 text-xs leading-5"><input type="checkbox" className="mt-1" checked={goal.codeSourceAccess === 'bound_workspace'} onChange={event => editGoal({ subject, patch: { codeSourceAccess: event.target.checked ? 'bound_workspace' : 'none' } })} />允许在当前绑定工作区检索与目标相关的有限源码；只会在已确认的项目资料和费用范围内使用。</label>}
        {goal.error && <div className="space-y-2"><p role="alert" className="text-sm text-destructive">{goal.error}</p><button type="button" className="text-sm text-primary underline" disabled={busy || goal.loading} onClick={() => void loadGoal(subject)}>重新读取目标（保留输入）</button></div>}
        {(goal.conflict || goal.requiresReview) && <ProjectOwnerGoalPanel projectId={projectId} taskId={taskId} includePlanningPanels={false} />}
        <div className="flex flex-wrap items-center gap-3"><button className={actionClass} type="submit" disabled={!canSubmitGoal}>{goal.snapshot ? '保存目标修改' : '提交目标'}</button><span className="text-xs text-muted-foreground">这里修改的是项目正式目标，会影响后续方案和执行范围；保存后，当前目标与方案会更新，必要时会请你重新确认。</span></div>
      </form>}
      {goalReady && currentGoal && <OwnerManagementConversation projectId={projectId} taskId={taskId}
        currentFocus={<div className="mt-3 space-y-4">
          <section className="rounded-xl bg-primary/5 p-4" aria-label="当前项目目标">
            <div className="flex items-start justify-between gap-3"><h4 className="text-sm font-semibold">项目目标</h4><div className="flex shrink-0 items-center gap-2"><OwnerModuleStatus tone="accent">已保存 · v{currentGoal.goal.goalVersion}</OwnerModuleStatus><button type="button" className="text-xs text-primary underline-offset-4 hover:underline" onClick={() => change({ editingGoal: true })}>调整目标</button></div></div>
            <p className="mt-2 whitespace-pre-wrap text-sm leading-6">{currentGoal.goal.objective}</p>
            {currentGoal.goal.constraints.length > 0 && <p className="mt-2 text-xs leading-5 text-muted-foreground"><span className="font-medium">约束：</span>{currentGoal.goal.constraints.join('；')}</p>}
            {currentGoal.goal.acceptanceCriteria.length > 0 && <p className="mt-2 text-xs leading-5 text-muted-foreground"><span className="font-medium">完成标准：</span>{currentGoal.goal.acceptanceCriteria.join('；')}</p>}
          </section>
          <ProjectOwnerConversationProgress subject={subject} />
          {plan.snapshot && <ProjectOwnerPlanPanel projectId={projectId} taskId={taskId} conversational />}
        </div>}
        historyFacts={<div className="grid gap-2 sm:grid-cols-2">
          <details className="rounded-xl bg-card p-3 shadow-sm"><summary className="cursor-pointer text-sm font-medium">已确认目标与边界</summary><div className="mt-2 space-y-2 text-xs leading-5 text-muted-foreground"><p><span className="font-medium text-foreground">目标：</span>{currentGoal.goal.objective}</p><p><span className="font-medium text-foreground">必须遵守：</span>{currentGoal.goal.constraints.join('；') || '暂无单独约束'}</p><p><span className="font-medium text-foreground">完成标准：</span>{currentGoal.goal.acceptanceCriteria.join('；') || '尚未单独设定'}</p></div></details>
          <details className="rounded-xl bg-card p-3 shadow-sm"><summary className="cursor-pointer text-sm font-medium">项目资料范围与管理额度</summary><div className="mt-2 space-y-2 text-xs leading-5 text-muted-foreground"><p>资料工作区：{workspace?.name ?? '尚未绑定'}</p><p>Owner与团队共用已确认的管理预算；具体额度和有效期见右侧授权卡。</p><p>发布和对外发送不在当前授权范围内。</p></div></details>
          {plan.snapshot && <details className="rounded-xl bg-card p-3 shadow-sm sm:col-span-2"><summary className="cursor-pointer text-sm font-medium">方案记录 · {plan.snapshot.state === 'confirmed' ? '已确认' : plan.snapshot.state === 'stale' ? '需更新' : '待审阅'}</summary><div className="mt-2 space-y-2 text-xs leading-5 text-muted-foreground"><p>{plan.snapshot.proposal.summary}</p><p><span className="font-medium text-foreground">交付步骤：</span>{plan.snapshot.proposal.steps.map(step => step.title).join('、')}</p></div></details>}
          <div className="rounded-xl bg-card p-3 text-xs leading-5 text-muted-foreground shadow-sm sm:col-span-2">每轮交付、验收意见和后续修改记录会按时间保留在下方对话历史中。</div>
        </div>}>
        {facts?.binding && <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-muted/40 px-4 py-3 text-xs">
          <p>当前 Owner 模型：{facts.binding.modelId}</p>
          <button type="button" className="text-primary underline underline-offset-4" disabled={busy} onClick={() => change({ editingConfiguration: true })}>更换 Owner 模型</button>
        </div>}
        {showSetupSummary && <div className="space-y-3 rounded-2xl rounded-tl-sm bg-muted/60 p-4">
          {setup.error && <p role="alert" className="text-sm text-destructive">{setup.error}</p>}
          {setup.loading && <p role="status" className="text-sm text-muted-foreground">Owner正在检查项目资料与可用能力。</p>}
          {facts && models.length > 0 && <label className="block text-xs">Owner规划模型<select aria-label="Owner规划模型" className="mt-1 w-full rounded-lg bg-background p-2 text-sm" value={setup.modelKey} disabled={busy} onChange={event => change({ modelKey: event.target.value })}><option value="">请选择模型</option>{models.map(model => <option key={model.key} value={model.key}>{model.label}</option>)}</select><span className="mt-1 block text-muted-foreground">默认使用 GLM-5.3-Flash；其他模型需在这里明确选择。开始前还需核对该模型能否受项目预算约束，不支持时会在授权卡说明。</span></label>}
          {facts && !setup.loading && !setup.needsRefresh && !selectedModel && <div className="space-y-2"><p className="text-sm leading-6">{models.length > 0 ? '请选择 Owner规划模型后继续。' : '当前没有可用于规划的已启用 AI 服务。请先添加服务凭据；目标已保留，Owner会接着处理。'}</p>{models.length === 0 && <button type="button" className="text-sm text-primary underline underline-offset-4" onClick={() => { setSettingsTab('channels'); setSettingsOpen(true) }}>添加 AI 服务</button>}</div>}
          {setup.needsRefresh && <button type="button" className="text-sm text-primary underline underline-offset-4" disabled={busy} onClick={() => void loadSetup(subject)}>重新检查</button>}
          {selectedModel && (canAutoPrepare || setup.saving) && <p role="status" className="text-sm leading-6">Owner正在沿用项目已授权的资料范围完成本地准备，不会发送模型请求。</p>}
          {selectedModel && needsWorkspaceApproval && <><p className="text-sm leading-6">为了避免混用其他项目的文件，Owner会为本项目使用独立资料空间。请确认是否允许读取和保存本项目所需资料。</p><label className="flex items-start gap-2 rounded-lg bg-amber-500/10 p-3 text-xs leading-5"><input type="checkbox" className="mt-1" checked={setup.authorizeWorkspace} onChange={event => change({ authorizeWorkspace: event.target.checked })} />允许Owner为本项目建立并使用独立资料空间。业务执行仍须另行授权。</label><button type="button" className={actionClass} disabled={!canConfirm} onClick={() => void confirm(subject)}>确认资料访问并继续</button></>}
          {selectedModel && !needsWorkspaceApproval && !canAutoPrepare && !setup.saving && <button type="button" className={actionClass} disabled={!canConfirm} onClick={() => void confirm(subject)}>{setup.editingConfiguration ? '保存 Owner 模型' : '继续本地准备'}</button>}
          {selectedModel && <p className="text-xs leading-5 text-muted-foreground">Owner会在已确认的项目资料和费用边界内规划；超出范围或缺少授权时，会在这里说明并征求你的决定。</p>}
        </div>}
        {facts?.binding && (setup.editingConfiguration || setup.dirty
          ? <p role="status" className="text-xs text-muted-foreground">请先保存 Owner 模型，再核对项目预算；当前修改尚未生效。</p>
          : <OwnerManagementDelegationCard projectId={projectId} taskId={taskId} />)}
        {goalReady && delegation.view?.state === 'none' && !facts?.binding && <p role="alert" className="rounded-xl bg-amber-500/10 px-4 py-3 text-sm leading-6">Owner提示需要恢复项目管理授权，但当前 Owner 运行配置尚未就绪，因此授权卡暂不可用。请先完成上方“本地准备”；准备完成后，项目总预算与管理范围卡会显示在这里。此提示不会发送模型请求。</p>}
      </OwnerManagementConversation>}
    </div>
  </section>
}

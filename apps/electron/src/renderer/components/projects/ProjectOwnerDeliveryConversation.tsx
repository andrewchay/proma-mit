import { useEffect, useMemo } from 'react'
import { atom, useAtom, useAtomValue, useSetAtom } from 'jotai'
import type { OwnerExecutionDispatchMode } from '@gravitas/shared'
import { getOwnerExecutionEditor, ownerExecutionEditorsAtom, ownerExecutionPlanReady } from '../../atoms/project-owner-execution-atoms'
import { canMaterializeOwnerTasks, compareOwnerTasksAtom, getOwnerTaskEditor, ownerTaskEditorsAtom, previewOwnerTasksAtom, type OwnerTaskEditor } from '../../atoms/project-owner-task-atoms'
import { getOwnerRevalidationEditor, ownerRevalidationEditorsAtom } from '../../atoms/project-owner-execution-revalidation-atoms'
import { getOwnerGrantEditor, ownerGrantEditorsAtom } from '../../atoms/project-owner-execution-grant-atoms'
import { confirmOwnerDeliveryTasksAtom, continueOwnerDeliveryRevalidationAtom, getOwnerDeliveryFlow, launchOwnerDeliveryAtom, loadOwnerDeliveryFlowAtom, ownerDeliveryFlowsAtom } from '../../atoms/owner-delivery-flow-atoms'
import { MaterializationFacts, ProjectOwnerTaskMaterializationPanel } from './ProjectOwnerTaskMaterializationPanel'
import { ProjectOwnerRevalidationPanel } from './ProjectOwnerRevalidationPanel'
import { ProjectOwnerExecutionGrantPanel } from './ProjectOwnerExecutionGrantPanel'
import { ProjectOwnerConversationProgress } from './ProjectOwnerConversationProgress'
import { OwnerModuleStatus } from './OwnerModuleStatus'

const button = 'rounded-xl bg-primary px-4 py-2 text-sm text-primary-foreground disabled:opacity-50'

export function ProjectOwnerManagedDeliverySummary({ preview }: { preview: NonNullable<OwnerTaskEditor['preview']> }): React.ReactElement {
  const { preparation } = preview
  return <div className="space-y-3">
    <ol className="space-y-2 text-sm" aria-label="预期成果">{preview.projections.map(item => <li key={item.stepKey} className="rounded-lg bg-muted/40 p-3"><p className="font-medium">{item.title}</p><p>成果：{item.outcome}</p><p>完成标准：{item.acceptanceCriteria.join('；')}</p></li>)}</ol>
    <p className="text-sm">项目共享预算上限：{(preparation.input.maxCostMicros / 1000000).toLocaleString()} 美元 · 有效期至 {new Date(preparation.input.expiresAt).toLocaleString()}</p>
    <div className="space-y-1 text-xs text-muted-foreground"><p>补充资料范围：{preparation.source.knowledgeSources.map(item => item.name).join('、') || '不额外使用知识资料'}</p>{preparation.source.developmentScope && <p>代码修改限于本次确认的项目范围；需要扩大范围时会先与你商量。</p>}</div>
  </div>
}

/** 从同一权威来源链恢复下一步；默认入口不要求用户理解revision/hash。 */
export function ProjectOwnerDeliveryConversation({ projectId, taskId, managed = false, singleConfirmation = false, ownerConversation = false }: { projectId: string; taskId?: string; managed?: boolean; singleConfirmation?: boolean; ownerConversation?: boolean }): React.ReactElement {
  const subject = useMemo(() => ({ projectId, ...(taskId === undefined ? {} : { taskId }) }), [projectId, taskId])
  // biome-ignore lint/correctness/useExhaustiveDependencies: 切换主体时关闭高级记录。
  const advancedAtom = useMemo(() => atom(false), [subject])
  const [advanced, setAdvanced] = useAtom(advancedAtom)
  // biome-ignore lint/correctness/useExhaustiveDependencies: 切换主体时重置最终确认的选择。
  const launchAtom = useMemo(() => atom({ mode: (managed ? 'autonomous' : 'manual') as OwnerExecutionDispatchMode }), [subject, managed])
  const [launch, setLaunch] = useAtom(launchAtom)
  const view = useMemo(() => atom(get => ({
    flow: getOwnerDeliveryFlow(get(ownerDeliveryFlowsAtom), subject),
    preparation: getOwnerExecutionEditor(get(ownerExecutionEditorsAtom), subject),
    tasks: getOwnerTaskEditor(get(ownerTaskEditorsAtom), subject),
    revalidation: getOwnerRevalidationEditor(get(ownerRevalidationEditorsAtom), subject),
    grant: getOwnerGrantEditor(get(ownerGrantEditorsAtom), subject),
    upstreamReady: ownerExecutionPlanReady(get, subject),
    canConfirm: canMaterializeOwnerTasks(get, subject),
  })), [subject])
  const { flow, preparation, tasks, revalidation, grant, canConfirm, upstreamReady } = useAtomValue(view)
  const load = useSetAtom(loadOwnerDeliveryFlowAtom), confirm = useSetAtom(confirmOwnerDeliveryTasksAtom), resume = useSetAtom(continueOwnerDeliveryRevalidationAtom)
  const compare = useSetAtom(compareOwnerTasksAtom), preview = useSetAtom(previewOwnerTasksAtom)
  const launchFlow = useSetAtom(launchOwnerDeliveryAtom)
  const preparationId = preparation.view?.preparation?.id
  // biome-ignore lint/correctness/useExhaustiveDependencies: 新准备登记后只读恢复下游状态。
  useEffect(() => { if (preparation.loaded && upstreamReady && !preparation.loading) void load(subject) }, [load, subject, preparationId, preparation.loaded, upstreamReady, preparation.loading])
  const record = tasks.view?.materialization
  const samePreparation = Boolean(record && preparation.view?.preparation && record.preview.preparation.id === preparationId && record.preview.preparation.integrityHash === preparation.view.preparation.integrityHash)
  const validation = revalidation.view?.revalidation
  const current = samePreparation && revalidation.loaded && revalidation.view?.status === 'current' && validation?.source.materialization.id === record?.id && validation?.source.materialization.integrityHash === record?.integrityHash
  const existingGrant = grant.loaded && Boolean(grant.grant && (!managed || grant.grant.state === 'active' || grant.grant.state === 'needs_reconcile' || (samePreparation && grant.grant.materializationId === record?.id)))
  const busy = flow.loading || flow.saving || tasks.loading || tasks.saving || tasks.previewing || Boolean(flow.stage)
  const error = flow.error || tasks.error || revalidation.error || grant.error
  const stageLabels: Record<string, string> = { register: '正在登记成果范围…', validate: '正在复核当前边界…', grant_preview: '正在检查开始条件…', grant_confirm: '正在授权并启动…' }
  const launchStageText = flow.stage ? stageLabels[flow.stage] ?? '正在处理…' : ''
  const reviewed = managed ? (tasks.preview ?? (samePreparation ? record?.preview : null)) : tasks.preview
  const launchable = managed ? Boolean(singleConfirmation && reviewed && !existingGrant && upstreamReady && preparation.loaded && !preparation.dirty && !preparation.requiresReview && !preparation.loading && !preparation.saving) : Boolean(tasks.preview && canConfirm && !existingGrant)
  return <section className="mt-5 min-w-0 space-y-4 rounded-2xl bg-muted/30 p-4 shadow-sm [overflow-wrap:anywhere]" aria-label="任务到交付对话">
    <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-semibold">{managed ? '确认结果与开始' : '把计划推进到可审阅的成果'}</h3>{!managed && <OwnerModuleStatus tone={grant.grant?.state === 'active' ? 'accent' : existingGrant || current ? 'accent' : samePreparation ? 'warn' : 'muted'}>{grant.grant?.state === 'active' ? '授权已生效' : grant.grant ? `授权${grant.grant.state === 'paused' ? '已登记' : '需核对'}` : current ? '已核验待授权' : samePreparation ? '已登记待核验' : '待登记任务'}</OwnerModuleStatus>}</div>
    {!managed && <ol className="flex flex-wrap gap-2 text-xs text-muted-foreground" aria-label="交付流程进度">
      <li className="rounded-lg bg-card px-3 py-2">{samePreparation ? '✓' : '1'} 登记任务</li>
      <li className="rounded-lg bg-card px-3 py-2">{current ? '✓' : '2'} 核验范围</li>
      <li className="rounded-lg bg-card px-3 py-2">{grant.grant?.state === 'active' ? '✓' : '3'} 独立执行授权</li>
      <li className="rounded-lg bg-card px-3 py-2">4 运行与成果反馈</li>
    </ol>}
    {busy && <p role="status" className="text-sm">{launchStageText || (flow.saving ? '正在登记任务并核验执行范围…' : '正在读取当前流程…')}</p>}
    {error && <p role="alert" className="text-sm text-destructive">{error}。{flow.pendingStartIntentId ? '本次确认已安全保存；重试会续接同一范围，应用重启后也会继续核对。' : '已有记录和输入保留；不会自动重试写入或启动模型。'}</p>}
    {managed && !existingGrant && reviewed && !busy && !singleConfirmation && <div className="space-y-3 rounded-xl bg-card p-4 shadow-sm" aria-label="已准备的交付范围">
      <p className="text-sm font-medium">已准备好的交付范围</p>
      <ProjectOwnerManagedDeliverySummary preview={reviewed} />
      <p className="text-xs text-muted-foreground">此处只保留暂停准备，不会授权或启动团队；请在 Owner 对话的结果与范围确认中继续。</p>
    </div>}
    {!existingGrant && launchable && ((!managed && !current && !samePreparation) || (managed && singleConfirmation)) && <div className="space-y-3 rounded-xl bg-card p-4 shadow-sm" aria-label="最终执行确认">
      <p className="text-sm font-medium">{managed ? 'Owner已准备好交付' : '开始前最后核对'}</p>
      <p className="text-sm text-muted-foreground">{managed ? '上方“确认方案并开始执行”是唯一确认入口。确认后Owner会自动组织并启动团队、独立检查成果并在授权内返工；需要新增授权或业务决定时会回到这里与你商量。' : '我已按你确认的范围安排好步骤、人员和预算。继续后我会依次登记任务、核验执行范围并签发执行授权；每步仍有独立校验，失败会停在这里并说明如何续接。'}</p>
      {managed ? <ProjectOwnerManagedDeliverySummary preview={reviewed!} /> : <><ol className="space-y-2 text-sm">{reviewed!.projections.map(item => <li key={item.stepKey} className="rounded-lg bg-muted/40 p-3"><p className="font-medium">{item.title}</p><p>成果：{item.outcome}</p><p>完成标准：{item.acceptanceCriteria.join('；')}</p><p className="text-xs text-muted-foreground">执行:{item.assignee.displayName} · 依赖:{item.dependencies.join('、') || '无'}</p></li>)}</ol><p className="text-sm">共享预算上限：{(reviewed!.preparation.input.maxCostMicros / 1000000).toLocaleString()} 美元 · 最多 {reviewed!.preparation.input.maxRuns} 次运行 / {reviewed!.preparation.input.maxRework} 次返工 · 截止 {new Date(reviewed!.preparation.input.expiresAt).toLocaleString()}</p></>}
      {!managed && <label className="block text-sm">执行方式<select className="mt-1 w-full rounded-lg bg-background p-2 text-sm" value={launch.mode} disabled={busy} onChange={event => setLaunch({ mode: event.target.value as OwnerExecutionDispatchMode })}><option value="manual">授权后逐条确认费用与启动（默认）</option><option value="autonomous">授权后自主调度（需主进程原生确认）</option></select></label>}
      {!managed && launch.mode === 'autonomous' && <p className="text-xs text-destructive">启用后会在额度和冻结范围内后台自动派发；本地费用台账不保证 Provider 最终账单绝不超额。</p>}
      {!managed && launch.mode === 'manual' && <p className="text-xs text-muted-foreground">确认授权不会启动模型；之后每条请求仍需单独确认费用和启动。</p>}
      {!managed && <button type="button" className={button} disabled={busy} onClick={() => void launchFlow({ subject, dispatchMode: launch.mode })}>{flow.stage ? '正在处理…' : '确认安排，登记、核验并签发执行授权'}</button>}
      {!managed && <details className="text-xs"><summary className="cursor-pointer">完整登记范围与现有任务变更</summary><MaterializationFacts preview={reviewed!} /></details>}
      {tasks.requiresReview && <button type="button" className="text-sm text-primary underline" disabled={busy || !tasks.loaded} onClick={() => { compare(subject); void preview(subject) }}>已核对当前任务来源，重新生成登记摘要</button>}
    </div>}
    {!managed && !existingGrant && !current && !samePreparation && !launchable && <div className="space-y-3 rounded-xl bg-card p-4 shadow-sm">
      <p className="text-sm">我已按你确认的范围整理出以下待登记任务。确认后登记为暂停任务，并核验真实任务、人员和依赖；之后仍需你独立授权执行。</p>
      {tasks.preview && <><ol className="space-y-2 text-sm">{tasks.preview.projections.map(item => <li key={item.stepKey} className="rounded-lg bg-muted/40 p-3"><p className="font-medium">{item.title}</p><p>成果：{item.outcome}</p><p>完成标准：{item.acceptanceCriteria.join('；')}</p><p>执行：{item.assignee.displayName} · 依赖：{item.dependencies.join('、') || '无'}</p>{item.previous && <p>现有任务将保留标题/说明，负责人、工作区、状态和范围按下方完整变更核对。</p>}</li>)}</ol><details className="text-xs"><summary className="cursor-pointer">完整登记范围与现有任务变更</summary><MaterializationFacts preview={tasks.preview} /></details></>}
      <button type="button" className={button} disabled={busy || !canConfirm} onClick={() => void confirm(subject)}>确认登记这些任务并核验范围</button>
      {!tasks.preview && !busy && <p className="text-xs text-muted-foreground">暂停准备和计划须为当前版本，且无未保存更改。核对上方来源后可重新读取。</p>}
      {tasks.requiresReview && <button type="button" className="text-sm text-primary underline" disabled={busy || !tasks.loaded} onClick={() => { compare(subject); void preview(subject) }}>已核对当前任务来源，重新生成登记摘要</button>}
    </div>}
    {!managed && samePreparation && <div className="rounded-xl bg-card p-4 text-sm shadow-sm"><p>已登记 {record?.links.length} 项任务，记录与原计划、执行范围相连。</p>{!current && !existingGrant && <><p className="mt-2">任务已保留，执行范围尚需核验。继续时只核验已有任务，不再新建。</p><button type="button" className={`${button} mt-3`} disabled={busy || !tasks.loaded} onClick={() => void resume(subject)}>继续核验已有任务</button></>}</div>}
    {!managed && current && !existingGrant && <p className="rounded-xl bg-primary/10 p-4 text-sm">真实任务、人员和依赖已核验。接下来选择执行方式并查看授权摘要；预算与期限沿用已确认范围。</p>}
    {((!managed && current) || existingGrant) && <ProjectOwnerExecutionGrantPanel projectId={projectId} taskId={taskId} conversational />}
    {managed && !reviewed && !existingGrant && !busy && <p role="status" className="text-sm">执行范围尚需核对，请重新读取摘要；已经登记的任务与记录会保留。</p>}
    {ownerConversation && <ProjectOwnerConversationProgress subject={subject} />}
    {!ownerConversation && <div className="flex flex-wrap gap-3 text-sm"><button type="button" disabled={busy} onClick={() => void load(subject)}>重新读取流程状态</button><button type="button" className="text-muted-foreground underline" onClick={() => setAdvanced(!advanced)}>{advanced ? '收起登记与核验记录' : '登记与核验高级记录'}</button></div>}
    {advanced && !ownerConversation && <><ProjectOwnerTaskMaterializationPanel projectId={projectId} taskId={taskId} /><ProjectOwnerRevalidationPanel projectId={projectId} taskId={taskId} /></>}
  </section>
}

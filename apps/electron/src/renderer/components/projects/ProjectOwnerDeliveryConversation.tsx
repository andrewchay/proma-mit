import { useEffect, useMemo } from 'react'
import { atom, useAtom, useAtomValue, useSetAtom } from 'jotai'
import { getOwnerExecutionEditor, ownerExecutionEditorsAtom, ownerExecutionPlanReady } from '../../atoms/project-owner-execution-atoms'
import { canMaterializeOwnerTasks, compareOwnerTasksAtom, getOwnerTaskEditor, ownerTaskEditorsAtom, previewOwnerTasksAtom } from '../../atoms/project-owner-task-atoms'
import { getOwnerRevalidationEditor, ownerRevalidationEditorsAtom } from '../../atoms/project-owner-execution-revalidation-atoms'
import { getOwnerGrantEditor, ownerGrantEditorsAtom } from '../../atoms/project-owner-execution-grant-atoms'
import { confirmOwnerDeliveryTasksAtom, continueOwnerDeliveryRevalidationAtom, getOwnerDeliveryFlow, loadOwnerDeliveryFlowAtom, ownerDeliveryFlowsAtom } from '../../atoms/owner-delivery-flow-atoms'
import { MaterializationFacts, ProjectOwnerTaskMaterializationPanel } from './ProjectOwnerTaskMaterializationPanel'
import { ProjectOwnerRevalidationPanel } from './ProjectOwnerRevalidationPanel'
import { ProjectOwnerExecutionGrantPanel } from './ProjectOwnerExecutionGrantPanel'

const button = 'rounded-xl bg-primary px-4 py-2 text-sm text-primary-foreground disabled:opacity-50'

/** 从同一权威来源链恢复下一步；默认入口不要求用户理解revision/hash。 */
export function ProjectOwnerDeliveryConversation({ projectId, taskId }: { projectId: string; taskId?: string }): React.ReactElement {
  const subject = useMemo(() => ({ projectId, ...(taskId === undefined ? {} : { taskId }) }), [projectId, taskId])
  // biome-ignore lint/correctness/useExhaustiveDependencies: 切换主体时关闭高级记录。
  const advancedAtom = useMemo(() => atom(false), [subject])
  const [advanced, setAdvanced] = useAtom(advancedAtom)
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
  const preparationId = preparation.view?.preparation?.id
  // biome-ignore lint/correctness/useExhaustiveDependencies: 新准备登记后只读恢复下游状态。
  useEffect(() => { if (preparation.loaded && upstreamReady && !preparation.loading) void load(subject) }, [load, subject, preparationId, preparation.loaded, upstreamReady, preparation.loading])
  const record = tasks.view?.materialization
  const samePreparation = Boolean(record && preparation.view?.preparation && record.preview.preparation.id === preparationId && record.preview.preparation.integrityHash === preparation.view.preparation.integrityHash)
  const validation = revalidation.view?.revalidation
  const current = samePreparation && revalidation.loaded && revalidation.view?.status === 'current' && validation?.source.materialization.id === record?.id && validation?.source.materialization.integrityHash === record?.integrityHash
  const existingGrant = grant.loaded && Boolean(grant.grant)
  const busy = flow.loading || flow.saving || tasks.loading || tasks.saving || tasks.previewing
  const error = flow.error || tasks.error || revalidation.error || grant.error
  return <section className="mt-5 min-w-0 space-y-4 rounded-2xl bg-muted/30 p-4 shadow-sm [overflow-wrap:anywhere]" aria-label="任务到交付对话">
    <h3 className="font-semibold">把计划推进到可审阅的成果</h3>
    <ol className="flex flex-wrap gap-2 text-xs text-muted-foreground" aria-label="交付流程进度">
      <li className="rounded-lg bg-card px-3 py-2">{samePreparation ? '✓' : '1'} 登记任务</li>
      <li className="rounded-lg bg-card px-3 py-2">{current ? '✓' : '2'} 核验范围</li>
      <li className="rounded-lg bg-card px-3 py-2">{grant.grant?.state === 'active' ? '✓' : '3'} 独立执行授权</li>
      <li className="rounded-lg bg-card px-3 py-2">4 运行与成果反馈</li>
    </ol>
    {busy && <p role="status" className="text-sm">{flow.saving ? '正在登记任务并核验执行范围…' : '正在读取当前流程…'}</p>}
    {error && <p role="alert" className="text-sm text-destructive">{error}。已有记录和输入保留；不会自动重试写入或启动模型。</p>}
    {!existingGrant && !current && !samePreparation && <div className="space-y-3 rounded-xl bg-card p-4 shadow-sm">
      <p className="text-sm">我已按你确认的范围整理出以下待登记任务。确认后登记为暂停任务，并核验真实任务、人员和依赖；之后仍需你独立授权执行。</p>
      {tasks.preview && <><ol className="space-y-2 text-sm">{tasks.preview.projections.map(item => <li key={item.stepKey} className="rounded-lg bg-muted/40 p-3"><p className="font-medium">{item.title}</p><p>成果：{item.outcome}</p><p>完成标准：{item.acceptanceCriteria.join('；')}</p><p>执行：{item.assignee.displayName} · 依赖：{item.dependencies.join('、') || '无'}</p>{item.previous && <p>现有任务将保留标题/说明，负责人、工作区、状态和范围按下方完整变更核对。</p>}</li>)}</ol><details className="text-xs"><summary className="cursor-pointer">完整登记范围与现有任务变更</summary><MaterializationFacts preview={tasks.preview} /></details></>}
      <button type="button" className={button} disabled={busy || !canConfirm} onClick={() => void confirm(subject)}>确认登记这些任务并核验范围</button>
      {!tasks.preview && !busy && <p className="text-xs text-muted-foreground">暂停准备和计划须为当前版本，且无未保存更改。核对上方来源后可重新读取。</p>}
      {tasks.requiresReview && <button type="button" className="text-sm text-primary underline" disabled={busy || !tasks.loaded} onClick={() => { compare(subject); void preview(subject) }}>已核对当前任务来源，重新生成登记摘要</button>}
    </div>}
    {samePreparation && <div className="rounded-xl bg-card p-4 text-sm shadow-sm"><p>已登记 {record?.links.length} 项任务，记录与原计划、执行范围相连。</p>{!current && !existingGrant && <><p className="mt-2">任务已保留，执行范围尚需核验。继续时只核验已有任务，不再新建。</p><button type="button" className={`${button} mt-3`} disabled={busy || !tasks.loaded} onClick={() => void resume(subject)}>继续核验已有任务</button></>}</div>}
    {current && !existingGrant && <p className="rounded-xl bg-primary/10 p-4 text-sm">真实任务、人员和依赖已核验。接下来选择执行方式并查看授权摘要；预算与期限沿用已确认范围。</p>}
    {(current || existingGrant) && <ProjectOwnerExecutionGrantPanel projectId={projectId} taskId={taskId} conversational />}
    <div className="flex flex-wrap gap-3 text-sm"><button type="button" disabled={busy} onClick={() => void load(subject)}>重新读取流程状态</button><button type="button" className="text-muted-foreground underline" onClick={() => setAdvanced(!advanced)}>{advanced ? '收起登记与核验记录' : '登记与核验高级记录'}</button></div>
    {advanced && <><ProjectOwnerTaskMaterializationPanel projectId={projectId} taskId={taskId} /><ProjectOwnerRevalidationPanel projectId={projectId} taskId={taskId} /></>}
  </section>
}

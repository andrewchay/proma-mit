import { atom, type Getter, type Setter } from 'jotai'
import type { ProjectOwnerGoalSubject } from '@gravitas/shared'
import { getOwnerExecutionEditor, loadOwnerExecutionAtom, ownerExecutionEditorsAtom } from './project-owner-execution-atoms'
import { canMaterializeOwnerTasks, getOwnerTaskEditor, loadOwnerTasksAtom, compareOwnerTasksAtom, previewOwnerTasksAtom, canPreviewOwnerTasks, materializeOwnerTasksAtom, ownerTaskEditorsAtom } from './project-owner-task-atoms'
import { editOwnerRevalidationAtom, getOwnerRevalidationEditor, loadOwnerRevalidationAtom, ownerRevalidationEditorsAtom, revalidateOwnerExecutionAtom } from './project-owner-execution-revalidation-atoms'
import { getOwnerGrantEditor, loadOwnerGrantAtom, ownerGrantEditorsAtom } from './project-owner-execution-grant-atoms'

interface OwnerDeliveryFlowState { loading: boolean; saving: boolean; error: string }
const empty: OwnerDeliveryFlowState = { loading: false, saving: false, error: '' }
export const ownerDeliveryFlowsAtom = atom(new Map<string, OwnerDeliveryFlowState>())
const key = (subject: ProjectOwnerGoalSubject) => JSON.stringify([subject.projectId, subject.taskId ?? null])
export const getOwnerDeliveryFlow = (entries: ReadonlyMap<string, OwnerDeliveryFlowState>, subject: ProjectOwnerGoalSubject) => entries.get(key(subject)) ?? empty
function update(get: Getter, set: Setter, subject: ProjectOwnerGoalSubject, patch: Partial<OwnerDeliveryFlowState>) {
  const entries = new Map(get(ownerDeliveryFlowsAtom))
  entries.set(key(subject), { ...getOwnerDeliveryFlow(entries, subject), ...patch })
  set(ownerDeliveryFlowsAtom, entries)
}
/** 重开只读取权威链，不登记Task、重验证、发行授权或启动模型。 */
export const loadOwnerDeliveryFlowAtom = atom(null, async (get, set, subject: ProjectOwnerGoalSubject) => {
  const state = getOwnerDeliveryFlow(get(ownerDeliveryFlowsAtom), subject)
  if (state.loading || state.saving) return
  update(get, set, subject, { loading: true, error: '' })
  try {
    await set(loadOwnerTasksAtom, subject)
    // 重新读取后只重建只读摘要；登记仍需用户确认精确新预览，不把加载瞬态当作人工冲突。
    const execution = getOwnerExecutionEditor(get(ownerExecutionEditorsAtom), subject)
    if (execution.loaded && !execution.loading && !execution.saving && !execution.dirty && !execution.requiresReview && execution.view?.status === 'current')
      set(compareOwnerTasksAtom, subject)
    await set(loadOwnerRevalidationAtom, subject)
    await set(loadOwnerGrantAtom, subject)
    const errors = [getOwnerTaskEditor(get(ownerTaskEditorsAtom), subject).error, getOwnerRevalidationEditor(get(ownerRevalidationEditorsAtom), subject).error, getOwnerGrantEditor(get(ownerGrantEditorsAtom), subject).error].filter(Boolean)
    if (errors.length) throw new Error(errors.join('；'))
    if (canPreviewOwnerTasks(get, subject)) {
      await set(previewOwnerTasksAtom, subject)
      const error = getOwnerTaskEditor(get(ownerTaskEditorsAtom), subject).error
      if (error) throw new Error(error)
    }
  } catch (cause) {
    update(get, set, subject, { error: cause instanceof Error ? cause.message : '读取交付流程失败' })
  } finally { update(get, set, subject, { loading: false }) }
})

/** 人工已确认精确Task预览后，一次登记并核验；失败即停，不隐式重试或发行授权。 */
export const confirmOwnerDeliveryTasksAtom = atom(null, async (get, set, subject: ProjectOwnerGoalSubject) => {
  const state = getOwnerDeliveryFlow(get(ownerDeliveryFlowsAtom), subject)
  if (state.loading || state.saving || !canMaterializeOwnerTasks(get, subject)) return
  const preparation = getOwnerExecutionEditor(get(ownerExecutionEditorsAtom), subject).view?.preparation
  const preview = getOwnerTaskEditor(get(ownerTaskEditorsAtom), subject).preview
  if (!preparation || !preview) return
  update(get, set, subject, { saving: true, error: '' })
  try {
    await set(materializeOwnerTasksAtom, subject)
    const tasks = getOwnerTaskEditor(get(ownerTaskEditorsAtom), subject)
    if (tasks.error) throw new Error(tasks.error)
    const record = tasks.view?.materialization
    if (!record || record.input.requestId !== preview.input.requestId || record.preview.previewFingerprint !== preview.previewFingerprint)
      throw new Error('任务登记结果尚未核实，请读取当前记录，不要重复登记')
    await set(loadOwnerTasksAtom, subject)
    await revalidate(get, set, subject, preparation.id, preparation.integrityHash, record.id, record.integrityHash)
  } catch (cause) {
    update(get, set, subject, { error: cause instanceof Error ? cause.message : '任务登记或核验失败' })
  } finally { update(get, set, subject, { saving: false }) }
})

async function revalidate(get: Getter, set: Setter, subject: ProjectOwnerGoalSubject, preparationId: string, preparationHash: string, materializationId: string, materializationHash: string) {
  const grant = getOwnerGrantEditor(get(ownerGrantEditorsAtom), subject).grant
  if (grant && grant.state !== 'paused') throw new Error('已有活动或待对账授权，请先核对并撤权；不会再次核验或扩大授权')
  const preparation = getOwnerExecutionEditor(get(ownerExecutionEditorsAtom), subject)
  const tasks = getOwnerTaskEditor(get(ownerTaskEditorsAtom), subject)
  if (!tasks.loaded || tasks.error || tasks.view?.status !== 'needs_revalidation' || tasks.view.materialization?.id !== materializationId
    || tasks.view.materialization.integrityHash !== materializationHash
    || tasks.view.materialization.preview.preparation.id !== preparationId || tasks.view.materialization.preview.preparation.integrityHash !== preparationHash || preparation.dirty || preparation.loading || preparation.saving
    || preparation.view?.preparation?.id !== preparationId || preparation.view.preparation.integrityHash !== preparationHash)
    throw new Error('登记后的来源已变化，请核对当前记录；已登记任务保留')
  await set(loadOwnerRevalidationAtom, subject)
  const before = getOwnerRevalidationEditor(get(ownerRevalidationEditorsAtom), subject)
  if (!before.loaded || before.error) throw new Error(before.error || '核验来源读取失败')
  if (before.view?.status === 'current' && before.view.revalidation?.source.materialization.integrityHash === materializationHash) return
  if (!before.changeReason.trim()) set(editOwnerRevalidationAtom, { subject, patch: { changeReason: `任务登记后核验：${preparation.view.preparation.input.changeReason}`.slice(0, 1900) } })
  await set(revalidateOwnerExecutionAtom, subject)
  const result = getOwnerRevalidationEditor(get(ownerRevalidationEditorsAtom), subject)
  if (result.error || result.view?.revalidation?.source.materialization.integrityHash !== materializationHash)
    throw new Error(result.error || '任务已登记，执行范围核验尚未完成；请读取后继续核验')
  // 核验推进了policy revision；按权威新版本读取，预算和期限仍由原准备携带。
  await set(loadOwnerExecutionAtom, subject)
  await set(loadOwnerTasksAtom, subject)
  await set(loadOwnerRevalidationAtom, subject)
  await set(loadOwnerGrantAtom, subject)
  const fresh = getOwnerRevalidationEditor(get(ownerRevalidationEditorsAtom), subject)
  if (!fresh.loaded || fresh.view?.status !== 'current') throw new Error(fresh.error || '核验已提交，但当前来源尚未确认有效，请保留记录核查')
}

/** 部分成功后的显式续接只核验已有任务，不再次登记任务。 */
export const continueOwnerDeliveryRevalidationAtom = atom(null, async (get, set, subject: ProjectOwnerGoalSubject) => {
  const state = getOwnerDeliveryFlow(get(ownerDeliveryFlowsAtom), subject)
  if (state.loading || state.saving) return
  const preparation = getOwnerExecutionEditor(get(ownerExecutionEditorsAtom), subject).view?.preparation
  const tasks = getOwnerTaskEditor(get(ownerTaskEditorsAtom), subject).view?.materialization
  if (!preparation || !tasks) return
  update(get, set, subject, { saving: true, error: '' })
  try { await revalidate(get, set, subject, preparation.id, preparation.integrityHash, tasks.id, tasks.integrityHash) }
  catch (cause) { update(get, set, subject, { error: cause instanceof Error ? cause.message : '继续核验失败' }) }
  finally { update(get, set, subject, { saving: false }) }
})

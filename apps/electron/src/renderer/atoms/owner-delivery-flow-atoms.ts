import { atom, type Getter, type Setter } from 'jotai'
import type { ProjectOwnerExecutionLaunchApi, ProjectOwnerGoalSubject } from '@gravitas/shared'
import { getOwnerExecutionEditor, loadOwnerExecutionAtom, previewOwnerExecutionAtom, saveOwnerExecutionAtom, ownerExecutionEditorsAtom, ownerExecutionInput, ownerExecutionPlanReady } from './project-owner-execution-atoms'
import { canMaterializeOwnerTasks, getOwnerTaskEditor, loadOwnerTasksAtom, compareOwnerTasksAtom, previewOwnerTasksAtom, canPreviewOwnerTasks, materializeOwnerTasksAtom, ownerTaskEditorsAtom } from './project-owner-task-atoms'
import { editOwnerRevalidationAtom, getOwnerRevalidationEditor, loadOwnerRevalidationAtom, ownerRevalidationEditorsAtom, revalidateOwnerExecutionAtom } from './project-owner-execution-revalidation-atoms'
import { getOwnerGrantEditor, loadOwnerGrantAtom, ownerGrantEditorsAtom, previewOwnerGrantIssueAtom, confirmOwnerGrantIssueAtom } from './project-owner-execution-grant-atoms'
import { confirmOwnerPlanAtom, getOwnerPlanEditor, loadOwnerPlanAtom, ownerPlanEditorsAtom } from './project-owner-plan-atoms'
import { loadOwnerManagementAtom } from './project-owner-management-atoms'

export type OwnerDeliveryLaunchStage = 'register' | 'validate' | 'grant_preview' | 'grant_confirm' | 'resume'
interface OwnerDeliveryFlowState { loading: boolean; saving: boolean; error: string; stage: OwnerDeliveryLaunchStage | ''; pendingStartIntentId: string | null }
const empty: OwnerDeliveryFlowState = { loading: false, saving: false, error: '', stage: '', pendingStartIntentId: null }
export const ownerDeliveryFlowsAtom = atom(new Map<string, OwnerDeliveryFlowState>())
type TestableOwnerExecutionLaunchApi = Pick<ProjectOwnerExecutionLaunchApi, 'saveOwnerExecutionStartIntent' | 'resumeOwnerExecutionStartIntent'>
export const ownerExecutionLaunchApiAtom = atom<TestableOwnerExecutionLaunchApi | null>(null)
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

/** 用户确认结果与边界后，先持久化确认意图，再由主进程唯一负责执行与恢复。 */
export const reviewOwnerManagedExecutionAtom = atom(null, async (get, set, subject: ProjectOwnerGoalSubject) => {
  const flow = getOwnerDeliveryFlow(get(ownerDeliveryFlowsAtom), subject)
  if (flow.loading || flow.saving || flow.stage) return
  const api = get(ownerExecutionLaunchApiAtom) ?? window.electronAPI.paa.project
  let intentId = flow.pendingStartIntentId
  if (!intentId) {
    const plan = getOwnerPlanEditor(get(ownerPlanEditorsAtom), subject)
    const input = ownerExecutionInput(get, subject, true)
    if (!plan.snapshot || !input || !['proposed', 'confirmed'].includes(plan.snapshot.state)) {
      update(get, set, subject, { error: '方案或执行边界尚未准备好；请核对当前方案与范围' })
      return
    }
    if (!api.saveOwnerExecutionStartIntent) {
      update(get, set, subject, { error: '当前应用缺少启动确认恢复接口，请更新后重试' })
      return
    }
    intentId = input.requestId
    update(get, set, subject, { saving: true, error: '' })
  try {
      const saved = await api.saveOwnerExecutionStartIntent({ ...subject, intentId, expectedGoalRevision: input.expectedGoalRevision,
        expectedPlanRevision: input.expectedPlanRevision, planFingerprint: plan.snapshot.planFingerprint, contextFingerprint: plan.snapshot.contextFingerprint, input })
      if (!saved.ok) throw new Error(saved.error.message)
      update(get, set, subject, { pendingStartIntentId: intentId })
    } catch (cause) {
      update(get, set, subject, { error: cause instanceof Error ? cause.message : '未能保存本次确认，执行尚未开始' })
      return
    } finally { update(get, set, subject, { saving: false }) }
  }
  if (!api.resumeOwnerExecutionStartIntent) {
    update(get, set, subject, { error: '确认已保存；当前应用缺少自动续接接口，请更新后重试' })
    return
  }
  update(get, set, subject, { stage: 'resume', error: '' })
  try {
    const result = await api.resumeOwnerExecutionStartIntent({ ...subject, intentId })
    if (!result.ok) throw new Error(result.error.message)
    if (result.value.projectId !== subject.projectId || (result.value.taskId ?? undefined) !== subject.taskId || result.value.dispatchMode !== 'autonomous')
      throw new Error('Owner启动恢复回执与当前项目不匹配')
    update(get, set, subject, { pendingStartIntentId: null, stage: '' })
    // 确认成功必须立即读回Owner在对话中的回应，避免用户看到对话被清空。
    await set(loadOwnerManagementAtom, subject.projectId)
    // 启动恢复可能确认了待审计划并生成了绑定该确认版本的新准备；同步权威状态，避免页面继续显示旧修订/草稿。
    await set(loadOwnerPlanAtom, subject)
    await set(loadOwnerExecutionAtom, subject)
    await set(loadOwnerDeliveryFlowAtom, subject)
  } catch (cause) {
    update(get, set, subject, { error: cause instanceof Error ? cause.message : '确认已保存；Owner将在应用恢复后继续核对' })
  } finally { update(get, set, subject, { stage: '' }) }
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

/**
 * 最终审阅卡的一次确认：顺序完成登记→核验→授权发行。
 * 每一步仍走原有服务端快照/指纹/预算校验；任何一步失败即停并保留现场，不隐式重试。
 */
export const launchOwnerDeliveryAtom = atom(null, async (get, set, { subject, dispatchMode, managed = false }: { subject: ProjectOwnerGoalSubject; dispatchMode: 'manual' | 'autonomous'; managed?: boolean }) => {
  const state = getOwnerDeliveryFlow(get(ownerDeliveryFlowsAtom), subject)
  // stage 非空即链在执行中；嵌套的登记/核验 atom 会自行管理 saving，这里不再占用，避免被幂等守卫跳过。
  if (state.loading || state.saving || state.stage) return
  if (managed) {
    update(get, set, subject, { error: 'Owner自动启动只允许通过Owner对话中的结果与范围确认' })
    return
  }
  update(get, set, subject, { error: '', stage: 'register' })
  try {
    const execution = getOwnerExecutionEditor(get(ownerExecutionEditorsAtom), subject)
    const preparation = execution.view?.preparation
    if (!preparation) throw new Error('缺少当前计划的暂停执行准备，无法开始执行')
    const tasksBefore = getOwnerTaskEditor(get(ownerTaskEditorsAtom), subject)
    const recordBefore = tasksBefore.view?.materialization
    const samePreparation = Boolean(recordBefore && recordBefore.preview.preparation.id === preparation.id && recordBefore.preview.preparation.integrityHash === preparation.integrityHash)
    if (!samePreparation) {
      if (!canMaterializeOwnerTasks(get, subject)) throw new Error('登记摘要尚未就绪或来源已变化，请重新读取并核对后再开始')
      await set(confirmOwnerDeliveryTasksAtom, subject)
      const flowError = getOwnerDeliveryFlow(get(ownerDeliveryFlowsAtom), subject).error
      if (flowError) throw new Error(flowError)
    } else {
      const revalidation = getOwnerRevalidationEditor(get(ownerRevalidationEditorsAtom), subject)
      const validated = revalidation.loaded && revalidation.view?.status === 'current' && revalidation.view.revalidation?.source.materialization.id === recordBefore!.id
        && revalidation.view.revalidation.source.materialization.integrityHash === recordBefore!.integrityHash
      if (!validated) {
        update(get, set, subject, { stage: 'validate' })
        await set(continueOwnerDeliveryRevalidationAtom, subject)
        const flowError = getOwnerDeliveryFlow(get(ownerDeliveryFlowsAtom), subject).error
        if (flowError) throw new Error(flowError)
      }
    }
    const preparationAfter = getOwnerExecutionEditor(get(ownerExecutionEditorsAtom), subject)
    const revalidationAfter = getOwnerRevalidationEditor(get(ownerRevalidationEditorsAtom), subject)
    const policyRevision = preparationAfter.view?.policyRevision
    const revalidationRevision = revalidationAfter.view?.revision
    const grantBefore = getOwnerGrantEditor(get(ownerGrantEditorsAtom), subject)
    if (grantBefore.grant && grantBefore.grant.state !== 'paused') throw new Error('已有活动或待对账授权，请先核对现有授权；不会重复发行')
    if (policyRevision === null || policyRevision === undefined || revalidationRevision === null || revalidationRevision === undefined)
      throw new Error('执行策略或核验版本未知，不能发行授权；请读取当前来源')
    const input = { requestId: crypto.randomUUID(), expectedRevalidationRevision: revalidationRevision, expectedPolicyRevision: policyRevision, dispatchMode }
    update(get, set, subject, { stage: 'grant_preview' })
    await set(previewOwnerGrantIssueAtom, { subject, input })
    const previewed = getOwnerGrantEditor(get(ownerGrantEditorsAtom), subject)
    if (previewed.error) throw new Error(previewed.error)
    if (!previewed.preview) throw new Error('授权摘要未生成；请核对授权条件后重试')
    if (previewed.preview.blockers.length > 0) throw new Error(`授权被阻断：${previewed.preview.blockers.join('；')}`)
    update(get, set, subject, { stage: 'grant_confirm' })
    await set(confirmOwnerGrantIssueAtom, { subject, input, confirmedFingerprint: previewed.preview.approvalFingerprint })
    const issued = getOwnerGrantEditor(get(ownerGrantEditorsAtom), subject)
    if (issued.error) throw new Error(issued.error)
    if (!issued.grant) throw new Error('授权确认未产生账本行；请读取账本核对当前状态')
    update(get, set, subject, { stage: '' })
    await set(loadOwnerDeliveryFlowAtom, subject)
  } catch (cause) {
    update(get, set, subject, { error: cause instanceof Error ? cause.message : '开始执行失败' })
  } finally { update(get, set, subject, { stage: '' }) }
})

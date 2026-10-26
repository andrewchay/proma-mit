/** 主进程最终启动编排；各步骤独立提交并复核，既有账本负责持久恢复，不另建任务或授权真相。 */
import type { OwnerExecutionGrant, MaterializeOwnerTasksRequest, ProjectOwnerGoalSubject } from '@gravitas/shared'
import * as store from './project-sqlite-store'
import { assertLocalActorEnabled } from './project-owner-plan-service'
import { ownerExecutionHash, ownerExecutionObject, parseOwnerExecutionSubject } from './project-owner-execution-source'
import { materializeOwnerTasks, parseOwnerTaskMaterializationInput } from './project-owner-task-materialization'
import { getOwnerExecutionRevalidation, previewOwnerExecutionRevalidation, saveOwnerExecutionRevalidation } from './project-owner-execution-revalidation'
import { confirmOwnerExecutionGrantIssue, getOwnerExecutionGrant, previewOwnerExecutionGrantIssue } from './project-owner-execution-grant-issue'
import { getPilotPolicy } from './project-pilot-policy'
import { runOwnerAutonomousSchedule } from './project-owner-autonomous-scheduler'

interface LaunchDependencies {
  schedule: (projectId: string) => Promise<void>
}
const production: LaunchDependencies = {
  schedule: async projectId => { await runOwnerAutonomousSchedule(projectId) },
}
const running = new Map<string, { fingerprint: string; promise: Promise<OwnerExecutionGrant> }>()
function request(raw: unknown): MaterializeOwnerTasksRequest {
  const value = ownerExecutionObject(raw, ['projectId', 'taskId', 'input', 'previewFingerprint'])
  const subject = parseOwnerExecutionSubject({ projectId: value.projectId, ...(value.taskId === undefined ? {} : { taskId: value.taskId }) })
  if (typeof value.previewFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(value.previewFingerprint)) throw new Error('执行范围摘要无效，请重新审阅')
  return { ...subject, input: parseOwnerTaskMaterializationInput(value.input), previewFingerprint: value.previewFingerprint }
}
async function launch(input: MaterializeOwnerTasksRequest, dependencies: LaunchDependencies): Promise<OwnerExecutionGrant> {
  const subject = { projectId: input.projectId, ...(input.taskId ? { taskId: input.taskId } : {}) }
  assertLocalActorEnabled()
  if (store.getProjectDb().isTransactionActive()) throw new Error('执行启动不能跨未提交外层事务')
  // 相同请求的材料化回执可重读；缺失或漂移实体不补造。新请求仍重算准确预览。
  const batch = materializeOwnerTasks(subject, input.input, input.previewFingerprint)
  const existingGrant = getOwnerExecutionGrant(subject)
  if (existingGrant) {
    if (existingGrant.state === 'active' && existingGrant.dispatchMode === 'autonomous'
      && existingGrant.materializationId === batch.id && existingGrant.materializationIntegrityHash === batch.integrityHash) {
      // 已确认许可只重唤醒幂等Scheduler，不再次弹框或签发；补偿首次调度失败。
      await dependencies.schedule(subject.projectId)
      return existingGrant
    }
    if (existingGrant.state === 'active' || existingGrant.state === 'needs_reconcile' || existingGrant.materializationId === batch.id)
      throw new Error('已有执行授权或待核对记录，请先核对原授权；不会重复签发或恢复已撤销许可')
    // 已撤权/归档的旧批次不阻塞经重新审阅的新批次；边界服务仍核对旧命令与未知占额。
  }
  let validated = getOwnerExecutionRevalidation(subject)
  const sameBatch = validated.revalidation?.source.materialization.id === batch.id && validated.revalidation.source.materialization.integrityHash === batch.integrityHash
  if (!(sameBatch && validated.status === 'current')) {
    if (sameBatch && validated.status === 'unapplied') throw new Error('已有核验记录尚未一致应用，请保留原件核对')
    const policy = getPilotPolicy(subject.projectId)
    if (!policy || policy.state !== 'paused') throw new Error('执行策略尚未处于可核验状态')
    const revalidationInput = { requestId: `owner-launch-validate:${batch.id}`, expectedRevalidationRevision: validated.revision, expectedMaterializationId: batch.id, expectedMaterializationRevision: batch.revision, expectedMaterializationHash: batch.integrityHash, expectedPolicyRevision: policy.revision, changeReason: 'Owner在最终执行确认前核对已登记任务与边界' }
    const preview = previewOwnerExecutionRevalidation(subject, revalidationInput)
    saveOwnerExecutionRevalidation(subject, revalidationInput, preview.previewFingerprint)
    validated = getOwnerExecutionRevalidation(subject)
  }
  if (validated.status !== 'current' || !validated.revalidation || validated.revalidation.source.materialization.id !== batch.id || validated.revalidation.source.materialization.integrityHash !== batch.integrityHash) throw new Error('任务已保留，执行范围尚未核验完成')
  const policy = getPilotPolicy(subject.projectId)
  if (!policy) throw new Error('执行策略缺失，不能签发许可')
  const grantInput = { requestId: `owner-launch-grant:${batch.id}`, expectedRevalidationRevision: validated.revalidation.revision, expectedPolicyRevision: policy.revision, dispatchMode: 'autonomous' as const }
  const preview = previewOwnerExecutionGrantIssue(subject, grantInput)
  if (preview.blockers.length) throw new Error(`执行暂不能开始：${preview.blockers.join('；')}`)
  // 此组合入口只由对话中的“确认并开始”按钮调用，按钮点击就是本次人工许可。
  // 签发服务仍在同一主进程调用栈内重验冻结来源、策略和预算；不再弹第二个原生确认框。
  const grant = confirmOwnerExecutionGrantIssue(subject, { input: grantInput, preview, confirmedFingerprint: preview.approvalFingerprint })
  await dependencies.schedule(subject.projectId)
  return grant
}
/** 只在本机IPC注册，不能作为模型工具；并发合并不替代持久账本幂等。 */
export async function launchOwnerPreparedExecution(raw: unknown, dependencies: LaunchDependencies = production): Promise<OwnerExecutionGrant> {
  const input = request(raw), fingerprint = ownerExecutionHash(input), prior = running.get(input.projectId)
  if (prior) {
    if (prior.fingerprint !== fingerprint) throw new Error('Owner正在处理另一份执行确认，请等待当前结果')
    return prior.promise
  }
  const promise = launch(input, dependencies)
  running.set(input.projectId, { fingerprint, promise })
  try { return await promise }
  finally { if (running.get(input.projectId)?.promise === promise) running.delete(input.projectId) }
}

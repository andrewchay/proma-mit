import { createHash, randomUUID } from 'node:crypto'
import type {
  NewMediaControlledAction,
  NewMediaExecutionOutcome,
  NewMediaExecutionReceipt,
  NewMediaPlatform,
} from '@gravitas/shared'
import type { NewMediaAuditEntry } from './new-media-audit'
import { appendNewMediaAudit, createNewMediaAuditEntry, listNewMediaAudit } from './new-media-audit'
import {
  ControlledExecutionError,
  ControlledExecutorUnavailableError,
  requireControlledActionExecutor,
} from './new-media-controlled-executor'
import { clearNewMediaRecordsForTests, getNewMediaRecord, listNewMediaRecords } from './new-media-sqlite-store'

export type ControlledActionKind = 'publish' | 'send-reply'
export type ControlledActionStatus = NewMediaControlledAction['status']

export type ControlledActionRequest = NewMediaControlledAction

export interface ControlledActionAuditEntry {
  id: string
  actionId: string
  event: 'requested' | 'approved' | 'simulated' | 'rejected' | 'executing' | 'executed' | 'execution_failed' | 'execution_reconciled' | 'execution_retried'
  actor: string
  createdAt: number
  detail: string
}

const ACTION_KIND = 'controlled-action'
const TRUSTED_LOCAL_ACTOR = 'local-user'

function computeApprovalPayloadHash(action: ControlledActionRequest): string {
  return createHash('sha256').update(JSON.stringify({
    kind: action.kind,
    platform: action.platform,
    targetId: action.targetId,
    accountId: action.accountId ?? null,
    summary: action.summary,
    revision: action.revision ?? 1,
  })).digest('hex')
}

function assertApprovalMatchesCurrentPayload(action: ControlledActionRequest): void {
  if (!action.approvalPayloadHash || action.approvalRevision === undefined) {
    throw new Error('该请求使用旧审批记录，缺少可信载荷绑定；请重新创建并审批')
  }
  if (action.approvalRevision !== (action.revision ?? 1) || action.approvalPayloadHash !== computeApprovalPayloadHash(action)) {
    throw new Error('外发请求内容已变化，原审批失效；请重新审批')
  }
}

/**
 * 进程内执行声明表。
 *
 * 目的：并发调用同一个已批准动作时，只有一个能真正执行。
 * 声明与检查必须在一个同步块内完成（await 之后立即判定并加入），
 * 这样才在单线程事件循环下具备原子性；仅靠状态判断会在并发下失效。
 */
const claimedActions = new Set<string>()

/** 仅供测试与诊断：当前正在执行的动作数。 */
export function getClaimedActionCount(): number {
  return claimedActions.size
}

/** 受控外发审计统一写入 new-media-audit，读取时映射回既有形状。 */
function createAudit(actionId: string, event: ControlledActionAuditEntry['event'], actor: string, detail: string, metadata?: Record<string, unknown>) {
  return createNewMediaAuditEntry({ domain: 'governance', event, actor, subjectId: actionId, detail, metadata })
}

async function persistAction(record: ControlledActionRequest, entry: Promise<NewMediaAuditEntry>): Promise<void> {
  await appendNewMediaAudit(await entry, [{ kind: ACTION_KIND, value: record }])
}

async function requireAction(actionId: string): Promise<ControlledActionRequest> {
  const action = await getNewMediaRecord<ControlledActionRequest>(ACTION_KIND, actionId)
  if (!action) throw new Error('外发请求不存在')
  return action
}

export async function requestControlledAction(input: Pick<ControlledActionRequest, 'kind' | 'platform' | 'targetId' | 'summary'> & { accountId?: string }, requester = 'local-user'): Promise<ControlledActionRequest> {
  if (!input.targetId.trim() || !input.summary.trim()) throw new Error('操作目标和摘要不能为空')
  const action: ControlledActionRequest = {
    id: randomUUID(),
    ...input,
    accountId: input.accountId?.trim() || undefined,
    status: 'pending_approval',
    requestedAt: Date.now(),
    revision: 1,
    attempts: 0,
  }
  await persistAction(action, createAudit(action.id, 'requested', requester, '已创建待审批外发请求；未获批准前不会有任何平台调用。', {
    kind: action.kind,
    platform: action.platform,
  }))
  return action
}

export async function listControlledActions(): Promise<ControlledActionRequest[]> {
  return listNewMediaRecords(ACTION_KIND)
}

/** 只允许可信主进程交互入口调用；Renderer/模型不得提供审批主体。 */
export async function approveControlledAction(actionId: string): Promise<ControlledActionRequest> {
  const current = await requireAction(actionId)
  if (current.status === 'rejected') throw new Error('已拒绝的请求不能批准')
  if (current.status === 'executed' || current.status === 'executing') throw new Error('已执行的请求不能重新批准')
  if (current.status === 'simulated' || current.status === 'approved') return current
  const approved: ControlledActionRequest = {
    ...current,
    status: 'approved',
    approvedAt: Date.now(),
    approvedBy: TRUSTED_LOCAL_ACTOR,
    approvalRevision: current.revision ?? 1,
    approvalPayloadHash: computeApprovalPayloadHash(current),
  }
  await persistAction(approved, createAudit(actionId, 'approved', TRUSTED_LOCAL_ACTOR, '已由可信本地主体批准；等待受控执行，一次批准只允许一次执行。', {
    platform: current.platform,
    approvalRevision: approved.approvalRevision ?? 1,
    approvalPayloadHash: approved.approvalPayloadHash ?? '',
  }))
  return approved
}

/** 只允许可信主进程交互入口调用；拒绝主体固定为本地用户。 */
export async function rejectControlledAction(actionId: string, reason: string): Promise<ControlledActionRequest> {
  const current = await requireAction(actionId)
  if (current.status === 'simulated') throw new Error('已模拟执行的请求不能拒绝')
  if (current.status === 'executed' || current.status === 'executing') throw new Error('已执行的请求不能拒绝')
  if (!reason.trim()) throw new Error('拒绝原因不能为空')
  const rejected: ControlledActionRequest = { ...current, status: 'rejected' }
  await persistAction(rejected, createAudit(actionId, 'rejected', TRUSTED_LOCAL_ACTOR, reason.trim(), { platform: current.platform }))
  return rejected
}

/** 本地模拟路径：只生成模拟回执，明确标记为 simulation，不代表平台结果。 */
export async function simulateControlledAction(actionId: string): Promise<ControlledActionRequest> {
  const current = await requireAction(actionId)
  if (current.status === 'simulated') return current
  if (current.status !== 'approved') throw new Error('外发请求尚未批准，不能执行')
  assertApprovalMatchesCurrentPayload(current)
  const simulated: ControlledActionRequest = {
    ...current,
    status: 'simulated',
    executedAt: Date.now(),
    executionMode: 'simulated',
    simulationReceipt: `simulation:${current.platform}:${current.id}`,
  }
  await persistAction(simulated, createAudit(actionId, 'simulated', 'system:simulation', '已生成模拟平台回执；未发生真实外部发布或消息发送。', {
    platform: current.platform,
    receipt: simulated.simulationReceipt ?? '',
  }))
  return simulated
}

/**
 * 真实执行受控动作。
 *
 * 门控规则（对应 P2-06 的 DoD）：
 * 1. 只有 approved 状态可以进入执行；未批准、已拒绝、已执行都会被拒绝。
 * 2. 执行前先把状态原子改为 executing 并记录尝试号，同一审批因此最多执行一次。
 * 3. 没有注册执行器时（例如微信发布尚未落地）保持 approved 不变并明确报错，
 *    既不消耗审批、也不会退回模拟成功。
 * 4. 失败时按 outcome 分类：unknown 必须人工对账后才允许重试，避免重复发布。
 */
export async function executeControlledAction(actionId: string, actor = 'local-user'): Promise<ControlledActionRequest> {
  const current = await requireAction(actionId)
  // 能力开关（P4-13）：外发能力被 kill switch 关闭时拒绝执行，动作保持原状态。
  const { isCapabilityActive, listCapabilityFlags } = await import('./new-media-feature-flags')
  const flags = await listCapabilityFlags()
  if (!isCapabilityActive({ capability: 'controlled-outbound', platform: current.platform, accountId: current.accountId }, flags)) {
    const decision = (await import('./new-media-feature-flags')).evaluateCapabilityFlag({ capability: 'controlled-outbound', platform: current.platform, accountId: current.accountId }, flags)
    throw new Error(`外发能力当前已被关闭，无法执行：${decision.reason}`)
  }
  if (current.status === 'executed') throw new Error('该请求已执行完成，同一审批不能重复执行')
  if (current.status === 'executing') throw new Error('该请求正在执行中，请等待结果')
  if (current.status === 'simulated') throw new Error('该请求已走本地模拟路径，不能再次真实执行')
  if (current.status === 'rejected') throw new Error('已拒绝的请求不能执行')
  if (current.status === 'failed') {
    // 失败后不能直接再执行：结果未知时必须先对账，否则应走重试入口。
    throw new Error(current.retryRequiresReconciliation
      ? '上次执行结果未知，可能已被平台接受；请先对账确认后再重试'
      : '上次执行已失败，请使用重试入口重新执行')
  }
  if (current.status !== 'approved') throw new Error('外发请求尚未批准，不能执行')
  assertApprovalMatchesCurrentPayload(current)

  // 同步块：判定并占用执行权，防止并发重复执行。
  if (claimedActions.has(actionId)) throw new Error('该请求正在执行中，请等待结果')
  claimedActions.add(actionId)

  let attemptId = ''
  let executor: ReturnType<typeof requireControlledActionExecutor>
  try {
    // 执行器缺失必须在改变状态之前判定，避免白白消耗一次审批。
    executor = requireControlledActionExecutor(current.kind, current.platform)
  } catch (error) {
    claimedActions.delete(actionId)
    throw error
  }

  attemptId = randomUUID()
  const executing: ControlledActionRequest = {
    ...current,
    status: 'executing',
    executionMode: 'live',
    executionAttemptId: attemptId,
    executionStartedAt: Date.now(),
    attempts: (current.attempts ?? 0) + 1,
    failureCode: undefined,
    failureOutcome: undefined,
    retryRequiresReconciliation: undefined,
  }
  await persistAction(executing, createAudit(actionId, 'executing', actor, '已取得该审批的单次执行权，开始调用平台执行器。', {
    platform: current.platform,
    attemptId,
    attempt: executing.attempts,
  }))

  try {
    const receipt = await executor.execute({
      actionId,
      kind: current.kind,
      platform: current.platform,
      targetId: current.targetId,
      accountId: current.accountId,
      summary: current.summary,
      attemptId,
      actor,
    })
    const executed: ControlledActionRequest = {
      ...executing,
      status: 'executed',
      executedAt: Date.now(),
      receipt: normalizeReceipt(receipt, current.platform),
      failureCode: undefined,
      failureOutcome: undefined,
    }
    await persistAction(executed, createAudit(actionId, 'executed', actor, `平台执行器返回结果：${executed.receipt?.summary ?? '已提交'}`, {
      platform: current.platform,
      attemptId,
      externalId: executed.receipt?.externalId ?? '',
      platformStatus: executed.receipt?.platformStatus ?? '',
    }))
    return executed
  } catch (error) {
    const outcome: NewMediaExecutionOutcome = error instanceof ControlledExecutionError ? error.outcome : 'unknown'
    const failureCode = error instanceof ControlledExecutionError ? error.code : 'unexpected_error'
    const failed: ControlledActionRequest = {
      ...executing,
      status: 'failed',
      failureCode,
      failureOutcome: outcome,
      // 结果不确定时禁止直接重试：请求可能已被平台接受。
      retryRequiresReconciliation: outcome === 'unknown',
    }
    await persistAction(failed, createAudit(actionId, 'execution_failed', actor, `执行失败（${outcome}）：${error instanceof Error ? error.message : String(error)}`, {
      platform: current.platform,
      attemptId,
      outcome,
      failureCode,
    }))
    throw error
  } finally {
    claimedActions.delete(actionId)
  }
}

/**
 * 人工对账：确认平台侧是否已经接收过该次外发。
 * 只有对账完成后，结果未知的失败才允许重试。
 */
export async function reconcileControlledExecution(
  actionId: string,
  input: { platformAccepted: boolean; note: string },
): Promise<ControlledActionRequest> {
  const current = await requireAction(actionId)
  if (current.status !== 'failed') throw new Error('只有失败的请求需要对账')
  if (!input.note.trim()) throw new Error('对账说明不能为空')

  const reconciled: ControlledActionRequest = {
    ...current,
    status: input.platformAccepted ? 'executed' : 'failed',
    reconciledAt: Date.now(),
    reconciledBy: TRUSTED_LOCAL_ACTOR,
    retryRequiresReconciliation: input.platformAccepted ? undefined : false,
    receipt: input.platformAccepted
      ? current.receipt ?? {
        platform: current.platform,
        summary: `人工对账确认平台已接收（说明：${input.note.trim()}）`,
        platformStatus: 'accepted_by_platform',
        receivedAt: Date.now(),
      }
      : current.receipt,
  }
  await persistAction(reconciled, createAudit(actionId, 'execution_reconciled', TRUSTED_LOCAL_ACTOR, `已对账：平台${input.platformAccepted ? '已接收' : '未接收'}。${input.note.trim()}`, {
    platform: current.platform,
    platformAccepted: input.platformAccepted,
  }))
  return reconciled
}

/**
 * 重试失败的外发。
 *
 * 仅当上一次失败是 confirmed_failure / not_started，或结果未知但已通过对账确认平台未接收时允许。
 */
export async function retryControlledExecution(actionId: string): Promise<ControlledActionRequest> {
  const current = await requireAction(actionId)
  if (current.status !== 'failed') throw new Error('只有失败的请求可以重试')
  if (current.retryRequiresReconciliation) {
    throw new Error('上次执行结果未知，可能已被平台接受；请先对账确认后再重试，避免重复外发')
  }
  const retried: ControlledActionRequest = { ...current, status: 'approved', retryRequiresReconciliation: undefined }
  await persistAction(retried, createAudit(actionId, 'execution_retried', TRUSTED_LOCAL_ACTOR, '已重置为待执行，将开始新的执行尝试。', {
    platform: current.platform,
    previousFailureCode: current.failureCode ?? '',
    previousOutcome: current.failureOutcome ?? '',
  }))
  return executeControlledAction(actionId, TRUSTED_LOCAL_ACTOR)
}

function normalizeReceipt(receipt: NewMediaExecutionReceipt, platform: NewMediaPlatform): NewMediaExecutionReceipt {
  return {
    platform: receipt.platform ?? platform,
    externalId: receipt.externalId,
    platformStatus: receipt.platformStatus,
    summary: receipt.summary,
    receivedAt: receipt.receivedAt || Date.now(),
    details: receipt.details,
  }
}

export async function getControlledActionAudit(actionId: string): Promise<ControlledActionAuditEntry[]> {
  const entries = await listNewMediaAudit({ domain: 'governance', subjectId: actionId })
  return entries.map((entry) => ({
    id: entry.id,
    actionId: entry.subjectId,
    event: entry.event as ControlledActionAuditEntry['event'],
    actor: entry.actor,
    createdAt: entry.createdAt,
    detail: entry.detail,
  }))
}

export { ControlledExecutionError, ControlledExecutorUnavailableError }

export async function resetControlledActionsForTests(): Promise<void> {
  await clearNewMediaRecordsForTests()
}

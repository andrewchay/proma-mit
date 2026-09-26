import { getPilotPolicy } from './project-pilot-policy'
import { getAgentExecution, getProjectDb } from './project-sqlite-store'
import { cancelLinkedQueuedPilotExecutions, listPilotCommandLinks } from './project-pilot-command-links'
import type { PilotPauseImpact, PilotRunningChoice } from './project-pilot-pause-impact'

interface QueuedTarget { executionId: string; commandId: string }
interface DecisionRow {
  project_id: string
  policy_revision: number
  fingerprint: string
  queued_targets: string
  running_choices: string
  created_at: number
}

export interface PilotPauseDecision {
  projectId: string
  policyRevision: number
  fingerprint: string
  queuedTargets: QueuedTarget[]
  runningChoices: PilotRunningChoice[]
  createdAt: number
}

function fromRow(row: DecisionRow): PilotPauseDecision {
  return { projectId: row.project_id, policyRevision: row.policy_revision, fingerprint: row.fingerprint,
    queuedTargets: JSON.parse(row.queued_targets) as QueuedTarget[],
    runningChoices: JSON.parse(row.running_choices) as PilotRunningChoice[], createdAt: row.created_at }
}

export function getPilotPauseDecision(projectId: string, policyRevision: number): PilotPauseDecision | null {
  const row = getProjectDb().prepare('SELECT * FROM pilot_pause_decisions WHERE project_id = ? AND policy_revision = ?')
    .get(projectId, policyRevision) as DecisionRow | undefined
  return row ? fromRow(row) : null
}

/** 将已校验的用户选择先于策略写入持久化；同版本的不同快照拒绝覆盖。 */
export function recordPilotPauseDecision(preview: PilotPauseImpact, choices: PilotRunningChoice[]): PilotPauseDecision {
  const queuedTargets = preview.queued.map((item) => ({ executionId: item.executionId, commandId: item.pilotCommandId }))
  const existing = getPilotPauseDecision(preview.projectId, preview.policyRevision)
  if (existing) {
    if (existing.fingerprint !== preview.fingerprint
      || JSON.stringify(existing.queuedTargets) !== JSON.stringify(queuedTargets)
      || JSON.stringify(existing.runningChoices) !== JSON.stringify(choices)) {
      throw new Error('同一策略版本已有不同的暂停确认，需人工对账')
    }
    return existing
  }
  const createdAt = Date.now()
  getProjectDb().prepare(`INSERT INTO pilot_pause_decisions
    (project_id, policy_revision, fingerprint, queued_targets, running_choices, created_at)
    VALUES (?, ?, ?, ?, ?, ?)`)
    .run(preview.projectId, preview.policyRevision, preview.fingerprint,
      JSON.stringify(queuedTargets), JSON.stringify(choices), createdAt)
  return { projectId: preview.projectId, policyRevision: preview.policyRevision, fingerprint: preview.fingerprint,
    queuedTargets, runningChoices: choices, createdAt }
}

export interface PilotPauseRecoveryResult {
  state: 'no_decision' | 'not_paused' | 'needs_attention' | 'queue_reconciled'
  cancelledExecutionIds: string[]
  reason?: string
}

/** 仅恢复已持久确认、且策略恰好进入下一暂停版本的排队取消；运行中停止始终留待人工核验。 */
export function recoverPilotPauseQueue(projectId: string, policyRevision: number): PilotPauseRecoveryResult {
  const decision = getPilotPauseDecision(projectId, policyRevision)
  if (!decision) return { state: 'no_decision', cancelledExecutionIds: [] }
  const policy = getPilotPolicy(projectId)
  if (!policy || policy.revision === policyRevision) return { state: 'not_paused', cancelledExecutionIds: [] }
  if (policy.revision !== policyRevision + 1 || policy.state !== 'paused'
    || policy.pauseDecisionFingerprint !== decision.fingerprint) {
    return { state: 'needs_attention', cancelledExecutionIds: [], reason: '策略版本无法对应已确认的暂停' }
  }

  const links = new Map(listPilotCommandLinks(projectId).map((link) => [link.executionId, link]))
  const targets = new Map(decision.queuedTargets.map((target) => [target.executionId, target]))
  const activeLinked = [...links.values()].filter((link) => {
    const execution = getAgentExecution(link.executionId)
    return execution?.status === 'queued' || execution?.status === 'running'
  })
  if (activeLinked.some((link) => !targets.has(link.executionId)
    && !decision.runningChoices.some((choice) => choice.executionId === link.executionId))) {
    return { state: 'needs_attention', cancelledExecutionIds: [], reason: '确认后出现新的 Pilot 执行' }
  }
  const remaining: QueuedTarget[] = []
  for (const target of decision.queuedTargets) {
    const link = links.get(target.executionId)
    const execution = getAgentExecution(target.executionId)
    if (!link || link.commandId !== target.commandId || !execution || execution.projectId !== projectId
      || execution.pilotCommandId !== target.commandId) {
      return { state: 'needs_attention', cancelledExecutionIds: [], reason: '命令归属无法核验' }
    }
    if (execution.status === 'queued' && execution.sessionId === '') remaining.push(target)
    else if (execution.status !== 'cancelled') {
      return { state: 'needs_attention', cancelledExecutionIds: [], reason: '原排队执行已启动或状态不明' }
    }
  }
  try {
    const cancelledExecutionIds = cancelLinkedQueuedPilotExecutions(projectId, remaining)
    if (decision.runningChoices.some((choice) => choice.disposition === 'request_stop')) {
      return { state: 'needs_attention', cancelledExecutionIds, reason: '运行中停止请求需人工核验' }
    }
    return { state: 'queue_reconciled', cancelledExecutionIds }
  } catch {
    return { state: 'needs_attention', cancelledExecutionIds: [], reason: '排队执行状态变化，需重新对账' }
  }
}

/** 启动时逐项目保守对账；单个项目异常不影响其他项目。 */
export function recoverAllPilotPauseQueues(): Array<{ projectId: string; policyRevision: number; result: PilotPauseRecoveryResult }> {
  const rows = getProjectDb().prepare('SELECT project_id, policy_revision FROM pilot_pause_decisions ORDER BY created_at')
    .all() as Array<{ project_id: string; policy_revision: number }>
  return rows.map((row) => {
    try {
      return { projectId: row.project_id, policyRevision: row.policy_revision,
        result: recoverPilotPauseQueue(row.project_id, row.policy_revision) }
    } catch {
      return { projectId: row.project_id, policyRevision: row.policy_revision,
        result: { state: 'needs_attention', cancelledExecutionIds: [], reason: '恢复对账失败' } }
    }
  })
}

import { createHash } from 'node:crypto'
import type { PilotRunningChoice, PilotRunningDisposition } from '@gravitas/shared'
export type { PilotRunningChoice, PilotRunningDisposition } from '@gravitas/shared'
import type { AgentExecution } from './project-types'
import { listAgentExecutionsByProject } from './project-sqlite-store'
import { getPilotPolicy, pausePilotPolicy, type PilotPolicy } from './project-pilot-policy'
import { cancelLinkedQueuedPilotExecutions, listPilotCommandLinks, type PilotCommandLink } from './project-pilot-command-links'
import { cancelAgentExecution } from './agent-employee-service'
import { recordPilotPauseDecision } from './project-pilot-pause-decision'

export interface PilotPauseExecution {
  executionId: string
  taskId: string
  agentId: string
  sessionId: string
  pilotCommandId: string
}

export interface PilotPauseImpact {
  projectId: string
  policyRevision: number
  fingerprint: string
  queued: PilotPauseExecution[]
  running: PilotPauseExecution[]
  mode: 'preview'
}

/** 只读展示候选影响面。真正取消前仍须核验命令归属并做 queued 状态条件更新。 */
export function previewPilotPauseImpact(projectId: string): PilotPauseImpact {
  const policy = getPilotPolicy(projectId)
  if (!policy) throw new Error('项目尚无 Pilot 策略草案')
  return buildPilotPauseImpact(policy, listAgentExecutionsByProject(projectId), listPilotCommandLinks(projectId))
}

export function buildPilotPauseImpact(policy: PilotPolicy, executions: AgentExecution[], links: PilotCommandLink[]): PilotPauseImpact {
  const linkedByExecution = new Map(links.filter((link) => link.projectId === policy.projectId)
    .map((link) => [link.executionId, link]))
  const candidates = executions.filter((execution) => execution.projectId === policy.projectId
    && execution.pilotCommandId && linkedByExecution.get(execution.id)?.commandId === execution.pilotCommandId)
  const project = (status: 'queued' | 'running'): PilotPauseExecution[] => candidates
    .filter((execution) => execution.status === status)
    .map((execution) => ({
      executionId: execution.id,
      taskId: execution.entityId,
      agentId: execution.agentId,
      sessionId: execution.sessionId,
      pilotCommandId: execution.pilotCommandId!,
    }))
    .sort((a, b) => a.executionId.localeCompare(b.executionId))
  const queued = project('queued')
  const running = project('running')
  const fingerprint = createHash('sha256').update(JSON.stringify({
    projectId: policy.projectId, policyRevision: policy.revision, queued, running,
  })).digest('hex')
  return { projectId: policy.projectId, policyRevision: policy.revision, fingerprint, queued, running, mode: 'preview' }
}

/** 确认每条运行中执行都有单独选择；本函数不执行暂停或取消。 */
export function validatePilotPauseChoices(preview: PilotPauseImpact, current: PilotPauseImpact, choices: PilotRunningChoice[]): void {
  if (preview.projectId !== current.projectId || preview.policyRevision !== current.policyRevision
    || preview.fingerprint !== current.fingerprint) {
    throw new Error('暂停影响面已变化，请重新预览并确认')
  }
  const selected = new Map<string, PilotRunningDisposition>()
  for (const choice of choices) {
    if (selected.has(choice.executionId) || (choice.disposition !== 'finish_current' && choice.disposition !== 'request_stop')) {
      throw new Error('运行中任务选择重复或无效')
    }
    selected.set(choice.executionId, choice.disposition)
  }
  if (selected.size !== current.running.length || current.running.some((execution) => !selected.has(execution.executionId))) {
    throw new Error('请逐项选择所有运行中任务的处理方式')
  }
}

export interface PilotPauseConfirmationResult {
  state: 'paused' | 'needs_reconfirmation'
  policyRevision: number
  cancelledExecutionIds: string[]
  stoppedExecutionIds: string[]
  stopRequestedExecutionIds: string[]
  stopUnverifiedExecutionIds: string[]
  latestImpact: PilotPauseImpact
}

/** 内部确认入口。政策先持久暂停，再条件取消排队项；运行中逐项尝试停止，未知结果明确报告。 */
export function confirmPilotPauseImpact(preview: PilotPauseImpact, choices: PilotRunningChoice[]): PilotPauseConfirmationResult {
  const current = previewPilotPauseImpact(preview.projectId)
  validatePilotPauseChoices(preview, current, choices)
  recordPilotPauseDecision(current, choices)
  const paused = pausePilotPolicy(preview.projectId, preview.policyRevision, preview.fingerprint)
  const afterPause = previewPilotPauseImpact(preview.projectId)
  if (JSON.stringify({ queued: current.queued, running: current.running })
    !== JSON.stringify({ queued: afterPause.queued, running: afterPause.running })) {
    return { state: 'needs_reconfirmation', policyRevision: paused.revision, cancelledExecutionIds: [],
      stoppedExecutionIds: [], stopRequestedExecutionIds: [], stopUnverifiedExecutionIds: [], latestImpact: afterPause }
  }

  let cancelledExecutionIds: string[]
  try {
    cancelledExecutionIds = cancelLinkedQueuedPilotExecutions(preview.projectId,
      current.queued.map((item) => ({ executionId: item.executionId, commandId: item.pilotCommandId })))
  } catch {
    return { state: 'needs_reconfirmation', policyRevision: paused.revision, cancelledExecutionIds: [],
      stoppedExecutionIds: [], stopRequestedExecutionIds: [], stopUnverifiedExecutionIds: [], latestImpact: previewPilotPauseImpact(preview.projectId) }
  }

  const stoppedExecutionIds: string[] = []
  const stopRequestedExecutionIds: string[] = []
  const stopUnverifiedExecutionIds: string[] = []
  for (const choice of choices) {
    if (choice.disposition !== 'request_stop') continue
    try {
      const result = cancelAgentExecution(choice.executionId)
      stopRequestedExecutionIds.push(choice.executionId)
      if (result.stopped) stoppedExecutionIds.push(choice.executionId)
      else stopUnverifiedExecutionIds.push(choice.executionId)
    } catch {
      stopUnverifiedExecutionIds.push(choice.executionId)
    }
  }
  return { state: 'paused', policyRevision: paused.revision, cancelledExecutionIds,
    stoppedExecutionIds, stopRequestedExecutionIds, stopUnverifiedExecutionIds, latestImpact: previewPilotPauseImpact(preview.projectId) }
}

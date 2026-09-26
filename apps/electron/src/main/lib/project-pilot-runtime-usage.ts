import { settlePilotCommandUsage, type PilotCommandSettlement } from './project-pilot-budget-ledger'
import { getAgentExecution, getProjectDb } from './project-sqlite-store'

/** Runtime 没有给出可核验 Provider 回执时，显式以 unknown 结算并撤权停等。 */
export function settlePilotExecutionUnknownUsage(
  executionId: string,
  reason: string,
  capturedAt = Date.now(),
): PilotCommandSettlement | null {
  const execution = getAgentExecution(executionId)
  if (!execution?.pilotCommandId) return null
  try {
    if (!execution.sessionId?.trim()) throw new Error('Pilot 终结执行缺少会话，无法记录未知用量')
    const grant = getProjectDb().prepare(`SELECT g.channel_id AS channelId, g.model_id AS modelId
      FROM pilot_commands c JOIN pilot_runtime_grants g ON g.id = c.grant_id AND g.project_id = c.project_id
      WHERE c.id = ? AND c.project_id = ? AND c.execution_id = ?`)
      .get(execution.pilotCommandId, execution.projectId, execution.id) as { channelId: string; modelId: string } | undefined
    if (!grant) throw new Error('Pilot 终结执行缺少冻结授权，无法记录未知用量')
    return settlePilotCommandUsage(execution.pilotCommandId, {
      source: 'unknown',
      executionId: execution.id,
      sessionId: execution.sessionId,
      channelId: grant.channelId,
      modelId: grant.modelId,
      capturedAt,
      reason,
    }, capturedAt)
  } catch (error) {
    // 用量无法入账时也要撤权；破损命令留给恢复对账，不允许继续预留新费用。
    getProjectDb().prepare(`UPDATE pilot_runtime_grants SET state = 'paused'
      WHERE id = (SELECT grant_id FROM pilot_commands WHERE id = ? AND project_id = ?)
        AND state = 'active'`).run(execution.pilotCommandId, execution.projectId)
    throw error
  }
}

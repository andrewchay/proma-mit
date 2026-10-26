/** 只输入项目目标和授权；规划、安排、返工、验收与交付均由真实产品服务推进。 */
import type { OwnerRealChainSmokeReport } from './owner-real-chain-smoke'
import * as store from './project-sqlite-store'
import { getProjectOwnerPlanDraft } from './project-owner-plan-service'
import { startOwnerManagementLoop } from './project-owner-management-loop'
import { getOwnerManagementView, listPendingOwnerManagementEvents } from './project-owner-management-store'
import { runOwnerAutonomousSchedule } from './project-owner-autonomous-scheduler'
import { listOwnerTechnicalReviewEvidence } from './project-owner-technical-review'
import { readOwnerQualityAction } from './project-owner-quality-actions'
import { listDevelopmentValidations } from './development-validation-service'
import { getAgentWorkspace, getAgentWorkspaceCwd } from './agent-workspace-manager'

export async function runOwner2048ProjectSmoke(projectId: string, channelId: string, modelId: string): Promise<OwnerRealChainSmokeReport> {
  const stop = startOwnerManagementLoop()
  const startedAt = Date.now()
  let lastState = '', error: string | undefined
  try {
    const deadline = Date.now() + 12 * 60_000
    while (Date.now() < deadline) {
      const schedule = await runOwnerAutonomousSchedule(projectId)
      const view = getOwnerManagementView(projectId)
      const plan = getProjectOwnerPlanDraft(projectId)
      if (plan?.state === 'confirmed' && view.messages.some(message => message.kind === 'delivery' && message.delivery?.planVersion === plan.planVersion)) break
      const state = `${plan?.state ?? 'planning'}/${schedule.state}/${schedule.nextAction ?? 'none'}`
      if (state !== lastState) { console.log(`[owner-2048] 阶段=${state}`); lastState = state }
      // 已完成的协议拒绝、额度阻断或业务升级不能用另一个项目掩盖；保留本次记录。
      const terminalAttention = view.messages.findLast(message => message.kind === 'attention')
      const live = store.listAgentExecutionsByProject(projectId).some(execution => ['queued', 'running'].includes(execution.status))
      if (!live && terminalAttention && terminalAttention.createdAt >= startedAt
        && Date.now() - terminalAttention.createdAt > 10_000 && listPendingOwnerManagementEvents(projectId).length === 0
        && ['waiting', 'paused', 'stale', 'expired', 'needs_reconcile'].includes(schedule.state)
        && schedule.nextAction !== 'await_owner_quality') {
        error = terminalAttention.content.slice(0, 600)
        break
      }
      await new Promise(resolve => setTimeout(resolve, 2000))
    }
    const result = reportOwner2048Project(projectId, channelId, modelId)
    if (result.deliveryState !== 'delivered') result.error = error ?? '项目未在受控期限内形成已验收交付；保留真实运行与阻断证据'
    return result
  } finally { stop() }
}

function reportOwner2048Project(projectId: string, channelId: string, modelId: string): OwnerRealChainSmokeReport {
  const database = store.getProjectDb()
  const commands = database.prepare(`SELECT id,role,execution_id,grant_id,source_task_id,rework_ordinal,state,actual_cost_micros FROM project_owner_execution_commands
    WHERE project_id=? ORDER BY rowid`).all(projectId) as Array<{ id: string; role: string; execution_id: string | null; grant_id: string; source_task_id: string; rework_ordinal: number; state: string; actual_cost_micros: number | null }>
  const executor = commands.findLast(command => command.role === 'executor')
  const reviewer = commands.findLast(command => command.role === 'reviewer' && command.grant_id === executor?.grant_id
    && command.source_task_id === executor.source_task_id && command.rework_ordinal === executor.rework_ordinal)
  const execution = executor?.execution_id ? store.getAgentExecution(executor.execution_id) : null
  const task = execution ? store.getTask(execution.entityId) : null
  const workspace = task?.workspaceId ? getAgentWorkspace(task.workspaceId) : null
  const artifactDirectory = workspace && execution ? getAgentWorkspaceCwd(workspace, execution.sessionId) : undefined
  const evidence = reviewer ? listOwnerTechnicalReviewEvidence(projectId).find(item => item.reviewerCommandId === reviewer.id) : undefined
  const action = evidence ? readOwnerQualityAction(evidence.reviewerCommandId) : null
  const validations = execution ? listDevelopmentValidations(execution.entityId).filter(item => item.executionId === execution.id) : []
  const messages = getOwnerManagementView(projectId).messages
  const plan = getProjectOwnerPlanDraft(projectId)
  const planningRequests = database.prepare('SELECT COUNT(*) AS count FROM project_owner_planning_admissions').get() as { count: number }
  const employeeRequests = database.prepare('SELECT COUNT(*) AS count FROM project_owner_execution_request_reservations').get() as { count: number }
  const reviewerRequests = reviewer ? database.prepare('SELECT COUNT(*) AS count FROM project_owner_execution_request_reservations WHERE command_id=?').get(reviewer.id) as { count: number } : null
  const assignment = database.prepare("SELECT payload FROM project_owner_planning_run_outcomes WHERE json_extract(payload, '$.assignmentProposal') IS NOT NULL ORDER BY rowid DESC LIMIT 1").get() as { payload: string } | undefined
  const proposal = assignment ? (JSON.parse(assignment.payload) as { assignmentProposal: { selectedStepKeys: string[]; assignments: unknown[]; reviewerEmployeeId: string } }).assignmentProposal : undefined
  return {
    projectId, channelId, modelId, stage: 'project-2048', status: execution?.status ?? 'unknown', executionId: execution?.id,
    artifactDirectory, ownerQualityState: action?.state ?? 'not_checked',
    deliveryState: plan?.state === 'confirmed' && messages.some(message => message.kind === 'delivery' && message.delivery?.planVersion === plan.planVersion
      && message.delivery.items.some(item => item.artifactHash === action?.artifactHash)) ? 'delivered' : 'not_checked',
    ownerPlan: plan ? { revision: plan.revision, steps: plan.proposal.steps.length, confirmed: plan.state === 'confirmed', generatedByOwner: Boolean(plan.sourceRun) } : undefined,
    ownerAssignment: proposal ? { selectedSteps: proposal.selectedStepKeys.length, assignments: proposal.assignments.length, reviewerChosen: Boolean(proposal.reviewerEmployeeId) } : undefined,
    reworkCount: executor?.rework_ordinal ?? 0,
    validations: validations.map(item => ({ taskId: item.taskId, status: item.status, method: item.method ?? 'unknown' })),
    checks: validations.flatMap(item => item.checks ?? []).map(({ id, status, detail }) => ({ id, status, detail })),
    reviewer: { status: reviewer?.execution_id ? store.getAgentExecution(reviewer.execution_id)?.status ?? 'unknown' : 'not_dispatched',
      commandSettlement: reviewer?.state ?? 'not_dispatched', recorded: Boolean(evidence), verdict: evidence?.verdict,
      findings: evidence?.findings.length, costMicros: reviewer?.actual_cost_micros ?? null, requestsSent: reviewerRequests?.count ?? 0 },
    totalRequestsSent: planningRequests.count + employeeRequests.count,
    // 仅员工逐请求账本的已知费用；Owner 未知费用继续保留预留，不能称为已结算。
    knownEmployeeCostMicros: commands.reduce((sum, command) => sum + (command.actual_cost_micros ?? 0), 0),
  }
}

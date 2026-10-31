import { createHash } from 'node:crypto'
import { createApproval } from './approval-service'
import * as store from './project-sqlite-store'
import type { AgentEmployeeCapabilityScope } from './project-types'
import { fingerprintCapabilityEvidence } from './employee-capability-evidence'

/**
 * 基于已经人工脱敏的学习样本创建“候选推广”审批；不运行模型、不直接写生产能力。
 * P1 的真实反思 Builder / eval runner 可在此候选工件上继续追加训练与 held-out 结果。
 */
export function proposeEmployeeCapabilityAdoption(input: {
  agentId: string
  scope: AgentEmployeeCapabilityScope
  workspaceId?: string
  content: string
  trainingScore: number
  heldOutScore: number
  judgeIndependent: boolean
  evidenceSampleIds: string[]
  /** 本次判定的评判者类型，写入审批以供核对。 */
  judgeKind?: 'rule' | 'llm' | 'injected'
  /** 当次评测使用的固定不可演化约束，便于审批时核对候选未绕过边界。 */
  nonEvolvableConstraints?: string[]
}): { approvalId: string } {
  if (!Number.isFinite(input.trainingScore) || !Number.isFinite(input.heldOutScore)) throw new Error('候选评测分数无效')
  if (!input.judgeIndependent) throw new Error('评判者不独立，不能创建自动推广建议')
  const employee = store.getAgentEmployee(input.agentId)
  if (!employee?.enabled) throw new Error('目标 AI 员工不存在或已停用')
  if (input.scope === 'workspace' && !input.workspaceId) throw new Error('工作区能力候选必须指定 workspaceId')
  const samples = store.listAgentEmployeeLearningSamples(input.agentId)
  const selected = samples.filter((sample) => (
    input.evidenceSampleIds.includes(sample.id)
    && (input.scope !== 'workspace' || sample.workspaceId === input.workspaceId)
  ))
  if (selected.length < 3 || selected.some((sample) => sample.privacyStatus !== 'sanitized')) {
    throw new Error('至少需要 3 条已脱敏学习样本才能创建能力推广建议')
  }
  const active = store.getActiveAgentEmployeeCapabilityVersions(input.agentId, input.workspaceId)
    .find((version) => version.scope === input.scope && version.workspaceId === input.workspaceId)
  const activeHealth = active
    ? store.getAgentEmployeeCapabilityHealth(input.agentId).find((item) => item.versionId === active.id)
    : undefined
  const percent = (value: number | null | undefined): string => value === null || value === undefined ? '数据不足' : `${(value * 100).toFixed(1)}%`
  const healthSummary = activeHealth
    ? `当前版本 v${active!.versionNumber}：Owner 判断 ${activeHealth.decidedSampleCount} 条、退回修改率 ${percent(activeHealth.reworkRate)}、执行失败率 ${percent(activeHealth.failureRate)}。`
    : '当前范围尚无可用版本健康记录。'
  const selectedOwnerJudgmentCount = selected.filter((sample) => sample.ownerJudgment).length
  const ownerSampleWarning = input.scope === 'role' && selectedOwnerJudgmentCount < 5
    ? '警告：Owner 判断少于 5 条；该建议仍可审批，但不能据此声称角色能力趋势改善。'
    : ''
  const versionNumber = Math.max(0, ...store.listAgentEmployeeCapabilityVersions(input.agentId).map((version) => version.versionNumber)) + 1
  const content = input.content.trim()
  if (!content || content.length > 12_000) throw new Error('候选能力内容为空或超出长度限制')
  // 能力内容会进入后续执行上下文，出现凭据/路径类内容时必须阻断。
  const { scanSampleForSensitiveContent } = require('./agent-employee-sample-scan') as typeof import('./agent-employee-sample-scan')
  const sensitive = scanSampleForSensitiveContent(content)
  if (sensitive.length > 0) throw new Error(`候选能力内容包含疑似敏感信息，请先清理：${sensitive.map((item) => item.message).join('、')}`)
  const contentHash = createHash('sha256').update(content).digest('hex')
  const approval = createApproval({
    sourceType: 'employee_capability',
    title: `推广 AI 员工能力候选：${employee.name}`,
    summary: `训练集 ${input.trainingScore.toFixed(1)}；held-out ${input.heldOutScore.toFixed(1)}；${selected.length} 条已脱敏样本，其中 Owner 判断 ${selectedOwnerJudgmentCount} 条；${healthSummary}${ownerSampleWarning}评判配置由本次运行或调用方声明，独立性尚未核验。批准后才会激活新版本。`,
    proposedChange: {
      type: 'employee_capability_adopt',
      agentId: input.agentId,
      scope: input.scope,
      workspaceId: input.workspaceId,
      parentVersionId: active?.id,
      versionNumber,
      content,
      contentHash,
      trainingScore: input.trainingScore,
      heldOutScore: input.heldOutScore,
      evidenceSampleIds: selected.map((sample) => sample.id),
      evidenceFingerprint: fingerprintCapabilityEvidence(selected),
      // 评判者身份与不可演化约束随候选一起冻结，供审批时核对。
      judgeKind: input.judgeKind ?? 'injected',
      judgeIndependent: input.judgeIndependent,
      nonEvolvableConstraints: input.nonEvolvableConstraints ?? []
    },
  })
  return { approvalId: approval.id }
}

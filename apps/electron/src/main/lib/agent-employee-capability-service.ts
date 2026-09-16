import { createHash } from 'node:crypto'
import { createApproval } from './approval-service'
import * as store from './project-sqlite-store'
import type { AgentEmployeeCapabilityScope } from './project-types'

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
}): { approvalId: string } {
  if (!Number.isFinite(input.trainingScore) || !Number.isFinite(input.heldOutScore)) throw new Error('候选评测分数无效')
  if (!input.judgeIndependent) throw new Error('评判者不独立，不能创建自动推广建议')
  const employee = store.getAgentEmployee(input.agentId)
  if (!employee?.enabled) throw new Error('目标 AI 员工不存在或已停用')
  if (input.scope === 'workspace' && !input.workspaceId) throw new Error('工作区能力候选必须指定 workspaceId')
  const samples = store.listAgentEmployeeLearningSamples(input.agentId)
  const selected = samples.filter((sample) => input.evidenceSampleIds.includes(sample.id))
  if (selected.length < 3 || selected.some((sample) => sample.privacyStatus !== 'sanitized')) {
    throw new Error('至少需要 3 条已脱敏学习样本才能创建能力推广建议')
  }
  const active = store.getActiveAgentEmployeeCapabilityVersions(input.agentId, input.workspaceId)
    .find((version) => version.scope === input.scope && version.workspaceId === input.workspaceId)
  const versionNumber = Math.max(0, ...store.listAgentEmployeeCapabilityVersions(input.agentId).map((version) => version.versionNumber)) + 1
  const content = input.content.trim()
  if (!content || content.length > 12_000) throw new Error('候选能力内容为空或超出长度限制')
  const contentHash = createHash('sha256').update(content).digest('hex')
  const approval = createApproval({
    sourceType: 'employee_capability',
    title: `推广 AI 员工能力候选：${employee.name}`,
    summary: `训练集 ${input.trainingScore.toFixed(1)}；held-out ${input.heldOutScore.toFixed(1)}；${selected.length} 条已脱敏样本；独立评判。批准后才会激活新版本。`,
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
    },
  })
  return { approvalId: approval.id }
}

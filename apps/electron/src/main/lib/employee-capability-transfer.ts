/**
 * 跨员工能力迁移。
 *
 * 默认关闭，且永不复制样本正文或直接复用来源分数：
 * - 只生成“可复用模式摘要”，来源为已脱敏样本的结构化结果（outcome 计数、版本数量）。
 * - 目标员工必须在自己的人工脱敏样本与 held-out 上重新评测，不能继承来源员工分数。
 * - 只创建待审批候选，不自动激活。
 */

import { getGovernancePolicy } from './employee-capability-governance-policy'
import { proposeEmployeeCapabilityAdoption } from './agent-employee-capability-service'
import * as store from './project-sqlite-store'
import type { AgentEmployeeCapabilityScope } from './project-types'

export interface CapabilityTransferInput {
  sourceAgentId: string
  targetAgentId: string
  scope: AgentEmployeeCapabilityScope
  workspaceId?: string
  /** 显式确认：跨员工迁移默认关闭，必须由用户显式开启。 */
  allowTransfer: boolean
  now?: number
}

export interface CapabilityTransferResult {
  status: 'prepared' | 'disabled' | 'source_insufficient' | 'target_insufficient'
  message: string
  /** 供人工评审的模式摘要，不含样本正文。 */
  patternSummary?: string
  /** 目标员工仍需完成的步骤。 */
  requiredSteps?: string[]
}

const MIN_SOURCE_SAMPLES = 3
const MIN_TARGET_SAMPLES = 3

/** 只统计结构化结果，不读取样本摘要正文。 */
function summarizePatterns(agentId: string): { total: number; sanitized: number; byOutcome: Record<string, number>; versionCount: number } {
  const samples = store.listAgentEmployeeLearningSamples(agentId)
  const byOutcome: Record<string, number> = {}
  for (const sample of samples.filter((item) => item.privacyStatus === 'sanitized')) {
    byOutcome[sample.outcome] = (byOutcome[sample.outcome] ?? 0) + 1
  }
  return {
    total: samples.length,
    sanitized: samples.filter((item) => item.privacyStatus === 'sanitized').length,
    byOutcome,
    versionCount: store.listAgentEmployeeCapabilityVersions(agentId).length,
  }
}

/**
 * 准备迁移候选。
 * 注意：本函数不创建可批准候选，只返回摘要与所需步骤；真正的候选必须由目标员工自己的评测产生。
 */
export function prepareCapabilityTransfer(input: CapabilityTransferInput): CapabilityTransferResult {
  if (!input.allowTransfer) {
    return { status: 'disabled', message: '跨员工迁移默认关闭；需显式开启后才会生成迁移摘要。' }
  }
  const source = store.getAgentEmployee(input.sourceAgentId)
  const target = store.getAgentEmployee(input.targetAgentId)
  if (!source?.enabled || !target?.enabled) return { status: 'source_insufficient', message: '来源或目标 AI 员工不存在或已停用' }
  if (input.sourceAgentId === input.targetAgentId) return { status: 'disabled', message: '来源与目标为同一员工，无需迁移' }

  const sourcePatterns = summarizePatterns(input.sourceAgentId)
  if (sourcePatterns.sanitized < MIN_SOURCE_SAMPLES) return { status: 'source_insufficient', message: `来源员工已脱敏样本不足 ${MIN_SOURCE_SAMPLES} 条` }

  const targetPatterns = summarizePatterns(input.targetAgentId)
  if (targetPatterns.sanitized < MIN_TARGET_SAMPLES) {
    return {
      status: 'target_insufficient',
      message: `目标员工已脱敏样本不足 ${MIN_TARGET_SAMPLES} 条，无法在本员工上重新评测`,
      requiredSteps: ['在目标员工上积累并人工脱敏至少 3 条学习样本', '运行目标员工自己的受控评测', '等待 held-out 门禁与独立评判通过'],
    }
  }

  const outcomeText = Object.entries(sourcePatterns.byOutcome).map(([outcome, count]) => `${outcome}=${count}`).join(' · ')
  return {
    status: 'prepared',
    message: '已生成迁移摘要；不会复用来源员工的评测分数，目标员工必须自行重新评测。',
    patternSummary: [
      `来源员工：${source.name}（${sourcePatterns.sanitized} 条已脱敏样本，${sourcePatterns.versionCount} 个版本）`,
      `结果分布：${outcomeText || '无'}`,
      `范围：${input.scope === 'role' ? '角色级' : `工作区级 · ${input.workspaceId ?? '未指定'}`}`,
    ].join('\n'),
    requiredSteps: [
      '在目标员工的样本上重新运行受控评测',
      'held-out 分数不得低于目标员工自身基线',
      '评判者必须独立',
      '通过后在审批页人工确认',
    ],
  }
}

/**
 * 仅当目标员工已自行评测并通过门禁时，才允许创建待审批候选。
 * 调用方必须传入来自目标员工评测的真实分数，本函数不接受来源员工分数。
 */
export function createTransferCandidate(input: {
  targetAgentId: string
  scope: AgentEmployeeCapabilityScope
  workspaceId?: string
  content: string
  /** 必须来自目标员工自己的评测。 */
  trainingScore: number
  heldOutScore: number
  judgeIndependent: boolean
  evidenceSampleIds: string[]
}): { approvalId: string } {
  if (!input.judgeIndependent) throw new Error('评判者不独立，不能创建迁移候选')
  const targetSamples = store.listAgentEmployeeLearningSamples(input.targetAgentId).filter((sample) => input.evidenceSampleIds.includes(sample.id))
  if (targetSamples.length < MIN_TARGET_SAMPLES || targetSamples.some((sample) => sample.privacyStatus !== 'sanitized')) {
    throw new Error('迁移候选必须引用目标员工自己的至少 3 条已脱敏样本')
  }
  const policy = getGovernancePolicy()
  if (targetSamples.length < policy.minSanitizedSamples) throw new Error(`目标员工样本低于治理阈值 ${policy.minSanitizedSamples} 条`)
  return proposeEmployeeCapabilityAdoption({ agentId: input.targetAgentId, scope: input.scope, workspaceId: input.workspaceId, content: input.content, trainingScore: input.trainingScore, heldOutScore: input.heldOutScore, judgeIndependent: true, evidenceSampleIds: input.evidenceSampleIds })
}

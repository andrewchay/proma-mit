import type { SubAgentInput } from '../types'
import type { TccSpawnFixtureCase } from './tcc-spawn-fixture'
import { prepareSubAgentProjectionFromItems } from './subagent-projection-adapter'
import { parseSubtaskResult, TYPED_SUBTASK_RESULT_PROTOCOL_PROMPT } from './subtask-result-parser'

export type TccSpawnExperimentVariant = 'full_context' | 'brief' | 'tcc_projection'
export interface TccSpawnExperimentRecord { variant: TccSpawnExperimentVariant; prompt: string; projectionId?: string; selectedItemIds: string[]; omittedItemIds: string[]; readOnly: boolean; resultProtocol: 'typed-v1' }
export interface TccSpawnExperimentDelegate { (input: SubAgentInput, record: TccSpawnExperimentRecord): Promise<string> }
export interface TccSpawnEligibility { eligible: boolean; savingsRate: number; reasons: string[] }
export interface TccEvalPreflight { ready: boolean; reasons: string[] }

/**
 * 付费调用前的离线自检。上一轮真实评测因协议约定与解析器不一致，白耗了多次调用，
 * 因此这里把「prompt 与 parser 是否同源」「样本是否真的有投影空间」「私密项是否泄漏」
 * 全部前置为确定性检查：任何一项不满足都不应发起真实请求。
 */
export function checkTccEvalPreflight(cases: TccSpawnFixtureCase[]): TccEvalPreflight {
  const reasons: string[] = []
  const eligibility = evaluateTccSpawnEligibility(cases)
  if (!eligibility.eligible) reasons.push(...eligibility.reasons)

  // prompt / parser 同源检查：协议提示必须声明解析器实际读取的字段。
  for (const field of ['protocolVersion', 'claims', 'evidence', 'verified']) {
    if (!TYPED_SUBTASK_RESULT_PROTOCOL_PROMPT.includes(field)) reasons.push(`protocol prompt is missing field ${field}`)
  }
  const selfCheck = parseSubtaskResult(`\`\`\`json\n${JSON.stringify({ protocolVersion: 1, status: 'completed', summary: 'preflight', claims: [{ statement: 'preflight claim', confidence: 'high', verified: true, evidence: [{ kind: 'file_locator', sourceId: 'preflight', verified: true }] }], artifacts: [], unverified: [], recommendedNextSteps: [] })}\n\`\`\``, 'preflight')
  const claim = selfCheck.result.claims[0]
  if (selfCheck.protocolError || !claim?.verified || claim.evidence.length === 0) {
    reasons.push(`typed-v1 round-trip self-check failed: ${selfCheck.protocolError ?? 'no verified claim'}`)
  }

  for (const testCase of cases) {
    const preparation = prepareSubAgentProjectionFromItems({ parentSessionId: testCase.projectionRequest.sessionId, enabled: true, subAgent: { agentName: testCase.targetAgentId, task: testCase.task, context: { projection: testCase.projectionRequest } }, items: testCase.items, sourceRevision: testCase.id })
    const selected = new Set(preparation.projection?.items.map((item) => item.itemId) ?? [])
    if (!testCase.requiredItemIds.every((id) => selected.has(id))) reasons.push(`${testCase.id} projection omits required evidence`)
    if (testCase.forbiddenItemIds.some((id) => selected.has(id))) reasons.push(`${testCase.id} projection leaks a forbidden item`)
  }
  return { ready: reasons.length === 0, reasons }
}

/** 在付费运行前做确定性资格检查，避免没有压缩空间的样本消耗模型调用。 */
export function evaluateTccSpawnEligibility(cases: TccSpawnFixtureCase[]): TccSpawnEligibility {
  if (cases.length < 10) return { eligible: false, savingsRate: 0, reasons: ['benchmark requires at least 10 fixed cases'] }
  let full = 0; let projected = 0
  for (const testCase of cases) {
    const preparation = prepareSubAgentProjectionFromItems({ parentSessionId: testCase.projectionRequest.sessionId, enabled: true, subAgent: { agentName: testCase.targetAgentId, task: testCase.task, context: { projection: testCase.projectionRequest } }, items: testCase.items, sourceRevision: testCase.id })
    full += testCase.items.reduce((total, item) => total + Math.ceil(item.content.length / 4), 0)
    projected += preparation.projection?.tokenEstimate ?? Number.MAX_SAFE_INTEGER
  }
  const savingsRate = full === 0 ? 0 : 1 - projected / full
  return { eligible: savingsRate >= 0.2, savingsRate, reasons: savingsRate >= 0.2 ? [] : ['TCC projection saves less than 20% estimated input tokens'] }
}

export async function runTccSpawnExperiment(testCase: TccSpawnFixtureCase, delegate: TccSpawnExperimentDelegate): Promise<TccSpawnExperimentRecord[]> {
  const variants: TccSpawnExperimentVariant[] = ['full_context', 'brief', 'tcc_projection']
  return Promise.all(variants.map(async (variant) => {
    const subAgent: SubAgentInput = { agentName: testCase.targetAgentId, task: testCase.task, maxTurns: 1, context: { resultProtocol: 'typed-v1', readOnly: true, projection: variant === 'tcc_projection' ? testCase.projectionRequest : undefined } }
    const prepared = prepareSubAgentProjectionFromItems({ parentSessionId: testCase.projectionRequest.sessionId, enabled: variant === 'tcc_projection', subAgent, items: testCase.items, sourceRevision: testCase.id })
    const selectedItemIds = prepared.projection?.items.map((item) => item.itemId) ?? []
    const record: TccSpawnExperimentRecord = { variant, prompt: variant === 'full_context' ? testCase.items.map((item) => item.content).join('\n') : variant === 'brief' ? testCase.brief : `${testCase.task}${prepared.promptSuffix}`, projectionId: prepared.projection?.id, selectedItemIds, omittedItemIds: testCase.items.map((item) => item.id).filter((id) => !selectedItemIds.includes(id)), readOnly: true, resultProtocol: 'typed-v1' }
    await delegate(subAgent, record)
    return record
  }))
}

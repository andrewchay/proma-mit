import type { SubAgentInput } from '../types'
import type { TccSpawnFixtureCase } from './tcc-spawn-fixture'
import { prepareSubAgentProjectionFromItems } from './subagent-projection-adapter'

export type TccSpawnExperimentVariant = 'full_context' | 'brief' | 'tcc_projection'
export interface TccSpawnExperimentRecord { variant: TccSpawnExperimentVariant; prompt: string; projectionId?: string; selectedItemIds: string[]; omittedItemIds: string[]; readOnly: boolean; resultProtocol: 'typed-v1' }
export interface TccSpawnExperimentDelegate { (input: SubAgentInput, record: TccSpawnExperimentRecord): Promise<string> }
export interface TccSpawnEligibility { eligible: boolean; savingsRate: number; reasons: string[] }

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

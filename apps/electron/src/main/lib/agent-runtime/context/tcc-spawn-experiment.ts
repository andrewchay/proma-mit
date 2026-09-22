import type { SubAgentInput } from '../types'
import type { TccSpawnFixtureCase } from './tcc-spawn-fixture'
import { prepareSubAgentProjectionFromItems } from './subagent-projection-adapter'

export type TccSpawnExperimentVariant = 'full_context' | 'brief' | 'tcc_projection'
export interface TccSpawnExperimentRecord { variant: TccSpawnExperimentVariant; prompt: string; projectionId?: string; selectedItemIds: string[]; omittedItemIds: string[]; readOnly: boolean; resultProtocol: 'typed-v1' }
export interface TccSpawnExperimentDelegate { (input: SubAgentInput, record: TccSpawnExperimentRecord): Promise<string> }

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

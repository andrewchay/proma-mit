import type { ContextItem, ContextProjectionRequest } from '@gravitas/shared'

interface RawFixtureItem {
  id: string
  kind: ContextItem['kind']
  content: string
  visibility: ContextItem['visibility']
  confidence: ContextItem['confidence']
  tags: string[]
  verified: boolean
  locator: string
}

interface RawFixtureCase {
  id: string
  task: string
  brief: string
  requiredItemIds: string[]
  forbiddenItemIds: string[]
  targetAgentId: string
  maxInputTokens: number
  items: RawFixtureItem[]
}

export interface TccSpawnFixtureCase extends Omit<RawFixtureCase, 'items'> {
  items: ContextItem[]
  projectionRequest: ContextProjectionRequest
}

export interface TccSpawnFixture {
  version: 1
  benchmarkId: 'typed-context-compiler-spawn'
  cases: TccSpawnFixtureCase[]
}

/** 将静态评测样本转换为与生产 ledger 相同的 ContextItem 合约。 */
export function loadTccSpawnFixture(input: unknown): TccSpawnFixture {
  if (!isRecord(input) || input.version !== 1 || input.benchmarkId !== 'typed-context-compiler-spawn' || !Array.isArray(input.cases)) {
    throw new Error('Invalid TCC spawn fixture header')
  }
  const cases = input.cases.map((entry) => loadCase(entry))
  if (cases.length < 10) throw new Error('TCC spawn fixture requires at least 10 cases')
  return { version: 1, benchmarkId: 'typed-context-compiler-spawn', cases }
}

function loadCase(input: unknown): TccSpawnFixtureCase {
  if (!isRecord(input) || !isStringArray(input.requiredItemIds) || !isStringArray(input.forbiddenItemIds) || !Array.isArray(input.items)
    || typeof input.id !== 'string' || typeof input.task !== 'string' || typeof input.brief !== 'string'
    || typeof input.targetAgentId !== 'string' || typeof input.maxInputTokens !== 'number') throw new Error('Invalid TCC spawn fixture case')
  const id = input.id as string
  const ids = new Set<string>()
  const items = input.items.map((raw) => hydrateItem(raw, id, ids))
  for (const id of [...input.requiredItemIds, ...input.forbiddenItemIds]) if (!ids.has(id)) throw new Error(`Fixture ${input.id} references missing item ${id}`)
  if (items.length < 23) throw new Error(`Fixture ${input.id} requires long-context noise`)
  return {
    id: input.id, task: input.task, brief: input.brief, requiredItemIds: input.requiredItemIds, forbiddenItemIds: input.forbiddenItemIds,
    targetAgentId: input.targetAgentId, maxInputTokens: input.maxInputTokens, items,
    projectionRequest: {
      sessionId: `tcc-spawn-${input.id}`, purpose: 'evaluation', task: input.task, targetAgentId: input.targetAgentId,
      targetModel: { provider: 'zhipu', modelId: 'glm-5.3-flash' }, requiredKinds: ['file_fact'], excludedKinds: ['tool_observation'], maxInputTokens: input.maxInputTokens,
      policy: { allowUnverified: false, includeRawEvidence: false, includeSummaries: true, includeFullContent: true, deniedPaths: ['secrets/'] },
    },
  }
}

function hydrateItem(raw: unknown, caseId: string, ids: Set<string>): ContextItem {
  if (!isRecord(raw) || typeof raw.id !== 'string' || typeof raw.kind !== 'string' || typeof raw.content !== 'string' || typeof raw.visibility !== 'string'
    || typeof raw.confidence !== 'string' || !isStringArray(raw.tags) || typeof raw.verified !== 'boolean' || typeof raw.locator !== 'string') throw new Error(`Invalid item in ${caseId}`)
  if (ids.has(raw.id)) throw new Error(`Duplicate item ${raw.id}`)
  ids.add(raw.id)
  return { id: raw.id, kind: raw.kind as ContextItem['kind'], version: 1, createdAt: '2026-09-22T00:00:00.000Z', updatedAt: '2026-09-22T00:00:00.000Z', content: raw.content, tags: raw.tags, visibility: raw.visibility as ContextItem['visibility'], mutability: 'append_only', confidence: raw.confidence as ContextItem['confidence'], source: { kind: 'file_locator', id: raw.id, sessionId: `tcc-spawn-${caseId}` }, evidence: [{ kind: 'file_locator', sourceId: raw.id, locator: raw.locator, verified: raw.verified }] }
}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null }
function isStringArray(value: unknown): value is string[] { return Array.isArray(value) && value.every((item) => typeof item === 'string') }

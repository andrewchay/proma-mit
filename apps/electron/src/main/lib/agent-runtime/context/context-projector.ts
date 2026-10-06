import { createHash } from 'node:crypto'
import type {
  ContextItem,
  ContextProjection,
  ContextProjectionItem,
  ContextRepresentation,
} from '@gravitas/shared'
import { contextItemRejectionReason, isVerified, resolveContextProjectionRequest } from './context-policy'
import { renderContextItem } from './context-renderer'

export interface ContextProjectionInput {
  request: ContextProjection['request']
  items: ContextItem[]
  sourceRevision: string
}

interface RankedItem {
  item: ContextItem
  representation: ContextRepresentation
  score: number
  reason: string
  required: boolean
}

/**
 * 规则型 Context Compiler。输入相同就产生相同 projection，不调用模型也不写入 ledger。
 */
export function compileContextProjection(input: ContextProjectionInput): ContextProjection {
  const request = resolveContextProjectionRequest(input.request)
  const omissions = new Map<string, string>()
  const ranked = input.items
    .flatMap((item) => {
      const rejection = contextItemRejectionReason(item, request)
      if (rejection) {
        omissions.set(item.id, rejection)
        return []
      }
      return [rankItem(item, request)]
    })
    .sort(compareRankedItems)

  const selected: RankedItem[] = []
  let tokenEstimate = 0
  for (const candidate of ranked) {
    const rendered = renderContextItem(candidate.item, candidate.representation)
    const candidateTokens = estimateTokens(rendered.block)
    if (candidate.required || tokenEstimate + candidateTokens <= request.maxInputTokens) {
      selected.push(candidate)
      tokenEstimate += candidateTokens
    } else {
      omissions.set(candidate.item.id, `token budget exceeded (${request.maxInputTokens})`)
    }
  }

  const projectionItems: ContextProjectionItem[] = selected.map((candidate) => ({
    itemId: candidate.item.id,
    representation: candidate.representation,
    reason: candidate.reason,
    score: candidate.score,
  }))
  const renderedPromptBlocks = selected.map((candidate) => renderContextItem(candidate.item, candidate.representation).block)
  const stableInput = JSON.stringify({ request, sourceRevision: input.sourceRevision, items: projectionItems })
  const id = `projection:${createHash('sha256').update(stableInput).digest('hex').slice(0, 24)}`
  const createdAt = selected
    .map((candidate) => candidate.item.updatedAt)
    .sort()
    .at(-1) ?? '1970-01-01T00:00:00.000Z'

  return {
    id,
    request,
    items: projectionItems,
    renderedPromptBlocks,
    omittedItemIds: [...omissions.keys()].sort(),
    omissions: [...omissions.entries()]
      .map(([itemId, reason]) => ({ itemId, reason }))
      .sort((left, right) => left.itemId.localeCompare(right.itemId)),
    tokenEstimate,
    createdAt,
    sourceRevision: input.sourceRevision,
  }
}

function rankItem(item: ContextItem, request: ReturnType<typeof resolveContextProjectionRequest>): RankedItem {
  const required = request.requiredKinds?.includes(item.kind) ?? false
  const task = request.task.toLocaleLowerCase()
  const tagMatches = item.tags.filter((tag) => task.includes(tag.toLocaleLowerCase())).length
  const verified = isVerified(item)
  const representation = selectRepresentation(item, request.policy)
  const confidenceScore = item.confidence === 'high' ? 300 : item.confidence === 'medium' ? 200 : item.confidence === 'low' ? 100 : 0
  const updatedScore = stableTimestamp(item.updatedAt)
  const score = (required ? 1_000_000_000_000 : 0)
    + tagMatches * 1_000_000_000
    + (verified ? 100_000_000 : 0)
    + confidenceScore * 100_000
    + updatedScore
  const reason = [
    required ? 'required kind' : undefined,
    tagMatches > 0 ? `task tag match (${tagMatches})` : undefined,
    verified ? 'verified evidence' : 'unverified or inferred',
    `representation=${representation}`,
  ].filter((part): part is string => part !== undefined).join('; ')

  return { item, representation, score, reason, required }
}

function selectRepresentation(
  item: ContextItem,
  policy: ReturnType<typeof resolveContextProjectionRequest>['policy'],
): ContextRepresentation {
  if (policy.includeSummaries && item.summary) return 'summary'
  if (policy.includeFullContent) return 'full'
  return 'locator'
}

function compareRankedItems(left: RankedItem, right: RankedItem): number {
  if (left.score !== right.score) return right.score - left.score
  return left.item.id.localeCompare(right.item.id)
}

function stableTimestamp(value: string): number {
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? Math.floor(timestamp / 1_000) : 0
}

function estimateTokens(value: string): number {
  return Math.max(1, Math.ceil(value.length / 4))
}

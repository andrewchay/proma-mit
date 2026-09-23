import { describe, expect, test } from 'bun:test'
import type { ContextItem, ContextProjectionRequest } from '@gravitas/shared'
import { compactMetadataPolicyId, rebuildCompactionView } from './compaction-rebuild'

function item(id: string, kind: ContextItem['kind'], overrides: Partial<ContextItem> = {}): ContextItem {
  return {
    id,
    kind,
    version: 1,
    createdAt: '2026-09-22T00:00:00.000Z',
    updatedAt: '2026-09-22T00:00:00.000Z',
    content: `内容 ${id}`,
    tags: ['fixture'],
    visibility: 'parent',
    mutability: 'append_only',
    confidence: 'high',
    source: { kind: 'file_locator', id, sessionId: 'session-1' },
    evidence: [{ kind: 'file_locator', sourceId: id, locator: `docs/${id}.md`, verified: true }],
    ...overrides,
  }
}

const items: ContextItem[] = [
  item('fact-1', 'file_fact', { tags: ['required'] }),
  item('noise-1', 'tool_observation', { confidence: 'low' }),
]

const request: ContextProjectionRequest = {
  sessionId: 'session-1',
  purpose: 'compaction',
  task: '延续当前任务',
  targetAgentId: 'main',
  targetModel: { provider: 'zhipu', modelId: 'glm-5.3-flash' },
  maxInputTokens: 500,
  requiredKinds: ['file_fact'],
  policy: { allowUnverified: false, includeRawEvidence: false, includeSummaries: true, includeFullContent: true },
}

describe('M5-02 rebuild compaction view from raw ledger', () => {
  test('is byte-stable and traceable for identical ledger input', () => {
    const first = rebuildCompactionView({ request, items, sourceRevision: 'rev-1', now: () => '2026-09-22T16:00:00.000Z' })
    const second = rebuildCompactionView({ request, items, sourceRevision: 'rev-1', now: () => '2026-09-22T16:00:00.000Z' })

    expect(first.projection.id).toBe(second.projection.id)
    expect(first.projection.renderedPromptBlocks).toEqual(second.projection.renderedPromptBlocks)
    expect(first.metadata).toEqual(second.metadata)
    expect(first.metadata.retainedItemIds).toContain('fact-1')
    expect(first.metadata.omittedItemIds).toContain('noise-1')
    expect(first.metadata.tokenEstimate).toBe(first.projection.tokenEstimate)
    expect(first.metadata.policyId).toBe(compactMetadataPolicyId(request.policy))
  })

  test('never mutates the raw ledger items', () => {
    const snapshot = JSON.parse(JSON.stringify(items)) as ContextItem[]
    rebuildCompactionView({ request, items, sourceRevision: 'rev-1' })
    expect(items).toEqual(snapshot)
  })

  test('ledger revision change invalidates the rebuilt view identity', () => {
    const before = rebuildCompactionView({ request, items, sourceRevision: 'rev-1' })
    const after = rebuildCompactionView({ request, items, sourceRevision: 'rev-2' })
    expect(after.projection.sourceRevision).toBe('rev-2')
    expect(after.projection.id).not.toBe(before.projection.id)
    expect(after.metadata.sourceRevision).toBe('rev-2')
  })
})

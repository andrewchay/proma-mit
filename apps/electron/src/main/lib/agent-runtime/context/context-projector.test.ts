import { describe, expect, test } from 'bun:test'
import type { ContextItem, ContextProjectionRequest } from '@gravitas/shared'
import { compileContextProjection } from './context-projector'

const baseRequest: ContextProjectionRequest = {
  sessionId: 'session-1',
  purpose: 'subagent_spawn',
  task: '检查 context 压缩阈值',
  maxInputTokens: 100,
}

function item(overrides: Partial<ContextItem> = {}): ContextItem {
  return {
    id: 'item-1',
    kind: 'file_fact',
    version: 1,
    createdAt: '2026-09-22T08:00:00.000Z',
    updatedAt: '2026-09-22T08:00:00.000Z',
    content: 'COMPACTION_THRESHOLD = 0.8',
    summary: '压缩阈值为 80%。',
    tags: ['context', '压缩'],
    visibility: 'model',
    mutability: 'append_only',
    confidence: 'high',
    source: { kind: 'file_locator', id: 'source-1', sessionId: 'session-1' },
    evidence: [{ kind: 'file_locator', sourceId: 'source-1', locator: 'src/context.ts:1', verified: true }],
    ...overrides,
  }
}

describe('compileContextProjection', () => {
  test('同一 ledger 与 request 生成 byte-stable projection，并优先选择摘要', () => {
    const items = [item(), item({ id: 'item-2', tags: ['无关'], updatedAt: '2026-09-21T08:00:00.000Z' })]
    const input = { request: baseRequest, items, sourceRevision: 'sha256:fixture' }

    expect(compileContextProjection(input)).toEqual(compileContextProjection(input))
    expect(compileContextProjection(input).items[0]).toMatchObject({ itemId: 'item-1', representation: 'summary' })
    expect(compileContextProjection(input).renderedPromptBlocks[0]).toContain('[SUMMARY]')
  })

  test('required kind 即使超过预算也保留，并公开 omitted items', () => {
    const required = item({ id: 'required', kind: 'constraint', content: '必须保留的约束，内容很长。'.repeat(30), summary: undefined })
    const optional = item({ id: 'optional', content: '可省略内容。'.repeat(30), summary: undefined })

    const projection = compileContextProjection({
      request: { ...baseRequest, maxInputTokens: 1, requiredKinds: ['constraint'] },
      items: [required, optional],
      sourceRevision: 'sha256:fixture',
    })

    expect(projection.items.map((entry) => entry.itemId)).toEqual(['required'])
    expect(projection.omittedItemIds).toEqual(['optional'])
    expect(projection.omissions).toEqual([{ itemId: 'optional', reason: 'token budget exceeded (1)' }])
    expect(projection.tokenEstimate).toBeGreaterThan(1)
  })

  test('未验证或不允许 visibility 的 item 不会伪装成 FACT 或绕过 policy', () => {
    const unverified = item({
      id: 'unverified',
      confidence: 'low',
      evidence: [{ kind: 'tool_result', sourceId: 'tool-1', verified: false }],
    })
    const privateItem = item({ id: 'private', visibility: 'private' })

    const projection = compileContextProjection({
      request: { ...baseRequest, policy: { allowUnverified: true, includeRawEvidence: false, includeSummaries: false, includeFullContent: true } },
      items: [unverified, privateItem],
      sourceRevision: 'sha256:fixture',
    })

    expect(projection.renderedPromptBlocks.join('\n')).toContain('[UNVERIFIED]')
    expect(projection.items.map((entry) => entry.itemId)).toEqual(['unverified'])
    expect(projection.omittedItemIds).toEqual(['private'])
  })

  test('policy 拒绝未验证事实时 fail-closed', () => {
    const projection = compileContextProjection({
      request: { ...baseRequest, policy: { allowUnverified: false, includeRawEvidence: false, includeSummaries: true, includeFullContent: true } },
      items: [item({ confidence: 'unknown', evidence: [] })],
      sourceRevision: 'sha256:fixture',
    })

    expect(projection.items).toHaveLength(0)
    expect(projection.omittedItemIds).toEqual(['item-1'])
  })
})

import { describe, expect, test } from 'bun:test'
import type { ContextItem, ContextProjectionRequest } from '@gravitas/shared'
import { contextItemRejectionReason, resolveContextProjectionRequest } from './context-policy'

const request: ContextProjectionRequest = {
  sessionId: 'session-1',
  purpose: 'subagent_spawn',
  task: '读取允许的文件',
}

function item(overrides: Partial<ContextItem> = {}): ContextItem {
  return {
    id: 'item-1',
    kind: 'file_fact',
    version: 1,
    createdAt: '2026-09-22T08:00:00.000Z',
    updatedAt: '2026-09-22T08:00:00.000Z',
    content: '内容',
    tags: [],
    visibility: 'model',
    mutability: 'append_only',
    confidence: 'high',
    source: { kind: 'file_locator', id: 'source-1', sessionId: 'session-1' },
    evidence: [{ kind: 'file_locator', sourceId: 'source-1', locator: 'src/allowed.ts:1', verified: true }],
    ...overrides,
  }
}

describe('Context projection policy', () => {
  test('allowPaths 与 deniedPaths 都 fail-closed，deny 优先', () => {
    const resolved = resolveContextProjectionRequest({
      ...request,
      policy: {
        allowUnverified: false,
        includeRawEvidence: false,
        includeSummaries: true,
        includeFullContent: true,
        allowedPaths: ['src/'],
        deniedPaths: ['src/private/'],
      },
    })

    expect(contextItemRejectionReason(item(), resolved)).toBeUndefined()
    expect(contextItemRejectionReason(item({ evidence: [{ kind: 'file_locator', sourceId: 'x', locator: 'docs/no.ts:1', verified: true }] }), resolved)).toBe('path blocked by policy')
    expect(contextItemRejectionReason(item({ evidence: [{ kind: 'file_locator', sourceId: 'x', locator: 'src/private/key.ts:1', verified: true }] }), resolved)).toBe('path blocked by policy')
  })

  test('model allowlist 缺少 target model 时拒绝，session 开关不参与 policy 绕过', () => {
    const resolved = resolveContextProjectionRequest({
      ...request,
      policy: {
        allowUnverified: false,
        includeRawEvidence: false,
        includeSummaries: true,
        includeFullContent: true,
        modelAllowlist: ['openai/gpt-5.6-terra'],
      },
    })

    expect(contextItemRejectionReason(item(), resolved)).toBe('target model blocked by policy')
    const allowed = resolveContextProjectionRequest({ ...resolved, targetModel: { provider: 'openai', modelId: 'gpt-5.6-terra' } })
    expect(contextItemRejectionReason(item(), allowed)).toBeUndefined()
  })
})

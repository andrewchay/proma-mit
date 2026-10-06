import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ContextItem, ContextProjectionPolicy, ContextProjectionRequest } from '@gravitas/shared'
import { compileContextProjection } from './context-projector'

interface GoldenItem {
  id: string
  kind?: ContextItem['kind']
  tags?: string[]
  content: string
  summary?: string
  locator?: string
}

interface GoldenCase {
  name: string
  request: { task: string; maxInputTokens: number; policy?: { deniedPaths?: string[] } }
  items: GoldenItem[]
  expectedBlocks: string[]
  expectedOmissions: string[]
}

const fixturePath = join(import.meta.dir, 'fixtures', 'm1-projection-golden.json')
const goldenCases = JSON.parse(readFileSync(fixturePath, 'utf8')) as GoldenCase[]

function makeItem(input: GoldenItem): ContextItem {
  return {
    id: input.id,
    kind: input.kind ?? 'file_fact',
    version: 1,
    createdAt: '2026-09-22T08:00:00.000Z',
    updatedAt: '2026-09-22T08:00:00.000Z',
    content: input.content,
    ...(input.summary ? { summary: input.summary } : {}),
    tags: input.tags ?? [],
    visibility: 'model',
    mutability: 'append_only',
    confidence: 'high',
    source: { kind: 'file_locator', id: `source-${input.id}`, sessionId: 'golden-session' },
    evidence: [{ kind: 'file_locator', sourceId: `source-${input.id}`, locator: input.locator ?? `src/${input.id}.ts:1`, verified: true }],
  }
}

function makeRequest(golden: GoldenCase): ContextProjectionRequest {
  const policy: ContextProjectionPolicy | undefined = golden.request.policy
    ? {
        allowUnverified: false,
        includeRawEvidence: false,
        includeSummaries: true,
        includeFullContent: true,
        ...golden.request.policy,
      }
    : undefined
  return {
    sessionId: 'golden-session',
    purpose: 'evaluation',
    task: golden.request.task,
    maxInputTokens: golden.request.maxInputTokens,
    ...(policy ? { policy } : {}),
  }
}

describe('Context projection golden fixtures', () => {
  for (const golden of goldenCases) {
    test(golden.name, () => {
      const projection = compileContextProjection({
        request: makeRequest(golden),
        items: golden.items.map(makeItem),
        sourceRevision: `sha256:${golden.name}`,
      })

      expect(projection.renderedPromptBlocks).toEqual(golden.expectedBlocks)
      expect(projection.omittedItemIds).toEqual(golden.expectedOmissions)
      expect(compileContextProjection({
        request: makeRequest(golden),
        items: golden.items.map(makeItem),
        sourceRevision: `sha256:${golden.name}`,
      })).toEqual(projection)
    })
  }
})

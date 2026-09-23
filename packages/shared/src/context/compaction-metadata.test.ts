import { describe, expect, test } from 'bun:test'
import {
  parseCompactMetadata,
  serializeCompactMetadata,
  type CompactMetadata,
} from './compaction-metadata'

const metadata: CompactMetadata = {
  version: 1,
  sourceRevision: 'rev-42',
  policyId: 'sha256:abcd1234',
  retainedItemIds: ['fact-1', 'fact-2'],
  omittedItemIds: ['noise-1'],
  summaryVersion: 1,
  tokenEstimate: 320,
  createdAt: '2026-09-22T16:00:00.000Z',
}

describe('M5-01 compact metadata', () => {
  test('round-trips through serialize and parse', () => {
    expect(parseCompactMetadata(serializeCompactMetadata(metadata))).toEqual(metadata)
  })

  test('rejects invalid metadata fail-closed', () => {
    expect(() => parseCompactMetadata('not json')).toThrow('not valid JSON')
    expect(() => parseCompactMetadata(JSON.stringify({ ...metadata, version: 2 }))).toThrow('version must be 1')
    expect(() => parseCompactMetadata(JSON.stringify({ ...metadata, retainedItemIds: 'fact-1' }))).toThrow('retainedItemIds must be string[]')
    expect(() => parseCompactMetadata(JSON.stringify({ ...metadata, tokenEstimate: -1 }))).toThrow('tokenEstimate must be a non-negative integer')
    expect(() => parseCompactMetadata(JSON.stringify({ ...metadata, createdAt: 'yesterday' }))).toThrow('createdAt must be an ISO timestamp')
  })

})

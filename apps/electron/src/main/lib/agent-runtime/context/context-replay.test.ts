import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ContextLedgerStore,
  recordArtifact,
  recordSessionMessage,
  recordToolObservation,
  type ArtifactInput,
  type SessionMessageInput,
  type ToolObservationInput,
} from './context-ledger'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

interface ReplaySessionMessage extends SessionMessageInput { kind: 'session_message' }
interface ReplayToolObservation extends ToolObservationInput { kind: 'tool_observation' }
interface ReplayArtifact extends ArtifactInput { kind: 'artifact' }
type ReplayEvent = ReplaySessionMessage | ReplayToolObservation | ReplayArtifact

function replayFixture(): ReplayEvent[] {
  const path = join(import.meta.dir, 'fixtures', 'm0-replay.json')
  return JSON.parse(readFileSync(path, 'utf8')) as ReplayEvent[]
}

function replay(directory: string): ContextLedgerStore {
  const store = new ContextLedgerStore(directory)
  for (const event of replayFixture()) {
    switch (event.kind) {
      case 'session_message':
        recordSessionMessage(store, event)
        break
      case 'tool_observation':
        recordToolObservation(store, event)
        break
      case 'artifact':
        recordArtifact(store, event)
        break
    }
  }
  return store
}

function createTestDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'gravitas-context-replay-'))
  temporaryDirectories.push(directory)
  return directory
}

describe('Context ledger replay fixture', () => {
  test('同一 fixture 在独立 ledger 上生成稳定 sourceRevision，重放不重复事实', () => {
    const first = replay(createTestDirectory())
    const second = replay(createTestDirectory())

    expect(first.list()).toHaveLength(3)
    expect(first.sourceRevision()).toBe(second.sourceRevision())

    for (const event of replayFixture()) {
      if (event.kind === 'session_message') recordSessionMessage(first, event)
      if (event.kind === 'tool_observation') recordToolObservation(first, event)
      if (event.kind === 'artifact') recordArtifact(first, event)
    }
    expect(first.list()).toHaveLength(3)
  })
})

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SubtaskArtifactStore, toStoredSubtaskArtifact } from './subtask-artifact-store'

const directories: string[] = []

afterEach(() => {
  while (directories.length > 0) rmSync(directories.pop()!, { recursive: true, force: true })
})

describe('SubtaskArtifactStore', () => {
  test('given a typed result when persisting then raw response, child session and projection source items remain traceable', () => {
    const directory = mkdtempSync(join(tmpdir(), 'gravitas-subtask-artifact-'))
    directories.push(directory)
    const store = new SubtaskArtifactStore(directory)
    const record = toStoredSubtaskArtifact({
      childSessionId: 'sub-child-1',
      parentSessionId: 'parent-1',
      task: '审查投影',
      rawResponse: '```json\n{"protocolVersion":1}\n```',
      result: {
        protocolVersion: 1,
        taskId: 'parent-task',
        status: 'completed',
        summary: '通过',
        claims: [],
        artifacts: [],
        unverified: [],
        recommendedNextSteps: [],
      },
      projection: {
        id: 'projection-1',
        request: { sessionId: 'parent-1', purpose: 'subagent_spawn', task: '审查投影' },
        items: [{ itemId: 'ledger-item-a', representation: 'summary', reason: 'required' }],
        renderedPromptBlocks: [],
        omittedItemIds: [],
        omissions: [],
        tokenEstimate: 0,
        createdAt: '2026-09-22T08:48:00.000Z',
        sourceRevision: 'revision-7',
      },
      createdAt: '2026-09-22T08:48:00.000Z',
    })

    store.save(record)

    expect(store.get('sub-child-1')).toMatchObject({
      childSessionId: 'sub-child-1',
      parentSessionId: 'parent-1',
      rawResponse: '```json\n{"protocolVersion":1}\n```',
      projection: { id: 'projection-1', sourceRevision: 'revision-7', sourceItemIds: ['ledger-item-a'] },
    })
  })

  test('given an unsafe child session id when reading then it cannot traverse the artifact directory', () => {
    const directory = mkdtempSync(join(tmpdir(), 'gravitas-subtask-artifact-'))
    directories.push(directory)
    expect(new SubtaskArtifactStore(directory).get('../parent')).toBeUndefined()
  })
})

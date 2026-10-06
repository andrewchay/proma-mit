import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ContextLedgerStore } from './context-ledger'
import { ContextMetricsStore } from './context-metrics'
import { createContextLedgerObserver } from './context-observer'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function createTestDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'gravitas-context-observer-'))
  temporaryDirectories.push(directory)
  return directory
}

describe('ContextLedgerObserver', () => {
  test('默认关闭，不创建 ledger', () => {
    const observer = createContextLedgerObserver({ workspaceDirectory: createTestDirectory(), enabled: false })

    expect(observer).toBeUndefined()
  })

  test('开启后旁路记录 session、tool 与 artifact，且写到工作区私有 context 目录', () => {
    const workspaceDirectory = createTestDirectory()
    const observer = createContextLedgerObserver({ workspaceDirectory, enabled: true })
    expect(observer).toBeDefined()

    observer?.recordSessionMessage({
      eventId: 'message-1',
      sessionId: 'session-1',
      role: 'user',
      content: '请读取文件。',
      createdAt: '2026-09-22T08:00:00.000Z',
    })
    observer?.recordToolObservation({
      eventId: 'tool-1',
      sessionId: 'session-1',
      toolName: 'Read',
      result: '文件内容',
      createdAt: '2026-09-22T08:01:00.000Z',
    })
    observer?.recordArtifact({
      artifactId: 'artifact-1',
      sourceEventId: 'message-1',
      sessionId: 'session-1',
      title: '检查结果',
      content: '结果内容',
      createdAt: '2026-09-22T08:02:00.000Z',
    })
    observer?.recordMetric({
      version: 1,
      id: 'metric-1',
      stage: 'turn_started',
      at: '2026-09-22T08:02:00.000Z',
      sessionId: 'session-1',
      runtime: 'proma',
      cacheStatus: 'unknown',
    })

    const contextDirectory = join(workspaceDirectory, 'context')
    const ledger = new ContextLedgerStore(contextDirectory)
    expect(ledger.list()).toHaveLength(3)
    expect(new ContextMetricsStore(contextDirectory).list()).toHaveLength(1)
  })

  test('observer 写入失败时只报告错误，不抛出到 Agent 调用方', () => {
    const errors: unknown[] = []
    const observer = createContextLedgerObserver({
      workspaceDirectory: '/dev/null',
      enabled: true,
      onError: (error) => errors.push(error),
    })

    expect(() => observer?.recordSessionMessage({
      eventId: 'message-1',
      sessionId: 'session-1',
      role: 'user',
      content: '不会阻断主流程',
    })).not.toThrow()
    expect(errors).toHaveLength(1)
  })
})

import { afterEach, describe, expect, test } from 'bun:test'
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ContextMetricsStore, type ContextCompilerMetricEvent } from './context-metrics'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function createTestDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'gravitas-context-metrics-'))
  temporaryDirectories.push(directory)
  return directory
}

function metric(stage: ContextCompilerMetricEvent['stage']): ContextCompilerMetricEvent {
  return {
    version: 1,
    id: `metric-${stage}`,
    stage,
    at: '2026-09-22T08:30:00.000Z',
    sessionId: 'session-1',
    workspaceId: 'workspace-1',
    runtime: 'proma',
    provider: 'openai',
    modelId: 'gpt-5.6-terra',
    inputTokenEstimate: 640,
    cacheStatus: 'unknown',
    durationMs: stage === 'turn_finished' ? 1234 : undefined,
    retryCount: 1,
    failureCode: stage === 'turn_finished' ? 'network_error' : undefined,
    ledgerSourceRevision: 'sha256:fixture',
  }
}

describe('ContextMetricsStore', () => {
  test('写入并读取无正文的 turn 指标，未知 cache 状态保持 unknown', () => {
    const directory = createTestDirectory()
    const store = new ContextMetricsStore(directory)
    const started = metric('turn_started')
    const finished = metric('turn_finished')

    store.append(started)
    store.append(finished)

    expect(store.list('session-1')).toEqual([started, finished])
    expect(JSON.stringify(store.list())).not.toContain('用户原始正文')
    expect(store.list()[0]?.cacheStatus).toBe('unknown')
  })

  test('损坏或不完整的 JSONL 行不会污染可用观测数据', () => {
    const directory = createTestDirectory()
    const store = new ContextMetricsStore(directory)
    const event = metric('turn_started')
    store.append(event)
    appendFileSync(join(directory, 'metrics.jsonl'), '{bad-json}\n{"version":1}\n', 'utf8')

    expect(store.list()).toEqual([event])
  })
})

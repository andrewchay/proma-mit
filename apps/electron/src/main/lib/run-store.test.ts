import { describe, expect, test, beforeEach, afterAll } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AppEventEnvelope } from '@gravitas/shared'
import { toRunRecord } from './run-store'

const testDir = mkdtempSync(join(tmpdir(), 'proma-run-store-test-'))
process.env.PROMA_TEST_CONFIG_DIR = testDir

describe('toRunRecord 运行记录映射', () => {
  test('waiting_action → 含 actionKind', () => {
    const event: AppEventEnvelope = {
      id: 'evt-1',
      type: 'waiting_action',
      source: 'agent',
      taskId: 's1',
      title: '会话',
      sessionId: 's1',
      actionKind: 'permission',
      detail: '等待权限确认',
      timestamp: 1000,
    }
    const record = toRunRecord(event)
    expect(record.runId).toBe('s1')
    expect(record.status).toBe('waiting_action')
    expect(record.actionKind).toBe('permission')
    expect(record.source).toBe('agent')
  })

  test('completed → status completed + detail', () => {
    const event: AppEventEnvelope = {
      id: 'evt-2',
      type: 'completed',
      source: 'workflow',
      taskId: 'run-1',
      title: '风险周报',
      detail: '任务已完成',
      timestamp: 2000,
    }
    const record = toRunRecord(event)
    expect(record.source).toBe('workflow')
    expect(record.status).toBe('completed')
    expect(record.detail).toBe('任务已完成')
  })

  test('progress → 无 actionKind，保留 detail', () => {
    const event: AppEventEnvelope = {
      id: 'evt-3',
      type: 'progress',
      source: 'agent',
      taskId: 's2',
      title: '会话2',
      detail: '正在使用 Bash',
      timestamp: 3000,
    }
    const record = toRunRecord(event)
    expect(record.status).toBe('progress')
    expect(record.actionKind).toBeUndefined()
    expect(record.detail).toBe('正在使用 Bash')
  })

  test('带 memberId/workspaceId 的事件 → 运行记录保留归属（PH1-C）', () => {
    const event: AppEventEnvelope = {
      id: 'evt-4',
      type: 'completed',
      source: 'agent',
      taskId: 's3',
      title: 'AI 员工执行',
      sessionId: 's3',
      memberId: 'agent-abc123',
      workspaceId: 'ws-1',
      detail: '已完成',
      timestamp: 4000,
    }
    const record = toRunRecord(event)
    expect(record.memberId).toBe('agent-abc123')
    expect(record.workspaceId).toBe('ws-1')
  })

  test('query 支持按 memberId 过滤（PH2-B）', () => {
    const { getRunStore } = require('./run-store')
    const store = getRunStore()
    store.record({ id: 'q-1', type: 'completed', source: 'agent', taskId: 's-a', title: 'A 会话', memberId: 'agent-a', timestamp: 5000 })
    store.record({ id: 'q-2', type: 'completed', source: 'agent', taskId: 's-b', title: 'B 会话', memberId: 'agent-b', timestamp: 5001 })
    const forA = store.query({ memberId: 'agent-a', limit: 50 })
    expect(forA.length).toBeGreaterThan(0)
    expect(forA.every((r: import('@gravitas/shared').RunRecord) => r.memberId === 'agent-a')).toBe(true)
    const none = store.query({ memberId: 'agent-zzz', limit: 50 })
    expect(none.some((r: import('@gravitas/shared').RunRecord) => r.memberId === 'agent-zzz')).toBe(false)
  })

  test('exportToFile 导出 JSONL', () => {
    const { getRunStore } = require('./run-store')
    const store = getRunStore()
    store.record({ id: 'e-1', type: 'completed', source: 'agent', taskId: 's-e', title: '导出会话', memberId: 'agent-e', timestamp: 6000 })
    const path = join(testDir, 'export-test.jsonl')
    const count = store.exportToFile(path, { memberId: 'agent-e', limit: 50 })
    expect(count).toBeGreaterThan(0)
    const content = readFileSync(path, 'utf8')
    expect(content).toContain('s-e')
  })
})

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ContextLedgerStore, recordSessionMessage } from './context-ledger'
import { prepareSubAgentProjection } from './subagent-projection-adapter'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function workspace(): string {
  const directory = mkdtempSync(join(tmpdir(), 'gravitas-tcc-spawn-'))
  temporaryDirectories.push(directory)
  return directory
}

describe('SubAgent projection adapter', () => {
  test('旧调用不读取 ledger，也不改变原有 prompt', () => {
    const prepared = prepareSubAgentProjection({
      parentSessionId: 'parent-1',
      enabled: false,
      subAgent: { agentName: 'explorer', task: '查找入口' },
    })

    expect(prepared).toEqual({ promptSuffix: '' })
  })

  test('显式 projection 只读取父 session 并注入可追溯 prompt', () => {
    const workspaceDirectory = workspace()
    const ledger = new ContextLedgerStore(join(workspaceDirectory, 'context'))
    recordSessionMessage(ledger, {
      eventId: 'parent-message',
      sessionId: 'parent-1',
      role: 'user',
      content: '请查找 Agent runtime 的入口。',
      summary: '查找 Agent runtime 入口。',
      createdAt: '2026-09-22T08:00:00.000Z',
    })
    recordSessionMessage(ledger, {
      eventId: 'other-message',
      sessionId: 'other-session',
      role: 'user',
      content: '不应泄漏。',
      createdAt: '2026-09-22T08:01:00.000Z',
    })

    const prepared = prepareSubAgentProjection({
      parentSessionId: 'parent-1',
      workspaceDirectory,
      enabled: true,
      subAgent: {
        agentName: 'explorer',
        task: '查找 Agent runtime 的入口',
        context: {
          projection: {
            sessionId: 'attacker-session',
            purpose: 'main_turn',
            task: '错误任务',
          },
        },
      },
    })

    expect(prepared.projection?.request).toMatchObject({
      sessionId: 'parent-1',
      purpose: 'subagent_spawn',
      task: '查找 Agent runtime 的入口',
      targetAgentId: 'explorer',
    })
    expect(prepared.projection?.sourceRevision).toMatch(/^sha256:/)
    expect(prepared.promptSuffix).toContain('## Typed Context Projection')
    expect(prepared.promptSuffix).toContain('sourceRevision: sha256:')
    expect(prepared.promptSuffix).toContain('查找 Agent runtime 入口。')
    expect(prepared.promptSuffix).not.toContain('不应泄漏')
  })

  test('feature flag 关闭时显式 projection 也不读取 ledger', () => {
    const prepared = prepareSubAgentProjection({
      parentSessionId: 'parent-1',
      enabled: false,
      subAgent: {
        agentName: 'explorer',
        task: '查找入口',
        context: { projection: { sessionId: 'parent-1', purpose: 'subagent_spawn', task: '查找入口' } },
      },
    })

    expect(prepared).toEqual({ promptSuffix: '' })
  })

  test('projection 缺少 workspace 时回退，不阻断原有 spawn', () => {
    const prepared = prepareSubAgentProjection({
      parentSessionId: 'parent-1',
      enabled: true,
      subAgent: {
        agentName: 'explorer',
        task: '查找入口',
        context: { projection: { sessionId: 'parent-1', purpose: 'subagent_spawn', task: '查找入口' } },
      },
    })

    expect(prepared.promptSuffix).toBe('')
    expect(prepared.fallbackReason).toBe('workspace ledger unavailable')
  })
})

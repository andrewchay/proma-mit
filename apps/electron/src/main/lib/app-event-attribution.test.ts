import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { rmSync } from 'node:fs'
import { initProjectDb, closeProjectDb, createAgentEmployee, createAgentExecution } from './project-sqlite-store'
import { resolveMemberForSession, toAppEvent } from './app-event-bus'
import type { AppEventEnvelope } from '@gravitas/shared'

/**
 * PH1-C 成员归属测试：
 * - resolveMemberForSession：AI 员工执行的会话能反查成 memberId=agent-<id>
 * - toAppEvent：归一化事件时带上 memberId
 * 使用 PROMA_TEST_CONFIG_DIR 隔离 sqlite。
 */

const testDir = join(tmpdir(), `gravitas-appevent-test-${Date.now()}`)

beforeAll(async () => {
  process.env.PROMA_TEST_CONFIG_DIR = testDir
  await initProjectDb()
})

afterAll(() => {
  closeProjectDb()
  try {
    rmSync(testDir, { recursive: true, force: true })
  } catch {
    // 忽略
  }
  delete process.env.PROMA_TEST_CONFIG_DIR
})

function agentEvaluationPayload(sessionId: string) {
  return {
    kind: 'agent_event' as const,
    event: { type: 'complete' as const, stopReason: 'end_turn' },
  }
}

describe('统一事件成员归属（PH1-C）', () => {
  test('resolveMemberForSession：AI 员工执行会话 → agent-<id>', () => {
    const agent = createAgentEmployee({ name: '测试AI', role: '测试', description: 'x', channelId: 'ch1' })
    const sessionId = `session-${Date.now()}`
    createAgentExecution({
      id: `exec-${Date.now()}`,
      projectId: 'p1',
      entityType: 'task',
      entityId: 't1',
      agentId: agent.id,
      sessionId,
      prompt: '测试',
    })

    expect(resolveMemberForSession(sessionId)).toBe(`agent-${agent.id}`)
    expect(resolveMemberForSession('unknown-session')).toBeUndefined()
  })

  test('toAppEvent 归一化带 memberId（AI 员工）', () => {
    const agent = createAgentEmployee({ name: '测试AI2', role: '测试', description: 'x', channelId: 'ch1' })
    const sessionId = `session-b-${Date.now()}`
    createAgentExecution({
      id: `exec-b-${Date.now()}`,
      projectId: 'p1',
      entityType: 'task',
      entityId: 't2',
      agentId: agent.id,
      sessionId,
      prompt: '测试',
    })
    const event = toAppEvent(sessionId, agentEvaluationPayload(sessionId)) as AppEventEnvelope | null
    expect(event).not.toBeNull()
    expect((event as { memberId?: string }).memberId).toBe(`agent-${agent.id}`)
  })

  test('toAppEvent 非 AI 员工会话不带 memberId', () => {
    const event = toAppEvent('plain-session-xyz', agentEvaluationPayload('plain-session-xyz'))
    expect(event).not.toBeNull()
    expect((event as { memberId?: string }).memberId).toBeUndefined()
  })
})

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { rmSync } from 'node:fs'
import { sendAgentInvoke, listIncomingInvokes, respondToInvoke, invokeToText } from './agent-invoke-service'

/**
 * PH2-F Agent 互调协议测试：
 * - sendAgentInvoke 落盘
 * - listIncomingInvokes 按 toMember 过滤 + status
 * - respondToInvoke 更新状态/结果
 * 使用 PROMA_TEST_CONFIG_DIR 隔离。
 */

const testDir = join(tmpdir(), `gravitas-agentinvoke-test-${Date.now()}`)

beforeAll(async () => {
  process.env.PROMA_TEST_CONFIG_DIR = testDir
})

afterAll(() => {
  try {
    rmSync(testDir, { recursive: true, force: true })
  } catch {
    // 忽略
  }
  delete process.env.PROMA_TEST_CONFIG_DIR
})

describe('Agent 互调协议（PH2-F）', () => {
  test('send + list 按 toMember 过滤', () => {
    sendAgentInvoke('agent-a', 'agent-b', '帮我审核这份 PR 摘要')
    sendAgentInvoke('agent-c', 'agent-b', '确认一下部署窗口')
    sendAgentInvoke('agent-a', 'agent-d', '另一个人的请求')

    const forB = listIncomingInvokes('agent-b')
    expect(forB.length).toBe(2)
    expect(forB.some((r) => r.task.includes('PR'))).toBe(true)
    expect(forB.every((r) => r.toMemberId === 'agent-b')).toBe(true)
  })

  test('respond 更新状态与结果', () => {
    const req = sendAgentInvoke('agent-a', 'agent-b', '帮忙跑测试')
    const done = respondToInvoke(req.id, 'done', '已跑完，全部通过')
    expect(done?.status).toBe('done')
    expect(done?.result).toContain('通过')
    const list = listIncomingInvokes('agent-b', 'done')
    expect(list.some((r) => r.id === req.id)).toBe(true)
  })

  test('invokeToText 可读', () => {
    const req = sendAgentInvoke('agent-a', 'agent-b', '简单确认')
    expect(invokeToText(req)).toContain('Agent 互调请求')
    expect(invokeToText(req)).toContain('简单确认')
  })
})

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { rmSync, existsSync, readFileSync } from 'node:fs'
import { initProjectDb, closeProjectDb, createAgentEmployee, createAgentExecution } from './project-sqlite-store'
import { appendComputerUseAudit } from './computer-use-audit-service'

/**
 * PH1-D 审计收口测试：
 * - 审计记录能带上执行者 memberId（衔接 PH1-C resolveMemberForSession）
 * - AI 员工执行的会话写入审计时携带 memberId=agent-<id>
 * 使用 PROMA_TEST_CONFIG_DIR 隔离。
 */

const testDir = join(tmpdir(), `gravitas-audit-member-test-${Date.now()}`)

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

describe('审计收口带成员归属（PH1-D）', () => {
  test('AI 员工执行的会话写入 ComputerUse 审计时带 memberId', async () => {
    const agent = createAgentEmployee({ name: '审计AI', role: '测试', description: 'x', channelId: 'ch1' })
    const sessionId = `audit-session-${Date.now()}`
    createAgentExecution({
      id: `audit-exec-${Date.now()}`,
      projectId: 'p1',
      entityType: 'task',
      entityId: 't1',
      agentId: agent.id,
      sessionId,
      prompt: '测试',
    })

    await appendComputerUseAudit(sessionId, 'move', { x: 10, y: 20 })

    const file = join(testDir, 'computer-use-audit', 'events.jsonl')
    expect(existsSync(file)).toBe(true)
    const line = readFileSync(file, 'utf8').trim().split('\n').at(-1)
    const parsed = JSON.parse(line!)
    expect(parsed.sessionId).toBe(sessionId)
    expect(parsed.memberId).toBe(`agent-${agent.id}`)
  })
})

import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { chmodSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { sendAgentInvoke, listIncomingInvokes, respondToInvoke, invokeToText } from './agent-invoke-service'

/**
 * PH2-F Agent 互调协议测试：
 * - sendAgentInvoke 落盘
 * - listIncomingInvokes 按 toMember 过滤 + status
 * - respondToInvoke 更新状态/结果
 * 使用 PROMA_TEST_CONFIG_DIR 隔离。
 */

const testDir = join(tmpdir(), `gravitas-agentinvoke-test-${Date.now()}`)

beforeAll(() => {
  process.env.PROMA_TEST_CONFIG_DIR = testDir
})

beforeEach(() => {
  rmSync(testDir, { recursive: true, force: true })
  mkdirSync(testDir, { recursive: true })
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

  test('相同幂等键的重试只产生一条收件箱请求', () => {
    const first = sendAgentInvoke('agent-a', 'agent-b', '只创建一次', 'retry-key-1')
    const retried = sendAgentInvoke('agent-a', 'agent-b', '只创建一次', 'retry-key-1')

    expect(retried.id).toBe(first.id)
    expect(retried.idempotencyKey).toBe('retry-key-1')
    expect(listIncomingInvokes('agent-b')).toHaveLength(1)
    expect(() => sendAgentInvoke('agent-a', 'agent-b', '不同任务', 'retry-key-1')).toThrow('幂等键')
  })

  test('不提供幂等键时仍保留每次发送一条请求的既有语义', () => {
    sendAgentInvoke('agent-a', 'agent-b', '允许重复')
    sendAgentInvoke('agent-a', 'agent-b', '允许重复')

    expect(listIncomingInvokes('agent-b')).toHaveLength(2)
  })

  test('以临时文件原子替换并保持 JSONL 格式', () => {
    const req = sendAgentInvoke('agent-a', 'agent-b', '原子写入')
    respondToInvoke(req.id, 'done', '完成')

    const dir = join(testDir, 'agent-invokes')
    const content = readFileSync(join(dir, 'invokes.jsonl'), 'utf-8')
    expect(content.endsWith('\n')).toBe(true)
    expect(content.trim().split('\n').map((line) => JSON.parse(line))).toHaveLength(1)
    expect(readdirSync(dir).filter((name) => name.includes('.tmp-'))).toEqual([])
  })

  test('损坏的 JSONL 会失败关闭且不会被新请求覆盖', () => {
    const dir = join(testDir, 'agent-invokes')
    const path = join(dir, 'invokes.jsonl')
    mkdirSync(dir, { recursive: true })
    writeFileSync(path, '{"id":"truncated"\n', 'utf-8')
    const before = readFileSync(path, 'utf-8')

    expect(() => sendAgentInvoke('agent-a', 'agent-b', '不得覆盖损坏数据')).toThrow('损坏')
    expect(readFileSync(path, 'utf-8')).toBe(before)
  })

  test('持久化失败会向上传播且原文件保持不变', () => {
    const req = sendAgentInvoke('agent-a', 'agent-b', '等待回复')
    const dir = join(testDir, 'agent-invokes')
    const path = join(dir, 'invokes.jsonl')
    const before = readFileSync(path, 'utf-8')

    const logSpy = spyOn(console, 'log').mockImplementation(() => undefined)
    chmodSync(dir, 0o500)
    try {
      expect(() => respondToInvoke(req.id, 'done', '不能落盘')).toThrow()
      expect(logSpy.mock.calls.some(([message]) => String(message).includes(`[Diag][agent-invoke] respond ${req.id}`))).toBe(false)
    } finally {
      chmodSync(dir, 0o700)
      logSpy.mockRestore()
    }

    expect(readFileSync(path, 'utf-8')).toBe(before)
    expect(listIncomingInvokes('agent-b', 'open')).toHaveLength(1)
  })
})

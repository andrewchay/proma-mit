import { afterAll, describe, expect, test } from 'bun:test'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { appendCompanionAudit } from './companion-audit-service'

/**
 * Companion 操作审计测试（PROMA_TEST_CONFIG_DIR 隔离）
 * 断言：JSONL 追加写入、字段齐全、不含消息正文。
 */

const testDir = join(tmpdir(), `gravitas-companion-audit-test-${Date.now()}`)

describe('companion-audit-service', () => {
  test('追加写入操作摘要，不含正文，失败静默', async () => {
    process.env.PROMA_TEST_CONFIG_DIR = testDir
    await appendCompanionAudit({ action: 'send_message', sessionId: 's1' })
    await appendCompanionAudit({ action: 'permission_allow', sessionId: 's1', detail: 'req-1' })

    const file = join(testDir, 'companion-audit', 'events.jsonl')
    const lines = readFileSync(file, 'utf-8').trim().split('\n')
    expect(lines.length).toBe(2)

    const first = JSON.parse(lines[0]!) as { at: string; action: string; sessionId?: string; detail?: string; text?: string }
    expect(first.action).toBe('send_message')
    expect(first.sessionId).toBe('s1')
    expect(first.at).toBeTruthy()
    // 绝不写入正文类字段
    expect(first.text).toBeUndefined()
    expect(first.detail).toBeUndefined()
  })

  test('detail 仅用于 requestId 类短标识', async () => {
    process.env.PROMA_TEST_CONFIG_DIR = testDir
    await appendCompanionAudit({ action: 'permission_deny', sessionId: 's2', detail: 'req-2' })
    const file = join(testDir, 'companion-audit', 'events.jsonl')
    const lines = readFileSync(file, 'utf-8').trim().split('\n')
    const last = JSON.parse(lines[lines.length - 1]!) as { detail?: string }
    expect(last.detail).toBe('req-2')
  })
})

afterAll(() => {
  delete process.env.PROMA_TEST_CONFIG_DIR
  try { rmSync(testDir, { recursive: true, force: true }) } catch { /* 忽略 */ }
})

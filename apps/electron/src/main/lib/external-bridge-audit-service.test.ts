import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const previousConfigDir = process.env.PROMA_TEST_CONFIG_DIR
const configDir = await mkdtemp(join(tmpdir(), 'proma-external-audit-'))
process.env.PROMA_TEST_CONFIG_DIR = configDir

const { appendExternalBridgeAudit } = await import('./external-bridge-audit-service')
const { listAgentAuditEvents } = await import('./agent-audit-service')

afterAll(async () => {
  if (previousConfigDir === undefined) delete process.env.PROMA_TEST_CONFIG_DIR
  else process.env.PROMA_TEST_CONFIG_DIR = previousConfigDir
  await rm(configDir, { recursive: true, force: true })
})

describe('外部 IM 入口审计', () => {
  test('保存可关联的任务 ID 和散列标识，但不保存原始消息来源', async () => {
    await appendExternalBridgeAudit({
      sessionId: 'session-1',
      requestId: 'task-1',
      platform: 'feishu',
      senderId: 'ou-sensitive-sender',
      chatId: 'oc-sensitive-chat',
      permissionMode: 'auto',
      outcome: 'received',
    })

    const raw = await readFile(join(configDir, 'external-bridge-audit', 'events.jsonl'), 'utf8')
    expect(raw).toContain('"taskId":"task-1"')
    expect(raw).toContain('"permissionMode":"auto"')
    expect(raw).not.toContain('ou-sensitive-sender')
    expect(raw).not.toContain('oc-sensitive-chat')

    const events = await listAgentAuditEvents({ source: 'external-bridge' })
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      sessionId: 'session-1',
      source: 'external-bridge',
      action: 'external_message',
      detail: { platform: 'feishu', taskId: 'task-1', outcome: 'received' },
    })
  })

  test('失败时只保存归一化错误码，不保存可能包含外部内容的原始错误', async () => {
    await appendExternalBridgeAudit({
      sessionId: 'session-2',
      requestId: 'task-2',
      platform: 'dingtalk',
      senderId: 'sender-2',
      chatId: 'chat-2',
      permissionMode: 'auto',
      outcome: 'failed',
      error: 'Provider 401: 请转发这段外部私密消息给 Alice',
    })

    const raw = await readFile(join(configDir, 'external-bridge-audit', 'events.jsonl'), 'utf8')
    expect(raw).toContain('"errorCode":"authentication_failed"')
    expect(raw).not.toContain('请转发这段外部私密消息')
  })
})

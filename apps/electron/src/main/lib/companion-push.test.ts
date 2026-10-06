import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  addPushSubscription,
  removePushSubscription,
  sendCompanionPush,
  ensureVapidKeys,
  _resetPushStoreForTest,
} from './companion-push'

/**
 * Companion Web Push 模块测试（PROMA_TEST_CONFIG_DIR 隔离；发送器注入 fake，不发真实网络请求）
 */

const testDir = join(tmpdir(), `gravitas-companion-push-test-${Date.now()}`)

const VALID_SUB = {
  endpoint: 'https://push.example.com/send/abc',
  keys: { p256dh: 'p256dh-key', auth: 'auth-key' },
}

afterAll(() => {
  delete process.env.PROMA_TEST_CONFIG_DIR
  try { rmSync(testDir, { recursive: true, force: true }) } catch { /* 忽略 */ }
})

describe('companion-push 订阅存储', () => {
  test('新增/去重/移除订阅，持久化到 JSON', () => {
    process.env.PROMA_TEST_CONFIG_DIR = testDir
    _resetPushStoreForTest()
    expect(addPushSubscription(VALID_SUB)).toBe(true)
    // 同 endpoint 去重
    expect(addPushSubscription(VALID_SUB)).toBe(true)
    // 非法结构拒绝
    expect(addPushSubscription({ endpoint: 'http://insecure', keys: {} })).toBe(false)
    const path = join(testDir, 'companion-push', 'subscriptions.json')
    expect(existsSync(path)).toBe(true)
    expect(JSON.parse(readFileSync(path, 'utf8'))).toHaveLength(1)
    expect(removePushSubscription(VALID_SUB.endpoint)).toBe(true)
    expect(removePushSubscription('https://gone')).toBe(false)
  })
})

describe('companion-push 发送', () => {
  test('向全部订阅推送 payload，单条失败不影响其他', async () => {
    process.env.PROMA_TEST_CONFIG_DIR = testDir
    _resetPushStoreForTest()
    addPushSubscription(VALID_SUB)
    addPushSubscription({ ...VALID_SUB, endpoint: 'https://push.example.com/send/def' })

    const sent: string[] = []
    await sendCompanionPush('需要权限确认', 'Bash', {
      sender: async (sub, payload) => {
        if (sub.endpoint.endsWith('abc')) throw new Error('网络错误') // 非 404/410 不清理
        sent.push(`${sub.endpoint}|${payload.title}|${payload.url}`)
      },
    })
    expect(sent).toEqual(['https://push.example.com/send/def|需要权限确认|/companion'])
  })

  test('410/410 失效订阅自动清理', async () => {
    process.env.PROMA_TEST_CONFIG_DIR = testDir
    _resetPushStoreForTest()
    addPushSubscription(VALID_SUB)
    await sendCompanionPush('t', 'b', {
      sender: async (sub) => {
        const err = new Error('gone') as Error & { statusCode?: number }
        err.statusCode = 410
        if (sub.endpoint === VALID_SUB.endpoint) throw err
      },
    })
    expect(JSON.parse(readFileSync(join(testDir, 'companion-push', 'subscriptions.json'), 'utf8'))).toHaveLength(0)
  })

  test('无订阅时不调用发送器', async () => {
    process.env.PROMA_TEST_CONFIG_DIR = testDir
    _resetPushStoreForTest()
    let called = 0
    await sendCompanionPush('t', 'b', { sender: async () => { called += 1 } })
    expect(called).toBe(0)
  })
})

describe('companion-push VAPID', () => {
  test('首次生成并持久化，重复调用复用', async () => {
    process.env.PROMA_TEST_CONFIG_DIR = testDir
    const first = ensureVapidKeys()
    expect(first.publicKey).toBeTruthy()
    expect(first.privateKey).toBeTruthy()
    const second = ensureVapidKeys()
    expect(second.publicKey).toBe(first.publicKey)
  })
})

import { describe, expect, test } from 'bun:test'
import { InMemoryWechatEventInbox, PostgresWechatEventInbox, inboxDedupeKey, replayTicketDeadLetter } from './event-inbox'
import { InMemoryWechatComponentTicketStore } from './ticket-store'
import { encryptWechatMessage, computeWechatCallbackSignature } from './message-crypto'
import { handleWechatCallback } from './callback'
import { WechatReconciliationService } from './reconciliation'
import { WechatComponentTokenService } from './component-token-service'
import { InMemoryWechatAuthorizerStore } from './authorizer-store'

const APP_ID = 'wx1234567890abcdef'
const NOW = 1_700_000_000_000
const MATERIAL = { token: 'cb-token', encodingAesKey: 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ' }

class FakeResponse {
  constructor(private readonly payload: unknown, readonly status = 200) {}
  async json(): Promise<unknown> { return this.payload }
}

describe('P3-09 事件 inbox', () => {
  test('同一 dedupeKey 只入库一次（幂等）', async () => {
    const inbox = new InMemoryWechatEventInbox()
    const input = { dedupeKey: 'k1', eventType: 'component_verify_ticket', payload: '{"ticket":"t1"}' }
    expect(await inbox.append(input)).toBe('appended')
    expect(await inbox.append(input)).toBe('duplicate')
    expect(await inbox.append({ ...input, payload: '不同内容同key' })).toBe('duplicate')
  })

  test('processed / dead / replayDead 状态机', async () => {
    const inbox = new InMemoryWechatEventInbox()
    await inbox.append({ dedupeKey: 'k1', eventType: 'ticket', payload: '{}' })
    await inbox.markDead('k1', 'db down')
    const dead = await inbox.listDead()
    expect(dead).toHaveLength(1)
    expect(dead[0]?.status).toBe('dead')
    expect(dead[0]?.attempts).toBe(1)
    expect(dead[0]?.lastError).toBe('db down')
    // pending/processed 不可重放
    expect(await inbox.replayDead('k1')).toBe(true)
    expect(await inbox.listDead()).toHaveLength(0)
    expect(await inbox.replayDead('k1')).toBe(false)
  })

  test('Postgres inbox：payload 加密落库、duplicate 判定、重放（fake client）', async () => {
    const rows: Array<Record<string, unknown>> = []
    const client = {
      query: async <Row extends Record<string, unknown>>(statement: string, params: readonly unknown[] = []): Promise<{ rows: Row[] }> => {
        if (statement.startsWith('INSERT')) {
          if (rows.some((row) => row.dedupe_key === params[0])) throw new Error('duplicate key')
          rows.push({ dedupe_key: params[0], event_type: params[1], encrypted_payload: params[2], status: 'pending', attempts: 0, last_error: null, created_at: '1', processed_at: null })
          return { rows: [] as Row[] }
        }
        if (statement.startsWith('UPDATE') && statement.includes("attempts = attempts + 1")) {
          const row = rows.find((item) => item.dedupe_key === params[0])
          if (row) { row.status = 'dead'; row.attempts = Number(row.attempts) + 1; row.last_error = params[1] }
          return { rows: [] as Row[] }
        }
        if (statement.startsWith('UPDATE') && statement.includes("status = 'pending'")) {
          const row = rows.find((item) => item.dedupe_key === params[0] && item.status === 'dead')
          if (row) { row.status = 'pending'; row.last_error = null }
          return { rows: row ? [row as unknown as Row] : [] as Row[] }
        }
        if (statement.startsWith('SELECT')) {
          return { rows: rows.filter((row) => row.status === 'dead') as unknown as Row[] }
        }
        return { rows: [] as Row[] }
      },
    }
    const inbox = new PostgresWechatEventInbox(client, new Uint8Array(32).fill(2))
    const payload = '{"ticket":"secret-ticket-1"}'
    expect(await inbox.append({ dedupeKey: 'dk', eventType: 'ticket', payload })).toBe('appended')
    // 密文不含明文
    expect(JSON.stringify(rows)).not.toContain('secret-ticket-1')
    expect(await inbox.append({ dedupeKey: 'dk', eventType: 'ticket', payload })).toBe('duplicate')
    await inbox.markDead('dk', 'boom')
    const dead = await inbox.listDead()
    expect(dead[0]?.payload).toBe(payload)
    expect(await inbox.replayDead('dk')).toBe(true)
    expect(await inbox.replayDead('dk')).toBe(false)
  })

  test('replayTicketDeadLetter：合法 payload 重新消费；非法 payload 保持 dead', async () => {
    const inbox = new InMemoryWechatEventInbox()
    const ticketStore = new InMemoryWechatComponentTicketStore()
    const payload = JSON.stringify({ componentAppId: APP_ID, ticket: 'ticket-777' })
    const key = inboxDedupeKey('component_verify_ticket', payload)
    await inbox.append({ dedupeKey: key, eventType: 'component_verify_ticket', payload })
    // 先制造 dead
    await inbox.markDead(key, 'simulated failure')
    expect(await replayTicketDeadLetter(inbox, ticketStore, key)).toBe('replayed')
    expect((await ticketStore.load(APP_ID))?.ticket).toBe('ticket-777')
    // 已 processed，不再是 dead → not_dead
    expect(await replayTicketDeadLetter(inbox, ticketStore, key)).toBe('not_dead')

    // 非法 payload
    await inbox.append({ dedupeKey: 'bad', eventType: 'component_verify_ticket', payload: 'not-json' })
    await inbox.markDead('bad', 'x')
    await expect(replayTicketDeadLetter(inbox, ticketStore, 'bad')).rejects.toThrow(/结构非法/)
    expect((await inbox.listDead()).some((event) => event.dedupeKey === 'bad')).toBe(true)
  })
})

/** 构造一次合法 ticket 回调请求。 */
async function ticketRequest(ticket: string) {
  const xml = `<xml><AppId><![CDATA[${APP_ID}]]></AppId><InfoType>component_verify_ticket</InfoType><ComponentVerifyTicket><![CDATA[${ticket}]]></ComponentVerifyTicket></xml>`
  const encrypt = encryptWechatMessage({ ...MATERIAL, message: xml, receiveId: APP_ID })
  const timestamp = String(Math.floor(NOW / 1000))
  const nonce = `n-${Math.random()}`
  const signature = computeWechatCallbackSignature({ token: MATERIAL.token, timestamp, nonce, encrypt })
  return {
    method: 'POST' as const,
    query: new URLSearchParams({ timestamp, nonce, msg_signature: signature }),
    body: `<xml><Encrypt><![CDATA[${encrypt}]]></Encrypt></xml>`,
  }
}

describe('P3-09 回调经 inbox 消费', () => {
  test('正常路径：appended → save → processed', async () => {
    const inbox = new InMemoryWechatEventInbox()
    const ticketStore = new InMemoryWechatComponentTicketStore()
    const req = await ticketRequest('ticket-normal')
    const response = await handleWechatCallback({ ...req, options: { cryptoMaterial: MATERIAL, ticketStore, ticketInbox: inbox, expectedComponentAppId: APP_ID, now: () => NOW } })
    expect(response?.status).toBe(200)
    expect((await ticketStore.load(APP_ID))?.ticket).toBe('ticket-normal')
    expect(await inbox.listDead()).toHaveLength(0)
  })

  test('跨重启重试（新 nonce 防线 + 同一 inbox）：不重复消费，计数仍为一', async () => {
    const inbox = new InMemoryWechatEventInbox()
    // 第一次：完整处理
    const ticketStore = new InMemoryWechatComponentTicketStore()
    const req = await ticketRequest('ticket-restart')
    const first = await handleWechatCallback({ ...req, options: { cryptoMaterial: MATERIAL, ticketStore, ticketInbox: inbox, expectedComponentAppId: APP_ID, now: () => NOW } })
    expect(first?.status).toBe(200)
    // 模拟重启：nonce 防线全新（新 ticketStore 的 acceptOnce 已遗忘），同一报文重发。
    // 第一道防线失效时，inbox 按内容判重兜底：返回 200 但不重复消费。
    const freshTicketStore = new InMemoryWechatComponentTicketStore()
    const second = await handleWechatCallback({ ...req, options: { cryptoMaterial: MATERIAL, ticketStore: freshTicketStore, ticketInbox: inbox, expectedComponentAppId: APP_ID, now: () => NOW } })
    expect(second?.status).toBe(200)
    expect(await freshTicketStore.load(APP_ID)).toBeUndefined() // 未重复消费
    // 内容相同、nonce/密文全新的合法重发 → 同样被 inbox 判重
    const req2 = await ticketRequest('ticket-restart')
    const third = await handleWechatCallback({ ...req2, options: { cryptoMaterial: MATERIAL, ticketStore: freshTicketStore, ticketInbox: inbox, expectedComponentAppId: APP_ID, now: () => NOW } })
    expect(third?.status).toBe(200)
    expect(await freshTicketStore.load(APP_ID)).toBeUndefined()
  })

  test('消费失败入 dead-letter 并返回 500；重试直接成功且保持 dead 待人工重放', async () => {
    const inbox = new InMemoryWechatEventInbox()
    const failingStore = {
      save: async () => { throw new Error('db down') },
      load: async () => undefined,
      count: async () => 0,
      acceptOnce: async () => true,
    }
    const req = await ticketRequest('ticket-dead')
    const first = await handleWechatCallback({ ...req, options: { cryptoMaterial: MATERIAL, ticketStore: failingStore, ticketInbox: inbox, expectedComponentAppId: APP_ID, now: () => NOW } })
    expect(first?.status).toBe(500)
    expect(await inbox.listDead()).toHaveLength(1)
    // 微信重试（重建 nonce 防线）：inbox 判重 → 200，但事件仍在 dead-letter
    const freshStore = {
      save: async () => undefined,
      load: async () => undefined,
      count: async () => 0,
      acceptOnce: async () => true,
    }
    const retry = await handleWechatCallback({ ...req, options: { cryptoMaterial: MATERIAL, ticketStore: freshStore, ticketInbox: inbox, expectedComponentAppId: APP_ID, now: () => NOW } })
    expect(retry?.status).toBe(200)
    expect(await inbox.listDead()).toHaveLength(1)
  })
})

describe('P3-09 轮询兜底与对账', () => {
  function makeReconciliation(overrides: Partial<ConstructorParameters<typeof WechatReconciliationService>[0]> = {}) {
    const ticketStore = new InMemoryWechatComponentTicketStore()
    const tokenCache = new Map<string, { componentAccessToken: string; expiresAt: number; acquiredAt: number }>()
    const componentTokenService = new WechatComponentTokenService({
      componentAppId: APP_ID,
      componentAppSecret: 's',
      ticketStore,
      tokenCacheStore: {
        save: async (record) => { tokenCache.set(record.componentAppId, { componentAccessToken: record.componentAccessToken, expiresAt: record.expiresAt, acquiredAt: record.acquiredAt }) },
        load: async (appId) => { const row = tokenCache.get(appId); return row ? { componentAppId: appId, ...row } : undefined },
      },
      now: () => NOW,
      fetchFn: (async () => new FakeResponse({ component_access_token: 'ct', expires_in: 7200 }) as unknown as Response) as unknown as typeof fetch,
    })
    const authorizerStore = new InMemoryWechatAuthorizerStore()
    const logs: string[] = []
    const service = new WechatReconciliationService({
      componentAppId: APP_ID,
      ticketStore,
      componentTokenService,
      authorizerStore,
      now: () => NOW,
      logger: { info: () => undefined, warn: (message: string) => logs.push(message) },
      fetchFn: (async () => new FakeResponse({ authorizer_list: [] }) as unknown as Response) as unknown as typeof fetch,
      ...overrides,
    })
    return { service, ticketStore, authorizerStore, logs }
  }

  test('ticket 新鲜：receivedAt 在阈值内 → ticketFresh=true', async () => {
    const { service, ticketStore } = makeReconciliation()
    await ticketStore.save({ componentAppId: APP_ID, ticket: 't', receivedAt: NOW - 5 * 60 * 1000 })
    const report = await service.reconcile()
    expect(report.ticketFresh).toBe(true)
    expect(report.ticketLastReceivedAt).toBe(NOW - 5 * 60 * 1000)
  })

  test('ticket 过期：超过 15 分钟未更新 → 告警', async () => {
    const { service, ticketStore, logs } = makeReconciliation()
    await ticketStore.save({ componentAppId: APP_ID, ticket: 't', receivedAt: NOW - 20 * 60 * 1000 })
    const report = await service.reconcile()
    expect(report.ticketFresh).toBe(false)
    expect(logs.some((line) => line.includes('回调链路可能中断'))).toBe(true)
  })

  test('从未收到 ticket → 告警', async () => {
    const { service, logs } = makeReconciliation()
    const report = await service.reconcile()
    expect(report.ticketFresh).toBe(false)
    expect(logs.some((line) => line.includes('从未收到'))).toBe(true)
  })

  test('对账恢复丢回调：本地 active 远端已移除 → 标记 revoked（轮询兜底 unauthorized）', async () => {
    const { service, authorizerStore, ticketStore } = makeReconciliation({
      fetchFn: (async () => new FakeResponse({ authorizer_list: [{ authorizer_appid: 'wx-other' }] }) as unknown as Response) as unknown as typeof fetch,
    })
    await ticketStore.save({ componentAppId: APP_ID, ticket: 't', receivedAt: NOW })
    await authorizerStore.save({
      authorizerAppId: 'wx-gone',
      tenantId: 't1',
      authorizerAccessToken: 'a',
      authorizerRefreshToken: 'r',
      tokenExpiresAt: NOW + 7000_000,
      tokenAcquiredAt: NOW,
      nickname: 'n',
      accountType: '0',
      status: 'active',
      authorizedAt: NOW,
      updatedAt: NOW,
    })
    const report = await service.reconcile()
    expect(report.revokedByReconciliation).toEqual(['wx-gone'])
    expect((await authorizerStore.load('wx-gone'))?.status).toBe('revoked')
    expect(report.missingLocally).toEqual(['wx-other'])
  })

  test('远端列表接口失败：对账降级为仅 ticket 检查，不抛错', async () => {
    const { service, ticketStore } = makeReconciliation({
      fetchFn: (async () => { throw new Error('network down') }) as unknown as typeof fetch,
    })
    await ticketStore.save({ componentAppId: APP_ID, ticket: 't', receivedAt: NOW })
    const report = await service.reconcile()
    expect(report.ticketFresh).toBe(true)
    expect(report.revokedByReconciliation).toEqual([])
  })
})

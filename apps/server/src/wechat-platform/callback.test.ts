import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { encryptWechatMessage } from './message-crypto'
import {
  CALLBACK_FRESHNESS_MS,
  handleWechatCallback,
  type WechatCallbackHandlerOptions,
} from './callback'
import { InMemoryWechatComponentTicketStore, PostgresWechatComponentTicketStore } from './ticket-store'

const MATERIAL = { token: 'cb-token', encodingAesKey: 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ' }
const COMPONENT_APP_ID = 'wx1234567890abcdef'
const NOW = 1_700_000_000_000

function makeOptions(overrides: Partial<WechatCallbackHandlerOptions> = {}): WechatCallbackHandlerOptions & { logs: string[] } {
  const logs: string[] = []
  const logger = {
    info: (message: string) => logs.push(`info:${message}`),
    warn: (message: string) => logs.push(`warn:${message}`),
  }
  return {
    cryptoMaterial: MATERIAL,
    ticketStore: new InMemoryWechatComponentTicketStore(),
    expectedComponentAppId: COMPONENT_APP_ID,
    logger,
    now: () => NOW,
    logs,
    ...overrides,
  }
}

function ticketXml(appId = COMPONENT_APP_ID, ticket = 'ticket-value-1'): string {
  return `<xml><AppId><![CDATA[${appId}]]></AppId><CreateTime>1700000000</CreateTime><InfoType>component_verify_ticket</InfoType><ComponentVerifyTicket><![CDATA[${ticket}]]></ComponentVerifyTicket></xml>`
}

function encryptedBody(appId: string, xml: string): string {
  return encryptWechatMessage({ ...MATERIAL, message: xml, receiveId: appId })
}

function signatureOf(parts: { timestamp: string; nonce: string; encrypt: string }): string {
  // 与服务端相同的签名算法（sha1 字典序拼接），由 message-crypto 提供以保证一致。
  const { computeWechatCallbackSignature } = require('./message-crypto') as typeof import('./message-crypto')
  return computeWechatCallbackSignature({ token: MATERIAL.token, ...parts })
}

async function postTicket(options: WechatCallbackHandlerOptions & { logs: string[] }, input: {
  appId?: string
  xml?: string
  ticket?: string
  tamperSignature?: boolean
  timestamp?: string
  nonce?: string
  replay?: boolean
}) {
  const appId = input.appId ?? COMPONENT_APP_ID
  const xml = input.xml ?? ticketXml(appId, input.ticket)
  const encrypt = encryptedBody(appId, xml)
  const timestamp = input.timestamp ?? String(Math.floor(NOW / 1000))
  const nonce = input.nonce ?? `nonce-${Math.random()}`
  const signature = signatureOf({ timestamp, nonce, encrypt })
  const query = new URLSearchParams({ timestamp, nonce, msg_signature: input.tamperSignature ? `${signature}0` : signature })
  return handleWechatCallback({
    method: 'POST',
    query,
    body: `<xml><AppId><![CDATA[${appId}]]></AppId><Encrypt><![CDATA[${encrypt}]]></Encrypt></xml>`,
    options: { ...options, ticketStore: input.replay ? options.ticketStore : options.ticketStore },
  })
}

describe('P3-02 回调 URL 验证（GET）', () => {
  test('验签解密成功时原样返回 echostr 明文', async () => {
    const options = makeOptions()
    const echostr = encryptedBody(COMPONENT_APP_ID, '随机验证串')
    const timestamp = String(Math.floor(NOW / 1000))
    const nonce = 'verify-nonce'
    const signature = signatureOf({ timestamp, nonce, encrypt: echostr })
    const response = await handleWechatCallback({
      method: 'GET',
      query: new URLSearchParams({ timestamp, nonce, msg_signature: signature, echostr }),
      options,
    })
    expect(response?.status).toBe(200)
    expect(await response?.text()).toBe('随机验证串')
  })

  test('签名不符返回 401', async () => {
    const options = makeOptions()
    const echostr = encryptedBody(COMPONENT_APP_ID, '随机验证串')
    const response = await handleWechatCallback({
      method: 'GET',
      query: new URLSearchParams({ timestamp: '1700000000', nonce: 'n', msg_signature: 'bad', echostr }),
      options,
    })
    expect(response?.status).toBe(401)
  })
})

describe('P3-02 ticket 回调（POST）', () => {
  test('合法 ticket 被验签、解密并加密存储，日志不含 ticket 明文', async () => {
    const options = makeOptions()
    const response = await postTicket(options, { ticket: 'secret-ticket-value' })
    expect(response?.status).toBe(200)
    expect(await response?.text()).toBe('success')

    const stored = await options.ticketStore.load(COMPONENT_APP_ID)
    expect(stored?.ticket).toBe('secret-ticket-value')
    expect(stored?.receivedAt).toBe(NOW)
    expect(await options.ticketStore.count(COMPONENT_APP_ID)).toBe(1)

    // 可观测：日志含指纹与 appid，绝无 ticket 明文
    expect(options.logs.some((line) => line.includes('component_verify_ticket') && line.includes(COMPONENT_APP_ID))).toBe(true)
    expect(options.logs.join('\n')).not.toContain('secret-ticket-value')
  })

  test('签名不符返回 401 且不落库', async () => {
    const options = makeOptions()
    const response = await postTicket(options, { tamperSignature: true })
    expect(response?.status).toBe(401)
    expect(await options.ticketStore.load(COMPONENT_APP_ID)).toBeUndefined()
  })

  test('过期时间戳返回 401（重放窗口之外）', async () => {
    const options = makeOptions()
    const response = await postTicket(options, { timestamp: String(Math.floor((NOW - CALLBACK_FRESHNESS_MS - 60_000) / 1000)) })
    expect(response?.status).toBe(401)
    expect(options.logs.some((line) => line.includes('新鲜度窗口'))).toBe(true)
  })

  test('重放同一请求被拒绝（timestamp+nonce 消重）', async () => {
    const options = makeOptions()
    // 构造一次合法请求并捕获完整请求（攻击者能原样重放捕获到的报文）
    const timestamp = String(Math.floor(NOW / 1000))
    const nonce = 'fixed-nonce'
    const xml = ticketXml(COMPONENT_APP_ID, 'ticket-once')
    const encrypt = encryptedBody(COMPONENT_APP_ID, xml)
    const signature = signatureOf({ timestamp, nonce, encrypt })
    const body = `<xml><AppId><![CDATA[${COMPONENT_APP_ID}]]></AppId><Encrypt><![CDATA[${encrypt}]]></Encrypt></xml>`
    const replayRequest = {
      method: 'POST' as const,
      query: new URLSearchParams({ timestamp, nonce, msg_signature: signature }),
      body,
    }
    const first = await handleWechatCallback({ ...replayRequest, options })
    expect(first?.status).toBe(200)
    // 原样重放：即使签名与解密都合法，消重也必须拒绝
    const replay = await handleWechatCallback({ ...replayRequest, options })
    expect(replay?.status).toBe(401)
    expect(await replay?.text()).toBe('fail')
    // ticket 只存了一份
    expect(await options.ticketStore.count(COMPONENT_APP_ID)).toBe(1)
  })

  test('receiveId 或 AppId 与预期组件不符时拒绝', async () => {
    const options = makeOptions()
    const wrongApp = await postTicket(options, { appId: 'wx9999999999999999' })
    expect(wrongApp?.status).toBe(403)
    expect(await options.ticketStore.load('wx9999999999999999')).toBeUndefined()
  })

  test('非 ticket 授权事件返回 success 且不落库（避免微信重推）', async () => {
    const options = makeOptions()
    const xml = `<xml><AppId><![CDATA[${COMPONENT_APP_ID}]]></AppId><InfoType>authorized</InfoType></xml>`
    const response = await postTicket(options, { xml })
    expect(response?.status).toBe(200)
    expect(await options.ticketStore.load(COMPONENT_APP_ID)).toBeUndefined()
  })

  test('缺少 Encrypt 字段返回 400', async () => {
    const options = makeOptions()
    const response = await handleWechatCallback({
      method: 'POST',
      query: new URLSearchParams({ timestamp: String(Math.floor(NOW / 1000)), nonce: 'n', msg_signature: 'sig' }),
      body: '<xml></xml>',
      options,
    })
    expect(response?.status).toBe(400)
  })

  test('存储失败返回 500（微信会重推）', async () => {
    const failingStore = {
      save: async () => { throw new Error('db down') },
      load: async () => undefined,
      count: async () => 0,
      acceptOnce: async () => true,
    }
    const options = makeOptions({ ticketStore: failingStore })
    const response = await postTicket(options, {})
    expect(response?.status).toBe(500)
    expect(options.logs.some((line) => line.includes('db down'))).toBe(true)
  })
})

describe('P3-02 ticket 存储加密', () => {
  test('Postgres 存储落库的是密文，读回一致（fake client）', async () => {
    const key = new Uint8Array(32).fill(7)
    const statements: Array<{ statement: string; params: readonly unknown[] }> = []
    const client = {
      query: async <Row extends Record<string, unknown>>(statement: string, params: readonly unknown[] = []): Promise<{ rows: Row[] }> => {
        statements.push({ statement, params })
        if (statement.startsWith('SELECT encrypted_ticket')) {
          const last = statements.filter((item) => item.statement.startsWith('INSERT')).at(-1)
          return { rows: [{ encrypted_ticket: last?.params[1] as string, received_at: '1700000000000' } as unknown as Row] }
        }
        if (statement.startsWith('SELECT receive_count')) return { rows: [{ receive_count: '3' } as unknown as Row] }
        return { rows: [] as Row[] }
      },
    }
    const store = new PostgresWechatComponentTicketStore(client, key)
    await store.initializeSchema()
    await store.save({ componentAppId: COMPONENT_APP_ID, ticket: 'plain-ticket-xyz', receivedAt: NOW })

    const insert = statements.find((item) => item.statement.startsWith('INSERT'))
    expect(insert?.params[1]).not.toBe('plain-ticket-xyz')
    expect(String(insert?.params[1])).toContain('v1.')
    expect(await store.load(COMPONENT_APP_ID)).toMatchObject({ componentAppId: COMPONENT_APP_ID, ticket: 'plain-ticket-xyz', receivedAt: NOW })
    expect(await store.count(COMPONENT_APP_ID)).toBe(3)
  })

  test('nonce 消重与清理（fake client）', async () => {
    const rows: Array<Record<string, unknown>> = []
    const client = {
      query: async <Row extends Record<string, unknown>>(statement: string, params: readonly unknown[] = []) => {
        if (statement.startsWith('INSERT INTO proma_wechat_callback_nonce')) {
          if (rows.some((row) => row.nonce_key === params[0])) throw new Error('duplicate key')
          rows.push({ nonce_key: params[0], seen_at: params[1] })
        }
        if (statement.startsWith('DELETE FROM proma_wechat_callback_nonce')) {
          const threshold = Number(params[0])
          for (let index = rows.length - 1; index >= 0; index -= 1) {
            if (Number(rows[index]?.seen_at) < threshold) rows.splice(index, 1)
          }
        }
        return { rows: [] as Row[] }
      },
    }
    const store = new PostgresWechatComponentTicketStore(client, new Uint8Array(32).fill(1))
    expect(await store.acceptOnce('k-1')).toBe(true)
    expect(await store.acceptOnce('k-1')).toBe(false)
    expect(await store.acceptOnce('k-2')).toBe(true)
    // 清理阈值必须晚于已写入的 seen_at（写入用的是真实 Date.now()）
    await store.pruneNonces(Date.now() + 1_000)
    expect(await store.acceptOnce('k-1')).toBe(true)
  })

  test('Postgres 存储走真实数据库（需要 PROMA_P2_TEST_DATABASE_URL）', async () => {
    const databaseUrl = process.env.PROMA_P2_TEST_DATABASE_URL
    if (!databaseUrl) return
    const sql = new Bun.SQL(databaseUrl)
    const client = {
      query: async <Row extends Record<string, unknown>>(statement: string, params: readonly unknown[] = []) => ({
        rows: await sql.unsafe<Row[]>(statement, [...params]),
      }),
    }
    const store = new PostgresWechatComponentTicketStore(client, new Uint8Array(32).fill(9))
    await store.initializeSchema()
    await store.save({ componentAppId: `e2e-${COMPONENT_APP_ID}`, ticket: 'e2e-ticket', receivedAt: NOW })
    const loaded = await store.load(`e2e-${COMPONENT_APP_ID}`)
    expect(loaded?.ticket).toBe('e2e-ticket')
    await sql`DELETE FROM proma_wechat_component_ticket WHERE component_app_id = ${`e2e-${COMPONENT_APP_ID}`}`
    await sql.close()
  })
})

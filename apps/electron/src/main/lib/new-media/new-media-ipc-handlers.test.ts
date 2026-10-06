/**
 * 新媒体 IPC 处理器注册与入参校验的端到端单测。
 *
 * 通过 electron mock 捕获 ipcMain.handle 注册的处理器，直接调用它们，
 * 验证渲染进程传入畸形参数时在进入服务层之前就被拒绝。
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mock } from 'bun:test'
import { buildElectronMock } from '../testing/electron-mock'

mock.module('electron', () => buildElectronMock())

const { NEW_MEDIA_IPC_CHANNELS } = await import('@gravitas/shared')
const { ipcMain } = await import('electron')
const { registerNewMediaIpcHandlers } = await import('./new-media-ipc-handlers')
const { closeNewMediaDb } = await import('./new-media-sqlite-store')

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>
const handlers = new Map<string, Handler>()

let testDir = ''
beforeAll(() => {
  testDir = mkdtempSync(join(tmpdir(), 'gravitas-nm-ipc-'))
  process.env.PROMA_TEST_CONFIG_DIR = testDir
  const original = ipcMain.handle.bind(ipcMain)
  // 捕获注册结果，避免真正把处理器塞进 mock 的内部表。
  ;(ipcMain as unknown as { handle: (channel: string, listener: Handler) => void }).handle = (channel, listener) => {
    handlers.set(channel, listener)
    original(channel, listener)
  }
  registerNewMediaIpcHandlers()
})
afterAll(() => { closeNewMediaDb(); delete process.env.PROMA_TEST_CONFIG_DIR; rmSync(testDir, { recursive: true, force: true }) })

const event = { sender: null }
async function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  const handler = handlers.get(channel)
  if (!handler) throw new Error(`未注册的通道: ${channel}`)
  return handler(event, ...args)
}

const ALL_NEW_MEDIA_CHANNELS = Object.values(NEW_MEDIA_IPC_CHANNELS) as string[]

describe('新媒体 IPC 处理器', () => {
  test('所有新媒体通道均已注册', () => {
    const missing = ALL_NEW_MEDIA_CHANNELS.filter((channel) => !handlers.has(channel))
    expect(missing).toEqual([])
  })

  test('畸形参数在进入服务层前被稳定错误拒绝', async () => {
    await expect(invoke(NEW_MEDIA_IPC_CHANNELS.CREATE_DRAFT, 'x', ['weibo'])).rejects.toThrow('new_media:invalid_enum:平台')
    await expect(invoke(NEW_MEDIA_IPC_CHANNELS.CREATE_DRAFT, '', ['xiaohongshu'])).rejects.toThrow('new_media:invalid_text:sourceText')
    await expect(invoke(NEW_MEDIA_IPC_CHANNELS.CREATE_DRAFT, 'a'.repeat(20001), ['xiaohongshu'])).rejects.toThrow('new_media:text_too_long:sourceText')
    await expect(invoke(NEW_MEDIA_IPC_CHANNELS.SCHEDULE_PUBLICATION, { platform: 'xiaohongshu' })).rejects.toThrow('new_media:')
    await expect(invoke(NEW_MEDIA_IPC_CHANNELS.SCHEDULE_PUBLICATION, { draftId: 'd', platform: 'xiaohongshu', accountId: 'a', scheduledAt: Date.now() - 1 })).rejects.toThrow('new_media:invalid_timestamp:scheduledAt')
    await expect(invoke(NEW_MEDIA_IPC_CHANNELS.CREATE_LISTENING_QUERY, [])).rejects.toThrow('new_media:invalid_array:keywords')
    await expect(invoke(NEW_MEDIA_IPC_CHANNELS.INGEST_MENTION, { queryId: 'q', platform: 'xiaohongshu', sourceUrl: 'javascript:alert(1)', text: 'x' })).rejects.toThrow('new_media:invalid_url:sourceUrl')
    await expect(invoke(NEW_MEDIA_IPC_CHANNELS.GET_ACCOUNT_AUDIT, '')).rejects.toThrow('new_media:invalid_text:accountId')
    await expect(invoke(NEW_MEDIA_IPC_CHANNELS.GET_ADAPTER_INFO, 'douyin')).rejects.toThrow('new_media:invalid_enum:平台')
    await expect(invoke(NEW_MEDIA_IPC_CHANNELS.GET_SOCIAL_REPORT, 'not-a-number', Date.now())).rejects.toThrow('new_media:invalid_number:periodStart')
  })

  test('合法调用可写入并按通道读回，未登记事件不会进入审计', async () => {
    const draft = await invoke(NEW_MEDIA_IPC_CHANNELS.CREATE_DRAFT, '烟测内容', ['xiaohongshu']) as { id: string }
    expect(draft.id).toBeDefined()

    const job = await invoke(NEW_MEDIA_IPC_CHANNELS.SCHEDULE_PUBLICATION, {
      draftId: draft.id, platform: 'xiaohongshu', accountId: 'account-1', scheduledAt: Date.now() + 60_000,
    }) as { status: string }
    expect(job.status).toBe('pending_approval')

    const jobs = await invoke(NEW_MEDIA_IPC_CHANNELS.LIST_PUBLICATION_JOBS) as Array<{ id: string }>
    expect(jobs.map((item) => item.id)).toContain((job as unknown as { id: string }).id)

    const schema = await invoke(NEW_MEDIA_IPC_CHANNELS.GET_SCHEMA_INFO) as { version: number; unknownKinds: string[] }
    expect(schema.version).toBeGreaterThanOrEqual(2)
    expect(schema.unknownKinds).toEqual([])

    const handoff = await invoke(NEW_MEDIA_IPC_CHANNELS.PREPARE_XHS_HANDOFF, draft.id) as { status: string; id: string }
    expect(handoff.status).toBe('draft_ready')
    await expect(invoke(NEW_MEDIA_IPC_CHANNELS.CONFIRM_XHS_PUBLISHED, handoff.id, 'Carol')).rejects.toThrow('必须先完成发布交接')
    const audit = await invoke(NEW_MEDIA_IPC_CHANNELS.GET_XHS_HANDOFF_AUDIT, handoff.id) as Array<{ event: string }>
    expect(audit.map((entry) => entry.event)).toEqual(['prepared'])
  })

  test('账号能力查询只读且不含凭据字段', async () => {
    const account = await invoke(NEW_MEDIA_IPC_CHANNELS.CREATE_ACCOUNT, { platform: 'wechat-official-account', displayName: '服务号' }) as { id: string }
    const result = await invoke(NEW_MEDIA_IPC_CHANNELS.GET_ACCOUNT_CAPABILITIES, account.id) as { capabilities: unknown[]; profile: unknown }
    expect(result.capabilities).toEqual([])
    expect(result.profile).toBeNull()
    await expect(invoke(NEW_MEDIA_IPC_CHANNELS.GET_ACCOUNT_CAPABILITIES, '')).rejects.toThrow('new_media:invalid_text:accountId')
  })

  test('受控外发与账号通道保持无密钥契约', async () => {
    await expect(invoke(NEW_MEDIA_IPC_CHANNELS.CREATE_ACCOUNT, { platform: 'xiaohongshu', displayName: '小红书主号' })).resolves.toBeDefined()
    // 渲染进程无法直接提交 token 类字段：多余字段不会进入持久化记录。
    const account = await invoke(NEW_MEDIA_IPC_CHANNELS.CREATE_ACCOUNT, { platform: 'xiaohongshu', displayName: '主号2', accessToken: 'should-be-ignored' }) as Record<string, unknown>
    expect(JSON.stringify(account)).not.toContain('should-be-ignored')

    const action = await invoke(NEW_MEDIA_IPC_CHANNELS.REQUEST_CONTROLLED_ACTION, { kind: 'publish', platform: 'xiaohongshu', targetId: 'draft-1', summary: '发布' }) as { id: string }
    await expect(invoke(NEW_MEDIA_IPC_CHANNELS.SIMULATE_CONTROLLED_ACTION, action.id)).rejects.toThrow('尚未批准')
    await invoke(NEW_MEDIA_IPC_CHANNELS.APPROVE_CONTROLLED_ACTION, action.id)
    await invoke(NEW_MEDIA_IPC_CHANNELS.REJECT_CONTROLLED_ACTION, action.id, '内容表述需要复核')
    const audit = await invoke(NEW_MEDIA_IPC_CHANNELS.GET_CONTROLLED_ACTION_AUDIT, action.id) as Array<{ event: string }>
    expect(audit.map((entry) => entry.event)).toEqual(['requested', 'approved', 'rejected'])
  })
})

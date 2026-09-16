import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { setRuntimeSecretCodecForTesting } from '../agent-runtime/runtime-secret-codec'
import type { PlatformAdapter } from './platform-adapter'
import { LOCAL_ONLY_CAPABILITIES, PlatformAdapterError } from './platform-adapter'
import { PlatformAdapterRegistry, setPlatformAdapterRegistryForTesting } from './platform-adapter-registry'
import { closeNewMediaDb } from './new-media-sqlite-store'
import { getNewMediaDir } from '../config-paths'
import {
  beginNewMediaAccountAuthorization,
  completeNewMediaAccountAuthorization,
  createNewMediaAccount,
  disconnectNewMediaAccount,
  getNewMediaAccountAudit,
  listNewMediaAccounts,
  validateNewMediaAccount,
} from './new-media-account-service'

let testDir = ''
const codec = {
  encode: (plain: string) => Buffer.from(`protected:${plain}`).toString('base64'),
  decode: (encoded: string) => Buffer.from(encoded, 'base64').toString('utf-8').replace(/^protected:/, ''),
}

const fakeAdapter: PlatformAdapter = {
  platform: 'xiaohongshu',
  displayName: '小红书 Fake',
  authorization: { method: 'oauth2', available: true, description: '测试授权', requestedScopes: ['content.read'] },
  getCapabilities: () => ({ ...LOCAL_ONLY_CAPABILITIES, readMetrics: true }),
  async beginAuthorization() {},
  async validateAuthorization(material) {
    if (material.accessToken !== 'valid-token') throw new PlatformAdapterError('invalid_credentials', '无效凭据')
    return { externalAccountId: 'xhs-100', displayName: '已连接账号', grantedScopes: ['content.read'], expiresAt: Date.now() + 60_000 }
  },
}

beforeAll(() => {
  testDir = mkdtempSync(join(tmpdir(), 'gravitas-new-media-account-'))
  process.env.PROMA_TEST_CONFIG_DIR = testDir
  setRuntimeSecretCodecForTesting(codec)
})

afterAll(() => {
  closeNewMediaDb()
  setPlatformAdapterRegistryForTesting()
  setRuntimeSecretCodecForTesting()
  delete process.env.PROMA_TEST_CONFIG_DIR
  rmSync(testDir, { recursive: true, force: true })
})

describe('新媒体账号授权状态机', () => {
  test('生产本地 Adapter 不会把账号伪装成已连接', async () => {
    setPlatformAdapterRegistryForTesting()
    const account = await createNewMediaAccount({ platform: 'wechat-official-account', displayName: '品牌公众号' })
    const result = await beginNewMediaAccountAuthorization(account.id)
    expect(result.available).toBe(false)
    expect((await listNewMediaAccounts()).find((item) => item.id === account.id)?.status).toBe('disconnected')
  })

  test('授权材料加密隔离，连接、校验与断开均可审计', async () => {
    const registry = new PlatformAdapterRegistry()
    registry.register(fakeAdapter)
    setPlatformAdapterRegistryForTesting(registry)
    const account = await createNewMediaAccount({ platform: 'xiaohongshu', displayName: '占位名' })
    expect((await beginNewMediaAccountAuthorization(account.id)).status).toBe('authorization_pending')
    const connected = await completeNewMediaAccountAuthorization(account.id, { accessToken: 'valid-token', refreshToken: 'refresh-secret' })
    expect(connected.status).toBe('connected')
    expect(connected.externalAccountId).toBe('xhs-100')

    const dbBytes = readFileSync(join(getNewMediaDir(), 'new-media.db'))
    expect(dbBytes.includes(Buffer.from('valid-token'))).toBe(false)
    const secretBytes = readFileSync(join(getNewMediaDir(), 'account-secrets.enc'))
    expect(secretBytes.includes(Buffer.from('valid-token'))).toBe(false)

    closeNewMediaDb()
    expect((await validateNewMediaAccount(account.id)).status).toBe('connected')
    const disconnected = await disconnectNewMediaAccount(account.id)
    expect(disconnected.status).toBe('disconnected')
    expect(disconnected.credentialRef).toBeUndefined()
    expect((await getNewMediaAccountAudit(account.id)).map((entry) => entry.event)).toContain('connected')
  })

  test('无效授权不会保存凭据并进入错误状态', async () => {
    const registry = new PlatformAdapterRegistry()
    registry.register(fakeAdapter)
    setPlatformAdapterRegistryForTesting(registry)
    const account = await createNewMediaAccount({ platform: 'xiaohongshu', displayName: '失败账号' })
    await expect(completeNewMediaAccountAuthorization(account.id, { accessToken: 'bad-token' })).rejects.toThrow('无效凭据')
    const stored = (await listNewMediaAccounts()).find((item) => item.id === account.id)
    expect(stored?.status).toBe('error')
    expect(stored?.credentialRef).toBeUndefined()
  })
})

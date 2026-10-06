import { describe, expect, test } from 'bun:test'
import { createDefaultPlatformAdapterRegistry, PlatformAdapterRegistry } from './platform-adapter-registry'
import { PlatformAdapterError } from './platform-adapter'

describe('新媒体平台 Adapter', () => {
  test('内置平台只声明本地草稿能力', () => {
    const registry = createDefaultPlatformAdapterRegistry()
    for (const adapter of registry.list()) {
      expect(adapter.getCapabilities()).toEqual({
        localDraft: true,
        remoteDraft: false,
        publish: false,
        readEngagements: false,
        sendReply: false,
        readMetrics: false,
      })
      expect(adapter.authorization.available).toBe(false)
    }
  })

  test('当前本地 Adapter 明确拒绝真实授权', async () => {
    const adapter = createDefaultPlatformAdapterRegistry().get('xiaohongshu')
    const account = {
      id: 'account-1', platform: 'xiaohongshu' as const, displayName: '测试账号', status: 'disconnected' as const,
      authorizationMethod: 'unavailable' as const, grantedScopes: [], capabilities: adapter.getCapabilities(),
      credentialProtection: 'none' as const, createdAt: 1, updatedAt: 1,
    }
    await expect(adapter.beginAuthorization(account)).rejects.toMatchObject({ code: 'authorization_unavailable' })
  })

  test('registry 拒绝重复注册并为缺失平台返回稳定错误', () => {
    const source = createDefaultPlatformAdapterRegistry().get('xiaohongshu')
    const registry = new PlatformAdapterRegistry()
    registry.register(source)
    expect(() => registry.register(source)).toThrow('已注册')
    expect(() => registry.get('wechat-official-account')).toThrow(PlatformAdapterError)
  })
})

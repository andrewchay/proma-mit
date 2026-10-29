import { afterAll, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const configDir = mkdtempSync(join(tmpdir(), 'model-context-config-'))
process.env.PROMA_TEST_CONFIG_DIR = configDir
afterAll(() => { rmSync(configDir, { recursive: true, force: true }); delete process.env.PROMA_TEST_CONFIG_DIR })
mock.module('electron', () => ({
  safeStorage: { isEncryptionAvailable: () => true, encryptString: (value: string) => Buffer.from(value), decryptString: (value: Buffer) => value.toString() },
  app: { getPath: () => configDir, getName: () => 'gravitas', getVersion: () => '0.0.0' },
  shell: { openExternal: async () => undefined },
}))
mock.module('./config-audit-service', () => ({ appendConfigAudit: async () => undefined, redactSensitive: (value: unknown) => value }))
const { createChannel, getChannelById, updateChannel } = await import('./channel-manager')

describe('模型窗口配置持久化', () => {
  test('保存 API 与手动值，切换端点后清除旧 API 值，保留手动配置', () => {
    const channel = createChannel({ provider: 'google', name: '测试', baseUrl: 'https://google.test', apiKey: 'fake', enabled: true,
      models: [{ id: 'gemini-4-argon', name: 'Gemini', enabled: true, contextWindow: 1_048_576, contextWindowSource: 'api', contextWindowOverride: 512_000 }] })
    expect(getChannelById(channel.id)?.models[0]?.contextWindowOverride).toBe(512_000)
    updateChannel(channel.id, { name: '改名' })
    expect(getChannelById(channel.id)?.models[0]?.contextWindow).toBe(1_048_576)
    updateChannel(channel.id, { baseUrl: 'https://relay.test' })
    expect(getChannelById(channel.id)?.models[0]).toMatchObject({ contextWindowOverride: 512_000 })
    expect(getChannelById(channel.id)?.models[0]?.contextWindow).toBe(1_048_576)
    expect(getChannelById(channel.id)?.models[0]?.contextWindowSource).toBe('catalog')
    updateChannel(channel.id, { models: [{ id: 'gemini-4-argon', name: 'Gemini', enabled: true }] })
    expect(getChannelById(channel.id)?.models[0]?.contextWindowOverride).toBeUndefined()
  })
  test('与端点一起保存的新 API 元数据不会被误删；旧配置读出时补目录值', () => {
    const channel = createChannel({ provider: 'custom', name: '旧配置', baseUrl: 'https://old.test', apiKey: 'fake', enabled: true,
      models: [{ id: 'gpt-4o', name: 'GPT', enabled: true }] })
    expect(getChannelById(channel.id)?.models[0]).toMatchObject({ contextWindow: 128_000, contextWindowSource: 'catalog' })
    updateChannel(channel.id, { baseUrl: 'https://new.test', models: [{ id: 'gpt-4o', name: 'GPT', enabled: true,
      contextWindow: 100_000, contextWindowSource: 'api', contextWindowEndpoint: JSON.stringify(['custom', 'https://new.test']) }] })
    expect(getChannelById(channel.id)?.models[0]).toMatchObject({ contextWindow: 100_000, contextWindowSource: 'api' })
  })
  test('IPC 写入同样拒绝无效窗口，不依赖表单校验', () => {
    expect(() => createChannel({ provider: 'custom', name: '测试', baseUrl: 'https://relay.test', apiKey: 'fake', enabled: true,
      models: [{ id: 'unknown', name: 'unknown', enabled: true, contextWindowOverride: -1 }] })).toThrow('正整数')
  })
})

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { setMcpClientSecret, listMcpClientSecrets } from './agent-runtime/mcp-client-secret-store'
import { credentialRegistryToText, listCredentials } from './credential-registry-service'

/**
 * PH2-D 凭据统一治理测试：
 * - listMcpClientSecrets 枚举（of MCP secret store）
 * - 渠道来源必须读取权威 channels.json（而非 settings.json），且不产生写入副作用
 * - 来源读取失败必须进入 sourceErrors，不能伪装成「无风险」
 * - credentialRegistryToText 摘要格式
 * 注：credential-registry 的 feishu/dingtalk/新媒体源依赖 electron，仅在真实环境取到。
 */

const testDir = join(tmpdir(), `gravitas-credreg-test-${Date.now()}`)

beforeAll(async () => {
  process.env.PROMA_TEST_CONFIG_DIR = testDir
})

afterAll(() => {
  try {
    rmSync(testDir, { recursive: true, force: true })
  } catch {
    // 忽略
  }
  delete process.env.PROMA_TEST_CONFIG_DIR
})

describe('凭据统一治理（PH2-D）', () => {
  test('MCP client_secret 枚举', () => {
    setMcpClientSecret('ws-1', 'server-a', 'secret-xyz')
    const list = listMcpClientSecrets()
    expect(list.some((c) => c.workspaceSlug === 'ws-1' && c.serverName === 'server-a' && c.hasSecret)).toBe(true)
  })

  test('渠道来源读取权威 channels.json，而非 settings.json', async () => {
    const { getChannelsPath } = await import('./config-paths')
    writeFileSync(getChannelsPath(), JSON.stringify({
      version: 1,
      channels: [
        { id: 'ch-1', name: 'DeepSeek', provider: 'deepseek', apiKey: 'encrypted-or-plain', enabled: true },
        { id: 'ch-2', name: 'Kimi', provider: 'custom', enabled: false },
      ],
    }))
    const registry = await listCredentials()
    const channels = registry.entries.filter((entry) => entry.kind === 'channel')
    expect(channels.map((entry) => entry.id).sort()).toEqual(['ch-1', 'ch-2'])
    expect(channels.find((entry) => entry.id === 'ch-1')?.hasSecret).toBe(true)
    expect(channels.find((entry) => entry.id === 'ch-2')?.hasSecret).toBe(false)
    // 缺少密钥的渠道必须进入风险列表
    expect(registry.risks.some((risk) => risk.includes('Kimi'))).toBe(true)
  })

  test('渠道来源读取失败进入 sourceErrors，不伪装成无风险', async () => {
    const { getChannelsPath } = await import('./config-paths')
    mkdirSync(join(testDir, 'proactive'), { recursive: true })
    writeFileSync(getChannelsPath(), '{"version":1,"channels":"not-an-array"}')
    const registry = await listCredentials()
    expect(registry.sourceErrors.some((message) => message.startsWith('渠道'))).toBe(true)
    // 有来源错误时摘要必须标记结果不完整
    expect(credentialRegistryToText(registry)).toContain('来源检查失败')
  })

  test('体检摘要生成', () => {
    setMcpClientSecret('ws-1', 'server-b', 'secret-abc')
    const text = credentialRegistryToText({ entries: [], count: 0, riskCount: 0, risks: [], sourceErrors: [], checkedAt: Date.now() })
    expect(text).toContain('凭据统一体检')
    expect(text).toContain('无凭据风险')
  })

  test('有风险时展示风险列表', () => {
    const text = credentialRegistryToText({ entries: [], count: 2, riskCount: 1, risks: ['渠道「x」未配置 API Key'], sourceErrors: [], checkedAt: Date.now() })
    expect(text).toContain('⚠ 风险 1 项')
    expect(text).toContain('渠道「x」')
  })
})

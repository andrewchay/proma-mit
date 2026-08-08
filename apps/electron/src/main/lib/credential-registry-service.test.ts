import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { rmSync } from 'node:fs'
import { setMcpClientSecret, listMcpClientSecrets } from './agent-runtime/mcp-client-secret-store'
import { credentialRegistryToText } from './credential-registry-service'

/**
 * PH2-D 凭据统一治理测试：
 * - listMcpClientSecrets 枚举（of MCP secret store）
 * - credentialRegistryToText 摘要格式
 * 注：credential-registry 的 feishu/dingtalk/渠道源依赖 electron，仅在真实环境取到。
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

  test('体检摘要生成', () => {
    setMcpClientSecret('ws-1', 'server-b', 'secret-abc')
    const text = credentialRegistryToText({ entries: [], count: 0, riskCount: 0, risks: [] })
    expect(text).toContain('凭据统一体检')
    expect(text).toContain('无凭据风险')
  })

  test('有风险时展示风险列表', () => {
    const text = credentialRegistryToText({ entries: [], count: 2, riskCount: 1, risks: ['渠道「x」未配置 API Key'] })
    expect(text).toContain('⚠ 风险 1 项')
    expect(text).toContain('渠道「x」')
  })
})

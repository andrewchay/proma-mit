import { mock, describe, test, expect, beforeEach } from 'bun:test'
import type { Channel } from '@gravitas/shared'

/**
 * video-credential-resolver 单元测试
 *
 * 覆盖「渠道（模型配置页）优先 → 环境变量兜底」的凭据解析逻辑：
 *  - seedance    → doubao 渠道，baseUrl 归一化 /api/v3，模型选择
 *  - minimax-h3  → minimax 渠道，Anthropic baseUrl 推导 /v1
 *  - 禁用 / 无 Key / 解密失败渠道均跳过
 *  - 显式 channelId 精确命中
 *  - 无可用渠道回退 process.env
 *
 * mock 掉 channel-manager（listChannels / decryptApiKey），不触磁盘与 safeStorage。
 */

// ---- mock 数据源（可在每个测试中重写） ----
let mockChannels: Channel[] = []

/** 标记：解密失败的渠道 key（模拟 safeStorage 解密抛错） */
const DECRYPT_FAIL_MARK = '__DECRYPT_FAIL__'

mock.module('../../channel-manager', () => ({
  listChannels: () => mockChannels,
  decryptApiKey: (channelId: string) => {
    const ch = mockChannels.find((c) => c.id === channelId)
    if (!ch) throw new Error(`渠道不存在: ${channelId}`)
    if (ch.apiKey.startsWith(DECRYPT_FAIL_MARK)) throw new Error('解密 API Key 失败')
    return ch.apiKey
  },
}))

const {
  resolveSeedanceConfig,
  resolveMiniMaxConfig,
  resolveVideoEngineConfig,
  SEEDANCE_DEFAULT_MODEL,
} = await import('./video-credential-resolver')

// ---- 工厂函数 ----
function makeChannel(partial: Partial<Channel> & Pick<Channel, 'id' | 'provider'>): Channel {
  const now = Date.now()
  return {
    name: partial.id,
    baseUrl: partial.provider === 'doubao' ? 'https://ark.cn-beijing.volces.com/api/v3' : 'https://api.minimaxi.com/anthropic',
    apiKey: '',
    models: [],
    enabled: true,
    createdAt: now,
    updatedAt: now,
    ...partial,
  }
}

function makeDoubaoChannel(overrides: Partial<Channel> = {}): Channel {
  return makeChannel({
    id: 'ch-doubao',
    name: '豆包视频渠道',
    provider: 'doubao',
    baseUrl: 'https://ark.cn-beijing.volces.com',
    apiKey: 'doubao-secret',
    models: [{ id: 'doubao-seedance-2-5-260628', name: 'Seedance 2.5', enabled: true }],
    ...overrides,
  })
}

function makeMiniMaxChannel(overrides: Partial<Channel> = {}): Channel {
  return makeChannel({
    id: 'ch-minimax',
    name: 'MiniMax 渠道',
    provider: 'minimax',
    baseUrl: 'https://api.minimaxi.com/anthropic',
    apiKey: 'minimax-secret',
    models: [],
    ...overrides,
  })
}

beforeEach(() => {
  mockChannels = []
  delete process.env.VOLCENGINE_API_KEY
  delete process.env.MINIMAX_API_KEY
})

// ============================================================
// Seedance（doubao 渠道）
// ============================================================

describe('resolveSeedanceConfig', () => {
  test('无渠道且无环境变量 → env 兜底，空 key，默认模型', () => {
    const cfg = resolveSeedanceConfig()
    expect(cfg.source).toBe('env')
    expect(cfg.apiKey).toBe('')
    expect(cfg.model).toBe(SEEDANCE_DEFAULT_MODEL)
    expect(cfg.baseUrl).toBe('https://ark.cn-beijing.volces.com/api/v3')
    expect(cfg.channelId).toBeUndefined()
  })

  test('有可用 doubao 渠道 → channel 优先，key 取自渠道，模型取自渠道', () => {
    mockChannels = [makeDoubaoChannel()]
    const cfg = resolveSeedanceConfig()
    expect(cfg.source).toBe('channel')
    expect(cfg.apiKey).toBe('doubao-secret')
    expect(cfg.channelId).toBe('ch-doubao')
    expect(cfg.channelName).toBe('豆包视频渠道')
    expect(cfg.model).toBe('doubao-seedance-2-5-260628')
  })

  test('doubao 渠道 baseUrl 无 /api/v3 路径 → 自动归一化追加', () => {
    mockChannels = [makeDoubaoChannel({ baseUrl: 'https://ark.cn-beijing.volces.com' })]
    const cfg = resolveSeedanceConfig()
    expect(cfg.baseUrl).toBe('https://ark.cn-beijing.volces.com/api/v3')
  })

  test('doubao 渠道 baseUrl 带尾斜杠 → 归一化不重复追加', () => {
    mockChannels = [makeDoubaoChannel({ baseUrl: 'https://ark.cn-beijing.volces.com/api/v3/' })]
    const cfg = resolveSeedanceConfig()
    expect(cfg.baseUrl).toBe('https://ark.cn-beijing.volces.com/api/v3')
  })

  test('渠道已指定 /api/v1 等路径 → 保留原路径', () => {
    mockChannels = [makeDoubaoChannel({ baseUrl: 'https://gateway.example.com/api/v4' })]
    const cfg = resolveSeedanceConfig()
    expect(cfg.baseUrl).toBe('https://gateway.example.com/api/v4')
  })

  test('渠道无 seedance 模型 → 使用默认模型', () => {
    mockChannels = [makeDoubaoChannel({ models: [{ id: 'doubao-1-5-pro', name: '豆包 1.5', enabled: true }] })]
    const cfg = resolveSeedanceConfig()
    expect(cfg.model).toBe(SEEDANCE_DEFAULT_MODEL)
  })

  test('多个 doubao 渠道 → 取第一个启用且有 key 的', () => {
    mockChannels = [
      makeDoubaoChannel({ id: 'ch-doubao-1', name: '第一个' }),
      makeDoubaoChannel({ id: 'ch-doubao-2', name: '第二个', apiKey: 'key-2' }),
    ]
    const cfg = resolveSeedanceConfig()
    expect(cfg.channelId).toBe('ch-doubao-1')
  })

  test('渠道 disabled → 跳过，回退 env', () => {
    mockChannels = [makeDoubaoChannel({ enabled: false })]
    process.env.VOLCENGINE_API_KEY = 'env-key'
    const cfg = resolveSeedanceConfig()
    expect(cfg.source).toBe('env')
    expect(cfg.apiKey).toBe('env-key')
  })

  test('渠道 apiKey 为空 → 视为不可用，回退 env', () => {
    mockChannels = [makeDoubaoChannel({ apiKey: '' })]
    process.env.VOLCENGINE_API_KEY = 'env-key'
    const cfg = resolveSeedanceConfig()
    expect(cfg.source).toBe('env')
    expect(cfg.apiKey).toBe('env-key')
  })

  test('渠道解密失败 → 跳过该渠道，回退 env', () => {
    mockChannels = [makeDoubaoChannel({ apiKey: `${DECRYPT_FAIL_MARK}corrupted` })]
    process.env.VOLCENGINE_API_KEY = 'env-key'
    const cfg = resolveSeedanceConfig()
    expect(cfg.source).toBe('env')
    expect(cfg.apiKey).toBe('env-key')
  })

  test('显式指定可用 channelId → 精确命中该渠道', () => {
    mockChannels = [
      makeDoubaoChannel({ id: 'ch-a', apiKey: 'key-a' }),
      makeDoubaoChannel({ id: 'ch-b', apiKey: 'key-b', models: [{ id: 'doubao-seedance-1-0', name: 'Seedance 1.0', enabled: true }] }),
    ]
    const cfg = resolveSeedanceConfig('ch-b')
    expect(cfg.channelId).toBe('ch-b')
    expect(cfg.apiKey).toBe('key-b')
    expect(cfg.model).toBe('doubao-seedance-1-0')
  })

  test('显式指定不存在的 channelId → 回退 env', () => {
    mockChannels = [makeDoubaoChannel()]
    process.env.VOLCENGINE_API_KEY = 'env-key'
    const cfg = resolveSeedanceConfig('ch-not-exist')
    expect(cfg.source).toBe('env')
    expect(cfg.apiKey).toBe('env-key')
  })

  test('显式指定 disabled 的 channelId → 回退 env', () => {
    mockChannels = [makeDoubaoChannel({ enabled: false })]
    process.env.VOLCENGINE_API_KEY = 'env-key'
    const cfg = resolveSeedanceConfig('ch-doubao')
    expect(cfg.source).toBe('env')
  })
})

// ============================================================
// MiniMax H3（minimax 渠道）
// ============================================================

describe('resolveMiniMaxConfig', () => {
  test('无渠道且无环境变量 → env 兜底，空 key', () => {
    const cfg = resolveMiniMaxConfig()
    expect(cfg.source).toBe('env')
    expect(cfg.apiKey).toBe('')
    expect(cfg.baseUrl).toBe('https://api.minimaxi.com/v1')
  })

  test('有可用 minimax 渠道 → channel 优先', () => {
    mockChannels = [makeMiniMaxChannel()]
    const cfg = resolveMiniMaxConfig()
    expect(cfg.source).toBe('channel')
    expect(cfg.apiKey).toBe('minimax-secret')
    expect(cfg.channelId).toBe('ch-minimax')
    expect(cfg.channelName).toBe('MiniMax 渠道')
  })

  test('渠道 baseUrl 以 /anthropic 结尾 → 推导为 /v1', () => {
    mockChannels = [makeMiniMaxChannel({ baseUrl: 'https://api.minimaxi.com/anthropic' })]
    const cfg = resolveMiniMaxConfig()
    expect(cfg.baseUrl).toBe('https://api.minimaxi.com/v1')
  })

  test('渠道 baseUrl 为裸域名 → 追加 /v1', () => {
    mockChannels = [makeMiniMaxChannel({ baseUrl: 'https://api.minimaxi.com' })]
    const cfg = resolveMiniMaxConfig()
    expect(cfg.baseUrl).toBe('https://api.minimaxi.com/v1')
  })

  test('minimax 渠道 disabled → 回退 env', () => {
    mockChannels = [makeMiniMaxChannel({ enabled: false })]
    process.env.MINIMAX_API_KEY = 'env-key'
    const cfg = resolveMiniMaxConfig()
    expect(cfg.source).toBe('env')
    expect(cfg.apiKey).toBe('env-key')
  })

  test('显式指定 channelId 精确命中', () => {
    mockChannels = [
      makeMiniMaxChannel({ id: 'ch-mm-1', apiKey: 'key-1' }),
      makeMiniMaxChannel({ id: 'ch-mm-2', apiKey: 'key-2' }),
    ]
    const cfg = resolveMiniMaxConfig('ch-mm-2')
    expect(cfg.channelId).toBe('ch-mm-2')
    expect(cfg.apiKey).toBe('key-2')
  })
})

// ============================================================
// 统一入口
// ============================================================

describe('resolveVideoEngineConfig', () => {
  test('seedance → doubao 渠道解析', () => {
    mockChannels = [makeDoubaoChannel()]
    const cfg = resolveVideoEngineConfig('seedance')
    expect(cfg.source).toBe('channel')
    expect(cfg.model).toBe('doubao-seedance-2-5-260628')
  })

  test('minimax-h3 → minimax 渠道解析', () => {
    mockChannels = [makeMiniMaxChannel()]
    const cfg = resolveVideoEngineConfig('minimax-h3')
    expect(cfg.source).toBe('channel')
    expect(cfg.baseUrl).toBe('https://api.minimaxi.com/v1')
  })

  test('引擎名不匹配 → 默认按 seedance 处理', () => {
    mockChannels = [makeDoubaoChannel()]
    const cfg = resolveVideoEngineConfig('seedance' as never)
    expect(cfg.source).toBe('channel')
  })
})

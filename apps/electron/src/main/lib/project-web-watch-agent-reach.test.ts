import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  AGENT_REACH_TEMPLATES,
  buildAgentReachArgv,
  collectAgentReachSources,
  mapEnvelopeItem,
  parseAgentReachEnvelope,
  setAgentReachProbe,
  setAgentReachSpawnRunner,
  validateAgentReachSource,
  type AgentReachWatchSource,
} from './project-web-watch-agent-reach'

/** 构造一条合法监控源（github 关键词搜索）。 */
function makeSource(overrides: Partial<AgentReachWatchSource> = {}): AgentReachWatchSource {
  return {
    id: 'source-1',
    channel: 'github',
    action: 'search',
    params: { query: 'agent reach', limit: 5 },
    label: 'GitHub 关键词',
    enabled: true,
    addedAt: 0,
    ...overrides,
  }
}

function envelopeJson(payload: Record<string, unknown>): string {
  return `${JSON.stringify(payload)}\n`
}

describe('监控源模板校验（BDD）', () => {
  test('Given 白名单内渠道动作与合法参数 When 校验 Then 通过', () => {
    expect(validateAgentReachSource(makeSource())).toBeNull()
  })

  test('Given 白名单外的登录渠道 When 校验 Then 拒绝', () => {
    const error = validateAgentReachSource(makeSource({ channel: 'xiaohongshu', action: 'search' }))
    expect(error).toContain('不支持的渠道动作')
  })

  test('Given 缺少必需参数 When 校验 Then 拒绝并点名参数', () => {
    expect(validateAgentReachSource(makeSource({ params: { limit: 5 } }))).toBe('缺少必需参数：query')
  })

  test('Given 模板外的参数名 When 校验 Then 拒绝', () => {
    expect(validateAgentReachSource(makeSource({ params: { query: 'x', page: 2 } }))).toBe('参数 page 不属于 github/search')
  })

  test('Given 数值参数越界 When 校验 Then 拒绝', () => {
    expect(validateAgentReachSource(makeSource({ params: { query: 'x', limit: 100 } }))).toContain('1-50 的整数')
  })
})

describe('CLI argv 拼装（BDD）', () => {
  test('Given github 搜索模板 When 拼参 Then 必需参数位置传入、可选参数 flag 传入', () => {
    const template = AGENT_REACH_TEMPLATES.find((item) => item.channel === 'github' && item.action === 'search')
    expect(buildAgentReachArgv(template!, { query: 'agent reach', limit: 5 })).toEqual(['github', 'search', 'agent reach', '--limit', '5'])
  })

  test('Given v2ex 热议模板 When 拼参 Then 无必需参数不带位置段', () => {
    const template = AGENT_REACH_TEMPLATES.find((item) => item.channel === 'v2ex' && item.action === 'hot')
    expect(buildAgentReachArgv(template!, { limit: 10 })).toEqual(['v2ex', 'hot', '--limit', '10'])
  })

  test('Given 可选参数缺省 When 拼参 Then 不生成对应 flag', () => {
    const template = AGENT_REACH_TEMPLATES.find((item) => item.channel === 'bilibili' && item.action === 'search')
    expect(buildAgentReachArgv(template!, { query: '大模型' })).toEqual(['bilibili', 'search', '大模型'])
  })
})

describe('envelope 解析与条目映射（BDD）', () => {
  test('Given 合法一行 JSON When 解析 Then 得到 envelope', () => {
    const parsed = parseAgentReachEnvelope(envelopeJson({ ok: true, items: [] }))
    expect('envelope' in parsed && parsed.envelope.ok).toBe(true)
  })

  test('Given 非 JSON 输出 When 解析 Then 报 UPSTREAM_BROKEN 可用的错误', () => {
    const parsed = parseAgentReachEnvelope('<html>not json</html>')
    expect('error' in parsed).toBe(true)
  })

  test('Given 空输出 When 解析 Then 报错且不抛异常', () => {
    expect('error' in parseAgentReachEnvelope('')).toBe(true)
  })

  test('Given 带 published_at 的条目 When 映射 Then 保留发布时间并标注来源', () => {
    const mapped = mapEnvelopeItem(
      { title: 't', url: 'https://example.com/1', published_at: '2026-11-01', text: 'body' },
      { type: 'agent-reach', channel: 'github', action: 'search', backend: 'api' },
    )
    expect(mapped).toEqual({ title: 't', url: 'https://example.com/1', snippet: 'body', publishedAt: '2026-11-01', origin: { type: 'agent-reach', channel: 'github', action: 'search', backend: 'api' } })
  })

  test('Given 非法 published_at When 映射 Then 丢弃该字段条目仍保留', () => {
    const mapped = mapEnvelopeItem({ title: 't', url: 'https://example.com/2', published_at: 'not-a-date' }, { type: 'websearch' })
    expect(mapped?.publishedAt).toBeUndefined()
    expect(mapped?.url).toBe('https://example.com/2')
  })

  test('Given 无 url 的条目 When 映射 Then 丢弃', () => {
    expect(mapEnvelopeItem({ title: 't', text: 'x' }, { type: 'websearch' })).toBeNull()
  })

  test('Given 超长正文 When 映射 Then snippet 截断到 500 字符', () => {
    const mapped = mapEnvelopeItem({ url: 'https://example.com/3', text: 'a'.repeat(900) }, { type: 'websearch' })
    expect(mapped?.snippet).toHaveLength(500)
  })
})

describe('错误码翻译（BDD）', () => {
  beforeEach(() => { setAgentReachProbe('agent-reach') })
  afterEach(() => { setAgentReachSpawnRunner(null); setAgentReachProbe(null) })

  function mockRunner(responder: (args: string) => string | { timedOut: true }) {
    setAgentReachSpawnRunner(async (argv) => {
      const reply = responder(argv.join(' '))
      return typeof reply === 'string' ? { stdout: reply, timedOut: false } : { stdout: '', timedOut: true }
    })
  }

  test('Given CLI 未安装 When 采集 Then 全部启用源记 NEED_SETUP 且不抛异常', async () => {
    setAgentReachProbe(null)
    const sources = [makeSource({ id: 's1' }), makeSource({ id: 's2', channel: 'v2ex', action: 'hot', params: { limit: 5 } })]
    // 注入 runner 也不会被调用：resolveAgentReachBinary 在 spawn 之前返回 null。
    mockRunner(() => envelopeJson({ ok: true, items: [] }))
    const result = await collectAgentReachSources(sources)
    expect(result.items).toEqual([])
    expect(result.errors).toHaveLength(2)
    expect(result.errors.every((error) => error.code === 'NEED_SETUP')).toBe(true)
  })

  test('Given 限流 envelope When 采集 Then 单源记 RATE_LIMITED 其余源照常', async () => {
    const okSource = makeSource({ id: 'ok', channel: 'v2ex', action: 'hot', params: { limit: 3 } })
    const limitedSource = makeSource({ id: 'limited' })
    mockRunner((key) => key.includes('github search')
      ? envelopeJson({ ok: false, error: { code: 'RATE_LIMITED', message: 'too fast', hint: '等 60 秒' } })
      : envelopeJson({ ok: true, items: [{ title: 'v2ex 帖', url: 'https://v2ex.com/t/1', text: '正文' }] }))
    const result = await collectAgentReachSources([okSource, limitedSource])
    expect(result.items).toHaveLength(1)
    expect(result.errors).toEqual([{ sourceId: 'limited', channel: 'github', code: 'RATE_LIMITED', message: 'too fast（等 60 秒）' }])
  })

  test('Given 单源超时 When 采集 Then 该源记 TIMEOUT 且不影响其他源', async () => {
    const slow = makeSource({ id: 'slow' })
    const fast = makeSource({ id: 'fast', channel: 'bilibili', action: 'hot', params: { limit: 3 } })
    mockRunner((key) => key.includes('github search') ? { timedOut: true } : envelopeJson({ ok: true, items: [] }))
    const result = await collectAgentReachSources([slow, fast], { timeoutPerSourceMs: 1000 })
    expect(result.errors).toEqual([{ sourceId: 'slow', channel: 'github', code: 'TIMEOUT', message: '采集超时（1s）' }])
    expect(result.items).toEqual([])
  })

  test('Given NEED_LOGIN envelope When 采集 Then 按原码记录供面板提示', async () => {
    mockRunner(() => envelopeJson({ ok: false, error: { code: 'NEED_LOGIN', message: '登录已过期' } }))
    const result = await collectAgentReachSources([makeSource()])
    expect(result.errors[0]?.code).toBe('NEED_LOGIN')
  })

  test('Given 停用源 When 采集 Then 被跳过且不产生错误', async () => {
    mockRunner(() => envelopeJson({ ok: true, items: [{ url: 'https://example.com' }] }))
    const result = await collectAgentReachSources([makeSource({ enabled: false })])
    expect(result.items).toEqual([])
    expect(result.errors).toEqual([])
  })
})

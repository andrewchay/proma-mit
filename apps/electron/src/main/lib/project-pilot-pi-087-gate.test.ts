import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAgentSession, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent'
import { createAssistantMessageEventStream, type AssistantMessage, type Api, type Model } from '@earendil-works/pi-ai'
import { Type } from 'typebox'
import { createPiRequestBudgetGate } from './adapters/pi-request-budget-gate'

const root = mkdtempSync(join(tmpdir(), 'pilot-pi-087-gate-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))
const model: Model<Api> = { id: 'offline', name: 'offline', provider: 'fixture', api: 'fixture',
  baseUrl: 'invalid://no-provider', reasoning: false, input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1_000, maxTokens: 100 }
const makeMessage = (cost: number | undefined, toolCall: boolean, reason?: 'error'): AssistantMessage => ({
  role: 'assistant', api: 'fixture', provider: 'fixture', model: model.id, timestamp: Date.now(),
  content: toolCall ? [{ type: 'toolCall', id: 'call-fixture', name: 'restricted', arguments: {} }]
    : [{ type: 'text', text: 'offline' }],
  usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
    cost: { input: cost ?? Number.NaN, output: 0, cacheRead: 0, cacheWrite: 0, total: cost ?? Number.NaN } },
  stopReason: reason ?? (toolCall ? 'toolUse' : 'stop'),
  ...(reason ? { errorMessage: 'fixture failure' } : {}),
})

async function harness(costs: Array<number | undefined>, limit: number, withTool = true, failFirst = false) {
  const cwd = mkdtempSync(join(root, 'run-'))
  const budget = createPiRequestBudgetGate(limit)
  let requests = 0
  let tools = 0
  let projected = 0
  let priorToolHook = 0
  const runtime = await ModelRuntime.create({ allowModelNetwork: false, refreshOnCreate: false,
    authPath: join(cwd, 'auth.json'), modelsPath: null })
  runtime.registerProvider('fixture', { name: '离线 fixture', baseUrl: 'http://127.0.0.1:1',
    api: 'openai-completions', apiKey: 'offline-fixture-only',
    models: [{ id: 'offline', name: 'offline', contextWindow: 1_000, maxTokens: 100,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, input: ['text'], reasoning: false }],
  })
  await runtime.setRuntimeApiKey('fixture', 'offline-fixture-only')
  const { session } = await createAgentSession({ cwd, agentDir: cwd, modelRuntime: runtime, model,
    noTools: 'builtin', sessionManager: SessionManager.inMemory(cwd), settingsManager: SettingsManager.inMemory(),
    customTools: withTool ? [{ name: 'restricted', label: '受控工具', description: '离线工具',
      parameters: Type.Object({}), execute: async () => { tools++; return { content: [{ type: 'text' as const, text: 'ok' }], details: undefined } } }] : [],
  })
  session.agent.toolExecution = 'sequential'
  const previousPrepare = session.agent.prepareRequest
  const previousToolHook = session.agent.beforeToolCall
  session.agent.prepareRequest = async (request, signal) => {
    // 保留 coding-agent 的 canonical context 投影；拒绝时 streamFn 不得触发。
    const prepared = await previousPrepare?.(request, signal)
    projected++
    budget.beforeRequest()
    return prepared ?? undefined
  }
  session.agent.beforeToolCall = async (context, signal) => {
    priorToolHook++
    const previous = await previousToolHook?.(context, signal)
    if (budget.blocked) return { block: true, reason: budget.blocked, terminate: true }
    return previous
  }
  session.agent.streamFunction = () => {
    const failed = failFirst && requests === 0
    const message = makeMessage(costs[requests], withTool && requests < costs.length - 1, failed ? 'error' : undefined)
    requests++
    const stream = createAssistantMessageEventStream()
    if (failed) stream.push({ type: 'error', reason: 'error', error: message })
    else stream.push({ type: 'done', reason: message.stopReason === 'toolUse' ? 'toolUse' : 'stop', message })
    return stream
  }
  const unsubscribe = session.subscribe((event) => {
    if (event.type === 'message_end' && event.message.role === 'assistant') budget.afterResponse(event.message)
  })
  return { session, budget, unsubscribe,
    get requests() { return requests }, get tools() { return tools },
    get projected() { return projected }, get priorToolHook() { return priorToolHook } }
}

test('0.87.1 最终 payload 审查拒绝时不发送 Provider HTTP 请求', async () => {
  let sent = 0
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => { sent++; return new Response('unexpected') } })
  const cwd = mkdtempSync(join(root, 'payload-'))
  try {
    const runtime = await ModelRuntime.create({ allowModelNetwork: false, refreshOnCreate: false,
      authPath: join(cwd, 'auth.json'), modelsPath: null })
    runtime.registerProvider('payload-fixture', { name: '离线请求体', baseUrl: `http://127.0.0.1:${server.port}/v1`,
      api: 'openai-completions', apiKey: 'offline-fixture-only',
      models: [{ id: 'offline', name: 'offline', contextWindow: 1000, maxTokens: 100,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, input: ['text'], reasoning: false }],
    })
    await runtime.setRuntimeApiKey('payload-fixture', 'offline-fixture-only')
    const selected = runtime.getModel('payload-fixture', 'offline')
    if (!selected) throw new Error('fixture 模型缺失')
    const { session } = await createAgentSession({ cwd, agentDir: cwd, modelRuntime: runtime, model: selected,
      noTools: 'builtin', sessionManager: SessionManager.inMemory(cwd),
      settingsManager: SettingsManager.inMemory({ cacheWarming: 'off', retry: { enabled: false, provider: { maxRetries: 0 } } }),
    })
    const steps: string[] = []
    const prepare = session.agent.prepareRequest
    session.agent.prepareRequest = async (request, signal) => {
      const prepared = await prepare?.(request, signal)
      steps.push('准入')
      return prepared ?? undefined
    }
    session.agent.onPayload = (payload) => {
      steps.push('请求体')
      expect(payload).toMatchObject({ model: 'offline', stream: true })
      throw new Error('离线拒绝请求体')
    }
    try {
      await session.prompt('离线请求') // SDK 将 Provider 错误封装为消息，而非抛出
      expect(steps).toEqual(['准入', '请求体'])
      expect(session.agent.state.errorMessage).toContain('离线拒绝请求体')
      expect(sent).toBe(0)
    } finally { session.dispose() }
  } finally { server.stop(true) }
}, 30_000)

test('0.87.1 SettingsManager：有限费用配置禁 Provider HTTP 重试与 cache warming', () => {
  const settings = SettingsManager.inMemory({ retry: { enabled: false, maxRetries: 2, provider: { maxRetries: 0 } }, cacheWarming: 'off' })
  expect(settings.getProviderRetrySettings().maxRetries).toBe(0)
  expect(settings.getCacheWarmingMode()).toBe('off')
  expect(SettingsManager.inMemory().getCacheWarmingMode()).toBe('streaming')
})

test('0.87.1 AgentSession：首轮与工具续轮均走请求前钩子，累计达到阈值后禁止第三次请求', async () => {
  const h = await harness([0.2, 0.3], 0.5)
  try {
    await h.session.prompt('离线执行')
    expect(h.requests).toBe(2)
    expect(h.projected).toBe(2) // 0.87 的 terminate 工具屏障直接结束本批，无第三次请求
    expect(h.tools).toBe(1)
    expect(h.priorToolHook).toBe(1)
    expect(h.budget.reportedUsd).toBe(0.5)
  } finally { h.unsubscribe(); h.session.dispose() }
}, 30_000)

test('0.87.1 AgentSession：单轮超额或费用缺失不执行工具，且不再请求 Provider', async () => {
  for (const cost of [0.7, undefined]) {
    const h = await harness([cost, 0.1], 0.5)
    try {
      await h.session.prompt('离线执行')
      expect(h.requests).toBe(1)
      expect(h.tools).toBe(0)
      expect(h.budget.blocked).toBeDefined()
    } finally { h.unsubscribe(); h.session.dispose() }
  }
}, 30_000)

test('0.87.1 AgentSession：有 token 但本地价格为零时不得冒充免费并执行工具', async () => {
  const h = await harness([0, 0.1], 0.5)
  try {
    await h.session.prompt('离线执行')
    expect(h.requests).toBe(1)
    expect(h.tools).toBe(0)
    expect(h.budget.blocked).toContain('费用缺失')
  } finally { h.unsubscribe(); h.session.dispose() }
}, 30_000)

test('0.87.1 AgentSession：失败回复的已报告费用计入占额；本夹具不证明原生重试路径', async () => {
  const h = await harness([0.4, 0.2], 0.3, false, true)
  try {
    await h.session.prompt('离线执行')
    expect(h.requests).toBe(1)
    expect(h.budget.reportedUsd).toBe(0.4)
    expect(h.budget.blocked).toBe('Runtime 结果不确定，已报告费用保留')
  } finally { h.unsubscribe(); h.session.dispose() }
}, 30_000)

test('0.87.1 AgentSession：本地预算状态被标记 stop 后再次 prompt 在首请求前被拒绝', async () => {
  const h = await harness([0.1, 0.1], 0.5, false)
  try {
    await h.session.prompt('离线首轮')
    expect(h.requests).toBe(1)
    h.budget.stop()
    await h.session.prompt('离线续轮') // coding-agent 吞下门禁抛错并以错误消息收束
    expect(h.requests).toBe(1)
    expect(h.projected).toBe(2)
  } finally { h.unsubscribe(); h.session.dispose() }
}, 30_000)

test('0.87.1 AgentSession：费用未知时首轮虽已花费但不能冒充零费用', async () => {
  const h = await harness([undefined], 0.5, false)
  try {
    await h.session.prompt('离线执行')
    expect(h.requests).toBe(1)
    expect(h.budget.blocked).toBe('Runtime 费用缺失或无效，实际支出未知')
  } finally { h.unsubscribe(); h.session.dispose() }
}, 30_000)

import { expect, test } from 'bun:test'
import { Agent, type AgentTool } from '@earendil-works/pi-agent-core'
import { createAssistantMessageEventStream, type AssistantMessage, type Model, type Api } from '@earendil-works/pi-ai'
import { Type } from 'typebox'
import { createPiTurnBudgetExperiment } from './project-pilot-pi-budget-poc'

const model: Model<Api> = { id: 'offline', name: 'offline', provider: 'fixture', api: 'fixture', baseUrl: 'invalid://no-provider',
  reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1_000, maxTokens: 100 }
const usage = (cost: number) => ({ input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
  cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost } })
const answer = (n: number, cost: number, tools = false): AssistantMessage => ({ role: 'assistant', content: tools
  ? [{ type: 'toolCall', id: `call-${n}`, name: 'restricted', arguments: {} }]
  : [{ type: 'text', text: 'offline' }],
api: 'fixture', provider: 'fixture', model: model.id, timestamp: Date.now(), usage: usage(cost), stopReason: tools ? 'toolUse' : 'stop' })

function harness(costs: number[], limit: number, withTool = false) {
  const budget = createPiTurnBudgetExperiment(limit)
  let requests = 0
  let deniedRequests = 0
  let toolRuns = 0
  const tool: AgentTool = { name: 'restricted', label: '受限操作', description: '实验工具', parameters: Type.Object({}),
    execute: async () => { toolRuns++; return { content: [{ type: 'text', text: 'ok' }], details: undefined } } }
  const agent = new Agent({ initialState: { model, tools: withTool ? [tool] : [], systemPrompt: '仅离线测试' },
    streamFn: () => {
      if (!budget.beforeRequest()) {
        deniedRequests++
        const stream = createAssistantMessageEventStream()
        const error = { ...answer(requests, 0), stopReason: 'error' as const, errorMessage: '离线实验拒绝发起下一请求' }
        stream.push({ type: 'error', reason: 'error', error })
        return stream
      }
      const index = requests++
      const message = answer(index, costs[index] ?? Number.NaN, withTool)
      const stream = createAssistantMessageEventStream()
      stream.push({ type: 'done', reason: message.stopReason === 'toolUse' ? 'toolUse' : 'stop', message })
      return stream
    },
    beforeToolCall: async () => budget.snapshot.blocked ? { block: true } : undefined,
  })
  agent.subscribe((event) => {
    if (event.type === 'message_end' && event.message.role === 'assistant') budget.afterResponse(event.message)
  })
  return { agent, budget, get requests() { return requests }, get deniedRequests() { return deniedRequests }, get toolRuns() { return toolRuns } }
}

test('Given 首次预留 When 成本可核验但达到阈值 Then 不再发起下一模型请求', async () => {
  const h = harness([0.6], 0.5, true)
  await h.agent.prompt('开始')
  expect(h.requests).toBe(1)
  expect(h.deniedRequests).toBe(1)
  expect(h.toolRuns).toBe(0)
  expect(h.budget.snapshot).toMatchObject({ totalUsd: 0.6, blocked: '预算已达到或超出上限' })
})

test('Given 两轮工具调用 When 第一轮低于阈值且第二轮达到阈值 Then 只准入两次请求', async () => {
  const h = harness([0.2, 0.3], 0.5, true)
  await h.agent.prompt('开始')
  expect(h.requests).toBe(2)
  expect(h.deniedRequests).toBe(1)
  expect(h.toolRuns).toBe(1)
  expect(h.budget.snapshot.totalUsd).toBe(0.5)
})

test('Given 费用缺失或异常 When 收到 Pi 消息 Then 不执行工具也不续请求', async () => {
  for (const cost of [Number.NaN, -1]) {
    const h = harness([cost], 1, true)
    await h.agent.prompt('开始')
    expect(h.requests).toBe(1)
    expect(h.deniedRequests).toBe(1)
    expect(h.toolRuns).toBe(0)
    expect(h.budget.snapshot.blocked).toContain('费用缺失')
  }
})

test('Given 错误终态仍有可核验费用 When 结束 Then 保留该费用并阻断下一请求', () => {
  const budget = createPiTurnBudgetExperiment(1)
  expect(budget.beforeRequest()).toBe(true)
  budget.afterResponse({ ...answer(0, 0.25), stopReason: 'error', errorMessage: 'fake error' })
  expect(budget.snapshot).toMatchObject({ totalUsd: 0.25, blocked: '结果不确定，已报告费用仍保留' })
  expect(budget.beforeRequest()).toBe(false)
})

test('Given 手动中止 When 首轮未准入 Then 不进入 fake stream', async () => {
  const h = harness([0.1], 1)
  h.budget.stop()
  await h.agent.prompt('开始')
  expect(h.requests).toBe(0)
  expect(h.deniedRequests).toBe(1)
  expect(h.toolRuns).toBe(0)
})

test('Given 请求仍在等待 When abort Then 终止等待且不再执行工具', async () => {
  let entered!: () => void
  const started = new Promise<void>((resolve) => { entered = resolve })
  const budget = createPiTurnBudgetExperiment(1)
  let toolRuns = 0
  const agent = new Agent({ initialState: { model, tools: [], systemPrompt: '离线测试' },
    streamFn: (_model, _context, options) => {
      const stream = createAssistantMessageEventStream()
      if (!budget.beforeRequest()) throw new Error('离线预检拒绝')
      entered()
      options?.signal?.addEventListener('abort', () => {
        budget.stop()
        const error = { ...answer(0, Number.NaN), stopReason: 'aborted' as const, errorMessage: 'aborted' }
        stream.push({ type: 'error', reason: 'aborted', error })
      }, { once: true })
      return stream
    },
    beforeToolCall: async () => { toolRuns++; return { block: true } },
  })
  const run = agent.prompt('开始')
  await started
  agent.abort()
  await run
  expect(toolRuns).toBe(0)
  expect(budget.snapshot.blocked).toBe('主动中止')
})

import { afterAll, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildElectronMock } from '../testing/electron-mock'
const directory = mkdtempSync(join(tmpdir(), 'owner-execution-sdk-'))
process.env.PROMA_TEST_CONFIG_DIR = directory
mock.module('electron', () => buildElectronMock())
const exit = await import('../project-owner-execution-request-exit')
mock.module('../project-owner-execution-request-exit', () => ({ ...exit, resolveOwnerExecutionMaxOutputTokens: () => 8192 }))
const { AISDKRuntimeCore } = await import('./ai-sdk-runtime-core')
afterAll(() => { delete process.env.PROMA_TEST_CONFIG_DIR; rmSync(directory, { recursive: true, force: true }) })
async function run(finishReason: 'stop' | 'length', planning = false) {
  let body: Record<string, unknown> | undefined
  const fetchFn = Object.assign(async (_url: unknown, init?: RequestInit) => {
    body = JSON.parse(String(init?.body))
    return new Response([
      'data: '+JSON.stringify({ id: 'employee-response', object: 'chat.completion.chunk', created: 1, model: 'glm-5.3-flash', choices: [{ index: 0, delta: { content: '完整正文或被截断的过程说明' }, finish_reason: null }] }),
      'data: '+JSON.stringify({ id: 'employee-response', object: 'chat.completion.chunk', created: 1, model: 'glm-5.3-flash', choices: [{ index: 0, delta: {}, finish_reason: finishReason }], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } }),
      'data: [DONE]', '',
    ].join('\n\n'), { headers: { 'content-type': 'text/event-stream' } })
  }, { preconnect() {} }) as typeof globalThis.fetch
  const messages = await new AISDKRuntimeCore().runAgentTurn({ sessionId: 'employee', prompt: '完成已授权任务', modelId: 'glm-5.3-flash', provider: 'zhipu', protocol: 'openai-chat', apiKey: 'fake', baseUrl: 'https://offline.invalid/v1', cwd: directory,
    ...(planning ? { ownerPlanningRequest: { systemPrompt: '仅输出JSON', userPrompt: '返回JSON对象', maxOutputTokens: 8192, reasoningEffort: 'low' as const, jsonOutput: true as const } } : {}),
    runtimeTools: [], activeSession: { controller: new AbortController(), permissionMode: 'safe', planModeEntered: false }, maxTurns: 2, maxRetries: 0, fetchFn })
  return { body, result: messages.at(-1) }
}
test('Given Owner员工GLM请求 When真实AI SDK序列化 Then低推理强度和8192输出上限进入同一请求', async () => {
  const { body, result } = await run('stop')
  expect(body).toMatchObject({ model: 'glm-5.3-flash', max_tokens: 8192, reasoning_effort: 'low' })
  expect(body).not.toHaveProperty('thinking')
  expect(result).toMatchObject({ subtype: 'success', finish_reason: 'stop' })
})
test('Given Owner员工输出被截断 When仍有过程文字 Then保留用量并返回失败终态', async () => {
  const { result } = await run('length')
  expect(result).toMatchObject({ subtype: 'error_during_execution', finish_reason: 'length', usage: { input_tokens: 20, output_tokens: 10 } })
})

test('Given Owner规划GLM JSON协议 When真实AI SDK序列化 Then同时发送JSON模式与low推理并禁止重试', async () => {
  const { body } = await run('stop', true)
  expect(body).toMatchObject({ max_tokens: 8192, reasoning_effort: 'low', response_format: { type: 'json_object' } })
})

test('Given Owner员工SSE尚未结束时 WhenRuntime接收首段文本 Then增量已到事件层且结束后才拿到完整终态', async () => {
  const encoder = new TextEncoder()
  let releaseStream!: () => void
  const release = new Promise<void>(resolve => { releaseStream = resolve })
  const chunk = (delta: Record<string, unknown>, extra: Record<string, unknown> = {}) => encoder.encode(`data: ${JSON.stringify({
    id: 'owner-stream', object: 'chat.completion.chunk', created: 1, model: 'glm-5.3-flash',
    choices: [{ index: 0, delta, finish_reason: null }], ...extra,
  })}\n\n`)
  const fetchFn = Object.assign(async () => new Response(new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(chunk({ content: '第一段：已读取项目资料。' }))
      await release
      controller.enqueue(chunk({ content: '第二段：开始写文件。' }))
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({
        id: 'owner-stream', object: 'chat.completion.chunk', created: 1, model: 'glm-5.3-flash',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
      })}\n\n`))
      controller.enqueue(encoder.encode('data: [DONE]\n\n'))
      controller.close()
    },
  }), { headers: { 'content-type': 'text/event-stream' } }), { preconnect() {} }) as typeof globalThis.fetch

  const deltas: string[] = []
  let finished = false
  const turn = new AISDKRuntimeCore().runAgentTurn({
    sessionId: 'employee-stream', prompt: '完成已授权任务', modelId: 'glm-5.3-flash', provider: 'zhipu', protocol: 'openai-chat',
    apiKey: 'fake', baseUrl: 'https://offline.invalid/v1', cwd: directory,
    runtimeTools: [], activeSession: { controller: new AbortController(), permissionMode: 'safe', planModeEntered: false },
    maxTurns: 2, maxRetries: 0, fetchFn,
    onAgentEvent: event => { if (event.type === 'text_delta') deltas.push(event.text) },
  }).finally(() => { finished = true })

  // 上游尚未结束时，首段增量必须已经到达事件层（旧实现在这里读不到任何文本）。
  const deadline = Date.now() + 5000
  while (deltas.length === 0 && Date.now() < deadline) await Bun.sleep(10)
  expect(deltas.join('')).toContain('第一段')
  expect(finished).toBe(false)

  releaseStream()
  const messages = await turn
  expect(deltas.join('')).toContain('第二段')
  expect(messages.at(-1)).toMatchObject({ subtype: 'success' })
})

test('Given 受控出口抛错 When 流无输出 Then 诊断文字包含真实原因', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'owner-cause-'))
  try {
    let calls = 0
    const error = await new AISDKRuntimeCore().runAgentTurn({ sessionId: 'employee-cause', prompt: '完成已授权任务', modelId: 'glm-5.3-flash', provider: 'zhipu', protocol: 'openai-chat', apiKey: 'fake', baseUrl: 'https://offline.invalid/v1', cwd: directory,
      activeSession: { controller: new AbortController(), permissionMode: 'safe', planModeEntered: false }, runtimeTools: [], maxTurns: 1, maxRetries: 0,
      fetchFn: Object.assign(async () => { calls++; throw new Error('Owner受控出口拒绝：价格证据与当前员工冻结来源不一致') }, { preconnect: () => {} }) as unknown as typeof fetch,
    }).catch((cause: unknown) => cause)
    // 受控出口确实被调用一次，且真实原因进入最终错误文字，而不是只剩通用无输出文案。
    expect(calls).toBe(1)
    expect((error as Error).message).toContain('Owner受控出口拒绝：价格证据与当前员工冻结来源不一致')
    expect((error as Error).message).toContain('价格证据与当前员工冻结来源不一致')
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

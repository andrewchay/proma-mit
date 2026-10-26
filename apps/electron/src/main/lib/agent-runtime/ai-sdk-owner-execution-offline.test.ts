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

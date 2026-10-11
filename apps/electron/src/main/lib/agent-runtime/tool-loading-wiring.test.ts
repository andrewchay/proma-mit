/**
 * D03 接线：ai-sdk runtime 的独立工具加载（opt-in）。
 *
 * - 传入 toolLoading spec：toolSet 只含选中工具（未选 schema 不进模型），
 *   系统提示词注入能力摘要；执行经加载门禁（未加载/旧 schema 拒绝）。
 * - 不传 toolLoading：行为与既有完全一致（B15）。
 */

import { afterAll, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildElectronMock } from '../testing/electron-mock'

const previousConfigDir = process.env.PROMA_TEST_CONFIG_DIR
const testDir = mkdtempSync(join(tmpdir(), 'gravitas-d03-wiring-'))
process.env.PROMA_TEST_CONFIG_DIR = testDir

mock.module('electron', () => buildElectronMock())
mock.module('../attachment-service', () => ({
  isImageAttachment: () => false,
  getMimeType: () => 'application/octet-stream',
  readAttachmentAsBase64: () => '',
  deleteAttachment: () => {},
  deleteConversationAttachments: () => {},
  saveAttachment: async () => ({ path: '/tmp/mock', fileName: 'mock', mimeType: 'text/plain', size: 0 }),
  openFileDialog: async () => null,
}))
mock.module('../document-parser', () => ({
  isDocumentAttachment: () => false,
  extractTextFromAttachment: async () => '',
}))

type Part = { type: string;[key: string]: unknown }
let streamTextCalls = 0
let lastStreamParams: { system?: string; tools?: Record<string, unknown> } | undefined

function resetAiMock(): void {
  streamTextCalls = 0
  lastStreamParams = undefined
  mock.module('ai', () => ({
    isStepCount: () => ({ continue: () => true }),
    jsonSchema: (schema: unknown) => schema,
    tool: (def: unknown) => def,
    streamText: (params: { system?: string; tools?: Record<string, unknown> }) => {
      streamTextCalls += 1
      lastStreamParams = params
      return {
        stream: {
          [Symbol.asyncIterator]: () => ({
            next: async (): Promise<IteratorResult<Part>> => ({ done: true, value: undefined }),
          }),
        },
        // AI SDK 真实返回的 steps/usage 在顶层（惰性 Promise）。
        steps: Promise.resolve([]),
        usage: Promise.resolve({
          inputTokens: 1,
          outputTokens: 1,
          totalTokens: 2,
          inputTokenDetails: { cacheReadTokens: 0, cacheWriteTokens: 0 },
          outputTokenDetails: { reasoningTokens: 0 },
        }),
      }
    },
  }))
}
resetAiMock()

const { AISDKRuntimeCore } = await import('./ai-sdk-runtime-core')
const { buildToolCapabilityCatalog } = await import('./tool-capability-catalog')
const { bindCoreToolEffects } = await import('./tool-effects')
const { createReadToolDefinition, executeReadTool } = await import('./tool-impls/read-tool')
const { createWriteToolDefinition, executeWriteTool } = await import('./tool-impls/write-tool')

afterAll(() => {
  rmSync(testDir, { recursive: true, force: true })
  if (previousConfigDir === undefined) delete process.env.PROMA_TEST_CONFIG_DIR
  else process.env.PROMA_TEST_CONFIG_DIR = previousConfigDir
})

const readTool = bindCoreToolEffects({ ...createReadToolDefinition(), execute: executeReadTool })
const writeTool = bindCoreToolEffects({ ...createWriteToolDefinition(), execute: executeWriteTool })

function turnInput(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: 'd03-session',
    cwd: testDir,
    provider: 'deepseek' as const,
    apiKey: 'key',
    baseUrl: 'https://example.test',
    modelId: 'deepseek-flash',
    systemPrompt: 'base prompt',
    prompt: '读取文件',
    historyMessages: [],
    runtimeTools: [readTool, writeTool],
    maxTurns: 1,
    maxRetries: 0,
    activeSession: { controller: new AbortController() },
    ...overrides,
  }
}

describe('D03 ai-sdk 接线（opt-in）', () => {
  test('传入 toolLoading：toolSet 只含选中工具，系统提示词注入能力摘要', async () => {
    resetAiMock()
    const catalog = buildToolCapabilityCatalog([readTool, writeTool]).catalog
    const core = new AISDKRuntimeCore()
    await core.runAgentTurn(turnInput({
      toolLoading: { catalog, query: 'read file', tokenBudget: 80 },
    }) as never)
    expect(streamTextCalls).toBe(1)
    const tools = Object.keys(lastStreamParams!.tools ?? {})
    expect(tools).toEqual(['Read'])
    expect(tools).not.toContain('Write')
    expect(lastStreamParams!.system).toContain('base prompt')
    expect(lastStreamParams!.system).toContain('builtin:Read')
  })

  test('不传 toolLoading：全量 toolSet、无摘要注入（行为兼容）', async () => {
    resetAiMock()
    const core = new AISDKRuntimeCore()
    await core.runAgentTurn(turnInput() as never)
    expect(streamTextCalls).toBe(1)
    expect(Object.keys(lastStreamParams!.tools ?? {}).sort()).toEqual(['Read', 'Write'])
    expect(lastStreamParams!.system).toContain('base prompt')
  })

  test('执行边界：加载后 schema 被修订的调用被拒绝且不执行 runtime tool', async () => {
    resetAiMock()
    let runtimeExecuted = false
    const trackingWrite = bindCoreToolEffects({
      ...createWriteToolDefinition(),
      execute: async () => { runtimeExecuted = true; return { toolCallId: '', content: '' } },
    })
    const catalog = buildToolCapabilityCatalog([readTool, trackingWrite]).catalog
    const core = new AISDKRuntimeCore()
    await core.runAgentTurn(turnInput({
      runtimeTools: [readTool, trackingWrite],
      toolLoading: { catalog, query: 'read file', tokenBudget: 300, requiredIds: ['builtin:Write'] },
    }) as never)
    const entries = lastStreamParams!.tools as Record<string, { execute: (args: Record<string, unknown>, options: { toolCallId?: string }) => Promise<{ content: string; isError?: boolean }> }>
    const writeEntry = entries.Write
    expect(writeEntry).toBeDefined()
    // 加载后目录被修订：同名师工具参数变化 → 执行包装必须拒绝，runtime tool 不得运行。
    trackingWrite.parameters = { ...trackingWrite.parameters, properties: { ...trackingWrite.parameters.properties, extra: { type: 'number' } } }
    const result = await writeEntry!.execute({ file_path: 'x.txt', content: 'y' }, { toolCallId: 't1' })
    expect(result.isError).toBe(true)
    expect(result.content).toContain('schema')
    expect(runtimeExecuted).toBe(false)
  })
})

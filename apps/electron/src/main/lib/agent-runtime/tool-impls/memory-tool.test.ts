/**
 * 记忆工具单元测试（Agent Runtime）
 *
 * 验证 RecallMemory / AddMemory 的凭据检查、参数校验与 MemOS 调用。
 * 通过 mock.module 隔离 memory-service 与 memos-client，避免真实网络请求。
 */

import { describe, expect, mock, test, beforeEach } from 'bun:test'
import type { MemorySearchResult } from '../../memos-client'

let mockMemoryConfig: { apiKey?: string; userId?: string; baseUrl?: string } = {}
let mockSearchCalls: string[] = []
let mockAddCalls: Array<{ userMessage: string; assistantMessage?: string }> = []

mock.module('../../memory-service', () => ({
  getMemoryConfig: () => mockMemoryConfig,
}))

mock.module('../../memos-client', () => ({
  searchMemory: async (_credentials: unknown, query: string): Promise<MemorySearchResult> => {
    mockSearchCalls.push(query)
    return {
      facts: [{ id: '1', text: `事实:${query}` }],
      preferences: [{ id: '2', text: '偏好:简洁回答', type: 'preference' }],
    }
  },
  addMemory: async (_credentials: unknown, params: { userMessage: string; assistantMessage?: string }): Promise<void> => {
    mockAddCalls.push(params)
  },
  formatSearchResult: (result: MemorySearchResult): string =>
    `Facts:\n- ${result.facts.map((f) => f.text).join(', ')}\nPreferences:\n- ${result.preferences.map((p) => p.text).join(', ')}`,
}))

const {
  executeRecallMemoryTool,
  executeAddMemoryTool,
  createRecallMemoryToolDefinition,
  createAddMemoryToolDefinition,
  RECALL_MEMORY_TOOL_NAME,
  ADD_MEMORY_TOOL_NAME,
} = await import('./memory-tool')

describe('记忆工具（Agent Runtime）', () => {
  const ctx = { cwd: '/tmp/workspace', sessionId: 'test-session' }

  beforeEach(() => {
    mockMemoryConfig = { apiKey: 'test-memory-key', userId: 'test-user' }
    mockSearchCalls = []
    mockAddCalls = []
  })

  test('工具定义包含正确的名称与必填参数', () => {
    const recallDef = createRecallMemoryToolDefinition()
    const addDef = createAddMemoryToolDefinition()
    expect(recallDef.name).toBe(RECALL_MEMORY_TOOL_NAME)
    expect(recallDef.parameters.required).toContain('query')
    expect(addDef.name).toBe(ADD_MEMORY_TOOL_NAME)
    expect(addDef.parameters.required).toContain('userMessage')
  })

  test('未配置 API Key 时返回配置提示', async () => {
    mockMemoryConfig = {}
    const recall = await executeRecallMemoryTool({ query: '用户偏好' }, ctx)
    expect(recall.isError).toBe(true)
    expect(recall.content).toContain('记忆工具未配置 API Key')

    const add = await executeAddMemoryTool({ userMessage: 'hi' }, ctx)
    expect(add.isError).toBe(true)
    expect(add.content).toContain('记忆工具未配置 API Key')
  })

  test('RecallMemory 缺少 query 时返回错误', async () => {
    const result = await executeRecallMemoryTool({}, ctx)
    expect(result.isError).toBe(true)
    expect(result.content).toContain('query')
  })

  test('RecallMemory 成功检索并格式化结果', async () => {
    const result = await executeRecallMemoryTool({ query: '用户用什么语言' }, ctx)
    expect(result.isError).toBeFalsy()
    expect(mockSearchCalls).toEqual(['用户用什么语言'])
    expect(result.content).toContain('事实:用户用什么语言')
    expect(result.content).toContain('偏好:简洁回答')
  })

  test('AddMemory 缺少 userMessage 时返回错误', async () => {
    const result = await executeAddMemoryTool({}, ctx)
    expect(result.isError).toBe(true)
    expect(result.content).toContain('userMessage')
  })

  test('AddMemory 成功存储（带可选 assistantMessage）', async () => {
    const result = await executeAddMemoryTool({ userMessage: '我喜欢用 TypeScript', assistantMessage: '已记住' }, ctx)
    expect(result.isError).toBeFalsy()
    expect(mockAddCalls).toHaveLength(1)
    expect(mockAddCalls[0]?.userMessage).toBe('我喜欢用 TypeScript')
    expect(mockAddCalls[0]?.assistantMessage).toBe('已记住')
    expect(result.content).toContain('记忆已存储')
  })
})

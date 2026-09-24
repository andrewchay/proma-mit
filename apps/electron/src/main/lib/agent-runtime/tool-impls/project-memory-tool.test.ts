/**
 * 项目记忆工具单元测试（Agent Runtime）
 *
 * 验证工具定义、参数校验、结果格式化与 Select 使用反馈。
 * 范围过滤的权限行为由 memory-plugin-service.scoped.test.ts 覆盖；
 * 本文件通过 mock.module 隔离存储层，避免真实配置目录与文件写入。
 */

import { beforeEach, describe, expect, mock, test } from 'bun:test'
import type { MemoryItem } from '../../memory-plugin-service'

let mockItems: MemoryItem[] = []
let mockSearchCalls: Array<{ query: string; sessionId: string; limit?: number }> = []
let mockReadCalls: Array<{ id: string; sessionId: string }> = []
let mockUsageCalls: string[] = []

mock.module('../../memory-plugin-service', () => ({
  searchScopedMemoryItems: (input: { query: string; sessionId: string; limit?: number }) => {
    mockSearchCalls.push(input)
    return mockItems.filter((item) => !item.archivedAt)
  },
  getScopedMemoryItem: (id: string, sessionId: string) => {
    mockReadCalls.push({ id, sessionId })
    return mockItems.find((item) => item.id === id && !item.archivedAt)
  },
  recordMemoryUsage: (id: string) => {
    mockUsageCalls.push(id)
    return mockItems.find((item) => item.id === id) ?? null
  },
}))

const {
  SEARCH_PROJECT_MEMORY_TOOL_NAME,
  READ_PROJECT_MEMORY_TOOL_NAME,
  createSearchProjectMemoryToolDefinition,
  createReadProjectMemoryToolDefinition,
  executeSearchProjectMemoryTool,
  executeReadProjectMemoryTool,
} = await import('./project-memory-tool')

const now = Date.UTC(2026, 8, 24)

function mkItem(overrides: Partial<MemoryItem> & { id: string; title: string }): MemoryItem {
  return {
    content: `${overrides.title} 的完整内容`,
    kind: 'fact',
    tags: ['测试'],
    confidence: 0.8,
    sourceRunId: 'run-1',
    sourceSessionId: 'session-1',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
}

describe('项目记忆工具（Agent Runtime）', () => {
  const ctx = { cwd: '/tmp/workspace', sessionId: 'session-42' }

  beforeEach(() => {
    mockItems = []
    mockSearchCalls = []
    mockReadCalls = []
    mockUsageCalls = []
  })

  test('工具定义包含正确名称与必填参数', () => {
    const searchDef = createSearchProjectMemoryToolDefinition()
    const readDef = createReadProjectMemoryToolDefinition()
    expect(searchDef.name).toBe(SEARCH_PROJECT_MEMORY_TOOL_NAME)
    expect(searchDef.parameters.required).toContain('query')
    expect(readDef.name).toBe(READ_PROJECT_MEMORY_TOOL_NAME)
    expect(readDef.parameters.required).toContain('memoryId')
  })

  test('SearchProjectMemory 缺少 query 时返回错误', async () => {
    const result = await executeSearchProjectMemoryTool({}, ctx)
    expect(result.isError).toBe(true)
    expect(result.content).toContain('query')
    expect(mockSearchCalls).toHaveLength(0)
  })

  test('SearchProjectMemory 返回范围与来源并记录使用反馈', async () => {
    mockItems = [
      mkItem({
        id: 'mem-1',
        title: '甲项目发布决策',
        scope: { kind: 'project', projectIds: ['project-甲'] },
        source: { workspaceId: 'ws-a', sessionId: 'session-1', runId: 'run-1', locator: 'note.md', observedAt: now },
      }),
    ]

    const result = await executeSearchProjectMemoryTool({ query: '发布', limit: 5 }, ctx)

    expect(result.isError).toBeFalsy()
    expect(mockSearchCalls).toEqual([{ query: '发布', sessionId: 'session-42', limit: 5 }])
    expect(result.content).toContain('甲项目发布决策')
    expect(result.content).toContain('范围: 项目（1 个项目）')
    expect(result.content).toContain('出处 note.md')
    expect(mockUsageCalls).toEqual(['mem-1'])
  })

  test('SearchProjectMemory 无命中时提示项目绑定而非暗示记忆不存在', async () => {
    const result = await executeSearchProjectMemoryTool({ query: '不存在' }, ctx)
    expect(result.isError).toBeFalsy()
    expect(result.content).toContain('没有找到')
    expect(result.content).toContain('项目已关联当前工作空间')
    expect(mockUsageCalls).toHaveLength(0)
  })

  test('ReadProjectMemory 缺少 memoryId 时返回错误', async () => {
    const result = await executeReadProjectMemoryTool({}, ctx)
    expect(result.isError).toBe(true)
    expect(result.content).toContain('memoryId')
    expect(mockReadCalls).toHaveLength(0)
  })

  test('ReadProjectMemory 返回完整内容并二次校验当前会话', async () => {
    mockItems = [
      mkItem({
        id: 'mem-2',
        title: '工作区规范',
        scope: { kind: 'workspace', workspaceId: 'ws-a' },
      }),
    ]

    const result = await executeReadProjectMemoryTool({ memoryId: 'mem-2' }, ctx)

    expect(result.isError).toBeFalsy()
    expect(mockReadCalls).toEqual([{ id: 'mem-2', sessionId: 'session-42' }])
    expect(result.content).toContain('工作区规范')
    expect(result.content).toContain('工作区规范 的完整内容')
    expect(mockUsageCalls).toEqual(['mem-2'])
  })

  test('ReadProjectMemory 对不存在或越权条目返回统一提示', async () => {
    const result = await executeReadProjectMemoryTool({ memoryId: 'mem-private' }, ctx)
    expect(result.isError).toBe(true)
    expect(result.content).toContain('不在当前会话授权范围内')
    expect(mockUsageCalls).toHaveLength(0)
  })
})

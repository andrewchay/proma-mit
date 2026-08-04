import { describe, expect, test } from 'bun:test'
import type { ToolSet } from 'ai'
import type { AgentRuntimeScope, RuntimeSpanQueryTool } from '@proma/shared'
import { createSpanQueryTools } from './span-query-tools.ts'

const scope: AgentRuntimeScope = { tenantId: 'tenant-a', userId: 'user-1' }

/** 记录被调用的 arg，便于断言 scope 隔离与参数透传。 */
function recordQuery(): { query: RuntimeSpanQueryTool; calls: { method: string; scope?: AgentRuntimeScope; args?: unknown[] }[] } {
  const calls: { method: string; scope?: AgentRuntimeScope; args?: unknown[] }[] = []
  const query: RuntimeSpanQueryTool = {
    getTaskTree: async (s, taskId) => { calls.push({ method: 'getTaskTree', scope: s, args: [taskId] }); return [] },
    listRecentRuns: async (s, limit) => { calls.push({ method: 'listRecentRuns', scope: s, args: [limit] }); return [] },
    searchSpans: async (s, input) => { calls.push({ method: 'searchSpans', scope: s, args: [input] }); return [] },
  }
  return { query, calls }
}

describe('createSpanQueryTools（P-III 自查工具）', () => {
  // AI SDK 的 tool.execute 类型较严格，这里用最小执行器适配器取工具并调用。
  const exec = (tools: ToolSet, name: string) => {
    const t = tools[name] as unknown as { execute: (input: Record<string, unknown>, options?: { abortSignal?: AbortSignal }) => Promise<unknown> }
    return t.execute
  }

  test('注册 RunInspect / ListRecentRuns / RunSearch 三个只读工具', () => {
    const { query } = recordQuery()
    const tools = createSpanQueryTools(query, scope)
    expect(['RunInspect', 'ListRecentRuns', 'RunSearch'].every((name) => name in tools)).toBe(true)
  })

  test('RunInspect 把传入 scope + taskId 透传给查询器，返回 JSON', async () => {
    const { query, calls } = recordQuery()
    const tools = createSpanQueryTools(query, scope)
    const result = await exec(tools, 'RunInspect')({ taskId: 'task-9' })
    expect(JSON.parse(String(result))).toEqual([])
    expect(calls[0]?.method).toBe('getTaskTree')
    expect(calls[0]?.scope).toEqual({ tenantId: 'tenant-a', userId: 'user-1' })
    expect(calls[0]?.args).toEqual(['task-9'])
  })

  test('RunSearch 透传搜索参数（含 kind/status 规范化）', async () => {
    const { query, calls } = recordQuery()
    const tools = createSpanQueryTools(query, scope)
    await exec(tools, 'RunSearch')({ q: 'Bash', kind: 'tool', status: 'error', sinceMs: 60_000 })
    const search = calls[0]?.args?.[0]
    expect(search).toMatchObject({ query: 'Bash', kind: 'tool', status: 'error', sinceMs: 60_000 })
  })

  test('RunSearch 对非法 status 不做透传（undefined）', async () => {
    const { query, calls } = recordQuery()
    const tools = createSpanQueryTools(query, scope)
    await exec(tools, 'RunSearch')({ status: 'bogus' })
    expect(calls[0]?.args?.[0]).toMatchObject({ status: undefined })
  })

  test('工具强制使用构造时的 scope（不会读传入之外的租户）', async () => {
    const { query, calls } = recordQuery()
    const tools = createSpanQueryTools(query, scope)
    await exec(tools, 'ListRecentRuns')({ limit: 5 })
    expect(calls[0]?.scope).toEqual({ tenantId: 'tenant-a', userId: 'user-1' })
    expect(calls[0]?.args).toEqual([5])
  })
})

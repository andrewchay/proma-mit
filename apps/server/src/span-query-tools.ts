import { jsonSchema, tool } from 'ai'
import type { ToolSet } from 'ai'
import type { AgentRuntimeScope, RuntimeSpanQueryTool } from '@gravitas/shared'
import type { PostgresRuntimeSpanStore } from './spans.ts'

/** 把 PostgresRuntimeSpanStore 适配为 RuntimeSpanQueryTool（P-III 只读查询）。 */
export function createSpanQueryToolAdapter(spanStore: PostgresRuntimeSpanStore): RuntimeSpanQueryTool {
  return {
    getTaskTree: (scope, taskId) => spanStore.listTask({ ...scope, taskId }),
    listRecentRuns: (scope, limit) => spanStore.listRecentTasks(scope, limit).then((runs) => runs.map((run) => ({ ...scope, ...run }))),
    searchSpans: (scope, input) => spanStore.searchSpans(scope, input),
  }
}

/**
 * P-III：Agent 自查运行档案的只读工具集。
 *
 * 只读（不引入副作用）、按当前 scope 严格隔离。注入 spanQuery 后才注册，
 * 未注入则工具不存在（向后兼容）。返回值统一为 JSON 字符串。
 */
export function createSpanQueryTools(query: RuntimeSpanQueryTool, scope: AgentRuntimeScope): ToolSet {
  return {
    RunInspect: tool({
      description: '按 taskId 查看某次 Agent 运行的 span 树（provider → tool 层级），用于失败溯源与复盘。只读，只限当前账号数据。',
      inputSchema: jsonSchema<{ taskId: string }>({
        type: 'object', required: ['taskId'], properties: { taskId: { type: 'string', description: '要检查的任务 ID' } }, additionalProperties: false,
      }),
      execute: async ({ taskId }) => JSON.stringify(await query.getTaskTree(scope, taskId)),
    }),
    ListRecentRuns: tool({
      description: '列出当前账号最近的 Agent 运行（任务）ID、会话、状态与时间，便于定位要检查的运行。只读。',
      inputSchema: jsonSchema<{ limit?: number }>({
        type: 'object', properties: { limit: { type: 'number', description: '最多返回条数，默认 20' } }, additionalProperties: false,
      }),
      execute: async ({ limit }) => JSON.stringify(await query.listRecentRuns(scope, limit)),
    }),
    RunSearch: tool({
      description: '按关键字/类型/状态/时间窗搜索运行 span，返回扁平命中列表（定位涉及的工具、错误与任务）。只读。',
      inputSchema: jsonSchema<{ q?: string; kind?: string; status?: string; sinceMs?: number; limit?: number }>({
        type: 'object', properties: {
          q: { type: 'string', description: '关键字，匹配 span 名称或错误信息' },
          kind: { type: 'string', description: 'span 类型：provider/tool/task/subtask' },
          status: { type: 'string', description: 'ok/error' },
          sinceMs: { type: 'number', description: '只搜最近多少毫秒内的 span' },
          limit: { type: 'number', description: '最多返回条数，默认 50' },
        }, additionalProperties: false,
      }),
      execute: async ({ q, kind, status, sinceMs, limit }) => JSON.stringify(await query.searchSpans(scope, {
        query: q, kind: kind as never, status: status === 'ok' || status === 'error' ? status : undefined, sinceMs, limit,
      })),
    }),
  }
}

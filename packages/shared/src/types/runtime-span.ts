import type { AgentRuntimeScope } from '../utils'

/**
 * Runtime Span（运行档案）数据契约。
 *
 * 一次 Agent 运行被建模为一棵 span 树：根是 task，往下是 provider 调用，
 * provider 内再嵌套 tool 调用；子任务（subtask）作为独立 task 树的根。
 *
 * 设计原则（P-I）：
 * - span 表只存轻量 meta（token / exitCode / 截断错误），不存完整 prompt/output，
 *   原始内容仍由 event hub（Redis + SSE 可重放）承载。
 * - 树用 `trace_id` + `parent_span_id` + `task_id` 共同组织。
 */

export type RuntimeSpanKind = 'task' | 'provider' | 'tool' | 'subtask'

export type RuntimeSpanStatus = 'ok' | 'error'

export interface RuntimeSpan extends AgentRuntimeScope {
  /** 逻辑 trace 标识；P-I 阶段先复用 task group key，同时保留字段为 P-II/III 贯穿 HTTP trace 预置。 */
  traceId: string
  sessionId: string
  taskId: string
  /** 嵌套父 span（provider 调用下的 tool 调用等）。 */
  parentSpanId?: string
  /** 稳定标识（随机 uuid），用于 begin/end 配对。 */
  spanId: string
  kind: RuntimeSpanKind
  /** 如 'provider:gpt-4o' / 'tool:Bash' / 'task:run'。 */
  name: string
  startedAt: number
  endedAt: number
  status: RuntimeSpanStatus
  /** 失败时的错误描述（截断），非失败不填。 */
  error?: string
  /** 轻量元数据：inputTokens/outputTokens/exitCode/resultTruncated 等。 */
  meta?: Record<string, unknown>
}

/** 创建 span 时尚未确定 endedAt/status，begin 阶段的数据契约。 */
export type RuntimeSpanBegin = Omit<RuntimeSpan, 'endedAt' | 'status'>

export interface RuntimeSpanNode extends RuntimeSpan {
  children: RuntimeSpanNode[]
}

/** span 写入 sink：runner 保持纯函数、不直接依赖 Postgres。 */
export interface RuntimeSpanSink {
  begin(span: RuntimeSpanBegin): Promise<void> | void
  /** 结束 span 时带 status + 可选 error/meta。 */
  end(spanId: string, patch: { status: RuntimeSpanStatus; error?: string; meta?: Record<string, unknown> }): Promise<void> | void
}

/** P-III：Agent 自查运行档案的只读能力契约（按当前 scope 严格隔离）。 */
export interface RuntimeSpanQueryTool {
  /** 按 taskId 返回该 task 的 span 嵌套树（可空表示无记录）。 */
  getTaskTree(scope: AgentRuntimeScope, taskId: string): Promise<RuntimeSpanNode[]>
  /** 列出当前 scope 最近任务的最小元数据（id/session/status/startedAt）。 */
  listRecentRuns(scope: AgentRuntimeScope, limit?: number): Promise<AgentRunSummary[]>
  /** 按关键字/类型/状态/时间窗搜索 span 扁平列表。 */
  searchSpans(scope: AgentRuntimeScope, input: {
    query?: string
    kind?: RuntimeSpanKind
    status?: RuntimeSpanStatus
    sinceMs?: number
    limit?: number
  }): Promise<RuntimeSpan[]>
}

export interface AgentRunSummary extends AgentRuntimeScope {
  taskId: string
  sessionId: string
  status: string
  startedAt: number
  completedAt?: number
}

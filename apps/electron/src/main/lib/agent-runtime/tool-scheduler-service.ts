/**
 * 生产执行接线（E05）：全进程共享的工具调度器。
 *
 * 锁域：仅本进程内经此调度器派发的工具调用（ai-sdk runtime 与 Pi 桥都经此处）。
 * 不支持跨进程共享锁：多实例、服务端 executor 或子进程中的调用不在锁域内，
 * 因此不得宣称“全局安全”。browser/terminal/Bash/MCP 等 unknown 工具走全局排他键，
 * 同一资源（含跨会话、父子 Agent）始终串行；文件读写在真实路径键上协调。
 */

import { randomUUID } from 'node:crypto'
import type { ToolContext, RuntimeToolDefinition } from './types'
import { ToolScheduler, planLockSpec } from './tool-scheduler'
import { ASK_USER_QUESTION_TOOL_NAME, ENTER_PLAN_MODE_TOOL_NAME, EXIT_PLAN_MODE_TOOL_NAME, GOAL_CHECKPOINT_TOOL_NAME } from './tool-registry'

/** 交互式/控制面工具不参与资源调度：它们没有资源语义，全局串行只会卡住会话。 */
const INTERACTIVE_TOOL_NAMES = new Set([
  ASK_USER_QUESTION_TOOL_NAME,
  ENTER_PLAN_MODE_TOOL_NAME,
  EXIT_PLAN_MODE_TOOL_NAME,
  GOAL_CHECKPOINT_TOOL_NAME,
])

export const toolExecutionScheduler = new ToolScheduler({ maxConcurrent: 4 })

const DEFAULT_MAX_CONCURRENT = 4

export interface ToolRetryPolicy {
  /** 最大尝试次数（含首次）。默认 1 = 不重试。 */
  readonly maxAttempts?: number
  /** 默认：非中止错误视为可重试；调用方可覆盖。 */
  readonly shouldRetry?: (error: unknown) => boolean
}

function defaultShouldRetry(error: unknown): boolean {
  return !(error instanceof Error && error.name === 'AbortError')
}

/**
 * 经共享调度器执行一次工具调用：同资源跨会话/父子 Agent 串行，独立读取并行。
 * 交互式工具直接执行；取消与错误以异常形式抛出由调用方处理。
 *
 * 重试硬规则：仅共享锁（幂等读）调用可按策略重试；含写或 unknown 的调用
 * （外部副作用、不可回放）绝不自动重放。取消永不重试。
 */
export async function runGuardedToolCall<T>(input: {
  tool: RuntimeToolDefinition
  args: Record<string, unknown>
  ctx: ToolContext
  signal?: AbortSignal
  execute: () => Promise<T>
  retry?: ToolRetryPolicy
}): Promise<T> {
  if (INTERACTIVE_TOOL_NAMES.has(input.tool.name)) return input.execute()
  const maxAttempts = Math.max(1, input.retry?.maxAttempts ?? 1)
  const spec = await planLockSpec(input.tool, input.args, input.ctx)
  const retryable = maxAttempts > 1 && spec.mode === 'shared'
  const shouldRetry = input.retry?.shouldRetry ?? defaultShouldRetry
  let lastError: unknown
  for (let attempt = 1; attempt <= (retryable ? maxAttempts : 1); attempt++) {
    const [result] = await toolExecutionScheduler.schedule<T>([{
      id: randomUUID(),
      tool: input.tool,
      input: input.args,
      ctx: input.ctx,
      execute: input.execute,
    }], input.signal)
    if (result?.status === 'completed') return result.result as T
    if (result?.status === 'cancelled') throw new Error('工具调用已取消（调度器中止）')
    lastError = new Error(result?.error ?? '工具执行失败（调度器）')
    if (attempt < maxAttempts && shouldRetry(lastError) && !input.signal?.aborted) continue
    throw lastError
  }
  throw lastError instanceof Error ? lastError : new Error('工具执行失败（调度器）')
}

/**
 * 禁用/恢复调度优化。禁用后退化为全串行（并发 1），但锁仍持有——
 * 这是硬底线：禁用只牺牲并行度，不放弃冲突串行化。
 */
export function setToolSchedulerDisabled(disabled: boolean): void {
  toolExecutionScheduler.setMaxConcurrent(disabled ? 1 : DEFAULT_MAX_CONCURRENT)
}

/** 调度指标快照：dispatched/completed/errored/cancelled/totalWaitMs。 */
export function schedulerMetricsSnapshot(): ReturnType<ToolScheduler['snapshotMetrics']> {
  return toolExecutionScheduler.snapshotMetrics()
}

/** 锁事件快照（HR07–HR09 执行窗口验证）：只含锁键与阶段，不含工具参数。 */
export function schedulerLockEvents(): ReturnType<ToolScheduler['snapshotLockEvents']> {
  return toolExecutionScheduler.snapshotLockEvents()
}

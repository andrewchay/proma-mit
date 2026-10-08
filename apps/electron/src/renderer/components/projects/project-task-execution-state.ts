import type { AgentExecutionResult, CancelAgentExecutionResult } from '@gravitas/shared'

/** 优先仍活跃的真实执行；不能让新插入的旧终态遮挡停止入口。 */
export function selectTaskExecution(executions: AgentExecutionResult[]): AgentExecutionResult | undefined {
  const newest = [...executions].sort((a, b) => b.startedAt - a.startedAt)
  return newest.find((execution) => execution.status === 'running' || execution.status === 'queued') ?? newest[0]
}

export function executionStopMessage(result: CancelAgentExecutionResult): string {
  if (result.stopped && result.status === 'cancelled') return '执行已取消，任务待人工处理。'
  if (result.stopRequested) return '已发送停止请求，等待运行结束；尚未确认底层操作终止。'
  return `当前执行状态：${result.status}，请刷新执行记录。`
}

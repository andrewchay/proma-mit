import type { ToolContext } from '../agent-runtime/types'

/** 耗时等待前后重新检查能力、取消状态与运行时绑定。 */
export function assertDirectorToolActive(ctx: ToolContext): void {
  if (ctx.abortSignal?.aborted) throw new Error('会话已取消')
  const { hasNewMediaContentCapability } = require('../plugins/new-media-plugin') as typeof import('../plugins/new-media-plugin')
  if (!hasNewMediaContentCapability()) throw new Error('新媒体内容能力已停用')
  const { assertBoundToolSession } = require('../project-owner-execution-gates') as typeof import('../project-owner-execution-gates')
  assertBoundToolSession(ctx)
}

/** 流量策略目录执行绑定：复用既有实现并保留 ToolResult 错误语义。 */

import type { ToolCall } from '@gravitas/core'
import { executeContentTrackerTool } from '../../../../src/main/lib/marketing/ma-tools/content-tracker'

export async function execute(input: unknown) {
  return executeContentTrackerTool({ id: 'directory-ma-suggest-traffic-strategy', name: 'ma_suggest_traffic_strategy', arguments: (input ?? {}) as Record<string, unknown> } as ToolCall)
}

/** KOL 建联目录执行绑定：复用既有实现并保留 ToolResult 错误语义。 */

import type { ToolCall } from '@gravitas/core'
import { executeConnectBotTool } from '../../../../src/main/lib/marketing/ma-tools/connect-bot'

export async function execute(input: unknown) {
  return executeConnectBotTool({ id: 'directory-ma-generate-outreach', name: 'ma_generate_outreach', arguments: (input ?? {}) as Record<string, unknown> } as ToolCall)
}

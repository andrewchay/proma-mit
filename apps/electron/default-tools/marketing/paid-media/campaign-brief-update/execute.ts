/** Campaign Brief 更新目录执行绑定：复用既有实现并保留 ToolResult 错误语义。 */

import type { ToolCall } from '@gravitas/core'
import { executeCampaignAgentTool } from '../../../../src/main/lib/marketing/ma-tools/campaign-agent'

export async function execute(input: unknown) {
  return executeCampaignAgentTool({ id: 'directory-ma-campaign-brief-update', name: 'ma_campaign_brief_update', arguments: (input ?? {}) as Record<string, unknown> } as ToolCall)
}

/** Campaign 达人池查询目录执行绑定：复用既有实现并保留 ToolResult 错误语义。 */

import type { ToolCall } from '@gravitas/core'
import { executeCampaignAgentTool } from '../../../../src/main/lib/marketing/ma-tools/campaign-agent'

export async function execute(input: unknown) {
  return executeCampaignAgentTool({ id: 'directory-ma-campaign-kol-list', name: 'ma_campaign_kol_list', arguments: (input ?? {}) as Record<string, unknown> } as ToolCall)
}

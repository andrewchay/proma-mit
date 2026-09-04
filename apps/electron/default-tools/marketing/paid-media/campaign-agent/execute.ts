/** Campaign 管理目录执行绑定：当前目录声明 ma_campaign_get。 */

import type { ToolCall } from '@gravitas/core'
import { executeCampaignAgentTool } from '../../../../src/main/lib/marketing/ma-tools/campaign-agent'

export async function execute(input: unknown) {
  return executeCampaignAgentTool({ id: 'directory-ma-campaign-get', name: 'ma_campaign_get', arguments: (input ?? {}) as Record<string, unknown> } as ToolCall)
}

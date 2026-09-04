/** Campaign 测试目录执行绑定：复用既有实现并保留 ToolResult 错误语义。 */

import type { ToolCall } from '@gravitas/core'
import { executeCampaignTesterTool } from '../../../../src/main/lib/marketing/ma-tools/campaign-tester'

export async function execute(input: unknown) {
  return executeCampaignTesterTool({ id: 'directory-ma-design-campaign-test', name: 'ma_design_campaign_test', arguments: (input ?? {}) as Record<string, unknown> } as ToolCall)
}

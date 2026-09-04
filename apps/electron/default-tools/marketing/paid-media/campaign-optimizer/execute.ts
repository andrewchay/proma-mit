/** Campaign 优化目录执行绑定：复用已验证的业务实现。 */

import type { ToolCall } from '@gravitas/core'
import { executeCampaignOptimizerTool } from '../../../../src/main/lib/marketing/ma-tools/campaign-optimizer'

export async function execute(input: unknown) {
  return executeCampaignOptimizerTool({ id: 'directory-ma-optimize-campaign', name: 'ma_optimize_campaign', arguments: (input ?? {}) as Record<string, unknown> } as ToolCall)
}

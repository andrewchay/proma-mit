/** 创意 Brief 目录执行绑定：复用已验证的业务实现。 */

import type { ToolCall } from '@gravitas/core'
import { executeCreativePilotTool } from '../../../../src/main/lib/marketing/ma-tools/creative-pilot'

export async function execute(input: unknown) {
  return executeCreativePilotTool({ id: 'directory-ma-generate-creative-brief', name: 'ma_generate_creative_brief', arguments: (input ?? {}) as Record<string, unknown> } as ToolCall)
}

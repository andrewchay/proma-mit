/** KOL 匹配目录执行绑定：复用已验证的业务实现。 */

import type { ToolCall } from '@gravitas/core'
import { executeMatchAITool } from '../../../../src/main/lib/marketing/ma-tools/match-ai'

export async function execute(input: unknown) {
  return executeMatchAITool({ id: 'directory-ma-match-kols', name: 'ma_match_kols', arguments: (input ?? {}) as Record<string, unknown> } as ToolCall)
}

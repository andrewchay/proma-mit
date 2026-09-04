/** 策略生成目录执行绑定：复用已验证的业务实现，保留 ToolResult 错误语义。 */

import type { ToolCall } from '@gravitas/core'
import { executeStrategyIQTool } from '../../../../src/main/lib/marketing/ma-tools/strategy-iq'

export async function execute(input: unknown) {
  return executeStrategyIQTool({
    id: 'directory-ma-generate-strategy',
    name: 'ma_generate_strategy',
    arguments: (input ?? {}) as Record<string, unknown>,
  } as ToolCall)
}

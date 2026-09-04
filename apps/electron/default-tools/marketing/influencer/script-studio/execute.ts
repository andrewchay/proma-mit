/** 内容脚本目录执行绑定：复用既有实现并保留 ToolResult 错误语义。 */

import type { ToolCall } from '@gravitas/core'
import { executeScriptStudioTool } from '../../../../src/main/lib/marketing/ma-tools/script-studio'

export async function execute(input: unknown) {
  return executeScriptStudioTool({ id: 'directory-ma-generate-script', name: 'ma_generate_script', arguments: (input ?? {}) as Record<string, unknown> } as ToolCall)
}

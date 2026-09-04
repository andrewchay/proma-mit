/** 达人自助服务目录执行绑定：复用既有实现并保留 ToolResult 错误语义。 */

import type { ToolCall } from '@gravitas/core'
import { executeKOLPortalTool } from '../../../../src/main/lib/marketing/ma-tools/kol-portal'

export async function execute(input: unknown) {
  return executeKOLPortalTool({ id: 'directory-ma-kol-portal', name: 'ma_kol_portal', arguments: (input ?? {}) as Record<string, unknown> } as ToolCall)
}

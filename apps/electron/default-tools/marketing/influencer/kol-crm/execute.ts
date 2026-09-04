/** 达人 CRM 目录执行绑定：复用既有实现并保留 ToolResult 错误语义。 */

import type { ToolCall } from '@gravitas/core'
import { executeKOLCRMTool } from '../../../../src/main/lib/marketing/ma-tools/kol-crm'

export async function execute(input: unknown) {
  return executeKOLCRMTool({ id: 'directory-ma-kol-crm', name: 'ma_kol_crm', arguments: (input ?? {}) as Record<string, unknown> } as ToolCall)
}

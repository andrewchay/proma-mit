/** 内容审核目录执行绑定：复用已验证的业务实现，保留 ToolResult 错误语义。 */

import type { ToolCall } from '@gravitas/core'
import { executeContentAuditTool } from '../../../../src/main/lib/marketing/ma-tools/content-audit'

export async function execute(input: unknown) {
  return executeContentAuditTool({
    id: 'directory-ma-audit-content',
    name: 'ma_audit_content',
    arguments: (input ?? {}) as Record<string, unknown>,
  } as ToolCall)
}

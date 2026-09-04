/** KOL 搜索目录执行绑定：复用已验证的业务实现，保留 ToolResult 错误语义。 */

import type { ToolCall } from '@gravitas/core'
import { executeKOLSearchTool } from '../../../../src/main/lib/marketing/ma-tools/kol-search'

export async function execute(input: unknown) {
  return executeKOLSearchTool({
    id: 'directory-ma-search-kols',
    name: 'ma_search_kols',
    arguments: (input ?? {}) as Record<string, unknown>,
  } as ToolCall)
}

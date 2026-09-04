/** 阶段复盘目录执行绑定：复用已验证的业务实现。 */

import type { ToolCall } from '@gravitas/core'
import { executePhaseReviewerTool } from '../../../../src/main/lib/marketing/ma-tools/ma-phase-reviewer'

export async function execute(input: unknown) {
  return executePhaseReviewerTool({ id: 'directory-ma-generate-phase-report', name: 'ma_generate_phase_report', arguments: (input ?? {}) as Record<string, unknown> } as ToolCall)
}

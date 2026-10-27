/**
 * 权限批量审批 —— 纯函数辅助
 *
 * 行为：权限请求按 FIFO 排队展示，当队首之后紧跟多个"同类"请求时，
 * 允许用户一次性放行队首的连续同类段，避免逐个点"允许"。
 *
 * 安全边界（与 agent-permission-service 的白名单语义对齐）：
 * - dangerous 级请求一律不批量，必须逐个确认；
 * - Computer Use / Web Bridge 上传下载等逐次确认类工具不批量；
 * - 非 Bash 工具要求同工具名同危险等级；
 * - Bash 工具额外要求同命令族（命令首个 token），且段内任何命令命中
 *   isDangerousCommand 时整个段不可批量（主进程侧仍有危险命令拦截兜底）。
 */

import type { PermissionRequest } from '@gravitas/shared'
import { isDangerousCommand } from '@gravitas/shared'

/** 逐次确认类工具：每次调用都代表一次真实外部副作用，不允许合并审批 */
export function requiresPerActionApprovalTool(toolName: string): boolean {
  return (toolName.startsWith('ComputerUse') && toolName !== 'ComputerUseStatus')
    || new Set(['WebBridgeDownload', 'WebBridgeUpload']).has(toolName)
}

/** 提取 Bash 命令族（首个 token），与主进程 agent-permission-service.extractBaseCommand 保持一致 */
export function extractBaseCommand(command: string): string {
  return command.trim().split(/\s+/)[0] ?? ''
}

/** 批量放行方案：可放行的队首连续段 */
export interface PermissionBatchPlan {
  /** 本次批量放行的请求 ID（含队首，保持 FIFO 顺序） */
  requestIds: string[]
  /** 批量放行后仍需逐个处理的剩余请求数 */
  remainingCount: number
}

/**
 * 计算可批量放行的队首连续段
 *
 * @param requests 当前会话的待批请求队列（FIFO 顺序）
 * @returns 可批量方案；不足 2 条或队首不满足批量条件时返回 null
 */
export function resolveBatchAllowPlan(requests: readonly PermissionRequest[]): PermissionBatchPlan | null {
  const first = requests[0]
  if (!first || requests.length < 2 || first.requiresPerActionApproval) return null
  if (first.dangerLevel === 'dangerous') return null
  if (requiresPerActionApprovalTool(first.toolName)) return null

  const requestIds: string[] = [first.requestId]
  for (const candidate of requests.slice(1)) {
    if (candidate.requiresPerActionApproval || candidate.dangerLevel !== first.dangerLevel) break
    if (candidate.toolName !== first.toolName) break
    if (requiresPerActionApprovalTool(candidate.toolName)) break
    if (first.toolName === 'Bash') {
      const firstCommand = first.command ?? ''
      const candidateCommand = candidate.command ?? ''
      // 同命令族才允许合并；命中危险命令时停止扩展（后续仍需逐个确认）
      if (extractBaseCommand(candidateCommand) !== extractBaseCommand(firstCommand)) break
      if (isDangerousCommand(candidateCommand)) break
    }
    requestIds.push(candidate.requestId)
  }

  if (requestIds.length < 2) return null
  return { requestIds, remainingCount: requests.length - requestIds.length }
}

/**
 * EvidenceService —— 运行证据服务（P1）
 *
 * 从 Agent 会话的运行数据生成结构化证据（decisions/validation/writeback/evidence），
 * 供 Goal 证据流沉淀。证据驱动的初衷：每次运行都记录"做了什么、改了什么、结果如何"，
 * 不做空洞的"完成"宣称。
 */

import { getTokenUsageRecords } from './token-usage-service'
import type { RunEvidence } from '@proma/shared'

/** 写操作类工具（近似判定：这些工具可能改变本地状态/文件/外部系统） */
const WRITE_TOOLS = new Set([
  'Write',
  'Edit',
  'MultiEdit',
  'Bash',
  'Shell',
  'TaskCreate',
  'TaskUpdate',
  'TodoWrite',
  'TodoCreate',
  'ImportProject',
  'WebFetch', // 可能触发副作用
  'Email', // 发送
  'Message', // 发送
])

/** 判定某工具名是否是写操作 */
function isWriteTool(toolName: string): boolean {
  if (WRITE_TOOLS.has(toolName)) return true
  if (toolName.startsWith('mcp__')) return true // MCP 工具视为可能对外部有副作用
  return false
}

/** 从工具调用名推断"关键决策"（非写操作且有信息价值的工具） */
function toDecisionText(toolNames: string[]): string {
  if (toolNames.length === 0) return '未调用工具'
  const nonWrite = toolNames.filter((name) => !isWriteTool(name))
  const write = toolNames.filter((name) => isWriteTool(name))
  const parts: string[] = []
  if (write.length > 0) parts.push(`写操作工具：${[...new Set(write)].join(', ')}`)
  if (nonWrite.length > 0) parts.push(`调研/分析工具：${[...new Set(nonWrite)].slice(0, 4).join(', ')}`)
  return parts.join('；')
}

/**
 * 根据会话 ID 构建结构化运行证据。
 *
 * @param sessionId 会话 ID
 * @param terminalState 终止状态（completed / failed），用于生成 validation 摘要
 * @param userMessage 本次运行的用户消息（可选，作为 evidence 上下文）
 * @param recordSource 可注入 token 记录来源（测试用），默认读取全局 token 统计
 */
export function buildSessionEvidence(
  sessionId: string,
  terminalState: 'completed' | 'failed' = 'completed',
  userMessage?: string,
  recordSource?: (q: import('@proma/shared').TokenUsageQuery) => import('@proma/shared').TokenUsageRecord[],
): RunEvidence {
  // 读取该会话的 token 使用记录（含每轮工具调用）
  const getRecords = recordSource ?? getTokenUsageRecords
  const records = getRecords({ sessionId })

  const allToolNames: string[] = []
  let totalTurns = 0
  let totalTokens = 0
  for (const record of records) {
    totalTurns += 1
    totalTokens += record.totalTokens
    for (const tool of record.toolNames) {
      if (tool.startsWith('mcp__')) {
        allToolNames.push(tool)
      } else {
        allToolNames.push(tool)
      }
    }
  }

  const uniqueTools = [...new Set(allToolNames)]
  const writeback = uniqueTools.filter((t) => isWriteTool(t))

  const decisionText = toDecisionText(uniqueTools)
  const validation =
    terminalState === 'completed'
      ? `运行成功完成（${totalTurns} 轮，${totalTokens.toLocaleString()} tokens）`
      : '运行失败，需人工检查'

  const summaryParts = [
    userMessage ? `目标：${userMessage.slice(0, 60)}` : `会话 ${sessionId}`,
    `${totalTurns} 轮，${totalTokens.toLocaleString()} tokens，${uniqueTools.length} 个工具`,
    terminalState === 'completed' ? '运行成功' : '运行失败',
  ]

  return {
    decisions: uniqueTools.length > 0 ? [decisionText] : undefined,
    validation,
    writeback: writeback.length > 0 ? [...new Set(writeback)] : undefined,
    evidence: summaryParts.join(' · '),
  }
}

/** 把 RunEvidence 格式化为可读的一句话摘要（用于 Goal evidence 列表） */
export function formatEvidenceSummary(evidence: RunEvidence): string {
  const parts: string[] = []
  if (evidence.evidence) parts.push(evidence.evidence)
  if (evidence.validation) parts.push(evidence.validation)
  if (evidence.writeback?.length) parts.push(`改动了 ${evidence.writeback.length} 类目标`)
  return parts.join(' | ')
}

/** 全局单例入口 */
export const evidenceService = {
  buildSessionEvidence,
  formatEvidenceSummary,
}

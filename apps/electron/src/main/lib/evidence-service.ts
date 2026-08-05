/**
 * EvidenceService —— 运行证据服务（P1）
 *
 * 从 Agent 会话的运行数据生成结构化证据（decisions/validation/writeback/evidence），
 * 供 Goal 证据流沉淀。证据驱动的初衷：每次运行都记录"做了什么、改了什么、结果如何"，
 * 不做空洞的"完成"宣称。
 */

import { getTokenUsageRecords } from './token-usage-service'
import type { RunEvidence } from '@gravitas/shared'

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

/** 工具 → 中文动作短语（E5 语义化增强，无联网） */
const TOOL_ACTION_LABELS: Record<string, string> = {
  Read: '阅读文件',
  Grep: '搜索代码',
  Glob: '查找文件',
  List: '查看目录',
  Bash: '执行命令',
  Shell: '执行命令',
  Write: '写入文件',
  Edit: '修改代码',
  MultiEdit: '批量修改代码',
  WebSearch: '网络搜索',
  WebFetch: '抓取网页',
  TaskCreate: '创建任务',
  TaskUpdate: '更新任务进度',
  TodoWrite: '记录待办',
  TodoCreate: '创建待办',
  recall_memory: '检索记忆',
  add_memory: '写入记忆',
  skill_open: '调用技能',
  proma_skill: '调用技能',
}

/** 把工具名转为语义动作短语（E5） */
function toolActionLabel(toolName: string): string {
  if (TOOL_ACTION_LABELS[toolName]) return TOOL_ACTION_LABELS[toolName]!
  if (toolName.startsWith('mcp__')) {
    const server = toolName.split('__')[1]
    return server ? `MCP(${server})` : toolName
  }
  return toolName
}

/** 从工具调用名推断"关键决策"（E5 语义化：转中文动作短语） */
function toDecisionText(toolNames: string[]): string {
  if (toolNames.length === 0) return '未调用工具'
  const labels = [...new Set(toolNames.map(toolActionLabel))]
  const uniqueLabels = [...new Set(labels)]
  return `完成：${uniqueLabels.slice(0, 6).join('、')}${uniqueLabels.length > 6 ? ` 等 ${uniqueLabels.length} 项操作` : ''}`
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
  recordSource?: (q: import('@gravitas/shared').TokenUsageQuery) => import('@gravitas/shared').TokenUsageRecord[],
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

  // E5：语义化动作描述（决策用）
  const semanticActions = [...new Set(uniqueTools.map(toolActionLabel))].slice(0, 6)
  const summaryParts = [
    userMessage ? `目标：${userMessage.slice(0, 60)}` : `会话 ${sessionId}`,
    `${totalTurns} 轮，${totalTokens.toLocaleString()} tokens`,
    semanticActions.length > 0 ? `操作：${semanticActions.join('、')}` : '无工具调用',
    terminalState === 'completed' ? '运行成功' : '运行失败',
  ]

  return {
    decisions: uniqueTools.length > 0 ? [decisionText] : undefined,
    validation,
    writeback: writeback.length > 0 ? [...new Set(writeback)] : undefined,
    // E5：evidence 用语义动作描述，替代纯工具名堆砌
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

/**
 * 预留：LLM 语义级证据增强扩展口（E5）
 *
 * 当前为 no-op 占位（返回原 evidence），避免引入模型调用基础设施与联网副作用。
 * 未来接入方式：
 * 1. 通过 proma-cloud 获取 LLM 凭据（主进程需新增凭据注入/渠道密钥读取）
 * 2. 把 rawEvidence（decisions/writeback/validation）发送给便宜的模型
 * 3. 让模型生成更贴切的"决策/验证/阻塞"一句话描述，仍带配额与降级
 */
export async function enrichEvidenceWithLLM(
  evidence: RunEvidence,
  _options: { model?: string; apiKey?: string; baseUrl?: string } = {},
): Promise<RunEvidence> {
  // 暂不调 LLM：返回原始 evidence，等基础设施就绪后在此实现
  return evidence
}

/** 全局单例入口 */
export const evidenceService = {
  buildSessionEvidence,
  formatEvidenceSummary,
}

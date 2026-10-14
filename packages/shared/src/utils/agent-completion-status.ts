/**
 * Agent 任务完成态红绿灯解析
 *
 * Agent 系统提示词约定：多步任务每轮回复的最后一行是进度状态行，
 * 以单个 emoji（🟢/🟡/🔴）开头。本模块提供统一的解析工具，
 * 供渲染层将状态行升级为独立的状态条展示。
 *
 * 解析原则（容错优先）：
 * - 只识别文本的最后一个非空行，且该行必须以红绿灯 emoji 开头
 * - 任何不符合约定的情况（缺行、格式漂移、纯问答）返回 null，UI 不渲染
 * - 识别失败是正常退化路径，不视为错误
 */

/** 任务完成态：🔴 进行中（需求未达）/ 🟡 待决策（达成且剩余可成计划）/ 🟢 已完成（达成且剩余为零散存档） */
export type AgentTrafficLight = 'green' | 'yellow' | 'red'

/** 状态行解析结果 */
export interface AgentCompletionStatus {
  /** 红绿灯状态 */
  status: AgentTrafficLight
  /** emoji 之后的说明文字（已去除多余空白；可能为空） */
  detail: string
}

/** 红绿灯 emoji 到语义状态的映射 */
const TRAFFIC_LIGHT_MAP: Record<string, AgentTrafficLight> = {
  '🟢': 'green',
  '🟡': 'yellow',
  '🔴': 'red',
}

/**
 * 从一段回复文本中解析末尾的进度状态行。
 *
 * 仅当最后一个非空行以 🟢/🟡/🔴 开头时返回结果，否则返回 null。
 * 兼容行首少量 Markdown 装饰（引用符、加粗、列表符）。
 */
export function parseAgentCompletionStatus(text: string): AgentCompletionStatus | null {
  if (!text) return null

  const lines = text.trimEnd().split('\n')
  let lastLine = ''
  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i]!.trim()
    if (trimmed) {
      lastLine = trimmed
      break
    }
  }
  if (!lastLine) return null

  // 剥离行首常见 Markdown 装饰（引用、加粗、列表符、代码标记），再匹配 emoji
  const stripped = lastLine.replace(/^(?:>\s*|[-*+]\s+|\d+\.\s+|\*\*|`)+/, '')
  const match = stripped.match(/^(🟢|🟡|🔴)\s*[:：]?\s*(.*)$/)
  if (!match) return null

  const status = TRAFFIC_LIGHT_MAP[match[1]!]
  if (!status) return null

  // 去除行尾可能残留的成对加粗标记
  const detail = match[2]!.replace(/\*\*$/, '').trim()
  return { status, detail }
}

/**
 * 上下文压缩 Golden 基线。
 *
 * 每个样本都只保留人工审阅过的结构化字段，故意不放入原始对话、工具输出或凭据。
 * 这些是回归基线：真实 Provider 输出应先投影为 ContextPacket，再由 evaluator 比较。
 */

import type { ContextPacket } from '@gravitas/shared'
import type { ContextCompactionGoldenCase } from './context-compaction-evaluator'

export interface ContextCompactionGoldenFixture {
  golden: ContextCompactionGoldenCase
  packet: ContextPacket
}

export const CONTEXT_COMPACTION_GOLDENS: ContextCompactionGoldenFixture[] = [
  {
    golden: {
      id: 'long-running-plan',
      requiredFacts: ['Kimi K3'],
      requiredDecisions: ['ContextPacket v1'],
      requiredOpenTasks: ['P5'],
    },
    packet: {
      version: 1,
      summary: '长会话已压缩，继续完成 P5 质量门。',
      facts: ['用户使用 Kimi K3，模型窗口按 1M 处理。'],
      decisions: ['长期记忆使用 ContextPacket v1。'],
      openTasks: ['完成 P5 Golden 质量门。'],
      importantFiles: ['context-compaction.ts'],
      toolState: ['无未完成外部工具调用。'],
    },
  },
  {
    golden: {
      id: 'multi-tool-state',
      requiredFacts: ['工作区'],
      requiredDecisions: ['保留最近消息'],
      requiredOpenTasks: ['验证'],
    },
    packet: {
      version: 1,
      summary: '多工具会话保留工作区与待验证状态。',
      facts: ['工作区为 proma-mit，工具结果已持久化。'],
      decisions: ['压缩时保留最近消息以维持工具调用连续性。'],
      openTasks: ['验证工具调用后的继续执行。'],
      importantFiles: ['agent-session-manager.ts'],
      toolState: ['MCP 连接复用，当前没有待审批动作。'],
    },
  },
  {
    golden: {
      id: 'overflow-recovery',
      requiredFacts: ['上下文超限'],
      requiredDecisions: ['重试一次'],
      requiredOpenTasks: ['确认恢复结果'],
    },
    packet: {
      version: 1,
      summary: 'Provider 上下文超限后已压缩并进行一次安全重试。',
      facts: ['发生明确的上下文超限错误，尚未执行工具。'],
      decisions: ['溢出恢复只允许压缩后重试一次。'],
      openTasks: ['确认恢复结果并继续原任务。'],
      importantFiles: ['error-patterns.ts'],
      toolState: ['没有发生工具副作用。'],
    },
  },
]

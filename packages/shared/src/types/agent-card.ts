/**
 * Agent Card 统一身份模型
 *
 * 兼容 AI 员工档案（AgentEmployeeResult）与未来的通用 Agent / 外部 Agent，
 * 是 Agent Registry 与 Execution Contract 层的公共身份单元。
 * 对应文档「AI 员工 + 通用 Agent 融合」设计中的身份层种子。
 */
import type { AgentEmployeeResult } from './work-module'

export const AGENT_CARD_SOURCE_EMPLOYEE = 'employee'
export const AGENT_CARD_SOURCE_WORKFLOW = 'workflow'
export const AGENT_CARD_SOURCE_EXTERNAL = 'external'

export type AgentCardSource =
  | typeof AGENT_CARD_SOURCE_EMPLOYEE
  | typeof AGENT_CARD_SOURCE_WORKFLOW
  | typeof AGENT_CARD_SOURCE_EXTERNAL

export interface AgentCardRuntimeStats {
  totalRuns: number
  completedRuns: number
  avgDurationMs?: number
  failureCount: number
}

/** Agent Card：机器可读的 Agent 身份（身份层的最小可落地集） */
export interface AgentCard {
  /** 注册 ID（employee 场景即 employeeId，workflow 场景即 workflowId） */
  cardId: string
  source: AgentCardSource
  /** 当 source=employee 时关联的 AI 员工档案 ID */
  employeeId?: string
  name: string
  role: string
  description: string
  /** 能力声明（skills / 工具白名单等），约束可见性与可调用范围 */
  capabilities: string[]
  /** 绑定的固定 Workflow SOP ID（如有） */
  fixedWorkflowId?: string
  /** 累计执行统计，Registry 聚合展示用 */
  executionStats?: AgentCardRuntimeStats
  enabled: boolean
  createdAt: number
  updatedAt: number
}

/** 从 AI 员工档案构建 Agent Card（后续服务端同步与契约派发的基础） */
export function buildAgentCardFromEmployee(emp: AgentEmployeeResult): AgentCard {
  return {
    cardId: emp.id,
    source: AGENT_CARD_SOURCE_EMPLOYEE,
    employeeId: emp.id,
    name: emp.name,
    role: emp.role,
    description: emp.description,
    capabilities: emp.skills ?? [],
    fixedWorkflowId: emp.workflowId,
    executionStats: {
      totalRuns: emp.totalTasks,
      completedRuns: emp.completedTasks,
      avgDurationMs: emp.avgDurationMs,
      failureCount: emp.failureCount,
    },
    enabled: emp.enabled,
    createdAt: emp.createdAt,
    updatedAt: emp.updatedAt,
  }
}

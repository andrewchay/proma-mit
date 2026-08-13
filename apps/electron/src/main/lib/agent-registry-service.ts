/**
 * 本地 Agent Registry（轻量版身份层种子）
 *
 * 现阶段以 AI 员工档案（agent_employees）为唯一事实源；
 * Registry 提供统一的 Agent Card 视图，供契约层派发、服务端同步与治理看板消费。
 * 对应「AI 员工 + 通用 Agent 融合」设计的身份层落地。
 */
import type { AgentCard } from '@gravitas/shared'
import { buildAgentCardFromEmployee } from '@gravitas/shared'
import * as store from './project-sqlite-store'

/** 列出全部在编 AI 员工为 Agent Cards */
export function listAgentCards(): AgentCard[] {
  return store.listAgentEmployees().map(buildAgentCardFromEmployee)
}

/** 按 cardId 读取单个 Agent Card（employee 场景 cardId === employeeId） */
export function getAgentCard(cardId: string): AgentCard | null {
  const emp = store.getAgentEmployee(cardId)
  return emp ? buildAgentCardFromEmployee(emp) : null
}

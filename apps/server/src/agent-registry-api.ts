/**
 * 服务端 Agent Registry API 处理器
 *
 * GET  /agent/registry            → 列出本租户卡片（可按 source/enabled 过滤）
 * PUT  /agent/registry            → upsert 一张卡片到本租户
 *
 * 依赖 app.ts 的 scope 解析与 RBAC 校验，本层只做参数校验与透传。
 */
import type { AgentRuntimeScope } from '@gravitas/shared/utils'
import type { AgentCard, AgentCardSource } from '@gravitas/shared'
import type { RegistryQuery } from './agent-registry'

export const AGENT_CARD_SOURCES: ReadonlySet<AgentCardSource> = new Set(['employee', 'workflow', 'external'])

/** 二次校验 AgentCard 形状，返回错误消息或 null（合法） */
export function validateAgentCard(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return '卡片必须是对象'
  const card = value as Record<string, unknown>
  if (typeof card.cardId !== 'string' || !card.cardId.trim()) return 'cardId 必须是非空字符串'
  if (typeof card.source !== 'string' || !AGENT_CARD_SOURCES.has(card.source as AgentCardSource)) return `source 必须是 ${[...AGENT_CARD_SOURCES].join('|')} 之一`
  if (typeof card.name !== 'string' || !card.name.trim()) return 'name 必须是非空字符串'
  if (typeof card.role !== 'string' || !card.role.trim()) return 'role 必须是非空字符串'
  if (typeof card.description !== 'string') return 'description 必须是字符串'
  if (card.capabilities !== undefined) {
    if (!Array.isArray(card.capabilities) || !card.capabilities.every((c) => typeof c === 'string')) return 'capabilities 必须是字符串数组'
  }
  if (typeof card.enabled !== 'boolean') return 'enabled 必须是布尔值'
  return null
}

export function parseAgentCardFromBody(body: unknown): { card?: AgentCard; error?: string } {
  const error = validateAgentCard(body)
  if (error) return { error }
  const b = body as Record<string, unknown>
  return {
    card: {
      cardId: b.cardId as string,
      source: b.source as AgentCardSource,
      employeeId: typeof b.employeeId === 'string' ? b.employeeId : undefined,
      name: b.name as string,
      role: b.role as string,
      description: b.description as string,
      capabilities: Array.isArray(b.capabilities) ? b.capabilities as string[] : [],
      fixedWorkflowId: typeof b.fixedWorkflowId === 'string' ? b.fixedWorkflowId : undefined,
      executionStats: b.executionStats && typeof b.executionStats === 'object' ? b.executionStats as AgentCard['executionStats'] : undefined,
      enabled: b.enabled as boolean,
      createdAt: typeof b.createdAt === 'number' ? b.createdAt : Date.now(),
      updatedAt: typeof b.updatedAt === 'number' ? b.updatedAt : Date.now(),
    },
  }
}

export function parseRegistryListQuery(_scope: AgentRuntimeScope, searchParams: URLSearchParams): {
  query: RegistryQuery
  error?: string
} {
  const source = searchParams.get('source')
  if (source != null && source !== '' && !AGENT_CARD_SOURCES.has(source as AgentCardSource)) {
    return { query: {}, error: `source 必须是 ${[...AGENT_CARD_SOURCES].join('|')} 之一` }
  }
  const enabledRaw = searchParams.get('enabled')
  const enabled = enabledRaw == null || enabledRaw === '' ? undefined : enabledRaw === 'true' ? true : enabledRaw === 'false' ? false : undefined
  const limitRaw = searchParams.get('limit')
  const limit = limitRaw == null || limitRaw === '' ? undefined : Number(limitRaw)
  if (limit != null && (!Number.isFinite(limit) || limit < 1 || limit > 1000)) {
    return { query: {}, error: 'limit 必须是 1..1000 的整数' }
  }
  return { query: { source: source || undefined, enabled, limit } }
}

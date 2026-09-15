/**
 * 知识范围解析服务（K1-02）
 *
 * 回答唯一的问题：**这个会话现在可以检索哪些资料？**
 *
 * 这是权限边界的核心，因此有三条设计约束：
 *
 * 1. **范围来自持久化会话，不来自工具参数**。工具参数里的 projectId 或
 *    knowledgeBaseId 只是"请求"，不能成为授权依据 —— 否则模型只要编一个
 *    ID 就能读到其他 Project 的资料。
 *
 * 2. **实时解析，不缓存范围**。Project 解除关联、知识库停用、来源被删除
 *    都必须立刻生效，所以每次调用都重新读目录，只把修订号用于缓存失效。
 *
 * 3. **缺省为空**。会话没有知识配置时返回 none，而不是退回"搜索所有
 *    Vault"。静默扩大范围比功能不可用危险得多。
 */

import { readCatalog, listRetrievableSources, listProjectKnowledgeBases } from './knowledge-catalog-service'
import type { AgentSessionMeta, KnowledgeBase, KnowledgeSource } from '@gravitas/shared'

export type KnowledgeScopeMode = 'project' | 'explicit' | 'none'

/** 解析输入：会话 ID 与该会话的持久化元数据 */
export interface KnowledgeScopeRequest {
  sessionId: string
  /** 会话元数据的知识相关字段；旧会话可能只有部分字段 */
  sessionMeta: Pick<
    AgentSessionMeta,
    'knowledgeScopeMode' | 'explicitKnowledgeBaseIds' | 'projectId'
  >
}

export interface ResolvedKnowledgeScope {
  sessionId: string
  mode: KnowledgeScopeMode
  /** 实际生效的知识库 ID（已过滤不存在的、已停用的） */
  knowledgeBaseIds: string[]
  /**
   * 范围修订号。
   *
   * 由目录修订号与解析结果共同派生：任何一次目录变更或范围变化都会
   * 改变它，因此可以直接作为检索缓存键的一部分。
   */
  scopeRevision: string
}

export interface ResolvedRetrievableScope extends ResolvedKnowledgeScope {
  /** 真正参与检索的来源（知识库与来源都必须启用） */
  sources: KnowledgeSource[]
  /** 命中的知识库对象，供 UI 展示名称与状态 */
  knowledgeBases: KnowledgeBase[]
}

/**
 * 解析会话的知识范围。
 *
 * 顺序：先取会话声明的知识库集合，再逐项校验目录中是否真实存在且启用。
 * 校验后为空说明范围已失效，此时按 none 处理并保持 knowledgeBaseIds 为空。
 */
export function resolveKnowledgeScope(request: KnowledgeScopeRequest): ResolvedKnowledgeScope {
  const mode: KnowledgeScopeMode = request.sessionMeta.knowledgeScopeMode ?? 'none'
  const catalog = readCatalog()

  if (mode === 'none') {
    // 旧会话与未配置会话都走这里：不读取任何资料
    return {
      sessionId: request.sessionId,
      mode: 'none',
      knowledgeBaseIds: [],
      scopeRevision: deriveScopeRevision(catalog.revision.revision, 'none', []),
    }
  }

  const declaredIds =
    mode === 'project'
      ? request.sessionMeta.projectId
        ? listProjectKnowledgeBases(request.sessionMeta.projectId).map((kb) => kb.id)
        : []
      : (request.sessionMeta.explicitKnowledgeBaseIds ?? [])

  // 存在的、启用的知识库才进入范围；伪造或已删除的 ID 被静默过滤
  const knowledgeBaseIds = declaredIds.filter((id) =>
    catalog.knowledgeBases.some((kb) => kb.id === id && kb.enabled),
  )

  return {
    sessionId: request.sessionId,
    mode,
    knowledgeBaseIds,
    scopeRevision: deriveScopeRevision(catalog.revision.revision, mode, knowledgeBaseIds),
  }
}

/**
 * 解析可检索来源。
 *
 * 在范围解析之上再做一层来源级校验：知识库启用不代表其来源启用。
 * 本次调用的结果就是"能否检索某份资料"的权威答案。
 */
export function resolveRetrievableScope(request: KnowledgeScopeRequest): ResolvedRetrievableScope {
  const scope = resolveKnowledgeScope(request)
  const catalog = readCatalog()

  const knowledgeBases = scope.knowledgeBaseIds
    .map((id) => catalog.knowledgeBases.find((kb) => kb.id === id))
    .filter((kb): kb is KnowledgeBase => kb !== undefined)

  const sources: KnowledgeSource[] = []
  for (const kb of knowledgeBases) {
    for (const source of listRetrievableSources(kb.id)) {
      if (!sources.some((s) => s.id === source.id)) sources.push(source)
    }
  }

  return {
    ...scope,
    scopeRevision: deriveScopeRevision(
      catalog.revision.revision,
      scope.mode,
      scope.knowledgeBaseIds,
      sources.map((s) => s.id),
    ),
    sources,
    knowledgeBases,
  }
}

/**
 * 判断请求的知识库集合是否超出了父会话允许的范围。
 *
 * 子 Agent 只能继承或收窄父范围，不能扩大。返回 false 时调用方必须拒绝
 * 该请求，而不是取交集后继续 —— 越权请求本身就是异常信号。
 */
export function assertScopeNotExpanded(input: {
  parentKnowledgeBaseIds: string[]
  requestedKnowledgeBaseIds: string[]
}): boolean {
  const allowed = new Set(input.parentKnowledgeBaseIds)
  return input.requestedKnowledgeBaseIds.every((id) => allowed.has(id))
}

/**
 * 派生范围修订号。
 *
 * 只用于缓存键与变更检测，不承载安全语义（安全由每次实时解析保证）。
 * 排序后拼接，保证同一集合产生同一修订号。
 */
function deriveScopeRevision(
  catalogRevision: number,
  mode: KnowledgeScopeMode,
  knowledgeBaseIds: string[],
  sourceIds: string[] = [],
): string {
  const stable = [...knowledgeBaseIds].sort().join(',')
  const stableSources = [...sourceIds].sort().join(',')
  return `${catalogRevision}:${mode}:${stable}:${stableSources}`
}

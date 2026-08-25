/**
 * 本地上下文存储服务
 *
 * 为 Agent 运行时提供：
 * - 按工作区管理 context-store 实例
 * - 自动写入（消息索引）
 * - 召回（用于 DynamicContext 注入）
 */

import { openContextStore, upsertEntity, recall } from '@gravitas/context-store'
import type { ContextStoreHandle, ContextEntity, RecallResult } from '@gravitas/context-store'

/** 单例实例 */
let serviceInstance: ContextStoreService | null = null

export class ContextStoreService {
  private stores = new Map<string, ContextStoreHandle>()

  /**
   * 获取或创建工作区的 context store。
   */
  async getStore(workspaceSlug?: string): Promise<ContextStoreHandle> {
    const key = workspaceSlug ?? '__global__'
    let handle = this.stores.get(key)
    if (!handle) {
      handle = await openContextStore({ workspaceSlug })
      this.stores.set(key, handle)
    }
    return handle
  }

  /**
   * 召回工作区内的相关上下文。
   */
  async recall(workspaceSlug: string | undefined, query: string, limit?: number): Promise<RecallResult> {
    const store = await this.getStore(workspaceSlug)
    return recall(store, query, { limit })
  }

  /**
   * 索引一条会话消息到 context store。
   */
  async indexMessage(
    workspaceSlug: string | undefined,
    sessionId: string,
    role: 'user' | 'assistant' | 'tool',
    content: string,
    occurredAt: number,
  ): Promise<void> {
    const store = await this.getStore(workspaceSlug)
    const entity: ContextEntity = {
      id: `msg:${sessionId}:${occurredAt}`,
      entityType: 'session_message',
      sourceId: sessionId,
      sourceType: 'agent_session',
      title: `${role}: ${content.slice(0, 80)}${content.length > 80 ? '...' : ''}`,
      content,
      occurredAt,
    }
    upsertEntity(store, entity)
    store.persist()
  }

  /**
   * 索引工具调用结果。
   */
  async indexToolCall(
    workspaceSlug: string | undefined,
    sessionId: string,
    toolName: string,
    result: string,
    occurredAt: number,
  ): Promise<void> {
    const store = await this.getStore(workspaceSlug)
    const entity: ContextEntity = {
      id: `tool:${sessionId}:${toolName}:${occurredAt}`,
      entityType: 'tool_call',
      sourceId: sessionId,
      sourceType: 'agent_session',
      title: `tool: ${toolName}`,
      content: result,
      occurredAt,
    }
    upsertEntity(store, entity)
    store.persist()
  }

  /**
   * 关闭所有 store 并持久化。
   */
  async shutdown(): Promise<void> {
    for (const [key, handle] of this.stores) {
      try {
        handle.persist()
        handle.close()
      } catch (err) {
        console.error(`[ContextStoreService] 关闭 store 失败 (${key}):`, err)
      }
    }
    this.stores.clear()
  }
}

/** 获取单例服务 */
export function getContextStoreService(): ContextStoreService {
  if (!serviceInstance) {
    serviceInstance = new ContextStoreService()
  }
  return serviceInstance
}

/** 重置单例（测试用） */
export function _resetContextStoreService(): void {
  serviceInstance = null
}

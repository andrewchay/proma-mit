/**
 * 本地上下文存储服务
 *
 * 为 Agent 运行时提供：
 * - 按工作区管理 context-store 实例
 * - 自动写入（消息索引）
 * - 召回（用于 DynamicContext 注入）
 */

import { join } from 'node:path'
import { getConfigDir } from './config-paths'
import { openContextStore, upsertEntity, recall } from '@gravitas/context-store'
import type { ContextStoreHandle, ContextEntity, RecallResult } from '@gravitas/context-store'

/** 单例实例 */
let serviceInstance: ContextStoreService | null = null

export class ContextStoreService {
  private closing = false
  private stores = new Map<string, ContextStoreHandle>()
  private opening = new Map<string, Promise<ContextStoreHandle>>()

  /**
   * 获取或创建工作区的 context store。
   */
  async getStore(workspaceSlug?: string): Promise<ContextStoreHandle> {
    if (this.closing) throw new Error('Context Store 服务已关闭')
    const key = workspaceSlug ?? '__global__'
    let handle = this.stores.get(key)
    if (!handle) {
      if (!/^[A-Za-z0-9_][A-Za-z0-9._-]*$/.test(key) || key === '.' || key === '..') throw new Error('工作区 slug 不合法')
      let pending = this.opening.get(key)
      if (!pending) {
        pending = openContextStore({ path: join(getConfigDir(), 'context-store', key, 'context-store.db') })
        this.opening.set(key, pending)
      }
      try {
        handle = await pending
        this.stores.set(key, handle)
      } finally {
        this.opening.delete(key)
      }
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
    this.closing = true
    // 等待已进入服务的打开操作，让同一轮排队的索引先完成。
    const opened = await Promise.allSettled([...this.opening.values()])
    const errors: unknown[] = opened.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
    for (const [key, handle] of this.stores) {
      try {
        handle.close()
        this.stores.delete(key)
      } catch (error) { errors.push(error) }
    }
    if (errors.length) throw new AggregateError(errors, 'Context Store 关闭或持久化失败')

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

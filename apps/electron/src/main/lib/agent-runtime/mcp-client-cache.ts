/**
 * MCP 客户端跨会话缓存
 *
 * Provider-Agnostic Runtime 每次会话都新建 McpClientManager 会导致：
 * 1. 每个会话都要重新建立 SSE/HTTP 连接，耗时且浪费；
 * 2. OAuth token 每次都要从磁盘读取。
 *
 * 本缓存按 workspaceSlug + 配置指纹复用已连接的 McpClientManager，
 * 最后一次使用后 5 分钟自动断开，避免长期占用。
 */

import type { McpServerEntry } from '@proma/shared'
import { McpClientManager, type McpAuthRequiredPayload } from './mcp-client'

interface CachedEntry {
  workspaceSlug: string
  manager: McpClientManager
  configsHash: string
  lastUsedAt: number
  ttlTimer: ReturnType<typeof setTimeout>
}

const cache = new Map<string, CachedEntry>()
const TTL_MS = 5 * 60 * 1000

function hashConfigs(configs: Record<string, McpServerEntry>): string {
  // 按名称排序后序列化，保证相同配置得到相同指纹
  const entries = Object.entries(configs).sort(([a], [b]) => a.localeCompare(b))
  return JSON.stringify(entries, Object.keys(configs).sort())
}

function makeKey(workspaceSlug: string): string {
  return workspaceSlug
}

function resetTtl(entry: CachedEntry): void {
  clearTimeout(entry.ttlTimer)
  entry.lastUsedAt = Date.now()
  entry.ttlTimer = setTimeout(() => {
    entry.manager.disconnect().catch((err: unknown) => {
      console.warn('[MCP 客户端缓存] 断开连接失败:', err)
    })
    cache.delete(makeKey(entry.workspaceSlug))
  }, TTL_MS)
}

/**
 * 获取或创建 McpClientManager
 *
 * 返回 manager 与 release 函数；调用方必须在会话结束时调用 release。
 * 缓存中的 manager 不会随 session abort 断开，生命周期由缓存管理。
 */
export async function acquireMcpClientManager(
  workspaceSlug: string,
  configs: Record<string, McpServerEntry>,
  cwd: string,
  options: {
    onMcpAuthRequired?: (payload: McpAuthRequiredPayload) => void
  },
): Promise<{ manager: McpClientManager; release: () => void }> {
  const key = makeKey(workspaceSlug)
  const configsHash = hashConfigs(configs)
  const existing = cache.get(key)

  if (existing && existing.configsHash === configsHash) {
    resetTtl(existing)
    return {
      manager: existing.manager,
      release: () => {
        resetTtl(existing)
      },
    }
  }

  // 配置变化时先清理旧缓存
  if (existing) {
    clearTimeout(existing.ttlTimer)
    existing.manager.disconnect().catch((err: unknown) => {
      console.warn('[MCP 客户端缓存] 配置变化，断开旧连接失败:', err)
    })
    cache.delete(key)
  }

  const manager = new McpClientManager(configs, cwd, {
    workspaceSlug,
    onMcpAuthRequired: options.onMcpAuthRequired,
    disconnectOnAbort: false,
  })
  await manager.connectAll()

  const entry: CachedEntry = {
    workspaceSlug,
    manager,
    configsHash,
    lastUsedAt: Date.now(),
    ttlTimer: setTimeout(() => {
      manager.disconnect().catch((err: unknown) => {
        console.warn('[MCP 客户端缓存] TTL 断开连接失败:', err)
      })
      cache.delete(key)
    }, TTL_MS),
  }
  cache.set(key, entry)

  return {
    manager,
    release: () => {
      resetTtl(entry)
    },
  }
}

/** 清空所有缓存并断开连接（主要用于测试或退出） */
export async function clearMcpClientCache(): Promise<void> {
  for (const [, entry] of cache) {
    clearTimeout(entry.ttlTimer)
    await entry.manager.disconnect().catch(() => { /* ignore */ })
  }
  cache.clear()
}

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { ContextStoreService, _resetContextStoreService } from './context-store-service.ts'
import { mkdirSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

describe('ContextStoreService', () => {
  const testSlug = '__test_ctx_service__'
  const testPath = join(homedir(), '.proma', 'workspaces', testSlug, 'context-store.db')

  beforeEach(() => {
    _resetContextStoreService()
    // 清理测试数据
    if (existsSync(testPath)) {
      rmSync(testPath)
    }
  })

  afterEach(() => {
    if (existsSync(testPath)) {
      rmSync(testPath)
    }
  })

  it('should index and recall messages', async () => {
    const service = new ContextStoreService()

    // 索引消息
    await service.indexMessage(testSlug, 'session-1', 'user', '如何部署到生产环境？', 1700000000000)
    await service.indexMessage(testSlug, 'session-1', 'assistant', '你可以使用 Docker 部署', 1700000001000)

    // 召回
    const result = await service.recall(testSlug, '部署', 5)
    expect(result.hits.length).toBeGreaterThan(0)
    expect(result.relaxed).toBe(false)
  })

  it('should index tool calls', async () => {
    const service = new ContextStoreService()

    await service.indexToolCall(testSlug, 'session-2', 'Bash', 'docker build -t app .', 1700000000000)

    const result = await service.recall(testSlug, 'docker', 5)
    expect(result.hits.length).toBeGreaterThan(0)
  })

  it('should return empty for no match', async () => {
    const service = new ContextStoreService()

    await service.indexMessage(testSlug, 'session-3', 'user', 'hello world', 1700000000000)

    const result = await service.recall(testSlug, '完全不相关的查询', 5)
    expect(result.hits).toHaveLength(0)
  })

  it('should use workspace isolation', async () => {
    const service = new ContextStoreService()
    const otherSlug = '__test_other__'
    const otherPath = join(homedir(), '.proma', 'workspaces', otherSlug, 'context-store.db')

    try {
      // 在 workspace A 索引
      await service.indexMessage(testSlug, 'session-a', 'user', 'workspace A content', 1700000000000)
      // 在 workspace B 索引
      await service.indexMessage(otherSlug, 'session-b', 'user', 'workspace B content', 1700000000000)

      // 从 workspace A 召回，不应命中 B 的内容
      const resultA = await service.recall(testSlug, 'workspace B', 5)
      // 由于是不同的 store 实例，确实隔离
      expect(resultA.hits.some((h) => h.entity.content?.includes('workspace B'))).toBe(false)
    } finally {
      if (existsSync(otherPath)) {
        rmSync(otherPath)
      }
    }
  })
})

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { ContextStoreService, _resetContextStoreService } from './context-store-service.ts'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

describe('ContextStoreService', () => {
  const testSlug = '__test_ctx_service__'
  const original = process.env.PROMA_TEST_CONFIG_DIR
  let directory: string
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'gravitas-context-service-'))
    process.env.PROMA_TEST_CONFIG_DIR = directory
    _resetContextStoreService()
  })
  afterEach(() => {
    rmSync(directory, { recursive: true, force: true })
    if (original === undefined) delete process.env.PROMA_TEST_CONFIG_DIR
    else process.env.PROMA_TEST_CONFIG_DIR = original
  })

  it('Given 并发索引 When 关闭服务并重建 Then 两条消息都保留', async () => {
    const service = new ContextStoreService()
    await Promise.all([
      service.indexMessage(testSlug, 'a', 'user', 'alpha persistent', 1),
      service.indexMessage(testSlug, 'b', 'user', 'beta persistent', 2),
    ])
    await service.shutdown()
    const reopened = new ContextStoreService()
    expect((await reopened.recall(testSlug, 'alpha')).hits).toHaveLength(1)
    expect((await reopened.recall(testSlug, 'beta')).hits).toHaveLength(1)
    await reopened.shutdown()
  })

  it('Given 索引正在打开数据库 When 同时关闭 Then 先完成索引且拒绝新操作', async () => {
    const service = new ContextStoreService()
    const pending = service.indexMessage(testSlug, 'closing', 'user', 'closing durable', 9)
    await service.shutdown()
    await pending
    await expect(service.recall(testSlug, 'closing')).rejects.toThrow('已关闭')
    const reopened = new ContextStoreService()
    expect((await reopened.recall(testSlug, 'closing')).hits).toHaveLength(1)
    await reopened.shutdown()
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
    const otherPath = join(directory, 'context-store', otherSlug, 'context-store.db')

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

import { describe, it, expect, beforeEach } from 'bun:test'
import { openContextStore } from '../store.ts'
import type { ContextStoreHandle, ContextEntity } from '../index.ts'

async function createTestStore(): Promise<ContextStoreHandle> {
  return openContextStore()
}

describe('两档召回', () => {
  let handle: ContextStoreHandle

  beforeEach(async () => {
    handle = await createTestStore()
  })

  it('严格档：词序一致时命中', () => {
    handle.entities.upsert({
      id: 'recall:strict-1',
      entityType: 'run',
      sourceId: 'strict-1',
      sourceType: 'run_store',
      title: '沙箱环境部署',
      content: '在沙箱环境中完成部署',
      occurredAt: 1700000000000,
    })

    // 词序与原文一致 → 严格档命中
    const result = handle.search.recall('沙箱环境')
    expect(result.hits.length).toBeGreaterThan(0)
    expect(result.relaxed).toBe(false)
  })

  it('放宽档：换词序时兜底召回', () => {
    handle.entities.upsert({
      id: 'recall:relaxed-1',
      entityType: 'run',
      sourceId: 'relaxed-1',
      sourceType: 'run_store',
      title: '沙箱环境部署完成',
      content: '测试内容',
      occurredAt: 1700000000000,
    })

    // 换词序："部署沙箱" → 严格档含 bigram「署沙」原文没有 → 0 命中
    // 放宽档去掉 bigram → 单字「部」「署」「沙」「箱」→ 命中
    const result = handle.search.recall('部署沙箱')
    expect(result.hits.length).toBeGreaterThan(0)
    expect(result.relaxed).toBe(true)
  })

  it('混合查询：CJK + ASCII', () => {
    handle.entities.upsert({
      id: 'recall:mixed-1',
      entityType: 'run',
      sourceId: 'mixed-1',
      sourceType: 'run_store',
      title: '修复 production bug',
      content: '线上环境出现 bug，需要修复',
      occurredAt: 1700000000000,
    })

    const result = handle.search.recall('修复 bug')
    expect(result.hits.length).toBeGreaterThan(0)
    expect(result.tokens).toContain('修复')
    expect(result.tokens).toContain('bug')
  })

  it('空查询返回空结果', () => {
    const result = handle.search.recall('')
    expect(result.hits).toHaveLength(0)
    expect(result.tokens).toHaveLength(0)
    expect(result.relaxed).toBe(false)
  })

  it('无匹配返回空结果', () => {
    handle.entities.upsert({
      id: 'recall:nomatch-1',
      entityType: 'run',
      sourceId: 'nomatch-1',
      sourceType: 'run_store',
      title: '数据库迁移',
      occurredAt: 1700000000000,
    })

    const result = handle.search.recall('完全不相关的查询')
    expect(result.hits).toHaveLength(0)
  })
})

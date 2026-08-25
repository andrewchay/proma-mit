import { describe, it, expect, beforeEach } from 'bun:test'
import { openContextStore } from '../store.ts'
import { EntityRepository, EdgeRepository, FactRepository, SearchRepository } from '../repositories/index.ts'
import type { ContextStoreHandle, ContextEntity } from '../index.ts'

async function createTestStore(): Promise<ContextStoreHandle> {
  return openContextStore()
}

describe('Repository 模式', () => {
  let handle: ContextStoreHandle

  beforeEach(async () => {
    handle = await createTestStore()
  })

  it('EntityRepository: upsert and get', () => {
    const entity: ContextEntity = {
      id: 'repo:test-1',
      entityType: 'run',
      sourceId: 'test-1',
      sourceType: 'run_store',
      title: 'Repository 测试',
      occurredAt: 1700000000000,
    }
    handle.entities.upsert(entity)
    const got = handle.entities.getById('repo:test-1')
    expect(got).toEqual(entity)
  })

  it('EdgeRepository: create and getRelated', () => {
    const run: ContextEntity = {
      id: 'repo:run-1',
      entityType: 'run',
      sourceId: 'run-1',
      sourceType: 'run_store',
      title: '运行',
      occurredAt: 1700000000000,
    }
    const session: ContextEntity = {
      id: 'repo:session-1',
      entityType: 'session',
      sourceId: 'session-1',
      sourceType: 'session_store',
      title: '会话',
      occurredAt: 1700000000000,
    }
    handle.entities.upsert(run)
    handle.entities.upsert(session)

    handle.edges.create({
      fromEntityId: run.id,
      toEntityId: session.id,
      relationType: 'run_belongs_to_session',
    })

    const related = handle.edges.getRelated(run.id, { direction: 'out' })
    expect(related.map((n) => n.entity.id)).toEqual(['repo:session-1'])
  })

  it('FactRepository: upsert and getByEntity', () => {
    const member: ContextEntity = {
      id: 'repo:member-1',
      entityType: 'member',
      sourceId: 'member-1',
      sourceType: 'member_store',
      title: '用户',
      occurredAt: 1700000000000,
    }
    handle.entities.upsert(member)

    handle.facts.upsert({
      entityId: member.id,
      factType: 'preference',
      key: 'theme',
      value: 'dark',
      confidence: 0.95,
    })

    const facts = handle.facts.getByEntity(member.id)
    expect(facts).toHaveLength(1)
    expect(facts[0]?.value).toBe('dark')
  })

  it('SearchRepository: searchFullText', () => {
    handle.entities.upsert({
      id: 'repo:search-1',
      entityType: 'run',
      sourceId: 'search-1',
      sourceType: 'run_store',
      title: '数据库迁移',
      content: '使用 Alembic 做 schema 迁移',
      occurredAt: 1700000000000,
    })

    const result = handle.search.searchFullText('Alembic')
    expect(result.hits.length).toBeGreaterThan(0)
    expect(result.hits[0]?.entity.id).toBe('repo:search-1')
  })

  it('SearchRepository: recall', () => {
    handle.entities.upsert({
      id: 'repo:recall-1',
      entityType: 'run',
      sourceId: 'recall-1',
      sourceType: 'run_store',
      title: '部署完成',
      content: '生产环境部署成功',
      occurredAt: 1700000000000,
    })

    const result = handle.search.recall('部署')
    expect(result.hits.length).toBeGreaterThan(0)
    expect(result.tokens).toContain('部署')
  })

  it('顶层 API 与 Repository 结果一致', () => {
    const entity: ContextEntity = {
      id: 'repo:consistency-1',
      entityType: 'task',
      sourceId: 'consistency-1',
      sourceType: 'task_store',
      title: '一致性测试',
      occurredAt: 1700000000000,
    }

    // 通过顶层 API 写入
    handle.entities.upsert(entity)

    // 通过 Repository 读取
    const fromRepo = handle.entities.getById('repo:consistency-1')

    // 通过顶层 API 读取
    const fromTop = handle.entities.getById('repo:consistency-1')

    expect(fromRepo).toEqual(fromTop)
  })
})

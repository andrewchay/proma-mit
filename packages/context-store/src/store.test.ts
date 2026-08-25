import { describe, it, expect, beforeEach } from 'bun:test'
import { openContextStore, upsertEntity, getEntity, listEntities, link, getRelated, searchFullText, recall, upsertFact, getFacts, deleteEntity, unlink, runMigrations, MIGRATIONS } from './index.ts'
import type { ContextEntity, ContextStoreHandle } from './index.ts'

async function createTestStore(): Promise<ContextStoreHandle> {
  return openContextStore()
}

describe('context-store', () => {
  let handle: ContextStoreHandle

  beforeEach(async () => {
    handle = await createTestStore()
  })

  it('should apply migrations on open', () => {
    expect(handle.appliedMigrations.length).toBeGreaterThan(0)
    expect(handle.appliedVersion).toBeGreaterThanOrEqual(1)
  })

  it('should upsert and retrieve an entity', () => {
    const entity: ContextEntity = {
      id: 'run:test-1',
      entityType: 'run',
      sourceId: 'test-1',
      sourceType: 'run_store',
      title: '测试运行',
      detail: 'completed',
      content: '运行内容：修复了登录 bug',
      occurredAt: 1700000000000,
    }
    upsertEntity(handle, entity)
    const got = getEntity(handle, 'run:test-1')
    expect(got).toEqual(entity)
  })

  it('should update existing entity on upsert', () => {
    const entity: ContextEntity = {
      id: 'run:test-2',
      entityType: 'run',
      sourceId: 'test-2',
      sourceType: 'run_store',
      title: '旧标题',
      occurredAt: 1700000000000,
    }
    upsertEntity(handle, entity)
    upsertEntity(handle, { ...entity, title: '新标题', content: '新内容' })
    const got = getEntity(handle, 'run:test-2')
    expect(got?.title).toBe('新标题')
    expect(got?.content).toBe('新内容')
  })

  it('should list entities by type sorted by time', () => {
    upsertEntity(handle, makeEntity('run:a', 'run', 1000))
    upsertEntity(handle, makeEntity('run:b', 'run', 2000))
    upsertEntity(handle, makeEntity('task:c', 'task', 3000))
    const runs = listEntities(handle, 'run')
    expect(runs.map((r) => r.id)).toEqual(['run:b', 'run:a'])
  })

  it('should link entities and query related', () => {
    const run = makeEntity('run:r1', 'run', 1000, '会话运行')
    const session = makeEntity('session:s1', 'session', 900, '用户会话')
    upsertEntity(handle, run)
    upsertEntity(handle, session)
    link(handle, { fromEntityId: run.id, toEntityId: session.id, relationType: 'run_belongs_to_session' })

    const related = getRelated(handle, run.id, { direction: 'out' })
    expect(related.map((n) => n.entity.id)).toEqual(['session:s1'])
    expect(related[0]?.edge.relationType).toBe('run_belongs_to_session')

    const inbound = getRelated(handle, session.id, { direction: 'in' })
    expect(inbound.map((n) => n.entity.id)).toEqual(['run:r1'])
  })

  it('should query related in both directions', () => {
    const a = makeEntity('a', 'member', 1000)
    const b = makeEntity('b', 'task', 900)
    upsertEntity(handle, a)
    upsertEntity(handle, b)
    link(handle, { fromEntityId: a.id, toEntityId: b.id, relationType: 'member_owns_task' })

    expect(getRelated(handle, a.id, { direction: 'both' }).map((n) => n.entity.id)).toEqual(['b'])
    expect(getRelated(handle, b.id, { direction: 'both' }).map((n) => n.entity.id)).toEqual(['a'])
  })

  it('should filter related by relation type', () => {
    const run = makeEntity('run:r2', 'run', 1000)
    const session = makeEntity('session:s2', 'session', 900)
    const member = makeEntity('member:m2', 'member', 800)
    upsertEntity(handle, run)
    upsertEntity(handle, session)
    upsertEntity(handle, member)
    link(handle, { fromEntityId: run.id, toEntityId: session.id, relationType: 'run_belongs_to_session' })
    link(handle, { fromEntityId: run.id, toEntityId: member.id, relationType: 'run_owned_by_member' })

    const onlySession = getRelated(handle, run.id, { relationTypes: ['run_belongs_to_session'] })
    expect(onlySession.map((n) => n.entity.id)).toEqual(['session:s2'])
  })

  it('should unlink relations', () => {
    const a = makeEntity('a2', 'member', 1000)
    const b = makeEntity('b2', 'task', 900)
    upsertEntity(handle, a)
    upsertEntity(handle, b)
    link(handle, { fromEntityId: a.id, toEntityId: b.id, relationType: 'member_owns_task' })
    expect(getRelated(handle, a.id, { direction: 'out' }).length).toBe(1)
    unlink(handle, a.id, b.id, 'member_owns_task')
    expect(getRelated(handle, a.id, { direction: 'out' }).length).toBe(0)
  })

  it('should store and retrieve facts', () => {
    const member = makeEntity('member:m3', 'member', 1000)
    upsertEntity(handle, member)
    upsertFact(handle, { entityId: member.id, factType: 'preference', key: 'editor', value: 'VSCode', confidence: 0.95 })
    const facts = getFacts(handle, member.id)
    expect(facts).toHaveLength(1)
    expect(facts[0]?.value).toBe('VSCode')
    expect(facts[0]?.confidence).toBe(0.95)
  })

  it('should delete entity and cascade edges/facts', () => {
    const a = makeEntity('del-a', 'run', 1000)
    const b = makeEntity('del-b', 'session', 900)
    upsertEntity(handle, a)
    upsertEntity(handle, b)
    link(handle, { fromEntityId: a.id, toEntityId: b.id, relationType: 'run_belongs_to_session' })
    upsertFact(handle, { entityId: a.id, factType: 'preference', key: 'theme', value: 'dark' })

    deleteEntity(handle, a.id)
    expect(getEntity(handle, a.id)).toBeNull()
    expect(getRelated(handle, b.id, { direction: 'in' })).toHaveLength(0)
    expect(getFacts(handle, a.id)).toHaveLength(0)
  })

  it('should search content via FTS5', () => {
    upsertEntity(handle, {
      id: 'run:fts-1',
      entityType: 'run',
      sourceId: 'fts-1',
      sourceType: 'run_store',
      title: '修复登录 Bug',
      content: '用户反馈无法登录，原因是 session 过期没有刷新',
      occurredAt: 1700000000000,
    })
    upsertEntity(handle, {
      id: 'run:fts-2',
      entityType: 'run',
      sourceId: 'fts-2',
      sourceType: 'run_store',
      title: '优化首页性能',
      content: '图片懒加载和缓存策略优化',
      occurredAt: 1700000001000,
    })

    const hits = searchFullText(handle, '登录')
    expect(hits.map((h) => h.entity.id)).toEqual(['run:fts-1'])
  })

  it('should support prefix match in FTS', () => {
    upsertEntity(handle, {
      id: 'run:fts-3',
      entityType: 'run',
      sourceId: 'fts-3',
      sourceType: 'run_store',
      title: '缓存策略',
      content: '实现 Redis 缓存层',
      occurredAt: 1700000000000,
    })
    const hits = searchFullText(handle, 'Redi')
    expect(hits.map((h) => h.entity.id)).toEqual(['run:fts-3'])
  })

  it('should filter search by entity type', () => {
    upsertEntity(handle, {
      id: 'run:fts-4',
      entityType: 'run',
      sourceId: 'fts-4',
      sourceType: 'run_store',
      title: '部署',
      content: '生产环境部署完成',
      occurredAt: 1700000000000,
    })
    upsertEntity(handle, {
      id: 'task:fts-5',
      entityType: 'task',
      sourceId: 'fts-5',
      sourceType: 'project_store',
      title: '部署文档',
      content: '补充部署文档',
      occurredAt: 1700000001000,
    })

    const runHits = searchFullText(handle, '部署', { entityTypes: ['run'] })
    expect(runHits.map((h) => h.entity.id)).toEqual(['run:fts-4'])
  })

  it('recall should return search hits and tokens', () => {
    upsertEntity(handle, {
      id: 'run:recall-1',
      entityType: 'run',
      sourceId: 'recall-1',
      sourceType: 'run_store',
      title: '数据库迁移',
      content: '使用 Alembic 做 schema 迁移',
      occurredAt: 1700000000000,
    })
    const result = recall(handle, 'Alembic 迁移')
    expect(result.hits).toHaveLength(1)
    // tokens 现在返回实际用于检索的词元（bigram 分词后）
    expect(result.tokens).toContain('alembic')
    expect(result.tokens).toContain('迁')
    expect(result.tokens).toContain('迁移')
    expect(result.tokens).toContain('移')
    expect(result.relaxed).toBe(false)
  })

  it('should reject tampered migrations', async () => {
    // 篡改必须真正改变 schema，才能触发 checksum 不一致校验。
    // 注意：不能只用追加注释的方式（`-- tampered`）——schemaChecksum 会剥掉注释，
    // 纯注释修改不会改变语义，校验本就不该拦截（migration-checksum.ts 的判据定义）。
    const tampered: typeof MIGRATIONS = [
      {
        version: 1,
        name: 'init',
        sql: MIGRATIONS[0]!.sql + `\nCREATE INDEX IF NOT EXISTS idx_tampered ON context_entities(_tampered);`,
      },
    ]
    expect(() => runMigrations(handle.db, tampered)).toThrow()
  })
})

function makeEntity(id: string, type: 'run' | 'session' | 'task' | 'member' | 'file_event' | 'todo_event' | 'calendar' | 'fact', occurredAt: number, title?: string): ContextEntity {
  return {
    // id 直接采用传入值（调用方已给出完整、去重后的 id），这里不再拼 type 前缀。
    id,
    entityType: type,
    sourceId: id,
    sourceType: `${type}_store`,
    title: title ?? `${type} ${id}`,
    occurredAt,
  }
}

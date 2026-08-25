/**
 * Context Store 实现
 *
 * 本地优先的上下文图存储：实体、关系、事实、全文检索。
 *
 * 实现基于 sql.js（与当前 apps/electron 保持一致，避免引入 better-sqlite3 native
 * 模块的打包复杂度）。生产使用时会传入磁盘文件内容，测试使用内存库。
 */
import initSqlJs, { type SqlJsStatic } from 'sql.js'
import {
  type ContextEntity,
  type ContextEntityType,
  type ContextEdge,
  type ContextEdgeInput,
  type ContextFact,
  type ContextFactInput,
  type ContextRelatedNode,
  type ContextSearchHit,
  type ContextStoreOptions,
  type RecallOptions,
  type RecallResult,
} from './types.ts'
import {
  type AppliedMigration,
  type SqlJsDatabase,
  runMigrations,
} from './migrations.ts'
import {
  EntityRepository,
  EdgeRepository,
  FactRepository,
  SearchRepository,
} from './repositories/index.ts'

export interface ContextStoreHandle {
  db: SqlJsDatabase
  appliedMigrations: AppliedMigration[]
  appliedVersion: number
  /** 持久化到磁盘（仅对传入 path 构建的 store 有意义） */
  persist(): Uint8Array | undefined
  close(): void

  // Repository 访问点（供高级用例直接操作）
  entities: EntityRepository
  edges: EdgeRepository
  facts: FactRepository
  search: SearchRepository
}

let sqlJsPromise: Promise<SqlJsStatic> | null = null

function loadSqlJs(): Promise<SqlJsStatic> {
  if (!sqlJsPromise) {
    sqlJsPromise = initSqlJs({
      locateFile: (file: string) => require.resolve(`sql.js/dist/${file}`),
    })
  }
  return sqlJsPromise
}

export async function openContextStore(options: ContextStoreOptions = {}): Promise<ContextStoreHandle> {
  const SQL = await loadSqlJs()
  const resolvedPath = options.path ?? (options.workspaceSlug ? await defaultWorkspacePath(options.workspaceSlug) : undefined)
  const initial = resolvedPath ? await readFileMaybe(resolvedPath) : undefined
  const database = new SQL.Database(initial)

  // sql.js 是内存库，WAL/pragma busy_timeout 不可用；但 FTS5 默认已编译进 sql.js。
  database.exec(`PRAGMA foreign_keys = ON`)

  const applied = runMigrations(database, undefined)
  const persist = (): Uint8Array | undefined => (resolvedPath ? database.export() : undefined)
  const close = (): void => {
    persist()
    database.close()
  }

  return {
    db: database,
    appliedMigrations: applied,
    appliedVersion: applied.at(-1)?.version ?? 0,
    persist,
    close,
    entities: new EntityRepository(database),
    edges: new EdgeRepository(database),
    facts: new FactRepository(database),
    search: new SearchRepository(database),
  }
}

async function defaultWorkspacePath(slug: string): Promise<string> {
  const { join } = await import('node:path')
  const { homedir } = await import('node:os')
  return join(homedir(), '.proma', 'workspaces', slug, 'context-store.db')
}

async function readFileMaybe(path: string): Promise<Uint8Array | undefined> {
  const { readFileSync, existsSync } = await import('node:fs')
  if (!existsSync(path)) return undefined
  return readFileSync(path)
}

// ============================================================
// 向后兼容的顶层 API（委托给 Repository）
// ============================================================

/** 插入或更新实体。 */
export function upsertEntity(handle: ContextStoreHandle, entity: ContextEntity): void {
  handle.entities.upsert(entity)
}

/** 按 ID 获取实体。 */
export function getEntity(handle: ContextStoreHandle, id: string): ContextEntity | null {
  return handle.entities.getById(id)
}

/** 按类型列出实体。 */
export function listEntities(
  handle: ContextStoreHandle,
  type: ContextEntityType,
  options: { limit?: number; after?: number } = {},
): ContextEntity[] {
  return handle.entities.listByType(type, options)
}

/** 建立两个实体之间的关系。 */
export function link(handle: ContextStoreHandle, input: ContextEdgeInput): ContextEdge {
  return handle.edges.create(input)
}

/** 删除关系。 */
export function unlink(
  handle: ContextStoreHandle,
  fromEntityId: string,
  toEntityId: string,
  relationType?: string,
): void {
  handle.edges.delete(fromEntityId, toEntityId, relationType)
}

/** 查询实体的相关实体。 */
export function getRelated(
  handle: ContextStoreHandle,
  entityId: string,
  options: {
    relationTypes?: readonly string[]
    direction?: 'out' | 'in' | 'both'
    limit?: number
  } = {},
): ContextRelatedNode[] {
  return handle.edges.getRelated(entityId, options)
}

/** 写入或更新事实。 */
export function upsertFact(handle: ContextStoreHandle, input: ContextFactInput): ContextFact {
  return handle.facts.upsert(input)
}

/** 获取实体的所有事实。 */
export function getFacts(handle: ContextStoreHandle, entityId: string, factType?: string): ContextFact[] {
  return handle.facts.getByEntity(entityId, factType)
}

/** 全文搜索。 */
export function searchFullText(
  handle: ContextStoreHandle,
  query: string,
  options: { entityTypes?: readonly ContextEntityType[]; limit?: number } = {},
): ContextSearchHit[] {
  return handle.search.searchFullText(query, options).hits
}

/** 统一召回接口（目前基于全文，后续可加图召回与 RRF 融合）。 */
export function recall(handle: ContextStoreHandle, query: string, options: RecallOptions = {}): RecallResult {
  return handle.search.recall(query, options)
}

/** 删除实体及其关联的边、事实。 */
export function deleteEntity(handle: ContextStoreHandle, id: string): void {
  handle.entities.delete(id)
}

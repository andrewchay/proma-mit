export { openContextStore } from './store.ts'
export type { ContextStoreHandle } from './store.ts'
export { runMigrations, MIGRATIONS } from './migrations.ts'
export type { Migration, AppliedMigration } from './migrations.ts'
export { schemaChecksum, rawChecksum, stripSqlComments } from './migration-checksum.ts'
export { withTransaction, TransactionError } from './tx.ts'

// Repository 模式（P1.4）
export {
  EntityRepository,
  EdgeRepository,
  FactRepository,
  SearchRepository,
} from './repositories/index.ts'

// Retrieval 层（Phase 2）
export { tokenize, toIndexTokens, toQueryTokenTiers } from './retrieval/tokenizer.ts'
export { fuseRrf, buildRecallDebug } from './retrieval/fuse.ts'
export type { RankedList, FusedHit, RecallDebug } from './retrieval/fuse.ts'

export type {
  ContextEntity,
  ContextEntityType,
  ContextEdge,
  ContextEdgeInput,
  ContextFact,
  ContextFactInput,
  ContextRelatedNode,
  ContextSearchHit,
  ContextStoreOptions,
  RecallOptions,
  RecallResult,
} from './types.ts'

// 向后兼容的顶层 API（内部委托给 Repository）
export {
  upsertEntity,
  getEntity,
  listEntities,
  link,
  unlink,
  getRelated,
  upsertFact,
  getFacts,
  searchFullText,
  recall,
  deleteEntity,
} from './store.ts'

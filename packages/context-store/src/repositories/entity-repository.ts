import type { SqlJsDatabase } from '../migrations.ts'
import {
  type ContextEntity,
  type ContextEntityType,
} from '../types.ts'
import { safeAll, safeRun } from '../migrations.ts'

function entityRowToEntity(row: Record<string, unknown>): ContextEntity {
  return {
    id: String(row.id),
    entityType: String(row.entity_type) as ContextEntityType,
    sourceId: String(row.source_id),
    sourceType: String(row.source_type),
    title: String(row.title),
    detail: row.detail === null || row.detail === undefined ? undefined : String(row.detail),
    content: row.content === null || row.content === undefined ? undefined : String(row.content),
    occurredAt: Number(row.occurred_at),
  }
}

export class EntityRepository {
  constructor(private readonly db: SqlJsDatabase) {}

  upsert(entity: ContextEntity): void {
    safeRun(
      this.db,
      `INSERT INTO context_entities(id, entity_type, source_id, source_type, title, detail, content, occurred_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         entity_type = excluded.entity_type,
         source_id = excluded.source_id,
         source_type = excluded.source_type,
         title = excluded.title,
         detail = excluded.detail,
         content = excluded.content,
         occurred_at = excluded.occurred_at`,
      [
        entity.id,
        entity.entityType,
        entity.sourceId,
        entity.sourceType,
        entity.title,
        entity.detail ?? null,
        entity.content ?? null,
        entity.occurredAt,
      ],
    )
  }

  getById(id: string): ContextEntity | null {
    const row = safeAll(this.db, `SELECT * FROM context_entities WHERE id = ?`, [id])[0]
    return row ? entityRowToEntity(row) : null
  }

  listByType(
    type: ContextEntityType,
    options: { limit?: number; after?: number } = {},
  ): ContextEntity[] {
    const rows = safeAll(
      this.db,
      `SELECT * FROM context_entities WHERE entity_type = ? AND occurred_at <= ? ORDER BY occurred_at DESC LIMIT ?`,
      [type, options.after ?? Number.MAX_SAFE_INTEGER, options.limit ?? 100],
    )
    return rows.map(entityRowToEntity)
  }

  delete(id: string): void {
    safeRun(this.db, `DELETE FROM context_entities WHERE id = ?`, [id])
  }
}

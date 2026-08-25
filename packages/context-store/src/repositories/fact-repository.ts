import type { SqlJsDatabase } from '../migrations.ts'
import {
  type ContextFact,
  type ContextFactInput,
} from '../types.ts'
import { safeAll, safeRun } from '../migrations.ts'

function now(): number {
  return Date.now()
}

function factRowToFact(row: Record<string, unknown>): ContextFact {
  return {
    id: String(row.id),
    entityId: String(row.entity_id),
    factType: String(row.fact_type),
    key: String(row.key),
    value: String(row.value),
    sourceRunId: row.source_run_id === null || row.source_run_id === undefined ? undefined : String(row.source_run_id),
    confidence: Number(row.confidence),
    createdAt: Number(row.created_at),
  }
}

export class FactRepository {
  constructor(private readonly db: SqlJsDatabase) {}

  upsert(input: ContextFactInput): ContextFact {
    const id = `${input.entityId}|${input.factType}|${input.key}`
    const createdAt = now()
    const confidence = input.confidence ?? 1.0
    safeRun(
      this.db,
      `INSERT INTO context_facts(id, entity_id, fact_type, key, value, source_run_id, confidence, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         value = excluded.value,
         source_run_id = excluded.source_run_id,
         confidence = excluded.confidence,
         created_at = excluded.created_at`,
      [id, input.entityId, input.factType, input.key, input.value, input.sourceRunId ?? null, confidence, createdAt],
    )
    return { id, ...input, confidence, createdAt }
  }

  getByEntity(entityId: string, factType?: string): ContextFact[] {
    const rows = factType
      ? safeAll(
          this.db,
          `SELECT * FROM context_facts WHERE entity_id = ? AND fact_type = ? ORDER BY created_at DESC`,
          [entityId, factType],
        )
      : safeAll(this.db, `SELECT * FROM context_facts WHERE entity_id = ? ORDER BY created_at DESC`, [entityId])
    return rows.map(factRowToFact)
  }
}

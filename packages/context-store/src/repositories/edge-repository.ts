import type { SqlJsDatabase } from '../migrations.ts'
import {
  type ContextEdge,
  type ContextEdgeInput,
  type ContextRelatedNode,
} from '../types.ts'
import { safeAll, safeRun } from '../migrations.ts'

function now(): number {
  return Date.now()
}

function edgeRowToEdge(row: Record<string, unknown>): ContextEdge {
  return {
    id: String(row.edge_id ?? row.id),
    fromEntityId: String(row.from_entity_id),
    toEntityId: String(row.to_entity_id),
    relationType: String(row.relation_type),
    sourceRunId: row.source_run_id === null || row.source_run_id === undefined ? undefined : String(row.source_run_id),
    confidence: Number(row.confidence),
    occurredAt: Number(row.edge_occurred_at ?? row.occurred_at),
  }
}

export class EdgeRepository {
  constructor(private readonly db: SqlJsDatabase) {}

  create(input: ContextEdgeInput): ContextEdge {
    const id = `${input.fromEntityId}|${input.relationType}|${input.toEntityId}`
    const occurredAt = input.occurredAt ?? now()
    const confidence = input.confidence ?? 1.0
    safeRun(
      this.db,
      `INSERT INTO context_edges(id, from_entity_id, to_entity_id, relation_type, source_run_id, confidence, occurred_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(from_entity_id, to_entity_id, relation_type) DO UPDATE SET
         source_run_id = excluded.source_run_id,
         confidence = excluded.confidence,
         occurred_at = excluded.occurred_at`,
      [id, input.fromEntityId, input.toEntityId, input.relationType, input.sourceRunId ?? null, confidence, occurredAt],
    )
    return {
      id,
      fromEntityId: input.fromEntityId,
      toEntityId: input.toEntityId,
      relationType: input.relationType,
      sourceRunId: input.sourceRunId,
      confidence,
      occurredAt,
    }
  }

  delete(fromEntityId: string, toEntityId: string, relationType?: string): void {
    if (relationType) {
      safeRun(this.db, `DELETE FROM context_edges WHERE from_entity_id = ? AND to_entity_id = ? AND relation_type = ?`, [
        fromEntityId,
        toEntityId,
        relationType,
      ])
    } else {
      safeRun(this.db, `DELETE FROM context_edges WHERE from_entity_id = ? AND to_entity_id = ?`, [
        fromEntityId,
        toEntityId,
      ])
    }
  }

  getRelated(
    entityId: string,
    options: {
      relationTypes?: readonly string[]
      direction?: 'out' | 'in' | 'both'
      limit?: number
    } = {},
  ): ContextRelatedNode[] {
    const relationTypes = options.relationTypes
    const direction = options.direction ?? 'both'
    const limit = options.limit ?? 100
    const nodes: ContextRelatedNode[] = []

    if (direction === 'out' || direction === 'both') {
      const rows = safeAll(
        this.db,
        `SELECT e.*, ed.id AS edge_id, ed.from_entity_id, ed.to_entity_id, ed.relation_type, ed.source_run_id, ed.confidence, ed.occurred_at AS edge_occurred_at
         FROM context_edges ed
         JOIN context_entities e ON e.id = ed.to_entity_id
         WHERE ed.from_entity_id = ? ${relationTypes ? `AND ed.relation_type IN (${this.placeholders(relationTypes.length)})` : ''}
         ORDER BY ed.occurred_at DESC
         LIMIT ?`,
        [entityId, ...(relationTypes ?? []), limit],
      )
      for (const row of rows) {
        nodes.push({ edge: edgeRowToEdge(row), entity: this.entityRowToEntity(row) })
      }
    }

    if (direction === 'in' || direction === 'both') {
      const rows = safeAll(
        this.db,
        `SELECT e.*, ed.id AS edge_id, ed.from_entity_id, ed.to_entity_id, ed.relation_type, ed.source_run_id, ed.confidence, ed.occurred_at AS edge_occurred_at
         FROM context_edges ed
         JOIN context_entities e ON e.id = ed.from_entity_id
         WHERE ed.to_entity_id = ? ${relationTypes ? `AND ed.relation_type IN (${this.placeholders(relationTypes.length)})` : ''}
         ORDER BY ed.occurred_at DESC
         LIMIT ?`,
        [entityId, ...(relationTypes ?? []), limit],
      )
      for (const row of rows) {
        nodes.push({ edge: edgeRowToEdge(row), entity: this.entityRowToEntity(row) })
      }
    }

    return nodes.slice(0, limit)
  }

  private entityRowToEntity(row: Record<string, unknown>): import('../types.ts').ContextEntity {
    return {
      id: String(row.id),
      entityType: String(row.entity_type) as import('../types.ts').ContextEntityType,
      sourceId: String(row.source_id),
      sourceType: String(row.source_type),
      title: String(row.title),
      detail: row.detail === null || row.detail === undefined ? undefined : String(row.detail),
      content: row.content === null || row.content === undefined ? undefined : String(row.content),
      occurredAt: Number(row.occurred_at),
    }
  }

  private placeholders(count: number): string {
    return Array.from({ length: count }, () => '?').join(', ')
  }
}

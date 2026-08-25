import { describe, it, expect } from 'bun:test'
import { openContextStore } from './store.ts'
import { withTransaction, TransactionError } from './tx.ts'
import { safeAll } from './migrations.ts'

describe('withTransaction', () => {
  it('should commit successful operations', async () => {
    const handle = await openContextStore()
    try {
      withTransaction(handle.db, () => {
        handle.db.exec(`INSERT INTO context_entities(id, entity_type, source_id, source_type, title, occurred_at) VALUES ('tx-test-1', 'run', 's1', 'store', 'title', 1)`)
      })

      const rows = safeAll(handle.db, `SELECT * FROM context_entities WHERE id = 'tx-test-1'`, [])
      expect(rows.length).toBe(1)
      expect(rows[0]?.id).toBe('tx-test-1')
    } finally {
      handle.close()
    }
  })

  it('should rollback on error', async () => {
    const handle = await openContextStore()
    try {
      expect(() => {
        withTransaction(handle.db, () => {
          handle.db.exec(`INSERT INTO context_entities(id, entity_type, source_id, source_type, title, occurred_at) VALUES ('tx-test-2', 'run', 's2', 'store', 'title', 1)`)
          throw new Error('intentional failure')
        })
      }).toThrow(TransactionError)

      const rows = safeAll(handle.db, `SELECT * FROM context_entities WHERE id = 'tx-test-2'`, [])
      expect(rows.length).toBe(0)
    } finally {
      handle.close()
    }
  })

  it('should return fn result', async () => {
    const handle = await openContextStore()
    try {
      const result = withTransaction(handle.db, () => {
        return 42
      })
      expect(result).toBe(42)
    } finally {
      handle.close()
    }
  })
})

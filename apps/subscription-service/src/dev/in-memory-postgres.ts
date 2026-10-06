/**
 * 内存 Postgres 替身，仅用于本地联调与端到端冒烟测试。
 *
 * 动机：真实联调需要 PostgreSQL，而开发者机器上未必有 Docker。
 * 本模块实现 SubscriptionStore 用到的那部分 SQL 子集，
 * 让完整服务逻辑（认证、权益签发、支付回调、退款、到期）
 * 能在零外部依赖下跑通。
 *
 * 边界说明（重要）：
 * - 这不是数据库引擎，只支持本服务实际发出的那些语句形态
 * - 不支持事务、并发控制、复杂 JOIN
 * - 仅供联调与测试，绝不可用于生产
 */

interface Table {
  rows: Array<Record<string, unknown>>
}

/** 把 SQL 归一化，便于匹配 */
function normalize(sql: string): string {
  return sql
    // 先剔除行注释与块注释，避免语句以注释开头导致类型判断失败
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
}

export class InMemoryPostgresClient {
  private readonly tables = new Map<string, Table>()

  private table(name: string): Table {
    let table = this.tables.get(name)
    if (!table) {
      table = { rows: [] }
      this.tables.set(name, table)
    }
    return table
  }

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<{ rows: Row[] }> {
    const statements = normalize(sql)
      .split(';')
      .map((item) => item.trim())
      .filter(Boolean)

    let lastResult: Row[] = []
    for (const statement of statements) {
      lastResult = this.execute(statement, params) as Row[]
    }
    return { rows: lastResult }
  }

  private execute(sql: string, params: readonly unknown[]): Array<Record<string, unknown>> {
    // ===== DDL：建表、建索引、约束全部忽略 =====
    if (/^CREATE\s+(TABLE|INDEX|UNIQUE)/i.test(sql)) {
      const match = sql.match(/CREATE TABLE IF NOT EXISTS (\w+)/i)
      if (match) this.table(match[1])
      return []
    }

    if (/^ALTER TABLE/i.test(sql)) return []

    // ===== 种子数据 =====
    // schema.sql 中的 plans 种子是多行 VALUES 且带 ::jsonb 类型转换，
    // 通用解析器无法处理，这里直接按固定结构写入。
    if (/^INSERT INTO subscription_plans/i.test(sql)) {
      const table = this.table('subscription_plans')
      const seeds = [
        { id: 'free', name: '免费版', monthly_price_cny: 0, yearly_price_cny: 0, capabilities: '[]' },
        {
          id: 'pro',
          name: '专业版',
          monthly_price_cny: 68,
          yearly_price_cny: 680,
          capabilities: '["influencer","paid-media","outbound-sourcing"]',
        },
      ]
      for (const seed of seeds) {
        if (!table.rows.some((row) => row.id === seed.id)) {
          table.rows.push({ ...seed, active: true })
        }
      }
      return []
    }

    // ===== INSERT =====
    // 注意：schema.sql 中的种子数据使用多行 VALUES + ON CONFLICT，
    // 因此单独处理 plan 表，避免被通用 INSERT 解析漏掉。
    const insertMatch = sql.match(/^INSERT INTO (\w+)\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)/i)
    if (insertMatch) {
      const [, tableName, columnsRaw, placeholders] = insertMatch
      const table = this.table(tableName)
      const columns = columnsRaw.split(',').map((item) => item.trim())
      const valueTokens = placeholders.split(',').map((item) => item.trim())

      const row: Record<string, unknown> = {}
      columns.forEach((column, index) => {
        const token = valueTokens[index]
        row[column] = this.resolveValue(token, params)
      })

      // 处理 UNIQUE 冲突：这里只对 id 做简单去重
      if (row.id !== undefined && table.rows.some((item) => item.id === row.id)) {
        return []
      }
      table.rows.push(row)
      return [row]
    }

    // ===== SELECT =====
    if (/^SELECT/i.test(sql)) {
      return this.select(sql, params)
    }

    // ===== UPDATE =====
    const updateMatch = sql.match(/^UPDATE (\w+) SET (.+?)(?: WHERE (.+?))?(?: RETURNING (.+))?$/i)
    if (updateMatch) {
      const [, tableName, setRaw, whereRaw, returning] = updateMatch
      const table = this.table(tableName)
      const assignments = this.parseAssignments(setRaw)
      const matched = table.rows.filter((row) => this.matchesWhere(row, whereRaw, params))

      for (const row of matched) {
        for (const [column, token] of assignments) {
          row[column] = this.resolveValue(token, params)
        }
      }

      if (returning) return matched
      return []
    }

    // ===== 其他语句（ON CONFLICT 等）直接忽略 =====
    return []
  }

  /** 解析 SET 子句为 [列名, 值 token] 列表 */
  private parseAssignments(raw: string): Array<[string, string]> {
    return raw.split(',').map((item) => {
      const [column, value] = item.split('=').map((part) => part.trim())
      return [column, value] as [string, string]
    })
  }

  /** 解析值 token：$1 形式取参数，字面量按类型转换 */
  private resolveValue(token: string | undefined, params: readonly unknown[]): unknown {
    if (token === undefined) return null
    const trimmed = token.trim()

    const paramMatch = trimmed.match(/^\$(\d+)$/)
    if (paramMatch) return params[Number(paramMatch[1]) - 1] ?? null

    if (/^NULL$/i.test(trimmed)) return null
    if (/^TRUE$/i.test(trimmed)) return true
    if (/^FALSE$/i.test(trimmed)) return false
    if (/^'.*'$/.test(trimmed)) return trimmed.slice(1, -1)
    if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed)

    return trimmed
  }

  /** 极简 WHERE 匹配，支持 col = $n、col IS NULL、col IS NOT NULL 与 AND */
  private matchesWhere(
    row: Record<string, unknown>,
    whereRaw: string | undefined,
    params: readonly unknown[],
  ): boolean {
    if (!whereRaw) return true

    const conditions = whereRaw.split(/\s+AND\s+/i)
    return conditions.every((condition) => {
      const trimmed = condition.trim()

      const isNullMatch = trimmed.match(/^(\w+)\s+IS\s+NULL$/i)
      if (isNullMatch) return row[isNullMatch[1]] == null

      const isNotNullMatch = trimmed.match(/^(\w+)\s+IS\s+NOT\s+NULL$/i)
      if (isNotNullMatch) return row[isNotNullMatch[1]] != null

      const eqMatch = trimmed.match(/^(\w+)\s*=\s*(.+)$/i)
      if (eqMatch) {
        const column = eqMatch[1]
        const expected = this.resolveValue(eqMatch[2], params)
        return row[column] === expected
      }

      const lteMatch = trimmed.match(/^(\w+)\s*<=\s*(.+)$/i)
      if (lteMatch) {
        const column = lteMatch[1]
        const expected = Number(this.resolveValue(lteMatch[2], params))
        return Number(row[column]) <= expected
      }

      const gteMatch = trimmed.match(/^(\w+)\s*>=\s*(.+)$/i)
      if (gteMatch) {
        const column = gteMatch[1]
        const expected = Number(this.resolveValue(gteMatch[2], params))
        return Number(row[column]) >= expected
      }

      const gtMatch = trimmed.match(/^(\w+)\s*>\s*(.+)$/i)
      if (gtMatch) {
        const column = gtMatch[1]
        const expected = Number(this.resolveValue(gtMatch[2], params))
        return Number(row[column]) > expected
      }

      const ltMatch = trimmed.match(/^(\w+)\s*<\s*(.+)$/i)
      if (ltMatch) {
        const column = ltMatch[1]
        const expected = Number(this.resolveValue(ltMatch[2], params))
        return Number(row[column]) < expected
      }

      return false
    })
  }

  /** 按目标表与 WHERE 条件返回匹配行，并支持列裁剪与排序 */
  private select(sql: string, params: readonly unknown[]): Array<Record<string, unknown>> {
    const tableMatch = sql.match(/FROM\s+(\w+)/i)
    if (!tableMatch) return []

    // 聚合查询：COUNT / MAX
    const aggregateMatch = sql.match(/SELECT\s+(COUNT\(\*\)|MAX\([^)]+\))\s+AS\s+(\w+)/i)
    if (aggregateMatch) {
      const table = this.table(tableMatch[1])
      const whereMatch = sql.match(/WHERE\s+(.+?)(?:\s+ORDER|\s+LIMIT|$)/i)
      const rows = table.rows.filter((row) => this.matchesWhere(row, whereMatch?.[1], params))

      const [, aggregate, alias] = aggregateMatch
      if (/^COUNT/i.test(aggregate)) return [{ [alias]: rows.length }]
      const column = aggregate.match(/MAX\((\w+)\)/i)?.[1] ?? 'id'
      const values = rows.map((row) => Number(row[column])).filter((value) => Number.isFinite(value))
      return [{ [alias]: values.length > 0 ? Math.max(...values) : null }]
    }

    const table = this.table(tableMatch[1])
    const whereMatch = sql.match(/WHERE\s+(.+?)(?:\s+ORDER BY|\s+LIMIT|$)/i)
    let rows = table.rows.filter((row) => this.matchesWhere(row, whereMatch?.[1], params))

    // ORDER BY
    const orderMatch = sql.match(/ORDER BY\s+(\w+)(\s+DESC|\s+ASC)?/i)
    if (orderMatch) {
      const column = orderMatch[1]
      const desc = /DESC/i.test(orderMatch[2] ?? '')
      rows = [...rows].sort((a, b) => {
        const left = a[column]
        const right = b[column]
        const leftNum = Number(left)
        const rightNum = Number(right)
        const comparable =
          Number.isFinite(leftNum) && Number.isFinite(rightNum)
            ? leftNum - rightNum
            : String(left).localeCompare(String(right))
        return desc ? -comparable : comparable
      })
    }

    // LIMIT $n
    const limitMatch = sql.match(/LIMIT\s+(\$\d+|\d+)/i)
    if (limitMatch) {
      const limitToken = limitMatch[1]
      const limit = limitToken.startsWith('$')
        ? Number(params[Number(limitToken.slice(1)) - 1])
        : Number(limitToken)
      rows = rows.slice(0, limit)
    }

    // 列裁剪：仅返回请求的列
    const columnsMatch = sql.match(/^SELECT\s+(.+?)\s+FROM/i)
    if (columnsMatch && !columnsMatch[1].includes('*')) {
      const columns = columnsMatch[1]
        .split(',')
        .map((item) => item.trim().split(/\s+AS\s+/i)[0].trim())
        .filter((item) => !item.includes('('))
      return rows.map((row) => {
        const projected: Record<string, unknown> = {}
        for (const column of columns) projected[column] = row[column]
        return projected
      })
    }

    return rows
  }
}

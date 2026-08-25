/**
 * 事务助手。
 *
 * 存在的唯一理由：让「规范表与 Outbox 同事务写入」这条不变式有个明确的落点，
 * 而不是散在各调用点靠自觉。破了它的后果是消费者读到 seq 却查不到实体
 * （先写 Outbox 后崩溃），或永久漏掉变更（先写规范表后崩溃）——
 * 两者都表现为"数据看起来采到了，实际缺一段"，而且没有任何东西会报错。
 *
 * sql.js 不支持 SAVEPOINT，但支持 BEGIN/COMMIT/ROLLBACK。
 * 包一层是为了：
 * ① 统一错误处理；
 * ② 有个可搜索的名字 —— `grep withTransaction` 就能列出所有需要原子性的写入点。
 */
import type { SqlJsDatabase } from './migrations.ts'

export class TransactionError extends Error {
  public readonly causeError?: Error

  constructor(message: string, cause?: Error) {
    super(message)
    this.name = 'TransactionError'
    this.causeError = cause
  }
}

/**
 * 在一个事务里执行 fn；抛错则整体回滚。
 *
 * @param database sql.js Database 实例
 * @param fn 要在事务内执行的函数
 * @returns fn 的返回值
 * @throws TransactionError 事务失败时抛出
 */
export function withTransaction<T>(database: SqlJsDatabase, fn: () => T): T {
  database.exec('BEGIN')
  try {
    const result = fn()
    database.exec('COMMIT')
    return result
  } catch (error) {
    try {
      database.exec('ROLLBACK')
    } catch {
      // rollback 失败不掩盖原始错误
    }
    const detail = error instanceof Error ? error.message : String(error)
    throw new TransactionError(`事务执行失败：${detail}`, error instanceof Error ? error : undefined)
  }
}

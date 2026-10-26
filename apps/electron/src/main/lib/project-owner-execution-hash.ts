import { createHash } from 'node:crypto'
/** 键顺序不构成身份；摘要不是防任意SQL写入的认证。 */
export function ownerExecutionHash(value: unknown): string {
  function stable(v: unknown): unknown {
    if (Array.isArray(v)) return v.map(stable)
    if (v && typeof v === 'object')
      return Object.fromEntries(
        Object.entries(v)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, item]) => [key, stable(item)]),
      )
    return v
  }
  return createHash('sha256')
    .update(JSON.stringify(stable(value)))
    .digest('hex')
}

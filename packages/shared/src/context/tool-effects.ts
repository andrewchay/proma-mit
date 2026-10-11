/** 文件资源引用尚未解析，不代表权限、sandbox或并行保障。 */
export interface FilesystemToolEffect {
  readonly kind: 'filesystem'
  readonly mode: 'read' | 'write'
  readonly pathParameter: string
  /** Write递归mkdir需要涵盖祖先目录，不得只锁目标文件。 */
  readonly scope: 'path' | 'path-and-ancestors'
}
export interface UnknownToolEffect { readonly kind: 'unknown' }
export interface ToolEffects {
  readonly version: 1
  readonly resources: readonly (FilesystemToolEffect | UnknownToolEffect)[]
  readonly replay: 'never' | 'idempotent_read'
}

/** 只检查普通自有数据属性；不调用声明中的getter。 */
export function isToolEffectsDataRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const proto: unknown = Object.getPrototypeOf(value)
  return (proto === Object.prototype || proto === null) && Reflect.ownKeys(value).every((key) =>
    typeof key === 'string' && Object.getOwnPropertyDescriptor(value, key)?.enumerable === true && Object.getOwnPropertyDescriptor(value, key)?.get === undefined &&
    Object.getOwnPropertyDescriptor(value, key)?.set === undefined)
}
function keysMatch(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
}
function valid(value: unknown): value is ToolEffects {
  if (!isToolEffectsDataRecord(value) || !keysMatch(value, ['version', 'resources', 'replay']) || value.version !== 1 ||
    (value.replay !== 'never' && value.replay !== 'idempotent_read') ||
    !Array.isArray(value.resources) || value.resources.length === 0) return false
  // 拒绝稀疏数组、额外属性和元素getter；这里只接受声明，不执行动态表达式。
  if (Object.getPrototypeOf(value.resources) !== Array.prototype ||
    Reflect.ownKeys(value.resources).length !== value.resources.length + 1) return false
  for (let i = 0; i < value.resources.length; i++) {
    const element = Object.getOwnPropertyDescriptor(value.resources, String(i))
    if (!element || !Object.hasOwn(element, 'value')) return false
    const r: unknown = element.value
    if (!isToolEffectsDataRecord(r)) return false
    if (r.kind === 'unknown') {
      if (!keysMatch(r, ['kind']) || value.replay !== 'never') return false
    } else if (r.kind === 'filesystem') {
      if (!keysMatch(r, ['kind', 'mode', 'pathParameter', 'scope']) || (r.mode !== 'read' && r.mode !== 'write') ||
        typeof r.pathParameter !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(r.pathParameter) ||
        ['__proto__', 'prototype', 'constructor'].includes(r.pathParameter) ||
        (r.scope !== 'path' && r.scope !== 'path-and-ancestors') ||
        (value.replay === 'idempotent_read' && r.mode !== 'read')) return false
    } else return false
  }
  return true
}
export function unknownToolEffects(): ToolEffects {
  return { version: 1, resources: [{ kind: 'unknown' }], replay: 'never' }
}
/** 解析成功也不是可信来源认证；运行端须按真实注册实例取声明。 */
export function normalizeToolEffects(value: unknown): ToolEffects {
  if (!valid(value)) return unknownToolEffects()
  return { version: 1, resources: value.resources.map((r) => ({ ...r })), replay: value.replay }
}
/** 仅静态候选：还需资源解析、锁和权限；不表示可以执行/重试/并行。 */
export function isIndependentReadCandidate(value: unknown): boolean {
  const effects = normalizeToolEffects(value)
  return effects.replay === 'idempotent_read' && effects.resources.every((r) => r.kind === 'filesystem' && r.mode === 'read')
}

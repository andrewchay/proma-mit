/**
 * 新媒体 IPC 运行时校验。
 *
 * 所有渲染进程传入的参数都必须先经过这里，再进入服务层；
 * 校验失败使用稳定的错误码，便于 UI 与日志按码分支处理。
 */

export const NEW_MEDIA_ERROR_PREFIX = 'new_media'

export type NewMediaIpcErrorCode =
  | 'invalid_payload'
  | 'invalid_platform'
  | 'invalid_id'
  | 'invalid_text'
  | 'text_too_long'
  | 'invalid_timestamp'
  | 'invalid_number'
  | 'invalid_array'
  | 'invalid_enum'
  | 'invalid_url'

/** 稳定的 IPC 错误载荷，渲染进程按 code 分支，不解析自由文本。 */
export interface NewMediaIpcErrorPayload {
  code: NewMediaIpcErrorCode
  field: string
  message: string
}

export class NewMediaIpcValidationError extends Error {
  readonly code: NewMediaIpcErrorCode
  readonly field: string

  constructor(payload: NewMediaIpcErrorPayload) {
    super(payload.message)
    this.name = 'NewMediaIpcValidationError'
    this.code = payload.code
    this.field = payload.field
  }

  toPayload(): NewMediaIpcErrorPayload {
    return { code: this.code, field: this.field, message: this.message }
  }
}

function fail(code: NewMediaIpcErrorCode, field: string, message: string): never {
  throw new NewMediaIpcValidationError({ code, field, message })
}

export const NEW_MEDIA_LIMITS = {
  id: 128,
  sourceText: 20000,
  bodyText: 5000,
  shortText: 200,
  summary: 500,
  url: 2048,
  arrayItems: 20,
  arrayItemLength: 64,
} as const

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/

export function assertPlainObject(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail('invalid_payload', field, `${field} 必须是对象`)
  }
  return value as Record<string, unknown>
}

export function requireString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string') fail('invalid_text', field, `${field} 必须是字符串`)
  const trimmed = value.trim()
  if (!trimmed) fail('invalid_text', field, `${field} 不能为空`)
  if (trimmed.length > maxLength) fail('text_too_long', field, `${field} 长度不能超过 ${maxLength} 个字符`)
  return trimmed
}

/** 正文类文本允许包含换行，因此不做控制字符整段拒绝，只拒绝 NUL。 */
export function requireRichText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string') fail('invalid_text', field, `${field} 必须是字符串`)
  const trimmed = value.trim()
  if (!trimmed) fail('invalid_text', field, `${field} 不能为空`)
  if (trimmed.length > maxLength) fail('text_too_long', field, `${field} 长度不能超过 ${maxLength} 个字符`)
  if (trimmed.includes('\u0000')) fail('invalid_text', field, `${field} 包含非法字符`)
  return trimmed
}

export function requireId(value: unknown, field: string): string {
  const id = requireString(value, field, NEW_MEDIA_LIMITS.id)
  if (CONTROL_CHARS.test(id)) fail('invalid_id', field, `${field} 包含非法字符`)
  return id
}

export function optionalId(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  return requireId(value, field)
}

export function requireEnum<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    fail('invalid_enum', field, `${field} 取值无效`)
  }
  return value as T
}

export function requirePlatform(value: unknown): string {
  return requireEnum(value, ['xiaohongshu', 'wechat-official-account'] as const, '平台')
}

export function requireFiniteNumber(value: unknown, field: string, options: { min?: number; max?: number } = {}): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail('invalid_number', field, `${field} 必须是有限数字`)
  if (options.min !== undefined && value < options.min) fail('invalid_number', field, `${field} 不能小于 ${options.min}`)
  if (options.max !== undefined && value > options.max) fail('invalid_number', field, `${field} 不能大于 ${options.max}`)
  return value
}

export function requireTimestamp(value: unknown, field: string): number {
  const result = requireFiniteNumber(value, field, { min: 0 })
  if (!Number.isInteger(result)) fail('invalid_timestamp', field, `${field} 必须是毫秒整数时间戳`)
  return result
}

export function requireFutureTimestamp(value: unknown, field: string, now = Date.now()): number {
  const result = requireTimestamp(value, field)
  if (result <= now) fail('invalid_timestamp', field, `${field} 必须是未来时间`)
  return result
}

export function requireStringArray(value: unknown, field: string, options: { maxItems?: number; maxItemLength?: number; allowEmpty?: boolean } = {}): string[] {
  const maxItems = options.maxItems ?? NEW_MEDIA_LIMITS.arrayItems
  const maxItemLength = options.maxItemLength ?? NEW_MEDIA_LIMITS.arrayItemLength
  if (!Array.isArray(value)) fail('invalid_array', field, `${field} 必须是数组`)
  if (value.length > maxItems) fail('invalid_array', field, `${field} 最多包含 ${maxItems} 项`)
  const normalized: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') fail('invalid_array', field, `${field} 只能包含字符串`)
    const trimmed = item.trim()
    if (!trimmed) continue
    if (trimmed.length > maxItemLength) fail('text_too_long', field, `${field} 单项长度不能超过 ${maxItemLength} 个字符`)
    if (!normalized.includes(trimmed)) normalized.push(trimmed)
  }
  if (normalized.length === 0 && !options.allowEmpty) fail('invalid_array', field, `${field} 至少需要一项`)
  return normalized
}

export function requireHttpUrl(value: unknown, field: string): string {
  const url = requireString(value, field, NEW_MEDIA_LIMITS.url)
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    fail('invalid_url', field, `${field} 不是合法链接`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') fail('invalid_url', field, `${field} 只允许 http 或 https 链接`)
  return url
}

/**
 * 统一包装 IPC 处理器：校验错误按稳定格式抛出，其余错误保持原样。
 */
export function newMediaIpcError(error: unknown): Error {
  if (error instanceof NewMediaIpcValidationError) {
    return new Error(`${NEW_MEDIA_ERROR_PREFIX}:${error.code}:${error.field}: ${error.message}`)
  }
  return error instanceof Error ? error : new Error(String(error))
}

export async function withNewMediaIpcValidation<T>(handler: () => Promise<T> | T): Promise<T> {
  try {
    return await handler()
  } catch (error) {
    throw newMediaIpcError(error)
  }
}

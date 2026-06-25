/**
 * 安全 JSON 解析工具
 *
 * 用于所有读取外部/用户数据的地方，避免 malformed JSON 导致主进程崩溃。
 */

/**
 * 安全解析 JSON 字符串。
 * @param raw 原始字符串
 * @param fallback 解析失败时返回的默认值
 * @returns 解析结果或 fallback
 */
export function safeParseJSON<T>(raw: string | undefined | null, fallback: T): T {
  if (!raw || typeof raw !== 'string') return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

/**
 * 安全解析可能是对象的 JSON 字符串，并确保返回普通对象。
 * 用于 SDK settings 这类必须返回 Record 的场景。
 */
export function safeParseJSONObject(raw: string | undefined | null): Record<string, unknown> {
  const parsed = safeParseJSON<unknown>(raw, {})
  if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
    return parsed as Record<string, unknown>
  }
  return {}
}

/**
 * 学术检索 adapter 公共类型
 *
 * 所有 adapter 注入 fetchFn：生产环境走统一代理（getFetchFn），
 * 测试注入假实现，离线可测（方案 §7 adapter 契约）。
 */

import type { SourceVersion } from '@gravitas/shared'

export interface ScholarSearchOptions {
  /** 最大结果数（会体现在分页参数与截断标记） */
  limit: number
  /** 额外过滤器（年份、开放获取等，按 adapter 支持） */
  filters?: Record<string, string>
  /**
   * 排序方式（M7.2）。各库取值不同，未指定时按库默认排序并在
   * 检索日志中记录为 'default'——不猜测实际排序规则。
   */
  sort?: string
  /** 分页偏移（M7.2）；未指定为 0 */
  offset?: number
}

export interface ScholarSearchResult {
  sources: SourceVersion[]
  totalCount?: number
  truncated: boolean
  errors: string[]
}

export interface ScholarAdapter {
  readonly databaseId: string
  search(query: string, options: ScholarSearchOptions): Promise<ScholarSearchResult>
}

/** 生成版本 ID（adapter 内部一致性即可，不用全局 UUID） */
export function draftVersionId(databaseId: string, externalKey: string): string {
  return `${databaseId}:${externalKey}`
}

/** HTTP 非 2x 归一化为错误信息（不抛出，调用方决定部分失败语义） */
export async function readJsonOrError(fetchFn: typeof fetch, url: string): Promise<unknown | { __error: string }> {
  try {
    const res = await fetchFn(url)
    if (!res.ok) return { __error: `HTTP ${res.status}` }
    return await res.json()
  } catch (err) {
    return { __error: err instanceof Error ? err.message : String(err) }
  }
}

export async function readTextOrError(fetchFn: typeof fetch, url: string): Promise<string | { __error: string }> {
  try {
    const res = await fetchFn(url)
    if (!res.ok) return { __error: `HTTP ${res.status}` }
    return await res.text()
  } catch (err) {
    return { __error: err instanceof Error ? err.message : String(err) }
  }
}

/** OpenAlex 反转摘要索引 → 摘要文本（官方格式：词 → 出现位置数组） */
export function rebuildInvertedAbstract(
  inverted: Record<string, number[]> | null | undefined,
): string | undefined {
  if (!inverted || typeof inverted !== 'object') return undefined
  const words: Array<{ pos: number; word: string }> = []
  for (const [word, positions] of Object.entries(inverted)) {
    for (const pos of positions ?? []) words.push({ pos, word })
  }
  if (words.length === 0) return undefined
  words.sort((a, b) => a.pos - b.pos)
  return words.map((w) => w.word).join(' ')
}

export type { SourceVersion }

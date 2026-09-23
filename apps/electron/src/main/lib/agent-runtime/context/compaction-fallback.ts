/**
 * M5-05 compaction 回退与迁移。
 *
 * feature flag 关闭、TCC view 构建抛错或产出为空时，一律回退旧 compact 路径；
 * 回退原因必须记录，旧行为不能被半完成的 TCC 视图破坏。
 */

export interface CompactionFallbackResult<T> {
  view: T
  usedFallback: boolean
  reason?: string
}

export interface RunCompactionWithFallbackInput<T> {
  /** TCC 视图开关；false 时直接走旧路径。 */
  enabled: boolean
  buildView: () => Promise<T | null | undefined> | T | null | undefined
  buildLegacy: () => Promise<T> | T
}

export async function runCompactionWithFallback<T>(input: RunCompactionWithFallbackInput<T>): Promise<CompactionFallbackResult<T>> {
  if (!input.enabled) {
    return { view: await input.buildLegacy(), usedFallback: true, reason: 'tcc compaction disabled: using legacy path' }
  }
  let view: T | null | undefined
  try {
    view = await input.buildView()
  } catch (error) {
    return {
      view: await input.buildLegacy(),
      usedFallback: true,
      reason: `tcc view failed: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
  if (view === null || view === undefined) {
    return { view: await input.buildLegacy(), usedFallback: true, reason: 'tcc view was empty: using legacy path' }
  }
  return { view, usedFallback: false }
}

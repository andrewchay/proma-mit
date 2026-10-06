/**
 * project-source-refs — 决策「结构化原文定位」的用户层辅助（R-P0-01）
 *
 * 职责：把 ProjectDecisionSourceRef 的解析、格式化、字段级校验集中到一处，
 * 供决策表单的行编辑器复用；后端 project-chain 仍是最终校验权威。
 */
import type { ProjectDecisionSourceRef, ProjectDecisionSourceType } from '@gravitas/shared'

/** 来源类型与中文标签；legacy 仅为兼容旧数据展示，不允许新建行选择 */
export const SOURCE_REF_TYPE_OPTIONS: Array<{
  value: ProjectDecisionSourceType
  label: string
  /** legacy 只读兼容，不作为新建选项 */
  creatable: boolean
}> = [
  { value: 'task', label: '任务', creatable: true },
  { value: 'document', label: '文档', creatable: true },
  { value: 'meeting', label: '会议', creatable: true },
  { value: 'message', label: '消息', creatable: true },
  { value: 'url', label: '链接', creatable: true },
  { value: 'other', label: '其他', creatable: true },
  { value: 'legacy', label: '旧格式（只读兼容）', creatable: false },
]

/** 表单 placeholder 示例：覆盖最常用的任务与会议两类 */
export const SOURCE_REF_PLACEHOLDER =
  '例如：task | TASK-1234 | section:1；meeting | meeting-2026-09-09 | paragraph:42'

/** 空白来源行 */
export function emptySourceRef(): ProjectDecisionSourceRef {
  return { sourceType: 'task', sourceId: '', locator: '' }
}

/** 旧文本格式（`类型 | 来源ID | 定位 | 可选checksum`）解析；用于兼容旧数据回显 */
export function parseSourceRefs(value: string): ProjectDecisionSourceRef[] {
  return value
    .split('\n')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      // 不含分隔符的旧行是自由文本，按 legacy 原样保留，不做静默改写
      if (!item.includes('|')) {
        return { sourceType: 'legacy' as ProjectDecisionSourceType, sourceId: item, locator: '' }
      }
      const [sourceType = '', sourceId = '', locator = '', checksum = ''] = item.split('|')
      return {
        sourceType: sourceType.trim() as ProjectDecisionSourceType,
        sourceId: sourceId.trim(),
        locator: locator.trim(),
        ...(checksum.trim() ? { checksum: checksum.trim() } : {}),
      }
    })
}

/** 反向格式化：legacy 行原样保留原始文本，避免静默改写旧数据 */
export function formatSourceRef(ref: ProjectDecisionSourceRef): string {
  if (ref.sourceType === 'legacy') {
    return ref.sourceId
  }
  return [ref.sourceType, ref.sourceId, ref.locator, ref.checksum].filter(Boolean).join(' | ')
}

export interface SourceRefFieldErrors {
  sourceType?: string
  sourceId?: string
  locator?: string
}

/** 字段级校验：错误信息包含字段名、合法取值或格式示例，用户可直接照做 */
export function validateSourceRef(ref: ProjectDecisionSourceRef): SourceRefFieldErrors {
  if (ref.sourceType === 'legacy') {
    return {}
  }
  const errors: SourceRefFieldErrors = {}
  const known = SOURCE_REF_TYPE_OPTIONS.some((option) => option.value === ref.sourceType)
  if (!known) {
    errors.sourceType = `来源类型不合法：「${ref.sourceType}」。请选择：${SOURCE_REF_TYPE_OPTIONS
      .filter((option) => option.creatable)
      .map((option) => option.value)
      .join(' / ')}`
  }
  if (!ref.sourceId.trim()) {
    errors.sourceId = '来源 ID 不能为空。例如：TASK-1234、meeting-2026-09-09、文档或消息 ID。'
  }
  if (!ref.locator.trim()) {
    errors.locator = '原文定位不能为空。例如：section:1、paragraph:42、message:om_xxx。'
  }
  return errors
}

/** 校验整组来源行；全部通过时返回 null，否则返回按行索引的错误表 */
export function validateSourceRefs(
  refs: ProjectDecisionSourceRef[],
): Array<SourceRefFieldErrors> | null {
  const rowErrors = refs.map((ref) => validateSourceRef(ref))
  const hasError = rowErrors.some((errors) => Object.keys(errors).length > 0)
  return hasError ? rowErrors : null
}

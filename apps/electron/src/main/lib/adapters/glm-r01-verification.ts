/** 数值任务验证完整数值字符串；非数值任务仍使用各自的精确格式契约。 */
export function matchesNumericAnswer(actual: string, expected: number): boolean {
  const value = actual.trim()
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value)) return false
  const parsed = Number(value)
  return Number.isFinite(parsed) && Number.isFinite(expected) && parsed === expected
}

interface DiagnosticSource {
  text: string
  toolErrorTexts: string[]
  errorTexts: string[]
}

export interface GlmRunDiagnostics {
  finalReply: string
  finalReplyTruncated: boolean
  toolErrors: string[]
  runtimeErrors: string[]
  errorsTruncated: boolean
}

/** 仅保存试点输出，不保存请求、headers或API key；大文本明确标记截断。 */
export function captureRunDiagnostics(source: DiagnosticSource): GlmRunDiagnostics {
  const limit = 8000
  return {
    finalReply: source.text.slice(0, limit),
    finalReplyTruncated: source.text.length > limit,
    toolErrors: source.toolErrorTexts.slice(0, 50).map((s) => s.slice(0, 2000)),
    runtimeErrors: source.errorTexts.slice(0, 50).map((s) => s.slice(0, 2000)),
    errorsTruncated: source.toolErrorTexts.length > 50 || source.errorTexts.length > 50
      || [...source.toolErrorTexts, ...source.errorTexts].some((s) => s.length > 2000),
  }
}

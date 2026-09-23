/**
 * M4-04 工具选择准确率实验。
 *
 * 对同一组选择用例比较两种 prompt 策略：
 * - full_schema：全部 30 个工具的完整参数 schema 进入 prompt；
 * - summary_on_demand：只有常驻能力摘要，无任何参数 schema。
 * 模型只输出选中的工具 id；delegate 注入，真实评测不做任何工具执行。
 */
import type { CapabilityCatalog } from '@gravitas/shared'
import { renderCapabilitySummary } from '@gravitas/shared'
import { getSelectionSchemaBody, type ToolSelectionCase } from './tool-selection-fixture'

export type ToolSelectionVariant = 'full_schema' | 'summary_on_demand'
export const TOOL_SELECTION_VARIANTS: readonly ToolSelectionVariant[] = ['full_schema', 'summary_on_demand']

export const TOOL_SELECTION_SYSTEM_PROMPT = '你是工具选择器。根据用户任务从候选工具中选出最合适的一个。只输出一个 JSON 对象：{"selectedId":"<工具 id>","confidence":"high|medium|low"}，不要输出任何解释或其他文本。'

export interface ToolSelectionDelegateResult {
  text: string
  inputTokens: number
  outputTokens: number
  cacheStatus: 'hit' | 'miss' | 'unknown'
}

export type ToolSelectionDelegate = (input: {
  caseId: string
  variant: ToolSelectionVariant
  task: string
  systemPrompt: string
}) => Promise<ToolSelectionDelegateResult>

export interface ToolSelectionRun {
  caseId: string
  variant: ToolSelectionVariant
  run: number
  status: 'ok' | 'failed'
  selectedId: string | null
  correct: boolean
  inputTokens: number
  outputTokens: number
  cacheStatus: 'hit' | 'miss' | 'unknown'
  durationMs: number
  protocolError?: string
}

export function buildToolSelectionPrompt(input: {
  testCase: ToolSelectionCase
  catalog: CapabilityCatalog
  variant: ToolSelectionVariant
}): string {
  if (input.variant === 'summary_on_demand') {
    return `## 候选工具（方向性摘要）\n\n${renderCapabilitySummary(input.catalog)}\n\n## 任务\n${input.testCase.task}`
  }
  const fullSchemas = input.catalog.descriptors
    .map((descriptor) => `- id: ${descriptor.id}\n  name: ${descriptor.name}\n  summary: ${descriptor.summary}\n  parameters: ${getSelectionSchemaBody(descriptor.schemaRef)}`)
    .join('\n')
  return `## 候选工具（完整参数 schema）\n\n${fullSchemas}\n\n## 任务\n${input.testCase.task}`
}

export function parseToolSelection(text: string): { selectedId: string | null; protocolError?: string } {
  const candidate = extractJson(text)
  if (!candidate) return { selectedId: null, protocolError: '未找到 JSON 对象' }
  try {
    const value: unknown = JSON.parse(candidate)
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return { selectedId: null, protocolError: 'JSON 不是对象' }
    }
    const selectedId = (value as Record<string, unknown>).selectedId
    if (typeof selectedId !== 'string' || selectedId.trim().length === 0) {
      return { selectedId: null, protocolError: 'selectedId 缺失或非法' }
    }
    return { selectedId }
  } catch {
    return { selectedId: null, protocolError: 'JSON 无法解析' }
  }
}

export async function runToolSelectionExperiment(input: {
  cases: readonly ToolSelectionCase[]
  catalog: CapabilityCatalog
  runsPerCase: number
  delegate: ToolSelectionDelegate
  now?: () => number
  onRun?: (run: ToolSelectionRun) => void
  alreadyCompleted?: ReadonlySet<string>
}): Promise<ToolSelectionRun[]> {
  const runs: ToolSelectionRun[] = []
  const now = input.now ?? Date.now
  for (const testCase of input.cases) {
    for (const variant of TOOL_SELECTION_VARIANTS) {
      for (let run = 1; run <= input.runsPerCase; run++) {
        const key = `${testCase.id}:${variant}:${run}`
        if (input.alreadyCompleted?.has(key)) continue
        const startedAt = now()
        try {
          const result = await input.delegate({
            caseId: testCase.id,
            variant,
            task: buildToolSelectionPrompt({ testCase, catalog: input.catalog, variant }),
            systemPrompt: TOOL_SELECTION_SYSTEM_PROMPT,
          })
          const parsed = parseToolSelection(result.text)
          const record: ToolSelectionRun = {
            caseId: testCase.id,
            variant,
            run,
            status: parsed.protocolError ? 'failed' : 'ok',
            selectedId: parsed.selectedId,
            correct: parsed.selectedId === testCase.expectedToolId,
            inputTokens: result.inputTokens,
            outputTokens: result.outputTokens,
            cacheStatus: result.cacheStatus,
            durationMs: Math.max(0, now() - startedAt),
            ...(parsed.protocolError ? { protocolError: parsed.protocolError } : {}),
          }
          runs.push(record)
          input.onRun?.(record)
        } catch (error) {
          const record: ToolSelectionRun = {
            caseId: testCase.id,
            variant,
            run,
            status: 'failed',
            selectedId: null,
            correct: false,
            inputTokens: 0,
            outputTokens: 0,
            cacheStatus: 'unknown',
            durationMs: Math.max(0, now() - startedAt),
            protocolError: error instanceof Error ? error.message : String(error),
          }
          runs.push(record)
          input.onRun?.(record)
        }
      }
    }
  }
  return runs
}

export interface ToolSelectionVariantSummary {
  variant: ToolSelectionVariant
  runs: number
  okRuns: number
  accuracy: number
  avgInputTokens: number
  totalInputTokens: number
}

export interface ToolSelectionGate {
  passed: boolean
  reasons: string[]
  summaries: ToolSelectionVariantSummary[]
}

/** M4-04 验收：summary 变体准确率不低于 full_schema，且 prompt token 有可测下降。 */
export function summarizeToolSelection(runs: readonly ToolSelectionRun[], minimumAccuracy = 0.9): ToolSelectionGate {
  const summaries = TOOL_SELECTION_VARIANTS.map((variant) => {
    const variantRuns = runs.filter((run) => run.variant === variant)
    const okRuns = variantRuns.filter((run) => run.status === 'ok')
    const totalInputTokens = okRuns.reduce((total, run) => total + run.inputTokens, 0)
    return {
      variant,
      runs: variantRuns.length,
      okRuns: okRuns.length,
      accuracy: okRuns.length === 0 ? 0 : okRuns.filter((run) => run.correct).length / okRuns.length,
      avgInputTokens: okRuns.length === 0 ? 0 : Math.round(totalInputTokens / okRuns.length),
      totalInputTokens,
    }
  })
  const full = summaries.find((summary) => summary.variant === 'full_schema')
  const summaryVariant = summaries.find((summary) => summary.variant === 'summary_on_demand')
  const reasons: string[] = []
  if (!full || !summaryVariant) {
    reasons.push('missing variant summary')
  } else {
    if (summaryVariant.accuracy < full.accuracy) {
      reasons.push(`summary_on_demand accuracy (${summaryVariant.accuracy.toFixed(3)}) is below full_schema (${full.accuracy.toFixed(3)})`)
    }
    if (summaryVariant.accuracy < minimumAccuracy) {
      reasons.push(`summary_on_demand accuracy (${summaryVariant.accuracy.toFixed(3)}) is below minimum ${minimumAccuracy}`)
    }
    if (!(summaryVariant.avgInputTokens < full.avgInputTokens)) {
      reasons.push('summary_on_demand shows no measurable prompt token reduction')
    }
  }
  return { passed: reasons.length === 0, reasons, summaries }
}

function extractJson(text: string): string | undefined {
  const fenced = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)]
    .flatMap((match) => match[1] === undefined ? [] : [match[1]!.trim()])
    .filter((candidate) => candidate.startsWith('{') && candidate.endsWith('}'))
  if (fenced.length > 0) return fenced.at(-1)
  const trimmed = text.trim()
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) return trimmed
  let depth = 0
  let start = -1
  let inString = false
  let escaped = false
  let candidate: string | undefined
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') { inString = true; continue }
    if (char === '{') { if (depth === 0) start = index; depth += 1; continue }
    if (char === '}') {
      depth -= 1
      if (depth === 0 && start >= 0) candidate = text.slice(start, index + 1)
      if (depth < 0) { depth = 0; start = -1 }
    }
  }
  return candidate
}

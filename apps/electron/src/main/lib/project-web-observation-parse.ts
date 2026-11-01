/**
 * 外部变化观察响应的严格解析。
 *
 * 原则：模型输出只是待核对数据。字段白名单、来源归属、发布时间归属、重复指向
 * 全部由本机复核；任一项不可核对就不进入账本，降级为 insufficient_evidence。
 */
import type { WebChangeDuplicateReason, WebChangeJudgment } from '@gravitas/shared'
import { normalizeWebSourceId, type RecordWebChangeObservationInput } from './project-web-change-observations'
import type { WebObservationSource } from './project-web-observation-prompt'

const TOP_FIELDS = ['judgment', 'facts', 'impact', 'suggestion', 'question', 'uncertainty', 'failureReason', 'relatedObservationIds', 'duplicateOf', 'duplicateReason'] as const
const FACT_FIELDS = ['title', 'url', 'quote', 'publishedAt', 'isInference'] as const
const JUDGMENTS: readonly WebChangeJudgment[] = ['record_only', 'attention', 'decision_required', 'insufficient_evidence', 'duplicate']
const DUPLICATE_REASONS: readonly WebChangeDuplicateReason[] = ['same_source', 'same_event', 'no_new_content']
const MAX_FACTS = 20
const MAX_TITLE = 300
const MAX_URL = 2000
const MAX_QUOTE = 600
const MAX_TEXT = 2000
const MAX_QUESTION = 300
const MAX_RELATED = 10
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:T[\d:.+-]+Z?)?$/

export interface WebObservationCandidateFact {
  title: string
  url: string
  quote: string
  publishedAt: string | null
  isInference: boolean
}

export interface WebObservationCandidate {
  judgment: WebChangeJudgment
  facts: WebObservationCandidateFact[]
  impact: string | null
  suggestion: string | null
  question: string | null
  uncertainty: string | null
  failureReason: string | null
  relatedObservationIds: string[]
  duplicateOf: string | null
  duplicateReason: WebChangeDuplicateReason | null
}

export interface WebObservationParseStats {
  /** 因来源不在本次扫描结果、缺引用、重复引用而被丢弃的事实条数。 */
  droppedFacts: number
  /** 因来源没有可信发布时间而被清空或改写的条数。 */
  droppedPublishedAt: number
}

export type WebObservationParseResult =
  | ({ ok: true; candidate: WebObservationCandidate } & WebObservationParseStats)
  | { ok: false; failureReason: string }

/** 模型有时在 JSON 前后附带说明；只接受唯一的完整对象。 */
function extractJsonObject(input: string): unknown {
  try {
    return JSON.parse(input) as unknown
  } catch {
    // 继续尝试从说明文字里找唯一的完整对象。
  }
  const candidates: string[] = []
  let start = -1
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index]!
    if (start < 0) {
      if (char === '{') { start = index; depth = 1; inString = false; escaped = false }
      continue
    }
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === '{') depth += 1
    else if (char === '}' && --depth === 0) {
      candidates.push(input.slice(start, index + 1))
      start = -1
    }
  }
  if (start >= 0 || candidates.length !== 1) throw new Error('响应不是唯一完整的 JSON 对象')
  try {
    return JSON.parse(candidates[0]!) as unknown
  } catch {
    throw new Error('响应不是有效 JSON')
  }
}

function strictRecord(input: unknown, fields: readonly string[], label: string): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null)) throw new Error(`${label}必须是 JSON 对象`)
  if (Object.keys(input).some((key) => !fields.includes(key))) throw new Error(`${label}包含未知字段`)
  return input as Record<string, unknown>
}

function optionalText(value: unknown, label: string, max: number): string | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string') throw new Error(`${label}必须是文本`)
  const trimmed = value.trim()
  if (!trimmed) return null
  if (trimmed.length > max) throw new Error(`${label}超过 ${max} 个字符`)
  return trimmed
}

function requiredText(value: unknown, label: string, max: number): string {
  const text = optionalText(value, label, max)
  if (!text) throw new Error(`${label}不能为空`)
  return text
}

function resolvePublishedAt(input: unknown, source: WebObservationSource, stats: WebObservationParseStats): string | null {
  const claimed = optionalText(input, '发布时间', 40)
  if (claimed && !ISO_DATE.test(claimed)) throw new Error('发布时间必须是 ISO 日期或 null')
  const trusted = typeof source.publishedAt === 'string' && ISO_DATE.test(source.publishedAt.trim()) ? source.publishedAt.trim() : null
  if (!trusted) {
    // 来源没有可信发布时间：任何模型给出的日期都不采信，一律留空。
    if (claimed) stats.droppedPublishedAt += 1
    return null
  }
  if (claimed && claimed !== trusted) stats.droppedPublishedAt += 1
  return trusted
}

function normalizeFacts(
  input: unknown,
  sourceBySourceId: ReadonlyMap<string, WebObservationSource>,
  stats: WebObservationParseStats,
  maxFacts: number,
): WebObservationCandidateFact[] {
  if (input === null || input === undefined) return []
  if (!Array.isArray(input)) throw new Error('facts 必须是数组')
  const facts: WebObservationCandidateFact[] = []
  const seen = new Set<string>()
  for (const raw of input.slice(0, maxFacts)) {
    const item = strictRecord(raw, FACT_FIELDS, '事实')
    if (typeof item.isInference !== 'boolean') throw new Error('每条事实都必须标明是事实还是推断')
    const url = requiredText(item.url, '来源链接', MAX_URL)
    const sourceId = normalizeWebSourceId(url)
    const source = sourceId ? sourceBySourceId.get(sourceId) : undefined
    if (!sourceId || !source) { stats.droppedFacts += 1; continue }
    // 同一来源允许一条事实引用和一条推断；重复引用同一来源同一性质才丢弃。
    const identity = `${sourceId}:${item.isInference}`
    if (seen.has(identity)) { stats.droppedFacts += 1; continue }
    seen.add(identity)
    const quote = optionalText(item.quote, '来源引用', MAX_QUOTE) ?? ''
    // 事实必须有原文引用；推断不得冒用原文引用。
    if (!item.isInference && !quote) { stats.droppedFacts += 1; continue }
    if (item.isInference && quote) throw new Error('推断不能携带原文引用')
    facts.push({
      title: requiredText(item.title, '来源标题', MAX_TITLE),
      url,
      quote,
      publishedAt: resolvePublishedAt(item.publishedAt, source, stats),
      isInference: item.isInference,
    })
  }
  if (Array.isArray(input) && input.length > maxFacts) stats.droppedFacts += input.length - maxFacts
  return facts
}

/** 解析模型响应；任何不可核对的字段都降级为失败原因，而不是猜一个值。 */
export function parseWebObservationResponse(
  raw: string,
  options: { sources: WebObservationSource[]; existingObservationIds?: string[]; maxFacts?: number },
): WebObservationParseResult {
  let parsed: Record<string, unknown>
  try {
    if (typeof raw !== 'string' || !raw.trim()) throw new Error('响应为空')
    parsed = strictRecord(extractJsonObject(raw), TOP_FIELDS, '观察响应')
  } catch (error) {
    return { ok: false, failureReason: error instanceof Error ? error.message : String(error) }
  }

  const stats: WebObservationParseStats = { droppedFacts: 0, droppedPublishedAt: 0 }
  try {
    const judgment = parsed.judgment
    if (typeof judgment !== 'string' || !JUDGMENTS.includes(judgment as WebChangeJudgment)) throw new Error('判定取值无效')
    const sourceBySourceId = new Map<string, WebObservationSource>()
    for (const source of options.sources) {
      const sourceId = normalizeWebSourceId(source.url)
      if (sourceId) sourceBySourceId.set(sourceId, source)
    }
    const facts = normalizeFacts(parsed.facts, sourceBySourceId, stats, options.maxFacts ?? MAX_FACTS)
    const allowedObservationIds = new Set(options.existingObservationIds ?? [])

    const duplicateOf = optionalText(parsed.duplicateOf, '重复指向的观察', 100)
    const duplicateReason = parsed.duplicateReason
    if (judgment === 'duplicate') {
      if (!duplicateOf || !allowedObservationIds.has(duplicateOf)) throw new Error('重复指向的观察不存在于本项目历史')
      if (typeof duplicateReason !== 'string' || !DUPLICATE_REASONS.includes(duplicateReason as WebChangeDuplicateReason)) throw new Error('重复原因无效')
    } else if (duplicateOf || duplicateReason) {
      throw new Error('只有重复判定才能携带重复指向')
    }
    if ((judgment === 'attention' || judgment === 'decision_required') && facts.length === 0) {
      throw new Error('该判定没有可核对的来源引用')
    }

    const question = judgment === 'decision_required' ? requiredText(parsed.question, '待决问题', MAX_QUESTION) : null
    const failureReason = optionalText(parsed.failureReason, '失败原因', MAX_TEXT)
    if (judgment === 'insufficient_evidence' && !failureReason) throw new Error('证据不足必须写明原因')

    const related = Array.isArray(parsed.relatedObservationIds) ? parsed.relatedObservationIds : []
    const relatedObservationIds = [...new Set(related
      .filter((id): id is string => typeof id === 'string' && allowedObservationIds.has(id) && id !== duplicateOf))]
      .slice(0, MAX_RELATED)

    return {
      ok: true,
      droppedFacts: stats.droppedFacts,
      droppedPublishedAt: stats.droppedPublishedAt,
      candidate: {
        judgment: judgment as WebChangeJudgment,
        facts,
        impact: optionalText(parsed.impact, '潜在影响', MAX_TEXT),
        suggestion: optionalText(parsed.suggestion, '建议动作', MAX_TEXT),
        question,
        uncertainty: optionalText(parsed.uncertainty, '不确定性说明', MAX_TEXT),
        failureReason,
        relatedObservationIds,
        duplicateOf: judgment === 'duplicate' ? duplicateOf : null,
        duplicateReason: judgment === 'duplicate' ? duplicateReason as WebChangeDuplicateReason : null,
      },
    }
  } catch (error) {
    return { ok: false, failureReason: error instanceof Error ? error.message : String(error) }
  }
}

/** 判断无法完成时使用的候选：只写原因，不写结论。 */
export function insufficientEvidenceCandidate(failureReason: string): WebObservationCandidate {
  return {
    judgment: 'insufficient_evidence',
    facts: [],
    impact: null,
    suggestion: null,
    question: null,
    uncertainty: null,
    failureReason: failureReason.trim().slice(0, MAX_TEXT) || '判断未完成',
    relatedObservationIds: [],
    duplicateOf: null,
    duplicateReason: null,
  }
}

export interface BuildWebObservationRecordInputArgs {
  projectId: string
  runId: string
  candidate: WebObservationCandidate
  /** 本次扫描的新来源，用于账本二次核对来源归属与摘要指纹。 */
  sources: Array<{ url: string; snippet?: string }>
  topics: string[]
  goalRevision: number | null
  contextFingerprint: string | null
  modelId: string | null
  promptVersion: number
  sourcesCount: number
  truncated: boolean
  createdAt?: number
}

/** 把已解析的候选转成账本入参；账本会再核对一次来源与必填字段。 */
export function buildWebObservationRecordInput(args: BuildWebObservationRecordInputArgs): RecordWebChangeObservationInput {
  return {
    projectId: args.projectId,
    runId: args.runId,
    judgment: args.candidate.judgment,
    facts: args.candidate.facts.map((fact) => ({
      title: fact.title,
      url: fact.url,
      quote: fact.quote,
      publishedAt: fact.publishedAt,
      isInference: fact.isInference,
    })),
    knownSources: args.sources,
    impact: args.candidate.impact,
    suggestion: args.candidate.suggestion,
    question: args.candidate.question,
    uncertainty: args.candidate.uncertainty,
    failureReason: args.candidate.failureReason,
    relatedObservationIds: args.candidate.relatedObservationIds,
    duplicateOf: args.candidate.duplicateOf,
    duplicateReason: args.candidate.duplicateReason,
    binding: { goalRevision: args.goalRevision, contextFingerprint: args.contextFingerprint, topics: args.topics },
    evaluation: { modelId: args.modelId, promptVersion: args.promptVersion, sourcesCount: args.sourcesCount, truncated: args.truncated },
    ...(args.createdAt === undefined ? {} : { createdAt: args.createdAt }),
  }
}

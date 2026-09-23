import type {
  ContextConfidence,
  ContextEvidence,
  EvidenceKind,
  SubtaskArtifact,
  SubtaskClaim,
  SubtaskResult,
  SubtaskStatus,
} from '@gravitas/shared'

const EVIDENCE_KINDS = new Set<EvidenceKind>([
  'file_locator',
  'tool_result',
  'session_message',
  'test_result',
  'user_statement',
  'agent_artifact',
])
const STATUSES = new Set<SubtaskStatus>(['completed', 'partial', 'blocked', 'failed'])
const CONFIDENCES = new Set<Exclude<ContextConfidence, 'unknown'>>(['high', 'medium', 'low'])
const ARTIFACT_KINDS = new Set<SubtaskArtifact['kind']>([
  'file_finding',
  'plan',
  'review_finding',
  'research_note',
  'test_report',
])

export interface ParsedSubtaskResult {
  result: SubtaskResult
  protocolError?: string
}

/** typed-v1 调用只接收最后一个 JSON 代码块；其余文本可用于过程说明，但不会作为结构化结论采纳。 */
export const TYPED_SUBTASK_RESULT_PROTOCOL_PROMPT = `完成后请在回复末尾给出唯一一个以 \`\`\`json 开始、以 \`\`\` 结束的 JSON 代码块，内容符合以下 typed-v1 协议：
{"protocolVersion":1,"status":"completed|partial|blocked|failed","summary":"简要结论","claims":[{"statement":"结论","confidence":"high|medium|low","evidence":[{"kind":"file_locator|tool_result|session_message|test_result|user_statement|agent_artifact","sourceId":"稳定来源 ID","locator":"可选定位","verified":true}],"verified":true}],"artifacts":[{"kind":"file_finding|plan|review_finding|research_note|test_report","title":"标题","content":"内容","evidence":[]}],"unverified":["未验证事项"],"recommendedNextSteps":["后续动作"]}
高置信主张必须附带 evidence；没有证据时请使用 medium 或 low，并写入 unverified。`

/**
 * 解析 typed-v1 子任务结果。协议异常不抛出，统一降级为可审计的 partial 结果，
 * 让后续持久化能保留原始摘要而不会把不可信文本伪装成已验证结论。
 */
/** 将 typed result 转为父 Agent 可消费的紧凑交接；绝不回传 raw child transcript。 */
export function formatSubtaskResultForParent(result: SubtaskResult): string {
  const lines = [`子任务状态：${result.status}`, `摘要：${result.summary}`]
  if (result.claims.length > 0) {
    lines.push('主张：')
    lines.push(...result.claims.map((claim) => {
      const evidence = claim.evidence.length > 0
        ? `；证据：${claim.evidence.map(({ kind, sourceId, locator }) => `${kind}:${sourceId}${locator ? `#${locator}` : ''}`).join(', ')}`
        : ''
      return `- [${claim.confidence}${claim.verified ? '，已验证' : '，未验证'}] ${claim.statement}${evidence}`
    }))
  }
  if (result.artifacts.length > 0) {
    lines.push('产物：')
    lines.push(...result.artifacts.map((artifact) => `- [${artifact.kind}] ${artifact.title}\n${artifact.content}`))
  }
  if (result.unverified.length > 0) {
    lines.push('未验证：')
    lines.push(...result.unverified.map((item) => `- ${item}`))
  }
  if (result.recommendedNextSteps.length > 0) {
    lines.push('建议后续：')
    lines.push(...result.recommendedNextSteps.map((item) => `- ${item}`))
  }
  return lines.join('\n')
}

export function parseSubtaskResult(text: string, taskId: string): ParsedSubtaskResult {
  const candidate = extractJsonObject(text)
  if (!candidate) return protocolFailure(taskId, text, '未找到 typed-v1 JSON 对象')

  try {
    const value: unknown = JSON.parse(candidate)
    if (!isRecord(value) || value.protocolVersion !== 1 || !isString(value.summary) || !STATUSES.has(value.status as SubtaskStatus)) {
      return protocolFailure(taskId, text, 'typed-v1 结果缺少必要字段')
    }

    const unverified = stringArray(value.unverified)
    const claims = parseClaims(value.claims, unverified)
    const artifacts = parseArtifacts(value.artifacts)
    return {
      result: {
        protocolVersion: 1,
        taskId,
        status: value.status as SubtaskStatus,
        summary: value.summary,
        claims,
        artifacts,
        unverified,
        recommendedNextSteps: stringArray(value.recommendedNextSteps),
      },
    }
  } catch {
    return protocolFailure(taskId, text, 'typed-v1 JSON 无法解析')
  }
}

function parseClaims(value: unknown, unverified: string[]): SubtaskClaim[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((claim): SubtaskClaim[] => {
    if (!isRecord(claim) || !isString(claim.statement) || !CONFIDENCES.has(claim.confidence as Exclude<ContextConfidence, 'unknown'>)) {
      return []
    }
    const evidence = parseEvidenceArray(claim.evidence)
    let confidence = claim.confidence as Exclude<ContextConfidence, 'unknown'>
    let verified = claim.verified === true
    if (confidence === 'high' && evidence.length === 0) {
      confidence = 'medium'
      verified = false
      unverified.push(`主张缺少 evidence，已从 high 降级：${claim.statement}`)
    }
    return [{ statement: claim.statement, confidence, evidence, verified }]
  })
}

function parseArtifacts(value: unknown): SubtaskArtifact[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((artifact): SubtaskArtifact[] => {
    if (!isRecord(artifact) || !ARTIFACT_KINDS.has(artifact.kind as SubtaskArtifact['kind']) || !isString(artifact.title) || !isString(artifact.content)) {
      return []
    }
    return [{
      kind: artifact.kind as SubtaskArtifact['kind'],
      title: artifact.title,
      content: artifact.content,
      evidence: parseEvidenceArray(artifact.evidence),
    }]
  })
}

function parseEvidenceArray(value: unknown): ContextEvidence[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((evidence): ContextEvidence[] => {
    if (!isRecord(evidence) || !EVIDENCE_KINDS.has(evidence.kind as EvidenceKind) || !isString(evidence.sourceId) || typeof evidence.verified !== 'boolean') {
      return []
    }
    return [{
      kind: evidence.kind as EvidenceKind,
      sourceId: evidence.sourceId,
      verified: evidence.verified,
      ...(isString(evidence.locator) ? { locator: evidence.locator } : {}),
      ...(isString(evidence.checksum) ? { checksum: evidence.checksum } : {}),
    }]
  })
}

function protocolFailure(taskId: string, text: string, protocolError: string): ParsedSubtaskResult {
  return {
    result: {
      protocolVersion: 1,
      taskId,
      status: 'partial',
      summary: text.trim() || '子任务未返回可解析的结果。',
      claims: [],
      artifacts: [],
      unverified: [protocolError],
      recommendedNextSteps: ['要求子任务按 typed-v1 协议重试。'],
    },
    protocolError,
  }
}

function extractJsonObject(text: string): string | undefined {
  const fenced = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)]
    .flatMap((match) => match[1] === undefined ? [] : [match[1].trim()])
    .filter((candidate) => candidate.startsWith('{') && candidate.endsWith('}'))
  if (fenced.length > 0) return fenced.at(-1)
  const trimmed = text.trim()
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) return trimmed
  // 真实模型常在 JSON 前后附加解释文字。只接受“最后一个能配平的顶层对象”，
  // 仍不放松协议字段校验，避免把散文当成结构化结论。
  return lastBalancedObject(text)
}

function lastBalancedObject(text: string): string | undefined {
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

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter(isString) : []
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isString(value: unknown): value is string {
  return typeof value === 'string'
}

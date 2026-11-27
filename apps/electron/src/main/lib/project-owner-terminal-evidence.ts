/** Owner命令终态证据：只做本地确定性归因，不推断账单、不改授权、不重放请求。 */
import type { OwnerExecutionCommandRole, OwnerTerminalEvidence, SDKResultMessage } from '@gravitas/shared'
import { ownerExecutionHash } from './project-owner-execution-hash'
import * as store from './project-sqlite-store'

/** 诊断说明最大长度；脱敏后仍可能超长，必须稳定截断。 */
const MAX_DETAIL_LENGTH = 300
/** 裸凭证 token 的最短可疑长度，避免把普通单词误判为密钥。 */
const MIN_SECRET_LENGTH = 12
/** 形如 `sk-xxxxxxxxxxxx` / `key_xxxxxxxxxxxx` / `token-xxxxxxxxxxxx` 的裸凭证。 */
const BARE_SECRET_PATTERN = new RegExp(`\\b(?:sk|key|token)[-_][A-Za-z0-9_-]{${MIN_SECRET_LENGTH},}\\b`, 'gi')

/** 归一化后的单条消息：只保留角色与内容块，屏蔽 SDKMessage / AgentMessage 的形状差异。 */
interface NormalizedMessage {
  role: 'assistant' | 'user'
  blocks: readonly unknown[]
}

export interface TerminalEvidenceInput {
  executionId: string
  commandId: string
  role: OwnerExecutionCommandRole
  executionStatus: string
  stopped: boolean
  /** Runtime 终态回执；仅部分字段可信，缺省表示没有回执。 */
  runtimeResult?: Partial<SDKResultMessage> | null
  /** 消息流；真实调用方传 AgentMessage[]，历史路径可能传 SDKMessage[]。 */
  messages: readonly unknown[]
  error: string
  cost: OwnerTerminalEvidence['cost']
  development: OwnerTerminalEvidence['development']
  capturedAt: number
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

/** 同时接受 SDKMessage（type + message.content blocks）与 AgentMessage（role + content string）。 */
function normalizeMessage(value: unknown): NormalizedMessage | null {
  const raw = record(value)
  if (!raw) return null
  const role = raw.role ?? raw.type
  if (role !== 'assistant' && role !== 'user') return null
  const body = record(raw.message)?.content ?? raw.content
  // AgentMessage 的 content 是字符串，确实不含工具信息；降级为空块列表，不伪造调用。
  return { role, blocks: Array.isArray(body) ? body : [] }
}

/** 截断到上限；若截断点落在占位符内部，退回到占位符起点之前。 */
function truncateDetail(value: string): string {
  if (value.length <= MAX_DETAIL_LENGTH) return value
  const sliced = value.slice(0, MAX_DETAIL_LENGTH)
  const open = sliced.lastIndexOf('[')
  if (open > 0 && open > sliced.lastIndexOf(']')) return sliced.slice(0, open).trimEnd()
  return sliced
}

/** 与 Owner 恢复提示同口径的脱敏：不得泄漏凭据、绝对路径或正文。 */
export function sanitizeOwnerDiagnostic(value: string): string {
  const sanitized = value
    .replace(/Bearer\s+\S+/gi, 'Bearer [已隐藏]')
    .replace(BARE_SECRET_PATTERN, '[凭证已隐藏]')
    .replace(/(api[_-]?key|authorization|access[_-]?token|password|secret|token)\s*[:=]\s*[^,;\s]+/gi, '$1=[已隐藏]')
    .replace(/(?:\/Users\/[^\s:]+|\/home\/[^\s:]+|\/opt\/[^\s:]+|\/var\/[^\s:]+|\/tmp\/[^\s:]+|[A-Z]:\\[^\s:]+)/g, '[本地路径]')
    .replace(/\s+/g, ' ').trim()
  return truncateDetail(sanitized)
}

function toolStats(messages: readonly unknown[]): OwnerTerminalEvidence['tools'] {
  let calls = 0, results = 0
  let lastToolName: string | null = null
  let lastResultStatus: OwnerTerminalEvidence['tools']['lastResultStatus'] = null
  for (const message of messages) {
    const normalized = normalizeMessage(message)
    if (!normalized) continue
    for (const blockValue of normalized.blocks) {
      const block = record(blockValue)
      if (block?.type === 'tool_use') { calls += 1; lastToolName = typeof block.name === 'string' ? block.name : null }
      if (block?.type === 'tool_result') { results += 1; lastResultStatus = block.is_error === true ? 'error' : 'ok' }
    }
  }
  if (calls > results) lastResultStatus = 'missing'
  return { calls, results, lastToolName, lastResultStatus, incompleteBatch: calls !== results }
}

/** Provider 终止原因是根因，工具批次不完整只是后果：判定顺序不能倒置。 */
function classify(input: TerminalEvidenceInput, tools: OwnerTerminalEvidence['tools']): OwnerTerminalEvidence['reason'] {
  const finishReason = input.runtimeResult?.finish_reason
  if (input.stopped) return 'stopped_by_user'
  if (finishReason === 'length') return 'output_limit'
  if (typeof finishReason === 'string' && finishReason !== 'stop') return 'provider_stop'
  if (input.runtimeResult?.toolCallBatchIntegrity?.complete === false) return 'tool_call_incomplete'
  if (finishReason === 'stop' && tools.calls !== tools.results) return 'tool_call_incomplete'
  const hasOutput = input.messages.some(message => normalizeMessage(message)?.role === 'assistant')
  if (!hasOutput) return 'no_output'
  if (input.error.trim()) return 'runtime_error'
  if (finishReason === 'stop') return 'completed'
  return 'unknown'
}

export function classifyOwnerTerminalEvidence(input: TerminalEvidenceInput): OwnerTerminalEvidence {
  const tools = toolStats(input.messages)
  const result = input.runtimeResult ?? null
  const correctionError = input.role === 'reviewer' && result?.subtype === 'error_during_execution' && Array.isArray(result.errors)
    ? result.errors.find(error => typeof error === 'string' && error.startsWith('Reviewer补正未完成：')) : undefined
  return {
    schemaVersion: 1,
    executionId: input.executionId,
    commandId: input.commandId,
    role: input.role,
    executionStatus: input.executionStatus,
    provider: result ? {
      subtype: typeof result.subtype === 'string' ? result.subtype : null,
      finishReason: typeof result.finish_reason === 'string' ? result.finish_reason : null,
      requestId: typeof result.provider_request_id === 'string' ? result.provider_request_id : null,
      responseId: typeof result.provider_response_id === 'string' ? result.provider_response_id : null,
    } : null,
    reason: classify(input, tools),
    detail: sanitizeOwnerDiagnostic(correctionError ?? (input.error.trim() || '未记录失败说明')),
    tools,
    cost: input.cost,
    development: input.development,
    capturedAt: input.capturedAt,
  }
}

interface EvidenceRow { payload: string; integrity_hash: string; project_id: string; execution_id: string }

/** 证据结构里没有 projectId；出现任何未列出的键都视为被篡改，拒绝读写。 */
const EVIDENCE_KEYS = ['schemaVersion', 'executionId', 'commandId', 'role', 'executionStatus', 'provider', 'reason', 'detail', 'tools', 'cost', 'development', 'capturedAt'].sort().join('|')

function shapeError(reason: string): never {
  throw new Error(`Owner终端证据结构无效：${reason}`)
}

/**
 * 读写共用的形状校验：写侧先验后落库，读侧验后再展示。
 * 两侧若不同款，写侧会静默落一条读侧必然拒绝的行，之后整个命令列表都不可用。
 */
function assertEvidenceShape(evidence: OwnerTerminalEvidence, commandId: string): void {
  const value = record(evidence)
  if (!value) shapeError('不是有效对象')
  if (value.schemaVersion !== 1) shapeError('schemaVersion必须为1')
  if (Object.keys(value).sort().join('|') !== EVIDENCE_KEYS) throw new Error('Owner终端证据夹带未授权字段')
  if (value.commandId !== commandId) throw new Error('Owner终端证据身份无效')
  for (const field of ['executionId', 'commandId', 'role', 'executionStatus'] as const) {
    const item = value[field]
    if (typeof item !== 'string' || !item.trim()) shapeError(`${field}必须是非空字符串`)
  }
  if (value.role !== 'executor' && value.role !== 'reviewer') shapeError('role无效')
  if (typeof value.detail !== 'string') shapeError('detail必须是字符串')
  if (!Number.isSafeInteger(value.capturedAt) || Number(value.capturedAt) < 1) shapeError('capturedAt必须是正整数时间戳')
  if (value.provider !== null) {
    const provider = record(value.provider)
    if (!provider) shapeError('provider必须是对象或null')
    for (const field of ['subtype', 'finishReason', 'requestId', 'responseId'] as const) {
      const item = provider[field]
      if (item !== null && typeof item !== 'string') shapeError(`provider.${field}必须是字符串或null`)
    }
  }
  const tools = record(value.tools)
  if (!tools) shapeError('tools必须是对象')
  if (!Number.isSafeInteger(tools.calls) || Number(tools.calls) < 0) shapeError('tools.calls必须是非负整数')
  if (!Number.isSafeInteger(tools.results) || Number(tools.results) < 0) shapeError('tools.results必须是非负整数')
  if (tools.lastToolName !== null && typeof tools.lastToolName !== 'string') shapeError('tools.lastToolName必须是字符串或null')
  if (tools.lastResultStatus !== null && tools.lastResultStatus !== 'ok' && tools.lastResultStatus !== 'error' && tools.lastResultStatus !== 'missing') shapeError('tools.lastResultStatus无效')
  if (typeof tools.incompleteBatch !== 'boolean') shapeError('tools.incompleteBatch必须是布尔值')
  const cost = record(value.cost)
  if (!cost) shapeError('cost必须是对象')
  if (cost.state !== 'settled' && cost.state !== 'unknown') shapeError('cost.state无效')
  if (cost.actualCostMicros !== null && (!Number.isSafeInteger(cost.actualCostMicros) || Number(cost.actualCostMicros) < 0)) shapeError('cost.actualCostMicros必须是非负整数或null')
  if (!Number.isSafeInteger(cost.requestCount) || Number(cost.requestCount) < 0) shapeError('cost.requestCount必须是非负整数')
  if (value.development !== null) {
    const development = record(value.development)
    if (!development) shapeError('development必须是对象或null')
    if (development.worktreePath !== null && typeof development.worktreePath !== 'string') shapeError('development.worktreePath必须是字符串或null')
    if (development.baseCommit !== null && typeof development.baseCommit !== 'string') shapeError('development.baseCommit必须是字符串或null')
    for (const field of ['changedFiles', 'untrackedFiles'] as const) {
      const files = development[field]
      if (!Array.isArray(files) || files.some(file => typeof file !== 'string')) shapeError(`development.${field}必须是字符串数组`)
    }
  }
}

function parseEvidenceRow(row: EvidenceRow, commandId: string): OwnerTerminalEvidence {
  let value: unknown
  try { value = JSON.parse(row.payload) } catch { throw new Error('Owner终端证据不是有效JSON') }
  if (ownerExecutionHash(value) !== row.integrity_hash) throw new Error('Owner终端证据完整性无效')
  const evidence = value as OwnerTerminalEvidence
  assertEvidenceShape(evidence, commandId)
  if (evidence.executionId !== row.execution_id) throw new Error('Owner终端证据身份无效')
  return evidence
}

/**
 * 同一命令只允许一份证据：重复写入比较的是规范化哈希（键序无关，值必须相同），不是逐字节一致。
 * 调用方必须从持久化状态派生 capturedAt，不得在重试时重新取 Date.now()；
 * 该写入发生在终态结算事务内，哈希不等会连 settleOwnerCommandUsage 一起回滚，
 * 一次成功的完成会退化成 needs_reconcile 与人工对账。
 */
export function writeOwnerTerminalEvidence(projectId: string, evidence: OwnerTerminalEvidence): OwnerTerminalEvidence {
  if (!projectId.trim()) throw new Error('Owner终端证据主体无效')
  // 任何写库动作之前先做与读侧同款的形状校验，避免落一条读不出来的行。
  assertEvidenceShape(evidence, evidence?.commandId ?? '')
  const database = store.getProjectDb()
  const existing = database.prepare('SELECT payload, integrity_hash, project_id, execution_id FROM project_owner_execution_terminal_evidence WHERE command_id=?')
    .get(evidence.commandId) as EvidenceRow | undefined
  const integrityHash = ownerExecutionHash(evidence)
  if (existing) {
    if (existing.project_id !== projectId || existing.execution_id !== evidence.executionId || existing.integrity_hash !== integrityHash)
      throw new Error('Owner终端证据与已有记录不一致，保留原件核查')
    return evidence
  }
  database.prepare('INSERT INTO project_owner_execution_terminal_evidence(command_id,project_id,execution_id,payload,integrity_hash,created_at) VALUES(?,?,?,?,?,?)')
    .run(evidence.commandId, projectId, evidence.executionId, JSON.stringify(evidence), integrityHash, evidence.capturedAt)
  return evidence
}

export function readOwnerTerminalEvidence(commandId: string): OwnerTerminalEvidence | null {
  const row = store.getProjectDb().prepare('SELECT payload, integrity_hash, project_id, execution_id FROM project_owner_execution_terminal_evidence WHERE command_id=?')
    .get(commandId) as EvidenceRow | undefined
  return row ? parseEvidenceRow(row, commandId) : null
}

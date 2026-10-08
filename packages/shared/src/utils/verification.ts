import type {
  VerificationArtifactRevision,
  VerificationParseOptions,
  VerificationParseResult,
  VerificationReceipt,
} from '../types/verification.ts'

const SUBJECT_KEYS = ['workspaceId', 'sessionId', 'runId', 'agentGoalId', 'projectId', 'taskId', 'executionId']
const BUSINESS_KEYS = ['projectId', 'taskId', 'executionId']
const ARTIFACT_KEYS = ['version', 'artifactId', 'subject', 'baseRevision', 'contentHash', 'scopeHash', 'capturedAt', 'evidenceRef']
const RECEIPT_KEYS = ['version', 'receiptId', 'subject', 'criteriaId', 'verifier', 'artifact', 'toolCallId', 'startedAt', 'finishedAt', 'exitCode', 'result', 'checksCollected', 'evidenceRef', 'source']
const SHA256 = /^[a-f0-9]{64}$/
const GIT_REVISION = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/

/** 仅校验DTO结构与身份一致性；成功不等于来源可信、产物新鲜或业务已验收。 */
export function parseVerificationArtifactRevision(
  input: unknown,
  options: VerificationParseOptions,
): VerificationParseResult<VerificationArtifactRevision> {
  const errors = validateOptions(options)
  validateArtifact(input, options, errors)
  return parsedResult<VerificationArtifactRevision>(input, errors)
}

/** 模型可伪造格式合法的DTO；后续服务必须从权威运行记录核验，不能直接消费为完成证据。 */
export function parseVerificationReceipt(
  input: unknown,
  options: VerificationParseOptions,
): VerificationParseResult<VerificationReceipt> {
  const errors = validateOptions(options)
  const receipt = objectFields(input, RECEIPT_KEYS, 'receipt', errors)
  if (!receipt) return { ok: false, errors }

  requireVersion(receipt, 'receipt', errors)
  requireStrings(receipt, ['receiptId', 'criteriaId', 'toolCallId', 'evidenceRef'], 'receipt', errors)
  validateSubject(receipt.subject, options.expectedSubject, 'receipt.subject', errors)
  validateArtifact(receipt.artifact, options, errors)

  const verifier = objectFields(receipt.verifier, ['id', 'version', 'configHash', 'kind'], 'receipt.verifier', errors)
  if (verifier) {
    requireStrings(verifier, ['id', 'version'], 'receipt.verifier', errors)
    requirePattern(verifier.configHash, SHA256, 'receipt.verifier.configHash', errors)
    if (verifier.kind !== 'test' && verifier.kind !== 'command') errors.push('receipt.verifier.kind 无效')
  }
  if (receipt.source !== 'main-process') errors.push('receipt.source 必须为main-process；这不是信任证明')
  if (typeof receipt.result !== 'string' || !['passed', 'failed', 'unknown', 'skipped'].includes(receipt.result)) errors.push('receipt.result 无效')
  validateTimestamp(receipt.startedAt, options.now, 'receipt.startedAt', errors)
  validateTimestamp(receipt.finishedAt, options.now, 'receipt.finishedAt', errors)
  if (isTimestamp(receipt.startedAt) && isTimestamp(receipt.finishedAt) && receipt.finishedAt < receipt.startedAt) {
    errors.push('receipt.finishedAt 早于startedAt')
  }
  const artifact = isRecord(receipt.artifact) ? receipt.artifact : undefined
  if (artifact && isTimestamp(artifact.capturedAt) && isTimestamp(receipt.startedAt) && artifact.capturedAt > receipt.startedAt) {
    errors.push('artifact.capturedAt 晚于验证开始')
  }
  if (receipt.exitCode !== null && !(typeof receipt.exitCode === 'number' && Number.isSafeInteger(receipt.exitCode) && receipt.exitCode >= 0)) {
    errors.push('receipt.exitCode 必须为非负整数或null')
  }
  if (receipt.checksCollected !== null && !isTimestamp(receipt.checksCollected)) {
    errors.push('receipt.checksCollected 必须为非负整数或null')
  }
  if (receipt.result === 'passed') {
    if (receipt.exitCode !== 0) errors.push('passed 必须有退出码0')
    if (verifier?.kind === 'test' && !(isTimestamp(receipt.checksCollected) && receipt.checksCollected > 0)) {
      errors.push('test passed 必须收集到至少一个检查')
    }
  }
  return parsedResult<VerificationReceipt>(input, errors)
}

function validateOptions(options: VerificationParseOptions): string[] {
  const errors: string[] = []
  if (!isTimestamp(options.now)) errors.push('options.now 必须为非负安全整数')
  validateSubject(options.expectedSubject, undefined, 'options.expectedSubject', errors)
  return errors
}

function validateArtifact(input: unknown, options: VerificationParseOptions, errors: string[]): void {
  const artifact = objectFields(input, ARTIFACT_KEYS, 'artifact', errors)
  if (!artifact) return
  requireVersion(artifact, 'artifact', errors)
  requireStrings(artifact, ['artifactId', 'evidenceRef'], 'artifact', errors)
  validateSubject(artifact.subject, options.expectedSubject, 'artifact.subject', errors)
  requirePattern(artifact.baseRevision, GIT_REVISION, 'artifact.baseRevision', errors)
  requirePattern(artifact.contentHash, SHA256, 'artifact.contentHash', errors)
  requirePattern(artifact.scopeHash, SHA256, 'artifact.scopeHash', errors)
  validateTimestamp(artifact.capturedAt, options.now, 'artifact.capturedAt', errors)
}

function validateSubject(input: unknown, expected: unknown, path: string, errors: string[]): void {
  const subject = objectFields(input, SUBJECT_KEYS, path, errors)
  if (!subject) return
  requireStrings(subject, SUBJECT_KEYS.slice(0, 4), path, errors)
  const presentBusinessKeys = BUSINESS_KEYS.filter((key) => Object.hasOwn(subject, key))
  if (presentBusinessKeys.length > 0) {
    requireStrings(subject, BUSINESS_KEYS, path, errors)
  }
  if (isRecord(expected)) {
    for (const key of SUBJECT_KEYS) {
      if (subject[key] !== expected[key]) errors.push(`${path}.${key} 身份不匹配`)
    }
  }
}

function objectFields(input: unknown, allowed: readonly string[], path: string, errors: string[]): Record<string, unknown> | undefined {
  if (!isRecord(input) || (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null)) {
    errors.push(`${path} 必须为普通JSON对象`)
    return undefined
  }
  for (const key of Object.keys(input)) {
    if (!allowed.includes(key)) errors.push(`${path}.${key} 为未知字段`)
  }
  return input
}

function requireVersion(input: Record<string, unknown>, path: string, errors: string[]): void {
  if (input.version !== 1) errors.push(`${path}.version 必须为1`)
}

function requireStrings(input: Record<string, unknown>, keys: readonly string[], path: string, errors: string[]): void {
  for (const key of keys) {
    if (typeof input[key] !== 'string' || input[key].trim().length === 0) errors.push(`${path}.${key} 必须为非空字符串`)
  }
}

function requirePattern(input: unknown, pattern: RegExp, path: string, errors: string[]): void {
  if (typeof input !== 'string' || !pattern.test(input)) errors.push(`${path} 格式无效`)
}

function validateTimestamp(input: unknown, now: number, path: string, errors: string[]): void {
  if (!isTimestamp(input) || input > now) errors.push(`${path} 必须为不晚于当前时钟的非负安全整数`)
}

function isTimestamp(input: unknown): input is number {
  return typeof input === 'number' && Number.isSafeInteger(input) && input >= 0
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input)
}

function parsedResult<T>(input: unknown, errors: string[]): VerificationParseResult<T> {
  if (errors.length > 0) return { ok: false, errors }
  // 所有字段已逐项校验；返回JSON独立副本，避免输入对象的后续修改影响解析结果。
  return { ok: true, value: JSON.parse(JSON.stringify(input)) as T }
}

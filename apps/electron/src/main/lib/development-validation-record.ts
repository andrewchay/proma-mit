/** 验证JSON结构与身份检查；只做解码，真实来源和新鲜度由服务回读。 */
import type { DevelopmentValidationResult } from '@gravitas/shared'

interface ExpectedValidationRecord {
  id: string
  taskId: string
  executionId: string
}

export const DEVELOPMENT_VALIDATION_OUTPUT_TAIL_CHARS = 8000

const HASH = /^[a-f0-9]{64}$/
const BASE_REVISION = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/
const RECORD_KEYS = ['id', 'taskId', 'executionId', 'command', 'startedAt', 'finishedAt', 'exitCode', 'timedOut', 'status', 'snapshotContentHash', 'outputTail', 'outputTruncated', 'binding']
const BINDING_KEYS = ['version', 'projectId', 'workspaceId', 'sessionId', 'snapshotId', 'baseCommit', 'scopeHash', 'verificationConfigHash']

export function parseDevelopmentValidationRecord(
  input: unknown,
  expected: ExpectedValidationRecord,
  now: number,
): DevelopmentValidationResult | undefined {
  if (!isRecord(input) || Object.keys(input).some((key) => !RECORD_KEYS.includes(key))) return undefined
  for (const key of ['id', 'taskId', 'executionId']) {
    if (typeof input[key] !== 'string' || !input[key].trim()) return undefined
  }
  if (input.id !== expected.id || input.taskId !== expected.taskId || input.executionId !== expected.executionId) return undefined
  if (typeof input.command !== 'string' || !input.command.trim()) return undefined
  if (!isTime(now) || !isTime(input.startedAt) || !isTime(input.finishedAt) || input.finishedAt < input.startedAt || input.finishedAt > now) return undefined
  if (input.exitCode !== null && !isTime(input.exitCode)) return undefined
  if (typeof input.timedOut !== 'boolean' || typeof input.outputTruncated !== 'boolean') return undefined
  if (typeof input.outputTail !== 'string' || input.outputTail.length > DEVELOPMENT_VALIDATION_OUTPUT_TAIL_CHARS) return undefined
  if (typeof input.snapshotContentHash !== 'string' || !HASH.test(input.snapshotContentHash)) return undefined
  if (typeof input.status !== 'string' || !['passed', 'failed', 'stale', 'timeout'].includes(input.status)) return undefined
  if (input.timedOut !== (input.status === 'timeout')) return undefined
  if (input.status === 'passed' && input.exitCode !== 0) return undefined
  if (input.status === 'timeout' && input.exitCode !== null) return undefined
  if (input.binding !== undefined) {
    const binding = input.binding
    if (!isRecord(binding) || Object.keys(binding).some((key) => !BINDING_KEYS.includes(key))) return undefined
    if (binding.version !== 1) return undefined
    for (const key of ['projectId', 'workspaceId', 'sessionId', 'snapshotId']) {
      if (typeof binding[key] !== 'string' || !binding[key].trim()) return undefined
    }
    if (typeof binding.baseCommit !== 'string' || !BASE_REVISION.test(binding.baseCommit)) return undefined
    for (const key of ['scopeHash', 'verificationConfigHash']) {
      if (typeof binding[key] !== 'string' || !HASH.test(binding[key])) return undefined
    }
  }
  return JSON.parse(JSON.stringify(input)) as DevelopmentValidationResult
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input)
    && (Object.getPrototypeOf(input) === Object.prototype || Object.getPrototypeOf(input) === null)
}

function isTime(input: unknown): input is number {
  return typeof input === 'number' && Number.isSafeInteger(input) && input >= 0
}

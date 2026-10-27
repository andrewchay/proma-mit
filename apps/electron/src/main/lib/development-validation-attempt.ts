import { closeSync, existsSync, fsyncSync, lstatSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { writeJsonFileAtomic } from './safe-file'

export interface OwnerDevelopmentValidationAttempt {
  version: 1
  ownerCommandId: string
  projectId: string
  grantId: string
  taskId: string
  stepLinkId: string
  sourceHash: string
  executionId: string
  workspaceId: string
  command: string
  snapshotContentHash: string
  verificationConfigHash: string
  validationId: string
  startedAt: number
  state: 'running' | 'completed'
}

export type OwnerDevelopmentValidationReservation =
  | { kind: 'reserved'; attempt: OwnerDevelopmentValidationAttempt }
  | { kind: 'unknown'; attempt: OwnerDevelopmentValidationAttempt }
  | { kind: 'completed'; attempt: OwnerDevelopmentValidationAttempt }

export function ownerDevelopmentValidationId(ownerCommandId: string, command: string, snapshotContentHash: string): string {
  if (!ownerCommandId.trim() || !command.trim() || !/^[a-f0-9]{64}$/.test(snapshotContentHash)) throw new Error('Owner验证尝试身份参数无效')
  return `val-${createHash('sha256').update(`${ownerCommandId}\0${command}\0${snapshotContentHash}`).digest('hex')}`
}

export function reserveOwnerDevelopmentValidationAttempt(
  directory: string,
  input: Omit<OwnerDevelopmentValidationAttempt, 'version' | 'state'>,
): OwnerDevelopmentValidationReservation {
  const path = attemptPath(directory, input.validationId)
  if (existsSync(path)) {
    const existing = readAttempt(path)
    if (!sameAttempt(existing, input)) throw new Error('Owner验证尝试ID与冻结命令来源冲突')
    return existing.state === 'completed' ? { kind: 'completed', attempt: existing } : { kind: 'unknown', attempt: existing }
  }

  const attempt: OwnerDevelopmentValidationAttempt = { version: 1, ...input, state: 'running' }
  let descriptor: number
  try {
    descriptor = openSync(path, 'wx', 0o600)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      const existing = readAttempt(path)
      if (!sameAttempt(existing, input)) throw new Error('Owner验证尝试ID与冻结命令来源冲突')
      return existing.state === 'completed' ? { kind: 'completed', attempt: existing } : { kind: 'unknown', attempt: existing }
    }
    throw error
  }
  try {
    writeFileSync(descriptor, JSON.stringify(attempt), 'utf8')
    fsyncSync(descriptor)
  } finally {
    closeSync(descriptor)
  }
  return { kind: 'reserved', attempt }
}

export function completeOwnerDevelopmentValidationAttempt(
  directory: string,
  input: Omit<OwnerDevelopmentValidationAttempt, 'version' | 'state'>,
): OwnerDevelopmentValidationAttempt {
  const path = attemptPath(directory, input.validationId)
  const existing = readAttempt(path)
  if (!sameAttempt(existing, input)) throw new Error('Owner验证回执与预留尝试来源不匹配')
  if (existing.state === 'completed') return existing
  const completed: OwnerDevelopmentValidationAttempt = { ...existing, state: 'completed' }
  writeJsonFileAtomic(path, completed)
  return completed
}

export function readOwnerDevelopmentValidationAttempt(directory: string, validationId: string): OwnerDevelopmentValidationAttempt | undefined {
  const path = attemptPath(directory, validationId)
  if (!existsSync(path)) return undefined
  return readAttempt(path)
}

function attemptPath(directory: string, validationId: string): string {
  if (!/^val-[a-f0-9]{64}$/.test(validationId)) throw new Error('Owner验证尝试ID无效')
  return join(directory, `owner-development-validation-attempt-${validationId}.json`)
}

function readAttempt(path: string): OwnerDevelopmentValidationAttempt {
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024) throw new Error('Owner验证尝试记录不是合法私有文件')
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (!isAttempt(value)) throw new Error('Owner验证尝试记录结构无效；按未知状态保留且不重跑')
  return value
}

function isAttempt(value: unknown): value is OwnerDevelopmentValidationAttempt {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const row = value as Record<string, unknown>
  return Object.keys(row).length === 15 && row.version === 1
    && ['ownerCommandId', 'projectId', 'grantId', 'taskId', 'stepLinkId', 'executionId', 'workspaceId', 'command'].every(key => typeof row[key] === 'string' && Boolean((row[key] as string).trim()))
    && ['sourceHash', 'snapshotContentHash', 'verificationConfigHash'].every(key => typeof row[key] === 'string' && /^[a-f0-9]{64}$/.test(row[key] as string))
    && typeof row.validationId === 'string' && /^val-[a-f0-9]{64}$/.test(row.validationId)
    && Number.isSafeInteger(row.startedAt) && (row.startedAt as number) >= 0
    && (row.state === 'running' || row.state === 'completed')
}

function sameAttempt(existing: OwnerDevelopmentValidationAttempt, expected: Omit<OwnerDevelopmentValidationAttempt, 'version' | 'state'>): boolean {
  return existing.ownerCommandId === expected.ownerCommandId && existing.projectId === expected.projectId
    && existing.grantId === expected.grantId && existing.taskId === expected.taskId
    && existing.stepLinkId === expected.stepLinkId && existing.sourceHash === expected.sourceHash
    && existing.executionId === expected.executionId && existing.workspaceId === expected.workspaceId
    && existing.command === expected.command && existing.snapshotContentHash === expected.snapshotContentHash
    && existing.verificationConfigHash === expected.verificationConfigHash && existing.validationId === expected.validationId
}

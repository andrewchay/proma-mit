/** 完整文本成果副本。业务身份仍由SQLite决定；缺失或损坏不从摘要补造。 */
import { constants, closeSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import type { OwnerTextDelivery } from '@gravitas/shared'
import { getProjectsDir } from './config-paths'
import { ownerExecutionHash } from './project-owner-execution-hash'
import { readOwnerCommandFrozenSource } from './project-owner-employee-runtime'
import * as store from './project-sqlite-store'

export const OWNER_TEXT_DELIVERY_MAX_BYTES = 64 * 1024
const MAX_FILE_BYTES = 512 * 1024
const sha = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex')
function syncDirectory(path: string): void {
  if (process.platform === 'win32') return
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try { fsyncSync(fd) } finally { closeSync(fd) }
}
interface DeliveryCommand {
  id: string; project_id: string; grant_id: string; source_task_id: string; source_step_link_id: string; source_hash: string
  role: string; rework_ordinal: number; execution_id: string | null; state: string; actual_cost_micros: number | null
  text_delivery_hash: string | null
}
function source(commandId: string) {
  const command = store.getProjectDb().prepare('SELECT * FROM project_owner_execution_commands WHERE id=?').get(commandId) as DeliveryCommand | undefined
  if (!command) throw new Error('文本成果命令不存在')
  const frozen = readOwnerCommandFrozenSource(commandId).source
  if (frozen.textDeliveryVersion !== 1) return null
  if (frozen.executionKind !== 'controlled' || command.role !== 'executor' || !command.execution_id) throw new Error('文本成果只允许准确的非代码Executor命令')
  const execution = store.getAgentExecution(command.execution_id)
  if (!execution || execution.ownerCommandId !== commandId || execution.projectId !== command.project_id || execution.entityType !== 'task' || execution.entityId !== command.source_task_id || !execution.sessionId) throw new Error('文本成果执行归属无法核验')
  return { command, frozen, execution }
}
function directory(projectId: string, create: boolean): string | null {
  let current = getProjectsDir()
  for (const name of ['owner-deliveries', sha(projectId)]) {
    current = join(current, name)
    if (create) { mkdirSync(current, { recursive: true, mode: 0o700 }); syncDirectory(dirname(current)) }
    try { const stat = lstatSync(current); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('文本成果目录不是可信本机目录') }
    catch (error) { if (!create && (error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
  }
  return current
}
/** 仅本机证据服务/测试使用，模型与Renderer均不接收本地路径。 */
export function ownerTextDeliveryFile(projectId: string, executionId: string): string | null {
  const root = directory(projectId, false)
  return root ? join(root, `${sha(executionId)}.json`) : null
}
function readFile(path: string): OwnerTextDelivery | null {
  let fd: number | undefined
  try {
    if (lstatSync(path).isSymbolicLink()) throw new Error('文本成果文件不能是符号链接')
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE_BYTES) throw new Error('文本成果文件类型或大小无效')
    const value = JSON.parse(readFileSync(fd, 'utf8')) as OwnerTextDelivery
    const { integrityHash, ...body } = value
    const fields = ['schemaVersion', 'projectId', 'grantId', 'commandId', 'executionId', 'sessionId', 'taskId', 'stepLinkId', 'sourceHash', 'planRevision', 'reworkOrdinal', 'messageId', 'content', 'contentSha256', 'byteLength', 'capturedAt', 'integrityHash']
    if (Object.keys(value).length !== fields.length || Object.keys(value).some(key => !fields.includes(key)) || value.schemaVersion !== 1 || ownerExecutionHash(body) !== integrityHash || typeof value.content !== 'string' || !value.content.trim() || Buffer.byteLength(value.content, 'utf8') !== value.byteLength || value.byteLength > OWNER_TEXT_DELIVERY_MAX_BYTES || sha(value.content) !== value.contentSha256 || typeof value.messageId !== 'string' || !value.messageId || !Number.isSafeInteger(value.capturedAt) || value.capturedAt < 1) throw new Error('文本成果内容或完整性无效')
    return value
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
  finally { if (fd !== undefined) closeSync(fd) }
}
function assertBinding(value: OwnerTextDelivery, current: NonNullable<ReturnType<typeof source>>): void {
  const { command, frozen, execution } = current
  if (value.projectId !== command.project_id || value.grantId !== command.grant_id || value.commandId !== command.id || value.executionId !== execution.id || value.sessionId !== execution.sessionId || value.taskId !== command.source_task_id || value.stepLinkId !== command.source_step_link_id || value.sourceHash !== command.source_hash || value.planRevision !== frozen.planRevision || value.reworkOrdinal !== command.rework_ordinal) throw new Error('文本成果与准确执行版本不匹配')
}
/** 调用方先捕获原文，随后提交执行终态；中途失败的副本保留，但不作为完成成果。 */
export function captureOwnerTextDelivery(commandId: string, executionId: string, message: { id: string; content: string }, capturedAt = Date.now()): OwnerTextDelivery | null {
  const current = source(commandId)
  if (!current) return null
  const { command, frozen, execution } = current
  if (execution.id !== executionId || execution.status !== 'running' || command.state !== 'running' || typeof message.content !== 'string' || !message.content.trim() || !message.id || !Number.isSafeInteger(capturedAt) || capturedAt < 1) throw new Error('文本成果捕获来源或运行状态无效')
  const byteLength = Buffer.byteLength(message.content, 'utf8')
  if (byteLength > OWNER_TEXT_DELIVERY_MAX_BYTES) throw new Error('完整文本成果超出64KiB审阅上限，已拒绝截断后评审')
  const body = { schemaVersion: 1 as const, projectId: command.project_id, grantId: command.grant_id, commandId, executionId, sessionId: execution.sessionId, taskId: command.source_task_id, stepLinkId: command.source_step_link_id, sourceHash: command.source_hash, planRevision: frozen.planRevision, reworkOrdinal: command.rework_ordinal, messageId: message.id, content: message.content, contentSha256: sha(message.content), byteLength, capturedAt }
  const value: OwnerTextDelivery = { ...body, integrityHash: ownerExecutionHash(body) }
  const path = join(directory(command.project_id, true)!, `${sha(executionId)}.json`)
  let fd: number
  try { fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    const existing = readFile(path)
    if (!existing) throw new Error('文本成果已存在但无法读取，保留原件核查')
    assertBinding(existing, current)
    if (existing.messageId !== message.id || existing.content !== message.content) throw new Error('文本成果已捕获不同内容，拒绝覆盖')
    return existing
  }
  try { writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd) } finally { closeSync(fd) }
  syncDirectory(dirname(path))
  return value
}
export function readOwnerTextDelivery(commandId: string, requireKnownSettlement = false): OwnerTextDelivery | null {
  const current = source(commandId)
  if (!current) return null
  if (current.execution.status !== 'completed') return null
  if (requireKnownSettlement && (current.command.state !== 'settled' || current.command.actual_cost_micros === null)) throw new Error('文本成果费用/终态未核验，不能启动独立评审')
  const path = ownerTextDeliveryFile(current.command.project_id, current.execution.id)
  const value = path ? readFile(path) : null
  if (value) {
    assertBinding(value, current)
    if (!current.command.text_delivery_hash || value.contentSha256 !== current.command.text_delivery_hash) throw new Error('文本成果与命令冻结正文摘要不一致')
  }
  return value
}

/** 评审排队时的哈希是输入身份；后续文件变化不能由新的模型回执追认。 */
export function assertOwnerReviewerTextDelivery(commandId: string): OwnerTextDelivery | null {
  const frozen = readOwnerCommandFrozenSource(commandId).source
  if (frozen.textDeliveryVersion !== 1) return null
  const reviewer = store.getProjectDb().prepare("SELECT grant_id,source_task_id,source_step_link_id,rework_ordinal,text_delivery_hash FROM project_owner_execution_commands WHERE id=? AND role='reviewer'").get(commandId) as { grant_id: string; source_task_id: string; source_step_link_id: string; rework_ordinal: number; text_delivery_hash: string | null } | undefined
  if (!reviewer?.text_delivery_hash) throw new Error('评审缺少冻结的完整成果版本')
  const executors = store.getProjectDb().prepare("SELECT id FROM project_owner_execution_commands WHERE grant_id=? AND source_task_id=? AND source_step_link_id=? AND role='executor' AND rework_ordinal=?").all(reviewer.grant_id, reviewer.source_task_id, reviewer.source_step_link_id, reviewer.rework_ordinal) as { id: string }[]
  if (executors.length !== 1) throw new Error('评审对应的准确执行轮次不唯一')
  const artifact = readOwnerTextDelivery(executors[0]!.id, true)
  if (!artifact || artifact.contentSha256 !== reviewer.text_delivery_hash) throw new Error('评审所读完整成果已缺失或变化')
  return artifact
}

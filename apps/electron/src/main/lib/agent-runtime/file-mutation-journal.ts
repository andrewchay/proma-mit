/**
 * 文件变更账本：把「一次写文件」拆成意图与结算两条事件，崩溃后可对账。
 *
 * 解决的问题：Write / Edit 直接截断再写入，进程在写入中途退出时，文件可能半写、
 * 也可能什么都没变。事后没有人知道"哪个文件可能被动过"，只能靠猜。
 *
 * 边界（明确不做）：
 * - 不做跨文件原子性：多文件仍然逐个提交，没有事务语义；本账本只负责"事后能核对"。
 * - 不做回滚：结算失败不会自动恢复旧内容，只记录当时的摘要供人工判断。
 * - 不记录文件内容，只记录路径、工具、会话与 SHA-256。
 * - 账本写入失败不阻断业务写入（它是取证设施，不是门禁），但会打印警告：这类写入无法事后对账。
 */

import { createHash, randomUUID } from 'node:crypto'
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getConfigDir } from '../config-paths'

export type FileMutationStatus = 'ok' | 'error'

interface FileMutationEvent {
  type: 'intent' | 'settled' | 'reconciled'
  id: string
  sessionId: string
  tool: string
  path: string
  createdAt: string
  bootId: string
  /** intent：写入前摘要（`absent` 表示写入前文件不存在）。 */
  preHash?: string
  /** settled：写入后摘要（失败时可能缺失）。 */
  postHash?: string
  status?: FileMutationStatus
  message?: string
  /** reconciled：核对时观察到的实际摘要与结论。 */
  observedHash?: string
  verdict?: FileMutationVerdict
}

export type FileMutationVerdict = 'applied' | 'not_applied' | 'partially_written' | 'changed_by_others' | 'missing'

export interface FileMutationHandle {
  id: string
  sessionId: string
  tool: string
  path: string
  preHash: string
}

export interface UnsettledFileMutation {
  id: string
  sessionId: string
  tool: string
  path: string
  createdAt: string
  bootId: string
  preHash: string
  /** 本次进程是否就是写下这条意图的进程。 */
  sameBoot: boolean
}

const FILE_NAME = 'file-mutations.jsonl'
const ABSENT = 'absent'
const bootId = randomUUID()
const digest = (content: string | Buffer): string => createHash('sha256').update(content).digest('hex')
const filePath = (): string => join(getConfigDir(), FILE_NAME)

function hashFile(path: string): string {
  try {
    return digest(readFileSync(path))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ABSENT
    return 'unreadable'
  }
}

async function append(event: FileMutationEvent): Promise<void> {
  await mkdir(getConfigDir(), { recursive: true })
  await appendFile(filePath(), `${JSON.stringify(event)}\n`, 'utf8')
}

/** 读取全部事件；文件缺失返回空，损坏抛错（不能拿坏账本做对账依据）。 */
async function readEvents(): Promise<FileMutationEvent[]> {
  let text: string
  try {
    text = await readFile(filePath(), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  return text.split('\n').filter(line => line.trim()).map(line => {
    const event = JSON.parse(line) as FileMutationEvent
    if (!event || (event.type !== 'intent' && event.type !== 'settled' && event.type !== 'reconciled')
      || typeof event.id !== 'string' || typeof event.path !== 'string' || typeof event.sessionId !== 'string'
      || typeof event.createdAt !== 'string' || typeof event.bootId !== 'string') {
      throw new Error('文件变更账本损坏，不能据此判断文件状态')
    }
    return event
  })
}

/**
 * 记录写入意图（在真正改文件之前调用）。
 *
 * 返回 undefined 表示账本不可用：业务写入可以继续，但这次变更事后无法对账。
 */
export async function beginFileMutation(input: { sessionId: string; tool: string; path: string }): Promise<FileMutationHandle | undefined> {
  const preHash = hashFile(input.path)
  const handle: FileMutationHandle = { id: `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`, ...input, preHash }
  try {
    await append({ type: 'intent', ...handle, createdAt: new Date().toISOString(), bootId })
    return handle
  } catch (error) {
    console.warn('[文件账本] 写入意图记录失败，本次写入无法事后对账:', error)
    return undefined
  }
}

/** 记录结算：写入成功或失败都落一条，失败保留实际原因。 */
export async function settleFileMutation(handle: FileMutationHandle | undefined, status: FileMutationStatus, message?: string): Promise<void> {
  if (!handle) return
  try {
    await append({
      type: 'settled',
      id: handle.id,
      sessionId: handle.sessionId,
      tool: handle.tool,
      path: handle.path,
      createdAt: new Date().toISOString(),
      bootId,
      preHash: handle.preHash,
      postHash: hashFile(handle.path),
      status,
      ...(message ? { message } : {}),
    })
  } catch (error) {
    console.warn('[文件账本] 结算记录失败，本次变更将留在待对账列表:', error)
  }
}

/**
 * 列出「有意图但没有结算」的变更。
 *
 * 这些就是崩溃或强杀时可能半写的文件；sameBoot=false 表示来自上一次运行。
 */
export async function listUnsettledFileMutations(): Promise<UnsettledFileMutation[]> {
  const unsettled = new Map<string, UnsettledFileMutation>()
  for (const event of await readEvents()) {
    if (event.type === 'intent') {
      unsettled.set(event.id, {
        id: event.id,
        sessionId: event.sessionId,
        tool: event.tool,
        path: event.path,
        createdAt: event.createdAt,
        bootId: event.bootId,
        preHash: event.preHash ?? 'unreadable',
        sameBoot: event.bootId === bootId,
      })
      continue
    }
    if (event.type === 'settled' || event.type === 'reconciled') unsettled.delete(event.id)
  }
  return [...unsettled.values()].sort((left, right) => right.createdAt.localeCompare(left.createdAt))
}

/**
 * 用当前磁盘内容核对一条未结算变更，并写入核对结论。
 *
 * 结论只描述"现在看到什么"，不替用户决定要不要恢复。
 */
export async function reconcileFileMutation(input: { id: string; note?: string }): Promise<{ verdict: FileMutationVerdict; observedHash: string } | undefined> {
  const unsettled = (await listUnsettledFileMutations()).find(item => item.id === input.id)
  if (!unsettled) return undefined
  const observedHash = hashFile(unsettled.path)
  const exists = existsSync(unsettled.path)
  const verdict: FileMutationVerdict = !exists
    ? 'missing'
    : observedHash === unsettled.preHash
      ? 'not_applied'
      : unsettled.preHash === ABSENT
        ? 'applied'
        : 'changed_by_others'
  try {
    await append({
      type: 'reconciled',
      id: unsettled.id,
      sessionId: unsettled.sessionId,
      tool: unsettled.tool,
      path: unsettled.path,
      createdAt: new Date().toISOString(),
      bootId,
      preHash: unsettled.preHash,
      observedHash,
      verdict,
      ...(input.note ? { message: input.note } : {}),
    })
  } catch (error) {
    console.warn('[文件账本] 对账结论写入失败，记录仍在待对账列表:', error)
    return undefined
  }
  return { verdict, observedHash }
}

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
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs'
import { dirname, join, parse, resolve } from 'node:path'
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

export type FileMutationVerdict = 'unchanged' | 'changed_unknown' | 'missing' | 'unreadable'

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
const MAX_HASH_BYTES = 8 * 1024 * 1024
const filePath = (): string => join(getConfigDir(), FILE_NAME)

/** 普通路径校验；不能替代 openat 级的目录原子隔离。 */
function hasSafeParents(path: string): boolean {
  let current = dirname(resolve(path))
  const root = parse(current).root
  while (current !== root) {
    const stat = lstatSync(current)
    if (!stat.isDirectory() || stat.isSymbolicLink()) return false
    current = dirname(current)
  }
  return true
}

function hashFile(path: string): string {
  let fd: number | undefined
  let before: ReturnType<typeof lstatSync>
  try {
    if (!hasSafeParents(path)) return 'unreadable'
    before = lstatSync(path)
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? ABSENT : 'unreadable'
  }
  try {
    if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_HASH_BYTES) return 'unreadable'
    if (typeof constants.O_NOFOLLOW !== 'number' || typeof constants.O_NONBLOCK !== 'number') return 'unreadable'
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const opened = fstatSync(fd)
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size > MAX_HASH_BYTES) return 'unreadable'
    const hash = createHash('sha256'), buffer = Buffer.alloc(64 * 1024)
    let total = 0
    for (;;) {
      const bytes = readSync(fd, buffer, 0, Math.min(buffer.length, MAX_HASH_BYTES + 1 - total), null)
      if (!bytes) break
      total += bytes
      if (total > MAX_HASH_BYTES) return 'unreadable'
      hash.update(buffer.subarray(0, bytes))
    }
    const after = fstatSync(fd)
    if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs || !hasSafeParents(path)) return 'unreadable'
    return hash.digest('hex')
  } catch { return 'unreadable' } finally { if (fd !== undefined) closeSync(fd) }
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
 * 列出尚无成功结算的变更，失败和历史自动对账均保留待核对。
 *
 * 包括崩溃、强杀或写入失败时可能部分写入的文件；sameBoot=false 表示来自上一次运行。
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
    // 历史 reconciled 结论没有目标摘要或人工证据，重新列出以供核对。
    if (event.type === 'settled' && event.status === 'ok') unsettled.delete(event.id)
  }
  return [...unsettled.values()].sort((left, right) => right.createdAt.localeCompare(left.createdAt))
}

/**
 * 观察一条未结算变更的当前磁盘状态；保留记录供进一步核对。
 *
 * 结论只描述"现在看到什么"，不替用户决定要不要恢复。
 */
export async function reconcileFileMutation(input: { id: string; note?: string }): Promise<{ verdict: FileMutationVerdict; observedHash: string } | undefined> {
  const unsettled = (await listUnsettledFileMutations()).find(item => item.id === input.id)
  if (!unsettled) return undefined
  const observedHash = hashFile(unsettled.path)
  const verdict: FileMutationVerdict = observedHash === 'unreadable' || unsettled.preHash === 'unreadable'
    ? 'unreadable'
    : observedHash === unsettled.preHash ? 'unchanged'
      : observedHash === ABSENT ? 'missing' : 'changed_unknown'
  // 观察无法证明写入是否完成，也无法证明谁改了文件；保留未结算记录。
  return { verdict, observedHash }
}

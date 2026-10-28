/**
 * MCP stdio 服务端进程树回收。
 *
 * `@modelcontextprotocol/sdk` 的 StdioClientTransport.close() 只对**直接子进程**
 * 依次下发 SIGTERM/SIGKILL；服务端自己再派生的进程（例如 `npx` 拉起 `node`、
 * 包装脚本拉起真正的 server）会变成孤儿并继续运行。会话停止后这些进程仍持有
 * 凭据、网络连接或文件句柄，因此需要在 close() 之后按父进程树收口。
 *
 * 这里同样遵循"没确认就不算终止"：只有目标进程全部探测不到，才返回 confirmed；
 * 进程表不可用或仍有存活时返回 unavailable / unconfirmed。
 *
 * 顺序约束：**必须先在父进程存活时快照后代**，再关闭/杀父进程。父进程一死，
 * 子进程会被 reparent 到 pid 1，ppid 链随即断裂，事后枚举只能看到根自己
 * （宿主用例实测踩到过这一点，导致"已确认终止"却仍有 sleep 存活）。
 */

import { execFile } from 'node:child_process'

export interface ProcessRow {
  pid: number
  ppid: number
}

export interface ReapEvidence {
  rootPid: number
  /** 实际下发信号的进程（含 root 本身），按先深后浅顺序。 */
  targeted: number[]
  signals: { pid: number; signal: NodeJS.Signals }[]
  survivors: number[]
  /** confirmed：目标全部消失；unconfirmed：仍有存活；unavailable：拿不到进程表。 */
  status: 'confirmed' | 'unconfirmed' | 'unavailable'
}

export interface ReapOptions {
  /** 读取进程表；默认调用 /bin/ps。 */
  listProcesses?: () => Promise<ProcessRow[]>
  /** 判断进程是否存活；默认 kill(pid, 0)。 */
  isAlive?: (pid: number) => boolean
  /** 下发信号的实现；默认 process.kill。 */
  sendSignal?: (pid: number, signal: NodeJS.Signals) => void
  graceMs?: number
  killGraceMs?: number
  sleep?: (ms: number) => Promise<void>
}

/** 默认进程表读取：解析 `ps -A -o pid=,ppid=`。 */
export async function listProcessTable(): Promise<ProcessRow[]> {
  const stdout = await new Promise<string>((resolve, reject) => {
    execFile('/bin/ps', ['-A', '-o', 'pid=,ppid='], { maxBuffer: 8 * 1024 * 1024 }, (error, out) => {
      if (error) reject(error)
      else resolve(out)
    })
  })
  const rows: ProcessRow[] = []
  for (const line of stdout.split('\n')) {
    const [pid, ppid] = line.trim().split(/\s+/)
    const pidNum = Number(pid)
    const ppidNum = Number(ppid)
    if (Number.isFinite(pidNum) && Number.isFinite(ppidNum) && pidNum > 0) rows.push({ pid: pidNum, ppid: ppidNum })
  }
  return rows
}

const defaultIsAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

/** 按父指针收集 root 的整棵子树（不含 pid 1 与自身），先深后浅排序。 */
export function collectDescendants(table: ProcessRow[], rootPid: number): number[] {
  const childrenOf = new Map<number, number[]>()
  for (const row of table) {
    const list = childrenOf.get(row.ppid)
    if (list) list.push(row.pid)
    else childrenOf.set(row.ppid, [row.pid])
  }
  const order: number[] = []
  const seen = new Set<number>([rootPid])
  const visit = (pid: number): void => {
    for (const child of childrenOf.get(pid) ?? []) {
      // seen 同时防止进程表出现环（异常情况下 ppid 互指）。
      if (seen.has(child)) continue
      seen.add(child)
      visit(child)
      order.push(child)
    }
  }
  visit(rootPid)
  return order.filter((pid) => pid !== 1 && pid !== process.pid)
}

/**
 * 在父进程仍存活时快照其整棵子树；进程表不可用时返回 undefined（表示无法核验）。
 */
export async function snapshotDescendants(rootPid: number, options: ReapOptions = {}): Promise<number[] | undefined> {
  try {
    const table = await (options.listProcesses ?? listProcessTable)()
    return collectDescendants(table, rootPid)
  } catch {
    return undefined
  }
}

export interface TerminateOptions extends Omit<ReapOptions, 'listProcesses'> {
  /** 证据里记录的根进程。 */
  rootPid?: number
}

/**
 * 终止给定进程集合：SIGTERM 全部存活目标，宽限后仍存活的升级 SIGKILL，
 * 最后逐个探测确认，未能确认的进程写入 survivors。
 */
export async function terminateProcesses(pids: number[], options: TerminateOptions = {}): Promise<ReapEvidence> {
  const isAlive = options.isAlive ?? defaultIsAlive
  const sendSignal = options.sendSignal ?? ((pid: number, signal: NodeJS.Signals) => {
    try {
      process.kill(pid, signal)
    } catch {
      // 已退出或无权：留待后续探测判定。
    }
  })
  const graceMs = options.graceMs ?? 1000
  const killGraceMs = options.killGraceMs ?? 800
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const targeted = [...new Set(pids)].filter((pid) => pid > 1 && pid !== process.pid)

  const signals: ReapEvidence['signals'] = []
  const signal = (pid: number, name: NodeJS.Signals) => {
    signals.push({ pid, signal: name })
    sendSignal(pid, name)
  }
  const aliveTargets = (): number[] => targeted.filter((pid) => isAlive(pid))

  for (const pid of aliveTargets()) signal(pid, 'SIGTERM')
  await sleep(graceMs)
  for (const pid of aliveTargets()) signal(pid, 'SIGKILL')
  if (killGraceMs > 0) await sleep(killGraceMs)

  const survivors = aliveTargets()
  return {
    rootPid: options.rootPid ?? pids[pids.length - 1] ?? 0,
    targeted,
    signals,
    survivors,
    status: survivors.length === 0 ? 'confirmed' : 'unconfirmed',
  }
}

/**
 * 快照后终止 root 的整棵进程树（root 仍存活时可直接用）。
 * 顺序是快照 → 终止：先快照才能覆盖随后被 reparent 的后代。
 */
export async function reapProcessTree(rootPid: number, options: ReapOptions = {}): Promise<ReapEvidence> {
  const descendants = await snapshotDescendants(rootPid, options)
  if (descendants === undefined) {
    return { rootPid, targeted: [], signals: [], survivors: [], status: 'unavailable' }
  }
  // 后代先杀、root 最后，避免父进程先死导致子进程 reparent 后难以枚举。
  return terminateProcesses([...descendants, rootPid], { ...options, rootPid })
}

/** 从传输层读取 stdio 子进程 pid（非 stdio 或尚未启动时为 null）。 */
export function readTransportPid(transport: unknown): number | null {
  const pid = (transport as { pid?: unknown } | undefined)?.pid
  return typeof pid === 'number' && Number.isFinite(pid) && pid > 0 ? pid : null
}

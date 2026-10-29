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
 *
 * 身份约束（PID 复用）：快照与发信号之间隔着 `close()` 与宽限期，期间目标可能
 * 已经退出，操作系统把同一个 pid 分配给一个无关的新进程。只凭 pid 发信号会误伤
 * 无关进程。因此在快照时记录每个目标的启动时间（`ps -o lstart=`），发信号前重新
 * 读取进程表比对：启动时间不同即判定 PID 已被复用，**不发信号**；缺少启动时间
 * 无法比对时标为 unknown，同样不发信号——宁可留下可观测的未回收进程，也不误杀。
 */

import { execFile } from 'node:child_process'

export interface ProcessRow {
  pid: number
  ppid: number
  /** 进程启动时间标识（`ps -o lstart=` 原文）；缺失表示该平台或该行无法验证身份。 */
  startedAt?: string
}

export interface ReapEvidence {
  rootPid: number
  /** 实际下发信号的进程（含 root 本身），按先深后浅顺序。 */
  targeted: number[]
  signals: { pid: number; signal: NodeJS.Signals }[]
  survivors: number[]
  /** 因 PID 已被复用而跳过的进程：它们不是快照时的目标，已自行退出。 */
  skippedReused: number[]
  /** 身份无法验证（缺启动时间或进程表读取失败）而**未发信号**的进程。 */
  unverified: number[]
  /**
   * confirmed：目标全部消失；unconfirmed：仍有存活；unavailable：拿不到进程表；
   * unknown：身份无法确认，未下发信号。
   */
  status: 'confirmed' | 'unconfirmed' | 'unavailable' | 'unknown'
  /** 本次是否真的做了身份比对。 */
  identity: 'verified' | 'unverified'
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

/** 身份比对结论。 */
export type IdentityCheck = 'match' | 'gone' | 'reused' | 'unverifiable'

function runPs(args: string[]): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    execFile('/bin/ps', args, { maxBuffer: 8 * 1024 * 1024 }, (error, out) => {
      if (error) reject(error)
      else resolve(out)
    })
  })
}

/** 解析 `pid=,ppid=` 或 `pid=,ppid=,lstart=` 输出；lstart 含空格，按前两段切分。 */
export function parseProcessTable(stdout: string): ProcessRow[] {
  const rows: ProcessRow[] = []
  for (const line of stdout.split('\n')) {
    const parts = line.trim().split(/\s+/)
    if (parts.length < 2) continue
    const pidNum = Number(parts[0])
    const ppidNum = Number(parts[1])
    if (!Number.isFinite(pidNum) || !Number.isFinite(ppidNum) || pidNum <= 0) continue
    const startedAt = parts.slice(2).join(' ').trim()
    rows.push(startedAt ? { pid: pidNum, ppid: ppidNum, startedAt } : { pid: pidNum, ppid: ppidNum })
  }
  return rows
}

/**
 * 默认进程表读取：优先带启动时间。
 *
 * 部分 ps 实现不支持 `lstart`，此时退回只有 pid/ppid 的表——调用方会把目标判为
 * 身份不可验证并拒绝发信号，而不是在没有身份的情况下动手。
 */
export async function listProcessTable(): Promise<ProcessRow[]> {
  try {
    return parseProcessTable(await runPs(['-A', '-o', 'pid=,ppid=,lstart=']))
  } catch {
    return parseProcessTable(await runPs(['-A', '-o', 'pid=,ppid=']))
  }
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

export interface ProcessTreeSnapshot {
  descendants: number[]
  /** pid → 启动时间标识；值为 undefined 表示该进程无法验证身份。 */
  identities: Record<number, string | undefined>
}

function identityOf(table: ProcessRow[], pid: number): string | undefined {
  return table.find((row) => row.pid === pid)?.startedAt
}

/**
 * 快照 root 子树，同时记录每个目标的启动时间标识。
 *
 * 发信号前用这些标识重新比对，避免在 PID 复用后误伤无关进程。
 */
export async function snapshotProcessTree(
  rootPid: number,
  options: ReapOptions = {},
): Promise<ProcessTreeSnapshot | undefined> {
  try {
    const table = await (options.listProcesses ?? listProcessTable)()
    const descendants = collectDescendants(table, rootPid)
    const identities: Record<number, string | undefined> = {}
    for (const pid of [...descendants, rootPid]) identities[pid] = identityOf(table, pid)
    return { descendants, identities }
  } catch {
    return undefined
  }
}

/** 比对进程身份：只有启动时间一致才允许发信号。 */
export function verifyIdentity(table: ProcessRow[], pid: number, expected: string | undefined): IdentityCheck {
  const row = table.find((item) => item.pid === pid)
  if (!row) return 'gone'
  if (!expected || !row.startedAt) return 'unverifiable'
  return row.startedAt === expected ? 'match' : 'reused'
}

export interface TerminateOptions extends ReapOptions {
  /** 证据里记录的根进程。 */
  rootPid?: number
  /**
   * 快照时记录的启动时间标识。提供后启用身份比对：
   * 比对不上的进程不发信号，缺标识的进程标 unknown 也不发信号。
   */
  identities?: Record<number, string | undefined>
}

const emptyEvidence = (rootPid: number, overrides: Partial<ReapEvidence>): ReapEvidence => ({
  rootPid,
  targeted: [],
  signals: [],
  survivors: [],
  skippedReused: [],
  unverified: [],
  status: 'unavailable',
  identity: 'unverified',
  ...overrides,
})

/**
 * 终止给定进程集合：SIGTERM 全部存活目标，宽限后仍存活的升级 SIGKILL，
 * 最后逐个探测确认，未能确认的进程写入 survivors。
 *
 * 提供 `identities` 时先做身份比对，未通过的目标一律不发信号。
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
  const rootPid = options.rootPid ?? pids[pids.length - 1] ?? 0
  const targeted = [...new Set(pids)].filter((pid) => pid > 1 && pid !== process.pid)

  const skippedReused: number[] = []
  const unverified: number[] = []
  let allowed = targeted

  if (options.identities) {
    let table: ProcessRow[] | undefined
    try {
      table = await (options.listProcesses ?? listProcessTable)()
    } catch {
      // 拿不到进程表就无法确认身份：不发信号，交给调用方按 unavailable 记录。
      return emptyEvidence(rootPid, {
        targeted,
        unverified: [...targeted],
        status: 'unavailable',
        identity: 'unverified',
      })
    }
    allowed = []
    for (const pid of targeted) {
      const check = verifyIdentity(table, pid, options.identities[pid])
      if (check === 'match') allowed.push(pid)
      else if (check === 'reused') skippedReused.push(pid)
      else if (check === 'unverifiable') unverified.push(pid)
      // 'gone'：快照后已自行退出，无需发信号也不计 survivor。
    }
  }

  const signals: ReapEvidence['signals'] = []
  const signal = (pid: number, name: NodeJS.Signals) => {
    signals.push({ pid, signal: name })
    sendSignal(pid, name)
  }
  const aliveTargets = (): number[] => allowed.filter((pid) => isAlive(pid))

  for (const pid of aliveTargets()) signal(pid, 'SIGTERM')
  await sleep(graceMs)
  for (const pid of aliveTargets()) signal(pid, 'SIGKILL')
  if (killGraceMs > 0) await sleep(killGraceMs)

  const survivors = aliveTargets()
  const status: ReapEvidence['status'] = survivors.length > 0
    ? 'unconfirmed'
    : unverified.length > 0 ? 'unknown' : 'confirmed'
  return {
    rootPid,
    targeted,
    signals,
    survivors,
    skippedReused,
    unverified,
    status,
    identity: options.identities ? 'verified' : 'unverified',
  }
}

/**
 * 快照后终止 root 的整棵进程树（root 仍存活时可直接用）。
 *
 * 顺序是 快照 → 补快照 → 终止：先快照才能覆盖随后被 reparent 的后代；
 * 发信号前再读一次进程表，把"快照之后才派生"的进程补进目标集合。
 */
export async function reapProcessTree(rootPid: number, options: ReapOptions = {}): Promise<ReapEvidence> {
  const listProcesses = options.listProcesses ?? listProcessTable
  const snapshot = await snapshotProcessTree(rootPid, { ...options, listProcesses })
  if (!snapshot) return emptyEvidence(rootPid, { status: 'unavailable', identity: 'unverified' })

  // 补快照：捕获首轮枚举之后被 root 新派生的进程。失败就沿用首轮结果。
  let descendants = snapshot.descendants
  try {
    const table = await listProcesses()
    const merged = [...new Set([...descendants, ...collectDescendants(table, rootPid)])]
    const identities = { ...snapshot.identities }
    for (const pid of merged) identities[pid] ??= identityOf(table, pid)
    descendants = merged
    snapshot.identities = identities
  } catch {
    // 二次枚举失败不影响首轮快照的收口能力，身份标识仍以首轮为准。
  }

  // 后代先杀、root 最后，避免父进程先死导致子进程 reparent 后难以枚举。
  return terminateProcesses([...descendants, rootPid], {
    ...options,
    rootPid,
    listProcesses,
    identities: snapshot.identities,
  })
}

/** 从传输层读取 stdio 子进程 pid（非 stdio 或尚未启动时为 null）。 */
export function readTransportPid(transport: unknown): number | null {
  const pid = (transport as { pid?: unknown } | undefined)?.pid
  return typeof pid === 'number' && Number.isFinite(pid) && pid > 0 ? pid : null
}

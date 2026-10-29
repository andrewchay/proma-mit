import { describe, expect, test, spyOn } from 'bun:test'
import { spawn } from 'node:child_process'
import {
  collectDescendants,
  listProcessTable,
  parseProcessTable,
  reapProcessTree,
  readTransportPid,
  snapshotProcessTree,
  terminateProcesses,
  verifyIdentity,
} from './mcp-process-reaper'

type FakeRow = { pid: number; ppid: number; startedAt?: string }

/**
 * 造一个可控的假进程环境：进程表 + 存活集合 + 记录信号。
 *
 * 给每行补一个稳定的启动时间标识——真实进程表带 `lstart`，缺了会被判为
 * 身份不可验证并拒绝发信号。
 */
const fakeEnv = (table: FakeRow[], alive: number[], options: { withIdentity?: boolean } = {}) => {
  const rows = options.withIdentity === false
    ? table
    : table.map((row) => (row.startedAt ? row : { ...row, startedAt: `started-${row.pid}` }))
  const living = new Set(alive)
  const signals: { pid: number; signal: string }[] = []
  return {
    living,
    signals,
    listProcesses: async () => rows,
    isAlive: (pid: number) => living.has(pid),
    sendSignal: (pid: number, signal: NodeJS.Signals) => {
      signals.push({ pid, signal })
      // 模拟信号生效：SIGKILL 必杀，SIGTERM 只杀"听话"的进程。
      if (signal === 'SIGKILL') living.delete(pid)
      else if (!NON_COOPERATIVE.has(pid)) living.delete(pid)
    },
  }
}

/** 忽略 SIGTERM 的进程 id 集合（每个用例单独设置）。 */
const NON_COOPERATIVE = new Set<number>()

const sleep = async () => {}

describe('collectDescendants（父指针树）', () => {
  const table = [
    { pid: 1, ppid: 0 },
    { pid: 100, ppid: 1 },
    { pid: 101, ppid: 100 },
    { pid: 102, ppid: 101 },
    { pid: 200, ppid: 1 },
  ]

  test('Given 三层进程树 When 收集 Then 只含后代且先深后浅', () => {
    expect(collectDescendants(table, 100)).toEqual([102, 101])
  })

  test('Given 无关进程 When 收集 Then 不包含', () => {
    expect(collectDescendants(table, 100)).not.toContain(200)
  })

  test('Given 进程表出现环 When 收集 Then 不死循环', () => {
    const cyclic = [
      { pid: 10, ppid: 11 },
      { pid: 11, ppid: 10 },
      { pid: 12, ppid: 13 },
    ]
    expect(collectDescendants(cyclic, 10)).toEqual([11])
  })

  test('Given 根是 pid 1 When 收集 Then 不把 1 或自身放进目标', () => {
    const result = collectDescendants(table, 1)
    expect(result).not.toContain(1)
    expect(result).not.toContain(process.pid)
  })
})

describe('reapProcessTree（确定性）', () => {
  const table = [
    { pid: 100, ppid: 1 },
    { pid: 101, ppid: 100 },
    { pid: 102, ppid: 101 },
    { pid: 900, ppid: 1 },
  ]

  test('Given 后代都响应 SIGTERM When 回收 Then 只发 SIGTERM 且确认终止', async () => {
    const env = fakeEnv(table, [100, 101, 102])
    const evidence = await reapProcessTree(100, { ...env, sleep })
    expect(evidence.status).toBe('confirmed')
    expect(evidence.survivors).toEqual([])
    expect(evidence.targeted.sort()).toEqual([100, 101, 102])
    expect(evidence.signals.every((item) => item.signal === 'SIGTERM')).toBe(true)
    // 无关进程既不在目标里也不收到信号。
    expect(evidence.signals.some((item) => item.pid === 900)).toBe(false)
  })

  test('Given 后代忽略 SIGTERM When 回收 Then 升级 SIGKILL 并确认终止', async () => {
    NON_COOPERATIVE.add(102)
    try {
      const env = fakeEnv(table, [100, 101, 102])
      const evidence = await reapProcessTree(100, { ...env, sleep })
      expect(evidence.status).toBe('confirmed')
      const killSignals = evidence.signals.filter((item) => item.signal === 'SIGKILL')
      expect(killSignals.map((item) => item.pid)).toEqual([102])
      // 已退出的进程不应再收到 SIGKILL。
      expect(killSignals.some((item) => item.pid === 101)).toBe(false)
    } finally {
      NON_COOPERATIVE.delete(102)
    }
  })

  test('Given 进程表不可用 When 回收 Then 标 unavailable 且不发信号', async () => {
    const evidence = await reapProcessTree(100, {
      listProcesses: async () => {
        throw new Error('ps 被拒绝')
      },
      sleep,
    })
    expect(evidence.status).toBe('unavailable')
    expect(evidence.signals).toEqual([])
  })

  test('Given 目标一直存活 When 回收 Then 标 unconfirmed 并列出 survivor', async () => {
    const evidence = await reapProcessTree(100, {
      listProcesses: async () => table.map((row) => ({ ...row, startedAt: `started-${row.pid}` })),
      isAlive: () => true,
      sendSignal: () => {},
      sleep,
    })
    expect(evidence.status).toBe('unconfirmed')
    expect(evidence.survivors.sort()).toEqual([100, 101, 102])
  })

  test('Given root 已自行退出 When 回收 Then 仍收口后代', async () => {
    const env = fakeEnv(table, [101, 102])
    const evidence = await reapProcessTree(100, { ...env, sleep })
    expect(evidence.status).toBe('confirmed')
    expect(evidence.signals.map((item) => item.pid).sort()).toEqual([101, 102])
  })
})

describe('readTransportPid', () => {
  test('Given 传输层有 pid When 读取 Then 返回数字', () => {
    expect(readTransportPid({ pid: 4321 })).toBe(4321)
  })

  test('Given 非 stdio 或未启动 When 读取 Then 返回 null', () => {
    expect(readTransportPid({})).toBeNull()
    expect(readTransportPid(undefined)).toBeNull()
    expect(readTransportPid({ pid: 0 })).toBeNull()
  })
})

describe('reapProcessTree（真实进程树，需要 ps）', () => {
  // 该用例依赖 /bin/ps：受限会话内 posix_spawn('/bin/ps') 被拒，仅在宿主执行。
  const psAvailable = (() => {
    try {
      const out = require('node:child_process').execFileSync('/bin/ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8' })
      return out.trim().length > 0
    } catch {
      return false
    }
  })()

  test.skipIf(!psAvailable)('Given 真实 sh 派生的 sleep When 先杀 sh 再回收 Then sleep 也被清理', async () => {
    const child = spawn('/bin/sh', ['-c', 'sleep 20 & wait'], { stdio: 'ignore' })
    await new Promise((resolve) => setTimeout(resolve, 250))
    const tableBefore = await listProcessTable()
    const descendants = collectDescendants(tableBefore, child.pid ?? 0)
    expect(descendants.length).toBeGreaterThan(0)
    // 真实 ps 的 lstart 必须能读到，否则身份校验会让回收退化成 unknown。
    const snapshot = await snapshotProcessTree(child.pid ?? 0)
    expect(snapshot?.identities[child.pid ?? 0]).toBeTruthy()

    // 模拟 SDK close() 只杀直接子进程：先杀掉 sh 让 sleep 成为孤儿。
    // 关键在于必须在杀父进程**之前**快照后代，否则 ppid 链断裂后再枚举找不到 sleep。
    process.kill(child.pid ?? 0, 'SIGKILL')
    await new Promise((resolve) => setTimeout(resolve, 250))

    const evidence = await terminateProcesses([...descendants, child.pid ?? 0], {
      rootPid: child.pid ?? 0,
      identities: snapshot?.identities,
    })
    expect(evidence.status).toBe('confirmed')
    expect(evidence.survivors).toEqual([])
    for (const pid of descendants) {
      expect(() => process.kill(pid, 0)).toThrow()
    }
  }, 20_000)
})

describe('McpClientManager.disconnect 接线', () => {
  test('Given stdio 服务端 When 断开 Then 记录进程树回收证据', async () => {
    const { McpClientManager } = await import('./mcp-client')
    const manager = new McpClientManager({}, process.cwd())
    let closed = false
    // 直接放入受控服务端：只验证断开流程会读取 pid 并回收进程树。
    ;(manager as unknown as { servers: unknown[] }).servers = [
      {
        name: 'demo',
        client: { close: async () => { closed = true } },
        transport: { pid: 999_999 },
      },
    ]
    const kill = spyOn(process, 'kill')
    try { await manager.disconnect() } finally { kill.mockRestore() }
    expect(kill).not.toHaveBeenCalled()
    expect(closed).toBe(true)
    const evidence = manager.getReapEvidence()
    expect(evidence.length).toBe(1)
    // 事后无法可靠证明全部后代退出，不能标记为 confirmed。
    expect(['unavailable', 'unknown']).toContain(evidence[0]?.status ?? '')
    expect(evidence[0]?.signals).toEqual([])
    expect(evidence[0]?.rootPid).toBe(999_999)
  })
})

describe('进程身份校验（PID 复用防护）', () => {
  const rows: FakeRow[] = [
    { pid: 100, ppid: 1, startedAt: 'Thu Oct 29 09:00:00 2026' },
    { pid: 101, ppid: 100, startedAt: 'Thu Oct 29 09:00:01 2026' },
    { pid: 102, ppid: 101, startedAt: 'Thu Oct 29 09:00:02 2026' },
  ]

  test('Given 启动时间一致 When 比对 Then match', () => {
    expect(verifyIdentity(rows, 101, 'Thu Oct 29 09:00:01 2026')).toBe('match')
  })

  test('Given 进程已消失 When 比对 Then gone', () => {
    expect(verifyIdentity(rows, 999, 'Thu Oct 29 09:00:01 2026')).toBe('gone')
  })

  test('Given 同一 pid 换了启动时间 When 比对 Then 判为复用', () => {
    expect(verifyIdentity(rows, 101, 'Thu Oct 29 10:30:00 2026')).toBe('reused')
  })

  test('Given 任一侧缺启动时间 When 比对 Then 无法验证', () => {
    expect(verifyIdentity(rows, 101, undefined)).toBe('unverifiable')
    expect(verifyIdentity([{ pid: 101, ppid: 100 }], 101, 'Thu Oct 29 09:00:01 2026')).toBe('unverifiable')
  })

  test('Given SIGTERM 后 PID 被复用 When 升级 SIGKILL Then 不给新进程发信号', async () => {
    let reads = 0
    const signals: string[] = []
    const evidence = await terminateProcesses([101], {
      identities: { 101: 'original' },
      listProcesses: async () => [{ pid: 101, ppid: 1, startedAt: reads++ === 0 ? 'original' : 'replacement' }],
      isAlive: () => true,
      sendSignal: (_pid, signal) => { signals.push(signal) },
      sleep: async () => {},
    })
    expect(signals).toEqual(['SIGTERM'])
    expect(evidence.skippedReused).toContain(101)
  })

  test('Given PID 已被复用 When 终止 Then 不发信号并记录跳过', async () => {
    // 快照后 102 退出，pid 被无关进程占用：启动时间不同。
    const replaced = rows.map((row) => (row.pid === 102 ? { ...row, startedAt: 'Thu Oct 29 10:30:00 2026' } : row))
    const env = fakeEnv(replaced, [100, 101, 102])
    const evidence = await terminateProcesses([102, 101, 100], {
      rootPid: 100,
      identities: { 100: 'Thu Oct 29 09:00:00 2026', 101: 'Thu Oct 29 09:00:01 2026', 102: 'Thu Oct 29 09:00:02 2026' },
      ...env,
      sleep,
    })
    expect(evidence.skippedReused).toEqual([102])
    expect(evidence.signals.some((item) => item.pid === 102)).toBe(false)
    expect(evidence.status).toBe('confirmed')
    expect(evidence.identity).toBe('verified')
  })

  test('Given 缺启动时间 When 终止 Then 不发信号并标 unknown', async () => {
    const blind = rows.map(({ pid, ppid }) => ({ pid, ppid }))
    // 显式关掉身份补全：模拟 ps 不支持 lstart 的真实降级路径。
    const env = fakeEnv(blind, [100, 101, 102], { withIdentity: false })
    const evidence = await terminateProcesses([102, 101, 100], {
      rootPid: 100,
      identities: { 100: 'a', 101: 'b', 102: 'c' },
      ...env,
      sleep,
    })
    expect(evidence.status).toBe('unknown')
    expect(evidence.signals).toEqual([])
    expect(evidence.unverified.sort()).toEqual([100, 101, 102])
  })

  test('Given 发信号前进程表读不到 When 终止 Then 不发信号且标 unavailable', async () => {
    const living = new Set([100, 101])
    const signals: { pid: number; signal: string }[] = []
    const evidence = await terminateProcesses([101, 100], {
      rootPid: 100,
      identities: { 100: 'a', 101: 'b' },
      listProcesses: async () => {
        throw new Error('ps 被拒绝')
      },
      isAlive: (pid) => living.has(pid),
      sendSignal: (pid, signal) => signals.push({ pid, signal }),
      sleep,
    })
    expect(evidence.status).toBe('unavailable')
    expect(evidence.signals).toEqual([])
    expect(signals).toEqual([])
  })

  test('Given 后代被 reparent 到 pid 1 When 回收 Then 仍按快照身份终止', async () => {
    // 首轮：101 挂在 100 下；父进程被 close() 杀掉后 101 重挂到 1。
    let call = 0
    const tables: FakeRow[][] = [
      [
        { pid: 100, ppid: 1, startedAt: 't100' },
        { pid: 101, ppid: 100, startedAt: 't101' },
      ],
      [
        { pid: 101, ppid: 1, startedAt: 't101' },
        { pid: 102, ppid: 1, startedAt: 't102' },
      ],
      [
        { pid: 101, ppid: 1, startedAt: 't101' },
        { pid: 102, ppid: 1, startedAt: 't102' },
      ],
    ]
    const living = new Set([101])
    const signals: { pid: number; signal: string }[] = []
    const evidence = await reapProcessTree(100, {
      listProcesses: async () => tables[Math.min(call++, tables.length - 1)] ?? [],
      isAlive: (pid) => living.has(pid),
      sendSignal: (pid, signal) => {
        signals.push({ pid, signal })
        living.delete(pid)
      },
      sleep,
    })
    // 100 已消失（gone，不发信号），101 按快照身份匹配后被终止；未在快照里的 102 不受影响。
    expect(evidence.status).toBe('confirmed')
    expect(signals).toEqual([{ pid: 101, signal: 'SIGTERM' }])
    expect(evidence.signals.some((item) => item.pid === 102)).toBe(false)
  })

  test('Given 快照之后又派生子进程 When 回收 Then 补快照把它纳入目标', async () => {
    let call = 0
    const first: FakeRow[] = [{ pid: 100, ppid: 1, startedAt: 't100' }]
    const second: FakeRow[] = [
      { pid: 100, ppid: 1, startedAt: 't100' },
      { pid: 103, ppid: 100, startedAt: 't103' },
    ]
    const living = new Set([100, 103])
    const signals: { pid: number; signal: string }[] = []
    const evidence = await reapProcessTree(100, {
      listProcesses: async () => (call++ === 0 ? first : second),
      isAlive: (pid) => living.has(pid),
      sendSignal: (pid, signal) => {
        signals.push({ pid, signal })
        living.delete(pid)
      },
      sleep,
    })
    expect(evidence.targeted.sort()).toEqual([100, 103])
    expect(evidence.status).toBe('confirmed')
    expect(signals.map((item) => item.pid).sort()).toEqual([100, 103])
  })
})

describe('parseProcessTable', () => {
  test('Given 带 lstart 的 ps 输出 When 解析 Then 保留含空格的启动时间', () => {
    const rows = parseProcessTable('  100     1 Thu Oct 29 09:00:00 2026\n  101   100 Thu Oct 29 09:00:01 2026\n')
    expect(rows).toEqual([
      { pid: 100, ppid: 1, startedAt: 'Thu Oct 29 09:00:00 2026' },
      { pid: 101, ppid: 100, startedAt: 'Thu Oct 29 09:00:01 2026' },
    ])
  })

  test('Given 只有 pid 与 ppid When 解析 Then 不带启动时间', () => {
    expect(parseProcessTable('  100     1\n')).toEqual([{ pid: 100, ppid: 1 }])
  })

  test('Given 异常行 When 解析 Then 跳过', () => {
    expect(parseProcessTable('\n耗时 3.2s\n  0     0\n')).toEqual([])
  })
})

import { describe, expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import { collectDescendants, listProcessTable, reapProcessTree, readTransportPid, terminateProcesses } from './mcp-process-reaper'

/** 造一个可控的假进程环境：进程表 + 存活集合 + 记录信号。 */
const fakeEnv = (table: Array<{ pid: number; ppid: number }>, alive: number[]) => {
  const living = new Set(alive)
  const signals: { pid: number; signal: string }[] = []
  return {
    living,
    signals,
    listProcesses: async () => table,
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
      listProcesses: async () => table,
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

    // 模拟 SDK close() 只杀直接子进程：先杀掉 sh 让 sleep 成为孤儿。
    // 关键在于必须在杀父进程**之前**快照后代，否则 ppid 链断裂后再枚举找不到 sleep。
    process.kill(child.pid ?? 0, 'SIGKILL')
    await new Promise((resolve) => setTimeout(resolve, 250))

    const evidence = await terminateProcesses([...descendants, child.pid ?? 0], { rootPid: child.pid ?? 0 })
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
    await manager.disconnect()
    expect(closed).toBe(true)
    const evidence = manager.getReapEvidence()
    expect(evidence.length).toBe(1)
    // 受限会话拿不到进程表 → unavailable；宿主上该 pid 不存在 → confirmed。
    expect(['unavailable', 'confirmed']).toContain(evidence[0]?.status ?? '')
    expect(evidence[0]?.rootPid).toBe(999_999)
  })
})

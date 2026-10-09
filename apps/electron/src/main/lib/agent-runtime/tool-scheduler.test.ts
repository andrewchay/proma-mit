import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolContext } from './types'
import { bindCoreToolEffects } from './tool-effects'
import { createReadToolDefinition, executeReadTool } from './tool-impls/read-tool'
import { createWriteToolDefinition, executeWriteTool } from './tool-impls/write-tool'
import { planLockSpec, ToolScheduler, type ScheduledCall } from './tool-scheduler'

const root = mkdtempSync(join(tmpdir(), 'gravitas-scheduler-'))
const cwd = join(root, 'work')
mkdirSync(cwd)
writeFileSync(join(cwd, 'a.txt'), 'a')
writeFileSync(join(cwd, 'b.txt'), 'b')
const ctx: ToolContext = { cwd, sessionId: 'fixture' }
const read = bindCoreToolEffects({ ...createReadToolDefinition(), execute: executeReadTool })
const write = bindCoreToolEffects({ ...createWriteToolDefinition(), execute: executeWriteTool })
afterAll(() => rmSync(root, { recursive: true, force: true }))

function call(id: string, tool: typeof read, input: unknown, run: () => Promise<{ content: string }>): ScheduledCall {
  return { id, tool, input, ctx, execute: run as ScheduledCall['execute'] }
}
function sleeper(id: string, ms: number, log: string[], tool: typeof read = read, input: unknown = { file_path: 'a.txt' }): ScheduledCall {
  return call(id, tool, input, async () => {
    log.push(`start:${id}`)
    await Bun.sleep(ms)
    log.push(`end:${id}`)
    return { content: id }
  })
}

describe('锁规约（planLockSpec）', () => {
  test('读共享、写排他且覆盖祖先目录、unknown 全局排他', async () => {
    expect(await planLockSpec(read, { file_path: 'a.txt' }, ctx)).toEqual({ keys: [realpathSync(join(cwd, 'a.txt'))], mode: 'shared' })
    const writeSpec = await planLockSpec(write, { file_path: 'new/deep/x.txt' }, ctx)
    expect(writeSpec.mode).toBe('exclusive')
    // 缺失目标的 canonical 路径由真实 cwd 拼接保留全部缺失尾部。
    expect(writeSpec.keys).toContain(join(realpathSync(cwd), 'new/deep/x.txt'))
    expect(writeSpec.keys).toContain(realpathSync(cwd))
    const unknown = bindCoreToolEffects({ name: 'McpTool', description: 'x', parameters: { type: 'object', properties: {} }, execute: async () => ({ toolCallId: '', content: '' }) })
    expect(await planLockSpec(unknown, {}, ctx)).toEqual({ keys: ['global:unknown'], mode: 'exclusive' })
  })
  test('符号链接别名解析为同一真实路径键', async () => {
    symlinkSync('a.txt', join(cwd, 'link-a'))
    const direct = await planLockSpec(read, { file_path: 'a.txt' }, ctx)
    const alias = await planLockSpec(read, { file_path: 'link-a' }, ctx)
    expect(alias.keys).toEqual(direct.keys)
  })
})

describe('调度语义', () => {
  test('同文件写串行且保持提交顺序；读-读真正并行', async () => {
    const log: string[] = []
    const scheduler = new ToolScheduler({ maxConcurrent: 4 })
    const results = await scheduler.schedule([
      sleeper('w1', 40, log, write, { file_path: 'same.txt', content: '1' }),
      sleeper('w2', 10, log, write, { file_path: 'same.txt', content: '2' }),
      sleeper('w3', 10, log, write, { file_path: 'same.txt', content: '3' }),
      sleeper('r1', 30, log, read, { file_path: 'b.txt' }),
      sleeper('r2', 30, log, read, { file_path: 'link-a' }),
    ])
    expect(results.map((r) => r.status)).toEqual(['completed', 'completed', 'completed', 'completed', 'completed'])
    expect(results.map((r) => r.id)).toEqual(['w1', 'w2', 'w3', 'r1', 'r2'])
    // w1→w2→w3 严格串行
    expect(log.indexOf('end:w1')).toBeLessThan(log.indexOf('start:w2'))
    expect(log.indexOf('end:w2')).toBeLessThan(log.indexOf('start:w3'))
    // r1 与 r2 是不同真实文件（b.txt 与 a.txt 的链接别名不同），读共享可并行
    expect(log.indexOf('start:r2')).toBeLessThan(log.indexOf('end:r1'))
  })
  test('读等待写完成；写等待读完成', async () => {
    writeFileSync(join(cwd, 'rw.txt'), 'x')
    const log: string[] = []
    const scheduler = new ToolScheduler()
    await scheduler.schedule([
      sleeper('w', 40, log, write, { file_path: 'rw.txt', content: 'x' }),
      sleeper('r', 10, log, read, { file_path: 'rw.txt' }),
    ])
    expect(log.indexOf('end:w')).toBeLessThan(log.indexOf('start:r'))
    const log2: string[] = []
    await new ToolScheduler().schedule([
      sleeper('r0', 40, log2, read, { file_path: 'rw.txt' }),
      sleeper('w0', 10, log2, write, { file_path: 'rw.txt', content: 'y' }),
    ])
    expect(log2.indexOf('end:r0')).toBeLessThan(log2.indexOf('start:w0'))
  })
  test('写阻塞时无关调用可越过队首；目录祖先冲突串行', async () => {
    const log: string[] = []
    const scheduler = new ToolScheduler()
    await scheduler.schedule([
      sleeper('big', 60, log, write, { file_path: 'dir/x.txt', content: 'x' }),
      sleeper('after', 10, log, read, { file_path: 'b.txt' }),
    ])
    expect(log.indexOf('start:after')).toBeLessThan(log.indexOf('end:big'))
    const log2: string[] = []
    await new ToolScheduler().schedule([
      sleeper('parent', 40, log2, write, { file_path: 'tree/a.txt', content: '1' }),
      sleeper('child', 10, log2, write, { file_path: 'tree/sub/b.txt', content: '2' }),
    ])
    expect(log2.indexOf('end:parent')).toBeLessThan(log2.indexOf('start:child'))
  })
  test('unknown 调用全局串行', async () => {
    const unknownTool = bindCoreToolEffects({ name: 'McpX', description: 'x', parameters: { type: 'object', properties: {} }, execute: async () => ({ toolCallId: '', content: '' }) })
    const log: string[] = []
    await new ToolScheduler().schedule([
      sleeper('u1', 40, log, unknownTool, {}),
      sleeper('u2', 10, log, unknownTool, {}),
    ])
    expect(log.indexOf('end:u1')).toBeLessThan(log.indexOf('start:u2'))
  })
  test('并发上限生效', async () => {
    let active = 0
    let maxActive = 0
    const mk = (id: string): ScheduledCall => call(id, read, { file_path: 'a.txt' }, async () => {
      active += 1
      maxActive = Math.max(maxActive, active)
      await Bun.sleep(20)
      active -= 1
      return { content: id }
    })
    const results = await new ToolScheduler({ maxConcurrent: 2 }).schedule([mk('1'), mk('2'), mk('3'), mk('4'), mk('5')])
    expect(results.every((r) => r.status === 'completed')).toBe(true)
    expect(maxActive).toBeLessThanOrEqual(2)
  })
  test('循环依赖批次不死锁（定序加锁）', async () => {
    const log: string[] = []
    const scheduler = new ToolScheduler()
    const results = await Promise.race([
      scheduler.schedule([
        sleeper('A', 20, log, write, { file_path: 'f1.txt', content: 'A' }),
        sleeper('B', 20, log, write, { file_path: 'f2.txt', content: 'B' }),
      ]),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('deadlock')), 3000)),
    ])
    expect(results.map((r) => r.status)).toEqual(['completed', 'completed'])
  })
  test('执行失败释放锁，其余调用继续；结果保持输入顺序', async () => {
    const boom = call('boom', read, { file_path: 'a.txt' }, async () => { throw new Error('执行失败') })
    const ok = sleeper('ok', 5, [], read, { file_path: 'a.txt' })
    const results = await new ToolScheduler().schedule([boom, ok])
    expect(results[0]).toMatchObject({ id: 'boom', status: 'error', error: '执行失败' })
    expect(results[1]?.status).toBe('completed')
  })
  test('abort 后未派发调用标记 cancelled，不执行', async () => {
    const controller = new AbortController()
    const log: string[] = []
    const slow = sleeper('slow', 60, log, write, { file_path: 'abort.txt', content: 'x' })
    const queued = sleeper('queued', 5, log, write, { file_path: 'abort.txt', content: 'y' })
    const promise = new ToolScheduler().schedule([slow, queued], controller.signal)
    setTimeout(() => controller.abort(), 10)
    const results = await promise
    expect(results.find((r) => r.id === 'queued')?.status).toBe('cancelled')
    expect(log).not.toContain('start:queued')
  })
})

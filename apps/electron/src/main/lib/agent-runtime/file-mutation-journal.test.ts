/**
 * 文件变更账本：写入意图 → 结算 → 崩溃后对账。
 *
 * 用隔离配置目录与临时文件模拟：正常写入、写入失败、进程在写入中途退出（只有意图没有结算）。
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  beginFileMutation,
  listUnsettledFileMutations,
  reconcileFileMutation,
  settleFileMutation,
} from './file-mutation-journal'

const configDir = mkdtempSync(join(tmpdir(), 'file-journal-'))
const previous = process.env.PROMA_TEST_CONFIG_DIR
const journalPath = join(configDir, 'file-mutations.jsonl')
const sha = (value: string) => createHash('sha256').update(value).digest('hex')

let workDir = ''
const target = (): string => join(workDir, 'notes.txt')

beforeAll(() => {
  process.env.PROMA_TEST_CONFIG_DIR = configDir
})
afterAll(() => {
  if (previous === undefined) delete process.env.PROMA_TEST_CONFIG_DIR
  else process.env.PROMA_TEST_CONFIG_DIR = previous
  rmSync(configDir, { recursive: true, force: true })
})
beforeEach(() => {
  rmSync(journalPath, { force: true })
  workDir = realpathSync(mkdtempSync(join(tmpdir(), 'file-journal-work-')))
})
afterEach(() => {
  rmSync(workDir, { recursive: true, force: true })
})

describe('文件变更账本', () => {
  test('Given 写入成功 When 结算 Then 不再留在待对账列表', async () => {
    writeFileSync(target(), 'before')
    const handle = await beginFileMutation({ sessionId: 's1', tool: 'Write', path: target() })
    expect(handle?.preHash).toBe(sha('before'))
    writeFileSync(target(), 'after')
    await settleFileMutation(handle, 'ok')
    expect(await listUnsettledFileMutations()).toEqual([])
  })

  test('Given 进程在写入中途退出 When 查询 Then 该文件进入待对账并带写入前摘要', async () => {
    writeFileSync(target(), 'before')
    const handle = await beginFileMutation({ sessionId: 's1', tool: 'Edit', path: target() })
    // 模拟崩溃：没有 settle，文件可能半写
    writeFileSync(target(), 'half')
    const unsettled = await listUnsettledFileMutations()
    expect(unsettled).toHaveLength(1)
    expect(unsettled[0]).toMatchObject({ id: handle!.id, sessionId: 's1', tool: 'Edit', preHash: sha('before') })
  })

  test('Given 新建文件的写入中断 When 对账 Then 只报告变化并保留待核对', async () => {
    const handle = await beginFileMutation({ sessionId: 's1', tool: 'Write', path: target() })
    expect(handle?.preHash).toBe('absent')
    writeFileSync(target(), 'created')
    const result = await reconcileFileMutation({ id: handle!.id, note: '用户核对' })
    expect(result?.verdict).toBe('changed_unknown')
    expect(await listUnsettledFileMutations()).toHaveLength(1)
  })

  test('Given 当前内容与写前一致 When 观察 Then 只报告未变化', async () => {
    writeFileSync(target(), 'same')
    const handle = await beginFileMutation({ sessionId: 's1', tool: 'Write', path: target() })
    const result = await reconcileFileMutation({ id: handle!.id })
    expect(result?.verdict).toBe('unchanged')
  })

  test('Given 当前内容与写前不同 When 观察 Then 不推断写入者或完成状态', async () => {
    writeFileSync(target(), 'before')
    const handle = await beginFileMutation({ sessionId: 's1', tool: 'Edit', path: target() })
    writeFileSync(target(), 'edited-by-us')
    writeFileSync(target(), 'edited-by-someone-else')
    const result = await reconcileFileMutation({ id: handle!.id })
    expect(result?.verdict).toBe('changed_unknown')
  })

  test('Given 目标是符号链接 When 记录意图 Then 不读取链接目标', async () => {
    const outside = join(workDir, 'outside.txt')
    writeFileSync(outside, 'secret')
    symlinkSync(outside, target())
    const handle = await beginFileMutation({ sessionId: 's1', tool: 'Write', path: target() })
    expect(handle?.preHash).toBe('unreadable')
    expect((await reconcileFileMutation({ id: handle!.id }))?.verdict).toBe('unreadable')
    expect(await listUnsettledFileMutations()).toHaveLength(1)
  })

  test('Given 父目录是符号链接 When 记录意图 Then 不读取链接目录里的文件', async () => {
    writeFileSync(target(), 'secret')
    const alias = join(workDir, 'alias')
    symlinkSync(workDir, alias, 'dir')
    expect((await beginFileMutation({ sessionId: 's1', tool: 'Write', path: join(alias, 'notes.txt') }))?.preHash).toBe('unreadable')
  })

  test('Given 文件超过摘要上限 When 记录意图 Then 不读取完整文件', async () => {
    writeFileSync(target(), Buffer.alloc(8 * 1024 * 1024 + 1))
    expect((await beginFileMutation({ sessionId: 's1', tool: 'Write', path: target() }))?.preHash).toBe('unreadable')
  })

  test.skipIf(process.platform === 'win32')('Given FIFO When 记录意图 Then 不打开阻塞管道', async () => {
    expect(spawnSync('mkfifo', [target()]).status).toBe(0)
    expect((await beginFileMutation({ sessionId: 's1', tool: 'Write', path: target() }))?.preHash).toBe('unreadable')
  })

  test('Given 历史自动对账事件 When 查询 Then 保留该意图供人工核对', async () => {
    const handle = await beginFileMutation({ sessionId: 's1', tool: 'Write', path: target() })
    const legacy = { type: 'reconciled', id: handle!.id, sessionId: 's1', path: target(), createdAt: new Date().toISOString(), bootId: 'old', verdict: 'applied' }
    const existing = readFileSync(journalPath, 'utf8')
    writeFileSync(journalPath, `${existing}${JSON.stringify(legacy)}\n`)
    expect((await listUnsettledFileMutations()).map(item => item.id)).toEqual([handle!.id])
  })

  test('Given 文件在中断后被删除 When 对账 Then 判为缺失', async () => {
    writeFileSync(target(), 'before')
    const handle = await beginFileMutation({ sessionId: 's1', tool: 'Write', path: target() })
    rmSync(target())
    const result = await reconcileFileMutation({ id: handle!.id })
    expect(result?.verdict).toBe('missing')
  })

  test('Given 写入失败 When 结算失败原因 Then 保留原因和待对账记录', async () => {
    writeFileSync(target(), 'before')
    const handle = await beginFileMutation({ sessionId: 's1', tool: 'Write', path: target() })
    await settleFileMutation(handle, 'error', 'Write拒绝符号链接、硬链接和非普通文件')
    expect(await listUnsettledFileMutations()).toHaveLength(1)
    const events = readFileSync(journalPath, 'utf8').trim().split('\n').map(line => JSON.parse(line))
    expect(events.at(-1)).toMatchObject({ type: 'settled', status: 'error', message: 'Write拒绝符号链接、硬链接和非普通文件' })
  })

  test('Given 多头意图与部分结算 When 查询 Then 只返回没有结算的那些', async () => {
    const first = await beginFileMutation({ sessionId: 's1', tool: 'Write', path: join(workDir, 'a.txt') })
    const second = await beginFileMutation({ sessionId: 's1', tool: 'Write', path: join(workDir, 'b.txt') })
    await settleFileMutation(first, 'ok')
    const unsettled = await listUnsettledFileMutations()
    expect(unsettled.map(item => item.path)).toEqual([join(workDir, 'b.txt')])
    expect(unsettled[0]?.id).toBe(second?.id)
  })

  test('Given 账本损坏 When 查询 Then 抛错而不是当作没有遗留变更', async () => {
    writeFileSync(journalPath, '{"type":"intent","id":"x"}\n')
    await expect(listUnsettledFileMutations()).rejects.toThrow('文件变更账本损坏')
  })

  test('Given 对账不存在的记录 When 调用 Then 返回 undefined 且不写事件', async () => {
    expect(await reconcileFileMutation({ id: 'missing-id' })).toBeUndefined()
  })
})

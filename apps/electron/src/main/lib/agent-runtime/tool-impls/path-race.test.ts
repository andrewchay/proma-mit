/**
 * 路径替换竞态测试（TOCTOU）
 *
 * 模拟"路径检查通过后、打开文件前父目录被替换"的场景：在 realpathSync 返回之后
 * 立即把父目录换成指向范围外的符号链接，验证 Read/Write 拒绝访问，而不是读写
 * 新位置指向的文件。同时验证 assertDescriptorMatchesStat 的基本语义。
 */

import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, mock, test } from 'bun:test'
import * as fs from 'node:fs'
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 竞态钩子：目标路径第 N 次被 realpathSync 解析、且已返回结果之后，执行一次父目录替换。
let raceTarget: string | undefined
// 同一文件可能以规范路径（/private/var/...）或 TMPDIR 原样路径（/var/...）出现，两者都算命中。
let raceTargetCanonical: string | undefined
let raceOnNth = 0
let raceCount = 0
let raceAction: (() => void) | undefined

const realRealpathSync = fs.realpathSync
const realStatSync = fs.statSync

/** 目标路径命中计数达到阈值后执行一次替换（在 realpathSync/statSync 返回之后）。 */
const maybeRace = (target: unknown) => {
  if (raceTarget && typeof target === 'string' && (target === raceTarget || target === raceTargetCanonical)) {
    raceCount += 1
    if (raceCount === raceOnNth && raceAction) {
      const action = raceAction
      raceTarget = undefined
      raceAction = undefined
      raceCount = 0
      action()
    }
  }
}

mock.module('node:fs', () => ({
  ...fs,
  realpathSync: ((target: Parameters<typeof fs.realpathSync>[0], ...rest: unknown[]) => {
    const result = (realRealpathSync as (...args: unknown[]) => unknown)(target, ...rest)
    maybeRace(target)
    return result
  }) as typeof fs.realpathSync,
  statSync: ((target: Parameters<typeof fs.statSync>[0], ...rest: unknown[]) => {
    const result = (realStatSync as (...args: unknown[]) => unknown)(target, ...rest)
    maybeRace(target)
    return result
  }) as typeof fs.statSync,
}))

import { bindTestToolContext } from '../../testing/bound-tool-context'
const { executeReadTool } = await import('./read-tool')
const { executeWriteTool } = await import('./write-tool')
const { assertDescriptorMatchesStat } = await import('./tool-utils')

const databaseDir = mkdtempSync(join(tmpdir(), 'gravitas-race-db-'))
const previousConfigDir = process.env.PROMA_TEST_CONFIG_DIR
beforeAll(async () => {
  process.env.PROMA_TEST_CONFIG_DIR = databaseDir
  const { initProjectDb } = await import('../../project-sqlite-store')
  await initProjectDb()
})
afterAll(async () => {
  const { closeProjectDb } = await import('../../project-sqlite-store')
  closeProjectDb()
  if (previousConfigDir === undefined) delete process.env.PROMA_TEST_CONFIG_DIR
  else process.env.PROMA_TEST_CONFIG_DIR = previousConfigDir
  rmSync(databaseDir, { recursive: true, force: true })
})

describe('路径替换竞态', () => {
  let cwd: string
  let outside: string
  let sessionId: string

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'race-cwd-'))
    outside = mkdtempSync(join(tmpdir(), 'race-outside-'))
    sessionId = `race-session-${Date.now()}`
    raceTarget = undefined
    raceTargetCanonical = undefined
    raceOnNth = 0
    raceCount = 0
    raceAction = undefined
  })

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  })

  /** 工具上下文按 Runtime 的方式绑定会话身份；绑定不触碰 fs，不影响竞态计数。 */
  const toolCtx = () => bindTestToolContext({ cwd, sessionId })

  /** 布置竞态：目标路径第 nth 次被解析返回后执行替换；布置本身不计入命中。 */
  const armRace = (target: string, nth: number, action: () => void) => {
    raceTargetCanonical = realRealpathSync(target)
    raceTarget = target
    raceOnNth = nth
    raceCount = 0
    raceAction = action
  }

  /** 布置：cwd/sub 是真实目录，outside 中同名文件是"秘密"内容。 */
  const setup = () => {
    const sub = join(cwd, 'sub')
    mkdirSync(sub, { recursive: true })
    writeFileSync(join(sub, 'file.txt'), 'inside-content')
    writeFileSync(join(outside, 'file.txt'), 'secret-content')
    return { sub, target: join(sub, 'file.txt') }
  }

  /** 父目录替换：sub 改名为 sub-old，sub 变为指向 outside 的符号链接。 */
  const swapParentToOutside = (sub: string) => {
    renameSync(sub, `${sub}-old`)
    symlinkSync(outside, sub)
  }

  test('Given Read 检查通过后父目录被替换 When 打开文件 Then 拒绝且不泄露范围外内容', async () => {
    const { sub, target } = setup()
    // 第 3 次命中是 Read 打开前的 stat（inode 基准）；返回后立即替换父目录，open 将落到范围外。
    armRace(target, 3, () => swapParentToOutside(sub))
    const result = await executeReadTool({ file_path: 'sub/file.txt' }, toolCtx())
    expect(result.isError).toBe(true)
    expect(result.content).not.toContain('secret-content')
    expect(result.content).toContain('被替换')
  })

  test('Given Write 检查通过后父目录被替换 When 打开文件 Then 拒绝且范围外文件不变', async () => {
    const { sub, target } = setup()
    // 第 1 次解析发生在 resolveToolPath 内；返回后替换父目录，打开将落到范围外。
    armRace(target, 1, () => swapParentToOutside(sub))
    const result = await executeWriteTool({ file_path: 'sub/file.txt', content: 'hacked' }, toolCtx())
    expect(result.isError).toBe(true)
    expect(readFileSync(join(outside, 'file.txt'), 'utf8')).toBe('secret-content')
  })

  test('Given 无竞态 When 正常读写 Then 行为不变', async () => {
    const { target } = setup()
    const read = await executeReadTool({ file_path: 'sub/file.txt' }, toolCtx())
    expect(read.isError).toBeFalsy()
    expect(read.content).toContain('inside-content')
    const write = await executeWriteTool({ file_path: 'sub/file.txt', content: 'updated' }, toolCtx())
    expect(write.isError).toBeFalsy()
    expect(readFileSync(target, 'utf8')).toBe('updated')
  })

  test('Given 描述符实际位置与预期不一致 When 校验 Then 拒绝', () => {
    const { target } = setup()
    const fd = fs.openSync(join(outside, 'file.txt'), 'r')
    try {
      expect(() => assertDescriptorMatchesStat(fd, fs.statSync(target))).toThrow('被替换')
    } finally {
      fs.closeSync(fd)
    }
  })

  test('Given 描述符实际位置与预期一致 When 校验 Then 通过', () => {
    const { target } = setup()
    const fd = fs.openSync(target, 'r')
    try {
      expect(() => assertDescriptorMatchesStat(fd, fs.statSync(fs.realpathSync(target)))).not.toThrow()
    } finally {
      fs.closeSync(fd)
    }
  })
})

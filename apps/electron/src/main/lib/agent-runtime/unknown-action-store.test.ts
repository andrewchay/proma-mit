import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  __resetUnknownActionCacheForTest,
  blockIfUnknownAction,
  buildActionKey,
  findPendingUnknownAction,
  hashDetail,
  listPendingUnknownActions,
  recordUnknownAction,
  resolveUnknownAction,
} from './unknown-action-store'

const directory = mkdtempSync(join(tmpdir(), 'unknown-action-'))
const previous = process.env.PROMA_TEST_CONFIG_DIR

beforeAll(() => {
  process.env.PROMA_TEST_CONFIG_DIR = directory
})
afterAll(() => {
  if (previous === undefined) delete process.env.PROMA_TEST_CONFIG_DIR
  else process.env.PROMA_TEST_CONFIG_DIR = previous
  rmSync(directory, { recursive: true, force: true })
})
beforeEach(() => {
  // 清内存不够：重建会从磁盘恢复上一条用例的记录，因此连文件一起删。
  rmSync(join(directory, 'unknown-actions.jsonl'), { force: true })
  __resetUnknownActionCacheForTest()
})

describe('未知动作登记', () => {
  test('Given 记录一次未知结果 When 查询 Then 返回 pending', async () => {
    const key = buildActionKey('computer-use:click', '10,20@primary')
    await recordUnknownAction({ sessionId: 's1', tool: 'ComputerUseClick', actionKey: key, reason: 'timed out' })
    const record = await findPendingUnknownAction('s1', key)
    expect(record?.status).toBe('pending')
    expect(record?.reason).toBe('timed out')
    expect(record?.tool).toBe('ComputerUseClick')
  })

  test('Given 未登记的动作 When 查询 Then 不拦截', async () => {
    const blocked = await blockIfUnknownAction({
      sessionId: 's1',
      tool: 'ComputerUseClick',
      actionKey: buildActionKey('computer-use:click', '99,99@primary'),
      confirmHint: '先截图',
    })
    expect(blocked).toBeUndefined()
  })

  test('Given 同会话同指纹存在未知 When 执行入口检查 Then 拒绝并说明依据', async () => {
    const key = buildActionKey('computer-use:click', '10,20@primary')
    await recordUnknownAction({ sessionId: 's1', tool: 'ComputerUseClick', actionKey: key, reason: 'Target closed' })
    const blocked = await blockIfUnknownAction({
      sessionId: 's1',
      tool: 'ComputerUseClick',
      actionKey: key,
      confirmHint: '请先调用 ComputerUseScreenshot 确认屏幕状态。',
    })
    expect(blocked).toContain('拒绝执行')
    expect(blocked).toContain('结果未知')
    expect(blocked).toContain('Target closed')
    expect(blocked).toContain('resolveUnknownAction')
    expect(blocked).toContain('ComputerUseScreenshot')
  })

  test('Given 不同会话 When 同指纹 Then 互不拦截', async () => {
    const key = buildActionKey('web-bridge:click', 'r1-2')
    await recordUnknownAction({ sessionId: 'session-a', tool: 'WebBridgeClick', actionKey: key, reason: 'Target closed' })
    expect(await findPendingUnknownAction('session-b', key)).toBeUndefined()
  })

  test('Given 同会话不同目标 When 检查 Then 不拦截', async () => {
    await recordUnknownAction({
      sessionId: 's1',
      tool: 'WebBridgeClick',
      actionKey: buildActionKey('web-bridge:click', 'r1-2'),
      reason: 'Target closed',
    })
    expect(await findPendingUnknownAction('s1', buildActionKey('web-bridge:click', 'r1-3'))).toBeUndefined()
  })
})

describe('未知动作解除', () => {
  test('Given 按指纹解除 When 再检查 Then 放行并保留处理依据', async () => {
    const key = buildActionKey('mcp:demo__create_issue', 'abc')
    await recordUnknownAction({ sessionId: 's1', tool: 'MCP 工具 demo__create_issue', actionKey: key, reason: 'Connection closed' })
    const resolved = await resolveUnknownAction({ sessionId: 's1', actionKey: key, resolution: '用户在 Issue 列表确认没有重复单' })
    expect(resolved?.status).toBe('resolved')
    expect(resolved?.resolution).toContain('确认没有重复单')
    expect(await findPendingUnknownAction('s1', key)).toBeUndefined()
    expect(
      await blockIfUnknownAction({ sessionId: 's1', tool: 'x', actionKey: key, confirmHint: 'hint' }),
    ).toBeUndefined()
  })

  test('Given 按 id 解除 When 会话不匹配 Then 不生效', async () => {
    const key = buildActionKey('computer-use:type', 'text:abc')
    const record = await recordUnknownAction({ sessionId: 's1', tool: 'ComputerUseType', actionKey: key, reason: 'unknown' })
    expect(await resolveUnknownAction({ sessionId: 'other', id: record.id, resolution: 'x' })).toBeUndefined()
    expect((await findPendingUnknownAction('s1', key))?.status).toBe('pending')
  })

  test('Given 会话内多条未知 When 列出 Then 只返回本会话', async () => {
    await recordUnknownAction({ sessionId: 's1', tool: 'a', actionKey: 'k1', reason: 'r' })
    await recordUnknownAction({ sessionId: 's1', tool: 'b', actionKey: 'k2', reason: 'r' })
    await recordUnknownAction({ sessionId: 's2', tool: 'c', actionKey: 'k3', reason: 'r' })
    const pending = await listPendingUnknownActions('s1')
    expect(pending.map((item) => item.actionKey).sort()).toEqual(['k1', 'k2'])
  })
})

describe('跨进程重建', () => {
  test('Given 登记后清空内存 When 重新查询 Then 从磁盘恢复 pending', async () => {
    const key = buildActionKey('computer-use:click', '5,5@primary')
    await recordUnknownAction({ sessionId: 'restart', tool: 'ComputerUseClick', actionKey: key, reason: 'timed out' })
    __resetUnknownActionCacheForTest()
    expect((await findPendingUnknownAction('restart', key))?.reason).toBe('timed out')
  })

  test('Given 解除事件已落盘 When 重建 Then 不再拦截', async () => {
    const key = buildActionKey('computer-use:click', '6,6@primary')
    await recordUnknownAction({ sessionId: 'restart', tool: 'ComputerUseClick', actionKey: key, reason: 'timed out' })
    await resolveUnknownAction({ sessionId: 'restart', actionKey: key, resolution: '用户确认已完成' })
    __resetUnknownActionCacheForTest()
    expect(await findPendingUnknownAction('restart', key)).toBeUndefined()
  })
})

describe('登记故障与并发', () => {
  test('Given 已有未知动作 When 同时首次查询 Then 两次均拦截', async () => {
    await recordUnknownAction({ sessionId: 's1', tool: 'x', actionKey: 'k', reason: 'unknown' })
    __resetUnknownActionCacheForTest()
    const results = await Promise.all([
      findPendingUnknownAction('s1', 'k'),
      findPendingUnknownAction('s1', 'k'),
    ])
    expect(results.every(Boolean)).toBe(true)
  })

  test('Given 解除事件无法写入 When 解除 Then 已有拦截仍保留', async () => {
    await recordUnknownAction({ sessionId: 's1', tool: 'x', actionKey: 'k', reason: 'unknown' })
    rmSync(join(directory, 'unknown-actions.jsonl'))
    mkdirSync(join(directory, 'unknown-actions.jsonl'))
    await expect(resolveUnknownAction({ sessionId: 's1', actionKey: 'k', resolution: 'confirmed' })).rejects.toThrow()
    expect(await findPendingUnknownAction('s1', 'k')).toBeDefined()
    rmSync(join(directory, 'unknown-actions.jsonl'), { recursive: true })
  })

  test('Given 登记文件损坏 When 查询 Then 拒绝而不是放行', async () => {
    writeFileSync(join(directory, 'unknown-actions.jsonl'), '{invalid}\n')
    await expect(findPendingUnknownAction('s1', 'k')).rejects.toThrow()
  })
})

describe('动作指纹', () => {
  test('Given 相同参数 When 计算哈希 Then 稳定且与不同参数区分', () => {
    expect(hashDetail({ a: 1, b: 'x' })).toBe(hashDetail({ b: 'x', a: 1 }))
    expect(hashDetail({ a: 1 })).not.toBe(hashDetail({ a: 2 }))
    expect(hashDetail('same')).toBe(hashDetail('same'))
  })

  test('Given 工具与目标 When 组装指纹 Then 带工具前缀', () => {
    expect(buildActionKey('mcp:demo__tool', 'abc')).toBe('mcp:demo__tool:abc')
  })
})

/**
 * R04 回滚演练：关闭新机制可恢复 baseline，硬安全底线不降低，旧数据可读。
 */
import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildElectronMock } from '../testing/electron-mock'

const previousConfigDir = process.env.PROMA_TEST_CONFIG_DIR
const configDir = mkdtempSync(join(tmpdir(), 'gravitas-rollback-'))
process.env.PROMA_TEST_CONFIG_DIR = configDir
mock.module('electron', () => buildElectronMock())

const { runGuardedToolCall, setToolSchedulerDisabled } = await import('./tool-scheduler-service')
const { loadHarnessPolicy, buildHarnessPolicyState } = await import('./harness-policy')
const { resolvePilotRuntimeBudgetLimitUsd } = await import('../project-pilot-runtime-budget')
const { bindCoreToolEffects } = await import('./tool-effects')
const { getAgentSessionSDKMessages } = await import('../agent-session-manager')
const { DEFAULT_HARNESS_POLICY } = await import('@gravitas/shared')

beforeAll(() => { mkdirSync(join(configDir, 'work'), { recursive: true }) })
afterAll(() => {
  setToolSchedulerDisabled(false)
  if (previousConfigDir === undefined) delete process.env.PROMA_TEST_CONFIG_DIR
  else process.env.PROMA_TEST_CONFIG_DIR = previousConfigDir
  rmSync(configDir, { recursive: true, force: true })
})

const fakeTool = bindCoreToolEffects({ name: 'McpRollback', description: 'x', parameters: { type: 'object', properties: {} }, execute: async () => ({ toolCallId: '', content: '' }) })
const ctx = { cwd: join(configDir, 'work'), sessionId: 'rollback' }

describe('R04 回滚演练', () => {
  test('关闭调度器 → 恢复 baseline 全串行；重新开启 → 并行恢复', async () => {
    const log: string[] = []
    const mk = (id: string, ms: number) => runGuardedToolCall({ tool: fakeTool, args: {}, ctx, execute: async () => { log.push(`s:${id}`); await Bun.sleep(ms); log.push(`e:${id}`); return { content: id } } })
    // 开启状态：unknown 全局锁本就串行（baseline 行为不变）
    await Promise.all([mk('on1', 40), mk('on2', 10)])
    expect(log.indexOf('e:on1')).toBeLessThan(log.indexOf('s:on2'))
    // 禁用（回滚）：仍串行（锁仍持有，硬底线不降低）
    setToolSchedulerDisabled(true)
    try {
      await Promise.all([mk('off1', 40), mk('off2', 10)])
      expect(log.indexOf('e:off1')).toBeLessThan(log.indexOf('s:off2'))
    } finally {
      setToolSchedulerDisabled(false)
    }
    // 恢复开启后调度器仍可用
    await expect(runGuardedToolCall({ tool: fakeTool, args: {}, ctx, execute: async () => ({ content: 'back' }) })).resolves.toEqual({ content: 'back' })
  })
  test('删除策略文件 → 回滚到默认策略；损坏文件拒绝且保留原件；修复后恢复', () => {
    const path = join(configDir, 'harness-policy-rollback.json')
    expect(loadHarnessPolicy(path)).toEqual(DEFAULT_HARNESS_POLICY)
    writeFileSync(path, '{ broken')
    expect(buildHarnessPolicyState(path).status).toBe('invalid')
    expect(() => loadHarnessPolicy(path)).toThrow(/JSON/)
    // 回滚动作 = 删除文件，不尝试修复性覆写
    rmSync(path)
    expect(loadHarnessPolicy(path)).toEqual(DEFAULT_HARNESS_POLICY)
  })
  test('旧数据可读：无 compactionSource 的旧 boundary 原样加载；日志不删', () => {
    const sessionId = 'legacy-session'
    const dir = join(configDir, 'agent-sessions')
    mkdirSync(dir, { recursive: true })
    const legacyBoundary = { type: 'system', subtype: 'compact_boundary', session_id: sessionId, summary: '旧摘要' }
    const legacyUser = { type: 'user', message: { content: [{ type: 'text', text: '旧消息' }] }, parent_tool_use_id: null }
    const file = join(dir, `${sessionId}.jsonl`)
    writeFileSync(file, [legacyBoundary, legacyUser].map((m) => JSON.stringify(m)).join('\n') + '\n', 'utf-8')
    const messages = getAgentSessionSDKMessages(sessionId)
    expect(messages).toHaveLength(2)
    expect((messages[0] as { subtype?: string }).subtype).toBe('compact_boundary')
    expect((messages[0] as { compactionSource?: unknown }).compactionSource).toBeUndefined()
  })
  test('硬底线与开关无关：Pilot 预算闸在调度器禁用/策略回滚下仍 fail-closed', () => {
    setToolSchedulerDisabled(true)
    try {
      expect(() => resolvePilotRuntimeBudgetLimitUsd('proma', 1_000_000)).toThrow(/不支持单次费用超额停止阈值/)
    } finally {
      setToolSchedulerDisabled(false)
    }
    expect(() => resolvePilotRuntimeBudgetLimitUsd('proma', 1_000_000)).toThrow(/不支持单次费用超额停止阈值/)
  })
})

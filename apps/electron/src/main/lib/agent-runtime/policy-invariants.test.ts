/**
 * P02 策略一致性钉板：既有权限/预算/费用底线不被新层旁路。
 * 只断言当前事实，不宣称额外的全局安全。
 */
import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildElectronMock } from '../testing/electron-mock'

const originalConfig = process.env.PROMA_TEST_CONFIG_DIR
const dir = mkdtempSync(join(tmpdir(), 'gravitas-policy-inv-'))
process.env.PROMA_TEST_CONFIG_DIR = dir
mock.module('electron', () => buildElectronMock())
const { AISDKRuntimeCore } = await import('./ai-sdk-runtime-core')
const { resolvePilotRuntimeBudgetLimitUsd } = await import('../project-pilot-runtime-budget')
const { bindCoreToolEffects } = await import('./tool-effects')
const { createWriteToolDefinition, executeWriteTool } = await import('./tool-impls/write-tool')
const { createBashToolDefinition, executeBashTool } = await import('./tool-impls/bash-tool')

beforeAll(() => { mkdirSync(join(dir, 'work')) })
afterAll(() => {
  if (originalConfig === undefined) delete process.env.PROMA_TEST_CONFIG_DIR
  else process.env.PROMA_TEST_CONFIG_DIR = originalConfig
  rmSync(dir, { recursive: true, force: true })
})
const cwd = join(dir, 'work')

const core = new AISDKRuntimeCore()
const session = (permissionMode: import('./ai-sdk-runtime-core').AISDKRuntimeSessionState['permissionMode'], overrides: Partial<import('./ai-sdk-runtime-core').AISDKRuntimeSessionState> = {}): import('./ai-sdk-runtime-core').AISDKRuntimeSessionState => ({
  sessionId: 'inv', cwd, model: 'm', permissionMode, planModeEntered: false, ...overrides,
} as import('./ai-sdk-runtime-core').AISDKRuntimeSessionState)

const writeTool = bindCoreToolEffects({ ...createWriteToolDefinition(), execute: executeWriteTool })
const bashTool = bindCoreToolEffects({ ...createBashToolDefinition(), execute: executeBashTool })

// 经私有检查器的最直接出口：构建 tools 并调用 execute（权限在执行路径内判定）。
const buildTools = (state: import('./ai-sdk-runtime-core').AISDKRuntimeSessionState) =>
  (core as unknown as { checkToolPermission: (name: string, input: Record<string, unknown>, st: unknown) => Promise<{ allowed: boolean; message?: string }> })

describe('P02 Plan 模式写范围', () => {
  test('plan 模式：.md 写允许，非 .md 写拒绝，写 Bash 拒绝，只读 Bash 允许', async () => {
    const checker = (core as never as { checkToolPermission: (n: string, i: Record<string, unknown>, s: unknown) => Promise<{ allowed: boolean; message?: string }> })
    const state = { cwd, sessionId: 'inv', signal: new AbortController().signal, activeSession: session('plan'), onEnterPlanMode: () => {}, onExitPlanMode: () => {}, onAskUser: undefined, runSubAgent: undefined, mcpManager: undefined }
    expect((await checker.checkToolPermission('Write', { file_path: 'plan/a.md' }, state)).allowed).toBe(true)
    expect((await checker.checkToolPermission('Write', { file_path: 'src/a.ts' }, state)).allowed).toBe(false)
    expect((await checker.checkToolPermission('Bash', { command: 'echo x > f.txt' }, state)).allowed).toBe(false)
    expect((await checker.checkToolPermission('Bash', { command: 'ls -la' }, state)).allowed).toBe(true)
    expect((await checker.checkToolPermission('Read', { file_path: 'a.ts' }, state)).allowed).toBe(true)
  })
})

describe('P02 硬底线不被放宽', () => {
  test('safe + worktreeScopedWrite：树内写允许，树外路径逃逸拒绝（bypass 之外的硬拒绝）', async () => {
    const checker = (core as never as { checkToolPermission: (n: string, i: Record<string, unknown>, s: unknown) => Promise<{ allowed: boolean; message?: string }> })
    const state = { cwd, sessionId: 'inv', signal: new AbortController().signal, activeSession: session('safe', { worktreeScopedWrite: true } as never), onEnterPlanMode: () => {}, onExitPlanMode: () => {}, onAskUser: undefined, runSubAgent: undefined, mcpManager: undefined }
    expect((await checker.checkToolPermission('Write', { file_path: 'inside.txt' }, state)).allowed).toBe(true)
    const escape = await checker.checkToolPermission('Write', { file_path: '../../etc/evil.txt' }, state)
    expect(escape.allowed).toBe(false)
    expect(escape.message).toContain('越界')
    // 无 scope 时 safe 模式写操作一律拒绝
    const plain = { ...state, activeSession: session('safe') }
    expect((await checker.checkToolPermission('Write', { file_path: 'inside.txt' }, plain)).allowed).toBe(false)
  })
  test('Pilot 预算闸与权限模式无关：不支持的 runtime 在 bypass 下仍 fail-closed', () => {
    // 该闸是纯函数层硬底线，bypassPermissions 只影响工具权限层，不触及预算闸。
    expect(() => resolvePilotRuntimeBudgetLimitUsd('proma', 1_000_000)).toThrow(/不支持单次费用超额停止阈值/)
    expect(() => resolvePilotRuntimeBudgetLimitUsd('ai-sdk', 1_000_000)).not.toThrow()
    expect(() => resolvePilotRuntimeBudgetLimitUsd('ai-sdk', 0)).toThrow(/无法核验/)
  })
  test('写工具与 Bash 工具经调度器接线后仍返回内容（接线不吞结果）', async () => {
    const result = await writeTool.execute({ file_path: 'ok.txt', content: 'v' }, { cwd, sessionId: 'inv' } as never)
    expect(result.content).toContain('已写入')
    const listed = await bashTool.execute({ command: 'ls ok.txt' }, { cwd, sessionId: 'inv' } as never)
    expect(listed.content).toContain('ok.txt')
    void buildTools
  })
})

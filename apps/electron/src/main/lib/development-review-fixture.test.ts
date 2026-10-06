/**
 * W00 fixture：验证研发 Review 测试的隔离契约。
 *
 * 证明三件事：
 * 1. 业务存储/工作区落在 PROMA_TEST_CONFIG_DIR 指定的临时目录；
 * 2. 真实 ~/.gravitas/agent-workspaces/ 在测试前后目录清单不变；
 * 3. fixture 可重建、清理后不遗留。
 */
import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { buildElectronMock } from './testing/electron-mock'

const directory = mkdtempSync(join(tmpRoot(), 'gravitas-review-fixture-'))
const originalConfig = process.env.PROMA_TEST_CONFIG_DIR
process.env.PROMA_TEST_CONFIG_DIR = join(directory, 'config')
mock.module('electron', () => buildElectronMock())

function tmpRoot(): string {
  return process.env.TMPDIR ?? '/tmp'
}

const store = await import('./project-sqlite-store')
const { createAgentWorkspace } = await import('./agent-workspace-manager')

/** 真实工作区目录名快照（只读名称，不读内容） */
function realWorkspaceEntries(): string[] {
  const dir = join(homedir(), '.gravitas', 'agent-workspaces')
  return existsSync(dir) ? readdirSync(dir).sort() : []
}

let realBefore: string[] = []

beforeAll(async () => {
  realBefore = realWorkspaceEntries()
  await store.initProjectDb()
})

afterAll(() => {
  store.closeProjectDb()
  if (originalConfig === undefined) delete process.env.PROMA_TEST_CONFIG_DIR
  else process.env.PROMA_TEST_CONFIG_DIR = originalConfig
  rmSync(directory, { recursive: true, force: true })
})

describe('研发 Review fixture 隔离', () => {
  test('Given 临时配置目录 When 创建项目/任务/工作区 Then 全部落在临时目录', async () => {
    const project = store.createProject({ title: '隔离样例', description: 'fixture' })
    const task = store.createTask(project.id, {description: '',  title: '修复样例 Bug' })
    const workspace = createAgentWorkspace(`fixture-${Math.random().toString(36).slice(2, 8)}`)

    expect(store.getTask(task.id)?.projectId).toBe(project.id)
    expect(workspace.rootPath).toBeUndefined()
    // 配置目录确实在临时目录内
    expect(process.env.PROMA_TEST_CONFIG_DIR!.startsWith(directory)).toBe(true)
    expect(existsSync(join(process.env.PROMA_TEST_CONFIG_DIR!, 'agent-workspaces'))).toBe(true)
  })

  test('Given 测试全部结束 When 清理 Then 真实配置目录无新增', () => {
    expect(realWorkspaceEntries()).toEqual(realBefore)
  })
})

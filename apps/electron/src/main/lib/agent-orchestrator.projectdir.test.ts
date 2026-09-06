import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createAgentWorkspace, getAgentWorkspaceCwd } from './agent-workspace-manager'
import { ElectronRuntimeWorkspaceStore } from './agent-runtime/runtime-services'

describe('本地项目正式工作区合同', () => {
  const original = process.env.PROMA_TEST_CONFIG_DIR
  let directory: string | undefined
  afterEach(() => {
    if (original === undefined) delete process.env.PROMA_TEST_CONFIG_DIR
    else process.env.PROMA_TEST_CONFIG_DIR = original
    if (directory) rmSync(directory, { recursive: true, force: true })
  })
  function project() {
    directory = mkdtempSync(join(tmpdir(), 'gravitas-project-cwd-'))
    process.env.PROMA_TEST_CONFIG_DIR = join(directory, 'config')
    const path = join(directory, 'project')
    mkdirSync(path)
    return { workspace: createAgentWorkspace('本地项目', path), path: realpathSync(path) }
  }
  test('Given 绑定已有项目 When runtime 解析 workspaceId Then 使用实际项目根目录', () => {
    const { workspace, path } = project()
    expect(new ElectronRuntimeWorkspaceStore().resolveWorkspaceContext({ workspaceId: workspace.id, sessionId: 'session' }).cwd).toBe(path)
    // Pi 与 Claude 复用同一正式工作区 cwd 函数。
    expect(getAgentWorkspaceCwd(workspace, 'session')).toBe(path)
  })
  test('Given 项目目录已移除 When runtime 解析 Then 在执行前明确拒绝', () => {
    const { workspace, path } = project()
    rmSync(path, { recursive: true })
    expect(() => new ElectronRuntimeWorkspaceStore().resolveWorkspaceContext({ workspaceId: workspace.id, sessionId: 'session' })).toThrow('本地项目文件夹不可用')
    expect(() => getAgentWorkspaceCwd(workspace, 'session')).toThrow('本地项目文件夹不可用')
  })
})

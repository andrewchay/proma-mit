/**
 * Agent 会话管理器单元测试
 */

import { describe, test, expect, beforeEach, afterEach, afterAll, mock } from 'bun:test'
import type { SDKMessage } from '@proma/shared'
import { mkdirSync, writeFileSync, existsSync, rmSync, realpathSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'

// 使用临时 HOME 目录，避免测试污染开发者本机的 ~/.proma-mit-dev
// Bun 的 os.homedir() 不读取 process.env.HOME，因此通过 mock.module 覆盖
const originalHomedir = homedir()
const tempHomeDir = mkdtempSync(join(tmpdir(), 'proma-agent-session-test-'))
process.env.PROMA_DEV = '1'

mock.module('os', () => ({
  homedir: () => tempHomeDir,
  tmpdir,
}))

mock.module('electron', () => ({
  BrowserWindow: class MockBrowserWindow {},
  app: { isPackaged: false },
  dialog: {},
}))

const {
  createAgentSession,
  forkAgentSession,
  getAgentSessionSDKMessages,
  getAgentSessionMeta,
  rewindProviderAgnosticSession,
  updateAgentSessionMeta,
} = await import('./agent-session-manager')
const { getConfigDir, getAgentSessionWorkspacePath, getAgentWorkspacePath } = await import('./config-paths')
const { createAgentWorkspace, getAgentWorkspaceCwd } = await import('./agent-workspace-manager')

describe('Agent 会话管理器', () => {
  let testWorkspaceId: string
  let testWorkspaceSlug: string
  const testDirs: string[] = []

  beforeEach(() => {
    const ws = createAgentWorkspace(`Test Workspace ${Date.now()}`)
    testWorkspaceId = ws.id
    testWorkspaceSlug = ws.slug
  })

  afterEach(() => {
    for (const dir of testDirs) {
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
    }
    const wsDir = getAgentWorkspacePath(testWorkspaceSlug)
    if (existsSync(wsDir)) rmSync(wsDir, { recursive: true, force: true })
    // 清理本测试创建的工作区索引（在临时 HOME 下，不会污染本机）
    const indexPath = join(getConfigDir(), 'agent-workspaces.json')
    if (existsSync(indexPath)) rmSync(indexPath, { force: true })
  })

  afterAll(() => {
    if (existsSync(tempHomeDir)) rmSync(tempHomeDir, { recursive: true, force: true })
    // 恢复 os.homedir，避免影响同一进程中的其他测试文件
    mock.module('os', () => ({
      homedir: () => originalHomedir,
      tmpdir,
    }))
  })

  test('新会话默认使用 Claude runtime，也可以显式指定 Proma runtime', () => {
    const defaultSession = createAgentSession('default runtime', undefined, testWorkspaceId)
    const promaSession = createAgentSession('proma runtime', undefined, testWorkspaceId, 'proma')

    expect(defaultSession.agentRuntime).toBe('claude')
    expect(getAgentSessionMeta(defaultSession.id)?.agentRuntime).toBe('claude')
    expect(promaSession.agentRuntime).toBe('proma')
    expect(getAgentSessionMeta(promaSession.id)?.agentRuntime).toBe('proma')
  })

  test('从已有本地文件夹创建工作区时，Agent cwd 直接使用项目根目录', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'proma-local-project-'))
    testDirs.push(projectDir)
    const workspace = createAgentWorkspace(`本地项目 ${Date.now()}`, projectDir)

    const canonicalProjectDir = realpathSync(projectDir)
    expect(workspace.rootPath).toBe(canonicalProjectDir)
    expect(getAgentWorkspaceCwd(workspace, 'session-1')).toBe(canonicalProjectDir)
    expect(getAgentSessionWorkspacePath(workspace.slug, 'session-1')).not.toBe(canonicalProjectDir)
  })

  test('更新会话 runtime 时会归一化非法值', () => {
    const session = createAgentSession('runtime update', undefined, testWorkspaceId, 'pi')

    expect(updateAgentSessionMeta(session.id, { agentRuntime: 'proma' }).agentRuntime).toBe('proma')
    expect(updateAgentSessionMeta(session.id, { agentRuntime: 'invalid' as never }).agentRuntime).toBe('claude')
  })

  test('fork Provider-Agnostic 会话：复制工作区文件与 JSONL 历史', async () => {
    const sourceSession = createAgentSession('source', undefined, testWorkspaceId, 'proma')
    const sourceDir = getAgentSessionWorkspacePath(testWorkspaceSlug, sourceSession.id)
    testDirs.push(sourceDir)
    mkdirSync(sourceDir, { recursive: true })
    writeFileSync(join(sourceDir, 'note.txt'), 'hello', 'utf-8')

    const newFork = await forkAgentSession({ sessionId: sourceSession.id })
    const destDir = getAgentSessionWorkspacePath(testWorkspaceSlug, newFork.id)
    testDirs.push(destDir)

    expect(newFork.title).toContain('fork')
    expect(newFork.agentRuntime).toBe('proma')
    expect(existsSync(join(destDir, 'note.txt'))).toBe(true)
    expect(getAgentSessionMeta(newFork.id)).toBeDefined()
  })

  test('fork Provider-Agnostic 会话：按消息 UUID 截断历史', async () => {
    const sourceSession = createAgentSession('source', undefined, testWorkspaceId)
    const sourceDir = getAgentSessionWorkspacePath(testWorkspaceSlug, sourceSession.id)
    testDirs.push(sourceDir)
    mkdirSync(sourceDir, { recursive: true })

    const sdkMessage: SDKMessage = {
      type: 'user',
      uuid: 'msg-1',
      message: { content: [{ type: 'text', text: '你好' }] },
      parent_tool_use_id: null,
    } as unknown as SDKMessage
    const messagesPath = join(getConfigDir(), 'agent-sessions', `${sourceSession.id}.jsonl`)
    mkdirSync(join(getConfigDir(), 'agent-sessions'), { recursive: true })
    writeFileSync(messagesPath, `${JSON.stringify(sdkMessage)}\n`, 'utf-8')

    const newFork = await forkAgentSession({ sessionId: sourceSession.id, upToMessageUuid: 'msg-1' })
    const forkMessages = getAgentSessionSDKMessages(newFork.id)
    const destDir = getAgentSessionWorkspacePath(testWorkspaceSlug, newFork.id)
    testDirs.push(destDir)

    expect(forkMessages).toHaveLength(1)
    expect((forkMessages[0] as unknown as { uuid?: string }).uuid).toBe('msg-1')
  })

  test('rewind Provider-Agnostic 会话：截断 JSONL 历史到指定消息', async () => {
    const sourceSession = createAgentSession('source', undefined, testWorkspaceId)
    const sourceDir = getAgentSessionWorkspacePath(testWorkspaceSlug, sourceSession.id)
    testDirs.push(sourceDir)

    const messagesPath = join(getConfigDir(), 'agent-sessions', `${sourceSession.id}.jsonl`)
    mkdirSync(join(getConfigDir(), 'agent-sessions'), { recursive: true })
    const msg1: SDKMessage = { type: 'user', uuid: 'msg-1', message: { content: [{ type: 'text', text: '你好' }] }, parent_tool_use_id: null } as unknown as SDKMessage
    const msg2: SDKMessage = { type: 'assistant', uuid: 'msg-2', message: { content: [{ type: 'text', text: '好的' }] }, parent_tool_use_id: null } as unknown as SDKMessage
    const msg3: SDKMessage = { type: 'user', uuid: 'msg-3', message: { content: [{ type: 'text', text: '继续' }] }, parent_tool_use_id: null } as unknown as SDKMessage
    writeFileSync(messagesPath, [msg1, msg2, msg3].map((m) => JSON.stringify(m)).join('\n') + '\n', 'utf-8')

    const kept = rewindProviderAgnosticSession(sourceSession.id, 'msg-2')
    const remaining = getAgentSessionSDKMessages(sourceSession.id)

    expect(kept).toHaveLength(2)
    expect(remaining).toHaveLength(2)
    expect((remaining[0] as unknown as { uuid?: string }).uuid).toBe('msg-1')
    expect((remaining[1] as unknown as { uuid?: string }).uuid).toBe('msg-2')
  })
})

/**
 * Agent 会话管理器单元测试
 */

import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test'
import type { SDKMessage } from '@proma/shared'
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'

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
} = await import('./agent-session-manager')
const { getConfigDir, getAgentSessionWorkspacePath, getAgentWorkspacePath } = await import('./config-paths')
const { createAgentWorkspace } = await import('./agent-workspace-manager')

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
    // 清理工作区索引
    const indexPath = join(getConfigDir(), 'agent-workspaces.json')
    if (existsSync(indexPath)) rmSync(indexPath, { force: true })
  })

  test('fork Provider-Agnostic 会话：复制工作区文件与 JSONL 历史', async () => {
    const sourceSession = createAgentSession('source', undefined, testWorkspaceId)
    const sourceDir = getAgentSessionWorkspacePath(testWorkspaceSlug, sourceSession.id)
    testDirs.push(sourceDir)
    mkdirSync(sourceDir, { recursive: true })
    writeFileSync(join(sourceDir, 'note.txt'), 'hello', 'utf-8')

    const newFork = await forkAgentSession({ sessionId: sourceSession.id })
    const destDir = getAgentSessionWorkspacePath(testWorkspaceSlug, newFork.id)
    testDirs.push(destDir)

    expect(newFork.title).toContain('fork')
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

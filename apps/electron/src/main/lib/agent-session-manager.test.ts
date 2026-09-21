/**
 * Agent 会话管理器单元测试
 */

import { describe, test, expect, beforeEach, afterEach, afterAll, mock } from 'bun:test'
import { buildElectronMock } from './testing/electron-mock'
import type { SDKMessage } from '@gravitas/shared'
import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync, realpathSync } from 'node:fs'
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

mock.module('electron', () => buildElectronMock())

const {
  createAgentSession,
  forkAgentSession,
  getAgentSessionSDKMessages,
  getAgentSessionMeta,
  rewindProviderAgnosticSession,
  searchAgentSessionReferences,
  updateAgentSessionMeta,
  compactSDKMessages,
  alignKeepStartToToolPairs,
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

  test('新会话默认使用 Pi runtime（支持 deepseek-v4-flash 等 pi 模型），也可以显式指定其他 runtime', () => {
    const defaultSession = createAgentSession('default runtime', undefined, testWorkspaceId)
    const promaSession = createAgentSession('proma runtime', undefined, testWorkspaceId, undefined, 'proma')

    expect(defaultSession.agentRuntime).toBe('pi')
    expect(getAgentSessionMeta(defaultSession.id)?.agentRuntime).toBe('pi')
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
    const session = createAgentSession('runtime update', undefined, testWorkspaceId, undefined, 'pi')

    expect(updateAgentSessionMeta(session.id, { agentRuntime: 'proma' }).agentRuntime).toBe('proma')
    expect(updateAgentSessionMeta(session.id, { agentRuntime: 'invalid' as never }).agentRuntime).toBe('pi')
  })

  test('压缩会话历史后清除压缩前的 token 观测', () => {
    const session = createAgentSession('compact usage reset', undefined, testWorkspaceId, undefined, 'pi')
    updateAgentSessionMeta(session.id, {
      lastContextUsage: { contextTokens: 200_000, modelId: 'kimi-for-coding', recordedAt: Date.now() },
    })
    const messagesPath = join(getConfigDir(), 'agent-sessions', `${session.id}.jsonl`)
    mkdirSync(join(getConfigDir(), 'agent-sessions'), { recursive: true })
    const message: SDKMessage = {
      type: 'user',
      uuid: 'compact-source',
      message: { content: [{ type: 'text', text: '需要保留的最近消息' }] },
      parent_tool_use_id: null,
    } as unknown as SDKMessage
    writeFileSync(messagesPath, `${JSON.stringify(message)}\n`, 'utf-8')

    compactSDKMessages(session.id, '已压缩摘要', 1)

    expect(getAgentSessionMeta(session.id)?.lastContextUsage).toBeUndefined()
    const archiveDir = join(getConfigDir(), 'agent-sessions', 'compaction-archive', session.id)
    const archiveFiles = readdirSync(archiveDir)
    expect(archiveFiles).toHaveLength(1)
    expect(readFileSync(join(archiveDir, archiveFiles[0]!), 'utf8')).toContain('compact-source')
  })

  test('压缩保留窗口不会从孤儿 tool_result 开始，回退到配对的 assistant', () => {
    const session = createAgentSession('compact tool pair', undefined, testWorkspaceId, undefined, 'pi')
    const messagesPath = join(getConfigDir(), 'agent-sessions', `${session.id}.jsonl`)
    mkdirSync(join(getConfigDir(), 'agent-sessions'), { recursive: true })
    // 5 条早期消息 + 配对的 tool_use/tool_result 对，
    // keepRecent=2 时切片点正好落在 tool_result user 上（孤儿）
    const history: SDKMessage[] = [
      { type: 'user', message: { content: [{ type: 'text', text: '早期 0' }] }, parent_tool_use_id: null },
      { type: 'assistant', message: { content: [{ type: 'text', text: '早期 1' }] }, parent_tool_use_id: null },
      { type: 'user', message: { content: [{ type: 'text', text: '早期 2' }] }, parent_tool_use_id: null },
      { type: 'assistant', message: { content: [{ type: 'text', text: '早期 3' }] }, parent_tool_use_id: null },
      { type: 'user', message: { content: [{ type: 'text', text: '早期 4' }] }, parent_tool_use_id: null },
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'call-1', name: 'Bash', input: {} }] }, parent_tool_use_id: null },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'call-1', content: '结果' }] }, parent_tool_use_id: 'call-1' },
      { type: 'assistant', message: { content: [{ type: 'text', text: '收尾' }] }, parent_tool_use_id: null },
    ] as unknown as SDKMessage[]
    writeFileSync(messagesPath, history.map((m) => JSON.stringify(m)).join('\n') + '\n', 'utf-8')

    const result = compactSDKMessages(session.id, '摘要', 2)

    // boundary + 回退后保留的配对段：tool_result 不能成为第一条业务消息
    const kept = result.filter((m) => m.type !== 'system')
    const firstUserWithToolResult = kept.findIndex(
      (m) => m.type === 'user' && JSON.stringify((m as { message?: { content?: unknown[] } }).message?.content)?.includes('tool_result'),
    )
    expect(firstUserWithToolResult).toBeGreaterThan(0)
    const previous = kept[firstUserWithToolResult - 1] as { message?: { content?: Array<{ type?: string }> } }
    expect(previous.message?.content?.some((b) => b.type === 'tool_use')).toBe(true)
    // 原始未受影响的消息没有丢失：tool_use 和 tool_result 都在保留段里
    expect(JSON.stringify(result)).toContain('call-1')
  })

  test('alignKeepStartToToolPairs：非 tool_result 开头时保持原起点', () => {
    const messages = [
      { type: 'assistant', message: { content: [{ type: 'text', text: 'a' }] } },
      { type: 'user', message: { content: [{ type: 'text', text: 'b' }] } },
    ] as unknown as SDKMessage[]
    expect(alignKeepStartToToolPairs(messages, 1)).toBe(1)
    expect(alignKeepStartToToolPairs(messages, 0)).toBe(0)
  })

  test('fork Provider-Agnostic 会话：复制工作区文件与 JSONL 历史', async () => {
    const sourceSession = createAgentSession('source', undefined, testWorkspaceId, undefined, 'proma')
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

  test('搜索会话引用：不带 workspaceId 时跨全部工作区搜索', () => {
    createAgentSession('Alpha 会话', undefined, testWorkspaceId)
    const wsB = createAgentWorkspace(`Second WS ${Date.now()}`)
    createAgentSession('Beta 会话', undefined, wsB.id)
    testDirs.push(getAgentWorkspacePath(wsB.slug))

    const all = searchAgentSessionReferences({})
    const titles = all.map((s) => s.title)
    expect(titles).toContain('Alpha 会话')
    expect(titles).toContain('Beta 会话')

    // 附带工作区名称，供统一命令菜单描述展示
    const alpha = all.find((s) => s.title === 'Alpha 会话')
    expect(alpha?.workspaceName).toBeDefined()
    expect(alpha?.workspaceSlug).toBeDefined()
  })

  test('搜索会话引用：指定 workspaceId 时仅返回该工作区会话', () => {
    createAgentSession('Only Me', undefined, testWorkspaceId)
    const wsB = createAgentWorkspace(`Third WS ${Date.now()}`)
    createAgentSession('Other WS', undefined, wsB.id)
    testDirs.push(getAgentWorkspacePath(wsB.slug))

    const result = searchAgentSessionReferences({ workspaceId: testWorkspaceId, limit: 20 })
    const titles = result.map((s) => s.title)
    expect(titles).toContain('Only Me')
    expect(titles).not.toContain('Other WS')
  })

  test('搜索会话引用：排除当前会话并支持标题/消息匹配', () => {
    const me = createAgentSession('当前会话标题', undefined, testWorkspaceId)
    createAgentSession('目标会话标题', undefined, testWorkspaceId)

    const result = searchAgentSessionReferences({
      excludeSessionId: me.id,
      query: '目标会话',
      limit: 10,
    })
    expect(result).toHaveLength(1)
    expect(result[0]?.title).toBe('目标会话标题')
  })
})

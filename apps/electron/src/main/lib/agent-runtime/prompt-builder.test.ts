/**
 * Agent Runtime Prompt 构建器单元测试
 */

import { afterAll, describe, test, expect } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isolateSteWritingHostDependencies } from '../testing/ste-writing-test-isolation'
import type { SDKMessage } from '@gravitas/shared'

isolateSteWritingHostDependencies()
const tempDir = mkdtempSync(join(tmpdir(), 'runtime-prompt-'))
const originalConfigDir = process.env.PROMA_TEST_CONFIG_DIR
process.env.PROMA_TEST_CONFIG_DIR = tempDir
const { buildAgentSystemPrompt, sdkMessagesToChatMessages, __resetViewTruncationThrottle } = await import('./prompt-builder')
afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true })
  if (originalConfigDir === undefined) delete process.env.PROMA_TEST_CONFIG_DIR
  else process.env.PROMA_TEST_CONFIG_DIR = originalConfigDir
})

describe('Prompt 构建器', () => {
  test('given 默认提示词 when 构建 runtime prompt then 包含 cwd 与自动化工具规则', () => {
    const prompt = buildAgentSystemPrompt(undefined, '/tmp/workspace')
    expect(prompt).toContain('/tmp/workspace')
    expect(prompt).toContain('你可以使用工具')
    expect(prompt).toContain('使用 WebSearch / WebFetch')
    expect(prompt).toContain('征求同意')
    expect(prompt).toContain('ComputerUseScreenshot')
    expect(prompt).toContain('coordinate_scale')
    expect(prompt).toContain('element_id')
  })

  test('given 自定义提示词 when 构建 runtime prompt then 保留自动化工具规则', () => {
    const prompt = buildAgentSystemPrompt('你是一个自定义助手。', '/tmp/workspace')

    expect(prompt).toContain('你是一个自定义助手。')
    expect(prompt).toContain('调用 WebBridgeScreenshot 后，必须先分析截图内容')
  })

  test('given 默认提示词 when 构建 runtime prompt then 注入任务完成态红绿灯约定', () => {
    const prompt = buildAgentSystemPrompt(undefined, '/tmp/workspace')

    expect(prompt).toContain('任务完成态红绿灯')
    expect(prompt).toContain('最后一个非空行必须是进度状态行')
    expect(prompt).toContain('🟢')
    expect(prompt).toContain('🟡')
    expect(prompt).toContain('🔴')
  })

  test('sdkMessagesToChatMessages 转换文本对话', () => {
    const messages: SDKMessage[] = [
      {
        type: 'user',
        message: { content: [{ type: 'text', text: '你好' }] },
        parent_tool_use_id: null,
      } as SDKMessage,
      {
        type: 'assistant',
        message: { content: [{ type: 'text', text: '有什么可以帮你？' }] },
        parent_tool_use_id: null,
      } as SDKMessage,
    ]

    const history = sdkMessagesToChatMessages(messages)

    expect(history).toHaveLength(2)
    expect(history[0]?.role).toBe('user')
    expect(history[0]?.content).toBe('你好')
    expect(history[1]?.role).toBe('assistant')
    expect(history[1]?.content).toBe('有什么可以帮你？')
  })

  test('sdkMessagesToChatMessages 序列化 tool_use/tool_result', () => {
    const messages: SDKMessage[] = [
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: '我来读取' },
            { type: 'tool_use', id: 'tc_1', name: 'Read', input: { file_path: 'note.txt' } },
          ],
        },
        parent_tool_use_id: null,
      } as SDKMessage,
      {
        type: 'user',
        message: {
          content: [{ type: 'tool_result', tool_use_id: 'tc_1', content: 'old content' }],
        },
        parent_tool_use_id: null,
      } as SDKMessage,
    ]

    const history = sdkMessagesToChatMessages(messages)

    expect(history).toHaveLength(2)
    expect(history[0]?.content).toContain('<tool_use id="tc_1" name="Read">')
    expect(history[0]?.content).toContain('file_path')
    expect(history[1]?.content).toContain('<tool_result tool_use_id="tc_1">')
    expect(history[1]?.content).toContain('old content')
  })

  test('sdkMessagesToChatMessages 只保留最近 20 条', () => {
    const messages: SDKMessage[] = Array.from({ length: 25 }, (_, i) => ({
      type: i % 2 === 0 ? 'user' : 'assistant',
      message: { content: [{ type: 'text', text: `msg ${i}` }] },
      parent_tool_use_id: null,
    } as SDKMessage))

    const history = sdkMessagesToChatMessages(messages)

    expect(history).toHaveLength(20)
    expect(history[0]?.content).toBe('msg 5')
    expect(history[19]?.content).toBe('msg 24')
  })

  test('given compact boundary when rebuilding history then summary remains model-visible', () => {
    const messages: SDKMessage[] = [
      {
        type: 'system',
        subtype: 'compact_boundary',
        summary: '此前已经完成数据库迁移，下一步运行回归测试。',
        contextPacket: { version: 1, summary: '此前已经完成数据库迁移，下一步运行回归测试。' },
      } as unknown as SDKMessage,
      ...Array.from({ length: 20 }, (_, i) => ({
        type: i % 2 === 0 ? 'user' : 'assistant',
        message: { content: [{ type: 'text', text: `recent ${i}` }] },
        parent_tool_use_id: null,
      } as SDKMessage)),
    ]

    const history = sdkMessagesToChatMessages(messages)

    expect(history).toHaveLength(21)
    expect(history[0]?.role).toBe('user')
    expect(history[0]?.content).toContain('<context_packet>')
    expect(history[0]?.content).toContain('数据库迁移')
    expect(history[20]?.content).toBe('recent 19')
  })

  test('given window starts at tool result when rebuilding history then matching tool use is backtracked', () => {
    const messages: SDKMessage[] = [
      ...Array.from({ length: 5 }, (_, i) => ({
        type: 'user',
        message: { content: [{ type: 'text', text: `old ${i}` }] },
        parent_tool_use_id: null,
      } as SDKMessage)),
      {
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: 'tc_boundary', name: 'Read', input: { file_path: 'note.txt' } }] },
        parent_tool_use_id: null,
      } as SDKMessage,
      {
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'tc_boundary', content: 'paired result' }] },
        parent_tool_use_id: null,
      } as SDKMessage,
      ...Array.from({ length: 19 }, (_, i) => ({
        type: i % 2 === 0 ? 'assistant' : 'user',
        message: { content: [{ type: 'text', text: `recent ${i}` }] },
        parent_tool_use_id: null,
      } as SDKMessage)),
    ]

    const history = sdkMessagesToChatMessages(messages)

    expect(history).toHaveLength(21)
    expect(history[0]?.content).toContain('<tool_use id="tc_boundary"')
    expect(history[1]?.content).toContain('<tool_result tool_use_id="tc_boundary">')
  })

  test('given orphan tool result in old history when rebuilding then it is filtered but user text remains', () => {
    const history = sdkMessagesToChatMessages([{
      type: 'user',
      message: {
        content: [
          { type: 'tool_result', tool_use_id: 'missing', content: 'orphan' },
          { type: 'text', text: '继续处理当前任务' },
        ],
      },
      parent_tool_use_id: null,
    } as SDKMessage])

    expect(history).toHaveLength(1)
    expect(history[0]?.content).toBe('继续处理当前任务')
    expect(history[0]?.content).not.toContain('orphan')
  })
})

describe('buildAgentSystemPrompt 注入 available_skills', () => {
  test('given skillContext 时注入 available_skills 清单与 ReadSkill 指引', () => {
    const prompt = buildAgentSystemPrompt(undefined, '/tmp/workspace', {
      workspaceSlug: 'ws',
      skills: [
        { slug: 'code-review', name: '代码审查', description: '审查 diff', enabled: true },
        { slug: 'bug-hunt', name: 'Bug 排查', enabled: true },
      ],
    })
    expect(prompt).toContain('<available_skills>')
    expect(prompt).toContain('- code-review: 代码审查（审查 diff）')
    expect(prompt).toContain('- bug-hunt: Bug 排查')
    expect(prompt).toContain('必须先调用 ReadSkill 读取其 SKILL.md 全文')
    expect(prompt).toContain('</available_skills>')
  })

  test('given 无 enabled skill 时不注入 available_skills', () => {
    const prompt = buildAgentSystemPrompt(undefined, '/tmp/workspace', {
      workspaceSlug: 'ws',
      skills: [{ slug: 'disabled-skill', name: '禁用', enabled: false }],
    })
    expect(prompt).not.toContain('<available_skills>')
  })

  test('given 无 skillContext 时不注入 available_skills', () => {
    const prompt = buildAgentSystemPrompt(undefined, '/tmp/workspace')
    expect(prompt).not.toContain('<available_skills>')
  })
})

describe('视图层历史截断审计', () => {
  function makeHistory(count: number, sessionId: string): SDKMessage[] {
    return Array.from({ length: count }, (_, i) => ({
      type: i % 2 === 0 ? 'user' : 'assistant',
      message: { content: [{ type: 'text', text: `消息 ${i}` }] },
      parent_tool_use_id: null,
      session_id: sessionId,
      uuid: `m-${i}`,
    } as SDKMessage))
  }

  async function readAuditEvents(): Promise<Array<Record<string, unknown>>> {
    const { readFile } = await import('node:fs/promises')
    try {
      const raw = await readFile(join(tempDir, 'context-compaction-audit', 'events.jsonl'), 'utf8')
      return raw.split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line) as Record<string, unknown>)
    } catch {
      return []
    }
  }

  test('无 boundary 且超限时记录丢弃条数', async () => {
    __resetViewTruncationThrottle()
    const before = (await readAuditEvents()).length
    sdkMessagesToChatMessages(makeHistory(100, 'view-1'))
    const events = await readAuditEvents()
    expect(events.length).toBe(before + 1)
    const truncation = events[events.length - 1]?.viewTruncation as { droppedMessages: number; reason: string } | undefined
    // 100 条历史只保留最近 MAX_HISTORY_MESSAGES(20) 条
    expect(truncation?.droppedMessages).toBe(80)
    expect(truncation?.reason).toBe('max_history_messages')
  })

  test('同一 session 60 秒内只记录一次', async () => {
    __resetViewTruncationThrottle()
    const before = (await readAuditEvents()).length
    sdkMessagesToChatMessages(makeHistory(100, 'view-2'))
    sdkMessagesToChatMessages(makeHistory(100, 'view-2'))
    sdkMessagesToChatMessages(makeHistory(100, 'view-2'))
    expect((await readAuditEvents()).length).toBe(before + 1)
  })

  test('历史未超限时不记录', async () => {
    __resetViewTruncationThrottle()
    const before = (await readAuditEvents()).length
    sdkMessagesToChatMessages(makeHistory(5, 'view-3'))
    expect((await readAuditEvents()).length).toBe(before)
  })

  test('存在 compact_boundary 时保留摘要之后全部历史且不记录截断', async () => {
    __resetViewTruncationThrottle()
    const before = (await readAuditEvents()).length
    const history = makeHistory(100, 'view-4')
    history[0] = {
      type: 'system',
      subtype: 'compact_boundary',
      session_id: 'view-4',
      summary: '交接摘要',
    } as unknown as SDKMessage
    const result = sdkMessagesToChatMessages(history)
    expect(result).toHaveLength(100)
    expect(result[1]?.content).toContain("消息 1")
    expect((await readAuditEvents()).length).toBe(before)
  })
})

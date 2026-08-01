/**
 * Agent Runtime Prompt 构建器单元测试
 */

import { describe, test, expect } from 'bun:test'
import { buildAgentSystemPrompt, sdkMessagesToChatMessages } from './prompt-builder'
import type { SDKMessage } from '@proma/shared'

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
    expect(prompt).toContain('调用 WebBridgeScreenshot 或 ComputerUseScreenshot 后，必须先分析截图内容')
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

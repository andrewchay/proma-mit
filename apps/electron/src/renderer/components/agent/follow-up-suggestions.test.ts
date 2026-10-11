import { describe, expect, test } from 'bun:test'
import { deriveFollowUpSuggestions, sliceLastTurn } from './follow-up-suggestions'
import type { SDKMessage, SDKAssistantMessage, SDKUserMessage } from '@gravitas/shared'

function userInput(text: string): SDKUserMessage {
  return { type: 'user', message: { content: [{ type: 'text', text }] } } as unknown as SDKUserMessage
}

function assistantWithTools(...toolUses: Array<{ id: string; name: string; input: Record<string, unknown> }>): SDKAssistantMessage {
  return {
    type: 'assistant',
    message: { content: toolUses.map((tu) => ({ type: 'tool_use', id: tu.id, name: tu.name, input: tu.input })) },
  } as unknown as SDKAssistantMessage
}

function userWithResults(...results: Array<{ toolUseId: string; isError: boolean }>): SDKUserMessage {
  return {
    type: 'user',
    message: { content: results.map((r) => ({ type: 'tool_result', tool_use_id: r.toolUseId, is_error: r.isError })) },
  } as unknown as SDKUserMessage
}

describe('follow-up 建议 —— 最后一轮切分', () => {
  test('只取最后一条用户输入之后的消息', () => {
    const messages = [
      userInput('第一问'),
      assistantWithTools({ id: 't0', name: 'Read', input: {} }),
      userInput('第二问'),
      assistantWithTools({ id: 't1', name: 'Edit', input: { file_path: '/a.ts' } }),
    ] as SDKMessage[]
    const turn = sliceLastTurn(messages)
    expect(turn).toHaveLength(2)
  })
})

describe('follow-up 建议 —— 启发式生成', () => {
  test('有代码改动但没跑测试 → 建议验证', () => {
    const messages = [
      userInput('改一下'),
      assistantWithTools({ id: 't1', name: 'Edit', input: { file_path: '/a.ts', old_string: 'a', new_string: 'b' } }),
    ] as SDKMessage[]
    expect(deriveFollowUpSuggestions(messages)).toEqual(['运行相关测试，验证刚才的改动是否符合预期'])
  })

  test('测试命令失败 → 优先建议修复', () => {
    const messages = [
      userInput('跑测试'),
      assistantWithTools({ id: 't1', name: 'Bash', input: { command: 'bun test' } }),
      userWithResults({ toolUseId: 't1', isError: true }),
    ] as SDKMessage[]
    expect(deriveFollowUpSuggestions(messages)).toEqual(['测试有失败，先查看失败详情并修复失败的用例'])
  })

  test('改动后已跑过测试（通过）→ 不再建议验证', () => {
    const messages = [
      userInput('改并验证'),
      assistantWithTools(
        { id: 't1', name: 'Edit', input: { file_path: '/a.ts', old_string: 'a', new_string: 'b' } },
        { id: 't2', name: 'Bash', input: { command: 'bun test' } },
      ),
      userWithResults({ toolUseId: 't2', isError: false }),
    ] as SDKMessage[]
    expect(deriveFollowUpSuggestions(messages)).toEqual([])
  })

  test('纯提交 → 建议推送', () => {
    const messages = [
      userInput('提交'),
      assistantWithTools({ id: 't1', name: 'Bash', input: { command: 'git commit -m "x"' } }),
    ] as SDKMessage[]
    expect(deriveFollowUpSuggestions(messages)).toEqual(['把当前提交推送到远端仓库'])
  })

  test('联网检索 → 建议整理要点', () => {
    const messages = [
      userInput('查一下'),
      assistantWithTools({ id: 't1', name: 'WebSearch', input: { query: 'gravitas' } }),
    ] as SDKMessage[]
    expect(deriveFollowUpSuggestions(messages)).toEqual(['把刚才搜集到的信息整理成要点总结'])
  })

  test('纯只读探索轮不打扰', () => {
    const messages = [
      userInput('看看代码'),
      assistantWithTools(
        { id: 't1', name: 'Read', input: { file_path: '/a.ts' } },
        { id: 't2', name: 'Grep', input: { pattern: 'foo' } },
      ),
    ] as SDKMessage[]
    expect(deriveFollowUpSuggestions(messages)).toEqual([])
  })

  test('无工具调用的纯问答轮不打扰', () => {
    const messages = [userInput('你好')] as SDKMessage[]
    expect(deriveFollowUpSuggestions(messages)).toEqual([])
  })

  test('最多返回 2 条且去重', () => {
    const messages = [
      userInput('改并查资料'),
      assistantWithTools(
        { id: 't1', name: 'Edit', input: { file_path: '/a.ts', old_string: 'a', new_string: 'b' } },
        { id: 't2', name: 'WebSearch', input: { query: 'x' } },
      ),
    ] as SDKMessage[]
    const suggestions = deriveFollowUpSuggestions(messages)
    expect(suggestions).toHaveLength(2)
    expect(new Set(suggestions).size).toBe(2)
  })
})

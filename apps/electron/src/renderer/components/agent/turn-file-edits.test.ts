import { describe, expect, test } from 'bun:test'
import { collectFileChanges } from './turn-file-edits'
import type { SDKMessage, SDKAssistantMessage, SDKUserMessage } from '@gravitas/shared'

function assistantWithToolUses(...toolUses: Array<{ id: string; name: string; input: Record<string, unknown> }>): SDKAssistantMessage {
  return {
    type: 'assistant',
    message: { content: toolUses.map((tu) => ({ type: 'tool_use', id: tu.id, name: tu.name, input: tu.input })) },
  } as unknown as SDKAssistantMessage
}

function userWithToolResults(...results: Array<{ toolUseId: string; isError: boolean }>): SDKUserMessage {
  return {
    type: 'user',
    message: { content: results.map((r) => ({ type: 'tool_result', tool_use_id: r.toolUseId, is_error: r.isError })) },
  } as unknown as SDKUserMessage
}

describe('Turn 级文件改动收集', () => {
  test('Edit 工具收集 old/new 片段并按文件归组', () => {
    const messages = [
      assistantWithToolUses(
        { id: 't1', name: 'Edit', input: { file_path: '/a.ts', old_string: 'foo', new_string: 'bar' } },
        { id: 't2', name: 'Edit', input: { file_path: '/a.ts', old_string: 'baz', new_string: 'qux' } },
        { id: 't3', name: 'Edit', input: { file_path: '/b.ts', old_string: 'x', new_string: 'y' } },
      ),
    ] as SDKMessage[]
    const changes = collectFileChanges(messages)
    expect(changes.map((c) => c.path)).toEqual(['/a.ts', '/b.ts'])
    expect(changes[0]?.ops).toEqual([
      { oldStr: 'foo', newStr: 'bar' },
      { oldStr: 'baz', newStr: 'qux' },
    ])
  })

  test('MultiEdit 展开为多段操作', () => {
    const messages = [
      assistantWithToolUses({
        id: 't1',
        name: 'MultiEdit',
        input: {
          file_path: '/a.ts',
          edits: [
            { old_string: 'a', new_string: 'b' },
            { old_string: 'c', new_string: 'd' },
          ],
        },
      }),
    ] as SDKMessage[]
    const changes = collectFileChanges(messages)
    expect(changes[0]?.ops).toHaveLength(2)
  })

  test('Write 工具计入文件列表但无 diff 片段', () => {
    const messages = [
      assistantWithToolUses({ id: 't1', name: 'Write', input: { file_path: '/new.ts', content: 'full' } }),
    ] as SDKMessage[]
    const changes = collectFileChanges(messages)
    expect(changes).toEqual([{ path: '/new.ts', ops: [] }])
  })

  test('失败的工具调用被排除', () => {
    const messages = [
      assistantWithToolUses(
        { id: 't1', name: 'Edit', input: { file_path: '/ok.ts', old_string: 'a', new_string: 'b' } },
        { id: 't2', name: 'Edit', input: { file_path: '/fail.ts', old_string: 'a', new_string: 'b' } },
      ),
      userWithToolResults({ toolUseId: 't2', isError: true }),
    ] as SDKMessage[]
    const changes = collectFileChanges(messages)
    expect(changes.map((c) => c.path)).toEqual(['/ok.ts'])
  })

  test('非修改类工具被忽略', () => {
    const messages = [
      assistantWithToolUses({ id: 't1', name: 'Read', input: { file_path: '/a.ts' } }),
    ] as SDKMessage[]
    expect(collectFileChanges(messages)).toEqual([])
  })
})

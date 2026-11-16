import { expect, test } from 'bun:test'
import { migrateLegacyTabState, persistSessionOnUnload } from './session-state'

const valid = new Set(['conv-1', 'conv-2', 'sess-1', 'sess-2'])

test('Given 旧标签状态 When activeTabId 命中 Then 恢复该会话', () => {
  expect(migrateLegacyTabState({
    tabs: [
      { type: 'chat', sessionId: 'conv-1' },
      { type: 'agent', sessionId: 'sess-1' },
    ],
    activeTabId: 'sess-1',
  }, valid)).toEqual({ mode: 'agent', conversationId: null, agentSessionId: 'sess-1' })
})

test('Given 旧标签状态 When activeTabId 指向已删除会话 Then 回退第一个可用标签', () => {
  expect(migrateLegacyTabState({
    tabs: [
      { type: 'chat', sessionId: 'deleted' },
      { type: 'agent', sessionId: 'sess-1' },
    ],
    activeTabId: 'deleted',
  }, valid)).toEqual({ mode: 'agent', conversationId: null, agentSessionId: 'sess-1' })
})

test('Given 分屏时代结构 When 无 activeTabId Then 用焦点面板的标签', () => {
  expect(migrateLegacyTabState({
    tabs: [
      { type: 'chat', sessionId: 'conv-1' },
      { type: 'chat', sessionId: 'conv-2' },
    ],
    splitLayout: { focusedPanelIndex: 1, panels: [{ activeTabId: 'conv-1' }, { activeTabId: 'conv-2' }] },
  }, valid)).toEqual({ mode: 'chat', conversationId: 'conv-2', agentSessionId: null })
})

test('Given 分屏结构 When focusedPanelIndex 越界 Then 回退首个面板', () => {
  expect(migrateLegacyTabState({
    tabs: [{ type: 'chat', sessionId: 'conv-1' }],
    splitLayout: { focusedPanelIndex: 9, panels: [{ activeTabId: 'conv-1' }] },
  }, valid)).toEqual({ mode: 'chat', conversationId: 'conv-1', agentSessionId: null })
})

test('Given 全部会话已失效 When 迁移 Then 返回 null 而不是恢复空会话', () => {
  expect(migrateLegacyTabState({
    tabs: [{ type: 'chat', sessionId: 'gone' }],
    activeTabId: 'gone',
  }, valid)).toBeNull()
})

test('Given 畸形输入 When 迁移 Then 一律返回 null 而不抛错', () => {
  expect(migrateLegacyTabState(null, valid)).toBeNull()
  expect(migrateLegacyTabState(undefined, valid)).toBeNull()
  expect(migrateLegacyTabState('nope', valid)).toBeNull()
  expect(migrateLegacyTabState({}, valid)).toBeNull()
  expect(migrateLegacyTabState({ tabs: 'not-an-array' }, valid)).toBeNull()
  expect(migrateLegacyTabState({ tabs: [null, 42, { type: 'chat' }] }, valid)).toBeNull()
})

test('Given 未知标签类型 When 迁移 Then 跳过该标签', () => {
  expect(migrateLegacyTabState({
    tabs: [
      { type: 'scratch', sessionId: 'scratch-1' },
      { type: 'agent', sessionId: 'sess-2' },
    ],
    activeTabId: 'scratch-1',
  }, valid)).toEqual({ mode: 'agent', conversationId: null, agentSessionId: 'sess-2' })
})

test('Given chat 类型 When 迁移 Then 只填 conversationId', () => {
  const result = migrateLegacyTabState({ tabs: [{ type: 'chat', sessionId: 'conv-1' }] }, valid)
  expect(result).toEqual({ mode: 'chat', conversationId: 'conv-1', agentSessionId: null })
})


test('Given 恢复未完成或读取失败 When 退出 Then 不覆盖上次会话；恢复完成后同步保存', () => {
  const state = { mode: 'agent' as const, conversationId: null, agentSessionId: null }
  const writes: unknown[] = []
  const sync = (value: unknown): boolean => { writes.push(value); return true }
  let fallback = 0
  const save = (): void => { fallback++ }
  persistSessionOnUnload(false, false, state, sync, save)
  persistSessionOnUnload(true, false, state, sync, save)
  expect(writes).toHaveLength(0)
  expect(fallback).toBe(0)
  persistSessionOnUnload(true, true, state, sync, save)
  expect(writes).toEqual([{ lastSession: state }])
  persistSessionOnUnload(true, true, state, () => false, save)
  expect(fallback).toBe(1)
})

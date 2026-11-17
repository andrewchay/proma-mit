import { expect, test } from 'bun:test'
import { createStore } from 'jotai'
import { agentSessionPendingFilesAtom, agentStreamingStatesAtom, liveMessagesMapAtom } from '../atoms/agent-atoms'
import { cleanupRetiredAgentSession } from './retired-agent-session'

test('Given 归档会话仍在执行 When 清理 Then 保留流式状态与附件直到结束', () => {
  const store = createStore()
  const cached = new Map([['file-1', 'private-data']])
  Object.defineProperty(globalThis, 'window', { value: { __pendingAgentFileData: cached }, configurable: true })
  const url = URL.createObjectURL(new Blob(['data']))
  store.set(agentSessionPendingFilesAtom, new Map([['session-1', [{ id: 'file-1', filename: 'file', size: 4, mediaType: 'text/plain', previewUrl: url }]]]))
  store.set(agentStreamingStatesAtom, new Map([['session-1', { running: true, content: 'live', toolActivities: [] }]]))
  expect(cleanupRetiredAgentSession(store, 'session-1')).toBe(false)
  expect(store.get(agentSessionPendingFilesAtom).has('session-1')).toBe(true)
  expect(cached.has('file-1')).toBe(true)
  store.set(agentStreamingStatesAtom, new Map([['session-1', { running: false, content: 'done', toolActivities: [] }]]))
  store.set(liveMessagesMapAtom, new Map([['session-1', []]]))
  expect(cleanupRetiredAgentSession(store, 'session-1')).toBe(true)
  expect(store.get(agentSessionPendingFilesAtom).has('session-1')).toBe(false)
  expect(store.get(agentStreamingStatesAtom).has('session-1')).toBe(false)
  expect(store.get(liveMessagesMapAtom).has('session-1')).toBe(false)
  expect(cached.has('file-1')).toBe(false)
})

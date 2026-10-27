import { expect, test } from 'bun:test'
import type { PermissionRequest } from '@gravitas/shared'
import { mergePendingAgentRequestSnapshot } from './pending-agent-request-recovery'

function request(requestId: string, sessionId: string): PermissionRequest {
  return { requestId, sessionId, toolName: 'Write', toolInput: {}, description: 'test', dangerLevel: 'normal' }
}

test('Given Renderer重载期间实时事件已到达 When恢复主进程权限快照 Then按会话合并且不重复', () => {
  const live = request('live', 'session-a')
  const restored = request('restored', 'session-b')
  const result = mergePendingAgentRequestSnapshot(
    new Map([['session-a', [live]]]),
    [live, restored],
    new Set(),
  )

  expect(result).toEqual(new Map([
    ['session-a', [live]],
    ['session-b', [restored]],
  ]))
})

test('Given快照读取期间权限已被其他入口解决 When恢复快照 Then不复活旧请求', () => {
  const live = request('live', 'session-a')
  const alreadyResolved = request('resolved', 'session-b')
  const result = mergePendingAgentRequestSnapshot(
    new Map([['session-a', [live]]]),
    [alreadyResolved],
    new Set(['resolved']),
  )

  expect(result).toEqual(new Map([['session-a', [live]]]))
})

test('Given快照读取期间较新的实时权限事件已到达 When恢复快照 Then保留同会话请求FIFO顺序', () => {
  const older = request('older', 'session-a')
  const newer = request('newer', 'session-a')
  const result = mergePendingAgentRequestSnapshot(
    new Map([['session-a', [newer]]]),
    [older],
    new Set(),
  )

  expect(result).toEqual(new Map([['session-a', [older, newer]]]))
})

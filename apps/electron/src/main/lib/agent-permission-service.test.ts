import { describe, expect, test } from 'bun:test'
import { AgentPermissionService, type CanUseToolOptions } from './agent-permission-service'
import type { PermissionRequest } from '@proma/shared'

function createOptions(overrides: Partial<CanUseToolOptions> = {}): CanUseToolOptions {
  return {
    signal: new AbortController().signal,
    toolUseID: 'tool-use-test',
    ...overrides,
  }
}

describe('AgentPermissionService safe 权限模式', () => {
  test('given safe mode when using read-only tools then permission is allowed without prompting', async () => {
    const service = new AgentPermissionService()
    const requests: PermissionRequest[] = []
    const canUseTool = service.createCanUseTool(
      'session-safe-read',
      (request) => requests.push(request),
      undefined,
      undefined,
      'safe',
    )

    const readResult = await canUseTool('Read', { file_path: 'README.md' }, createOptions())
    const bashResult = await canUseTool('Bash', { command: 'ls -la' }, createOptions())

    expect(readResult.behavior).toBe('allow')
    expect(bashResult.behavior).toBe('allow')
    expect(requests).toHaveLength(0)
  })

  test('given safe mode when using write tools then permission is denied without prompting', async () => {
    const service = new AgentPermissionService()
    const requests: PermissionRequest[] = []
    const canUseTool = service.createCanUseTool(
      'session-safe-write',
      (request) => requests.push(request),
      undefined,
      undefined,
      'safe',
    )

    const writeResult = await canUseTool('Write', { file_path: 'note.txt', content: 'hello' }, createOptions())
    const bashResult = await canUseTool('Bash', { command: 'echo hello > note.txt' }, createOptions())

    expect(writeResult.behavior).toBe('deny')
    expect(bashResult.behavior).toBe('deny')
    expect(requests).toHaveLength(0)
  })

  test('given a tool was always allowed in auto mode when switching to safe mode then whitelist does not bypass safe denial', async () => {
    const service = new AgentPermissionService()
    const requests: PermissionRequest[] = []
    let currentMode: 'auto' | 'safe' = 'auto'
    const canUseTool = service.createCanUseTool(
      'session-safe-whitelist',
      (request) => requests.push(request),
      undefined,
      undefined,
      () => currentMode,
    )

    const pendingPermission = canUseTool('Write', { file_path: 'note.txt', content: 'hello' }, createOptions())
    expect(requests).toHaveLength(1)
    const sessionId = service.respondToPermission(requests[0]!.requestId, 'allow', true)
    expect(sessionId).toBe('session-safe-whitelist')
    expect((await pendingPermission).behavior).toBe('allow')

    currentMode = 'safe'
    const safeResult = await canUseTool('Write', { file_path: 'note.txt', content: 'hello' }, createOptions())

    expect(safeResult.behavior).toBe('deny')
    expect(requests).toHaveLength(1)
  })

  test('given Computer Use is approved with always allow when invoked again then every action still requests approval', async () => {
    const service = new AgentPermissionService()
    const requests: PermissionRequest[] = []
    const canUseTool = service.createCanUseTool('session-computer-use', (request) => requests.push(request), undefined, undefined, 'auto')

    const first = canUseTool('ComputerUseClick', { x: 10, y: 20 }, createOptions({ agentID: 'child-agent' }))
    expect(requests).toHaveLength(1)
    service.respondToPermission(requests[0]!.requestId, 'allow', true)
    expect((await first).behavior).toBe('allow')

    const second = canUseTool('ComputerUseClick', { x: 30, y: 40 }, createOptions())
    expect(requests).toHaveLength(2)
    service.respondToPermission(requests[1]!.requestId, 'deny', false)
    expect((await second).behavior).toBe('deny')
  })

  test('given Web Bridge navigation is approved with always allow when invoked again then every action still requests approval', async () => {
    const service = new AgentPermissionService()
    const requests: PermissionRequest[] = []
    const canUseTool = service.createCanUseTool('session-web-bridge', (request) => requests.push(request), undefined, undefined, 'auto')

    const first = canUseTool('WebBridgeNavigate', { url: 'https://example.com' }, createOptions())
    expect(requests).toHaveLength(1)
    service.respondToPermission(requests[0]!.requestId, 'allow', true)
    expect((await first).behavior).toBe('allow')

    const second = canUseTool('WebBridgeNavigate', { url: 'https://example.org' }, createOptions())
    expect(requests).toHaveLength(2)
    service.respondToPermission(requests[1]!.requestId, 'deny', false)
    expect((await second).behavior).toBe('deny')
  })
})

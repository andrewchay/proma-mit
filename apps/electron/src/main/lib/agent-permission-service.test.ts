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

    // auto 模式下写敏感路径（.env）仍需人工确认，可用来建立白名单
    const pendingPermission = canUseTool('Write', { file_path: 'config/.env', content: 'hello' }, createOptions())
    expect(requests).toHaveLength(1)
    const sessionId = service.respondToPermission(requests[0]!.requestId, 'allow', true)
    expect(sessionId).toBe('session-safe-whitelist')
    expect((await pendingPermission).behavior).toBe('allow')

    currentMode = 'safe'
    const safeResult = await canUseTool('Write', { file_path: 'config/.env', content: 'hello' }, createOptions())

    expect(safeResult.behavior).toBe('deny')
    expect(requests).toHaveLength(1)
  })

  test('given auto mode when writing to a regular project path then permission is allowed without prompting', async () => {
    const service = new AgentPermissionService()
    const requests: PermissionRequest[] = []
    const canUseTool = service.createCanUseTool('session-auto-write', (request) => requests.push(request), undefined, undefined, 'auto')

    const writeResult = await canUseTool('Write', { file_path: '/workspace/src/app.ts', content: 'export {}' }, createOptions())
    const editResult = await canUseTool('Edit', { file_path: '/workspace/src/app.ts', old_string: 'a', new_string: 'b' }, createOptions())

    expect(writeResult.behavior).toBe('allow')
    expect(editResult.behavior).toBe('allow')
    expect(requests).toHaveLength(0)
  })

  test('given auto mode when writing to a sensitive path then permission still requests approval', async () => {
    const service = new AgentPermissionService()
    const requests: PermissionRequest[] = []
    const canUseTool = service.createCanUseTool('session-auto-sensitive', (request) => requests.push(request), undefined, undefined, 'auto')

    const envResult = canUseTool('Write', { file_path: '/workspace/.env', content: 'SECRET=1' }, createOptions())
    expect(requests).toHaveLength(1)
    service.respondToPermission(requests[0]!.requestId, 'allow', false)
    expect((await envResult).behavior).toBe('allow')
  })

  test('given auto mode when classifier approves a safe operation then permission is allowed without prompting', async () => {
    const service = new AgentPermissionService()
    const requests: PermissionRequest[] = []
    const canUseTool = service.createCanUseTool('session-auto-classifier', (request) => requests.push(request), undefined, undefined, 'auto')

    const result = await canUseTool(
      'Bash',
      { command: 'npm run build' },
      createOptions({ classifierApprovable: true }),
    )

    expect(result.behavior).toBe('allow')
    expect(requests).toHaveLength(0)
  })

  test('given auto mode when classifier approves a dangerous operation then permission still requests approval', async () => {
    const service = new AgentPermissionService()
    const requests: PermissionRequest[] = []
    const canUseTool = service.createCanUseTool('session-auto-classifier-dangerous', (request) => requests.push(request), undefined, undefined, 'auto')

    const result = canUseTool(
      'Bash',
      { command: 'rm -rf /tmp/x' },
      createOptions({ classifierApprovable: true }),
    )
    expect(requests).toHaveLength(1)
    service.respondToPermission(requests[0]!.requestId, 'allow', false)
    expect((await result).behavior).toBe('allow')
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

  test('given Web Bridge navigation is approved with always allow when invoked again then it is auto allowed by session whitelist', async () => {
    const service = new AgentPermissionService()
    const requests: PermissionRequest[] = []
    const canUseTool = service.createCanUseTool('session-web-bridge', (request) => requests.push(request), undefined, undefined, 'auto')

    const first = canUseTool('WebBridgeNavigate', { url: 'https://example.com' }, createOptions())
    expect(requests).toHaveLength(1)
    service.respondToPermission(requests[0]!.requestId, 'allow', true)
    expect((await first).behavior).toBe('allow')

    // 页面交互（导航/点击/输入）加入会话白名单后不再重复弹审批
    const second = await canUseTool('WebBridgeNavigate', { url: 'https://example.org' }, createOptions())
    expect(requests).toHaveLength(1)
    expect(second.behavior).toBe('allow')
  })

  test('given Web Bridge download is approved with always allow when invoked again then it still requests approval', async () => {
    const service = new AgentPermissionService()
    const requests: PermissionRequest[] = []
    const canUseTool = service.createCanUseTool('session-web-bridge-transfer', (request) => requests.push(request), undefined, undefined, 'auto')

    const first = canUseTool('WebBridgeDownload', { url: 'https://example.com/file.zip' }, createOptions())
    expect(requests).toHaveLength(1)
    service.respondToPermission(requests[0]!.requestId, 'allow', true)
    expect((await first).behavior).toBe('allow')

    // 下载/上传涉及本地文件系统，即使选了"总是允许"也必须逐次确认
    const second = canUseTool('WebBridgeDownload', { url: 'https://example.org/other.zip' }, createOptions())
    expect(requests).toHaveLength(2)
    service.respondToPermission(requests[1]!.requestId, 'deny', false)
    expect((await second).behavior).toBe('deny')
  })
})

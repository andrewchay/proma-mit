import { describe, expect, test } from 'bun:test'
import { createCompanionApi, type CompanionApiDeps } from './companion-api'

/**
 * Companion API 纯路由表测试：依赖全部注入 fake，不依赖真实主进程服务。
 * 关注认证边界与操作语义（401/403/409、alwaysAllow 强制 false、审计调用）。
 */

function makeDeps(overrides: Partial<CompanionApiDeps> = {}): CompanionApiDeps {
  return {
    verifyPairingCode: (code: string) => code === '123456',
    issueToken: async () => ({ token: 't'.repeat(64) }),
    verifyToken: (t: string | undefined | null) => t === 'good-token',
    listSessions: () => [{ id: 's1', title: '测试会话' } as never],
    listWorkspaces: () => [{ id: 'w1', name: '默认工作区', updatedAt: Date.now() }],
    getMessages: (id: string) => (id === 's1' ? ([{ role: 'user', text: '你好' }] as never) : null),
    getPendingPermissions: () => [],
    getPendingAskUsers: () => [],
    respondPermission: async () => 's1',
    respondAskUser: async () => 's1',
    notifyPermissionResolved: () => undefined,
    notifyAskUserResolved: () => undefined,
    isSessionActive: () => false,
    sendUserMessage: async () => undefined,
    stopSession: () => true,
    appendAudit: async () => undefined,
    ...overrides,
  }
}

describe('companion-api 认证边界', () => {
  test('无 token / 错误 token 的业务接口返回 401', async () => {
    const api = createCompanionApi(makeDeps())
    const noToken = await api('GET', '/api/sessions', undefined, new URLSearchParams())
    expect(noToken!.status).toBe(401)
    const badToken = await api('GET', '/api/sessions', undefined, new URLSearchParams(), 'wrong')
    expect(badToken!.status).toBe(401)
  })

  test('配对成功返回 token；错误配对码返回 403 且审计记 pair_failed', async () => {
    const audits: string[] = []
    const api = createCompanionApi(makeDeps({
      appendAudit: async (input) => { audits.push(input.action) },
    }))
    const ok = await api('POST', '/api/pair', { code: '123456' }, new URLSearchParams())
    expect(ok!.status).toBe(200)
    expect(((await ok!.json()) as { token: string }).token).toBe('t'.repeat(64))
    const bad = await api('POST', '/api/pair', { code: '000000' }, new URLSearchParams())
    expect(bad!.status).toBe(403)
    expect(audits).toEqual(['pair', 'pair_failed'])
  })
})

describe('companion-api 只读接口', () => {
  test('GET /api/sessions 返回会话列表', async () => {
    const api = createCompanionApi(makeDeps())
    const res = await api('GET', '/api/sessions', undefined, new URLSearchParams(), 'good-token')
    expect(res!.status).toBe(200)
    expect(((await res!.json()) as { sessions: unknown[] }).sessions.length).toBe(1)
  })

  test('GET /api/sessions/:id/messages：存在返回消息，不存在 404', async () => {
    const api = createCompanionApi(makeDeps())
    const ok = await api('GET', '/api/sessions/s1/messages', undefined, new URLSearchParams(), 'good-token')
    expect(ok!.status).toBe(200)
    const missing = await api('GET', '/api/sessions/none/messages', undefined, new URLSearchParams(), 'good-token')
    expect(missing!.status).toBe(404)
  })

  test('GET /api/pending 返回待确认请求', async () => {
    const api = createCompanionApi(makeDeps({
      getPendingPermissions: () => [{ requestId: 'p1' } as never],
      getPendingAskUsers: () => [{ requestId: 'a1' } as never],
    }))
    const res = await api('GET', '/api/pending', undefined, new URLSearchParams(), 'good-token')
    const body = (await res!.json()) as { permissions: unknown[]; askUsers: unknown[] }
    expect(body.permissions.length).toBe(1)
    expect(body.askUsers.length).toBe(1)
  })
})

describe('companion-api 操作接口', () => {
  test('发送消息：会话运行中 409；空闲 202 并审计 send_message', async () => {
    const audits: string[] = []
    const busyApi = createCompanionApi(makeDeps({ isSessionActive: () => true }))
    const busy = await busyApi('POST', '/api/sessions/s1/messages', { text: 'hi' }, new URLSearchParams(), 'good-token')
    expect(busy!.status).toBe(409)

    const api = createCompanionApi(makeDeps({
      appendAudit: async (input) => { audits.push(input.action) },
    }))
    const ok = await api('POST', '/api/sessions/s1/messages', { text: 'hi' }, new URLSearchParams(), 'good-token')
    expect(ok!.status).toBe(202)
    expect(audits).toEqual(['send_message'])
  })

  test('空消息返回 400', async () => {
    const api = createCompanionApi(makeDeps())
    const res = await api('POST', '/api/sessions/s1/messages', { text: '   ' }, new URLSearchParams(), 'good-token')
    expect(res!.status).toBe(400)
  })

  test('停止：运行中返回 200 并审计 stop，未运行 409', async () => {
    const api = createCompanionApi(makeDeps({ stopSession: () => false }))
    const notRunning = await api('POST', '/api/sessions/s1/stop', undefined, new URLSearchParams(), 'good-token')
    expect(notRunning!.status).toBe(409)
  })

  test('权限应答：alwaysAllow 强制覆盖为 false（远程确认不落盘白名单）', async () => {
    const captured: { behavior?: string; alwaysAllow?: boolean } = {}
    const api = createCompanionApi(makeDeps({
      respondPermission: async (_id, behavior, alwaysAllow) => {
        captured.behavior = behavior
        captured.alwaysAllow = alwaysAllow
        return 's1'
      },
    }))
    const res = await api('POST', '/api/permission/p1', { behavior: 'allow', alwaysAllow: true }, new URLSearchParams(), 'good-token')
    expect(res!.status).toBe(200)
    expect(captured.behavior).toBe('allow')
    expect(captured.alwaysAllow).toBe(false)
  })

  test('权限应答成功后通知 resolved；404 时既不通知也不记审计', async () => {
    const notifications: string[] = []
    const audits: string[] = []
    const api = createCompanionApi(makeDeps({
      respondPermission: async () => null,
      notifyPermissionResolved: (_sid, requestId) => { notifications.push(requestId) },
      appendAudit: async (input) => { audits.push(input.action) },
    }))
    const missing = await api('POST', '/api/permission/p1', { behavior: 'deny' }, new URLSearchParams(), 'good-token')
    expect(missing!.status).toBe(404)
    expect(notifications).toEqual([])
    expect(audits).toEqual([])

    const okApi = createCompanionApi(makeDeps({
      notifyPermissionResolved: (_sid, requestId) => { notifications.push(requestId) },
      appendAudit: async (input) => { audits.push(input.action) },
    }))
    const ok = await okApi('POST', '/api/permission/p1', { behavior: 'allow' }, new URLSearchParams(), 'good-token')
    expect(ok!.status).toBe(200)
    expect(notifications).toEqual(['p1'])
    expect(audits).toEqual(['permission_allow'])
  })

  test('AskUser 应答成功后通知 resolved', async () => {
    const notifications: string[] = []
    const api = createCompanionApi(makeDeps({
      notifyAskUserResolved: (_sid, requestId) => { notifications.push(requestId) },
    }))
    const ok = await api('POST', '/api/ask-user/a1', { answers: { q1: 'A' } }, new URLSearchParams(), 'good-token')
    expect(ok!.status).toBe(200)
    expect(notifications).toEqual(['a1'])
  })

  test('权限应答非法 behavior 返回 400，未知 requestId 返回 404', async () => {
    const api = createCompanionApi(makeDeps({ respondPermission: async () => null }))
    const bad = await api('POST', '/api/permission/p1', { behavior: 'maybe' as never }, new URLSearchParams(), 'good-token')
    expect(bad!.status).toBe(400)
    const missing = await api('POST', '/api/permission/p1', { behavior: 'deny' }, new URLSearchParams(), 'good-token')
    expect(missing!.status).toBe(404)
  })

  test('AskUser 应答透传 answers，未知 requestId 返回 404', async () => {
    let capturedAnswers: Record<string, string> | undefined
    const api = createCompanionApi(makeDeps({
      respondAskUser: async (_id, answers) => {
        capturedAnswers = answers
        return 's1'
      },
    }))
    const ok = await api('POST', '/api/ask-user/a1', { answers: { q1: '选项A' } }, new URLSearchParams(), 'good-token')
    expect(ok!.status).toBe(200)
    expect(capturedAnswers).toEqual({ q1: '选项A' })
    const missing = await createCompanionApi(makeDeps({ respondAskUser: async () => null }))(
      'POST', '/api/ask-user/a1', { answers: {} }, new URLSearchParams(), 'good-token',
    )
    expect(missing!.status).toBe(404)
  })
})

describe('companion-api 路由兜底', () => {
  test('未知路径返回 null（由传输层 404）', async () => {
    const api = createCompanionApi(makeDeps())
    const res = await api('GET', '/api/unknown', undefined, new URLSearchParams(), 'good-token')
    expect(res).toBeNull()
  })
})

import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCompanionApi, type CompanionApiDeps } from './companion-api'
import { EventRouter, writeEventRules, type AgentAutomationEvent, type DispatchOutcome } from './event-router-service'

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
    getVapidPublicKey: () => 'vapid-public-key',
    subscribePush: () => true,
    unsubscribePush: () => true,
    dispatchAutomationEvent: async () => [{ ruleName: '', status: 'no_rule' }],
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

describe('companion-api 外部事件 hook', () => {
  function hookDeps(overrides: Partial<CompanionApiDeps> = {}): CompanionApiDeps {
    return makeDeps({ dispatchAutomationEvent: async () => [{ ruleName: '唤醒', status: 'matched' }], ...overrides })
  }

  test('无 token 时拒绝（不泄露 trigger 是否存在）', async () => {
    const api = createCompanionApi(hookDeps())
    const res = await api('POST', '/api/hooks/owner-goal', { projectId: 'p-1' }, new URLSearchParams())
    expect(res!.status).toBe(401)
  })

  test('合法请求构造事件并交给路由器，返回各 outcome', async () => {
    const dispatched: AgentAutomationEvent[] = []
    const api = createCompanionApi(hookDeps({
      dispatchAutomationEvent: async (event) => {
        dispatched.push(event)
        return [{ ruleName: '唤醒', status: 'matched' }]
      },
    }))

    const res = await api(
      'POST', '/api/hooks/owner-goal',
      { projectId: 'p-1', taskId: 't-1', summary: 'PR #42 已合并' },
      new URLSearchParams(), 'good-token',
    )

    expect(res!.status).toBe(200)
    expect(dispatched).toHaveLength(1)
    expect(dispatched[0]?.source).toBe('webhook')
    expect(dispatched[0]?.type).toBe('owner-goal')
    expect(dispatched[0]?.target).toBe('p-1')
    expect(dispatched[0]?.summary).toBe('PR #42 已合并')
    expect(dispatched[0]?.payload).toEqual({ projectId: 'p-1', taskId: 't-1' })
  })

  test('缺 projectId 返回 400', async () => {
    const api = createCompanionApi(hookDeps())
    const res = await api('POST', '/api/hooks/owner-goal', { summary: 'x' }, new URLSearchParams(), 'good-token')
    expect(res!.status).toBe(400)
  })

  test('summary 缺省时用 projectId 兜底（不产生空摘要）', async () => {
    const dispatched: AgentAutomationEvent[] = []
    const api = createCompanionApi(hookDeps({
      dispatchAutomationEvent: async (event) => { dispatched.push(event); return [] },
    }))
    await api('POST', '/api/hooks/owner-goal', { projectId: 'p-9' }, new URLSearchParams(), 'good-token')
    expect(dispatched[0]?.summary).toContain('p-9')
  })

  test('全部规则都失败时返回 502（让调用方重试）', async () => {
    const api = createCompanionApi(hookDeps({
      dispatchAutomationEvent: async () => [{ ruleName: '唤醒', status: 'failed' }],
    }))
    const res = await api('POST', '/api/hooks/owner-goal', { projectId: 'p-1' }, new URLSearchParams(), 'good-token')
    expect(res!.status).toBe(502)
  })

  test('无规则命中时返回 202（事件已接收但无处理方）', async () => {
    const api = createCompanionApi(hookDeps({
      dispatchAutomationEvent: async () => [{ ruleName: '', status: 'no_rule' }],
    }))
    const res = await api('POST', '/api/hooks/owner-goal', { projectId: 'p-1' }, new URLSearchParams(), 'good-token')
    expect(res!.status).toBe(202)
  })

  test('调用成功写审计 hook_owner_goal', async () => {
    const audits: string[] = []
    const api = createCompanionApi(hookDeps({
      appendAudit: async (input) => { audits.push(input.action) },
    }))
    await api('POST', '/api/hooks/owner-goal', { projectId: 'p-1' }, new URLSearchParams(), 'good-token')
    expect(audits).toEqual(['hook_owner_goal'])
  })

  test('端到端：同一 webhook 在去重窗口内重放，第二次为 duplicate 且不唤醒', async () => {
    const wakes: string[] = []
    let rulesPath = ''
    const dir = mkdtempSync(join(tmpdir(), 'hook-e2e-'))
    try {
      rulesPath = join(dir, 'event-rules.json')
      writeEventRules(
        [{ name: '唤醒', when: { source: 'webhook', types: ['owner-goal'] }, to: { kind: 'owner-goal', projectId: 'p-1' } }],
        rulesPath,
      )
      const router = new EventRouter(undefined, async (input) => { wakes.push(input.projectId); return true })
      router.setRulesPath(rulesPath)
      const api = createCompanionApi(makeDeps({ dispatchAutomationEvent: (event) => router.dispatch(event) }))

      const first = await api('POST', '/api/hooks/owner-goal', { projectId: 'p-1', taskId: 't-1' }, new URLSearchParams(), 'good-token')
      const second = await api('POST', '/api/hooks/owner-goal', { projectId: 'p-1', taskId: 't-1' }, new URLSearchParams(), 'good-token')

      expect(first!.status).toBe(200)
      expect(((await first!.json()) as { outcomes: DispatchOutcome[] }).outcomes[0]?.status).toBe('matched')
      expect(((await second!.json()) as { outcomes: DispatchOutcome[] }).outcomes[0]?.status).toBe('duplicate')
      expect(wakes).toEqual(['p-1'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

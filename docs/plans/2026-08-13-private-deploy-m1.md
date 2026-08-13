# M1 浏览器登录闭环实施计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

## 执行进度（全部完成 ✅ 2026-08-13）
- [x] **M1.1** 会话存储 + 本地管理员 scrypt（`13288ece`）
- [x] **M1.2** cookie 会话 + 复合 auth resolver（`7e5088a0`）
- [x] **M1.3** `/auth/*` 登录路由 + 挂载（`7d40a6c9`）
- [x] **M1.4** authMode 接线 + 解死锁（`d0fba83c`）
- [x] **M1.5** 端到端验收：真实 server local 登录闭环全绿（登录→cookie→RBAC→logout）；server 119 pass

**Goal:** 为私有部署提供浏览器登录闭环——支持本地用户名/密码 fallback（默认）与 OIDC Authorization Code 两种登录方式，用 HTTP-only 会话 cookie 建立认证，并把现有无状态的 Bearer-JWT/trusted-header auth 升级为"cookie 会话优先、Bearer 回退"的复合认证，从而解围当前"非 trusted-header 时必须配置 OIDC 才能启动"的死锁。

**Architecture:** 分层复合 auth resolver（cookie 会话 → Bearer JWT → trusted header）；新增 Postgres 会话存储 + 本地管理员存储（scrypt 哈希）；`/auth/*` 登录路由族（本地表单 + OIDC 授权码重定向/回调）；`PromaWebServerConfig` 增 `authMode`（local/oidc/both）与 OIDC 客户端配置。保持现有 `AgentRuntimeWebAuthResolver` 签名不变（它是可组合的纯函数），在 app.ts 中组合成复合 resolver。

**Tech Stack:** TypeScript / Bun server（`apps/server/src/`）、Postgres（`AgentRuntimePostgresClient`，同 scheduler-store/audit 的注入 mock 测试模式）、`node:crypto`（scrypt 哈希、HMAC 会话签名）、WebCrypto / `fetch`（OIDC JWKS 已复用 `jwt-auth.ts`）、HTTP-only secure cookie。

---

## 依赖与现状（已核实）

- 现有认证：`createTrustedHeaderAuth`（本地，startup policy 强制 loopback+dev）、`createOidcJwtAuth`（`jwt-auth.ts`，纯 Bearer RS256 JWT 校验，**无登录流程**）。
- `index.ts`：`if (!trustedHeaderAuth) requireEnvironment(OIDC_*)` → 无 OIDC 就无法启动（M1 死锁点）。
- `app.ts:302` `/agent/ui` 未鉴权直接返回 HTML（是登录入口面）；`app.ts:304` `const scope = await auth({ request, url })` 是唯一鉴权点，返回 undefined 则 401（当前跳转逻辑需补）。
- `AgentRuntimeWebAuthResolver = ({request,url}) => scope`——纯函数组合点。
- 无 session store、无本地用户存储。

## 阶段总览

| Task | 交付 |
|---|---|
| M1.1 | 会话存储（Postgres `proma_runtime_auth_sessions`）+ 本地管理员存储（scrypt 哈希） |
| M1.2 | cookie 会话 auth resolver（cookie→scope，回退 Bearer/trusted-header） |
| M1.3 | `/auth/*` 路由：本地表单登录 + logout + OIDC start/callback + login 页 |
| M1.4 | `index.ts`/`app.ts` 接线：`authMode` 配置、复合 resolver、启动策略解死锁 |
| M1.5 | 端到端验收：无 OIDC 可启动→本地登录→建会话→跑任务；有 OIDC 走授权码 |

每 Task TDD（先失败测试），mock Postgres + 真实部署冒烟双验证。

---

## Task M1.1：会话存储 + 本地管理员存储

**Files:**
- Create: `apps/server/src/auth-session-store.ts`
- Create: `apps/server/src/auth-session-store.test.ts`
- Create: `apps/server/src/local-admin-auth.ts`
- Create: `apps/server/src/local-admin-auth.test.ts`

### M1.1.1 会话存储

**Step 1: 写失败测试**

`auth-session-store.test.ts`（mock `AgentRuntimePostgresClient`，同 scheduler-store 模式）：

```ts
import { describe, expect, it } from 'bun:test'
import { PostgresAuthSessionStore } from './auth-session-store'

const SCOPE = { tenantId: 'tenant-a', userId: 'admin-1' }

function makeClient(rowsFor: (sql: string) => Record<string, unknown>[]) {
  const calls: string[] = []
  return {
    client: { query: async <Row extends Record<string, unknown>>(sql: string) => { calls.push(sql); return { rows: (rowsFor(sql) ?? []) as unknown as Row[] } } },
    calls,
  }
}

describe('PostgresAuthSessionStore', () => {
  it('initializeSchema 创建会话表（幂等）', async () => {
    const { client, calls } = makeClient(() => [])
    const store = new PostgresAuthSessionStore(client)
    await store.initializeSchema()
    expect(calls[0]).toContain('CREATE TABLE IF NOT EXISTS proma_runtime_auth_sessions')
  })

  it('create 写入会话；get 按 sessionId 读取并校验未过期', async () => {
    const store = new PostgresAuthSessionStore(makeClient(() => []).client)
    const future = Date.now() + 60_000
    const rows = [{ session_id: 's1', tenant_id: 'tenant-a', user_id: 'admin-1', roles: '["admin"]', expires_at: future }]
    // 二次调用返回过滤后的行
    const calls: string[] = []
    const client = { query: async <Row extends Record<string, unknown>>(sql: string) => {
      calls.push(sql)
      return { rows: (sql.includes('WHERE session_id') ? rows : []) as unknown as Row[] }
    } }
    const store2 = new PostgresAuthSessionStore(client)
    await store2.create(SCOPE, 's1', ['admin'], future)
    const got = await store2.get('s1', Date.now())
    expect(got).toEqual({ sessionId: 's1', tenantId: 'tenant-a', userId: 'admin-1', roles: ['admin'], expiresAt: future })
  })

  it('get 对过期会话返回 null', async () => {
    const rows = [{ session_id: 's1', tenant_id: 't', user_id: 'u', roles: '[]', expires_at: 1_000 }] // 已过期
    const client = { query: async <Row extends Record<string, unknown>>(sql: string) => ({ rows: (sql.includes('WHERE session_id') ? rows : []) as unknown as Row[] }) }
    const store = new PostgresAuthSessionStore(client)
    expect(await store.get('s1', Date.now())).toBeNull()
  })

  it('destroy 删除会话', async () => {
    const calls: string[] = []
    const client = { query: async <Row extends Record<string, unknown>>(sql: string) => { calls.push(sql); return { rows: [] } } }
    const store = new PostgresAuthSessionStore(client)
    await store.destroy('s1')
    expect(calls[0]).toContain('DELETE FROM proma_runtime_auth_sessions')
  })
})
```

**Step 2: 运行确认失败**

Run: `cd apps/server && bun test src/auth-session-store.test.ts`
Expected: FAIL（`Cannot find module './auth-session-store'`）

**Step 3: 实现**

`auth-session-store.ts`:

```ts
import type { AgentRuntimePostgresClient, AgentRuntimeRole } from '@gravitas/shared/utils'

export interface AuthSessionRecord {
  sessionId: string
  tenantId: string
  userId: string
  roles: AgentRuntimeRole[]
  expiresAt: number
}

/** Postgres 会话存储：session_id → scope；HTTP-only cookie 对应。 */
export class PostgresAuthSessionStore {
  constructor(private readonly client: AgentRuntimePostgresClient) {}

  async initializeSchema(): Promise<void> {
    await this.client.query(`CREATE TABLE IF NOT EXISTS proma_runtime_auth_sessions (
      session_id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      roles TEXT NOT NULL DEFAULT '[]',
      expires_at BIGINT NOT NULL,
      created_at BIGINT NOT NULL
    )`)
    await this.client.query('CREATE INDEX IF NOT EXISTS idx_auth_sessions_expires ON proma_runtime_auth_sessions(expires_at)')
  }

  async create(scope: { tenantId: string; userId: string }, sessionId: string, roles: AgentRuntimeRole[], expiresAt: number): Promise<void> {
    await this.client.query(
      `INSERT INTO proma_runtime_auth_sessions (session_id, tenant_id, user_id, roles, expires_at, created_at)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [sessionId, scope.tenantId, scope.userId, JSON.stringify(roles), expiresAt, Date.now()],
    )
  }

  async get(sessionId: string, now: number): Promise<AuthSessionRecord | null> {
    const result = await this.client.query<Record<string, unknown>>(
      'SELECT session_id, tenant_id, user_id, roles, expires_at FROM proma_runtime_auth_sessions WHERE session_id = $1',
      [sessionId],
    )
    const row = result.rows[0]
    if (!row) return null
    const expiresAt = Number(row.expires_at)
    if (expiresAt <= now) return null
    return {
      sessionId: String(row.session_id),
      tenantId: String(row.tenant_id),
      userId: String(row.user_id),
      roles: JSON.parse(String(row.roles)) as AgentRuntimeRole[],
      expiresAt,
    }
  }

  async destroy(sessionId: string): Promise<void> {
    await this.client.query('DELETE FROM proma_runtime_auth_sessions WHERE session_id = $1', [sessionId])
  }
}
```

**Step 4: 运行确认通过** + typecheck。

### M1.1.2 本地管理员认证（scrypt 哈希）

**Step 1: 写失败测试** `local-admin-auth.test.ts`：

```ts
import { describe, expect, it } from 'bun:test'
import { hashPassword, verifyPassword, parseAdminAccount } from './local-admin-auth'

describe('local-admin-auth', () => {
  it('hashPassword 产出带随机盐的哈希；verifyPassword 校验正确/错误密码', async () => {
    const hash = await hashPassword('s3cret-password', crypto.getRandomValues(new Uint8Array(16)))
    expect(await verifyPassword('s3cret-password', hash)).toBe(true)
    expect(await verifyPassword('wrong-password', hash)).toBe(false)
  })

  it('parseAdminAccount 解析 admin:tenant:password 格式', () => {
    const acct = parseAdminAccount('admin:tenant-a:s3cret')
    expect(acct).toEqual({ username: 'admin', tenantId: 'tenant-a', password: 's3cret' })
  })

  it('parseAdminAccount 对缺字段抛错', () => {
    expect(() => parseAdminAccount('admin:s3cret')).toThrow() // 缺 tenant
    expect(() => parseAdminAccount('admin:tenant-a')).toThrow() // 缺 password
  })
})
```

**Step 2: 运行确认失败。**

**Step 3: 实现** `local-admin-auth.ts`（scrypt，格式 `scrypt$N$r$p$saltB64$hashB64`）：

```ts
import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'

const scrypt = promisify(scryptCb) as (password: string, salt: Buffer, keylen: number) => Promise<Buffer>

const N = 16_384, r = 8, p = 1, KEYLEN = 32

export async function hashPassword(password: string, salt = randomBytes(16)): Promise<string> {
  const derived = await scrypt(password, salt, KEYLEN)
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${derived.toString('base64')}`
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false
  const [alg, nStr, rStr, pStr, saltB64, hashB64] = parts
  const salt = Buffer.from(saltB64, 'base64')
  const expected = Buffer.from(hashB64, 'base64')
  const derived = await scrypt(password, salt, expected.length)
  return timingSafeEqual(derived, expected)
}

export interface AdminAccount { username: string; tenantId: string; password: string }
export function parseAdminAccount(raw: string, fallbackName = 'admin'): AdminAccount {
  const parts = raw.split(':')
  if (parts.length !== 3) throw new Error('PROMA_WEB_ADMIN 必须是 username:tenantId:password 格式')
  const [username, tenantId, password] = parts
  if (!username || !tenantId || !password) throw new Error('PROMA_WEB_ADMIN 的 username/tenantId/password 不能为空')
  return { username, tenantId, password }
}
```

**Step 4: 运行确认通过。**

### M1.1 提交
```bash
git add apps/server/src/auth-session-store.ts apps/server/src/auth-session-store.test.ts apps/server/src/local-admin-auth.ts apps/server/src/local-admin-auth.test.ts
git commit -m "feat(server): auth session store + local admin scrypt auth"
```

---

## Task M1.2：cookie 会话 auth resolver

**Files:**
- Create: `apps/server/src/auth-resolvers.ts`
- Create: `apps/server/src/auth-resolvers.test.ts`

**目标**：把 cookie session 接入 `AgentRuntimeWebAuthResolver` 链。设计一个 `createCookieSessionAuthResolver`（返回 scope），并提供一个 `createCompositeAuthResolver`（按序尝试 cookie→bearer→trustedHeader）。

**Step 1: 写失败测试**：

```ts
import { describe, expect, it } from 'bun:test'
import { createCookieSessionAuthResolver, createCompositeAuthResolver, parseSessionCookie } from './auth-resolvers'

const SCOPE = { tenantId: 'tenant-a', userId: 'admin-1', roles: ['admin'] as const }

describe('auth-resolvers', () => {
  it('parseSessionCookie 解析 HTTP-only cookie 中的 session id', () => {
    const cookie = 'proma_session=abc123; Path=/; HttpOnly'
    expect(parseSessionCookie(cookie)).toBe('abc123')
    expect(parseSessionCookie('other=1; proma_session=xyz')).toBe('xyz')
    expect(parseSessionCookie('no-session-here')).toBeUndefined()
  })

  it('createCookieSessionAuthResolver 用 cookie 命中 session 返回 scope', async () => {
    const resolver = createCookieSessionAuthResolver({
      store: { get: async (sid) => (sid === 'sid1' ? { sessionId: 'sid1', ...SCOPE, expiresAt: Date.now() + 60_000 } : null) },
      cookieName: 'proma_session',
    })
    const req = new Request('http://x/agent/ui', { headers: { cookie: 'proma_session=sid1' } })
    const scope = await resolver({ request: req, url: new URL('http://x/agent/ui') })
    expect(scope).toEqual(SCOPE)
  })

  it('cookie 未命中时返回 undefined（交给 Bearer 链路）', async () => {
    const resolver = createCookieSessionAuthResolver({ store: { get: async () => null }, cookieName: 'proma_session' })
    const scope = await resolver({ request: new Request('http://x/'), url: new URL('http://x/') })
    expect(scope).toBeUndefined()
  })

  it('createCompositeAuthResolver 按 cookie→bearer 顺序尝试', async () => {
    const cookieFn = async () => ({ tenantId: 't', userId: 'cookie-user', roles: ['operator'] as const })
    const bearerFn = async () => undefined
    const inner = createCompositeAuthResolver(cookieFn, bearerFn)
    const scope = await inner({ request: new Request('http://x/'), url: new URL('http://x/') })
    expect(scope?.userId).toBe('cookie-user')
  })
})
```

**Step 2: 运行确认失败。**

**Step 3: 实现** `auth-resolvers.ts`：

```ts
import type { AgentRuntimeScope, AgentRuntimeWebAuthResolver } from '@gravitas/shared/utils'
import type { AuthSessionRecord } from './auth-session-store'

export interface CookieSessionAuthOptions {
  store: { get(sessionId: string, now: number): Promise<AuthSessionRecord | null> }
  cookieName?: string
}

export function parseSessionCookie(cookieHeader: string | null, name = 'proma_session'): string | undefined {
  if (!cookieHeader) return undefined
  for (const part of cookieHeader.split(';')) {
    const [key, ...rest] = part.trim().split('=')
    if (key === name) return rest.join('=') || undefined
  }
  return undefined
}

export function createCookieSessionAuthResolver(options: CookieSessionAuthOptions): AgentRuntimeWebAuthResolver {
  const name = options.cookieName ?? 'proma_session'
  return async ({ request }) => {
    const sessionId = parseSessionCookie(request.headers.get('cookie'), name)
    if (!sessionId) return undefined
    const session = await options.store.get(sessionId, Date.now())
    if (!session) return undefined
    return { tenantId: session.tenantId, userId: session.userId, roles: session.roles }
  }
}

/** 按序尝试多个 auth resolver，第一个返回 scope 的胜出 */
export function createCompositeAuthResolver(...resolvers: AgentRuntimeWebAuthResolver[]): AgentRuntimeWebAuthResolver {
  return async (input) => {
    for (const resolver of resolvers) {
      const scope = await resolver(input)
      if (scope) return scope
    }
    return undefined
  }
}
```

**Step 4: 运行确认通过。**

### M1.2 提交
```bash
git add apps/server/src/auth-resolvers.ts apps/server/src/auth-resolvers.test.ts
git commit -m "feat(server): cookie session + composite auth resolvers"
```

---

## Task M1.3：`/auth/*` 登录路由

**Files:**
- Create: `apps/server/src/auth-routes.ts`
- Create: `apps/server/src/auth-routes.test.ts`
- Modify: `apps/server/src/app.ts`（挂载 authRoutes 到 fetch 之前）

**目标**：`/auth/login`（GET 页 / POST 本地登录）、`/auth/logout`、`/auth/oidc/start`、`/auth/oidc/callback`。成功登录设 HTTP-only cookie。

**Step 1: 写失败测试**（聚焦 POST 本地登录 + OIDC start 重定向 + logout，mock store）：

`auth-routes.test.ts`:

```ts
import { describe, expect, it } from 'bun:test'
import { createAuthHandler } from './auth-routes'

// mock 会话 store + 管理员校验 + oidc config
function makeHandler(overrides: Record<string, unknown> = {}) {
  const sessions: Record<string, unknown> = {}
  return createAuthHandler({
    sessionStore: {
      get: async (id: string) => sessions[id] ?? null,
      create: async (_s: unknown) => {},
      destroy: async (id: string) => { delete sessions[id] },
    },
    verifyAdmin: async (username: string, password: string) =>
      username === 'admin' && password === 's3cret' ? { tenantId: 'tenant-a', roles: ['admin'] as const } : null,
    sessionCookieName: 'proma_session',
    sessionTtlMs: 60_000,
    oidc: undefined, // 本地模式
    ...overrides,
  })
}

describe('auth-routes', () => {
  it('GET /auth/login 返回登录页 HTML', async () => {
    const h = makeHandler()
    const res = await h.loginPage()
    expect((await res.text()).includes('登录')).toBe(true)
  })

  it('POST /auth/login 本地凭据正确时设 cookie + 返回 200', async () => {
    const h = makeHandler()
    const res = await h.loginForm({ username: 'admin', password: 's3cret' })
    expect(res.status).toBe(200)
    expect(res.headers.get('set-cookie')).toContain('proma_session=')
    expect(res.headers.get('set-cookie')).toContain('HttpOnly')
  })

  it('POST /auth/login 凭据错误返回 401', async () => {
    const h = makeHandler()
    const res = await h.loginForm({ username: 'admin', password: 'wrong' })
    expect(res.status).toBe(401)
  })

  it('OIDC start 无配置时返回 400', async () => {
    const h = makeHandler()
    const res = await h.oidcStart()
    expect(res.status).toBe(400)
  })

  it('OIDC start 有配置时重定向到 authorize URL', async () => {
    const h = makeHandler({ oidc: { authorizationEndpoint: 'https://idp/authorize', clientId: 'c', redirectUri: 'http://x/auth/oidc/callback' } })
    const res = await h.oidcStart()
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toContain('https://idp/authorize')
  })

  it('logout 清除 cookie', async () => {
    const h = makeHandler()
    const res = await h.logout()
    expect(res.headers.get('set-cookie')).toContain('proma_session=; Max-Age=0')
  })
})
```

**Step 2: 运行确认失败。**

**Step 3: 实现** `auth-routes.ts`（返回 `Response` 的纯 handler 集，便于测试与在 app.ts 挂载）：

```ts
import type { AgentRuntimeRole } from '@gravitas/shared/utils'
import { createSessionId } from './auth-session-store'

export interface AuthRoutesDeps {
  sessionStore: {
    create(session): Promise<void>
    destroy(sessionId: string): Promise<void>
  }
  verifyAdmin: (username: string, password: string) => Promise<{ tenantId: string; roles: AgentRuntimeRole[] } | null>
  sessionCookieName?: string
  sessionTtlMs?: number
  /** 未配置则禁用 OIDC（本地 fallback 模式） */
  oidc?: { authorizationEndpoint: string; tokenEndpoint: string; clientId: string; clientSecret: string; redirectUri: string; scope?: string; jwksUrl?: string }
  oidcTokenFromCode?: (code: string, oidc: NonNullable<AuthRoutesDeps['oidc']>, jwks? : unknown) => Promise<{ tenantId: string; userId: string; roles: AgentRuntimeRole[] }>
}

// ... loginPage() / loginForm(body) / logout() / oidcStart() / oidcCallback(code)
```

（完整实现含 scrypt 校验、cookie 构造 `proma_session=<id>; Path=/; HttpOnly; SameSite=Lax`、OIDC code→token 交换。）

**Step 4: 运行确认通过。**

### M1.3 提交
```bash
git add apps/server/src/auth-routes.ts apps/server/src/auth-routes.test.ts apps/server/src/app.ts
git commit -m "feat(server): /auth/* login routes (local form + OIDC start/callback) + cookies"
```

---

## Task M1.4：接线 authMode + 启动解死锁

**Files:**
- Modify: `apps/server/src/app.ts`（mount authRoutes、composite resolver、fetch 前置处理 /auth 与未认证跳转）
- Modify: `apps/server/src/index.ts`（解析 `PROMA_WEB_AUTH_MODE`：local/oidc/both；`PROMA_WEB_ADMIN`；OIDC client env；启动策略）
- Modify: `apps/server/src/auth-startup-policy.ts`（允许 local/both 在非 loopback 部署）

**Step 1: 写失败测试**（startup policy 扩展 + authMode 解析）：

`auth-startup-policy.test.ts` 追加：local 模式允许非 dev 监听非 loopback（因为本地密码是可用身份边界）；trusted-header 仍强制 loopback+dev。

`index.ts` 解析测试（`parseAuthMode`）：`local`→仅本地；`oidc`→仅 OIDC；`both`→两者；缺省行为（有 OIDC env→both，无 OIDC env→local，避免死锁）。

**Step 2: 运行确认失败。**

**Step 3: 实现。**

- `app.ts`：`if (url.pathname === '/auth/login' || ...)` 走 authRoutes；`/agent/ui` 未登录时仍返回 HTML（登录页在其中/跳转）；把 `createCookieSessionAuthResolver` + 现有 bearer/trusted 组合进 `auth` resolver；提供 `getAuthSession(request)` 供 app.ts 判断登录态。
- `index.ts`：`const authMode = parseAuthMode(env)`（默认：给 OIDC_ISSUER 则 both 否则 local）。`PROMA_WEB_ADMIN='user:tenant:pass'` 解析为本地管理员。移除"非 trusted 必须 OIDC"的硬 require，改为按 authMode 校验。
- `auth-startup-policy.ts`：trusted-header 仍受限；新增 `assertAuthModeStartupPolicy`：`fallback password login` 允许生产非 loopback（`PROMA_WEB_ADMIN` 必须提供且密码强度足够）。

**Step 4: 运行确认通过。**

### M1.4 提交
```bash
git add apps/server/src/app.ts apps/server/src/index.ts apps/server/src/auth-startup-policy.ts
git commit -m "feat(server): wire authMode (local/oidc/both), mount /auth routes, lift OIDC-mandatory startup"
```

---

## Task M1.5：端到端验收

**Step 1: 真实部署冒烟**（复用 `docker-compose.production.yml` 或本地 Bun）：

本地冒烟（local 模式，`PROMA_WEB_TRUSTED_HEADER_AUTH=1` 仅开发，但此处用 local 验证登录闭环）：

```bash
# 1. 起依赖
docker compose -f apps/server/docker-compose.p2-test.yml up -d
export PROMA_WEB_DATABASE_URL='postgres://proma:proma@127.0.0.1:55432/proma'
export PROMA_WEB_REDIS_URL='redis://127.0.0.1:56379'
export PROMA_WEB_S3_BUCKET=proma PROMA_WEB_S3_REGION=us-east-1 PROMA_WEB_S3_ENDPOINT=http://127.0.0.1:9000
export PROMA_WEB_S3_ACCESS_KEY_ID=minioadmin PROMA_WEB_S3_SECRET_ACCESS_KEY=minioadmin

# 2. local 模式启动（无 OIDC 不应再报缺环境变量）
export PROMA_WEB_AUTH_MODE=local
export PROMA_WEB_ADMIN='admin:tenant-a:s3cret-pass'
export PROMA_WEB_ENVELOPE_KEY=$(openssl rand -base64 32)
cd apps/server && bun run index.ts
```

**Step 2: 验证闭环：**
1. `GET /auth/login` → 200 登录页
2. `curl -i -X POST /auth/login -d '{"username":"admin","password":"s3cret-pass"}'` → 302 + `Set-Cookie: proma_session=...`
3. 带 cookie 访问 `/agent/ui` → 200 且能建会话/跑任务
4. 不带 cookie 访问 `/agent/metrics` → 401 或跳转登录
5. `POST /auth/logout` → cookie 失效
6. OIDC 模式：配置真实 IdP 后走 `/auth/oidc/start` 重定向 + 回调（本机无 IdP 时用 mock 验证重定向与 code→token 交换逻辑）
7. 回归：`bun test` server 全量通过

**Step 3: 提交收尾**（如有修复则提交，并更新 `docs/private-deployment-minimal.md` 勾选 M1、`docs/plans/2026-08-13-private-deploy-m1.md` 进度）。

---

## 排除（本次不做）
- OIDC 真实 IdP 接入验收（与 `docs/server-web-remaining-todo.md` P8 暂缓原则一致：不能伪造占位 IdP 验收）。M1.5 用 mock/matcher 验证 code 交换逻辑，真实验收留待有真实 IdP 时。
- 多用户自助注册/找回密码/2FA——本地 fallback 只做 bootstrap 的 admin 账号 + 密码，后续可扩展用户表。
- 前端工程化 —— 登录页为内嵌 HTML（与 dashboard 一致，无构建依赖）。
- CSRF token、会话轮换（Sliding expiration）——留注释标注为生产加固项。

## 与既有工作关系
- 复用 `jwt-auth.ts` 的 OIDC JWT 校验与 JWKS 缓存（`createOidcJwtAuth`）；新增 cookie 链路是"加法"，不改其行为。
- 会话表命名 `proma_runtime_auth_sessions`，与 `proma_runtime_*` 命名一致。
- 本 M1 全部完成后，`docs/private-deployment-minimal.md` 的 M1 可勾选，最小集进度推进到 M2。

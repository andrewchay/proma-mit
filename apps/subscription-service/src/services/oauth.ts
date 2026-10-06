import { randomBytes } from 'node:crypto'

/**
 * 第三方 OAuth 登录（GitHub / Google）。
 *
 * 安全要点：
 * - state 由服务端生成并校验，防 CSRF
 * - 授权码换 token 在服务端完成，client_secret 永不下发客户端
 * - 必须取得**已验证的邮箱**才允许登录，避免归并到攻击者控制的未验证邮箱
 */

export type OAuthProviderId = 'github' | 'google'

/** state 有效期 10 分钟 */
export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export interface OAuthStateRecord {
  state: string
  provider: OAuthProviderId
  redirectUri: string
  expiresAt: number
  createdAt: number
}

const SUPPORTED_PROVIDERS: ReadonlySet<string> = new Set(['github', 'google'])

export function generateOAuthState(): string {
  return randomBytes(24).toString('hex')
}

export function parseOAuthState(input: {
  provider: string
  state: string
  redirectUri: string
  now: number
}): OAuthStateRecord {
  if (!SUPPORTED_PROVIDERS.has(input.provider)) {
    throw new Error(`不支持的 OAuth provider: ${input.provider}`)
  }
  if (!input.state) throw new Error('state 不能为空')
  if (!input.redirectUri) throw new Error('redirectUri 不能为空')

  return {
    state: input.state,
    provider: input.provider as OAuthProviderId,
    redirectUri: input.redirectUri,
    expiresAt: input.now + OAUTH_STATE_TTL_MS,
    createdAt: input.now,
  }
}

export function buildGitHubAuthorizeUrl(input: {
  clientId: string
  redirectUri: string
  state: string
}): string {
  const params = new URLSearchParams({
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    // user:email 是必须的：没有它无法取得邮箱，也就无法与邮箱验证码登录归并为同一账号
    scope: 'read:user user:email',
    state: input.state,
    allow_signup: 'true',
  })
  return `https://github.com/login/oauth/authorize?${params.toString()}`
}

export function buildGoogleAuthorizeUrl(input: {
  clientId: string
  redirectUri: string
  state: string
}): string {
  const params = new URLSearchParams({
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    state: input.state,
    access_type: 'online',
    prompt: 'select_account',
  })
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`
}

export interface ResolvedOAuthIdentity {
  provider: OAuthProviderId
  /** 已验证邮箱，统一小写 */
  email: string
  /** 渠道侧稳定用户标识，用于换绑检测 */
  subjectId: string
  displayName?: string
}

export interface GitHubResolveInput {
  code: string
  clientId: string
  clientSecret: string
  redirectUri: string
  fetchImpl?: FetchLike
}

export async function resolveGitHubIdentity(
  input: GitHubResolveInput,
): Promise<ResolvedOAuthIdentity> {
  const doFetch: FetchLike = input.fetchImpl ?? ((url, init) => fetch(url, init))

  const tokenResponse = await doFetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      client_id: input.clientId,
      client_secret: input.clientSecret,
      code: input.code,
      redirect_uri: input.redirectUri,
    }),
  })

  if (!tokenResponse.ok) throw new Error('GitHub token 交换失败')

  const tokenJson = (await tokenResponse.json().catch(() => undefined)) as
    | { access_token?: string; error?: string }
    | undefined
  const accessToken = tokenJson?.access_token
  if (!accessToken) {
    throw new Error(`GitHub token 交换失败: ${tokenJson?.error ?? 'unknown'}`)
  }

  const authHeaders = { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' }

  const userResponse = await doFetch('https://api.github.com/user', { headers: authHeaders })
  if (!userResponse.ok) throw new Error('GitHub 用户信息获取失败')
  const user = (await userResponse.json().catch(() => undefined)) as
    | { id?: number; login?: string; name?: string }
    | undefined
  if (!user?.id) throw new Error('GitHub 用户信息缺少 id')

  const emailResponse = await doFetch('https://api.github.com/user/emails', {
    headers: authHeaders,
  })
  if (!emailResponse.ok) throw new Error('GitHub 邮箱获取失败')
  const emails = (await emailResponse.json().catch(() => undefined)) as
    | Array<{ email?: string; primary?: boolean; verified?: boolean }>
    | undefined

  if (!Array.isArray(emails)) throw new Error('GitHub 邮箱响应格式异常')

  // 优先主邮箱，但必须是已验证的；未验证邮箱不可用于账号归并
  const primary = emails.find((item) => item.primary === true && item.verified === true && item.email)
  if (!primary?.email) {
    throw new Error('GitHub 账号没有已验证的主邮箱，无法登录')
  }

  return {
    provider: 'github',
    email: primary.email.trim().toLowerCase(),
    subjectId: String(user.id),
    ...(user.name ? { displayName: user.name } : user.login ? { displayName: user.login } : {}),
  }
}

export interface GoogleResolveInput {
  code: string
  clientId: string
  clientSecret: string
  redirectUri: string
  fetchImpl?: FetchLike
}

export async function resolveGoogleIdentity(
  input: GoogleResolveInput,
): Promise<ResolvedOAuthIdentity> {
  const doFetch: FetchLike = input.fetchImpl ?? ((url, init) => fetch(url, init))

  const tokenResponse = await doFetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: input.clientId,
      client_secret: input.clientSecret,
      code: input.code,
      grant_type: 'authorization_code',
      redirect_uri: input.redirectUri,
    }).toString(),
  })

  if (!tokenResponse.ok) throw new Error('Google token 交换失败')

  const tokenJson = (await tokenResponse.json().catch(() => undefined)) as
    | { access_token?: string; error?: string }
    | undefined
  const accessToken = tokenJson?.access_token
  if (!accessToken) {
    throw new Error(`Google token 交换失败: ${tokenJson?.error ?? 'unknown'}`)
  }

  const profileResponse = await doFetch('https://www.googleapis.com/oauth2/v3/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!profileResponse.ok) throw new Error('Google 用户信息获取失败')

  const profile = (await profileResponse.json().catch(() => undefined)) as
    | { sub?: string; email?: string; email_verified?: boolean; name?: string }
    | undefined

  if (!profile?.sub) throw new Error('Google 用户信息缺少 sub')
  if (!profile.email) throw new Error('Google 账号没有邮箱，无法登录')
  // Google 明确返回 email_verified，未验证邮箱不得用于账号归并
  if (profile.email_verified !== true) {
    throw new Error('Google 账号邮箱未验证，无法登录')
  }

  return {
    provider: 'google',
    email: profile.email.trim().toLowerCase(),
    subjectId: profile.sub,
    ...(profile.name ? { displayName: profile.name } : {}),
  }
}

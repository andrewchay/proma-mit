import { describe, expect, test } from 'bun:test'
import {
  buildGitHubAuthorizeUrl,
  parseOAuthState,
  resolveGitHubIdentity,
  resolveGoogleIdentity,
  OAUTH_STATE_TTL_MS,
  type FetchLike,
} from './oauth'

describe('OAuth state 构造与解析', () => {
  test('state 可解析回原始字段', () => {
    const state = parseOAuthState({
      provider: 'github',
      state: 'abc123',
      redirectUri: 'https://app.example.com/callback',
      now: 1_800_000_000_000,
    })
    expect(state.state).toBe('abc123')
    expect(state.provider).toBe('github')
    expect(state.expiresAt).toBe(1_800_000_000_000 + OAUTH_STATE_TTL_MS)
  })

  test('拒绝不支持的 provider', () => {
    expect(() =>
      parseOAuthState({
        provider: 'facebook' as 'github',
        state: 'x',
        redirectUri: 'https://a.com',
        now: 0,
      }),
    ).toThrow()
  })

  test('拒绝空 state', () => {
    expect(() =>
      parseOAuthState({ provider: 'github', state: '', redirectUri: 'https://a.com', now: 0 }),
    ).toThrow()
  })

  test('state 有效期不超过 10 分钟', () => {
    expect(OAUTH_STATE_TTL_MS).toBeLessThanOrEqual(10 * 60 * 1000)
  })
})

describe('GitHub 授权地址', () => {
  test('包含 client_id、redirect_uri、scope 与 state', () => {
    const url = buildGitHubAuthorizeUrl({
      clientId: 'cid',
      redirectUri: 'https://app.example.com/callback',
      state: 'st-1',
    })
    const parsed = new URL(url)
    expect(parsed.origin + parsed.pathname).toBe('https://github.com/login/oauth/authorize')
    expect(parsed.searchParams.get('client_id')).toBe('cid')
    expect(parsed.searchParams.get('state')).toBe('st-1')
    // 至少要能读到用户邮箱，否则无法归并账号
    const scope = parsed.searchParams.get('scope') ?? ''
    expect(scope).toContain('user:email')
  })
})

describe('GitHub 身份解析', () => {
  function makeFetch(user: unknown, emails: unknown): FetchLike {
    return async (input) => {
      if (String(input).includes('/user/emails')) {
        return new Response(JSON.stringify(emails), { status: 200 })
      }
      if (String(input).includes('/user')) {
        return new Response(JSON.stringify(user), { status: 200 })
      }
      // token 交换
      return new Response(JSON.stringify({ access_token: 'gh-token' }), { status: 200 })
    }
  }

  test('取主邮箱并返回稳定外部 ID', async () => {
    const identity = await resolveGitHubIdentity({
      code: 'code-1',
      clientId: 'cid',
      clientSecret: 'secret',
      redirectUri: 'https://app.example.com/callback',
      fetchImpl: makeFetch(
        { id: 42, login: 'octocat', name: 'The Octocat' },
        [
          { email: 'secondary@example.com', primary: false, verified: true },
          { email: 'primary@example.com', primary: true, verified: true },
        ],
      ),
    })

    expect(identity.provider).toBe('github')
    expect(identity.email).toBe('primary@example.com')
    expect(identity.subjectId).toBe('42')
    expect(identity.displayName).toBe('The Octocat')
  })

  test('无已验证主邮箱时拒绝（避免归并到未验证邮箱）', async () => {
    await expect(
      resolveGitHubIdentity({
        code: 'code-1',
        clientId: 'cid',
        clientSecret: 'secret',
        redirectUri: 'https://app.example.com/callback',
        fetchImpl: makeFetch(
          { id: 42, login: 'octocat' },
          [{ email: 'unverified@example.com', primary: true, verified: false }],
        ),
      }),
    ).rejects.toThrow()
  })

  test('token 交换失败时拒绝', async () => {
    await expect(
      resolveGitHubIdentity({
        code: 'bad',
        clientId: 'cid',
        clientSecret: 'secret',
        redirectUri: 'https://app.example.com/callback',
        fetchImpl: async () => new Response(JSON.stringify({ error: 'bad_verification_code' }), { status: 200 }),
      }),
    ).rejects.toThrow()
  })
})

describe('Google 身份解析', () => {
  test('从 userinfo 取邮箱与 sub', async () => {
    const identity = await resolveGoogleIdentity({
      code: 'code-1',
      clientId: 'cid',
      clientSecret: 'secret',
      redirectUri: 'https://app.example.com/callback',
      fetchImpl: async (input) => {
        if (String(input).includes('oauth2.googleapis.com/token')) {
          return new Response(JSON.stringify({ access_token: 'g-token' }), { status: 200 })
        }
        return new Response(
          JSON.stringify({
            sub: 'google-123',
            email: 'user@gmail.com',
            email_verified: true,
            name: 'Test User',
          }),
          { status: 200 },
        )
      },
    })

    expect(identity.provider).toBe('google')
    expect(identity.email).toBe('user@gmail.com')
    expect(identity.subjectId).toBe('google-123')
  })

  test('邮箱未验证时拒绝', async () => {
    await expect(
      resolveGoogleIdentity({
        code: 'code-1',
        clientId: 'cid',
        clientSecret: 'secret',
        redirectUri: 'https://app.example.com/callback',
        fetchImpl: async (input) => {
          if (String(input).includes('token')) {
            return new Response(JSON.stringify({ access_token: 'g' }), { status: 200 })
          }
          return new Response(
            JSON.stringify({ sub: 'x', email: 'a@b.com', email_verified: false }),
            { status: 200 },
          )
        },
      }),
    ).rejects.toThrow()
  })

  test('缺少邮箱时拒绝', async () => {
    await expect(
      resolveGoogleIdentity({
        code: 'code-1',
        clientId: 'cid',
        clientSecret: 'secret',
        redirectUri: 'https://app.example.com/callback',
        fetchImpl: async (input) => {
          if (String(input).includes('token')) {
            return new Response(JSON.stringify({ access_token: 'g' }), { status: 200 })
          }
          return new Response(JSON.stringify({ sub: 'x', email_verified: true }), { status: 200 })
        },
      }),
    ).rejects.toThrow()
  })
})

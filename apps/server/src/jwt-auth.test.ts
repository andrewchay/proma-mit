import { afterEach, describe, expect, test } from 'bun:test'
import { createOidcJwtAuth, verifyJwtWithJwks } from './jwt-auth.ts'
import { createAuthHandler } from './auth-routes.ts'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('OIDC JWT 认证', () => {
  test('Given API audience 与 client ID 不同 When 验证 ID token Then 只接受 client ID', async () => {
    const signing = await createSigningMaterial()
    let token = ''
    globalThis.fetch = (async (input: RequestInfo | URL) => String(input).endsWith('/token') ? Response.json({ id_token: token }) : Response.json({ keys: [signing.jwk] })) as unknown as typeof fetch
    const handler = createAuthHandler({
      sessionStore: { create: async () => {}, destroy: async () => {} }, verifyAdmin: async () => null,
      oidc: { issuer: 'https://issuer.example', audience: 'api-resource', jwksUrl: 'https://issuer.example/jwks', authorizationEndpoint: 'https://issuer.example/authorize', tokenEndpoint: 'https://issuer.example/token', clientId: 'web-client', redirectUri: 'https://app.example/auth/oidc/callback' },
    })
    const start = await handler.oidcStart()
    const authorization = new URL(start.headers.get('location')!)
    token = await signJwt(signing.privateKey, { iss: 'https://issuer.example', aud: 'web-client', exp: futureEpoch(), nonce: authorization.searchParams.get('nonce'), tenant_id: 'tenant-a', sub: 'user-a' })
    expect((await handler.oidcCallback({ code: 'code', state: authorization.searchParams.get('state')! }, start.headers.get('set-cookie'))).status).toBe(302)
    const second = await handler.oidcStart()
    const next = new URL(second.headers.get('location')!)
    token = await signJwt(signing.privateKey, { iss: 'https://issuer.example', aud: 'api-resource', exp: futureEpoch(), nonce: next.searchParams.get('nonce'), tenant_id: 'tenant-a', sub: 'user-a' })
    await expect(handler.oidcCallback({ code: 'code', state: next.searchParams.get('state')! }, second.headers.get('set-cookie'))).rejects.toThrow('id_token 校验失败')
  })
  test('Given OIDC ID token When nonce 不匹配或缺少过期时间 Then 拒绝', async () => {
    const signing = await createSigningMaterial()
    stubJwks(signing.jwk)
    const config = { issuer: 'https://issuer.example', audience: 'proma-web', jwksUrl: 'https://issuer.example/jwks', expectedNonce: 'expected' }
    const base = { iss: config.issuer, aud: config.audience, tenant_id: 'tenant-a', sub: 'user-a' }
    for (const claims of [{ ...base, nonce: 'wrong', exp: futureEpoch() }, { ...base, nonce: 'expected' }, { ...base, nonce: 'expected', exp: pastEpoch() }]) {
      expect(await verifyJwtWithJwks(await signJwt(signing.privateKey, claims), config)).toBeUndefined()
    }
    for (const claims of [{ ...base, aud: ['proma-web', 'untrusted'], nonce: 'expected', exp: futureEpoch() }, { ...base, azp: 'other-client', nonce: 'expected', exp: futureEpoch() }]) {
      expect(await verifyJwtWithJwks(await signJwt(signing.privateKey, claims), config)).toBeUndefined()
    }
    expect(await verifyJwtWithJwks(await signJwt(signing.privateKey, { ...base, nonce: 'expected', exp: futureEpoch() }), config)).toMatchObject({ userId: 'user-a' })
    expect(await verifyJwtWithJwks(await signJwt(signing.privateKey, { ...base, aud: ['proma-web'], azp: 'proma-web', nonce: 'expected', exp: futureEpoch() }), config)).toMatchObject({ userId: 'user-a' })
  })
  test('given a valid signed JWT with tenant and user claims then it returns the trusted scope', async () => {
    const signing = await createSigningMaterial()
    stubJwks(signing.jwk)
    const auth = createOidcJwtAuth({ issuer: 'https://issuer.example', audience: 'proma-web', jwksUrl: 'https://issuer.example/jwks' })

    const scope = await resolveScope(auth, new Request('http://localhost', {
      headers: { authorization: `Bearer ${await signJwt(signing.privateKey, { iss: 'https://issuer.example', aud: 'proma-web', exp: futureEpoch(), tenant_id: 'tenant-a', sub: 'user-a', roles: ['operator', 'unknown'] })}` },
    }))

    expect(scope).toEqual({ tenantId: 'tenant-a', userId: 'user-a', roles: ['operator'] })
  })

  test('given a JWT with a bad signature, audience, expiry, or missing scope then it is refused', async () => {
    const trusted = await createSigningMaterial()
    const attacker = await createSigningMaterial()
    stubJwks(trusted.jwk)
    const auth = createOidcJwtAuth({ issuer: 'https://issuer.example', audience: 'proma-web', jwksUrl: 'https://issuer.example/jwks' })

    for (const claims of [
      { iss: 'https://issuer.example', aud: 'wrong-audience', exp: futureEpoch(), tenant_id: 'tenant-a', sub: 'user-a' },
      { iss: 'https://issuer.example', aud: 'proma-web', exp: pastEpoch(), tenant_id: 'tenant-a', sub: 'user-a' },
      { iss: 'https://issuer.example', aud: 'proma-web', exp: futureEpoch(), tenant_id: 'tenant-a' },
    ]) {
      const scope = await resolveScope(auth, requestWithToken(await signJwt(trusted.privateKey, claims)))
      expect(scope).toBeUndefined()
    }

    const forgedScope = await resolveScope(auth, requestWithToken(await signJwt(attacker.privateKey, { iss: 'https://issuer.example', aud: 'proma-web', exp: futureEpoch(), tenant_id: 'tenant-a', sub: 'user-a' })))
    expect(forgedScope).toBeUndefined()
  })
})

interface SigningMaterial {
  privateKey: CryptoKey
  jwk: OidcTestJwk
}

interface OidcTestJwk extends JsonWebKey { kid: string }

async function createSigningMaterial(): Promise<SigningMaterial> {
  const keys = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify'])
  const jwk = await crypto.subtle.exportKey('jwk', keys.publicKey)
  return { privateKey: keys.privateKey, jwk: { ...jwk, kid: 'key-1', kty: 'RSA' } }
}

function stubJwks(jwk: OidcTestJwk): void {
  globalThis.fetch = (async () => Response.json({ keys: [jwk] })) as unknown as typeof fetch
}

async function resolveScope(auth: ReturnType<typeof createOidcJwtAuth>, request: Request) {
  return auth({ request, url: new URL(request.url) })
}

async function signJwt(privateKey: CryptoKey, claims: Record<string, unknown>): Promise<string> {
  const header = encodeJson({ alg: 'RS256', kid: 'key-1', typ: 'JWT' })
  const body = encodeJson(claims)
  const signed = `${header}.${body}`
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', privateKey, new TextEncoder().encode(signed))
  return `${signed}.${toBase64Url(new Uint8Array(signature))}`
}

function requestWithToken(token: string): Request {
  return new Request('http://localhost', { headers: { authorization: `Bearer ${token}` } })
}

function encodeJson(value: Record<string, unknown>): string {
  return toBase64Url(new TextEncoder().encode(JSON.stringify(value)))
}

function toBase64Url(value: Uint8Array): string {
  return value.toBase64().replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

function futureEpoch(): number { return Math.floor(Date.now() / 1_000) + 60 }
function pastEpoch(): number { return Math.floor(Date.now() / 1_000) - 60 }

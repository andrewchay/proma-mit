import { afterEach, describe, expect, test } from 'bun:test'
import { createOidcJwtAuth } from './jwt-auth.ts'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('OIDC JWT 认证', () => {
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

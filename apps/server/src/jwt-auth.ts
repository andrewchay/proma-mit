import type { AgentRuntimeWebAuthResolver } from '@proma/shared/utils'

export interface OidcJwtAuthConfig {
  issuer: string
  audience: string
  jwksUrl: string
  tenantClaim?: string
  userClaim?: string
}

/** 基于 JWKS 的 RS256 Bearer token 验证器；只返回经过签名验证的 scope。 */
export function createOidcJwtAuth(config: OidcJwtAuthConfig): AgentRuntimeWebAuthResolver {
  let cachedKeys: OidcJwk[] = []
  let expiresAt = 0
  return async ({ request }) => {
    const token = request.headers.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1]
    if (!token) return undefined
    const [encodedHeader, encodedClaims, encodedSignature] = token.split('.')
    if (!encodedHeader || !encodedClaims || !encodedSignature) return undefined
    const header = decodeJson(encodedHeader)
    const claims = decodeJson(encodedClaims)
    if (header?.alg !== 'RS256' || typeof header.kid !== 'string' || !claims) return undefined
    if (Date.now() >= expiresAt) {
      const response = await fetch(config.jwksUrl)
      if (!response.ok) throw new Error(`获取 OIDC JWKS 失败: ${response.status}`)
      const body = await response.json() as { keys?: OidcJwk[] }
      cachedKeys = body.keys ?? []
      expiresAt = Date.now() + 5 * 60_000
    }
    const jwk = cachedKeys.find((key) => key.kid === header.kid && key.kty === 'RSA')
    if (!jwk) return undefined
    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify'])
    const signed = new TextEncoder().encode(`${encodedHeader}.${encodedClaims}`)
    const signature = decodeBase64Url(encodedSignature)
    if (!await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, bytesToArrayBuffer(signature), bytesToArrayBuffer(signed))) return undefined
    if (claims.iss !== config.issuer || !hasAudience(claims.aud, config.audience) || !isCurrent(claims)) return undefined
    const tenantId = claims[config.tenantClaim ?? 'tenant_id']
    const userId = claims[config.userClaim ?? 'sub']
    return typeof tenantId === 'string' && typeof userId === 'string' && tenantId && userId ? { tenantId, userId } : undefined
  }
}

interface OidcJwk extends JsonWebKey { kid?: string }

function decodeJson(value: string): Record<string, unknown> | undefined {
  try { const parsed: unknown = JSON.parse(new TextDecoder().decode(decodeBase64Url(value))); return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : undefined } catch { return undefined }
}
function decodeBase64Url(value: string): Uint8Array { return Uint8Array.fromBase64(value.replace(/-/g, '+').replace(/_/g, '/')) }
function bytesToArrayBuffer(value: Uint8Array): ArrayBuffer { return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer }
function hasAudience(value: unknown, audience: string): boolean { return value === audience || Array.isArray(value) && value.includes(audience) }
function isCurrent(claims: Record<string, unknown>): boolean { const now = Math.floor(Date.now() / 1_000); return (typeof claims.exp !== 'number' || claims.exp > now) && (typeof claims.nbf !== 'number' || claims.nbf <= now) }

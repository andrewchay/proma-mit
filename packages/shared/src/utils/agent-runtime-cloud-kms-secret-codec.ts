import type { AgentRuntimeWebSecretCodec, AgentRuntimeWebSecretContext } from './agent-runtime-web-server'

/** 云 KMS 的最小信封加密契约；可由 AWS KMS、GCP KMS、Azure Key Vault 实现。 */
export interface CloudKmsDataKeyProvider {
  keyId: string
  generateDataKey(context: AgentRuntimeWebSecretContext): Promise<{ plaintextKey: Uint8Array; encryptedKey: string }>
  decryptDataKey(encryptedKey: string, context: AgentRuntimeWebSecretContext): Promise<Uint8Array>
}

export interface CloudKmsEnvelopeSecretCodecOptions {
  activeKeyId: string
  providers: Readonly<Record<string, CloudKmsDataKeyProvider>>
  crypto?: Crypto
}

interface CloudKmsEnvelopePayload { v: 1; alg: 'AES-GCM'; kid: string; ek: string; iv: string; ct: string }
const PREFIX = 'proma-kms-secret-v1.'

/** 使用云 KMS 包裹每条密文的 data key，并通过 kid 支持 grace period 内的轮换。 */
export function createCloudKmsEnvelopeSecretCodec(options: CloudKmsEnvelopeSecretCodecOptions): AgentRuntimeWebSecretCodec {
  const active = options.providers[options.activeKeyId]
  if (!active) throw new Error('activeKeyId 必须存在于 cloud KMS providers')
  const cryptoImpl = options.crypto ?? globalThis.crypto
  if (!cryptoImpl?.subtle) throw new Error('当前运行时不支持 WebCrypto subtle API')
  return {
    encode: async (plain, context) => {
      const dataKey = await active.generateDataKey(context)
      assertAesKey(dataKey.plaintextKey)
      const iv = cryptoImpl.getRandomValues(new Uint8Array(12))
      const key = await cryptoImpl.subtle.importKey('raw', asBuffer(dataKey.plaintextKey), { name: 'AES-GCM' }, false, ['encrypt'])
      const ciphertext = await cryptoImpl.subtle.encrypt({ name: 'AES-GCM', iv: asBuffer(iv), additionalData: aad(context) }, key, new TextEncoder().encode(plain))
      const payload: CloudKmsEnvelopePayload = { v: 1, alg: 'AES-GCM', kid: active.keyId, ek: dataKey.encryptedKey, iv: toBase64Url(iv), ct: toBase64Url(new Uint8Array(ciphertext)) }
      return `${PREFIX}${toBase64Url(new TextEncoder().encode(JSON.stringify(payload)))}`
    },
    decode: async (encoded, context) => {
      if (!encoded.startsWith(PREFIX)) throw new Error('Cloud KMS secret envelope 格式不正确')
      const payload = parse(encoded.slice(PREFIX.length))
      const provider = options.providers[payload.kid]
      if (!provider) throw new Error(`KMS keyId ${payload.kid} 已撤销或不在 grace period 内`)
      const dataKey = await provider.decryptDataKey(payload.ek, context)
      assertAesKey(dataKey)
      const key = await cryptoImpl.subtle.importKey('raw', asBuffer(dataKey), { name: 'AES-GCM' }, false, ['decrypt'])
      const plain = await cryptoImpl.subtle.decrypt({ name: 'AES-GCM', iv: asBuffer(fromBase64Url(payload.iv)), additionalData: aad(context) }, key, asBuffer(fromBase64Url(payload.ct)))
      return new TextDecoder().decode(plain)
    },
  }
}

function parse(encoded: string): CloudKmsEnvelopePayload {
  const value = JSON.parse(new TextDecoder().decode(fromBase64Url(encoded))) as Partial<CloudKmsEnvelopePayload>
  if (value.v !== 1 || value.alg !== 'AES-GCM' || typeof value.kid !== 'string' || typeof value.ek !== 'string' || typeof value.iv !== 'string' || typeof value.ct !== 'string') throw new Error('Cloud KMS secret envelope payload 不正确')
  return value as CloudKmsEnvelopePayload
}
function assertAesKey(value: Uint8Array): void { if (![16, 24, 32].includes(value.byteLength)) throw new Error('KMS data key 必须是 AES 128/192/256 key') }
function aad(context: AgentRuntimeWebSecretContext): ArrayBuffer { return asBuffer(new TextEncoder().encode(JSON.stringify({ tenantId: context.tenantId, userId: context.userId, purpose: context.purpose, resourceId: context.resourceId }))) }
function asBuffer(value: Uint8Array): ArrayBuffer { const copy = new Uint8Array(value.byteLength); copy.set(value); return copy.buffer }
function toBase64Url(value: Uint8Array): string { return btoa(String.fromCharCode(...value)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '') }
function fromBase64Url(value: string): Uint8Array { const text = atob(value.replaceAll('-', '+').replaceAll('_', '/').padEnd(Math.ceil(value.length / 4) * 4, '=')); return Uint8Array.from(text, (item) => item.charCodeAt(0)) }

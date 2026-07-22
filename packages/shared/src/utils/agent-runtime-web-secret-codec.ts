import type {
  AgentRuntimeWebSecretCodec,
  AgentRuntimeWebSecretContext,
} from './agent-runtime-web-server'

export interface WebCryptoEnvelopeSecretCodecOptions {
  keyId: string
  keyBytes: Uint8Array
  crypto?: Crypto
}

interface WebCryptoEnvelopePayload {
  v: 1
  alg: 'AES-GCM'
  kid: string
  iv: string
  ct: string
}

const ENVELOPE_PREFIX = 'proma-secret-v1.'
const AES_GCM_IV_BYTES = 12
const AES_KEY_LENGTHS = new Set([16, 24, 32])

export function createWebCryptoEnvelopeSecretCodec(
  options: WebCryptoEnvelopeSecretCodecOptions,
): AgentRuntimeWebSecretCodec {
  if (!AES_KEY_LENGTHS.has(options.keyBytes.byteLength)) {
    throw new Error('WebCrypto secret codec keyBytes 必须是 16、24 或 32 字节')
  }
  const cryptoImpl = options.crypto ?? globalThis.crypto
  if (!cryptoImpl?.subtle) {
    throw new Error('当前运行时不支持 WebCrypto subtle API')
  }

  let importedKey: Promise<CryptoKey> | undefined
  const getKey = (): Promise<CryptoKey> => {
    importedKey ??= cryptoImpl.subtle.importKey(
      'raw',
      bytesToArrayBuffer(options.keyBytes),
      { name: 'AES-GCM' },
      false,
      ['encrypt', 'decrypt'],
    )
    return importedKey
  }

  return {
    encode: async (plain, context) => {
      const iv = cryptoImpl.getRandomValues(new Uint8Array(AES_GCM_IV_BYTES))
      const ciphertext = await cryptoImpl.subtle.encrypt(
        {
          name: 'AES-GCM',
          iv: bytesToArrayBuffer(iv),
          additionalData: encodeAAD(context),
        },
        await getKey(),
        new TextEncoder().encode(plain),
      )
      const payload: WebCryptoEnvelopePayload = {
        v: 1,
        alg: 'AES-GCM',
        kid: options.keyId,
        iv: bytesToBase64Url(iv),
        ct: bytesToBase64Url(new Uint8Array(ciphertext)),
      }
      return `${ENVELOPE_PREFIX}${bytesToBase64Url(new TextEncoder().encode(JSON.stringify(payload)))}`
    },
    decode: async (encoded, context) => {
      if (!encoded.startsWith(ENVELOPE_PREFIX)) {
        throw new Error('Secret envelope 格式不正确')
      }
      const payload = parseEnvelopePayload(encoded.slice(ENVELOPE_PREFIX.length))
      if (payload.kid !== options.keyId) {
        throw new Error('Secret envelope keyId 不匹配')
      }
      const plaintext = await cryptoImpl.subtle.decrypt(
        {
          name: 'AES-GCM',
          iv: bytesToArrayBuffer(base64UrlToBytes(payload.iv)),
          additionalData: encodeAAD(context),
        },
        await getKey(),
        bytesToArrayBuffer(base64UrlToBytes(payload.ct)),
      )
      return new TextDecoder().decode(plaintext)
    },
  }
}

export function parseWebCryptoEnvelopeKey(base64Key: string): Uint8Array {
  return base64UrlToBytes(base64Key)
}

function encodeAAD(context: AgentRuntimeWebSecretContext): ArrayBuffer {
  return bytesToArrayBuffer(new TextEncoder().encode(JSON.stringify({
    tenantId: context.tenantId,
    userId: context.userId,
    purpose: context.purpose,
    resourceId: context.resourceId,
  })))
}

function parseEnvelopePayload(encodedPayload: string): WebCryptoEnvelopePayload {
  const raw = new TextDecoder().decode(base64UrlToBytes(encodedPayload))
  const value = JSON.parse(raw) as Partial<WebCryptoEnvelopePayload>
  if (
    value.v !== 1 ||
    value.alg !== 'AES-GCM' ||
    typeof value.kid !== 'string' ||
    typeof value.iv !== 'string' ||
    typeof value.ct !== 'string'
  ) {
    throw new Error('Secret envelope payload 不正确')
  }
  return value as WebCryptoEnvelopePayload
}

function bytesToBase64Url(bytes: Uint8Array): string {
  const binary = Array.from(bytes, (byte) => String.fromCharCode(byte)).join('')
  return globalThis.btoa(binary)
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '')
}

function base64UrlToBytes(value: string): Uint8Array {
  const padded = value.replaceAll('-', '+').replaceAll('_', '/').padEnd(Math.ceil(value.length / 4) * 4, '=')
  const binary = globalThis.atob(padded)
  return Uint8Array.from(binary, (char) => char.charCodeAt(0))
}

function bytesToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return copy.buffer
}

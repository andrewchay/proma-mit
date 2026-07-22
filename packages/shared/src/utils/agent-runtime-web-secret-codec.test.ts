import { describe, expect, test } from 'bun:test'
import {
  createRotatingWebCryptoEnvelopeSecretCodec,
  createWebCryptoEnvelopeSecretCodec,
  parseWebCryptoEnvelopeKey,
  reencryptWebCryptoEnvelopeSecret,
} from './agent-runtime-web-secret-codec'
import type { AgentRuntimeWebSecretContext } from './agent-runtime-web-server'

const context: AgentRuntimeWebSecretContext = {
  tenantId: 'tenant-a',
  userId: 'user-a',
  purpose: 'provider_api_key',
  resourceId: 'deepseek',
}

describe('WebCrypto envelope secret codec', () => {
  test('given valid key and scope then secret round-trips without exposing plaintext', async () => {
    const codec = createWebCryptoEnvelopeSecretCodec({
      keyId: 'test-key-v1',
      keyBytes: testKey(),
    })

    const encoded = await codec.encode('plain-secret', context)
    const decoded = await codec.decode(encoded, context)

    expect(encoded).toStartWith('proma-secret-v1.')
    expect(encoded).not.toContain('plain-secret')
    expect(decoded).toBe('plain-secret')
  })

  test('given different resource scope then decrypt is rejected by AES-GCM AAD', async () => {
    const codec = createWebCryptoEnvelopeSecretCodec({
      keyId: 'test-key-v1',
      keyBytes: testKey(),
    })
    const encoded = await codec.encode('plain-secret', context)

    await expect(codec.decode(encoded, {
      ...context,
      resourceId: 'qwen',
    })).rejects.toThrow()
  })

  test('given different key id then decode fails before decrypting', async () => {
    const first = createWebCryptoEnvelopeSecretCodec({
      keyId: 'test-key-v1',
      keyBytes: testKey(),
    })
    const second = createWebCryptoEnvelopeSecretCodec({
      keyId: 'test-key-v2',
      keyBytes: testKey(),
    })
    const encoded = await first.encode('plain-secret', context)

    await expect(second.decode(encoded, context)).rejects.toThrow('keyId')
  })

  test('given base64 envelope key then it can be parsed for codec construction', async () => {
    const keyBytes = parseWebCryptoEnvelopeKey('MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY')
    const codec = createWebCryptoEnvelopeSecretCodec({
      keyId: 'test-key-v1',
      keyBytes,
    })

    expect(await codec.decode(await codec.encode('secret', context), context)).toBe('secret')
  })

  test('given a rotated active key then new writes use it while the grace key still decrypts old ciphertext', async () => {
    const oldKey = testKey()
    const newKey = new TextEncoder().encode('fedcba9876543210fedcba9876543210')
    const oldCodec = createWebCryptoEnvelopeSecretCodec({ keyId: 'old', keyBytes: oldKey })
    const rotating = createRotatingWebCryptoEnvelopeSecretCodec({
      activeKeyId: 'new',
      keys: { old: oldKey, new: newKey },
    })
    const newOnly = createWebCryptoEnvelopeSecretCodec({ keyId: 'new', keyBytes: newKey })
    const oldCiphertext = await oldCodec.encode('secret', context)
    const newCiphertext = await rotating.encode('secret', context)

    expect(await rotating.decode(oldCiphertext, context)).toBe('secret')
    expect(await newOnly.decode(newCiphertext, context)).toBe('secret')
    await expect(newOnly.decode(oldCiphertext, context)).rejects.toThrow('keyId')
    expect(await newOnly.decode(await reencryptWebCryptoEnvelopeSecret(oldCiphertext, rotating, rotating, context), context)).toBe('secret')
  })
})

function testKey(): Uint8Array {
  return new TextEncoder().encode('0123456789abcdef0123456789abcdef')
}

import { describe, expect, test } from 'bun:test'
import { createCloudKmsEnvelopeSecretCodec } from './agent-runtime-cloud-kms-secret-codec'

describe('Cloud KMS envelope secret codec', () => {
  test('given a cloud KMS provider when encrypting then ciphertext needs the same scope to decrypt', async () => {
    const key = new Uint8Array(32).fill(7)
    const codec = createCloudKmsEnvelopeSecretCodec({ activeKeyId: 'kms-v2', providers: {
      'kms-v2': { keyId: 'kms-v2', generateDataKey: async () => ({ plaintextKey: key, encryptedKey: 'wrapped-v2' }), decryptDataKey: async (wrapped) => { expect(wrapped).toBe('wrapped-v2'); return key } },
    } })
    const context = { tenantId: 'tenant', userId: 'user', purpose: 'provider_api_key' as const, resourceId: 'channel' }
    const encrypted = await codec.encode('secret', context)
    expect(encrypted).toStartWith('proma-kms-secret-v1.')
    expect(await codec.decode(encrypted, context)).toBe('secret')
    await expect(codec.decode(encrypted, { ...context, userId: 'other' })).rejects.toThrow()
  })
})

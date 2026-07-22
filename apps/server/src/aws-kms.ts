import { DecryptCommand, GenerateDataKeyCommand, KMSClient } from '@aws-sdk/client-kms'
import type { CloudKmsDataKeyProvider, AgentRuntimeWebSecretContext } from '@proma/shared/utils'

/** AWS KMS data-key provider；凭证由标准 AWS credential provider chain 提供。 */
export class AwsKmsDataKeyProvider implements CloudKmsDataKeyProvider {
  private readonly client: KMSClient

  constructor(readonly keyId: string, options: { region: string; endpoint?: string } ) {
    this.client = new KMSClient({ region: options.region, endpoint: options.endpoint })
  }

  async generateDataKey(context: AgentRuntimeWebSecretContext): Promise<{ plaintextKey: Uint8Array; encryptedKey: string }> {
    const response = await this.client.send(new GenerateDataKeyCommand({ KeyId: this.keyId, KeySpec: 'AES_256', EncryptionContext: encryptionContext(context) }))
    if (!response.Plaintext || !response.CiphertextBlob) throw new Error('AWS KMS 未返回 data key')
    return { plaintextKey: new Uint8Array(response.Plaintext), encryptedKey: toBase64Url(new Uint8Array(response.CiphertextBlob)) }
  }

  async decryptDataKey(encryptedKey: string, context: AgentRuntimeWebSecretContext): Promise<Uint8Array> {
    const response = await this.client.send(new DecryptCommand({ CiphertextBlob: fromBase64Url(encryptedKey), EncryptionContext: encryptionContext(context), KeyId: this.keyId }))
    if (!response.Plaintext) throw new Error('AWS KMS 未返回解密后的 data key')
    return new Uint8Array(response.Plaintext)
  }
}

function encryptionContext(context: AgentRuntimeWebSecretContext): Record<string, string> {
  return { tenantId: context.tenantId, userId: context.userId, purpose: context.purpose, resourceId: context.resourceId }
}
function toBase64Url(bytes: Uint8Array): string { return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '') }
function fromBase64Url(value: string): Uint8Array { const text = atob(value.replaceAll('-', '+').replaceAll('_', '/').padEnd(Math.ceil(value.length / 4) * 4, '=')); return Uint8Array.from(text, (item) => item.charCodeAt(0)) }

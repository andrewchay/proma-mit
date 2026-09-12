import { createSign, createVerify } from 'node:crypto'
import type { EntitlementSnapshot, SubscriptionCapabilityId, SubscriptionPlanId } from '@gravitas/shared'
import { DEFAULT_ENTITLEMENT_GRACE_MS } from '@gravitas/shared'
import { SUBSCRIPTION_PLANS } from '../config'
import type { SubscriptionEntitlementRevisionRecord, SubscriptionStore } from '../db/subscription-store'

export interface EntitlementIssueInput {
  accountId: string
  planId: SubscriptionPlanId
  status: 'active' | 'expired' | 'revoked'
  validUntil?: number
  reason: string
}

export class EntitlementService {
  constructor(
    private readonly store: SubscriptionStore,
    private readonly privateKeyPem: string | undefined,
    private readonly publicKeyPem: string | undefined,
    private readonly keyId: string,
  ) {}

  async issueEntitlement(input: EntitlementIssueInput): Promise<EntitlementSnapshot> {
    const plan = SUBSCRIPTION_PLANS.find((item) => item.id === input.planId)
    const revision = await this.store.nextEntitlementRevision(input.accountId)
    const record: SubscriptionEntitlementRevisionRecord = await this.store.createEntitlementRevision({
      accountId: input.accountId,
      planId: input.planId,
      capabilities: (plan?.capabilities ?? []) as SubscriptionCapabilityId[],
      status: input.status,
      ...(input.validUntil ? { validUntil: input.validUntil } : {}),
      reason: input.reason,
      revision,
    })
    return this.toSnapshot(record)
  }

  async getCurrentSnapshot(accountId: string): Promise<EntitlementSnapshot | undefined> {
    const revision = await this.store.findLatestEntitlementRevision(accountId)
    if (!revision) return undefined
    return this.toSnapshot(revision)
  }

  signSnapshot(snapshot: EntitlementSnapshot): string {
    if (!this.privateKeyPem) {
      // 本地开发/测试环境允许未配置私钥，但签名必须显式标记为 dev，避免生产误用。
      return `dev.${snapshot.keyId}.${Buffer.from(JSON.stringify(snapshot)).toString('base64url')}`
    }
    const payload = Buffer.from(JSON.stringify(snapshot))
    const signer = createSign('RSA-SHA256')
    signer.update(payload)
    signer.end()
    return signer.sign(this.privateKeyPem, 'base64url')
  }

  verifySnapshot(snapshot: EntitlementSnapshot, signature: string): boolean {
    if (signature.startsWith('dev.')) {
      return snapshot.keyId === this.keyId || snapshot.keyId.startsWith('dev-')
    }
    if (!this.publicKeyPem) return false
    const verifier = createVerify('RSA-SHA256')
    verifier.update(Buffer.from(JSON.stringify(snapshot)))
    verifier.end()
    return verifier.verify(this.publicKeyPem, signature, 'base64url')
  }

  private toSnapshot(record: SubscriptionEntitlementRevisionRecord): EntitlementSnapshot {
    const now = Date.now()
    const status = record.status === 'active' && record.validUntil && record.validUntil >= now
      ? 'active'
      : record.status === 'active'
        ? 'grace'
        : record.status === 'revoked'
          ? 'none'
          : 'expired'
    const snapshot: EntitlementSnapshot = {
      accountId: record.accountId,
      planId: record.planId,
      capabilities: record.capabilities,
      status,
      lastVerifiedAt: new Date(now).toISOString(),
      signature: '',
      keyId: this.keyId,
      ...(record.validUntil ? { validUntil: new Date(record.validUntil).toISOString() } : {}),
      ...(status === 'grace' ? { graceUntil: new Date(now + DEFAULT_ENTITLEMENT_GRACE_MS).toISOString() } : {}),
    }
    return { ...snapshot, signature: this.signSnapshot(snapshot) }
  }
}

import { describe, expect, test, beforeAll } from 'bun:test'
import { generateKeyPairSync } from 'node:crypto'
import { join } from 'node:path'
import { verifyEntitlementSnapshotSignature } from './entitlement-signature'
import type { EntitlementSnapshot, SubscriptionPlanId } from '@gravitas/shared'

/**
 * 跨端一致性测试：直接用订阅服务的真实签名实现签发快照，
 * 再用客户端的真实验签实现校验。
 *
 * 存在的意义：签名原文由两端各自构造，字段顺序或序列化方式一旦不一致，
 * 生产环境会出现「服务端签了但客户端全部验签失败」的事故。
 * 该测试锁死两端契约，任一侧改动导致不一致都会立即失败。
 */

// 两个 app 是独立 workspace，用仓库根路径定位服务端实现，避免相对路径失效
const REPO_ROOT = join(import.meta.dir, '../../../../../..')
const SERVER_ENTITLEMENT_SERVICE = join(
  REPO_ROOT,
  'apps/subscription-service/src/services/entitlement-service.ts',
)

interface ServerEntitlementService {
  signSnapshot(snapshot: EntitlementSnapshot): string
}
type ServerEntitlementServiceCtor = new (
  store: unknown,
  privateKeyPem: string | undefined,
  publicKeyPem: string | undefined,
  keyId: string,
) => ServerEntitlementService

let privateKeyPem: string
let publicKeyPem: string
let EntitlementService: ServerEntitlementServiceCtor

beforeAll(async () => {
  const pair = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  })
  privateKeyPem = pair.privateKey
  publicKeyPem = pair.publicKey

  // 动态导入避免两个 app 之间的静态路径依赖（它们是独立 workspace）
  const mod = (await import(SERVER_ENTITLEMENT_SERVICE)) as {
    EntitlementService: ServerEntitlementServiceCtor
  }
  EntitlementService = mod.EntitlementService
})

/** 用服务端真实实现构造并签发快照 */
function issueViaServer(params: {
  planId: SubscriptionPlanId
  status: 'active' | 'grace' | 'expired' | 'none'
  validUntil?: number
}): EntitlementSnapshot {
  const service = new EntitlementService(
    {} as never,
    privateKeyPem,
    publicKeyPem,
    'prod-1',
  )

  // 直接用服务端真实的 signSnapshot 签名，锁死两端契约
  const now = Date.now()
  const snapshot: EntitlementSnapshot = {
    accountId: 'acc-1',
    planId: params.planId,
    capabilities: params.planId === 'pro' ? ['influencer', 'paid-media'] : [],
    status: params.status,
    lastVerifiedAt: new Date(now).toISOString(),
    signature: '',
    keyId: 'prod-1',
    ...(params.validUntil ? { validUntil: new Date(params.validUntil).toISOString() } : {}),
  }
  return { ...snapshot, signature: service.signSnapshot(snapshot) }
}

describe('服务端签名 → 客户端验签（跨端契约）', () => {
  test('服务端签发的 active pro 快照可被客户端验签通过', () => {
    const snapshot = issueViaServer({
      planId: 'pro',
      status: 'active',
      validUntil: Date.now() + 30 * 24 * 60 * 60 * 1000,
    })

    const result = verifyEntitlementSnapshotSignature(snapshot, publicKeyPem)
    expect(result.ok).toBe(true)
  })

  test('不含 validUntil 的快照同样可验签（可选字段缺失场景）', () => {
    const snapshot = issueViaServer({ planId: 'pro', status: 'active' })
    const result = verifyEntitlementSnapshotSignature(snapshot, publicKeyPem)
    expect(result.ok).toBe(true)
  })

  test('含 graceUntil 的快照可验签', () => {
    const now = Date.now()
    const snapshot: EntitlementSnapshot = {
      accountId: 'acc-1',
      planId: 'pro',
      capabilities: ['influencer'],
      status: 'grace',
      lastVerifiedAt: new Date(now).toISOString(),
      graceUntil: new Date(now + 72 * 60 * 60 * 1000).toISOString(),
      signature: '',
      keyId: 'prod-1',
    }

    // 借用服务端签名实现
    const store = {} as never
    const service = new EntitlementService(store, privateKeyPem, publicKeyPem, 'prod-1')
    const signed = { ...snapshot, signature: service.signSnapshot(snapshot) }

    const result = verifyEntitlementSnapshotSignature(signed, publicKeyPem)
    expect(result.ok).toBe(true)
  })

  test('服务端签发的 free 快照可被客户端验签通过', () => {
    const snapshot = issueViaServer({ planId: 'free', status: 'active' })
    const result = verifyEntitlementSnapshotSignature(snapshot, publicKeyPem)
    expect(result.ok).toBe(true)
  })

  test('客户端篡改服务端签发的快照后验签失败', () => {
    const snapshot = issueViaServer({
      planId: 'free',
      status: 'active',
    })
    // 模拟用户手改本地缓存，把 free 提升为 pro
    const tampered: EntitlementSnapshot = {
      ...snapshot,
      planId: 'pro',
      capabilities: ['influencer', 'paid-media', 'outbound-sourcing'],
    }

    const result = verifyEntitlementSnapshotSignature(tampered, publicKeyPem)
    expect(result.ok).toBe(false)
  })
})

import { describe, expect, test, beforeAll } from 'bun:test'
import { generateKeyPairSync, createSign } from 'node:crypto'
import {
  buildEntitlementSigningPayload,
  verifyEntitlementSnapshotSignature,
  isDevSignature,
} from './entitlement-signature'
import type { EntitlementSnapshot } from '@gravitas/shared'

let privateKeyPem: string
let publicKeyPem: string
let otherPublicKeyPem: string

beforeAll(() => {
  const pair = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  })
  privateKeyPem = pair.privateKey
  publicKeyPem = pair.publicKey

  const other = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  })
  otherPublicKeyPem = other.publicKey
})

function signSnapshot(snapshot: Omit<EntitlementSnapshot, 'signature'>): EntitlementSnapshot {
  // 必须先构造完整快照（含 keyId），再用同一对象生成签名原文，
  // 否则签名时的 payload 与验签时的 payload 不一致。
  const complete: EntitlementSnapshot = { ...snapshot, signature: '', keyId: 'prod-1' }
  const payload = buildEntitlementSigningPayload(complete)
  const signature = createSign('RSA-SHA256').update(payload, 'utf8').sign(privateKeyPem, 'base64url')
  return { ...complete, signature }
}

function baseSnapshot(): EntitlementSnapshot {
  return {
    accountId: 'acc-1',
    planId: 'pro',
    capabilities: ['influencer', 'paid-media'],
    status: 'active',
    keyId: 'prod-1',
    signature: '',
    lastVerifiedAt: '2026-09-13T08:00:00.000Z',
    validUntil: '2026-10-13T08:00:00.000Z',
  }
}

describe('签名原文构造', () => {
  test('字段顺序稳定，相同输入得到相同原文', () => {
    const a = buildEntitlementSigningPayload(baseSnapshot())
    const b = buildEntitlementSigningPayload(baseSnapshot())
    expect(a).toBe(b)
  })

  test('字段值变化会改变签名原文', () => {
    const base = buildEntitlementSigningPayload(baseSnapshot())
    const changed = buildEntitlementSigningPayload({ ...baseSnapshot(), planId: 'free' })
    expect(base).not.toBe(changed)
  })

  test('能力列表顺序不影响原文（需排序后参与签名）', () => {
    const a = buildEntitlementSigningPayload({
      ...baseSnapshot(),
      capabilities: ['influencer', 'paid-media'],
    })
    const b = buildEntitlementSigningPayload({
      ...baseSnapshot(),
      capabilities: ['paid-media', 'influencer'],
    })
    expect(a).toBe(b)
  })
})

describe('权益快照签名校验', () => {
  test('合法签名通过校验', () => {
    const snapshot = signSnapshot(baseSnapshot())
    const result = verifyEntitlementSnapshotSignature(snapshot, publicKeyPem)
    expect(result.ok).toBe(true)
  })

  test('篡改 planId 后校验失败', () => {
    const snapshot = signSnapshot(baseSnapshot())
    const tampered: EntitlementSnapshot = { ...snapshot, planId: 'free' }
    const result = verifyEntitlementSnapshotSignature(tampered, publicKeyPem)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('signature_mismatch')
  })

  test('篡改 capabilities 后校验失败（核心防伪场景）', () => {
    const snapshot = signSnapshot({ ...baseSnapshot(), planId: 'free', capabilities: [] })
    const tampered: EntitlementSnapshot = {
      ...snapshot,
      capabilities: ['influencer', 'paid-media', 'outbound-sourcing'],
    }
    const result = verifyEntitlementSnapshotSignature(tampered, publicKeyPem)
    expect(result.ok).toBe(false)
  })

  test('篡改 validUntil 延长有效期后校验失败', () => {
    const snapshot = signSnapshot(baseSnapshot())
    const tampered: EntitlementSnapshot = {
      ...snapshot,
      validUntil: '2099-01-01T00:00:00.000Z',
    }
    const result = verifyEntitlementSnapshotSignature(tampered, publicKeyPem)
    expect(result.ok).toBe(false)
  })

  test('篡改 lastVerifiedAt 延长宽限期后校验失败', () => {
    const snapshot = signSnapshot(baseSnapshot())
    const tampered: EntitlementSnapshot = {
      ...snapshot,
      lastVerifiedAt: '2099-01-01T00:00:00.000Z',
    }
    const result = verifyEntitlementSnapshotSignature(tampered, publicKeyPem)
    expect(result.ok).toBe(false)
  })

  test('用其他密钥签发的快照校验失败', () => {
    const snapshot = signSnapshot(baseSnapshot())
    const result = verifyEntitlementSnapshotSignature(snapshot, otherPublicKeyPem)
    expect(result.ok).toBe(false)
  })

  test('缺少 signature 时校验失败', () => {
    const snapshot = { ...baseSnapshot() } as EntitlementSnapshot
    const result = verifyEntitlementSnapshotSignature(snapshot, publicKeyPem)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('missing_signature')
  })

  test('未配置公钥时校验失败（不得静默放行）', () => {
    const snapshot = signSnapshot(baseSnapshot())
    const result = verifyEntitlementSnapshotSignature(snapshot, '')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('no_public_key')
  })

  test('签名格式非法时不抛异常', () => {
    const snapshot: EntitlementSnapshot = { ...baseSnapshot(), signature: 'not-base64!!!' }
    const result = verifyEntitlementSnapshotSignature(snapshot, publicKeyPem)
    expect(result.ok).toBe(false)
  })
})

describe('开发签名识别', () => {
  test('dev. 前缀被识别为开发签名', () => {
    expect(isDevSignature('dev.dev-1.abcdef')).toBe(true)
  })

  test('正常签名不被误判', () => {
    expect(isDevSignature('U3RhY2tPdmVyZmxvdw==')).toBe(false)
  })

  test('空签名不算开发签名', () => {
    expect(isDevSignature('')).toBe(false)
  })
})

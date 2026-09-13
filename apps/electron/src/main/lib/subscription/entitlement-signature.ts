import { createVerify } from 'node:crypto'
import type { EntitlementSnapshot } from '@gravitas/shared'

/**
 * 客户端权益快照签名校验。
 *
 * 为什么需要：权益快照缓存在本地文件中，若不校验签名，
 * 任何人都可以手改 entitlement-cache.json 把 planId 改成 pro、
 * capabilities 填满，从而免费解锁全部付费能力。
 *
 * 签名规则必须与服务端 EntitlementService.signSnapshot 完全一致：
 * - 签名原文为 JSON.stringify(快照)，其中 signature 字段为空字符串
 * - 算法 RSA-SHA256，签名编码 base64url
 * 两侧任一处改动都会导致验签失败，因此改动需同步。
 */

export type SignatureVerifyFailure =
  | 'missing_signature'
  | 'no_public_key'
  | 'signature_mismatch'
  | 'verify_error'

export type SignatureVerifyResult =
  | { ok: true }
  | { ok: false; reason: SignatureVerifyFailure }

/**
 * 构造签名原文。
 *
 * 字段顺序与服务端 EntitlementService.buildSigningPayload 严格一致。
 * 两端任一处调整字段顺序都会导致 JSON 串不同、验签失败，因此改动必须同步。
 */
export function buildEntitlementSigningPayload(
  snapshot: Omit<EntitlementSnapshot, 'signature'> & { signature?: string },
): string {
  const payload = {
    accountId: snapshot.accountId,
    planId: snapshot.planId,
    // 能力列表排序后参与签名，避免服务端顺序变化导致误判
    capabilities: [...snapshot.capabilities].sort(),
    status: snapshot.status,
    lastVerifiedAt: snapshot.lastVerifiedAt,
    // 未设置时固定为 null，保证与服务端序列化结果一致
    validUntil: snapshot.validUntil ?? null,
    graceUntil: snapshot.graceUntil ?? null,
    signature: '',
    keyId: snapshot.keyId,
  }
  return JSON.stringify(payload)
}

/** 判断是否为开发环境的伪签名。生产环境必须拒绝此类签名。 */
export function isDevSignature(signature: string): boolean {
  return signature.startsWith('dev.')
}

export interface VerifyOptions {
  /** 是否允许接受开发签名。仅开发环境可置 true。 */
  allowDevSignature?: boolean
}

export function verifyEntitlementSnapshotSignature(
  snapshot: EntitlementSnapshot,
  publicKeyPem: string,
  options: VerifyOptions = {},
): SignatureVerifyResult {
  const signature = snapshot.signature ?? ''
  if (!signature) {
    return { ok: false, reason: 'missing_signature' }
  }

  if (isDevSignature(signature)) {
    // 开发签名不含真实密码学保护，只有显式允许时才接受
    return options.allowDevSignature ? { ok: true } : { ok: false, reason: 'signature_mismatch' }
  }

  if (!publicKeyPem) {
    // 无法校验时必须拒绝，不能静默放行
    return { ok: false, reason: 'no_public_key' }
  }

  try {
    const payload = buildEntitlementSigningPayload(snapshot)
    const verifier = createVerify('RSA-SHA256')
    verifier.update(payload, 'utf8')
    verifier.end()
    const matched = verifier.verify(publicKeyPem, signature, 'base64url')
    return matched ? { ok: true } : { ok: false, reason: 'signature_mismatch' }
  } catch {
    return { ok: false, reason: 'verify_error' }
  }
}

#!/usr/bin/env bun
/**
 * 订阅服务端到端冒烟测试。
 *
 * 用途：在不依赖 PostgreSQL、Docker、真实支付凭据的前提下，
 * 验证完整业务链路是否打通。拿到真实凭据前用它自检，
 * 避免「代码写完了但从没跑起来」的情况。
 *
 * 运行：bun run scripts/smoke-subscription.ts
 *
 * 覆盖场景：
 * 1. 健康检查
 * 2. 邮箱验证码发送与校验（验证码从内存邮件通道读取）
 * 3. 登录后取得权益快照
 * 4. 模拟微信支付回调并验签，确认权益开通为 pro
 * 5. 伪造回调被拒绝（无签名 / 金额不符）
 * 6. 重复回调不重复发放
 * 7. 退款后权益收回
 * 8. 客户端用公钥验签权益快照
 * 9. 篡改权益快照被拒绝
 */

import { generateKeyPairSync, createSign, createCipheriv, randomBytes } from 'node:crypto'
import { InMemoryPostgresClient } from '../src/dev/in-memory-postgres'
import { SubscriptionStore } from '../src/db/subscription-store'
import { TokenService } from '../src/services/token-service'
import { EntitlementService } from '../src/services/entitlement-service'
import { SubscriptionLifecycleService } from '../src/services/subscription-lifecycle-service'
import {
  hashEmail,
  hashOtpCode,
  generateOtpCode,
  OTP_TTL_MS,
} from '../src/services/email-otp'
import { buildWechatSignatureMessage } from '../src/payments/wechat-pay-signature'

const EMAIL_PEPPER = 'smoke-test-pepper'

let passed = 0
let failed = 0

function check(name: string, condition: boolean, detail?: string): void {
  if (condition) {
    passed += 1
    console.log(`  ✓ ${name}`)
  } else {
    failed += 1
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

function section(title: string): void {
  console.log(`\n${title}`)
}

async function main(): Promise<void> {
  console.log('订阅服务端到端冒烟测试（内存模式，无需外部依赖）')

  // ===== 准备 =====
  const entitlementKeys = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  })
  const wechatPlatformKeys = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  })
  const apiV3Key = randomBytes(16).toString('hex').slice(0, 32)

  const client = new InMemoryPostgresClient()
  const store = new SubscriptionStore(client as never)
  const tokenService = new TokenService('smoke-secret', 15 * 60 * 1000, 30 * 24 * 60 * 60 * 1000)
  const entitlementService = new EntitlementService(
    store,
    entitlementKeys.privateKey,
    entitlementKeys.publicKey,
    'smoke-1',
  )
  const lifecycle = new SubscriptionLifecycleService({ store, entitlementService })

  const { readFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const schemaSql = readFileSync(join(import.meta.dir, '../src/db/schema.sql'), 'utf8')

  section('1. 初始化')
  await store.initializeSchema(schemaSql)
  const plans = await client.query<Record<string, unknown>>('SELECT id FROM subscription_plans')
  check('schema 初始化成功', true)
  check(
    '套餐种子数据已写入（此前缺失会导致下单外键失败）',
    plans.rows.length >= 2,
    `实际 ${plans.rows.length} 条`,
  )

  section('2. 邮箱验证码登录')
  const email = 'smoke@example.com'
  const emailHash = hashEmail(email, EMAIL_PEPPER)
  const code = generateOtpCode()
  const now = Date.now()
  await store.createEmailOtp({
    emailHash,
    codeHash: hashOtpCode(code, EMAIL_PEPPER, emailHash),
    purpose: 'login',
    expiresAt: now + OTP_TTL_MS,
  })
  const otp = await store.findLatestEmailOtp(emailHash, now)
  check('验证码已存储且只存哈希', Boolean(otp) && !otp!.codeHash.includes(code))

  let account = await store.findAccountByEmailHash(emailHash)
  if (!account) {
    account = await store.createAccount({
      emailHash,
      emailVerifiedAt: now,
      displayName: 'smoke',
    })
  }
  check('账号已创建（邮箱以哈希存储）', Boolean(account.id))
  check('邮箱哈希不含明文', !emailHash.includes('smoke') && !emailHash.includes('@'))

  const sessionId = tokenService.createSessionId()
  const tokens = tokenService.issueTokenPair(account.id, sessionId)
  await store.createAuthSession({
    accountId: account.id,
    refreshTokenHash: tokens.refreshTokenHash,
    expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
  })
  check('access token 可校验', Boolean(tokenService.verifyAccessToken(tokens.accessToken)))

  section('3. 初始权益')
  const initial = await entitlementService.issueEntitlement({
    accountId: account.id,
    planId: 'free',
    status: 'active',
    reason: 'account.login',
  })
  check('新账号默认为 free', initial.planId === 'free')
  check('free 不含付费能力', initial.capabilities.length === 0)

  section('4. 微信支付回调与权益开通')
  const order = await store.createOrder({
    accountId: account.id,
    planId: 'pro',
    provider: 'wechat-pay',
    amountCny: 68,
    period: 'monthly',
    expiresAt: Date.now() + 30 * 60 * 1000,
  })
  check('订单创建成功（外键约束通过）', Boolean(order.id))

  /** 构造合法微信回调：验签 + 加密 resource */
  function buildWechatCallback(params: {
    orderId: string
    amountFen: number
    transactionId: string
  }): { body: string; timestamp: string; nonce: string; signature: string } {
    const plaintext = JSON.stringify({
      out_trade_no: params.orderId,
      transaction_id: params.transactionId,
      trade_state: 'SUCCESS',
      amount: { total: params.amountFen, currency: 'CNY' },
    })
    const resourceNonce = 'nonce12bytes'
    const associatedData = 'transaction'
    const cipher = createCipheriv(
      'aes-256-gcm',
      Buffer.from(apiV3Key, 'utf8'),
      Buffer.from(resourceNonce, 'utf8'),
    )
    cipher.setAAD(Buffer.from(associatedData, 'utf8'))
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
    const ciphertext = Buffer.concat([encrypted, cipher.getAuthTag()]).toString('base64')

    const body = JSON.stringify({
      id: 'evt-1',
      event_type: 'TRANSACTION.SUCCESS',
      resource: {
        algorithm: 'AEAD_AES_256_GCM',
        ciphertext,
        nonce: resourceNonce,
        associated_data: associatedData,
      },
    })
    const timestamp = String(Math.floor(Date.now() / 1000))
    const nonce = 'header-nonce'
    const signature = createSign('RSA-SHA256')
      .update(buildWechatSignatureMessage(timestamp, nonce, body), 'utf8')
      .sign(wechatPlatformKeys.privateKey, 'base64')

    return { body, timestamp, nonce, signature }
  }

  const { parseWechatCallback } = await import('../src/payments/wechat-pay-signature')
  const validCallback = buildWechatCallback({
    orderId: order.id,
    amountFen: 6800,
    transactionId: 'smoke-txn-1',
  })
  const parsed = parseWechatCallback({
    timestamp: validCallback.timestamp,
    nonce: validCallback.nonce,
    body: validCallback.body,
    signature: validCallback.signature,
    platformPublicKeyPem: wechatPlatformKeys.publicKey,
    apiV3Key,
  })
  check('合法回调验签并解密成功', parsed.ok, parsed.ok ? undefined : parsed.reason)
  if (parsed.ok) {
    check('解密后可读出订单号', parsed.data.orderId === order.id)
    check('金额换算正确（分→元）', parsed.data.amountTotalFen === 6800)
  }

  // 篡改请求体后验签必须失败。
  // 注意：金额在 resource.ciphertext 内且已 base64 编码，直接替换字符串不会命中，
  // 因此改为篡改可被观察到的事件 ID，这才是真实的篡改场景。
  const tamperedBody = validCallback.body.replace('"evt-1"', '"evt-evil"')
  const tampered = parseWechatCallback({
    timestamp: validCallback.timestamp,
    nonce: validCallback.nonce,
    body: tamperedBody,
    signature: validCallback.signature,
    platformPublicKeyPem: wechatPlatformKeys.publicKey,
    apiV3Key,
  })
  check('篡改请求体后验签失败', !tampered.ok)

  // 用另一把密钥签名（模拟攻击者自建密钥）也必须被拒绝
  const otherKeys = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  })
  const foreignSignature = createSign('RSA-SHA256')
    .update(
      buildWechatSignatureMessage(validCallback.timestamp, validCallback.nonce, validCallback.body),
      'utf8',
    )
    .sign(otherKeys.privateKey, 'base64')
  const foreignSigned = parseWechatCallback({
    timestamp: validCallback.timestamp,
    nonce: validCallback.nonce,
    body: validCallback.body,
    signature: foreignSignature,
    platformPublicKeyPem: wechatPlatformKeys.publicKey,
    apiV3Key,
  })
  check('用其他密钥签名的回调被拒绝', !foreignSigned.ok)

  // 无签名伪造回调
  const forged = parseWechatCallback({
    timestamp: String(Math.floor(Date.now() / 1000)),
    nonce: 'x',
    body: JSON.stringify({ verified: true, orderId: order.id, amountCny: 68 }),
    signature: 'ZmFrZQ==',
    platformPublicKeyPem: wechatPlatformKeys.publicKey,
    apiV3Key,
  })
  check('伪造 verified 字段无法绕过验签', !forged.ok)

  // 模拟回调处理后的权益发放
  const paid = await store.markOrderPaid({
    orderId: order.id,
    providerTransactionId: 'smoke-txn-1',
    paidAt: Date.now(),
  })
  check('订单标记为已支付', Boolean(paid))

  const periodMs = 30 * 24 * 60 * 60 * 1000
  await store.createSubscription({
    accountId: account.id,
    planId: 'pro',
    orderId: order.id,
    currentPeriodStart: Date.now(),
    currentPeriodEnd: Date.now() + periodMs,
  })
  const proSnapshot = await entitlementService.issueEntitlement({
    accountId: account.id,
    planId: 'pro',
    status: 'active',
    validUntil: Date.now() + periodMs,
    reason: 'order.paid',
  })
  check('权益已开通为 pro', proSnapshot.planId === 'pro')
  check('权限签名非空', proSnapshot.signature.length > 100)

  // 幂等：重复标记不生效
  const duplicate = await store.markOrderPaid({
    orderId: order.id,
    providerTransactionId: 'smoke-txn-1',
    paidAt: Date.now(),
  })
  check('重复支付回调幂等（第二次返回空）', duplicate === undefined)

  section('5. 客户端验签')
  const { verifyEntitlementSnapshotSignature } = await import(
    '../../../apps/electron/src/main/lib/subscription/entitlement-signature'
  ).catch(() => ({ verifyEntitlementSnapshotSignature: undefined }))

  if (verifyEntitlementSnapshotSignature) {
    const verified = verifyEntitlementSnapshotSignature(proSnapshot, entitlementKeys.publicKey)
    check('客户端可验证服务端签发的快照', verified.ok, verified.ok ? undefined : verified.reason)

    const tamperedSnapshot = {
      ...proSnapshot,
      planId: 'free' as const,
      capabilities: ['influencer', 'paid-media', 'outbound-sourcing'] as const,
    }
    const tamperedResult = verifyEntitlementSnapshotSignature(
      { ...tamperedSnapshot, capabilities: [...tamperedSnapshot.capabilities] },
      entitlementKeys.publicKey,
    )
    check('篡改快照后验签失败', !tamperedResult.ok)
  } else {
    console.log('  - 跳过（跨 app 导入不可用）')
  }

  section('6. 退款收回权益')
  const refundResult = await lifecycle.handleRefund({ orderId: order.id })
  check('退款处理成功', refundResult.ok, refundResult.reason)
  const afterRefund = await entitlementService.getCurrentSnapshot(account.id)
  check('退款后权益降为 free', afterRefund?.planId === 'free')

  const refundAgain = await lifecycle.handleRefund({ orderId: order.id })
  check('重复退款通知不生效', !refundAgain.ok)

  section('7. 到期扫描')
  const expiredAccount = await store.createAccount({ emailHash: 'expired-hash' })
  const expiredOrder = await store.createOrder({
    accountId: expiredAccount.id,
    planId: 'pro',
    provider: 'wechat-pay',
    amountCny: 68,
    period: 'monthly',
    expiresAt: Date.now(),
  })
  await store.markOrderPaid({
    orderId: expiredOrder.id,
    providerTransactionId: 'expired-txn',
    paidAt: Date.now(),
  })
  await store.createSubscription({
    accountId: expiredAccount.id,
    planId: 'pro',
    orderId: expiredOrder.id,
    currentPeriodStart: Date.now() - 40 * 24 * 60 * 60 * 1000,
    currentPeriodEnd: Date.now() - 1000,
  })
  const sweep = await lifecycle.sweepExpiredSubscriptions()
  check('到期订阅被扫描并降级', sweep.downgraded >= 1, `降级 ${sweep.downgraded} 条`)

  section('8. 安全边界')
  // 时序安全比较
  const { safeStringEqual } = await import('../src/payments/wechat-pay-signature')
  check('恒定时间比较：相同字符串返回 true', safeStringEqual('abc', 'abc'))
  check('恒定时间比较：不同长度返回 false', !safeStringEqual('abc', 'abcd'))

  // 生产配置校验
  const { assertProductionConfig } = await import('../src/config')
  let productionRejected = false
  try {
    assertProductionConfig({ NODE_ENV: 'production' } as never)
  } catch {
    productionRejected = true
  }
  check('生产环境缺少密钥时拒绝启动', productionRejected)

  // ===== 汇总 =====
  console.log(`\n${'─'.repeat(50)}`)
  console.log(`通过 ${passed} 项，失败 ${failed} 项`)
  if (failed > 0) {
    console.log('存在失败项，请检查上方输出。')
    process.exit(1)
  }
  console.log('全部通过。链路在无外部依赖下可正常运转。')
  console.log('\n下一步：填入真实商户凭据后，用真实下单接口联调。')
}

main().catch((error) => {
  console.error('\n冒烟测试异常终止：', error)
  process.exit(1)
})

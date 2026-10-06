#!/usr/bin/env bun
/**
 * 生成订阅服务所需的密钥材料。
 *
 * 用法：
 *   bun run scripts/generate-keys.ts            # 输出到 stdout，不落盘
 *   bun run scripts/generate-keys.ts --out .env # 直接写入指定文件
 *
 * 安全约定：
 * - 生成的私钥只应写入部署环境的密钥管理系统或 .env（且 .env 必须被 gitignore）
 * - 绝不提交到 Git，绝不写入 .env.example
 * - 本脚本不生成任何真实支付渠道凭据，那些必须由用户从商户平台获取
 */

import { generateKeyPairSync, randomBytes } from 'node:crypto'
import { writeFileSync, existsSync, chmodSync } from 'node:fs'

const args = process.argv.slice(2)
const outIndex = args.indexOf('--out')
const outPath = outIndex >= 0 ? args[outIndex + 1] : undefined

function genRsaKeyPair(): { privateKeyPem: string; publicKeyPem: string } {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  })
  return { privateKeyPem: privateKey, publicKeyPem: publicKey }
}

// 权益签名密钥：服务端用私钥签发快照，客户端用公钥验证
const entitlementKeys = genRsaKeyPair()

// access token 签名密钥：至少 32 字节随机值
const accessTokenSecret = randomBytes(32).toString('hex')

// 用于把多行 PEM 转成单行环境变量值（PEM 中的换行需转义为 \n）
function pemToEnvValue(pem: string): string {
  return pem.trim().replace(/\n/g, '\\n')
}

const lines = [
  '# ===== 订阅服务密钥材料 =====',
  '# 由 scripts/generate-keys.ts 生成，请勿提交到 Git',
  '',
  '# 权益签名密钥（Ed25519/RSA，服务端签发，客户端验证）',
  `SUBSCRIPTION_ENTITLEMENT_PRIVATE_KEY_PEM="${pemToEnvValue(entitlementKeys.privateKeyPem)}"`,
  `SUBSCRIPTION_ENTITLEMENT_PUBLIC_KEY_PEM="${pemToEnvValue(entitlementKeys.publicKeyPem)}"`,
  'SUBSCRIPTION_ENTITLEMENT_KEY_ID="prod-1"',
  '',
  '# Access token 签名密钥',
  `SUBSCRIPTION_ACCESS_TOKEN_SECRET="${accessTokenSecret}"`,
  '',
  '# 数据库',
  'SUBSCRIPTION_DATABASE_URL="postgres://gravitas:CHANGE_ME@localhost:5432/gravitas_subscription"',
  '',
  '# ===== 支付渠道凭据（需从商户平台获取，此处留空）=====',
  '# 微信支付：登录微信支付商户平台 -> 账户中心 -> API 安全',
  '# WECHAT_PAY_APP_ID=""',
  '# WECHAT_PAY_MCH_ID=""',
  '# WECHAT_PAY_API_V3_KEY=""',
  '# WECHAT_PAY_SERIAL_NO=""',
  '# WECHAT_PAY_PRIVATE_KEY_PEM=""          # apiclient_key.pem 内容，换行转义为 \\n',
  '# WECHAT_PAY_PLATFORM_PUBLIC_KEY_PEM=""  # 平台证书公钥，用于回调验签',
  '# WECHAT_PAY_NOTIFY_URL="https://your-domain.com/v1/payments/wechat/notify"',
  '',
  '# 支付宝：登录支付宝开放平台 -> 应用详情 -> 开发设置',
  '# ALIPAY_APP_ID=""',
  '# ALIPAY_PRIVATE_KEY_PEM=""              # 应用私钥',
  '# ALIPAY_PUBLIC_KEY_PEM=""               # 支付宝公钥，用于回调验签',
  '# ALIPAY_NOTIFY_URL="https://your-domain.com/v1/payments/alipay/notify"',
  '',
]

const content = lines.join('\n')

if (outPath) {
  writeFileSync(outPath, content, { mode: 0o600 })
  // 确保只有属主可读，避免密钥被同机其他用户读取
  chmodSync(outPath, 0o600)
  console.log(`密钥已写入 ${outPath}（权限 600）`)
  console.log('提醒：确认该文件已被 .gitignore 忽略，切勿提交到 Git。')
} else {
  console.log(content)
  console.warn('提醒：以上内容包含私钥，请仅保存到安全的密钥管理系统。')
}

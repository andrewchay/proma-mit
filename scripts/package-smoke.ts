/**
 * 用临时配置启动实际安装包；仅在显式 Kimi 渠道变量存在时连接 Provider，不替换用户应用。
 *
 * 商业化后打包环境强制验签权益快照（`app.isPackaged` → 不接受 dev 伪签名），
 * 而烟测需要验证「订阅营销域后 skills 分发到工作区」。因此这里生成一对临时
 * RSA 密钥，把公钥经环境变量交给子进程，并用私钥签发一份仅存在于临时目录的
 * 权益快照。私钥不落盘、不进入版本库，测试结束后随临时目录一起删除。
 */
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync, existsSync, realpathSync } from 'node:fs'
import { join, basename, dirname, isAbsolute } from 'node:path'
import { tmpdir } from 'node:os'
import { generateKeyPairSync, createSign } from 'node:crypto'
import { exportPackageSmokeEvidence, resolvePackageSmokeEvidenceDestination } from './package-smoke-evidence'
import { assertOwnerSmokeResult } from './owner-smoke-result'

const executable = process.argv[2]
if (!executable) throw new Error('用法: bun scripts/package-smoke.ts <安装包可执行文件>')
const evidenceDirectory = process.env.GRAVITAS_OWNER_CHAIN_SMOKE_EXPORT_DIR
if (process.env.GRAVITAS_OWNER_CHAIN_SMOKE_CHANNEL_ID && !evidenceDirectory) throw new Error('真实 Owner 冒烟必须指定 GRAVITAS_OWNER_CHAIN_SMOKE_EXPORT_DIR，先保存证据再清理')
if (process.env.GRAVITAS_OWNER_CHAIN_SMOKE_CHANNEL_ID && (process.env.GRAVITAS_OWNER_PARAM_PROBE_CHANNEL_ID || process.env.GRAVITAS_PACKAGE_SMOKE_KIMI_CHANNEL_ID)) throw new Error('Owner真实冒烟不能与其他付费探针混跑')
const resumeProfile = process.env.GRAVITAS_OWNER_CHAIN_SMOKE_RESUME_PROFILE
if (resumeProfile && (!process.env.GRAVITAS_OWNER_CHAIN_SMOKE_RESUME_PROJECT_ID || process.env.GRAVITAS_OWNER_CHAIN_SMOKE_MODE !== 'project-2048'
  || !isAbsolute(resumeProfile) || !existsSync(join(resumeProfile, '.package-smoke-empty'))
  || !basename(realpathSync(resumeProfile)).startsWith('gravitas-package-smoke-') || dirname(realpathSync(resumeProfile)) !== realpathSync(tmpdir()))) {
  throw new Error('只能恢复临时目录中由冒烟创建的明确2048 profile')
}
const directory = resumeProfile ? realpathSync(resumeProfile) : mkdtempSync(join(tmpdir(), 'gravitas-package-smoke-'))
if (resumeProfile && existsSync(join(directory, 'owner-real-chain-report.json'))) throw new Error('恢复前须先保全并归档上一轮报告；本轮尚未启动，不覆盖原证据')

/** 与被测应用 buildEntitlementSigningPayload 保持一致的待签名字段 */
function buildSigningPayload(snapshot: {
  accountId: string
  planId: string
  capabilities: string[]
  status: string
  lastVerifiedAt: string
  validUntil: string | null
  graceUntil: string | null
  keyId: string
}): string {
  return JSON.stringify({
    accountId: snapshot.accountId,
    planId: snapshot.planId,
    // 能力列表排序后参与签名，与服务端行为一致
    capabilities: [...snapshot.capabilities].sort(),
    status: snapshot.status,
    lastVerifiedAt: snapshot.lastVerifiedAt,
    validUntil: snapshot.validUntil ?? null,
    graceUntil: snapshot.graceUntil ?? null,
    signature: '',
    keyId: snapshot.keyId,
  })
}

try {
  if (evidenceDirectory) resolvePackageSmokeEvidenceDestination(directory, evidenceDirectory)
  writeFileSync(join(directory, '.package-smoke-empty'), '')

  // 生成烟测专用密钥对并签发权益快照（仅授予营销 influencer 域）
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  })
  const now = new Date()
  const snapshot = {
    accountId: 'package-smoke',
    planId: 'pro',
    capabilities: ['influencer', 'knowledge-pro'],
    status: 'active',
    lastVerifiedAt: now.toISOString(),
    validUntil: new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString(),
    graceUntil: null,
    keyId: 'package-smoke-1',
  }
  const signature = createSign('RSA-SHA256')
    .update(buildSigningPayload(snapshot), 'utf8')
    .sign(privateKey, 'base64url')

  const subscriptionDir = join(directory, 'subscription')
  mkdirSync(subscriptionDir, { recursive: true })
  writeFileSync(
    join(subscriptionDir, 'entitlement-cache.json'),
    JSON.stringify({ snapshot: { ...snapshot, signature }, cachedAt: Date.now() }, null, 2),
  )

  if (process.env.GRAVITAS_OWNER_CHAIN_SMOKE_CHANNELS_PATH) {
    copyFileSync(process.env.GRAVITAS_OWNER_CHAIN_SMOKE_CHANNELS_PATH, join(directory, 'channels.json'))
  }
  if (process.env.GRAVITAS_OWNER_PARAM_PROBE_CHANNELS_PATH) {
    copyFileSync(process.env.GRAVITAS_OWNER_PARAM_PROBE_CHANNELS_PATH, join(directory, 'channels.json'))
  }
  if (process.env.GRAVITAS_PACKAGE_SMOKE_KIMI_CHANNEL_ID) {
    const channelsPath = process.env.GRAVITAS_PACKAGE_SMOKE_CHANNELS_PATH
    if (!channelsPath) throw new Error('真实 Kimi 烟测必须指定 GRAVITAS_PACKAGE_SMOKE_CHANNELS_PATH')
    copyFileSync(channelsPath, join(directory, 'channels.json'))
  }
  const child = Bun.spawn([executable, ...process.argv.slice(3)], {
    env: {
      ...process.env,
      // 父 Agent 可能以 Electron Node 模式运行；不得让被测应用静默退化为 Node。
      ELECTRON_RUN_AS_NODE: undefined,
      GRAVITAS_PACKAGE_SMOKE: '1',
      PROMA_TEST_CONFIG_DIR: directory,
      PROMA_ALLOW_MULTI_INSTANCE: '1',
      // 打包环境用此公钥验证上面签发的权益快照
      GRAVITAS_SUBSCRIPTION_ENTITLEMENT_PUBLIC_KEY_PEM: publicKey,
    },
    stdout: 'inherit', stderr: 'inherit',
  })
  const timeoutMs = process.env.GRAVITAS_OWNER_CHAIN_SMOKE_CHANNEL_ID ? (process.env.GRAVITAS_OWNER_CHAIN_SMOKE_MODE === 'project-2048' ? 780_000 : 420_000) : process.env.GRAVITAS_PACKAGE_SMOKE_KIMI_CHANNEL_ID ? 180_000 : 120_000
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    child.kill()
  }, timeoutMs)
  try {
    const exitCode = await child.exited
    if (timedOut) throw new Error(`实际安装包烟测超时（${timeoutMs}ms）`)
    if (exitCode !== 0) throw new Error(`实际安装包烟测失败，exitCode=${exitCode}`)
    if (process.env.GRAVITAS_OWNER_CHAIN_SMOKE_CHANNEL_ID) {
      assertOwnerSmokeResult(JSON.parse(readFileSync(join(directory, 'owner-real-chain-report.json'), 'utf8')), process.env.GRAVITAS_OWNER_CHAIN_SMOKE_MODE ?? 'segment')
    }
    console.log(`[Package Smoke] 子进程正常结束: exitCode=${exitCode}`)
  } finally { clearTimeout(timer) }
} finally {
  if (evidenceDirectory) {
    try {
      const files = exportPackageSmokeEvidence(directory, evidenceDirectory)
      console.log(`[Package Smoke] 已导出 ${files.length} 个证据文件：${evidenceDirectory}`)
    } catch (cause) {
      console.error(`[Package Smoke] 证据导出失败，原隔离 profile 保留于：${directory}`)
      throw cause
    }
  }
  if (!resumeProfile && process.env.GRAVITAS_OWNER_CHAIN_SMOKE_KEEP_PROFILE !== '1') rmSync(directory, { recursive: true, force: true })
  else console.log(`[Package Smoke] 完整隔离 profile 保留，便于同项目恢复：${directory}`)
}

import { spawn } from 'node:child_process'
import { createSign, generateKeyPairSync } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const executable = process.argv[2]
const profile = process.argv[3] ? resolve(process.argv[3]) : ''
if (!executable || !profile || !existsSync(join(profile, '.package-smoke-empty'))) throw new Error('需要固定应用与已保全的隔离 Profile')
if (existsSync(join(profile, 'owner-real-chain-report.json'))) throw new Error('恢复前必须保全旧报告')

const { publicKey, privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
})
const now = new Date()
const snapshot = {
  accountId: 'package-smoke', planId: 'pro', capabilities: ['influencer', 'knowledge-pro'],
  status: 'active', lastVerifiedAt: now.toISOString(),
  validUntil: new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString(), graceUntil: null,
  keyId: 'package-smoke-1', signature: '',
}
const payload = JSON.stringify({
  accountId: snapshot.accountId, planId: snapshot.planId,
  capabilities: [...snapshot.capabilities].sort(), status: snapshot.status,
  lastVerifiedAt: snapshot.lastVerifiedAt, validUntil: snapshot.validUntil,
  graceUntil: snapshot.graceUntil, signature: '', keyId: snapshot.keyId,
})
snapshot.signature = createSign('RSA-SHA256').update(payload, 'utf8').sign(privateKey, 'base64url')
const subscription = join(profile, 'subscription')
mkdirSync(subscription, { recursive: true })
writeFileSync(join(subscription, 'entitlement-cache.json'), JSON.stringify({ snapshot, cachedAt: Date.now() }, null, 2))

const child = spawn(executable, [], {
  env: {
    ...process.env,
    ELECTRON_RUN_AS_NODE: undefined,
    GRAVITAS_PACKAGE_SMOKE: '1',
    PROMA_TEST_CONFIG_DIR: profile,
    PROMA_ALLOW_MULTI_INSTANCE: '1',
    GRAVITAS_SUBSCRIPTION_ENTITLEMENT_PUBLIC_KEY_PEM: publicKey,
    GRAVITAS_OWNER_CHAIN_SMOKE_CHANNEL_ID: '642b2570-fb0c-4890-a4fe-f277718108a9',
    GRAVITAS_OWNER_CHAIN_SMOKE_MODEL: 'glm-5.3-flash',
    GRAVITAS_OWNER_CHAIN_SMOKE_MODE: 'project-2048',
    GRAVITAS_OWNER_CHAIN_SMOKE_RESUME_PROJECT_ID: 'a9854f58-9954-48a0-8705-f41bfaf8c7e4',
    GRAVITAS_OWNER_CHAIN_SMOKE_MAX_REQUESTS: '100',
    GRAVITAS_OWNER_CHAIN_SMOKE_PRIOR_REQUESTS: '0',
    GRAVITAS_OWNER_CHAIN_SMOKE_PRIOR_COST_MICROS: '12614',
    GRAVITAS_OWNER_CHAIN_SMOKE_REPLAN_SINGLE_STEP: undefined,
    GRAVITAS_OWNER_CHAIN_SMOKE_RESUME_START_INTENT: undefined,
    GRAVITAS_OWNER_CHAIN_SMOKE_RECOVER_OWNER_EXECUTION_ID: undefined,
    GRAVITAS_OWNER_CHAIN_SMOKE_REVALIDATE_ARTIFACT_HASH: undefined,
    GRAVITAS_OWNER_CHAIN_SMOKE_RENEW_EXPIRED: undefined,
  },
  stdio: 'inherit',
})
const timer = setTimeout(() => child.kill(), 120_000)
const exitCode = await new Promise<number>((resolveExit, reject) => {
  child.once('error', reject)
  child.once('exit', code => resolveExit(code ?? -1))
}).finally(() => clearTimeout(timer))
if (exitCode !== 0) throw new Error(`固定包恢复复验失败，exitCode=${exitCode}；不自动重试`)

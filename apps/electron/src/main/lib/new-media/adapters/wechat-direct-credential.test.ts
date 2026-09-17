import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  WECHAT_DIRECT_CAPABILITY_RULES,
  WECHAT_DIRECT_EXTERNAL_CAPABILITIES,
  negotiateWechatDirectCapabilities,
  toWechatPlatformCapabilities,
  type WechatDirectNegotiationInput,
} from './wechat-direct-capability'
import {
  assertWechatDirectCredentialFormat,
  describeWechatDirectCredential,
  isValidWechatAppId,
  isValidWechatAppSecret,
  loadWechatDirectCredential,
} from './wechat-direct-credential'
import {
  connectWechatDirectAccount,
  createNewMediaAccount,
  configureWechatDirectAccount,
  disconnectNewMediaAccount,
  getNewMediaAccount,
  getNewMediaAccountAudit,
  getNewMediaAccountCapabilityStates,
  getNewMediaAccountProfile,
  recordWechatObservedScopes,
  updateWechatDirectAccountProfile,
} from '../new-media-account-service'
import { clearWechatTokenCache, type WechatTokenTransport } from './wechat-direct-token-service'
import { clearNewMediaRecordsForTests, closeNewMediaDb } from '../new-media-sqlite-store'

let testDir = ''
const SECRET = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'
const APP_ID = 'wx1234567890abcdef'

beforeAll(() => { testDir = mkdtempSync(join(tmpdir(), 'gravitas-nm-wechat-')); process.env.PROMA_TEST_CONFIG_DIR = testDir })
afterEach(async () => { await clearNewMediaRecordsForTests() })
afterAll(() => { closeNewMediaDb(); delete process.env.PROMA_TEST_CONFIG_DIR; rmSync(testDir, { recursive: true, force: true }) })

function negotiate(overrides: Partial<WechatDirectNegotiationInput> = {}) {
  return negotiateWechatDirectCapabilities({
    accountType: 'service',
    verificationStatus: 'verified',
    grantedScopes: ['material', 'draft', 'freepublish', 'analysis', 'comment', 'message'],
    ipWhitelistConfigured: true,
    hasCredential: true,
    connected: true,
    ...overrides,
  })
}

describe('P2-01 微信 direct 凭据模型', () => {
  test('AppID 与 AppSecret 格式校验严格，错误信息不回显凭据', () => {
    expect(isValidWechatAppId(APP_ID)).toBe(true)
    expect(isValidWechatAppId('wxshort')).toBe(false)
    expect(isValidWechatAppId('1234567890abcdef')).toBe(false)
    expect(isValidWechatAppSecret(SECRET)).toBe(true)
    expect(isValidWechatAppSecret('short')).toBe(false)

    expect(() => assertWechatDirectCredentialFormat({ appId: '', appSecret: SECRET })).toThrow('AppID 不能为空')
    expect(() => assertWechatDirectCredentialFormat({ appId: 'bad', appSecret: SECRET })).toThrow(/AppID 格式不正确/)
    expect(() => assertWechatDirectCredentialFormat({ appId: APP_ID, appSecret: 'oops-secret-value' })).toThrow(/AppSecret 格式不正确/)
    try {
      assertWechatDirectCredentialFormat({ appId: APP_ID, appSecret: 'oops-secret-value' })
    } catch (error) {
      expect((error as Error).message).not.toContain('oops-secret-value')
    }
  })

  test('凭据只进入加密 Store，账号元数据与审计都不含 AppSecret', async () => {
    const account = await createNewMediaAccount({ platform: 'wechat-official-account', displayName: '品牌服务号' })
    const configured = await configureWechatDirectAccount(account.id, {
      appId: APP_ID,
      appSecret: SECRET,
      accountType: 'service',
      verificationStatus: 'verified',
      ipWhitelistConfigured: true,
    })

    expect(configured.credentialRef).toBeDefined()
    expect(configured.wechatDirect?.appId).toBe(APP_ID)
    // 账号记录本身不得包含 AppSecret
    expect(JSON.stringify(configured)).not.toContain(SECRET)
    // 审计同样不得包含 AppSecret
    expect(JSON.stringify(await getNewMediaAccountAudit(account.id))).not.toContain(SECRET)
    // 业务数据库文件里也不得出现明文
    expect(readFileSync(join(testDir, 'new-media', 'new-media.db')).includes(Buffer.from(SECRET))).toBe(false)
    // 凭据可从加密 Store 读回
    expect(loadWechatDirectCredential(configured.credentialRef as string)?.appSecret).toBe(SECRET)

    const descriptor = describeWechatDirectCredential(configured.credentialRef as string)
    expect(descriptor.appId).toBe(APP_ID)
    expect(descriptor.hasAppSecret).toBe(true)
    expect(JSON.stringify(descriptor)).not.toContain(SECRET)
  })

  test('配置凭据不会让账号变成 connected，且未连接时不能写入权限集', async () => {
    const account = await createNewMediaAccount({ platform: 'wechat-official-account', displayName: '测试号' })
    const configured = await configureWechatDirectAccount(account.id, {
      appId: APP_ID,
      appSecret: SECRET,
      accountType: 'test',
      verificationStatus: 'unverified',
      ipWhitelistConfigured: false,
    })
    expect(configured.status).toBe('disconnected')
    expect(configured.capabilityStates?.every((item) => item.enabled)).toBe(false)
    expect(configured.capabilityStates?.[0]?.reason).toBe('not_connected')

    await expect(configureWechatDirectAccount(account.id, {
      appId: APP_ID,
      appSecret: SECRET,
      accountType: 'service',
      verificationStatus: 'verified',
      ipWhitelistConfigured: true,
      grantedScopes: ['draft'],
    })).rejects.toThrow('不能写入接口权限集')
  })

  test('断开账号后凭据被清除，档案与能力状态不再残留', async () => {
    const account = await createNewMediaAccount({ platform: 'wechat-official-account', displayName: '服务号' })
    const configured = await configureWechatDirectAccount(account.id, {
      appId: APP_ID, appSecret: SECRET, accountType: 'service', verificationStatus: 'verified', ipWhitelistConfigured: true,
    })
    const credentialRef = configured.credentialRef as string
    expect(loadWechatDirectCredential(credentialRef)).toBeDefined()

    const disconnected = await disconnectNewMediaAccount(account.id)
    expect(disconnected.credentialRef).toBeUndefined()
    expect(disconnected.credentialProtection).toBe('none')
    expect(loadWechatDirectCredential(credentialRef)).toBeUndefined()
    expect(await getNewMediaAccountProfile(account.id)).toBeUndefined()
    expect(await getNewMediaAccountCapabilityStates(account.id)).toEqual([])
  })
})

describe('P2-02 微信 direct 连接与权限观察', () => {
  test('凭据校验成功后连接账号，但接口权限保持未观察状态', async () => {
    const account = await createNewMediaAccount({ platform: 'wechat-official-account', displayName: '服务号' })
    await configureWechatDirectAccount(account.id, {
      appId: APP_ID, appSecret: SECRET, accountType: 'service', verificationStatus: 'verified', ipWhitelistConfigured: true,
    })
    const transport: WechatTokenTransport = async () => ({ status: 200, text: async () => JSON.stringify({ access_token: 'TOKEN-CONNECT', expires_in: 7200 }) })
    const connected = await connectWechatDirectAccount(account.id, { transport })

    expect(connected.status).toBe('connected')
    expect(connected.errorCode).toBeUndefined()
    expect(connected.wechatDirect?.grantedScopes).toEqual([])
    expect(connected.wechatDirect?.stableTokenExpiresAt).toBeDefined()
    // 微信不返回权限清单，因此所有能力都应因缺少权限观察而关闭
    expect(connected.capabilityStates?.every((state) => !state.enabled)).toBe(true)
    expect(connected.capabilityStates?.every((state) => state.reason === 'scope_not_granted')).toBe(true)
    expect(connected.capabilities.publish).toBe(false)

    const audit = await getNewMediaAccountAudit(account.id)
    expect(audit.map((entry) => entry.event)).toEqual(['account_created', 'authorization_started', 'connected'])
    expect(JSON.stringify(audit)).not.toContain(SECRET)
    expect(JSON.stringify(audit)).not.toContain('TOKEN-CONNECT')
    clearWechatTokenCache()
  })

  test('凭据校验失败时账号进入错误状态并保留可诊断错误码', async () => {
    const account = await createNewMediaAccount({ platform: 'wechat-official-account', displayName: '服务号' })
    await configureWechatDirectAccount(account.id, {
      appId: APP_ID, appSecret: SECRET, accountType: 'service', verificationStatus: 'verified', ipWhitelistConfigured: false,
    })
    const transport: WechatTokenTransport = async () => ({ status: 200, text: async () => JSON.stringify({ errcode: 40164, errmsg: 'invalid ip' }) })
    await expect(connectWechatDirectAccount(account.id, { transport })).rejects.toThrow(/IP 白名单/)

    const failed = await getNewMediaAccount(account.id)
    expect(failed?.status).toBe('error')
    expect(failed?.errorCode).toBe('ip_not_whitelisted')
    const audit = await getNewMediaAccountAudit(account.id)
    expect(audit.at(-1)?.event).toBe('validation_failed')
    expect(audit.at(-1)?.detail).toContain('ip_not_whitelisted')
    clearWechatTokenCache()
  })

  test('只有真实调用结果才能开启能力，撤销权限会立即关闭', async () => {
    const account = await createNewMediaAccount({ platform: 'wechat-official-account', displayName: '服务号' })
    await configureWechatDirectAccount(account.id, {
      appId: APP_ID, appSecret: SECRET, accountType: 'service', verificationStatus: 'verified', ipWhitelistConfigured: true,
    })
    const transport: WechatTokenTransport = async () => ({ status: 200, text: async () => JSON.stringify({ access_token: 'TOKEN-OBS', expires_in: 7200 }) })
    await connectWechatDirectAccount(account.id, { transport })

    const observed = await recordWechatObservedScopes(account.id, { grantedScopes: ['material', 'draft'] })
    expect(observed.wechatDirect?.grantedScopes.sort()).toEqual(['draft', 'material'])
    expect(observed.capabilityStates?.find((state) => state.capability === 'draft:create')?.enabled).toBe(true)
    expect(observed.capabilityStates?.find((state) => state.capability === 'freepublish:submit')?.enabled).toBe(false)
    expect(observed.capabilities.remoteDraft).toBe(true)
    expect(observed.capabilities.publish).toBe(false)

    const revoked = await recordWechatObservedScopes(account.id, { deniedScopes: ['draft'] })
    expect(revoked.wechatDirect?.grantedScopes).toEqual(['material'])
    expect(revoked.capabilities.remoteDraft).toBe(false)

    // 断开后凭据与档案被清空，不能再写入权限观察
    await disconnectNewMediaAccount(account.id)
    await expect(recordWechatObservedScopes(account.id, { grantedScopes: ['draft'] })).rejects.toThrow('尚未配置微信公众号凭据')

    // 仅配置凭据但未连接的账号同样拒绝写入权限观察
    const pending = await createNewMediaAccount({ platform: 'wechat-official-account', displayName: '未连接服务号' })
    await configureWechatDirectAccount(pending.id, {
      appId: APP_ID, appSecret: SECRET, accountType: 'service', verificationStatus: 'verified', ipWhitelistConfigured: true,
    })
    await expect(recordWechatObservedScopes(pending.id, { grantedScopes: ['draft'] })).rejects.toThrow('尚未连接')
    clearWechatTokenCache()
  })
})

describe('P2-01 微信 direct 能力协商', () => {
  test('能力矩阵覆盖草稿、发布、分析与互动，并标注对外副作用', () => {
    const capabilities = WECHAT_DIRECT_CAPABILITY_RULES.map((rule) => rule.capability)
    expect(capabilities).toContain('draft:create')
    expect(capabilities).toContain('freepublish:submit')
    expect(capabilities).toContain('analysis:article')
    expect(capabilities).toContain('comment:read')
    expect(capabilities).toContain('message:customer-service')
    expect(WECHAT_DIRECT_CAPABILITY_RULES.every((rule) => rule.requiredScopes.length > 0)).toBe(true)
    expect(WECHAT_DIRECT_EXTERNAL_CAPABILITIES).toEqual(['freepublish:submit', 'comment:reply', 'message:customer-service'])
    // 服务号专属能力不得对订阅号或测试号开放
    const customerService = WECHAT_DIRECT_CAPABILITY_RULES.find((rule) => rule.capability === 'message:customer-service')
    expect(customerService?.allowedAccountTypes).toEqual(['service'])
    const submit = WECHAT_DIRECT_CAPABILITY_RULES.find((rule) => rule.capability === 'freepublish:submit')
    expect(submit?.allowedAccountTypes).toEqual(['subscription', 'service'])
  })

  test('未配置凭据时全部关闭并给出 no_credential', () => {
    const result = negotiate({ hasCredential: false, connected: false })
    expect(result.enabledCapabilities).toEqual([])
    expect(result.capabilities.every((item) => item.reason === 'no_credential')).toBe(true)
  })

  test('已认证服务号且权限齐备时按权限集精确开启', () => {
    const result = negotiate()
    expect(result.enabledCapabilities).toContain('draft:create')
    expect(result.enabledCapabilities).toContain('freepublish:submit')
    expect(result.enabledCapabilities).toContain('message:customer-service')
    expect(result.missingScopes).toEqual([])
    expect(result.capabilities.every((item) => item.explanation.includes('均已满足'))).toBe(true)
  })

  test('缺少平台权限时保持关闭并列出缺口，不本地补全', () => {
    const result = negotiate({ grantedScopes: ['material', 'draft'] })
    expect(result.enabledCapabilities).toContain('draft:create')
    expect(result.enabledCapabilities).not.toContain('freepublish:submit')
    expect(result.missingScopes.sort()).toEqual(['analysis', 'comment', 'freepublish', 'message'])
    const submit = result.capabilities.find((item) => item.capability === 'freepublish:submit')
    expect(submit?.reason).toBe('scope_not_granted')
    expect(submit?.explanation).toContain('freepublish')
  })

  test('测试号不能发布，未认证账号与未配置白名单都被拒绝', () => {
    const testAccount = negotiate({ accountType: 'test' })
    expect(testAccount.enabledCapabilities).toContain('draft:create')
    expect(testAccount.capabilities.find((item) => item.capability === 'freepublish:submit')?.reason).toBe('account_type_not_allowed')

    const unverified = negotiate({ verificationStatus: 'unverified' })
    expect(unverified.capabilities.find((item) => item.capability === 'draft:create')?.reason).toBe('verification_required')

    const noWhitelist = negotiate({ ipWhitelistConfigured: false })
    expect(noWhitelist.capabilities.find((item) => item.capability === 'draft:create')?.reason).toBe('ip_whitelist_required')
  })

  test('平台能力快照只在提交与状态查询同时可用时才标记可发布', () => {
    const both = negotiate({ grantedScopes: ['draft', 'freepublish'] })
    expect(toWechatPlatformCapabilities(both).publish).toBe(true)

    const partial = toWechatPlatformCapabilities(negotiate({ grantedScopes: ['draft'] }))
    expect(partial.remoteDraft).toBe(true)
    expect(partial.publish).toBe(false)

    // 微信把留言读取与回复放在同一个接口权限下，因此两者同时可用；
    // 回复仍属于对外副作用能力，必须走单独人工审批（见 externalSideEffect）。
    const commentScope = negotiate({ grantedScopes: ['comment'] })
    const readOnly = toWechatPlatformCapabilities(commentScope)
    expect(readOnly.readEngagements).toBe(true)
    expect(readOnly.sendReply).toBe(true)
    expect(readOnly.localDraft).toBe(true)
    expect(commentScope.capabilities.find((item) => item.capability === 'comment:reply')?.externalSideEffect).toBe(true)
  })

  test('账号档案更新会重新协商并保留审计', async () => {
    const account = await createNewMediaAccount({ platform: 'wechat-official-account', displayName: '服务号' })
    await configureWechatDirectAccount(account.id, {
      appId: APP_ID, appSecret: SECRET, accountType: 'subscription', verificationStatus: 'unverified', ipWhitelistConfigured: false,
    })
    const updated = await updateWechatDirectAccountProfile(account.id, { verificationStatus: 'verified', ipWhitelistConfigured: true })
    expect(updated.wechatDirect?.verificationStatus).toBe('verified')
    expect(updated.wechatDirect?.ipWhitelistConfigured).toBe(true)
    // 仍未通过平台校验，能力依旧关闭
    expect(updated.capabilityStates?.every((item) => !item.enabled)).toBe(true)

    const audit = await getNewMediaAccountAudit(account.id)
    expect(audit.map((entry) => entry.event)).toEqual(['account_created', 'authorization_started', 'authorization_started'])
    expect(JSON.stringify(audit)).not.toContain(SECRET)

    const reloaded = await getNewMediaAccount(account.id)
    expect(reloaded?.wechatDirect?.accountType).toBe('subscription')
  })
})

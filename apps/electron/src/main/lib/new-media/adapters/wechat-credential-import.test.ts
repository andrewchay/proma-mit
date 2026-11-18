import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { NewMediaConnectedAccount } from '@gravitas/shared'
import { importWechatCredentialFile } from './wechat-credential-import'

const directory = mkdtempSync(join(tmpdir(), 'wechat-import-'))
const prior = process.env.PROMA_TEST_CONFIG_DIR
process.env.PROMA_TEST_CONFIG_DIR = directory
afterAll(async () => { (await import('../new-media-sqlite-store')).closeNewMediaDb(); if (prior === undefined) delete process.env.PROMA_TEST_CONFIG_DIR; else process.env.PROMA_TEST_CONFIG_DIR = prior; rmSync(directory, { recursive: true, force: true }) })
const file = join(directory, 'credentials.json')
const secret = '0123456789abcdef0123456789abcdef'
const account = { id: 'a', platform: 'wechat-official-account', credentialProtection: 'none' } as NewMediaConnectedAccount
const options = { accountType: 'service', verificationStatus: 'verified', ipWhitelistConfigured: true } as const

test('主进程读取用户选择文件，账号结果不含密钥或文件路径', async () => {
  writeFileSync(file, JSON.stringify({ appId: 'wx1234567890abcdef', appSecret: secret }))
  let captured = ''
  const result = await importWechatCredentialFile('a', file, options, {
    isProtected: () => true, getAccount: async () => account,
    configure: async (_id, input) => { captured = input.appSecret; return account },
  })
  expect(captured).toBe(secret)
  expect(JSON.stringify(result)).not.toContain(secret)
  expect(JSON.stringify(result)).not.toContain(file)
})

test('未加密、重复凭据、无效文件与符号链接均拒绝导入', async () => {
  await expect(importWechatCredentialFile('a', file, options, { isProtected: () => false })).rejects.toThrow('安全存储')
  await expect(importWechatCredentialFile('a', file, options, { isProtected: () => true, getAccount: async () => ({ ...account, credentialRef: 'existing' }) })).rejects.toThrow('已有凭据')
  const invalid = join(directory, 'invalid.json')
  writeFileSync(invalid, '{bad secret}')
  await expect(importWechatCredentialFile('a', invalid, options, { isProtected: () => true, getAccount: async () => account })).rejects.toThrow('有效的 JSON')
  const link = join(directory, 'link.json')
  symlinkSync(file, link)
  await expect(importWechatCredentialFile('a', link, options, { isProtected: () => true, getAccount: async () => account })).rejects.toThrow('无法读取')
})


test('读取文件期间断开账号，旧导入不能在断开后重新保存凭据', async () => {
  const { createNewMediaAccount, disconnectNewMediaAccount } = await import('../new-media-account-service')
  const created = await createNewMediaAccount({ platform: 'wechat-official-account', displayName: '测试公众号' })
  let release!: () => void
  let began!: () => void
  const ready = new Promise<void>(resolve => { began = resolve })
  const gate = new Promise<void>(resolve => { release = resolve })
  const pending = importWechatCredentialFile(created.id, file, options, { isProtected: () => true, getAccount: async () => { began(); await gate; return created } })
  await ready
  await disconnectNewMediaAccount(created.id)
  release()
  await expect(pending).rejects.toThrow('账号状态已变更')
})

test('选择文件期间断开账号后，旧选择不能重新保存凭据', async () => {
  const { createNewMediaAccount, disconnectNewMediaAccount } = await import('../new-media-account-service')
  const { getWechatAccountRevocationVersion } = await import('../wechat-account-lock')
  const created = await createNewMediaAccount({ platform: 'wechat-official-account', displayName: '测试公众号' })
  const version = getWechatAccountRevocationVersion(created.id)
  await disconnectNewMediaAccount(created.id)
  await expect(importWechatCredentialFile(created.id, file, options, { isProtected: () => true, expectedRevocationVersion: version })).rejects.toThrow('账号状态已变更')
})

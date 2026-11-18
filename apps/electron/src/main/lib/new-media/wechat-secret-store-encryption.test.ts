import { afterAll, expect, mock, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildElectronMock } from '../testing/electron-mock'
mock.module('electron', () => buildElectronMock())
const { saveNewMediaAccountSecret, hasStrongSafeStorage } = await import('./new-media-account-secret-store')
const directory = mkdtempSync(join(tmpdir(), 'nm-secret-strict-'))
const prior = process.env.PROMA_TEST_CONFIG_DIR
process.env.PROMA_TEST_CONFIG_DIR = directory
afterAll(() => { if (prior === undefined) delete process.env.PROMA_TEST_CONFIG_DIR; else process.env.PROMA_TEST_CONFIG_DIR = prior; rmSync(directory, { recursive: true, force: true }) })

test('已标记必须加密的材料在后续写回时不允许降级', () => {
  const base = join(directory, 'new-media')
  mkdirSync(base, { recursive: true })
  const path = join(base, 'account-secrets.enc')
  const existing = Buffer.from(JSON.stringify({ first: { accessToken: 'fixture', requireEncryption: true } })).toString('base64')
  writeFileSync(path, existing)
  expect(() => saveNewMediaAccountSecret('second', { accessToken: 'new' })).toThrow('无法加密公众号凭据')
  expect(readFileSync(path, 'utf8')).toBe(existing)
})


test('Linux 无系统密钥服务时拒绝 basic_text 与未知后端', () => {
  expect(hasStrongSafeStorage({ isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'basic_text' }, 'linux')).toBe(false)
  expect(hasStrongSafeStorage({ isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'unknown' }, 'linux')).toBe(false)
  expect(hasStrongSafeStorage({ isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'gnome_libsecret' }, 'linux')).toBe(true)
  expect(hasStrongSafeStorage({ isEncryptionAvailable: () => true }, 'darwin')).toBe(true)
})

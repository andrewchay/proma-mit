import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  getNewMediaCredentialProtection,
  hasNewMediaAccountSecret,
  loadNewMediaAccountSecret,
  removeNewMediaAccountSecret,
  saveNewMediaAccountSecret,
} from './new-media-account-secret-store'
import { closeNewMediaDb, getNewMediaSchemaInfo, initNewMediaDb } from './new-media-sqlite-store'

let testDir = ''
const secretPath = (): string => join(testDir, 'new-media', 'account-secrets.enc')
const dbPath = (): string => join(testDir, 'new-media', 'new-media.db')

beforeAll(() => { testDir = mkdtempSync(join(tmpdir(), 'gravitas-nm-secret-')); process.env.PROMA_TEST_CONFIG_DIR = testDir })
afterEach(() => { removeNewMediaAccountSecret('ref-a'); removeNewMediaAccountSecret('ref-b') })
afterAll(async () => { closeNewMediaDb(); delete process.env.PROMA_TEST_CONFIG_DIR; rmSync(testDir, { recursive: true, force: true }) })

describe('新媒体账号凭据隔离', () => {
  test('授权材料只写入独立 Secret Store，不落业务数据库', async () => {
    await initNewMediaDb()
    saveNewMediaAccountSecret('ref-a', { accessToken: 'token-value-abcdefghijklmnop', refreshToken: 'refresh-value', scopes: ['draft'] })

    expect(existsSync(secretPath())).toBe(true)
    expect(loadNewMediaAccountSecret('ref-a')?.accessToken).toBe('token-value-abcdefghijklmnop')

    // 业务数据库文件与记录中都不应出现明文凭据。
    const dbBytes = readFileSync(dbPath())
    expect(dbBytes.includes(Buffer.from('token-value-abcdefghijklmnop'))).toBe(false)
    expect(JSON.stringify(await getNewMediaSchemaInfo())).not.toContain('token-value-abcdefghijklmnop')
  })

  test('返回值是副本，修改不影响已存材料', () => {
    saveNewMediaAccountSecret('ref-a', { accessToken: 'token-1', scopes: ['draft'] })
    const first = loadNewMediaAccountSecret('ref-a')
    first!.scopes!.push('mutated')
    first!.accessToken = 'overwritten'
    expect(loadNewMediaAccountSecret('ref-a')?.accessToken).toBe('token-1')
    expect(loadNewMediaAccountSecret('ref-a')?.scopes).toEqual(['draft'])
  })

  test('多账号互不覆盖，删除只影响目标引用', () => {
    saveNewMediaAccountSecret('ref-a', { accessToken: 'token-a' })
    saveNewMediaAccountSecret('ref-b', { accessToken: 'token-b' })
    expect(hasNewMediaAccountSecret('ref-a')).toBe(true)
    expect(removeNewMediaAccountSecret('ref-a')).toBe(true)
    expect(hasNewMediaAccountSecret('ref-a')).toBe(false)
    expect(loadNewMediaAccountSecret('ref-b')?.accessToken).toBe('token-b')
    expect(removeNewMediaAccountSecret('ref-a')).toBe(false)
  })

  test('凭据保护等级明确暴露加密或降级状态', () => {
    expect(['encrypted', 'degraded']).toContain(getNewMediaCredentialProtection())
  })
})

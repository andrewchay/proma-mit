import { describe, expect, test } from 'bun:test'
import {
  isGithubCopilotCredentialExpired,
  parseGithubCopilotCredentials,
  serializeGithubCopilotCredentials,
} from './channel'

/**
 * GitHub Copilot OAuth 凭据序列化行为测试：
 * 业务字段往返一致、隔离 Pi runtime 临时字段（type 等）、
 * 缺字段拒绝解析（防止半截凭据进入请求链路）。
 */

const VALID = {
  access: 'ghp_access_token',
  refresh: 'gho_refresh_token',
  expires: Date.now() + 3600_000,
  availableModelIds: ['gpt-5.2', 'claude-sonnet-4-6', 'gpt-5.2'],
}

describe('GithubCopilotOAuthCredentials 序列化', () => {
  test('序列化→解析往返一致，且去重 availableModelIds', () => {
    const secret = serializeGithubCopilotCredentials(VALID)
    const parsed = parseGithubCopilotCredentials(secret)
    expect(parsed).not.toBeNull()
    expect(parsed!.access).toBe(VALID.access)
    expect(parsed!.refresh).toBe(VALID.refresh)
    expect(parsed!.expires).toBe(VALID.expires)
    expect(parsed!.availableModelIds).toEqual(['gpt-5.2', 'claude-sonnet-4-6'])
  })

  test('序列化剥离 Pi runtime 临时字段（type）', () => {
    const secret = JSON.stringify({ ...VALID, type: 'oauth' })
    // serializeGithubCopilotCredentials 只写业务字段；parse 侧对多余字段天然忽略
    const parsed = parseGithubCopilotCredentials(secret)
    expect(parsed).not.toBeNull()
    expect((parsed as unknown as { type?: string }).type).toBeUndefined()
  })

  test('缺字段 / 非法 JSON 拒绝解析返回 null', () => {
    expect(parseGithubCopilotCredentials('')).toBeNull()
    expect(parseGithubCopilotCredentials('not-json')).toBeNull()
    expect(parseGithubCopilotCredentials(JSON.stringify({ access: 'x' }))).toBeNull()
    expect(parseGithubCopilotCredentials(JSON.stringify({ ...VALID, refresh: '' }))).toBeNull()
    expect(parseGithubCopilotCredentials(JSON.stringify({ ...VALID, availableModelIds: 'gpt' }))).toBeNull()
  })

  test('enterpriseUrl 可选保留', () => {
    const withEnterprise = { ...VALID, enterpriseUrl: 'https://github.ghe.com' }
    const parsed = parseGithubCopilotCredentials(serializeGithubCopilotCredentials(withEnterprise))
    expect(parsed?.enterpriseUrl).toBe('https://github.ghe.com')
  })

  test('过期判定：临近过期（skew 60s）视为过期', () => {
    const expiring = { ...VALID, expires: Date.now() + 30_000 }
    expect(isGithubCopilotCredentialExpired(expiring)).toBe(true)
    expect(isGithubCopilotCredentialExpired(VALID)).toBe(false)
  })
})

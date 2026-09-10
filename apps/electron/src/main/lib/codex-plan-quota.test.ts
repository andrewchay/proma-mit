import { describe, expect, test } from 'bun:test'
import { parseCodexPlanQuotaResponse } from './codex-plan-quota'
import {
  isCodexCredentialExpired,
  parseCodexCredentials,
  serializeCodexCredentials,
} from '@gravitas/shared'

/**
 * ChatGPT (Codex) 订阅额度解析 + 凭据序列化行为测试（纯函数，不发网络请求）：
 * - primary/secondary 双窗口解析（5h/weekly 标签按实际时长映射）
 * - used_percent → remainingPercent 换算与 reset 时间
 * - 凭据 JSON 往返、缺字段拒绝、60s skew 过期判定
 */

describe('parseCodexPlanQuotaResponse', () => {
  test('标准 5h + weekly 双窗口', () => {
    const result = parseCodexPlanQuotaResponse({
      plan_type: 'plus',
      rate_limit: {
        primary_window: { used_percent: 40, limit_window_seconds: 5 * 60 * 60, reset_after_seconds: 3600 },
        secondary_window: { used_percent: 10, limit_window_seconds: 7 * 24 * 60 * 60, reset_at: 1790000000 },
      },
    })
    expect(result.supported).toBe(true)
    expect(result.planName).toBe('ChatGPT Plus (Codex)')
    expect(result.windows.length).toBe(2)
    expect(result.windows[0]?.label).toBe('每 5 小时')
    expect(result.windows[0]?.remainingPercent).toBe(60)
    expect(result.windows[1]?.label).toBe('每周额度')
    expect(result.windows[1]?.remainingPercent).toBe(90)
    // reset_at 秒级时间戳转毫秒
    expect(result.windows[1]?.resetAt).toBe(1_790_000_000_000)
  })

  test('非标准时长按实际值标 custom（不误标 5h/weekly）', () => {
    const result = parseCodexPlanQuotaResponse({
      rate_limit: {
        primary_window: { used_percent: 30, limit_window_seconds: 4.5 * 60 * 60 },
      },
    })
    expect(result.windows[0]?.label).toBe('每 4.5 小时')
    expect(result.windows[0]?.type).toBe('custom')
  })

  test('缺窗口/非法响应返回 unsupported', () => {
    expect(parseCodexPlanQuotaResponse({}).supported).toBe(false)
    expect(parseCodexPlanQuotaResponse({ rate_limit: null }).supported).toBe(false)
    expect(parseCodexPlanQuotaResponse({
      rate_limit: { primary_window: { used_percent: 'x', limit_window_seconds: 0 } },
    }).supported).toBe(false)
  })

  test('缺 plan_type 用默认名', () => {
    const result = parseCodexPlanQuotaResponse({
      rate_limit: { primary_window: { used_percent: 0, limit_window_seconds: 5 * 60 * 60 } },
    })
    expect(result.planName).toBe('ChatGPT 订阅 (Codex)')
  })
})

describe('CodexOAuthCredentials 序列化', () => {
  const VALID = {
    access: 'eyJ access',
    refresh: 'eyJ refresh',
    expires: Date.now() + 3600_000,
  }

  test('往返一致，accountId 可选保留', () => {
    const parsed = parseCodexCredentials(serializeCodexCredentials({ ...VALID, accountId: 'acct-123' }))
    expect(parsed).not.toBeNull()
    expect(parsed!.access).toBe(VALID.access)
    expect(parsed!.accountId).toBe('acct-123')
  })

  test('缺字段/非法 JSON 拒绝解析', () => {
    expect(parseCodexCredentials('')).toBeNull()
    expect(parseCodexCredentials('not-json')).toBeNull()
    expect(parseCodexCredentials(JSON.stringify({ access: 'x' }))).toBeNull()
    expect(parseCodexCredentials(JSON.stringify({ ...VALID, expires: 'soon' }))).toBeNull()
  })

  test('过期判定：60s skew 内视为过期', () => {
    expect(isCodexCredentialExpired({ ...VALID, expires: Date.now() + 30_000 })).toBe(true)
    expect(isCodexCredentialExpired(VALID)).toBe(false)
  })
})

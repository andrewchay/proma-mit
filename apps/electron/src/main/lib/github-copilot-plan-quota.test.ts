import { describe, expect, test } from 'bun:test'
import { parseGithubCopilotPlanQuotaResponse } from './github-copilot-plan-quota'

/**
 * GitHub Copilot 订阅额度解析行为测试（纯函数，不发网络请求）：
 * - premium/chat/completions 窗口解析与百分比计算
 * - 不限额 / 按量计费的非计量窗口
 * - 套餐名映射与非法响应拒绝
 */

describe('parseGithubCopilotPlanQuotaResponse', () => {
  test('标准 premium + chat/completions 窗口', () => {
    const result = parseGithubCopilotPlanQuotaResponse({
      copilot_plan: 'pro',
      quota_reset_date: '2026-10-01T00:00:00Z',
      quota_snapshots: {
        premium_interactions: { entitlement: 300, remaining: 150 },
        chat: { unlimited: true },
        completions: { entitlement: 2000, remaining: 1800 },
      },
    })
    expect(result.supported).toBe(true)
    expect(result.planName).toBe('GitHub Copilot Pro')
    expect(result.windows.length).toBe(3)
    const premium = result.windows.find((w) => w.label === 'Premium')
    expect(premium?.remainingPercent).toBe(50)
    expect(premium?.remainingLabel).toBe('150 / 300')
    const chat = result.windows.find((w) => w.label === 'Chat')
    expect(chat?.showProgress).toBe(false)
    expect(chat?.remainingLabel).toBe('不限额')
  })

  test('monthly_quotas 兜底（快照缺失时用月配额计算）', () => {
    const result = parseGithubCopilotPlanQuotaResponse({
      copilot_plan: 'free',
      monthly_quotas: { chat: 50 },
      limited_user_quotas: { chat: 42 },
    })
    expect(result.supported).toBe(true)
    const chat = result.windows.find((w) => w.label === 'Chat')
    expect(chat?.remainingPercent).toBe(84)
    expect(chat?.remainingLabel).toBe('42 / 50')
  })

  test('按量计费窗口置顶且不被不限额遮蔽', () => {
    const result = parseGithubCopilotPlanQuotaResponse({
      token_based_billing: true,
      quota_snapshots: { chat: { unlimited: true } },
    })
    expect(result.windows[0]?.label).toBe('计费方式')
    expect(result.windows[0]?.remainingLabel).toBe('按量计费')
  })

  test('全零占位（Business）不产生假额度窗口', () => {
    const result = parseGithubCopilotPlanQuotaResponse({
      copilot_plan: 'business',
      quota_snapshots: {
        premium_interactions: { entitlement: 0, remaining: 0, percent_remaining: 100 },
      },
    })
    // business 无可用窗口 → unsupported
    expect(result.supported).toBe(false)
  })

  test('非法/空响应返回 unsupported', () => {
    expect(parseGithubCopilotPlanQuotaResponse(null).supported).toBe(false)
    expect(parseGithubCopilotPlanQuotaResponse('x').supported).toBe(false)
    expect(parseGithubCopilotPlanQuotaResponse({}).supported).toBe(false)
  })

  test('套餐名映射不含未知回显字段', () => {
    const result = parseGithubCopilotPlanQuotaResponse({
      copilot_plan: { malicious: 'x' },
      quota_snapshots: { chat: { unlimited: true } },
    })
    expect(result.planName).toBe('GitHub Copilot')
  })
})

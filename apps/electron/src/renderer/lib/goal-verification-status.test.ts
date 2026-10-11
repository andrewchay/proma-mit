/**
 * V05：Goal 验证状态解析（纯函数）。
 *
 * run finished ≠ verified ≠ accepted；legacy 无回执显示"未验证"；
 * 回执绑定身份与 Goal 不符时明确警告（不串项）。
 */

import { describe, expect, test } from 'bun:test'
import type { AgentGoal, PinnedVerifierReceipt } from '@gravitas/shared'
import { resolveGoalVerificationStatus } from './goal-verification-status'

function goal(overrides: Partial<AgentGoal> = {}): AgentGoal {
  return {
    id: 'goal-1', sessionId: 's', runtime: 'ai-sdk', objective: '目标',
    status: 'active', acceptanceCriteria: [], createdAt: 0, updatedAt: 0, version: 1,
    ...overrides,
  }
}

function receipt(overrides: Partial<PinnedVerifierReceipt> = {}): PinnedVerifierReceipt {
  return {
    version: 1, verifierId: 'bun-baseline', commitSha: 'a'.repeat(40), argvSha256: 'b'.repeat(64),
    cleanCheckout: true, isolation: 'seatbelt-macos', exitCode: 0, timedOut: false,
    tests: 3, failures: 0, errors: 0, skipped: 0, verdict: 'passed', reasons: [],
    cleanedUp: true, startedAt: new Date(0).toISOString(), finishedAt: new Date(0).toISOString(),
    ...overrides,
  }
}

describe('V05：Goal 验证状态', () => {
  test('completed + 回执 = 已验证已完成；含证据定位（verifier/commit）', () => {
    const state = resolveGoalVerificationStatus(goal({
      status: 'completed',
      completionVerification: { ...receipt(), boundGoalId: 'goal-1', boundRunId: 'run-1', reportSha256: 'c'.repeat(64) },
    }))
    expect(state.state).toBe('accepted')
    expect(state.verified).toBe(true)
    expect(state.label).toContain('已验证')
    expect(state.detail).toContain('bun-baseline')
    expect(state.detail).toContain('aaaaaaa')
  })

  test('completed 但无门禁无回执 = legacy 未验证（不冒充已验证）', () => {
    const state = resolveGoalVerificationStatus(goal({ status: 'completed' }))
    expect(state.state).toBe('unverified')
    expect(state.verified).toBe(false)
    expect(state.label).toContain('未验证')
  })

  test('回执 passed 但 Goal 未完成 = 验证通过待接受', () => {
    const state = resolveGoalVerificationStatus(goal({
      completionVerification: { ...receipt(), boundGoalId: 'goal-1', boundRunId: 'run-1' },
    }))
    expect(state.state).toBe('verified')
    expect(state.verified).toBe(true)
  })

  test('仅有 run 检查点（checkpointRunId）= run 完成但未验证', () => {
    const state = resolveGoalVerificationStatus(goal({ checkpointRunId: 'run-9' }))
    expect(state.state).toBe('finished_unverified')
    expect(state.verified).toBe(false)
  })

  test('回执绑定身份不符 = mismatch 警告（跨 Goal 移植可检测，不串项展示）', () => {
    const state = resolveGoalVerificationStatus(goal({
      completionVerification: { ...receipt(), boundGoalId: 'other-goal', boundRunId: 'run-1' },
    }))
    expect(state.state).toBe('mismatch')
    expect(state.verified).toBe(false)
  })

  test('回执 verdict 非 passed 不算已验证', () => {
    const state = resolveGoalVerificationStatus(goal({
      completionVerification: { ...receipt(), verdict: 'failed', boundGoalId: 'goal-1', boundRunId: 'run-1' },
    }))
    expect(state.verified).toBe(false)
  })
})

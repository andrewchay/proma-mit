/**
 * V05：Goal 验证状态解析（纯函数）。
 *
 * 区分 run finished（checkpointRunId）/ verified（回执 passed 且身份绑定）/
 * accepted（Goal completed）/ legacy 未验证 / 回执身份不符（不串项）。
 */

import type { AgentGoal, PinnedVerifierReceipt } from '@gravitas/shared'

export type GoalVerificationState = 'accepted' | 'verified' | 'finished_unverified' | 'unverified' | 'mismatch'

export interface GoalVerificationPresentation {
  readonly state: GoalVerificationState
  /** 是否经过可信验证（回执 passed 且绑定本 Goal）。 */
  readonly verified: boolean
  readonly label: string
  readonly detail?: string
}

function receiptOf(goal: AgentGoal): PinnedVerifierReceipt | undefined {
  const receipt = goal.completionVerification
  if (!receipt || receipt.verdict !== 'passed') return undefined
  return receipt
}

export function resolveGoalVerificationStatus(goal: AgentGoal): GoalVerificationPresentation {
  const receipt = receiptOf(goal)
  // 身份绑定优先：移植的回执不可作为本 Goal 的验证证据。
  if (receipt?.boundGoalId && receipt.boundGoalId !== goal.id) {
    return { state: 'mismatch', verified: false, label: '回执身份不符', detail: `回执绑定 ${receipt.boundGoalId}，非本 Goal` }
  }
  const evidence = receipt
    ? `${receipt.verifierId} · 提交 ${receipt.commitSha.slice(0, 7)} · ${receipt.tests} 测试${receipt.reportSha256 ? ' · 报告哈希已绑定' : ''}`
    : undefined
  if (goal.status === 'completed') {
    return receipt
      ? { state: 'accepted', verified: true, label: '已完成 · 已验证', detail: evidence }
      : { state: 'unverified', verified: false, label: '已完成 · 未验证（legacy）', detail: '无完成门禁回执，不视为已验证' }
  }
  if (receipt) {
    return { state: 'verified', verified: true, label: '验证通过 · 待完成', detail: evidence }
  }
  if (goal.checkpointRunId) {
    return { state: 'finished_unverified', verified: false, label: 'run 已提交检查点 · 未验证', detail: '检查点接收 ≠ 证据验证通过' }
  }
  return { state: 'unverified', verified: false, label: '未验证' }
}

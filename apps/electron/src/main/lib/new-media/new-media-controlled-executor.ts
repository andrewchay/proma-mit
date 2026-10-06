/**
 * 受控外发执行器契约。
 *
 * 设计原则：
 * - 执行器只能由 controlled-actions 的审批门控调用；这里不提供任何「直接执行」入口。
 * - 默认不注册任何执行器：真实发布需要 P2-05 的 freepublish 状态机，
 *   在它落地之前调用执行必须明确失败，而不是退回模拟成功。
 * - 失败必须区分三种结果，因为真实发布最危险的错误是「结果未知」：
 *   - not_started：请求还没发出去，可以安全重试；
 *   - unknown：请求已发出但没拿到确认，可能已经发布成功，重试会导致重复发布；
 *   - confirmed_failure：平台明确拒绝，可以修正后重试。
 */
import type { NewMediaPlatform } from '@gravitas/shared'
import type { ControlledActionKind } from './controlled-actions'

export type ControlledExecutionOutcome = 'not_started' | 'unknown' | 'confirmed_failure'

export interface ControlledExecutionReceipt {
  platform: NewMediaPlatform
  /** 平台侧回执标识，例如微信 publish_id 或 msg_id。 */
  externalId?: string
  /** 平台侧状态原文，例如 publishing / published；本地不得改写为成功。 */
  platformStatus?: string
  summary: string
  receivedAt: number
  /** 原始回执中的非敏感字段，便于审计与排查。 */
  details?: Record<string, string | number | boolean>
}

export interface ControlledExecutionInput {
  actionId: string
  kind: ControlledActionKind
  platform: NewMediaPlatform
  targetId: string
  /** 目标账号；执行器据此解析本地凭据。 */
  accountId?: string
  summary: string
  /** 本次执行尝试标识，用于在平台侧对账与幂等关联。 */
  attemptId: string
  actor: string
}

export interface ControlledActionExecutor {
  readonly kind: ControlledActionKind
  readonly platform: NewMediaPlatform
  /** 面向用户的说明，用于在 UI 中解释该执行器会做什么、不会做什么。 */
  describe(): string
  /**
   * 执行一次外发。实现必须：
   * - 使用本地账户凭据，不接收来自 UI 的任何密钥；
   * - 失败时抛出 ControlledExecutionError 并明确 outcome。
   */
  execute(input: ControlledExecutionInput): Promise<ControlledExecutionReceipt>
}

export class ControlledExecutionError extends Error {
  constructor(
    readonly outcome: ControlledExecutionOutcome,
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'ControlledExecutionError'
  }
}

/** 未注册执行器时抛出，用于把「能力尚未落地」与「执行失败」区分开。 */
export class ControlledExecutorUnavailableError extends Error {
  constructor(readonly kind: ControlledActionKind, readonly platform: NewMediaPlatform) {
    super(`尚未可用的执行器：${kind} / ${platform}。真实外发需要对应平台适配器与授权，当前不会执行任何操作。`)
    this.name = 'ControlledExecutorUnavailableError'
  }
}

const executors = new Map<string, ControlledActionExecutor>()

function keyOf(kind: ControlledActionKind, platform: NewMediaPlatform): string {
  return `${kind}:${platform}`
}

export function registerControlledActionExecutor(executor: ControlledActionExecutor): void {
  const key = keyOf(executor.kind, executor.platform)
  if (executors.has(key)) throw new Error(`执行器重复注册：${key}`)
  executors.set(key, executor)
}

export function getControlledActionExecutor(kind: ControlledActionKind, platform: NewMediaPlatform): ControlledActionExecutor | undefined {
  return executors.get(keyOf(kind, platform))
}

export function requireControlledActionExecutor(kind: ControlledActionKind, platform: NewMediaPlatform): ControlledActionExecutor {
  const executor = getControlledActionExecutor(kind, platform)
  if (!executor) throw new ControlledExecutorUnavailableError(kind, platform)
  return executor
}

export function listControlledActionExecutors(): Array<{ kind: ControlledActionKind; platform: NewMediaPlatform; description: string }> {
  return [...executors.values()]
    .map((executor) => ({ kind: executor.kind, platform: executor.platform, description: executor.describe() }))
    .sort((left, right) => keyOf(left.kind, left.platform).localeCompare(keyOf(right.kind, right.platform)))
}

/** 仅供测试使用：清空注册表。 */
export function clearControlledActionExecutorsForTests(): void {
  executors.clear()
}

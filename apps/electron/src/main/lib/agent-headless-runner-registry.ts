/**
 * Agent headless runner 注册表
 *
 * 用于主进程内置工具在不直接 import agent-service.ts 的情况下启动/停止真实 Agent 会话，
 * 避免 AgentOrchestrator 与 agent-service 形成难以维护的循环依赖。
 */

import type {
  AgentExternalRunSource,
  AgentMessage,
  AgentSendInput,
} from '@gravitas/shared'

export interface HeadlessAgentRunCallbacks {
  onError: (error: string) => void
  onComplete: (messages?: AgentMessage[], result?: { stoppedByUser?: boolean }) => void
  onTitleUpdated: (title: string) => void
  source?: AgentExternalRunSource
  /** 发起此次 headless 运行的可见会话，用于将事件路由回其 renderer。 */
  originSessionId?: string
}

export type HeadlessAgentRunner = (
  input: AgentSendInput,
  callbacks: HeadlessAgentRunCallbacks,
) => Promise<void>

export type AgentStopReason = 'stop-request-accepted' | 'not-active' | 'generation-mismatch' | 'stop-failed'

export interface AgentStopResult {
  sessionId: string
  expectedGeneration?: number
  activeGeneration?: number
  /** Runtime 接受了针对目标 generation 的取消请求。 */
  requestAccepted: boolean
  /** 仅在 Runtime 同步确认执行已终止时为 true；当前内置 Runtime 均不会同步确认。 */
  stopped: boolean
  reason: AgentStopReason
  processTermination: 'VERIFIED' | 'NOT_VERIFIED'
  error?: string
}

export type AgentStopper = (sessionId: string, expectedGeneration?: number) => AgentStopResult

let headlessRunner: HeadlessAgentRunner | null = null
let agentStopper: AgentStopper | null = null

export function setHeadlessAgentRunner(runner: HeadlessAgentRunner): void {
  headlessRunner = runner
}

export function setAgentStopper(stopper: AgentStopper): void {
  agentStopper = stopper
}

export async function runRegisteredHeadlessAgent(
  input: AgentSendInput,
  callbacks: HeadlessAgentRunCallbacks,
): Promise<void> {
  if (!headlessRunner) {
    throw new Error('Agent headless runner 尚未初始化')
  }
  await headlessRunner(input, callbacks)
}

export function stopRegisteredAgent(sessionId: string, expectedGeneration?: number): AgentStopResult {
  if (!agentStopper) {
    throw new Error('Agent stopper 尚未初始化')
  }
  return agentStopper(sessionId, expectedGeneration)
}

/**
 * AI SDK Runtime 会话身份绑定（兼容层）。
 *
 * 实现已统一到 runtime-session-identity.ts；本文件只保留原有导出名与签名，
 * 内部以 runtime = 'ai-sdk' 委托共享实现，避免两套并行实现出现语义分叉。
 */

import {
  bindRuntimeSessionIdentity,
  matchesRuntimeSessionIdentity,
  revokeRuntimeSessionIdentity,
} from './runtime-session-identity'

/** 活动会话只能绑定一次；重复绑定同一身份是幂等的。 */
export function bindAISDKSessionIdentity(session: object, sessionId: string, cwd: string): void {
  bindRuntimeSessionIdentity(session, { sessionId, cwd, runtime: 'ai-sdk' })
}

/** 会话结束后保留撤销标记，防止旧对象重新绑定。 */
export function revokeAISDKSessionIdentity(session: object): void {
  revokeRuntimeSessionIdentity(session)
}

/** 未绑定或会话身份不一致时拒绝执行。 */
export function matchesAISDKSessionIdentity(session: object, sessionId: string, cwd: string): boolean {
  return matchesRuntimeSessionIdentity(session, { sessionId, cwd, runtime: 'ai-sdk' })
}

/**
 * Runtime 会话身份绑定（跨 Runtime 共享实现）。
 *
 * 用途：把「运行时对象（活动会话状态对象）」与「会话身份（sessionId + cwd + runtime）」做
 * 进程内一次性绑定。工具执行入口在真正执行工具前校验该绑定，身份缺失、不匹配或已撤销时
 * 默认拒绝（fail-closed），避免会话被并发复用或身份被异步改写后串到别的会话。
 *
 * 边界：只信任绑定时写入的身份，**不信任调用方在执行时携带的 sessionId / cwd / runtime**。
 * 调用方传进来的身份只用于比对，永远不能改写已绑定身份；绑定后不可换身份，会话结束后
 * 保留撤销标记，防止旧对象重新绑定。
 *
 * 语义与 AI SDK Runtime 原有实现保持一致（单次绑定、重复绑定同一身份幂等、cwd 用 resolve
 * 归一），并额外校验 runtime，避免 Pi / Proma / AI SDK 的身份互相冒用。
 */

import { resolve } from 'node:path'

export type AgentRuntimeKind = 'ai-sdk' | 'pi' | 'proma' | 'claude-sdk'

export interface RuntimeSessionIdentity {
  sessionId: string
  cwd: string
  runtime: AgentRuntimeKind
}

interface StoredSessionIdentity {
  sessionId: string
  cwd: string
  runtime: AgentRuntimeKind
  revoked: boolean
}

const RUNTIME_LABELS: Record<AgentRuntimeKind, string> = {
  'ai-sdk': 'AI SDK',
  pi: 'Pi',
  proma: 'Proma',
  'claude-sdk': 'Claude SDK',
}

const identities = new WeakMap<object, StoredSessionIdentity>()

function runtimeLabel(runtime: AgentRuntimeKind): string {
  return RUNTIME_LABELS[runtime] ?? String(runtime)
}

function normalize(cwd: string): string {
  return resolve(cwd)
}

/**
 * 绑定会话身份。活动会话只能绑定一次；重复绑定同一身份（含 runtime）是幂等的。
 * 已撤销的对象不允许重新绑定。
 */
export function bindRuntimeSessionIdentity(owner: object, identity: RuntimeSessionIdentity): void {
  if (!identity.sessionId.trim() || !identity.cwd.trim()) throw new Error(`${runtimeLabel(identity.runtime)} 会话身份不完整`)
  const next: StoredSessionIdentity = {
    sessionId: identity.sessionId,
    cwd: normalize(identity.cwd),
    runtime: identity.runtime,
    revoked: false,
  }
  const previous = identities.get(owner)
  // 错误消息描述的是「已绑定的那个会话」，因此优先用绑定时的 runtime 名称。
  const boundLabel = runtimeLabel(previous?.runtime ?? identity.runtime)
  if (previous?.revoked) throw new Error(`${boundLabel} 会话身份已撤销`)
  if (previous && (
    previous.sessionId !== next.sessionId
    || previous.cwd !== next.cwd
    || previous.runtime !== next.runtime
  )) {
    throw new Error(`${boundLabel} 活动会话不能重新绑定其他身份`)
  }
  if (!previous) identities.set(owner, next)
}

export interface RuntimeSessionIdentitySnapshot {
  sessionId: string
  cwd: string
  runtime: AgentRuntimeKind
  revoked: boolean
}

/** 只读快照；未绑定返回 undefined。不得据此修改绑定。 */
export function getRuntimeSessionIdentity(owner: object): RuntimeSessionIdentitySnapshot | undefined {
  const bound = identities.get(owner)
  if (!bound) return undefined
  return { sessionId: bound.sessionId, cwd: bound.cwd, runtime: bound.runtime, revoked: bound.revoked }
}

/** 会话结束后保留撤销标记，防止旧对象重新绑定其他身份。 */
export function revokeRuntimeSessionIdentity(owner: object): void {
  const identity = identities.get(owner)
  if (identity) identity.revoked = true
}

/** 未绑定、已撤销或会话身份（含 runtime）不一致时返回 false。 */
export function matchesRuntimeSessionIdentity(owner: object, identity: RuntimeSessionIdentity): boolean {
  const bound = identities.get(owner)
  return Boolean(
    bound
    && !bound.revoked
    && bound.sessionId === identity.sessionId
    && bound.cwd === normalize(identity.cwd)
    && bound.runtime === identity.runtime,
  )
}

/**
 * 身份缺失/不匹配/已撤销时抛出 Error；用于工具执行入口 fail-closed。
 *
 * 只做比对，不会因为传入身份而修改绑定关系。
 */
export function assertRuntimeSessionIdentity(owner: object, identity: RuntimeSessionIdentity): void {
  if (!matchesRuntimeSessionIdentity(owner, identity)) {
    throw new Error(`${runtimeLabel(identity.runtime)} 会话身份不匹配，拒绝执行工具`)
  }
}

/**
 * 权限与门禁层用：从绑定对象取回授权依据的 sessionId，调用链携带的身份只参与比对。
 *
 * 与工具实现内的绑定校验分开，是为了让权限回调（可能长时间等待人工审批）在调用前
 * 就把「会话身份被改写」挡掉，而不是等工具实现再拒绝。绑定对象缺失一律失败关闭。
 */
export function requireBoundSessionId(
  owner: object | undefined,
  identity: { sessionId: string; cwd?: string; runtime?: AgentRuntimeKind },
): string {
  const bound = owner ? getRuntimeSessionIdentity(owner) : undefined
  if (!bound) throw new Error('工具执行缺少已绑定的会话身份，拒绝执行工具')
  if (bound.revoked) throw new Error('会话身份绑定已失效，拒绝执行工具')
  if (bound.sessionId !== identity.sessionId) throw new Error('工具执行会话身份与会话不一致，拒绝执行')
  if (identity.cwd !== undefined && bound.cwd !== normalize(identity.cwd)) throw new Error('工具执行工作目录与会话身份不一致，拒绝执行')
  if (identity.runtime !== undefined && bound.runtime !== identity.runtime) throw new Error('工具执行 Runtime 与会话绑定不一致，拒绝执行')
  return bound.sessionId
}

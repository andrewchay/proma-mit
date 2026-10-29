import { resolve } from 'node:path'

interface SessionIdentity {
  sessionId: string
  cwd: string
  revoked: boolean
}

const identities = new WeakMap<object, SessionIdentity>()

/** 活动会话只能绑定一次；重复绑定同一身份是幂等的。 */
export function bindAISDKSessionIdentity(session: object, sessionId: string, cwd: string): void {
  if (!sessionId.trim() || !cwd.trim()) throw new Error('AI SDK 会话身份不完整')
  const identity = { sessionId, cwd: resolve(cwd), revoked: false }
  const previous = identities.get(session)
  if (previous?.revoked) throw new Error('AI SDK 会话身份已撤销')
  if (previous && (previous.sessionId !== identity.sessionId || previous.cwd !== identity.cwd)) {
    throw new Error('AI SDK 活动会话不能重新绑定其他身份')
  }
  if (!previous) identities.set(session, identity)
}

/** 会话结束后保留撤销标记，防止旧对象重新绑定。 */
export function revokeAISDKSessionIdentity(session: object): void {
  const identity = identities.get(session)
  if (identity) identity.revoked = true
}

/** 未绑定或会话身份不一致时拒绝执行。 */
export function matchesAISDKSessionIdentity(session: object, sessionId: string, cwd: string): boolean {
  const identity = identities.get(session)
  return Boolean(identity && !identity.revoked && identity.sessionId === sessionId && identity.cwd === resolve(cwd))
}

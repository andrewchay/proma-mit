/** 凭据配置、连接、断开与草稿同步共享账号锁，避免并发覆盖或撤权后继续发送。 */
const tails = new Map<string, Promise<void>>()
export async function withWechatAccountLock<T>(accountId: string, operation: () => Promise<T>): Promise<T> {
  const previous = tails.get(accountId) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>(resolve => { release = resolve })
  tails.set(accountId, current)
  await previous
  try { return await operation() }
  finally { release(); if (tails.get(accountId) === current) tails.delete(accountId) }
}

const revocations = new Map<string, number>()
const revocationVersions = new Map<string, number>()
export function getWechatAccountRevocationVersion(accountId: string): number {
  return revocationVersions.get(accountId) ?? 0
}
export function isWechatAccountRevoking(accountId: string): boolean {
  return (revocations.get(accountId) ?? 0) > 0
}

/** 断开意图在排队前生效；在途同步须在下一个网络步骤前停止。 */
export async function withWechatAccountRevocation<T>(accountId: string, operation: () => Promise<T>): Promise<T> {
  revocationVersions.set(accountId, getWechatAccountRevocationVersion(accountId) + 1)
  revocations.set(accountId, (revocations.get(accountId) ?? 0) + 1)
  try { return await withWechatAccountLock(accountId, operation) }
  finally {
    const remaining = (revocations.get(accountId) ?? 1) - 1
    if (remaining > 0) revocations.set(accountId, remaining)
    else revocations.delete(accountId)
  }
}

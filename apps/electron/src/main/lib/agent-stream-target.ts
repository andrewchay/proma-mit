/** 只接受明确的主窗口目标，禁止从辅助窗口列表猜测消息接收方。 */
export function resolveAgentStreamTarget<T extends { isDestroyed(): boolean }>(
  origin: T | null | undefined,
  main: T | null | undefined,
): T | null {
  if (origin && !origin.isDestroyed()) return origin
  return main && !main.isDestroyed() ? main : null
}

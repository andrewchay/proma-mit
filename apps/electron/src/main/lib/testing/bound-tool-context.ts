import { bindRuntimeSessionIdentity, getRuntimeSessionIdentity } from '../agent-runtime/runtime-session-identity'

export type TestRuntimeKind = 'ai-sdk' | 'pi' | 'proma'

/**
 * 测试用：把工具上下文绑定为当前会话身份，并按 Runtime 的方式自引用写入 boundSession。
 *
 * 生产路径由三个 Runtime 各自绑定（ai-sdk-runtime-core / pi-agent-adapter /
 * provider-agnostic-agent-adapter）；测试必须显式调用本函数，避免把「缺绑定被拒绝」
 * 这条规则悄悄掩盖掉。就地修改并返回同一个对象，通常一行包裹调用参数即可。
 */
export function bindTestToolContext<T extends { sessionId: string; cwd: string; boundSession?: object; runtime?: TestRuntimeKind }>(
  ctx: T,
  runtime: TestRuntimeKind = 'ai-sdk',
): T {
  const alreadyBound = ctx.boundSession ? getRuntimeSessionIdentity(ctx.boundSession) : undefined
  if (alreadyBound) return ctx
  bindRuntimeSessionIdentity(ctx, { sessionId: ctx.sessionId, cwd: ctx.cwd, runtime })
  ctx.boundSession = ctx
  ctx.runtime = runtime
  return ctx
}

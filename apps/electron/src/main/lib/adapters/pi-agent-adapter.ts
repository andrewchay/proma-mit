/**
 * Pi Agent runtime 占位适配器。
 *
 * 阶段 2 只建立 runtime 路由 contract，Pi SDK 的模型注册、消息转换和工具桥接
 * 会在后续阶段单独实现。这里显式报错，避免调用方误以为 Pi runtime 已可用。
 */

import type { AgentProviderAdapter, AgentQueryInput, SDKMessage } from '@proma/shared'

export class PiAgentAdapter implements AgentProviderAdapter {
  async *query(_input: AgentQueryInput): AsyncIterable<SDKMessage> {
    throw new Error('Pi Agent runtime 尚未接入，请先完成 Pi adapter 实现')
  }

  abort(_sessionId: string): void {
    // Pi runtime 尚未创建长生命周期资源，当前无需处理。
  }

  dispose(): void {
    // Pi runtime 尚未创建长生命周期资源，当前无需处理。
  }
}

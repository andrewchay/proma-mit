/**
 * 尚未启用 runtime 的占位适配器。
 *
 * 用于把 runtime 类型、设置和路由先纳入统一 contract，同时避免误落到其他 runtime。
 */

import type { AgentProviderAdapter, AgentQueryInput, SDKMessage } from '@proma/shared'

export class UnavailableAgentAdapter implements AgentProviderAdapter {
  constructor(private readonly runtimeName: string) {}

  async *query(_input: AgentQueryInput): AsyncIterable<SDKMessage> {
    throw new Error(`${this.runtimeName} Runtime 尚未启用`)
  }

  abort(_sessionId: string): void {
    // runtime 尚未启动，无需处理。
  }

  dispose(): void {
    // runtime 尚未启动，无需处理。
  }
}

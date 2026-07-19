/**
 * Agent runtime 路由适配器。
 *
 * Orchestrator 只依赖 AgentProviderAdapter；这里按每个会话记录的 runtime
 * 把 query / abort / 队列消息 / 权限切换转发到具体 runtime adapter。
 */

import type {
  AgentProviderAdapter,
  AgentQueryInput,
  AgentRuntime,
  SendQueuedMessageOptions,
  SDKMessage,
  SDKUserMessageInput,
} from '@proma/shared'
import { DEFAULT_AGENT_RUNTIME, normalizeAgentRuntime } from '@proma/shared'

export class RuntimeRoutingAgentAdapter implements AgentProviderAdapter {
  private readonly sessionRuntimes = new Map<string, AgentRuntime>()

  constructor(private readonly adapters: Record<AgentRuntime, AgentProviderAdapter>) {}

  query(input: AgentQueryInput): AsyncIterable<SDKMessage> {
    const runtime = normalizeAgentRuntime(input.agentRuntime)
    this.sessionRuntimes.set(input.sessionId, runtime)
    return this.adapters[runtime].query(input)
  }

  abort(sessionId: string): void {
    const runtime = this.sessionRuntimes.get(sessionId)
    if (runtime) {
      this.adapters[runtime].abort(sessionId)
      return
    }

    for (const adapter of Object.values(this.adapters)) {
      adapter.abort(sessionId)
    }
  }

  async interruptQuery(sessionId: string): Promise<void> {
    const adapter = this.getAdapter(sessionId)
    await adapter.interruptQuery?.(sessionId)
  }

  dispose(): void {
    for (const adapter of Object.values(this.adapters)) {
      adapter.dispose()
    }
    this.sessionRuntimes.clear()
  }

  async sendQueuedMessage(
    sessionId: string,
    message: SDKUserMessageInput,
    options?: SendQueuedMessageOptions,
  ): Promise<void> {
    const adapter = this.getAdapter(sessionId)
    if (!adapter.sendQueuedMessage) {
      throw new Error('当前 Agent runtime 不支持追加消息')
    }
    await adapter.sendQueuedMessage(sessionId, message, options)
  }

  async cancelQueuedMessage(sessionId: string, messageUuid: string): Promise<void> {
    const adapter = this.getAdapter(sessionId)
    await adapter.cancelQueuedMessage?.(sessionId, messageUuid)
  }

  async setPermissionMode(sessionId: string, mode: string): Promise<void> {
    const adapter = this.getAdapter(sessionId)
    await adapter.setPermissionMode?.(sessionId, mode)
  }

  private getAdapter(sessionId: string): AgentProviderAdapter {
    const runtime = this.sessionRuntimes.get(sessionId) ?? DEFAULT_AGENT_RUNTIME
    return this.adapters[runtime]
  }
}

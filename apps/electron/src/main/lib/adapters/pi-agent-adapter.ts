/**
 * Pi Agent SDK 适配器。
 *
 * v1 目标是接通一条真实 Pi runtime 闭环：Proma 渠道临时注册为 Pi provider/model，
 * Pi 负责 agent loop，Proma 仍负责会话持久化与 UI 事件。写入类工具和 MCP 桥接
 * 暂不开放，避免绕过 Proma 自己的权限系统。
 */

import type { AgentProviderAdapter, AgentQueryInput, SDKMessage } from '@proma/shared'
import type { AgentMessage as PiAgentMessage } from '@earendil-works/pi-agent-core'
import type { AgentSession, AgentSessionEvent } from '@earendil-works/pi-coding-agent'
import { enrichMessageWithDocuments } from '../agent-runtime/attachment-enrichment'
import { convertPiMessagesToSDKMessages, convertSDKMessagesToPiMessages } from './pi-message-adapter'
import { registerPiModelFromChannel } from './pi-model-registry'
import { loadPiCodingAgent } from './pi-sdk-loader'

export interface PiAgentQueryOptions extends AgentQueryInput {
  /** 系统提示词 */
  systemPrompt?: string
  /** 历史 SDKMessage，用于恢复 Pi in-memory session 上下文 */
  historyMessages?: SDKMessage[]
}

interface ActivePiSession {
  session: AgentSession
  unsubscribe: () => void
}

const PI_READ_ONLY_TOOLS = ['read', 'grep', 'find', 'ls']

export class PiAgentAdapter implements AgentProviderAdapter {
  private readonly activeSessions = new Map<string, ActivePiSession>()

  async *query(input: PiAgentQueryOptions): AsyncIterable<SDKMessage> {
    const { sessionId, prompt, provider, apiKey, baseUrl, model, cwd, systemPrompt, historyMessages, attachments } = input
    if (!provider || !apiKey || !baseUrl || !model || !cwd) {
      throw new Error('Pi Runtime 需要 provider、apiKey、baseUrl、model、cwd')
    }

    const registration = await registerPiModelFromChannel({
      sessionId,
      provider,
      apiKey,
      baseUrl,
      modelId: model,
    })

    const { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } = await loadPiCodingAgent()
    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: true, maxRetries: 2 },
      images: { blockImages: true },
    })
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir: registration.agentDir,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPrompt,
    })
    await resourceLoader.reload()

    const { session } = await createAgentSession({
      cwd,
      agentDir: registration.agentDir,
      modelRuntime: registration.modelRuntime,
      model: registration.model,
      thinkingLevel: 'off',
      tools: PI_READ_ONLY_TOOLS,
      resourceLoader,
      sessionManager: SessionManager.inMemory(cwd),
      settingsManager,
    })

    if (historyMessages && historyMessages.length > 0) {
      session.state.messages = convertSDKMessagesToPiMessages(historyMessages)
    }

    let finalMessages: PiAgentMessage[] = []
    const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
      if (event.type === 'agent_end') {
        finalMessages = event.messages
      }
    })
    this.activeSessions.set(sessionId, { session, unsubscribe })

    try {
      const enrichedPrompt = await enrichMessageWithDocuments(prompt, attachments)
      await session.prompt(enrichedPrompt, { expandPromptTemplates: false })
      const outputMessages = convertPiMessagesToSDKMessages(finalMessages, sessionId, model)
      for (const message of outputMessages) {
        yield message
      }
    } finally {
      this.releaseSession(sessionId)
    }
  }

  abort(sessionId: string): void {
    const active = this.activeSessions.get(sessionId)
    if (!active) return
    void active.session.abort().catch((error: unknown) => {
      console.error('[Pi Runtime] 中止会话失败:', error)
    })
    this.releaseSession(sessionId)
  }

  dispose(): void {
    for (const sessionId of this.activeSessions.keys()) {
      this.releaseSession(sessionId)
    }
  }

  private releaseSession(sessionId: string): void {
    const active = this.activeSessions.get(sessionId)
    if (!active) return
    this.activeSessions.delete(sessionId)
    active.unsubscribe()
    active.session.dispose()
  }
}

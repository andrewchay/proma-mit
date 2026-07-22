/**
 * Agent runtime 服务边界。
 *
 * Electron 默认实现继续复用本地 JSON/JSONL/文件系统；服务端 Web 可以替换这些接口，
 * 实现多用户配置、数据库会话存储、对象存储和 SSE/WebSocket 事件下发。
 */

import { existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import type {
  AgentStreamPayload,
  AgentWorkspace,
  Channel,
  McpServerEntry,
  ProviderType,
  SDKMessage,
} from '@proma/shared'
import { appendSDKMessages, getAgentSessionSDKMessages, truncateSDKMessages } from '../agent-session-manager'
import { getAgentWorkspace, getAgentWorkspaceCwd, getWorkspaceMcpConfig } from '../agent-workspace-manager'
import { getAgentSessionWorkspacePath } from '../config-paths'
import type { AgentEventBus } from '../agent-event-bus'
import { ElectronRuntimeMcpService, type RuntimeMcpService } from './runtime-mcp-service'
export type {
  RuntimeMcpAcquireFn,
  RuntimeMcpAcquireInput,
  RuntimeMcpLease,
  RuntimeMcpService,
} from './runtime-mcp-service'

export interface ResolvedRuntimeChannel {
  channelId: string
  provider: ProviderType
  apiKey: string
  baseUrl: string
  defaultModel?: string
}

export interface RuntimeWorkspaceContext {
  cwd: string
  workspace?: AgentWorkspace
  workspaceSlug?: string
  mcpServers?: Record<string, McpServerEntry>
}

export interface RuntimeCredentialStore {
  resolveChannel(channelId: string): Promise<ResolvedRuntimeChannel | undefined>
}

export interface RuntimeWorkspaceStore {
  resolveWorkspaceContext(input: {
    workspaceId?: string
    sessionId: string
  }): RuntimeWorkspaceContext
}

export interface RuntimeSessionStore {
  getHistoryMessages(sessionId: string): SDKMessage[]
  appendMessages(sessionId: string, messages: SDKMessage[]): void
  truncateMessages(sessionId: string, upToUuidInclusive: string): SDKMessage[]
}

export interface RuntimeEventSink {
  emit(sessionId: string, payload: AgentStreamPayload): void
}

export interface RuntimeServices {
  credentials: RuntimeCredentialStore
  workspaces: RuntimeWorkspaceStore
  sessions: RuntimeSessionStore
  events: RuntimeEventSink
  mcp: RuntimeMcpService
}

export class ElectronRuntimeCredentialStore implements RuntimeCredentialStore {
  async resolveChannel(channelId: string): Promise<ResolvedRuntimeChannel | undefined> {
    const { getChannelById, decryptApiKey } = await import('../channel-manager')
    const channel = getChannelById(channelId)
    if (!channel) return undefined
    return {
      channelId,
      provider: channel.provider,
      apiKey: decryptApiKey(channelId),
      baseUrl: channel.baseUrl,
      defaultModel: getDefaultModel(channel),
    }
  }
}

export class ElectronRuntimeWorkspaceStore implements RuntimeWorkspaceStore {
  resolveWorkspaceContext(input: {
    workspaceId?: string
    sessionId: string
  }): RuntimeWorkspaceContext {
    let cwd = homedir()
    let workspace: AgentWorkspace | undefined
    let workspaceSlug: string | undefined
    let mcpServers: Record<string, McpServerEntry> | undefined

    if (!input.workspaceId) {
      return { cwd }
    }

    workspace = getAgentWorkspace(input.workspaceId)
    if (!workspace) {
      return { cwd }
    }

    workspaceSlug = workspace.slug
    cwd = getAgentWorkspaceCwd(workspace, input.sessionId)
    if (!existsSync(cwd)) {
      mkdirSync(cwd, { recursive: true })
    }

    try {
      mcpServers = getWorkspaceMcpConfig(workspace.slug).servers
    } catch (err) {
      console.warn('[Agent Runtime] 加载 MCP 配置失败:', err)
    }

    return {
      cwd,
      workspace,
      workspaceSlug,
      mcpServers,
    }
  }
}

export class ElectronRuntimeSessionStore implements RuntimeSessionStore {
  getHistoryMessages(sessionId: string): SDKMessage[] {
    return getAgentSessionSDKMessages(sessionId)
  }

  appendMessages(sessionId: string, messages: SDKMessage[]): void {
    appendSDKMessages(sessionId, messages)
  }

  truncateMessages(sessionId: string, upToUuidInclusive: string): SDKMessage[] {
    return truncateSDKMessages(sessionId, upToUuidInclusive)
  }
}

export class EventBusRuntimeEventSink implements RuntimeEventSink {
  constructor(private readonly eventBus: AgentEventBus) {}

  emit(sessionId: string, payload: AgentStreamPayload): void {
    this.eventBus.emit(sessionId, payload)
  }
}

export function createElectronRuntimeServices(eventBus: AgentEventBus): RuntimeServices {
  return {
    credentials: new ElectronRuntimeCredentialStore(),
    workspaces: new ElectronRuntimeWorkspaceStore(),
    sessions: new ElectronRuntimeSessionStore(),
    events: new EventBusRuntimeEventSink(eventBus),
    mcp: new ElectronRuntimeMcpService(),
  }
}

function getDefaultModel(channel: Channel): string | undefined {
  return channel.models.find((model) => model.enabled)?.id ?? channel.models[0]?.id
}

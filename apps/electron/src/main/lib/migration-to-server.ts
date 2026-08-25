/**
 * 数据迁移工具：本地 JSON → 服务端 Postgres
 *
 * 将 Gravitas 开源版的本地文件数据迁移到企业版服务端。
 * 所有数据自动映射到 'local' 租户。
 */

import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type {
  AgentRuntimeScope,
  Channel,
  AgentWorkspace,
  AgentSessionMeta,
  WorkspaceMcpConfig,
  SDKMessage,
} from '@gravitas/shared'
import { getConfigDir } from './config-paths'

interface MigrationResult {
  success: boolean
  migrated: {
    channels: number
    workspaces: number
    sessions: number
    messages: number
    mcpConfigs: number
  }
  errors: string[]
}

interface MigrationOptions {
  /** 目标服务端 URL */
  serverUrl: string
  /** 鉴权 token（Bearer）或 localAdmin 凭据 */
  authToken?: string
  /** 本地配置目录（默认 ~/.gravitas/） */
  localConfigDir?: string
  /** 是否 dry-run（只统计，不实际写入） */
  dryRun?: boolean
}

/**
 * 将本地数据迁移到服务端
 *
 * 迁移顺序：渠道 → 工作区 → MCP 配置 → 会话 → 消息
 * 所有数据自动绑定 tenantId='local'。
 */
export async function migrateLocalToServer(options: MigrationOptions): Promise<MigrationResult> {
  const result: MigrationResult = {
    success: false,
    migrated: { channels: 0, workspaces: 0, sessions: 0, messages: 0, mcpConfigs: 0 },
    errors: [],
  }

  const configDir = options.localConfigDir || getConfigDir()
  const scope: AgentRuntimeScope = { tenantId: 'local', userId: 'default', roles: ['admin'] }

  try {
    // 1. 迁移渠道
    const channels = await migrateChannels(configDir, options, scope)
    result.migrated.channels = channels.count
    result.errors.push(...channels.errors)

    // 2. 迁移工作区
    const workspaces = await migrateWorkspaces(configDir, options, scope)
    result.migrated.workspaces = workspaces.count
    result.errors.push(...workspaces.errors)

    // 3. 迁移 MCP 配置
    const mcpConfigs = await migrateMcpConfigs(configDir, options, scope)
    result.migrated.mcpConfigs = mcpConfigs.count
    result.errors.push(...mcpConfigs.errors)

    // 4. 迁移会话
    const sessions = await migrateSessions(configDir, options, scope)
    result.migrated.sessions = sessions.count
    result.migrated.messages = sessions.messageCount
    result.errors.push(...sessions.errors)

    result.success = result.errors.length === 0
  } catch (error) {
    result.errors.push(`迁移失败: ${error instanceof Error ? error.message : String(error)}`)
  }

  return result
}

// ===== 迁移子任务 =====

async function migrateChannels(
  configDir: string,
  options: MigrationOptions,
  scope: AgentRuntimeScope,
): Promise<{ count: number; errors: string[] }> {
  const errors: string[] = []
  const channelsPath = join(configDir, 'channels.json')
  if (!existsSync(channelsPath)) return { count: 0, errors }

  let channels: Channel[] = []
  try {
    channels = JSON.parse(readFileSync(channelsPath, 'utf-8')) as Channel[]
  } catch {
    errors.push('channels.json 解析失败')
    return { count: 0, errors }
  }

  if (options.dryRun) return { count: channels.length, errors }

  for (const channel of channels) {
    try {
      const response = await fetch(`${options.serverUrl}/agent/credentials`, {
        method: 'PUT',
        headers: {
          'content-type': 'application/json',
          ...(options.authToken && { authorization: `Bearer ${options.authToken}` }),
        },
        body: JSON.stringify({
          ...scope,
          channelId: channel.id,
          provider: channel.provider,
          apiKey: channel.apiKey,
          baseUrl: channel.baseUrl || '',
          defaultModel: channel.models[0]?.id,
        }),
      })
      if (!response.ok) errors.push(`渠道 ${channel.id} 迁移失败: ${response.status}`)
    } catch (error) {
      errors.push(`渠道 ${channel.id} 迁移异常: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  return { count: channels.length, errors }
}

async function migrateWorkspaces(
  configDir: string,
  options: MigrationOptions,
  scope: AgentRuntimeScope,
): Promise<{ count: number; errors: string[] }> {
  const errors: string[] = []
  const workspacesPath = join(configDir, 'agent-workspaces.json')
  if (!existsSync(workspacesPath)) return { count: 0, errors }

  let workspaces: AgentWorkspace[] = []
  try {
    const index = JSON.parse(readFileSync(workspacesPath, 'utf-8')) as { workspaces: AgentWorkspace[] }
    workspaces = index.workspaces || []
  } catch {
    errors.push('agent-workspaces.json 解析失败')
    return { count: 0, errors }
  }

  if (options.dryRun) return { count: workspaces.length, errors }

  for (const workspace of workspaces) {
    try {
      const response = await fetch(`${options.serverUrl}/agent/workspaces`, {
        method: 'PUT',
        headers: {
          'content-type': 'application/json',
          ...(options.authToken && { authorization: `Bearer ${options.authToken}` }),
        },
        body: JSON.stringify({
          ...scope,
          workspaceSlug: workspace.slug,
          cwd: workspace.rootPath || join(configDir, 'agent-workspaces', workspace.slug),
          mcpServers: {},
        }),
      })
      if (!response.ok) errors.push(`工作区 ${workspace.slug} 迁移失败: ${response.status}`)
    } catch (error) {
      errors.push(`工作区 ${workspace.slug} 迁移异常: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  return { count: workspaces.length, errors }
}

async function migrateMcpConfigs(
  configDir: string,
  options: MigrationOptions,
  scope: AgentRuntimeScope,
): Promise<{ count: number; errors: string[] }> {
  const errors: string[] = []
  const workspacesPath = join(configDir, 'agent-workspaces.json')
  if (!existsSync(workspacesPath)) return { count: 0, errors }

  let workspaces: AgentWorkspace[] = []
  try {
    const index = JSON.parse(readFileSync(workspacesPath, 'utf-8')) as { workspaces: AgentWorkspace[] }
    workspaces = index.workspaces || []
  } catch {
    return { count: 0, errors }
  }

  let count = 0
  for (const workspace of workspaces) {
    const mcpPath = join(configDir, 'agent-workspaces', workspace.slug, 'mcp.json')
    if (!existsSync(mcpPath)) continue

    try {
      const mcpConfig = JSON.parse(readFileSync(mcpPath, 'utf-8')) as WorkspaceMcpConfig
      count++

      if (options.dryRun) continue

      const response = await fetch(`${options.serverUrl}/agent/workspaces`, {
        method: 'PUT',
        headers: {
          'content-type': 'application/json',
          ...(options.authToken && { authorization: `Bearer ${options.authToken}` }),
        },
        body: JSON.stringify({
          ...scope,
          workspaceSlug: workspace.slug,
          mcpServers: mcpConfig.servers,
        }),
      })
      if (!response.ok) errors.push(`MCP ${workspace.slug} 迁移失败: ${response.status}`)
    } catch (error) {
      errors.push(`MCP ${workspace.slug} 迁移异常: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  return { count, errors }
}

async function migrateSessions(
  configDir: string,
  options: MigrationOptions,
  scope: AgentRuntimeScope,
): Promise<{ count: number; messageCount: number; errors: string[] }> {
  const errors: string[] = []
  const sessionsPath = join(configDir, 'agent-sessions.json')
  if (!existsSync(sessionsPath)) return { count: 0, messageCount: 0, errors }

  let sessions: AgentSessionMeta[] = []
  try {
    const index = JSON.parse(readFileSync(sessionsPath, 'utf-8')) as { sessions: AgentSessionMeta[] }
    sessions = index.sessions || []
  } catch {
    errors.push('agent-sessions.json 解析失败')
    return { count: 0, messageCount: 0, errors }
  }

  let messageCount = 0
  if (options.dryRun) {
    // 统计消息数
    for (const session of sessions) {
      const messagesPath = join(configDir, 'agent-sessions', `${session.id}.jsonl`)
      if (!existsSync(messagesPath)) continue
      const lines = readFileSync(messagesPath, 'utf-8').split('\n').filter(Boolean)
      messageCount += lines.length
    }
    return { count: sessions.length, messageCount, errors }
  }

  for (const session of sessions) {
    try {
      // 创建会话
      const response = await fetch(`${options.serverUrl}/agent/sessions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(options.authToken && { authorization: `Bearer ${options.authToken}` }),
        },
        body: JSON.stringify({
          ...scope,
          sessionId: session.id,
          workspaceSlug: session.workspaceId || 'default',
          channelId: session.channelId || '',
          modelId: session.modelId || '',
          runtime: session.agentRuntime || 'claude',
          title: session.title,
          createdAt: session.createdAt,
          updatedAt: session.updatedAt,
        }),
      })
      if (!response.ok) {
        errors.push(`会话 ${session.id} 迁移失败: ${response.status}`)
        continue
      }

      // 迁移消息
      const messagesPath = join(configDir, 'agent-sessions', `${session.id}.jsonl`)
      if (existsSync(messagesPath)) {
        const lines = readFileSync(messagesPath, 'utf-8').split('\n').filter(Boolean)
        const messages: SDKMessage[] = lines.map((line) => JSON.parse(line) as SDKMessage)
        messageCount += messages.length

        await fetch(`${options.serverUrl}/agent/sessions/${session.id}/messages`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(options.authToken && { authorization: `Bearer ${options.authToken}` }),
          },
          body: JSON.stringify({ ...scope, messages }),
        })
      }
    } catch (error) {
      errors.push(`会话 ${session.id} 迁移异常: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  return { count: sessions.length, messageCount, errors }
}

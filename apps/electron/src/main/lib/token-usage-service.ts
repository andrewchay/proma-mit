/**
 * Token 消耗统计服务
 *
 * 通过订阅 AgentEventBus 中间件，无侵入地采集 Agent 每轮调用的 token 用量，
 * 并按工具 / Skill / MCP / 模型维度持久化到本地 JSONL。
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type {
  AgentStreamPayload,
  SDKAssistantMessage,
  SDKContentBlock,
  SDKMessage,
  SDKToolUseBlock,
  TokenUsageAggregate,
  TokenUsageDayItem,
  TokenUsageDimensionItem,
  TokenUsageIndex,
  TokenUsageQuery,
  TokenUsageRecord,
  TokenUsageSessionSummary,
} from '@proma/shared'
import type { AgentEventMiddleware } from './agent-event-bus'
import { getTokenUsageIndexPath, getTokenUsageMonthPath, getDefaultSkillsDir } from './config-paths'
import { getAgentSessionMeta } from './agent-session-manager'
import { getAgentWorkspace, getWorkspaceSkills } from './agent-workspace-manager'

/** 单文件最大记录数软上限（用于裁剪极久远的月份，非严格限制） */
const MAX_INDEX_SESSIONS = 2000
/** 索引更新防抖毫秒 */
const INDEX_DEBOUNCE_MS = 1000
/** 默认 Skill slug 白名单缓存 */
let defaultSkillSlugsCache: string[] | undefined

/** 从运行时 message 中归一化 usage 数据 */
function normalizeUsage(message: SDKAssistantMessage): {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  totalTokens: number
  costInput: number
  costOutput: number
  costCacheRead: number
  costCacheCreation: number
  costTotal: number
} {
  const raw = (message.message as Record<string, unknown>)?.usage as Record<string, unknown> | undefined
  const fallbackTotal =
    (typeof raw?.input_tokens === 'number' ? raw.input_tokens : 0) +
    (typeof raw?.input === 'number' ? raw.input : 0) +
    (typeof raw?.output_tokens === 'number' ? raw.output_tokens : 0) +
    (typeof raw?.output === 'number' ? raw.output : 0)

  const inputTokens =
    (typeof raw?.input_tokens === 'number' ? raw.input_tokens : 0) ||
    (typeof raw?.input === 'number' ? raw.input : 0) ||
    0
  const outputTokens =
    (typeof raw?.output_tokens === 'number' ? raw.output_tokens : 0) ||
    (typeof raw?.output === 'number' ? raw.output : 0) ||
    0
  const cacheReadTokens =
    (typeof raw?.cache_read_input_tokens === 'number' ? raw.cache_read_input_tokens : 0) ||
    (typeof raw?.cacheRead === 'number' ? raw.cacheRead : 0) ||
    (typeof raw?.prompt_cache_hit_tokens === 'number' ? raw.prompt_cache_hit_tokens : 0) ||
    0
  const cacheCreationTokens =
    (typeof raw?.cache_creation_input_tokens === 'number' ? raw.cache_creation_input_tokens : 0) ||
    (typeof raw?.cacheWrite === 'number' ? raw.cacheWrite : 0) ||
    (typeof raw?.prompt_cache_miss_tokens === 'number' ? raw.prompt_cache_miss_tokens : 0) ||
    0
  const totalTokens =
    (typeof raw?.totalTokens === 'number' ? raw.totalTokens : 0) ||
    (typeof raw?.total_tokens === 'number' ? raw.total_tokens : 0) ||
    (inputTokens + outputTokens) ||
    fallbackTotal

  const rawCost = raw?.cost as Record<string, unknown> | undefined
  const costInput = typeof rawCost?.input === 'number' ? rawCost.input : 0
  const costOutput = typeof rawCost?.output === 'number' ? rawCost.output : 0
  const costCacheRead = typeof rawCost?.cacheRead === 'number' ? rawCost.cacheRead : 0
  const costCacheCreation = typeof rawCost?.cacheWrite === 'number' ? rawCost.cacheWrite : 0
  const costTotal =
    typeof rawCost?.total === 'number'
      ? rawCost.total
      : costInput + costOutput + costCacheRead + costCacheCreation

  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    totalTokens,
    costInput,
    costOutput,
    costCacheRead,
    costCacheCreation,
    costTotal,
  }
}

/** 从 content blocks 中提取所有 tool_use 块 */
function extractToolUseBlocks(content: SDKContentBlock[] | undefined): SDKToolUseBlock[] {
  if (!Array.isArray(content)) return []
  return content.filter((block): block is SDKToolUseBlock => {
    if (!block || typeof block !== 'object') return false
    return (block as SDKToolUseBlock).type === 'tool_use' && typeof (block as SDKToolUseBlock).name === 'string'
  })
}

/** 解析 MCP 服务器名（mcp__server__tool） */
function parseMcpServer(toolName: string): string | undefined {
  if (!toolName.startsWith('mcp__')) return undefined
  const parts = toolName.split('__')
  if (parts.length < 2) return undefined
  return parts[1]
}

/** 生成某日期字符串（YYYY-MM-DD） */
function toDateString(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** 合并维度聚合条目 */
function mergeDimensionItem(
  map: Map<string, TokenUsageDimensionItem>,
  name: string,
  input: number,
  output: number,
  cacheRead: number,
  cacheCreation: number,
  total: number,
  cost: number,
): void {
  const existing = map.get(name)
  if (existing) {
    existing.count += 1
    existing.inputTokens += input
    existing.outputTokens += output
    existing.cacheReadTokens += cacheRead
    existing.cacheCreationTokens += cacheCreation
    existing.totalTokens += total
    existing.cost += cost
  } else {
    map.set(name, {
      name,
      count: 1,
      inputTokens: input,
      outputTokens: output,
      cacheReadTokens: cacheRead,
      cacheCreationTokens: cacheCreation,
      totalTokens: total,
      cost,
    })
  }
}

/** 合并按天聚合条目 */
function mergeDayItem(
  map: Map<string, TokenUsageDayItem>,
  date: string,
  input: number,
  output: number,
  cacheRead: number,
  cacheCreation: number,
  total: number,
  cost: number,
): void {
  const existing = map.get(date)
  if (existing) {
    existing.count += 1
    existing.inputTokens += input
    existing.outputTokens += output
    existing.cacheReadTokens += cacheRead
    existing.cacheCreationTokens += cacheCreation
    existing.totalTokens += total
    existing.cost += cost
  } else {
    map.set(date, {
      date,
      count: 1,
      inputTokens: input,
      outputTokens: output,
      cacheReadTokens: cacheRead,
      cacheCreationTokens: cacheCreation,
      totalTokens: total,
      cost,
    })
  }
}

export class TokenUsageService {
  /** 内存缓存：最近一年的所有记录（按时间倒序） */
  private cache: TokenUsageRecord[] = []
  /** 每会话当前最大 turnIndex */
  private sessionTurnIndex = new Map<string, number>()
  /** 索引更新计时器 */
  private indexDebounceTimer: ReturnType<typeof setTimeout> | null = null
  /** 是否已加载 */
  private loaded = false

  /**
   * 启动服务：加载历史 JSONL 并恢复内存缓存与 turnIndex。
   *
   * 应在应用启动后调用一次。
   */
  start(): void {
    if (this.loaded) return
    this.loadFromDisk()
    this.loaded = true
  }

  /**
   * AgentEventBus 中间件。
   *
   * 监听 sdk_message 事件，对完整 assistant message 提取 usage 并持久化。
   */
  middleware: AgentEventMiddleware = (sessionId, payload, next) => {
    next()
    this.handleEvent(sessionId, payload)
  }

  private handleEvent(sessionId: string, payload: AgentStreamPayload): void {
    if (payload.kind !== 'sdk_message') return
    const message = payload.message as SDKMessage | undefined
    if (!message || typeof message !== 'object') return

    // 只处理完整的 assistant message
    if (message.type !== 'assistant') return
    const assistantMessage = message as SDKAssistantMessage
    if (((assistantMessage as unknown) as Record<string, unknown>)._partial === true) return

    const normalized = normalizeUsage(assistantMessage)
    if (normalized.totalTokens === 0 && normalized.inputTokens === 0 && normalized.outputTokens === 0) return

    const toolBlocks = extractToolUseBlocks(assistantMessage.message.content)
    const rawToolNames = toolBlocks.map((block) => block.name).filter((name): name is string => typeof name === 'string')
    const toolNames = [...new Set(rawToolNames)]

    const workspaceId = this.resolveWorkspaceId(sessionId)
    const skillIds = this.resolveSkillIds(toolNames, workspaceId)
    const mcpServers = [...new Set(toolNames.map(parseMcpServer).filter((name): name is string => !!name))]

    const nextTurnIndex = (this.sessionTurnIndex.get(sessionId) ?? 0) + 1
    this.sessionTurnIndex.set(sessionId, nextTurnIndex)

    const meta = getAgentSessionMeta(sessionId)

    const record: TokenUsageRecord = {
      id: randomUUID(),
      sessionId,
      turnIndex: nextTurnIndex,
      messageUuid: assistantMessage.uuid,
      timestamp: (((assistantMessage as unknown) as Record<string, number>)._createdAt) ?? Date.now(),
      modelId: assistantMessage.message.model ?? meta?.modelId,
      channelId: meta?.channelId,
      agentRuntime: meta?.agentRuntime,
      ...normalized,
      toolNames,
      skillIds,
      mcpServers,
      sessionTitle: meta?.title,
      workspaceId,
      goalId: meta?.goalId,
    }

    this.appendRecord(record)
  }

  private resolveWorkspaceId(sessionId: string): string | undefined {
    const meta = getAgentSessionMeta(sessionId)
    return meta?.workspaceId
  }

  private resolveSkillIds(toolNames: string[], workspaceId: string | undefined): string[] {
    const skillSlugs = this.getSkillSlugs(workspaceId)
    return [...new Set(toolNames.filter((name) => skillSlugs.includes(name)))]
  }

  private getSkillSlugs(workspaceId: string | undefined): string[] {
    const workspaceSlugs = new Set<string>()
    if (workspaceId) {
      try {
        const skills = getWorkspaceSkills(getAgentWorkspace(workspaceId)?.slug ?? '')
        for (const skill of skills) {
          workspaceSlugs.add(skill.slug)
        }
      } catch {
        // 忽略工作区读取失败
      }
    }
    return [...new Set([...this.getDefaultSkillSlugs(), ...workspaceSlugs])]
  }

  private getDefaultSkillSlugs(): string[] {
    if (defaultSkillSlugsCache) return defaultSkillSlugsCache
    try {
      const defaultSkillsDir = getDefaultSkillsDir()
      if (!existsSync(defaultSkillsDir)) {
        defaultSkillSlugsCache = []
        return defaultSkillSlugsCache
      }
      const entries = readdirSync(defaultSkillsDir, { withFileTypes: true })
      defaultSkillSlugsCache = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
    } catch {
      defaultSkillSlugsCache = []
    }
    return defaultSkillSlugsCache ?? []
  }

  /** 追加一条记录到本地 JSONL 与内存缓存 */
  private appendRecord(record: TokenUsageRecord): void {
    try {
      const line = `${JSON.stringify(record)}\n`
      appendFileSync(getTokenUsageMonthPath(record.timestamp), line, 'utf-8')
      this.cache.unshift(record)
      this.scheduleIndexUpdate()
    } catch (error) {
      console.error('[TokenUsage] 写入记录失败:', error)
    }
  }

  /** 从磁盘加载历史记录 */
  private loadFromDisk(): void {
    try {
      const indexPath = getTokenUsageIndexPath()
      if (existsSync(indexPath)) {
        const raw = readFileSync(indexPath, 'utf-8')
        const parsed = JSON.parse(raw) as TokenUsageIndex
        if (parsed.sessions) {
          for (const session of parsed.sessions) {
            this.sessionTurnIndex.set(session.sessionId, session.turns)
          }
        }
      }
    } catch {
      // 索引文件可能不存在或损坏，继续从 JSONL 加载
    }

    try {
      const dir = join(getTokenUsageIndexPath(), '..')
      if (!existsSync(dir)) return
      const files = readdirSync(dir)
        .filter((name) => name.endsWith('.jsonl'))
        .sort()
        .reverse()

      const records: TokenUsageRecord[] = []
      const now = Date.now()
      const oneYearAgo = now - 365 * 24 * 60 * 60 * 1000

      for (const file of files) {
        const filePath = join(dir, file)
        const content = readFileSync(filePath, 'utf-8')
        const lines = content.split('\n').filter((line) => line.trim())
        for (const line of lines) {
          try {
            const record = JSON.parse(line) as TokenUsageRecord
            if (record.timestamp >= oneYearAgo) {
              records.push(record)
              const currentMax = this.sessionTurnIndex.get(record.sessionId) ?? 0
              if (record.turnIndex > currentMax) {
                this.sessionTurnIndex.set(record.sessionId, record.turnIndex)
              }
            }
          } catch {
            // 跳过损坏行
          }
        }
      }

      this.cache = records.sort((a, b) => b.timestamp - a.timestamp)
      this.rebuildIndexSync()
    } catch (error) {
      console.error('[TokenUsage] 加载历史记录失败:', error)
    }
  }

  /** 安排索引更新（防抖） */
  private scheduleIndexUpdate(): void {
    if (this.indexDebounceTimer) {
      clearTimeout(this.indexDebounceTimer)
    }
    this.indexDebounceTimer = setTimeout(() => {
      this.rebuildIndexSync()
    }, INDEX_DEBOUNCE_MS)
  }

  /** 同步重建索引文件 */
  private rebuildIndexSync(): void {
    try {
      const sessionMap = new Map<string, TokenUsageSessionSummary>()
      for (const record of this.cache) {
        const existing = sessionMap.get(record.sessionId)
        if (existing) {
          existing.turns = Math.max(existing.turns, record.turnIndex)
          existing.inputTokens += record.inputTokens
          existing.outputTokens += record.outputTokens
          existing.cacheReadTokens += record.cacheReadTokens
          existing.cacheCreationTokens += record.cacheCreationTokens
          existing.totalTokens += record.totalTokens
          existing.cost += record.costTotal
          if (record.timestamp > existing.lastTimestamp) {
            existing.lastTimestamp = record.timestamp
            existing.title = record.sessionTitle ?? existing.title
          }
        } else {
          sessionMap.set(record.sessionId, {
            sessionId: record.sessionId,
            title: record.sessionTitle ?? record.sessionId,
            workspaceId: record.workspaceId,
            turns: record.turnIndex,
            inputTokens: record.inputTokens,
            outputTokens: record.outputTokens,
            cacheReadTokens: record.cacheReadTokens,
            cacheCreationTokens: record.cacheCreationTokens,
            totalTokens: record.totalTokens,
            cost: record.costTotal,
            lastTimestamp: record.timestamp,
          })
        }
      }

      const sessions = [...sessionMap.values()]
        .sort((a, b) => b.lastTimestamp - a.lastTimestamp)
        .slice(0, MAX_INDEX_SESSIONS)

      const index: TokenUsageIndex = {
        version: 1,
        sessions,
        lastUpdatedAt: Date.now(),
      }
      writeFileSync(getTokenUsageIndexPath(), `${JSON.stringify(index)}\n`, 'utf-8')
    } catch (error) {
      console.error('[TokenUsage] 重建索引失败:', error)
    }
  }

  /** 查询记录明细 */
  query(query: TokenUsageQuery = {}): TokenUsageRecord[] {
    this.ensureStarted()
    const { sessionId, workspaceId, from, to, limit = 100 } = query
    const results = this.cache.filter((record) => {
      if (sessionId && record.sessionId !== sessionId) return false
      if (workspaceId && record.workspaceId !== workspaceId) return false
      if (from && record.timestamp < from) return false
      if (to && record.timestamp > to) return false
      return true
    })
    return results.slice(0, limit)
  }

  /** 聚合统计 */
  aggregate(query: TokenUsageQuery = {}): TokenUsageAggregate {
    this.ensureStarted()
    const records = this.query({ ...query, limit: Number.MAX_SAFE_INTEGER })

    let totalInputTokens = 0
    let totalOutputTokens = 0
    let totalCacheReadTokens = 0
    let totalCacheCreationTokens = 0
    let totalTokens = 0
    let totalCost = 0

    const byTool = new Map<string, TokenUsageDimensionItem>()
    const bySkill = new Map<string, TokenUsageDimensionItem>()
    const byMcpServer = new Map<string, TokenUsageDimensionItem>()
    const byModel = new Map<string, TokenUsageDimensionItem>()
    const byDay = new Map<string, TokenUsageDayItem>()

    for (const record of records) {
      totalInputTokens += record.inputTokens
      totalOutputTokens += record.outputTokens
      totalCacheReadTokens += record.cacheReadTokens
      totalCacheCreationTokens += record.cacheCreationTokens
      totalTokens += record.totalTokens
      totalCost += record.costTotal

      const date = toDateString(record.timestamp)
      mergeDayItem(
        byDay,
        date,
        record.inputTokens,
        record.outputTokens,
        record.cacheReadTokens,
        record.cacheCreationTokens,
        record.totalTokens,
        record.costTotal,
      )

      mergeDimensionItem(
        byModel,
        record.modelId ?? 'unknown',
        record.inputTokens,
        record.outputTokens,
        record.cacheReadTokens,
        record.cacheCreationTokens,
        record.totalTokens,
        record.costTotal,
      )

      for (const toolName of record.toolNames) {
        mergeDimensionItem(
          byTool,
          toolName,
          record.inputTokens / record.toolNames.length,
          record.outputTokens / record.toolNames.length,
          record.cacheReadTokens / record.toolNames.length,
          record.cacheCreationTokens / record.toolNames.length,
          record.totalTokens / record.toolNames.length,
          record.costTotal / record.toolNames.length,
        )
      }

      for (const skillId of record.skillIds) {
        mergeDimensionItem(
          bySkill,
          skillId,
          record.inputTokens / record.skillIds.length,
          record.outputTokens / record.skillIds.length,
          record.cacheReadTokens / record.skillIds.length,
          record.cacheCreationTokens / record.skillIds.length,
          record.totalTokens / record.skillIds.length,
          record.costTotal / record.skillIds.length,
        )
      }

      for (const server of record.mcpServers) {
        mergeDimensionItem(
          byMcpServer,
          server,
          record.inputTokens / record.mcpServers.length,
          record.outputTokens / record.mcpServers.length,
          record.cacheReadTokens / record.mcpServers.length,
          record.cacheCreationTokens / record.mcpServers.length,
          record.totalTokens / record.mcpServers.length,
          record.costTotal / record.mcpServers.length,
        )
      }
    }

    const sortByTotal = (a: TokenUsageDimensionItem, b: TokenUsageDimensionItem) => b.totalTokens - a.totalTokens
    const sortByDay = (a: TokenUsageDayItem, b: TokenUsageDayItem) => a.date.localeCompare(b.date)

    return {
      totalInputTokens,
      totalOutputTokens,
      totalCacheReadTokens,
      totalCacheCreationTokens,
      totalTokens,
      totalCost,
      byTool: [...byTool.values()].sort(sortByTotal),
      bySkill: [...bySkill.values()].sort(sortByTotal),
      byMcpServer: [...byMcpServer.values()].sort(sortByTotal),
      byModel: [...byModel.values()].sort(sortByTotal),
      byDay: [...byDay.values()].sort(sortByDay),
    }
  }

  /** 查询会话汇总列表 */
  listSessions(): TokenUsageSessionSummary[] {
    this.ensureStarted()
    const sessionMap = new Map<string, TokenUsageSessionSummary>()
    for (const record of this.cache) {
      const existing = sessionMap.get(record.sessionId)
      if (existing) {
        existing.turns = Math.max(existing.turns, record.turnIndex)
        existing.inputTokens += record.inputTokens
        existing.outputTokens += record.outputTokens
        existing.cacheReadTokens += record.cacheReadTokens
        existing.cacheCreationTokens += record.cacheCreationTokens
        existing.totalTokens += record.totalTokens
        existing.cost += record.costTotal
        if (record.timestamp > existing.lastTimestamp) {
          existing.lastTimestamp = record.timestamp
          existing.title = record.sessionTitle ?? existing.title
        }
      } else {
        sessionMap.set(record.sessionId, {
          sessionId: record.sessionId,
          title: record.sessionTitle ?? record.sessionId,
          workspaceId: record.workspaceId,
          turns: record.turnIndex,
          inputTokens: record.inputTokens,
          outputTokens: record.outputTokens,
          cacheReadTokens: record.cacheReadTokens,
          cacheCreationTokens: record.cacheCreationTokens,
          totalTokens: record.totalTokens,
          cost: record.costTotal,
          lastTimestamp: record.timestamp,
        })
      }
    }
    return [...sessionMap.values()].sort((a, b) => b.lastTimestamp - a.lastTimestamp)
  }

  /** 清空所有 token 使用记录 */
  clear(): void {
    this.ensureStarted()
    try {
      const dir = join(getTokenUsageIndexPath(), '..')
      if (!existsSync(dir)) return
      for (const file of readdirSync(dir)) {
        if (file.endsWith('.jsonl') || file === 'index.json') {
          rmSync(join(dir, file))
        }
      }
      this.cache = []
      this.sessionTurnIndex.clear()
    } catch (error) {
      console.error('[TokenUsage] 清空记录失败:', error)
      throw error
    }
  }

  private ensureStarted(): void {
    if (!this.loaded) {
      this.start()
    }
  }
}

/** 全局单例 */
export const tokenUsageService = new TokenUsageService()

/** 用于测试的工厂函数 */
export function createTokenUsageService(): TokenUsageService {
  return new TokenUsageService()
}

/** 便捷查询：供证据服务等按条件读取 token 使用记录 */
export function getTokenUsageRecords(query: import('@proma/shared').TokenUsageQuery): import('@proma/shared').TokenUsageRecord[] {
  return tokenUsageService.query(query)
}

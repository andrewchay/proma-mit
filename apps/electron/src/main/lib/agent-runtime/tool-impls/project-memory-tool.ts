/**
 * 项目记忆工具实现（Agent Runtime）
 *
 * 为 Agent 提供按会话授权范围检索本地长期记忆的能力：
 * - SearchProjectMemory：先由主进程按 session.workspaceId / projectId / 当前正式绑定
 *   过滤记忆条目，再做内容匹配。
 * - ReadProjectMemory：按 id 读取单条记忆，并在返回内容前二次校验当前会话范围。
 *
 * 权限边界：
 * - 范围来自持久化会话与实时绑定，工具参数不接受 projectId / workspaceId。
 * - 项目条目必须同时满足：会话有 projectId、条目 projectIds 包含该 projectId、
 *   会话 workspaceId 与 projectId 存在正式绑定。
 * - 旧无 scope 条目在工作空间/个人检索中兼容可见，但不进入已绑定项目的检索结果。
 */

import { createRequire } from 'node:module'
import type { ToolResult } from '@gravitas/core'
import type { ToolContext } from '../types.ts'
import type { MemoryItem } from '../../memory-plugin-service'

/**
 * 动态加载记忆存储服务。
 * memory-plugin-service 在模块尾部注册 IPC 并依赖 electron；Agent Runtime 工具只调用
 * 纯数据 API，动态 require 可避免 Pi Bridge 单测与打包初始化过早拉入 electron。
 */
const scopedRequire = createRequire(typeof __filename === 'string' ? __filename : import.meta.url)

interface MemoryPluginDataService {
  searchScopedMemoryItems(input: { query: string; sessionId: string; limit?: number }): MemoryItem[]
  getScopedMemoryItem(id: string, sessionId: string): MemoryItem | undefined
  recordMemoryUsage(id: string): MemoryItem | null
}

function loadMemoryPluginService(): MemoryPluginDataService {
  return scopedRequire('../../memory-plugin-service') as MemoryPluginDataService
}

export const SEARCH_PROJECT_MEMORY_TOOL_NAME = 'SearchProjectMemory'
export const READ_PROJECT_MEMORY_TOOL_NAME = 'ReadProjectMemory'

export interface SearchProjectMemoryInput {
  query: string
  limit?: number
}

export interface ReadProjectMemoryInput {
  memoryId: string
}

/** 人类可读的范围标签；未知/旧数据不给项目归属暗示 */
function formatScope(item: MemoryItem): string {
  if (!item.scope) return '未分类（旧格式）'
  if (item.scope.kind === 'project') {
    const count = item.scope.projectIds?.length ?? 0
    return `项目（${count} 个项目）`
  }
  if (item.scope.kind === 'workspace') return item.scope.workspaceId ? '当前工作空间' : '工作空间（未指明）'
  return '个人'
}

/** 来源定位：只展示真实存在的字段，避免伪造项目或路径 */
function formatSource(item: MemoryItem): string {
  const parts: string[] = []
  const source = item.source
  if (source?.workspaceId) parts.push(`工作空间 ${source.workspaceId}`)
  if (source?.sessionId) parts.push(`会话 ${source.sessionId}`)
  if (source?.runId) parts.push(`运行 ${source.runId}`)
  if (source?.locator) parts.push(`出处 ${source.locator}`)
  if (typeof source?.observedAt === 'number') {
    parts.push(`观察于 ${new Date(source.observedAt).toLocaleString('zh-CN')}`)
  }
  // 兼容旧版平铺字段
  if (parts.length === 0 && item.sourceSessionId) parts.push(`会话 ${item.sourceSessionId}`)
  if (parts.length === 0 && item.sourceRunId) parts.push(`运行 ${item.sourceRunId}`)
  return parts.length > 0 ? parts.join(' · ') : '未记录来源'
}

function formatItemSummary(item: MemoryItem, index: number): string {
  const content = item.content.replace(/\s+/g, ' ').trim()
  const excerpt = content.length > 240 ? `${content.slice(0, 240)}…` : content
  return [
    `${index + 1}. ${item.title}`,
    `   范围: ${formatScope(item)}`,
    `   来源: ${formatSource(item)}`,
    `   更新: ${new Date(item.updatedAt).toLocaleString('zh-CN')}`,
    `   内容: ${excerpt}`,
  ].join('\n')
}

export function createSearchProjectMemoryToolDefinition() {
  return {
    name: SEARCH_PROJECT_MEMORY_TOOL_NAME,
    description:
      '在当前会话授权范围内检索本地长期记忆。项目会话只返回当前项目可见的项目记忆；普通会话返回个人与当前工作空间记忆。结果包含范围与来源，可用于追溯。',
    parameters: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: '记忆检索关键词，可匹配标题、内容与标签' },
        limit: { type: 'number', description: '返回条数上限（默认 8，最大 20）' },
      },
      required: ['query'],
    },
  }
}

export function createReadProjectMemoryToolDefinition() {
  return {
    name: READ_PROJECT_MEMORY_TOOL_NAME,
    description:
      '读取本地长期记忆单条完整内容。memoryId 应来自 SearchProjectMemory；读取前会再次校验当前会话范围，越权结果按不存在处理。',
    parameters: {
      type: 'object' as const,
      properties: {
        memoryId: { type: 'string', description: 'SearchProjectMemory 返回的记忆条目 id' },
      },
      required: ['memoryId'],
    },
  }
}

export async function executeSearchProjectMemoryTool(input: unknown, ctx: ToolContext): Promise<ToolResult> {
  const query = (input as SearchProjectMemoryInput | null)?.query?.trim()
  if (!query) return { toolCallId: '', content: '参数缺失: query', isError: true }
  if (!ctx.sessionId) return { toolCallId: '', content: '当前工具上下文缺少 sessionId，无法解析记忆范围。', isError: true }

  const rawLimit = (input as SearchProjectMemoryInput).limit
  const limit = typeof rawLimit === 'number' && Number.isFinite(rawLimit)
    ? Math.min(Math.max(Math.trunc(rawLimit), 1), 20)
    : 8

  try {
    const items = loadMemoryPluginService().searchScopedMemoryItems({ query, sessionId: ctx.sessionId, limit })
    if (items.length === 0) {
      return {
        toolCallId: '',
        content: `当前会话范围内没有找到与「${query}」相关的记忆。若这是项目任务，请确认项目已关联当前工作空间；旧未分类记忆不会自动进入项目检索。`,
      }
    }

    // Select 反馈：检索命中即视为一次使用，供效用治理更新；失败不影响本次结果。
    for (const item of items) {
      try {
        loadMemoryPluginService().recordMemoryUsage(item.id)
      } catch {
        // 使用反馈失败不阻断检索
      }
    }

    return {
      toolCallId: '',
      content: `找到 ${items.length} 条当前会话可见的记忆：\n\n${items.map(formatItemSummary).join('\n\n')}`,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error('[项目记忆工具] 检索失败:', error)
    return { toolCallId: '', content: `项目记忆检索失败: ${message}`, isError: true }
  }
}

export async function executeReadProjectMemoryTool(input: unknown, ctx: ToolContext): Promise<ToolResult> {
  const memoryId = (input as ReadProjectMemoryInput | null)?.memoryId?.trim()
  if (!memoryId) return { toolCallId: '', content: '参数缺失: memoryId', isError: true }
  if (!ctx.sessionId) return { toolCallId: '', content: '当前工具上下文缺少 sessionId，无法校验记忆范围。', isError: true }

  try {
    // 二次范围校验：条目存在但不在当前会话可见范围内时按不存在处理，不泄露归属。
    const item = loadMemoryPluginService().getScopedMemoryItem(memoryId, ctx.sessionId)
    if (!item) {
      return {
        toolCallId: '',
        content: '记忆不存在、已归档，或不在当前会话授权范围内。请先通过 SearchProjectMemory 获取当前可见的 memoryId。',
        isError: true,
      }
    }

    try {
      loadMemoryPluginService().recordMemoryUsage(item.id)
    } catch {
      // 使用反馈失败不阻断读取
    }

    return {
      toolCallId: '',
      content: [
        `# ${item.title}`,
        `范围: ${formatScope(item)}`,
        `来源: ${formatSource(item)}`,
        `创建: ${new Date(item.createdAt).toLocaleString('zh-CN')} · 更新: ${new Date(item.updatedAt).toLocaleString('zh-CN')}`,
        '',
        item.content,
      ].join('\n'),
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error('[项目记忆工具] 读取失败:', error)
    return { toolCallId: '', content: `项目记忆读取失败: ${message}`, isError: true }
  }
}

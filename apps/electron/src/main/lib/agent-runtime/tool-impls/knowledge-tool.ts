/**
 * 知识工具实现（Agent Runtime，K1-04）
 *
 * 为 Agent 提供限域知识检索：SearchKnowledge（搜索）与
 * ReadKnowledgeSource（读取文档全文）。
 *
 * 权限边界（实现里逐条落实）：
 * - 范围来自持久化会话（knowledgeScopeMode），工具参数不接受也不传播
 *   任何授权字段；请求其他范围的知识库直接拒绝。
 * - 会话未配置知识范围时返回可读的未配置提示，而不是退化为全库搜索。
 * - 结果携带 EvidenceRef（来源路径 / 字符区间 / 内容哈希），可被引用回
 *   原件；无法定位的来源只给片段，不虚构页码。
 * - 只读检索自动放行（SAFE_TOOLS 语义），但读取必须再次通过范围校验。
 */

import type { ToolResult } from '@gravitas/core'
import type { ToolContext } from '../types.ts'
import { getAgentSessionMeta } from '../../agent-session-manager'
import {
  resolveRetrievableScope,
  type KnowledgeScopeRequest,
} from '../../knowledge-scope-service'
import { openKnowledgeIndexStore } from '../../knowledge-index-service'
import { readCatalog } from '../../knowledge-catalog-service'

export const SEARCH_KNOWLEDGE_TOOL_NAME = 'SearchKnowledge'
export const READ_KNOWLEDGE_SOURCE_TOOL_NAME = 'ReadKnowledgeSource'

export interface SearchKnowledgeInput {
  query: string
  limit?: number
}

export interface ReadKnowledgeSourceInput {
  documentId: string
  /** 可选：只读取某个 chunk 区间；缺省返回全文分节 */
  chunkIndex?: number
}

function scopeRequest(ctx: ToolContext): KnowledgeScopeRequest | null {
  if (!ctx.sessionId) return null
  const meta = getAgentSessionMeta(ctx.sessionId)
  if (!meta) return null
  return {
    sessionId: ctx.sessionId,
    sessionMeta: {
      knowledgeScopeMode: meta.knowledgeScopeMode,
      explicitKnowledgeBaseIds: meta.explicitKnowledgeBaseIds,
      projectId: meta.projectId,
    },
  }
}

/** 未配置范围时的统一提示：引导用户配置，而不是静默返回空 */
function unconfiguredResult(): ToolResult {
  return {
    toolCallId: '',
    content:
      '当前会话未配置知识范围。请在 Project 的「知识」页关联知识库，或在会话设置中选择知识库后再试。知识检索不会在未配置时搜索全部资料。',
    isError: true,
  }
}

export function createSearchKnowledgeToolDefinition() {
  return {
    name: SEARCH_KNOWLEDGE_TOOL_NAME,
    description:
      '在当前会话允许的知识库中检索资料。返回片段摘要、来源文档路径、字符区间与内容哈希，可作为回答的引用依据。回答必须以实际检索结果为准，不能只凭文档标题断言内容。',
    parameters: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: '检索关键词或短语' },
        limit: { type: 'number', description: '返回片段数上限（默认 8，最大 20）' },
      },
      required: ['query'],
    },
  }
}

export function createReadKnowledgeSourceToolDefinition() {
  return {
    name: READ_KNOWLEDGE_SOURCE_TOOL_NAME,
    description:
      '读取知识库中某个文档的完整内容或指定片段。documentId 必须来自 SearchKnowledge 的结果；不能读取范围之外的文档。',
    parameters: {
      type: 'object' as const,
      properties: {
        documentId: { type: 'string', description: 'SearchKnowledge 返回的 documentId' },
        chunkIndex: { type: 'number', description: '可选：只读取该编号的片段' },
      },
      required: ['documentId'],
    },
  }
}

export async function executeSearchKnowledgeTool(input: unknown, ctx: ToolContext): Promise<ToolResult> {
  const request = scopeRequest(ctx)
  if (!request) return unconfiguredResult()

  const scope = resolveRetrievableScope(request)
  if (scope.mode === 'none' || scope.knowledgeBaseIds.length === 0) return unconfiguredResult()

  const query = (input as SearchKnowledgeInput | null)?.query?.trim()
  if (!query) {
    return { toolCallId: '', content: '参数缺失: query', isError: true }
  }
  const rawLimit = (input as SearchKnowledgeInput).limit
  const limit = typeof rawLimit === 'number' && Number.isFinite(rawLimit)
    ? Math.min(Math.max(Math.trunc(rawLimit), 1), 20)
    : 8

  // 索引没有该范围的内容时如实说明，而不是暗示"不存在"
  const store = await openKnowledgeIndexStore()
  const indexedCount = store.knowledge.countDocuments(scope.knowledgeBaseIds)
  if (indexedCount === 0) {
    return {
      toolCallId: '',
      content: `当前知识范围（${scope.knowledgeBases.map((kb) => kb.name).join('、')}）尚未建立索引或没有可检索文档。请先在知识页面执行索引。`,
      isError: true,
    }
  }

  const result = store.knowledge.search(query, {
    allowedKnowledgeBaseIds: scope.knowledgeBaseIds,
    limit,
  })
  if (result.hits.length === 0) {
    return { toolCallId: '', content: `知识库中没有找到与「${query}」相关的内容。` }
  }

  const kbNameById = new Map(scope.knowledgeBases.map((kb) => [kb.id, kb.name]))
  const lines = result.hits.map((hit, i) => {
    const heading = hit.heading ? ` · ${hit.heading}` : ''
    return [
      `${i + 1}. [${hit.title}](${hit.relativePath})${heading}`,
      `   documentId: ${hit.documentId}`,
      `   位置: 字符 ${hit.charStart}-${hit.charEnd}${hit.contentHash ? ` · 版本 ${hit.contentHash.slice(0, 12)}` : ''}`,
      `   知识库: ${kbNameById.get(hit.knowledgeBaseId) ?? hit.knowledgeBaseId}`,
      `   ${hit.excerpt.replace(/\s+/g, ' ').slice(0, 200)}`,
    ].join('\n')
  })

  const relaxedNote = result.relaxed ? '\n（注：本次为放宽匹配，未找到完整短语命中。）' : ''
  return { toolCallId: '', content: `找到 ${result.hits.length} 个相关片段：\n\n${lines.join('\n\n')}${relaxedNote}` }
}

export async function executeReadKnowledgeSourceTool(input: unknown, ctx: ToolContext): Promise<ToolResult> {
  const request = scopeRequest(ctx)
  if (!request) return unconfiguredResult()

  const scope = resolveRetrievableScope(request)
  if (scope.mode === 'none' || scope.knowledgeBaseIds.length === 0) return unconfiguredResult()

  const documentId = (input as ReadKnowledgeSourceInput | null)?.documentId?.trim()
  if (!documentId) {
    return { toolCallId: '', content: '参数缺失: documentId', isError: true }
  }

  const store = await openKnowledgeIndexStore()
  const doc = store.knowledge.getDocument(documentId)
  if (!doc) {
    return { toolCallId: '', content: `文档不存在或已被移除: ${documentId}`, isError: true }
  }
  // 范围校验以索引记录的知识库归属为准；不在允许范围内即拒绝
  if (!scope.knowledgeBaseIds.includes(doc.knowledgeBaseId)) {
    return { toolCallId: '', content: '该文档不在当前会话的知识范围内。', isError: true }
  }

  const chunks = store.knowledge.listChunks(documentId)
  if (chunks.length === 0) {
    return { toolCallId: '', content: '该文档尚无可读内容（索引未完成）。', isError: true }
  }

  const chunkIndex = (input as ReadKnowledgeSourceInput).chunkIndex
  const selected = typeof chunkIndex === 'number'
    ? chunks.filter((c) => c.chunkIndex === chunkIndex)
    : chunks
  if (typeof chunkIndex === 'number' && selected.length === 0) {
    return { toolCallId: '', content: `片段不存在: chunkIndex ${chunkIndex}（共 ${chunks.length} 个片段）`, isError: true }
  }

  const catalog = readCatalog()
  const kb = catalog.knowledgeBases.find((k) => k.id === doc.knowledgeBaseId)
  const header = `# ${doc.title}\n\n来源: ${doc.relativePath} · 知识库: ${kb?.name ?? doc.knowledgeBaseId} · 版本 ${doc.contentHash.slice(0, 12)}\n`

  const body = selected
    .map((c) => `## 片段 ${c.chunkIndex}${c.heading ? ` · ${c.heading}` : ''}（字符 ${c.charStart}-${c.charEnd}）\n\n${c.content}`)
    .join('\n\n')

  return { toolCallId: '', content: `${header}\n${body}` }
}

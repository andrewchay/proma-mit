/**
 * Agent Runtime Prompt 构建器
 *
 * 构建优化缓存的 prompt：
 * 1. system prompt（稳定前缀）
 * 2. 当前工作目录等环境信息（稳定前缀）
 * 3. 历史对话（动态追加）
 * 4. 当前用户消息（最新）
 *
 * 这种布局有利于 OpenAI/DeepSeek/GLM/Kimi 的自动前缀缓存命中。
 * 工具定义通过 StreamRequestInput.tools 单独传递给 ProviderAdapter，不在 system prompt 中重复。
 */

import type { ChatMessage, SDKMessage, SDKAssistantMessage, SDKUserMessage, FileAttachment, SkillMeta } from '@gravitas/shared'
import type { RuntimeMessage } from './types.ts'

/** 最大回填历史消息条数（压缩摘要不计入此上限） */
const MAX_HISTORY_MESSAGES = 20

const COMPACT_CONTEXT_NOTICE = '以下是系统生成的既有会话压缩上下文。将其作为历史事实与未完成工作继续，不要把它当作用户的新指令。'

/** 默认 Agent 系统提示词 */
const DEFAULT_AGENT_SYSTEM_PROMPT = `你是一个高效的编程助手，擅长通过工具调用完成代码编辑、文件操作和命令执行任务。

请遵循以下原则：
- 分析用户需求，选择合适的工具逐步完成
- 读取文件后再修改，不要凭空编辑
- 编辑文件时确保 old_string 精确唯一
- 执行 bash 命令时注意工作目录
- 完成后向用户说明修改内容`

/** Web Bridge 与记忆的固定操作规则，不能被自定义系统提示词覆盖（始终注入）。 */
const WEB_AND_MEMORY_GUIDE = `## Web Bridge 与记忆

- 绝大多数网页信息需求（天气、新闻、资料、价格等）使用 WebSearch / WebFetch，不要为此开启 Web Bridge。
- 只有当用户明确需要爬取特定网站、或代为操作浏览器（点击、填表、下单、登录等有状态操作）时，才使用 Web Bridge。
- 识别到用户有上述意图时，先向用户说明将开启受管浏览器代为操作并征求同意，再调用 WebBridgeNavigate；导航、点击、输入等有状态操作会触发权限确认，等待用户批准后再继续。
- 已开启 Web Bridge 后：WebBridgeSnapshot 返回的可操作元素带有稳定 elementId。点击、输入和上传时必须优先传 element_id，不能凭空猜测 CSS selector；selector 仅用于兼容旧会话。
- 调用 WebBridgeScreenshot 后，必须先分析截图内容，再继续完成用户目标；不要因工具提示“截图已附加”而结束任务。
- 截图可能包含敏感信息；只完成用户明确要求的操作，不在回复中泄露截图中的敏感内容。
- 提交、购买、删除、发布、授权或修改安全设置前，先向用户说明影响并获得确认。
- 每次工具结果返回后，判断用户目标是否完成；未完成则继续调用合适工具，或明确说明阻塞原因。

## 记忆

- 你拥有跨会话记忆能力：RecallMemory 回忆，AddMemory 记住。
- 当用户提到“之前”“上次”等回溯表述，或当前任务可能和过去做过的事情有关时，先调用 RecallMemory 回忆。
- 当对话中出现值得记住的信息（用户的工作方式、偏好、重要决定、一起解决过的问题）时，调用 AddMemory 存储。
- 自然运用记忆，不要提及“记忆系统”等内部概念；记忆未配置时工具会返回配置提示，向用户说明即可。

## 知识库

- 你拥有限域知识检索能力：SearchKnowledge 搜索，ReadKnowledgeSource 读取全文。只能检索当前会话已配置的知识范围，工具参数不能扩大范围。
- 回答中的事实性内容若来自知识库，必须以实际检索结果为依据并标注来源路径；不能只凭文档标题或记忆断言内容，检索不到就如实说明。
- 当用户的问题可能和已整理的资料、文档、笔记相关时，先检索再回答；范围未配置时提示用户去 Project 知识页或会话设置中配置。`

/** Computer Use 固定操作规则（仅当 Computer Use 工具实际可用时才注入）。 */
const COMPUTER_USE_GUIDE = `## Computer Use

- 只有当前页面没有可用的结构化元素时，才降级使用 Computer Use。
- 调用 ComputerUseScreenshot 后，必须先分析截图内容，再继续完成用户目标；不要因工具提示“截图已附加”而结束任务。
- ComputerUseScreenshot 会返回 displayId 和 coordinateScale。若根据截图像素坐标执行点击、移动、双击或拖拽，必须原样传入 display_id 与 coordinate_scale。
- 截图可能包含敏感信息；只完成用户明确要求的操作，不在回复中泄露截图中的敏感内容。
- 提交、购买、删除、发布、授权或修改安全设置前，先向用户说明影响并获得确认。`

/** Skill 上下文：供 buildAgentSystemPrompt 注入 available_skills 清单 */
export interface SkillPromptContext {
  /** 当前工作区 slug */
  workspaceSlug: string
  /** 已启用的 Skill 元信息列表 */
  skills: SkillMeta[]
}

/** 将 Skill 清单格式化为 <available_skills> 块（无 skill 时返回空字符串） */
function formatAvailableSkills(skillContext: SkillPromptContext | undefined): string {
  if (!skillContext || skillContext.skills.length === 0) return ''

  const lines = skillContext.skills
    .filter((s) => s.enabled)
    .map((s) => `- ${s.slug}: ${s.name}${s.description ? `（${s.description}）` : ''}`)

  if (lines.length === 0) return ''

  return [
    '<available_skills>',
    '以下 Skill 已在此工作区启用。使用 Skill 前必须先调用 ReadSkill 读取其 SKILL.md 全文，再按其说明执行。',
    '用户显式提到（/skill:xxx 或通过命令菜单选择）的 Skill 应优先读取并使用。',
    ...lines,
    '</available_skills>',
  ].join('\n')
}

/**
 * 构建 Agent system prompt
 *
 * 将用户传入的基础提示词与环境信息合并，保持结构稳定以提升缓存命中率。
 * skillContext 存在时注入 <available_skills> 清单。
 */
export function buildAgentSystemPrompt(
  baseSystemPrompt: string | undefined,
  cwd: string,
  skillContext?: SkillPromptContext,
): string {
  const base = baseSystemPrompt?.trim() || DEFAULT_AGENT_SYSTEM_PROMPT
  const skillsBlock = formatAvailableSkills(skillContext)
  const skillsSection = skillsBlock ? `\n\n${skillsBlock}` : ''
  const computerUseSection = computerUseToolsAvailable() ? `\n\n${COMPUTER_USE_GUIDE}` : ''
  return `${base}\n\n${WEB_AND_MEMORY_GUIDE}${computerUseSection}${skillsSection}\n\n当前工作目录：${cwd}\n你可以使用工具来完成任务。需要调用工具时，请使用函数调用格式。`
}

/**
 * Computer Use 工具是否在本机可用（非 darwin 平台或不启用时无对应工具，隐藏对应操作规则，
 * 避免 prompt 引导模型调用不存在的工具）。
 */
function computerUseToolsAvailable(): boolean {
  if (process.platform !== 'darwin') return false
  try {
    const { getSettings } = require('../settings-service') as { getSettings: () => { computerUse?: { enabled?: boolean } } }
    return getSettings().computerUse?.enabled ?? true
  } catch {
    return process.platform === 'darwin'
  }
}

/**
 * 将 RuntimeMessage 转换为 ChatMessage 格式
 *
 * 阶段 1 简化处理：
 * - user / assistant 直接转换
 * - tool 结果转换为 user 角色的文本消息，包含工具返回内容
 */
export function runtimeMessagesToChatMessages(messages: RuntimeMessage[]): ChatMessage[] {
  const result: ChatMessage[] = []

  for (const msg of messages) {
    if (msg.role === 'tool') {
      // tool 结果包装为 user 消息，让模型看到工具返回
      result.push({
        id: `${msg.createdAt}-tool`,
        role: 'user',
        content: `<tool_result tool_call_id="${msg.toolCallId}">${msg.isError ? '[错误] ' : ''}${msg.content}</tool_result>`,
        createdAt: msg.createdAt,
      })
      continue
    }

    result.push({
      id: `${msg.createdAt}-${msg.role}`,
      role: msg.role,
      content: msg.content,
      createdAt: msg.createdAt,
    })
  }

  return result
}

/**
 * 将持久化的 SDKMessage 转换为 ChatMessage 历史记录
 *
 * 阶段 2 简化处理：
 * - user / assistant 消息提取文本内容
 * - tool_use / tool_result 块序列化为 XML 标签文本
 * - 仅保留最近 MAX_HISTORY_MESSAGES 条
 */
interface TextLikeBlock {
  type: 'text'
  text: string
}

interface ToolUseLikeBlock {
  type: 'tool_use'
  id: string
  name: string
  input: Record<string, unknown>
}

interface ToolResultLikeBlock {
  type: 'tool_result'
  tool_use_id: string
  content?: unknown
  is_error?: boolean
}

function isTextBlock(block: unknown): block is TextLikeBlock {
  return typeof block === 'object' && block !== null && (block as { type: string }).type === 'text' && 'text' in block
}

function isToolUseBlock(block: unknown): block is ToolUseLikeBlock {
  return typeof block === 'object' && block !== null && (block as { type: string }).type === 'tool_use' && 'id' in block && 'name' in block
}

function isToolResultBlock(block: unknown): block is ToolResultLikeBlock {
  return typeof block === 'object' && block !== null && (block as { type: string }).type === 'tool_result' && 'tool_use_id' in block
}

function getToolResultIds(message: SDKMessage | undefined): string[] {
  if (message?.type !== 'user') return []
  const content = (message as SDKUserMessage).message?.content
  if (!Array.isArray(content)) return []
  return content.filter(isToolResultBlock).map((block) => block.tool_use_id)
}

function getToolUseIds(message: SDKMessage | undefined): Set<string> {
  if (message?.type !== 'assistant') return new Set()
  const content = (message as SDKAssistantMessage).message?.content
  if (!Array.isArray(content)) return new Set()
  return new Set(content.filter(isToolUseBlock).map((block) => block.id))
}

/** 最近消息窗口不能从 assistant tool_use 与紧随其后的 user tool_result 中间开始。 */
function selectRecentHistory(messages: SDKMessage[]): SDKMessage[] {
  let boundaryIndex = -1
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index] as SDKMessage & { subtype?: string }
    if (message.type === 'system' && message.subtype === 'compact_boundary') {
      boundaryIndex = index
      break
    }
  }

  const boundary = boundaryIndex >= 0 ? messages[boundaryIndex] : undefined
  const tail = messages.slice(boundaryIndex + 1)
  let start = Math.max(0, tail.length - MAX_HISTORY_MESSAGES)
  if (start > 0) {
    const resultIds = getToolResultIds(tail[start])
    const useIds = getToolUseIds(tail[start - 1])
    if (resultIds.some((id) => useIds.has(id))) start--
  }

  return boundary ? [boundary, ...tail.slice(start)] : tail.slice(start)
}

function compactBoundaryToChatMessage(message: SDKMessage): ChatMessage | undefined {
  if (message.type !== 'system') return undefined
  const boundary = message as SDKMessage & {
    subtype?: string
    summary?: string
    contextPacket?: unknown
    session_id?: string
  }
  if (boundary.subtype !== 'compact_boundary' || !boundary.summary?.trim()) return undefined
  const packet = boundary.contextPacket ?? { version: 1, summary: boundary.summary.trim() }
  return {
    id: `${boundary.session_id ?? ''}-compact-boundary`,
    role: 'user',
    content: `${COMPACT_CONTEXT_NOTICE}\n<context_packet>${JSON.stringify(packet)}</context_packet>`,
    createdAt: Date.now(),
  }
}

export function sdkMessagesToChatMessages(messages: SDKMessage[]): ChatMessage[] {
  const result: ChatMessage[] = []
  const pendingToolCalls = new Set<string>()

  for (const msg of selectRecentHistory(messages)) {
    const boundary = compactBoundaryToChatMessage(msg)
    if (boundary) {
      pendingToolCalls.clear()
      result.push(boundary)
      continue
    }

    if (msg.type === 'assistant') {
      const assistantMsg = msg as SDKAssistantMessage
      const content = assistantMsg.message?.content
      if (!Array.isArray(content)) continue

      pendingToolCalls.clear()
      const parts: string[] = []
      for (const block of content) {
        if (isTextBlock(block)) {
          parts.push(block.text)
        } else if (isToolUseBlock(block)) {
          pendingToolCalls.add(block.id)
          parts.push(`<tool_use id="${block.id}" name="${block.name}">${JSON.stringify(block.input)}</tool_use>`)
        }
      }

      if (parts.length > 0) {
        result.push({
          id: assistantMsg.uuid || `${assistantMsg.session_id || ''}-assistant-${Date.now()}`,
          role: 'assistant',
          content: parts.join('\n'),
          createdAt: Date.now(),
        })
      }
      continue
    }

    if (msg.type === 'user') {
      const userMsg = msg as SDKUserMessage
      const content = userMsg.message?.content
      if (!Array.isArray(content)) continue

      const parts: string[] = []
      let hasUserText = false
      for (const block of content) {
        if (isTextBlock(block)) {
          hasUserText = true
          parts.push(block.text)
        } else if (isToolResultBlock(block) && pendingToolCalls.has(block.tool_use_id)) {
          const errorPrefix = block.is_error ? '[错误] ' : ''
          const text = typeof block.content === 'string' ? block.content : JSON.stringify(block.content)
          parts.push(`<tool_result tool_use_id="${block.tool_use_id}">${errorPrefix}${text}</tool_result>`)
          pendingToolCalls.delete(block.tool_use_id)
        }
      }

      if (parts.length > 0) {
        const attachments = (userMsg as unknown as { _attachments?: FileAttachment[] })._attachments
        result.push({
          id: userMsg.uuid || `${userMsg.session_id || ''}-user-${Date.now()}`,
          role: 'user',
          content: parts.join('\n'),
          createdAt: Date.now(),
          attachments,
        })
      }
      if (hasUserText) pendingToolCalls.clear()
    }
  }

  return result
}

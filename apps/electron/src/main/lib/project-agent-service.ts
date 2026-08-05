import { getAdapter } from '@gravitas/core'
import type { ProviderType } from '@gravitas/shared'

// ===== 类型定义 =====

export interface ExtractedTask {
  title: string
  description: string
  assignee?: string
  priority: 'low' | 'medium' | 'high' | 'critical'
  dueDate?: string
}

/** 用于 createTaskDraft 的输入 */
export interface ExtractedTaskInput {
  title: string
  description: string
  assignee?: { userId: string; displayName: string }
  priority?: 'low' | 'medium' | 'high' | 'critical'
  dueDate?: number
}

/** LLM 调用器类型 */
export type LLMCaller = (prompt: string) => Promise<string>

// ===== Prompt 构建 =====

/**
 * 构建任务提取 Prompt
 *
 * 要求 LLM 从会议纪要中提取 Action Items，并返回结构化结果。
 */
export function buildTaskExtractionPrompt(meetingContent: string): string {
  return `你是项目管理助手，擅长从会议纪要中提取 Action Items（行动项）。

请仔细阅读以下会议纪要，提取所有需要执行的任务。

对于每个任务，提取以下信息：
- 任务标题（简洁，20字以内）
- 任务描述（具体要做什么）
- 负责人（如果提到）
- 优先级（high/medium/low，基于任务重要性和紧急程度判断）
- 截止日期（如果提到，格式 YYYY-MM-DD）

输出格式：

## 提取结果

1. {任务标题}
   - 描述: {任务描述}
   - 负责人: {负责人名或"未指定"}
   - 优先级: {high|medium|low}
   - 截止日期: {YYYY-MM-DD 或 "未指定"}

2. ...

如果会议纪要中没有可提取的任务，请明确回答"本次纪要没有 Action Items"。

---

会议纪要内容：

${meetingContent}

---

请提取 Action Items（如果有）：`
}

// ===== 响应解析 =====

/**
 * 解析 LLM 提取响应，转换为结构化任务列表
 *
 * 支持多种格式：
 * - 1. / 1) / 一、 编号列表
 * - Markdown 列表项
 * - 字段标签匹配（描述/负责人/优先级/截止日期）
 */
export function parseTaskExtractionResponse(rawText: string): ExtractedTask[] {
  const tasks: ExtractedTask[] = []

  // 快速检查：无任务情况
  if (
    rawText.includes('没有 Action Items') ||
    rawText.includes('无任务') ||
    rawText.includes('没有可提取') ||
    rawText.includes('无需执行') ||
    rawText.trim().length < 10
  ) {
    return tasks
  }

  // 按行分割，尝试匹配任务块
  const lines = rawText.split('\n')
  let currentTask: Partial<ExtractedTask> | null = null

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line) continue

    // 检测任务标题：数字编号 或 列表符号 开头（排除字段行）
    const titleMatch = line.match(
      /^(?:\d+[.\)、\.]\s*|[-*+]\s*(?!描述[:：]|负责人[:：]|优先级[:：]|截止日期[:：])|[一二三四五六七八九十][、\.]\s*)\s*(.+)/
    )

    if (titleMatch && titleMatch[1]) {
      // 保存上一个任务
      if (currentTask && currentTask.title) {
        tasks.push(finalizeTask(currentTask))
      }
      currentTask = { title: titleMatch[1].trim() }
      continue
    }

    // 如果不是标题行，但有当前任务，则解析字段
    if (currentTask) {
      // 描述字段
      const descMatch = line.match(/(?:描述|description|内容|说明)\s*[:：]\s*(.+)/i)
      if (descMatch && descMatch[1]) {
        currentTask.description = descMatch[1].trim()
        continue
      }

      // 负责人字段
      const assigneeMatch = line.match(/(?:负责人|assignee|执行人|责任人|负责)\s*[:：]\s*(.+)/i)
      if (assigneeMatch && assigneeMatch[1]) {
        const name = assigneeMatch[1].trim()
        if (name !== '未指定' && name !== '无') {
          currentTask.assignee = name
        }
        continue
      }

      // 优先级字段
      const priorityMatch = line.match(/(?:优先级|priority|重要程度|priority)\s*[:：]\s*(.+)/i)
      if (priorityMatch && priorityMatch[1]) {
        currentTask.priority = normalizePriority(priorityMatch[1].trim())
        continue
      }

      // 截止日期字段
      const dateMatch = line.match(
        /(?:截止日期|dueDate|deadline|截止时间|日期)\s*[:：]\s*(.+)/i
      )
      if (dateMatch && dateMatch[1]) {
        const date = dateMatch[1].trim()
        if (date !== '未指定' && date !== '无' && date !== '待定') {
          currentTask.dueDate = normalizeDate(date)
        }
        continue
      }

      // 如果没有任何字段匹配，且当前任务没有描述，把这行作为描述
      if (!currentTask.description && line.length > 5) {
        currentTask.description = line
      }
    }
  }

  // 保存最后一个任务
  if (currentTask && currentTask.title) {
    tasks.push(finalizeTask(currentTask))
  }

  return tasks
}

// ===== 内部工具函数 =====

function finalizeTask(partial: Partial<ExtractedTask>): ExtractedTask {
  return {
    title: partial.title || '未命名任务',
    description: partial.description || partial.title || '',
    assignee: partial.assignee,
    priority: partial.priority || 'medium',
    dueDate: partial.dueDate,
  }
}

function normalizePriority(raw: string): ExtractedTask['priority'] {
  const lower = raw.toLowerCase().trim()
  // critical 必须排在 high 之前，避免被降级
  if (lower.includes('critical') || lower.includes('严重') || lower.includes('阻塞')) {
    return 'critical'
  }
  if (lower.includes('high') || lower.includes('高') || lower.includes('紧急')) {
    return 'high'
  }
  if (lower.includes('low') || lower.includes('低') || lower.includes('轻微')) {
    return 'low'
  }
  return 'medium'
}

function normalizeDate(raw: string): string | undefined {
  const trimmed = raw.trim()
  // 匹配 YYYY-MM-DD 格式
  const isoMatch = trimmed.match(/(\d{4})\s*[-/年\s]\s*(\d{1,2})\s*[-/月\s]\s*(\d{1,2})/)
  if (isoMatch && isoMatch[1] && isoMatch[2] && isoMatch[3]) {
    const [, year, month, day] = isoMatch
    return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`
  }
  // 匹配 MM-DD 格式（补当前年）
  const shortMatch = trimmed.match(/(\d{1,2})\s*[-/月\s]\s*(\d{1,2})/)
  if (shortMatch && shortMatch[1] && shortMatch[2]) {
    const year = new Date().getFullYear()
    const month = shortMatch[1].padStart(2, '0')
    const day = shortMatch[2].padStart(2, '0')
    return `${year}-${month}-${day}`
  }
  return undefined
}

// ===== 端到端提取 =====

/**
 * 从会议纪要中提取任务
 *
 * @param meetingContent 会议纪要原始文本
 * @param llmCaller LLM 调用器（注入，便于测试和换模型）
 * @returns 提取的任务列表
 */
export async function extractTasksFromMeetingNote(
  meetingContent: string,
  llmCaller: LLMCaller
): Promise<ExtractedTask[]> {
  const prompt = buildTaskExtractionPrompt(meetingContent)
  const rawResponse = await llmCaller(prompt)
  return parseTaskExtractionResponse(rawResponse)
}

/**
 * 将提取结果转换为任务草稿输入
 *
 * @param extracted 提取的任务
 * @returns 可用于 createTaskDraft 的输入
 */
export function extractedTaskToDraftInput(
  extracted: ExtractedTask
): ExtractedTaskInput {
  let dueDate: number | undefined
  if (extracted.dueDate) {
    const timestamp = new Date(extracted.dueDate + 'T00:00:00').getTime()
    dueDate = Number.isNaN(timestamp) ? undefined : timestamp
  }

  return {
    title: extracted.title,
    description: extracted.description,
    assignee: extracted.assignee
      ? { userId: extracted.assignee, displayName: extracted.assignee }
      : undefined,
    priority: extracted.priority,
    dueDate,
  }
}

/**
 * 创建基于 ProviderAdapter 的 LLM 调用器（非流式）
 *
 * 复用现有的 ProviderAdapter 逻辑，发送一次性请求获取完整响应。
 * 适合后台自动处理场景（会议纪要提取等）。
 */
export function createLlmCaller(config: {
  provider: ProviderType
  baseUrl: string
  apiKey: string
  modelId: string
  maxTokens?: number
}): LLMCaller {
  return async (prompt: string): Promise<string> => {
    const adapter = getAdapter(config.provider)
    const request = adapter.buildTitleRequest({
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      modelId: config.modelId,
      prompt,
    })

    // 调整 max_tokens：标题生成默认只有 50，提取任务需要更大的空间
    const body = JSON.parse(request.body)
    body.max_tokens = config.maxTokens ?? 4096
    request.body = JSON.stringify(body)

    const response = await fetch(request.url, {
      method: 'POST',
      headers: request.headers,
      body: request.body,
    })

    if (!response.ok) {
      const text = await response.text().catch(() => 'Unknown error')
      throw new Error(`LLM 请求失败 (${response.status}): ${text}`)
    }

    const json = await response.json()
    const text = adapter.parseTitleResponse(json)
    if (text === null) {
      throw new Error('LLM 响应解析失败')
    }

    return text
  }
}

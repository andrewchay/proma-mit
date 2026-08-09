import { getAdapter } from '@gravitas/core'
import type { ProviderType } from '@gravitas/shared'

// ===== 类型定义 =====

export interface ExtractedTask {
  title: string
  description: string
  assignee?: string
  priority: 'low' | 'medium' | 'high' | 'critical'
  dueDate?: string
  /** 所属章节/分类（从文档标题层级推断），用于分组展示 */
  category?: string
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
 * 关键能力：区分“动作描述/背景说明”与“真实可执行 To-do”，只提取真正要去做的事项。
 */
export function buildTaskExtractionPrompt(meetingContent: string): string {
  return `你是项目管理助手，擅长从会议纪要或文档中提取 Action Items（行动项/To-do）。

【重要区分】
文档常常把「动作描述/背景说明/策略步骤」和「真实 To-do」混排在一起。请仔细甄别：
- 动作描述：说明“应该怎么做”“背景是什么”“分成几个环节”等，属于策略/认知，不是待办任务。例如“商品运营：定期进行产品线更新”“达人圈选逻辑优化：核心点在于…”，这些是策略描述，不要提取为任务。
- 真实 To-do：明确是“要去执行”“要建立”“要搭建”“牵头做”“跟进”的事项，通常伴有负责人（如 @某人）或"To-do/todo/待办"字样。这些才提取为任务。例如“@Andrew 搭建一个机器人来进行达人回复”。
- 若某句没有分配负责人、没有明确动作，只是“待定/后续再议/下一阶段”，不要硬提取。

【提取原则】
1. 只提取真实需要执行的任务，宁可少提而精准。
2. 任务标题要精炼：用“动作 + 对象”短句，尽量 20 字以内；不要把整段策略描述作为标题。
3. 负责人：从文本中的 @某人 或 “XX牵头/负责” 提取人名；没有则留空。
4. 章节：判断该任务所属的文档章节/板块（如"业务战略优化""推广执行优化"），用于分组。
5. 优先级：基于重要性和紧急程度判断（high/medium/low/critical）。
6. 截止日期：仅在提到时填写（YYYY-MM-DD），否则留空。

请按以下 JSON 数组格式输出（不要输出多余解释），每条任务为：

{"title": "任务标题", "description": "要做什么，具体可执行", "assignee": "负责人姓名或空", "priority": "high|medium|low|critical", "category": "所属章节", "dueDate": "YYYY-MM-DD 或空"}

如果没有任何可执行的任务，输出空数组 []。

---

会议纪要 / 文档内容：

${meetingContent}

---

请提取 Action Items：`
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

  // 优先尝试解析 JSON 数组输出（新版 Prompt 约定格式）
  const jsonTasks = parseJsonTasks(rawText)
  if (jsonTasks) {
    return jsonTasks
  }

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
  // 章节上下文：遇到纯章节标题时记录，后续任务继承
  let currentCategory: string | undefined

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line) continue

    // 字段行（描述/负责人/优先级/截止日期/章节/分类）优先拦截，避免被误判为任务标题
    const isFieldLine =
      /^(?:[-*+]|[\d一二三四五六七八九十][.\)、])\s*(?:描述|description|内容|说明|负责人|assignee|执行人|责任人|负责|优先级|priority|重要程度|截止日期|dueDate|deadline|截止时间|日期|章节|分类|category|归类|所属)\s*[:：]/.test(
        line
      )

    if (!isFieldLine) {
      // 检测任务标题：数字编号 或 列表符号 开头
      const titleMatch = line.match(
        /^(?:\d+[.\)、\.]\s*|[-*+]\s*|[一二三四五六七八九十][、\.]\s*)\s*(.+)/
      )

      if (titleMatch && titleMatch[1]) {
        // 检查是否纯章节标题（如 "业务战略优化"、"推广执行优化"），不当作任务
        const candidate = extractAssigneeAndTitle(titleMatch[1].trim(), currentCategory)
        if (candidate && candidate.isCategoryOnly) {
          currentCategory = candidate.title
          continue
        }

        // 保存上一个任务
        if (currentTask && currentTask.title) {
          tasks.push(finalizeTask(currentTask))
        }

        currentTask = candidate
          ? { title: candidate.title, assignee: candidate.assignee, category: candidate.category ?? currentCategory }
          : { title: titleMatch[1].trim(), category: currentCategory }
        continue
      }
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

      // 章节/分类字段
      const categoryMatch = line.match(/(?:章节|分类|category|归类|所属)\s*[:：]\s*(.+)/i)
      if (categoryMatch && categoryMatch[1]) {
        const cat = categoryMatch[1].trim()
        if (cat && cat !== '无' && cat !== '未指定' && cat !== '待定') {
          currentTask.category = cat
        }
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
    category: partial.category,
  }
}

/**
 * 解析 LLM 输出的 JSON 数组。成功返回任务数组，无法解析返回 undefined（交由 Markdown 路径兜底）。
 */
function parseJsonTasks(rawText: string): ExtractedTask[] | undefined {
  // 兼容 LLM 输出 ```json ... ``` 包裹
  let text = rawText.trim()
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence && fence[1]) {
    text = fence[1].trim()
  }

  // 尝试提取最外层数组
  const arrStart = text.indexOf('[')
  const arrEnd = text.lastIndexOf(']')
  let jsonStr = text
  if (arrStart !== -1 && arrEnd !== -1 && arrEnd > arrStart) {
    jsonStr = text.slice(arrStart, arrEnd + 1)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(jsonStr)
  } catch {
    return undefined
  }

  if (!Array.isArray(parsed) || parsed.length === 0) {
    // 空数组：明确代表"无任务"
    if (Array.isArray(parsed)) return []
    return undefined
  }

  const tasks: ExtractedTask[] = []
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue
    const obj = item as Record<string, unknown>
    const title = typeof obj.title === 'string' ? obj.title.trim() : ''
    if (!title) continue
    tasks.push({
      title: cleanTitle(title),
      description: typeof obj.description === 'string' ? obj.description.trim() : title,
      assignee: typeof obj.assignee === 'string' ? cleanAssignee(obj.assignee) : undefined,
      priority: normalizePriority(typeof obj.priority === 'string' ? obj.priority : 'medium'),
      dueDate: typeof obj.dueDate === 'string' && obj.dueDate ? normalizeDate(obj.dueDate) : undefined,
      category: typeof obj.category === 'string' && obj.category ? cleanCategory(obj.category) : undefined,
    })
  }
  return tasks
}

interface ParsedTitle {
  title: string
  assignee?: string
  category?: string
  /** 该标题是否为纯章节标记（非任务） */
  isCategoryOnly: boolean
}

/**
 * 从标题文本中提取负责人（@某人／XX牵头）与精炼标题。
 * 同时识别“纯章节标题”（如“业务战略优化”）——这类不作为任务。
 */
function extractAssigneeAndTitle(rawTitle: string, currentCategory?: string): ParsedTitle {
  // 去掉技巧性前缀（To-do/todo/待办/Action/item等）
  const stripped = rawTitle
    .replace(/^(?:to[- ]?do|todo|待办|action|item)\s*[:：]\s*/i, '')
    .trim()

  // 章节识别：若整行仅是一个短章节名（无动词、无编号、长度临界），视为章节
  // 启发式：不含动词性后缀、不带 @、长度<=12、结尾是 优化/建设/能力/体系 等
  if (
    !stripped.includes('@') &&
    stripped.length <= 12 &&
    /(优化|建设|能力|体系|管理|计划|战略|实施|升级|改进|执行)$/.test(stripped) &&
    !/[，。：:]/.test(stripped)
  ) {
    return { title: stripped, isCategoryOnly: true }
  }

  // 提取 @某人 负责人
  const mention = stripped.match(/@([^\s，。；;,，]{1,24})/)
  let assignee: string | undefined
  let title = stripped
  if (mention && mention[1]) {
    assignee = cleanAssignee(mention[1])
    // 从标题中移除 @某人 部分
    title = stripped.replace(/@[^\s，。；;,，]{1,24}/, '').trim()
    // 兼容 "@Andrew待定" —— 去掉尾部"待定"
    title = title.replace(/^(待定|后续|暂缓|再议)\s*$/, '').trim()
    // 若移除后只剩空，则用 assignee 纯 @ 提及作为兜底（保留语义）
    if (!title) title = assignee
  }

  return {
    title: cleanTitle(title),
    assignee,
    category: currentCategory,
    isCategoryOnly: false,
  }
}

/** 精炼目标标题：压缩连续空白、去掉多余标点、限长 */
function cleanTitle(raw: string): string {
  let t = raw.replace(/\s+/g, ' ').trim()
  t = t.replace(/[。；;，]+$/, '').trim()
  // 尾部“待定/后续/再议”标记移除
  t = t.replace(/(待定|后续|暂缓|再议)$/, '').trim()
  // 超长标题截断到合理长度，避免整段描述作标题
  if (t.length > 60) {
    t = t.slice(0, 60) + '…'
  }
  return t || raw.trim()
}

/** 清洗负责人：去掉 @ 与“牵头/负责”等尾缀，保留人名 */
function cleanAssignee(raw: string): string {
  let a = raw.replace(/^@/, '').trim()
  a = a.replace(/(牵头|负责|跟进|待定|后续|再议)$/i, '').trim()
  return a
}

/** 清洗章节名 */
function cleanCategory(raw: string): string {
  const c = raw.replace(/\s+/g, ' ').trim()
  if (c.length > 30) return c.slice(0, 30)
  return c
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

  // 章节作为描述前缀，便于分组展示（Task 暂无独立 category 字段，用前缀不破坏 schema）
  const description = extracted.category
    ? `【${extracted.category}】${extracted.description || ''}`
    : extracted.description

  return {
    title: extracted.title,
    description,
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

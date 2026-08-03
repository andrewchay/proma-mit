/**
 * 项目风险评估服务 — Project Risk Assessment Service
 *
 * 核心职责：
 * - 基于任务信息 + 会议纪要构建风险评估 Prompt
 * - 解析 LLM 响应提取风险等级和摘要
 * - 判断是否需要完成纪要（高风险任务需要）
 * - 与外部同步状态联动：外部 Todo 完成时触发风险评估
 *
 * 调用模式：
 * ```typescript
 * const result = await assessTaskRisk(taskId, llmCaller)
 * if (result.requiresCompletionNotes) {
 *   // 提示用户填写完成纪要
 * }
 * ```
 */

import { getTask, listMeetingNotes, updateTask, type Task } from './project-service'

// ===== 类型定义 =====

export interface RiskAssessmentResult {
  /** 风险等级：low / medium / high / critical */
  riskLevel: 'low' | 'medium' | 'high' | 'critical'
  /** 是否需要完成纪要 */
  requiresCompletionNotes: boolean
  /** 风险分析摘要 */
  summary: string
  /** 原始 LLM 响应文本 */
  rawResponse?: string
}

export interface LLMCaller {
  (prompt: string): Promise<string>
}

// ===== Prompt 构建 =====

/**
 * 构建风险评估 Prompt
 *
 * 输入：任务 + 关联会议纪要
 * 输出：结构化 Prompt 字符串
 */
export function buildRiskAssessmentPrompt(
  task: Task,
  meetingNotes: Array<{ title: string; rawContent: string }>
): string {
  const priorityDesc = {
    low: '低优先级',
    medium: '中优先级',
    high: '高优先级',
    critical: '关键优先级',
  }

  let prompt = `## 任务信息

**标题**: ${task.title}
**描述**: ${task.description || '无'}
**优先级**: ${priorityDesc[task.priority] || task.priority}
**状态**: ${task.status}
**负责人**: ${task.assignee?.displayName || '未分配'}
`

  if (task.dueDate) {
    prompt += `**截止日期**: ${new Date(task.dueDate).toLocaleDateString('zh-CN')}\n`
  }

  if (meetingNotes.length > 0) {
    prompt += `\n## 关联会议纪要\n\n`
    meetingNotes.forEach((note, index) => {
      prompt += `### 纪要 ${index + 1}: ${note.title}\n${note.rawContent}\n\n`
    })
  }

  prompt += `\n## 风险评估要求

请基于以上任务信息和会议纪要，进行风险评估：

1. **分析任务的业务影响和技术复杂度**
2. **参考会议纪要中的风险提示**
3. **判断是否需要完成纪要**（高风险任务需要详细记录完成过程）

请按以下格式输出：

\`\`\`
**风险等级**: [low / medium / high / critical]
**需要完成纪要**: [是 / 否]

**分析摘要**:
[简要分析，2-4 句话]
\`\`\`

风险等级说明：
- low: 常规维护，不影响其他模块
- medium: 有轻微影响，但可控
- high: 影响核心业务或关键路径
- critical: 影响系统稳定性或重大收入
`

  return prompt
}

// ===== 响应解析 =====

/**
 * 从 LLM 响应中提取风险等级和摘要
 */
export function parseRiskAssessmentResponse(rawText: string): RiskAssessmentResult {
  const text = rawText.trim()

  // 提取风险等级
  let riskLevel: RiskAssessmentResult['riskLevel'] = 'medium'

  const riskPatterns = [
    /\*\*风险等级\*\*[:\s]*([a-zA-Z\u4e00-\u9fff]+)/i,
    /风险等级[:\s]*([a-zA-Z\u4e00-\u9fff]+)/i,
    /等级[:\s]*([a-zA-Z\u4e00-\u9fff]+)/i,
  ]

  for (const pattern of riskPatterns) {
    const match = text.match(pattern)
    if (match && match[1]) {
      const raw = match[1].trim().toLowerCase()
      riskLevel = normalizeRiskLevel(raw)
      break
    }
  }

  // 如果没有明确的风险等级，尝试从内容推断
  if (riskLevel === 'medium') {
    riskLevel = inferRiskLevelFromText(text)
  }

  // 提取是否需要完成纪要
  let requiresCompletionNotes = false

  const notePatterns = [
    /\*\*需要完成纪要\*\*[:\s]*([是\u662f否\u5426yes\u662fno]+)/i,
    /需要完成纪要[:\s]*([是\u662f否\u5426yes\u662fno]+)/i,
  ]

  for (const pattern of notePatterns) {
    const match = text.match(pattern)
    if (match && match[1]) {
      const raw = match[1].trim().toLowerCase()
      requiresCompletionNotes = raw.includes('是') || raw.includes('yes') || raw.includes('true')
      break
    }
  }

  // 如果没有明确标记，基于风险等级推断
  if (!requiresCompletionNotes && (riskLevel === 'high' || riskLevel === 'critical')) {
    requiresCompletionNotes = true
  }

  // 提取摘要
  let summary = ''
  const summaryPatterns = [
    /\*\*分析摘要\*\*[:\s]*([\s\S]*?)(?=\*\*建议\*\*|\*\*|$)/i,
    /分析摘要[:\s]*([\s\S]*?)(?=建议|$)/i,
  ]

  for (const pattern of summaryPatterns) {
    const match = text.match(pattern)
    if (match && match[1]) {
      summary = match[1].trim()
      break
    }
  }

  // 如果摘要为空，提取前几句作为摘要
  if (!summary) {
    const sentences = text
      .replace(/\*\*/g, '')
      .split(/[。\n]/)
      .filter((s) => s.trim().length > 5 && !s.includes('风险等级') && !s.includes('完成纪要'))
    summary = sentences.slice(0, 2).join('。').trim() || text.slice(0, 100)
  }

  return {
    riskLevel,
    requiresCompletionNotes,
    summary,
    rawResponse: text,
  }
}

/** 归一化风险等级 */
function normalizeRiskLevel(raw: string): RiskAssessmentResult['riskLevel'] {
  const map: Record<string, RiskAssessmentResult['riskLevel']> = {
    '低': 'low',
    '中': 'medium',
    '高': 'high',
    '严重': 'critical',
    'critical': 'critical',
    'high': 'high',
    'medium': 'medium',
    'low': 'low',
  }
  return map[raw] || 'medium'
}

/** 从文本内容推断风险等级 */
function inferRiskLevelFromText(text: string): RiskAssessmentResult['riskLevel'] {
  const lowKeywords = ['简单', '常规', '无风险', '低风险', '不影响', '维护']
  const highKeywords = ['高风险', '影响收入', '核心', '关键路径', '严重', '复杂']
  const criticalKeywords = ['critical', '致命', '系统崩溃', '重大']

  const lowerText = text.toLowerCase()

  if (criticalKeywords.some((k) => lowerText.includes(k))) return 'critical'
  if (highKeywords.some((k) => lowerText.includes(k))) return 'high'
  if (lowKeywords.some((k) => lowerText.includes(k))) return 'low'

  return 'medium'
}

// ===== 完成纪要触发判断 =====

/**
 * 判断是否需要完成纪要
 *
 * 规则：高风险及以上需要完成纪要
 */
export function requiresCompletionNotes(riskLevel: RiskAssessmentResult['riskLevel']): boolean {
  return riskLevel === 'high' || riskLevel === 'critical'
}

// ===== 核心评估逻辑 =====

/**
 * 对任务进行风险评估
 *
 * @param taskId 本地任务 ID
 * @param llmCaller LLM 调用函数
 * @returns 风险评估结果
 */
export async function assessTaskRisk(
  taskId: string,
  llmCaller: LLMCaller
): Promise<RiskAssessmentResult> {
  // 1. 获取任务信息
  const task = await getTask(taskId)
  if (!task) {
    throw new Error(`任务不存在: ${taskId}`)
  }

  // 2. 获取关联会议纪要
  const allNotes = await listMeetingNotes(task.projectId)
  // 过滤出与任务相关的纪要（包含任务标题关键词或任务被提取的纪要）
  const relatedNotes = allNotes.filter(
    (note) =>
      note.rawContent.includes(task.title) ||
      note.extractedTaskIds.includes(taskId)
  )

  // 3. 构建 Prompt
  const prompt = buildRiskAssessmentPrompt(
    task,
    relatedNotes.map((n) => ({ title: n.title, rawContent: n.rawContent }))
  )

  // 4. 调用 LLM
  let rawResponse: string
  try {
    rawResponse = await llmCaller(prompt)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`风险评估 LLM 调用失败: ${message}`)
  }

  // 5. 解析响应
  const result = parseRiskAssessmentResponse(rawResponse)
  result.rawResponse = rawResponse

  return result
}

// ===== 与外部同步联动 =====

/**
 * 当检测到外部 Todo 被完成时，触发风险评估
 *
 * @param taskId 本地任务 ID
 * @param llmCaller LLM 调用函数
 * @returns 风险评估结果 + 是否更新成功
 */
export async function handleExternalTaskCompleted(
  taskId: string,
  llmCaller: LLMCaller
): Promise<{ result: RiskAssessmentResult; taskUpdated: boolean }> {
  const result = await assessTaskRisk(taskId, llmCaller)

  // 更新任务的风险等级
  const task = await getTask(taskId)
  if (task) {
    await updateTask(taskId, {
      riskLevel: result.riskLevel,
      // 如果需要完成纪要，状态不自动改为 completed，等待用户确认
      status: result.requiresCompletionNotes ? task.status : 'completed',
    })
  }

  return {
    result,
    taskUpdated: !!task,
  }
}

// ===== 完成纪要存储 =====

/**
 * 保存任务完成纪要
 *
 * @param taskId 任务 ID
 * @param notes 完成纪要文本
 * @returns 更新后的任务
 */
export async function saveCompletionNotes(taskId: string, notes: string): Promise<Task | null> {
  const task = await getTask(taskId)
  if (!task) return null

  return updateTask(taskId, {
    completionNotes: notes,
    status: 'completed',
  })
}

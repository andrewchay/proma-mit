/**
 * 项目级风险报告服务 — Project Risk Report Service
 *
 * 核心职责：
 * - 基于项目所有任务、会议纪要、外部同步状态生成综合风险报告
 * - 返回结构化的项目风险分析文字
 * - 识别高风险任务、进度延迟、完成纪要不足等风险
 *
 * 调用模式：
 * ```typescript
 * const report = await generateProjectRiskReport(projectId, llmCaller)
 * console.log(report.summary) // 项目风险摘要
 * ```
 */

import { getProject, listTasks, listMeetingNotes, type Project } from './project-service'

// ===== 类型定义 =====

export interface ProjectRiskReport {
  /** 整体风险等级：low / medium / high / critical */
  overallRiskLevel: 'low' | 'medium' | 'high' | 'critical'
  /** 风险摘要（1-3 句） */
  summary: string
  /** 高风险任务列表（文本描述） */
  highRiskTasks: string[]
  /** 建议措施列表 */
  suggestions: string[]
  /** 整体进度描述 */
  progress: string
  /** 原始 LLM 响应文本 */
  rawResponse?: string
}

export interface LLMCaller {
  (prompt: string): Promise<string>
}

interface TaskSummary {
  id: string
  title: string
  description: string
  status: string
  priority: string
  riskLevel?: string
  completionNotes?: string
}

interface NoteSummary {
  title: string
  rawContent: string
}

// ===== Prompt 构建 =====

/**
 * 构建项目风险报告 Prompt
 */
export function buildProjectRiskReportPrompt(
  project: Project,
  tasks: TaskSummary[],
  notes: NoteSummary[]
): string {
  const totalTasks = tasks.length
  const completedTasks = tasks.filter((t) => t.status === 'completed').length
  const inProgressTasks = tasks.filter((t) => t.status === 'in_progress').length
  const pendingTasks = tasks.filter((t) => t.status === 'pending').length
  const highRiskTasks = tasks.filter((t) => t.riskLevel === 'high' || t.riskLevel === 'critical')
  const tasksWithoutCompletionNotes = tasks.filter(
    (t) => t.riskLevel === 'high' || t.riskLevel === 'critical'
  ).filter((t) => !t.completionNotes)

  let prompt = `## 项目信息

**项目名称**: ${project.title}
**项目描述**: ${project.description || '无'}

**任务统计**:
- 总任务数: ${totalTasks}
- 已完成: ${completedTasks}
- 进行中: ${inProgressTasks}
- 待处理: ${pendingTasks}
`

  if (highRiskTasks.length > 0) {
    prompt += `\n**高风险任务** (${highRiskTasks.length}):\n`
    highRiskTasks.forEach((t) => {
      prompt += `- ${t.title} (${t.riskLevel}, ${t.status})\n`
    })
  }

  if (tasksWithoutCompletionNotes.length > 0) {
    prompt += `\n**未完成纪要的高风险任务** (${tasksWithoutCompletionNotes.length}):\n`
    tasksWithoutCompletionNotes.forEach((t) => {
      prompt += `- ${t.title}\n`
    })
  }

  if (tasks.length > 0) {
    prompt += `\n**任务列表**:\n`
    tasks.forEach((t) => {
      prompt += `- ${t.title} [${t.priority} / ${t.status}]
    ${t.description || ''}
    ${t.riskLevel ? `风险: ${t.riskLevel}` : ''}
    ${t.completionNotes ? '已填写完成纪要' : ''}
    \n`
    })
  } else {
    prompt += `\n**任务列表**: 暂无任务\n`
  }

  if (notes.length > 0) {
    prompt += `\n**关联会议纪要**:\n\n`
    notes.forEach((note, index) => {
      prompt += `### 纪要 ${index + 1}: ${note.title}\n${note.rawContent}\n\n`
    })
  }

  prompt += `\n## 风险报告要求

请基于以上项目信息、任务列表和会议纪要，生成一份项目风险报告：

1. **分析整体风险等级**：基于任务风险、进度、外部同步状态综合判断
2. **识别高风险任务**：特别关注未填写完成纪要的高风险任务
3. **评估进度**：基于已完成/进行中/待处理任务数
4. **提出建议措施**：针对发现的风险给出具体建议

请按以下格式输出：

\`\`\`
**整体风险等级**: [low / medium / high / critical]
**风险摘要**: [1-3 句话，概述项目整体风险]

**高风险任务**:
1. [任务名]（风险等级）— [简要说明]

**建议措施**:
1. [具体建议]

**整体进度**: [百分比，如 50%（1/2 任务已完成）]
\`\`\`

风险等级说明：
- low: 所有任务风险可控，进度正常
- medium: 有少量高风险任务或轻微进度延迟
- high: 多个高风险任务或关键路径受阻
- critical: 核心功能未开始或严重进度延迟
`

  return prompt
}

// ===== 响应解析 =====

/**
 * 从 LLM 响应中提取项目风险报告
 */
export function parseProjectRiskReport(rawText: string): ProjectRiskReport {
  const text = rawText.trim()

  // 提取整体风险等级
  let overallRiskLevel: ProjectRiskReport['overallRiskLevel'] = 'low'
  const riskPatterns = [
    /\*\*整体风险等级\*\*[:\s]*([a-zA-Z\u4e00-\u9fff]+)/i,
    /整体风险等级[:\s]*([a-zA-Z\u4e00-\u9fff]+)/i,
  ]
  for (const pattern of riskPatterns) {
    const match = text.match(pattern)
    if (match && match[1]) {
      const raw = match[1].trim().toLowerCase()
      overallRiskLevel = normalizeRiskLevel(raw)
      break
    }
  }
  if (overallRiskLevel === 'low') {
    overallRiskLevel = inferRiskLevelFromText(text)
  }

  // 提取摘要
  let summary = ''
  const summaryPatterns = [
    /\*\*风险摘要\*\*[:\s]*([\s\S]*?)(?=\*\*高风险任务\*\*|\*\*建议措施\*\*|\*\*|$)/i,
    /风险摘要[:\s]*([\s\S]*?)(?=高风险任务|建议措施|$)/i,
  ]
  for (const pattern of summaryPatterns) {
    const match = text.match(pattern)
    if (match && match[1]) {
      summary = match[1].trim()
      break
    }
  }
  if (!summary) {
    const sentences = text
      .replace(/\*\*/g, '')
      .split(/[。\n]/)
      .filter((s) => s.trim().length > 5 && !s.includes('风险等级') && !s.includes('整体进度'))
    summary = sentences.slice(0, 2).join('。').trim() || text.slice(0, 100)
  }

  // 提取高风险任务
  const highRiskTasks: string[] = []
  const taskPatterns = [
    /\*\*高风险任务\*\*[:\s]*([\s\S]*?)(?=\*\*建议措施\*\*|\*\*|$)/i,
    /高风险任务[:\s]*([\s\S]*?)(?=建议措施|建议|$)/i,
  ]
  for (const pattern of taskPatterns) {
    const match = text.match(pattern)
    if (match && match[1]) {
      const taskSection = match[1].trim()
      if (taskSection && !taskSection.includes('无')) {
        const lines = taskSection.split('\n').filter((l) => l.trim().match(/^\d+\./))
        highRiskTasks.push(...lines.map((l) => l.replace(/^\d+\.\s*/, '').trim()))
      }
      break
    }
  }

  // 提取建议措施
  const suggestions: string[] = []
  const suggestionPatterns = [
    /\*\*建议措施\*\*[:\s]*([\s\S]*?)(?=\*\*整体进度\*\*|\*\*|$)/i,
    /建议措施[:\s]*([\s\S]*?)(?=整体进度|进度|$)/i,
  ]
  for (const pattern of suggestionPatterns) {
    const match = text.match(pattern)
    if (match && match[1]) {
      const suggestionSection = match[1].trim()
      const lines = suggestionSection.split('\n').filter((l) => l.trim().match(/^\d+\./))
      suggestions.push(...lines.map((l) => l.replace(/^\d+\.\s*/, '').trim()))
      break
    }
  }

  // 提取进度
  let progress = ''
  const progressPatterns = [
    /\*\*整体进度\*\*[:\s]*([\s\S]*?)$/im,
    /整体进度[:\s]*([\s\S]*?)$/im,
  ]
  for (const pattern of progressPatterns) {
    const match = text.match(pattern)
    if (match && match[1]) {
      progress = match[1].trim()
      break
    }
  }
  if (!progress) {
    progress = '进度信息未明确'
  }

  return {
    overallRiskLevel,
    summary,
    highRiskTasks,
    suggestions,
    progress,
    rawResponse: text,
  }
}

/** 归一化风险等级 */
function normalizeRiskLevel(raw: string): ProjectRiskReport['overallRiskLevel'] {
  const map: Record<string, ProjectRiskReport['overallRiskLevel']> = {
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
function inferRiskLevelFromText(text: string): ProjectRiskReport['overallRiskLevel'] {
  const lowerText = text.toLowerCase()
  // 先检查低风险，因为 high/critical 可能出现在任务描述中
  if (lowerText.includes('low') || lowerText.includes('低风险') || lowerText.includes('可控') || lowerText.includes('正常') || lowerText.includes('顺利') || lowerText.includes('无风险')) return 'low'
  if (lowerText.includes('critical') || lowerText.includes('致命') || lowerText.includes('核心功能未开始')) return 'critical'
  if (lowerText.includes('high') || lowerText.includes('高风险') || lowerText.includes('严重') || lowerText.includes('关键')) return 'high'
  return 'medium'
}

// ===== 核心报告逻辑 =====

/**
 * 生成项目风险报告
 *
 * @param projectId 项目 ID
 * @param llmCaller LLM 调用函数
 * @returns 项目风险报告
 */
export async function generateProjectRiskReport(
  projectId: string,
  llmCaller: LLMCaller
): Promise<ProjectRiskReport> {
  // 1. 获取项目信息
  const project = await getProject(projectId)
  if (!project) {
    throw new Error(`项目不存在: ${projectId}`)
  }

  // 2. 获取所有任务
  const tasks = await listTasks(projectId)
  const taskSummaries: TaskSummary[] = tasks.map((t) => ({
    id: t.id,
    title: t.title,
    description: t.description,
    status: t.status,
    priority: t.priority,
    riskLevel: t.riskLevel,
    completionNotes: t.completionNotes,
  }))

  // 3. 获取所有会议纪要
  const notes = await listMeetingNotes(projectId)
  const noteSummaries: NoteSummary[] = notes.map((n) => ({
    title: n.title,
    rawContent: n.rawContent,
  }))

  // 4. 构建 Prompt
  const prompt = buildProjectRiskReportPrompt(project, taskSummaries, noteSummaries)

  // 5. 调用 LLM
  let rawResponse: string
  try {
    rawResponse = await llmCaller(prompt)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`项目风险报告 LLM 调用失败: ${message}`)
  }

  // 6. 解析响应
  const report = parseProjectRiskReport(rawResponse)
  report.rawResponse = rawResponse

  return report
}

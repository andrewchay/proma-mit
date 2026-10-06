/**
 * 学术助手服务 —— 论文项目持久化与五阶段 pipeline 编排
 *
 * 这是 **Pro 插件能力**（com.gravitas.academic）。本服务只负责：
 * - 论文项目 CRUD 与本地持久化（~/.gravitas/academic/）
 * - 五阶段状态机推进与回退
 * - 调用 @gravitas/core 的纯算法产出完整性 / 评审 / 修订报告
 *
 * 权限判定不在这里做：工具注入由 academic-plugin.ts 按订阅权益过滤，
 * 渲染层入口由 selectCanUseCapability 控制。本服务被直接调用时不额外
 * 校验权益，与 knowledge-service / analysis-service 保持一致的分层。
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type {
  AcademicAdvanceResult,
  AcademicPaper,
  AcademicPaperSummary,
  AcademicStage,
  AcademicStageRecord,
  IntegrityReport,
  PeerReviewReport,
  RevisionTracking,
} from '@gravitas/shared'
import {
  checkPaperIntegrity,
  simulatePeerReview,
  createRevisionTracker,
  type PaperContent,
  type ReviewCommentInput,
} from '@gravitas/core/services/academic'
import {
  getAcademicArtifactsDir,
  getAcademicPapersPath,
} from './config-paths'

// ===== 阶段定义 =====

/**
 * 五阶段 pipeline 顺序。
 *
 * integrity 位于 write 之后、review 之前，且**不能跳过**：
 * 未通过完整性检查的稿件不得进入评审阶段。
 */
const STAGE_ORDER: AcademicStage[] = ['research', 'write', 'integrity', 'review', 'revise', 'finalize']

/** 允许跳过的阶段（integrity 与 finalize 不可跳过） */
const SKIPPABLE_STAGES: AcademicStage[] = ['research', 'write', 'review', 'revise']

/** 各阶段的中文显示名 */
export const STAGE_LABELS: Record<AcademicStage, string> = {
  research: '选题研究',
  write: '论文撰写',
  integrity: '完整性检查',
  review: '同行评审',
  revise: '修改追踪',
  finalize: '发表准备',
}

// ===== 持久化 =====

interface PapersFile {
  papers: AcademicPaper[]
}

/** 论文索引损坏时抛出，避免把用户已有研究当成空库覆盖 */
export class AcademicDataCorruptionError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'AcademicDataCorruptionError'
  }
}

/** 读取论文索引；文件缺失返回空列表，损坏时保留原件并拒绝读写 */
function readPapersFile(): PapersFile {
  const path = getAcademicPapersPath()
  if (!existsSync(path)) return { papers: [] }
  let raw: string
  try {
    raw = readFileSync(path, 'utf-8')
  } catch (err) {
    throw new AcademicDataCorruptionError(`论文索引无法读取: ${path}`, { cause: err })
  }
  try {
    const parsed = JSON.parse(raw) as PapersFile
    if (!Array.isArray(parsed.papers)) {
      throw new Error('papers 字段不是数组')
    }
    return parsed
  } catch (err) {
    // 不覆盖原文件：损坏副本交由用户修复，读写路径全部拒绝。
    console.error('[学术助手] 论文索引损坏，拒绝读写以保护原文件:', err)
    throw new AcademicDataCorruptionError(
      `论文索引损坏，已保留原文件：${path}。请修复或备份后重试。`,
      { cause: err },
    )
  }
}

function writePapersFile(data: PapersFile): void {
  writeFileSync(getAcademicPapersPath(), JSON.stringify(data, null, 2), 'utf-8')
}

/**
 * 产出物文件名：{paperId}-{kind}-{reportId}.json。
 *
 * 旧版 {paperId}-{kind}.json 会互相覆盖，历史报告一旦丢失就无法
 * 对比不同稿件版本的检查结论；这里改为每次检查写入新报告文件，
 * 读取时返回最新一份，兼容旧文件。
 */
function artifactPath(paperId: string, kind: 'integrity' | 'peer-review' | 'revision'): string {
  return join(getAcademicArtifactsDir(), `${paperId}-${kind}.json`)
}

function artifactHistoryPath(paperId: string, kind: string, reportId: string): string {
  return join(getAcademicArtifactsDir(), `${paperId}-${kind}-${reportId}.json`)
}

function writeArtifact(paperId: string, kind: 'integrity' | 'peer-review' | 'revision', data: unknown): void {
  writeFileSync(artifactPath(paperId, kind), JSON.stringify(data, null, 2), 'utf-8')

  // 版本化副本：报告对象本身带 id（若没有则生成），供历史对比。
  const withId = (typeof data === 'object' && data !== null ? data : {}) as { id?: string }
  const reportId = typeof withId.id === 'string' && withId.id.trim()
    ? withId.id
    : `${Date.now()}-${randomUUID().slice(0, 8)}`
  const stamped = withId.id ? data : { ...(withId as Record<string, unknown>), id: reportId }
  writeFileSync(
    artifactHistoryPath(paperId, kind, reportId),
    JSON.stringify(stamped, null, 2),
    'utf-8',
  )
}

function readArtifact<T>(paperId: string, kind: 'integrity' | 'peer-review' | 'revision'): T | null {
  const path = artifactPath(paperId, kind)
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as T
  } catch (err) {
    console.error(`[学术助手] ${kind} 产出物解析失败:`, err)
    return null
  }
}

/** 初始化一个论文项目的阶段记录 */
function initialStages(): AcademicStageRecord[] {
  return STAGE_ORDER.map((stage) => ({
    stage,
    status: 'pending' as const,
    artifactRefs: [],
  }))
}

function findPaper(papers: AcademicPaper[], id: string): AcademicPaper {
  const paper = papers.find((p) => p.id === id)
  if (!paper) throw new Error(`论文不存在: ${id}`)
  return paper
}

// ===== 论文项目 CRUD =====

export function listPapers(): AcademicPaperSummary[] {
  return readPapersFile().papers.map((paper) => {
    const completed = paper.stages.filter((s) => s.status === 'completed' || s.status === 'skipped').length
    return {
      id: paper.id,
      title: paper.title,
      field: paper.field,
      currentStage: paper.currentStage,
      revisionRound: paper.revisionRound,
      stageProgress: { completed, total: STAGE_ORDER.length },
      updatedAt: paper.updatedAt,
    }
  })
}

export function getPaper(id: string): AcademicPaper | null {
  return readPapersFile().papers.find((p) => p.id === id) ?? null
}

export interface CreatePaperInput {
  title: string
  abstract?: string
  field?: string
  content?: string
  keywords?: string[]
  targetJournal?: string
}

export function createPaper(input: CreatePaperInput): AcademicPaper {
  const title = input.title?.trim()
  if (!title) throw new Error('论文标题不能为空')

  const now = new Date().toISOString()
  const paper: AcademicPaper = {
    id: randomUUID(),
    title,
    abstract: input.abstract,
    field: input.field,
    content: input.content ?? '',
    keywords: Array.isArray(input.keywords) ? input.keywords : [],
    targetJournal: input.targetJournal,
    stages: initialStages(),
    currentStage: 'research',
    revisionRound: 0,
    createdAt: now,
    updatedAt: now,
  }

  const data = readPapersFile()
  data.papers.push(paper)
  writePapersFile(data)
  return paper
}

export interface UpdatePaperInput {
  title?: string
  abstract?: string
  field?: string
  content?: string
  keywords?: string[]
  targetJournal?: string
}

export function updatePaper(id: string, input: UpdatePaperInput): AcademicPaper {
  const data = readPapersFile()
  const paper = findPaper(data.papers, id)

  if (input.title !== undefined) {
    const title = input.title.trim()
    if (!title) throw new Error('论文标题不能为空')
    paper.title = title
  }
  if (input.abstract !== undefined) paper.abstract = input.abstract
  if (input.field !== undefined) paper.field = input.field
  if (input.content !== undefined) paper.content = input.content
  if (input.keywords !== undefined) paper.keywords = input.keywords
  if (input.targetJournal !== undefined) paper.targetJournal = input.targetJournal
  paper.updatedAt = new Date().toISOString()

  writePapersFile(data)
  return paper
}

export function deletePaper(id: string): boolean {
  const data = readPapersFile()
  const before = data.papers.length
  data.papers = data.papers.filter((p) => p.id !== id)
  if (data.papers.length === before) return false
  writePapersFile(data)
  return true
}

// ===== Pipeline 推进 =====

/**
 * 识别 Markdown 标题对应的章节类型。
 *
 * Reviewer 按 method 等类型查找章节；旧版把整篇标成 body 会让
 * 完整的论文被误判缺章。这里做保守映射：识别不了的标题回退 body。
 */
function sectionTypeOfHeading(heading: string): string {
  const h = heading.toLowerCase()
  if (/introduction|引言|绪论|背景/.test(h)) return 'introduction'
  if (/method|methods|materials|研究方法|方法|实验设计|数据与方法/.test(h)) return 'method'
  if (/result|findings|结果|研究发现/.test(h)) return 'results'
  if (/discussion|讨论/.test(h)) return 'discussion'
  if (/conclusion|结论/.test(h)) return 'conclusion'
  if (/abstract|摘要/.test(h)) return 'abstract'
  if (/reference|参考文献|书目/.test(h)) return 'references'
  return 'body'
}

/**
 * 把论文正文解析成算法层可识别的章节列表。
 *
 * 识别 Markdown 标题（#/##/###）为章节边界，标题前内容归入 body。
 * 无任何标题时退回旧行为：整体作为 body。
 */
export function parsePaperSections(content: string): Array<{ type: string; content: string }> {
  if (!content.trim()) return []

  const lines = content.split(/\r?\n/)
  const sections: Array<{ type: string; content: string }> = []
  let currentType = 'body'
  let buffer: string[] = []

  const flush = () => {
    const text = buffer.join('\n').trim()
    if (text) sections.push({ type: currentType, content: text })
    buffer = []
  }

  for (const line of lines) {
    const heading = line.match(/^#{1,3}\s+(\S.*)$/)
    if (heading) {
      flush()
      currentType = sectionTypeOfHeading(heading[1]!)
    } else {
      buffer.push(line)
    }
  }
  flush()

  return sections
}

/** 把论文内容适配成学术算法需要的 PaperContent 结构 */
function toPaperContent(paper: AcademicPaper): PaperContent {
  return {
    title: paper.title,
    abstract: paper.abstract ?? '',
    sections: parsePaperSections(paper.content),
    wordCount: paper.content.length,
    field: paper.field,
  }
}

function nextStageOf(current: AcademicStage): AcademicStage | null {
  const idx = STAGE_ORDER.indexOf(current)
  if (idx < 0 || idx >= STAGE_ORDER.length - 1) return null
  return STAGE_ORDER[idx + 1] ?? null
}

/**
 * 推进论文到下一阶段。
 *
 * integrity 阶段的特殊规则：
 * - 检查未通过（isSubmittable=false）时，当前阶段标记为 blocked，
 *   不推进到 review，并在返回值中给出 blockedReason。
 *
 * 因为完整性检查器是异步的（引用验证需要访问外部引用数据库），
 * 本函数同样为 async。
 */
export async function advanceStage(id: string): Promise<AcademicAdvanceResult> {
  const data = readPapersFile()
  const paper = findPaper(data.papers, id)
  const current = paper.currentStage
  const next = nextStageOf(current)
  const now = Date.now()
  const currentRecord = paper.stages.find((s) => s.stage === current)

  if (!next) {
    // finalize 是最后一个阶段：推进表示显式完成交付，而不是抛错。
    if (currentRecord) {
      currentRecord.status = 'completed'
      currentRecord.completedAt = now
      delete currentRecord.blockedReason
      paper.updatedAt = new Date().toISOString()
      writePapersFile(data)
      return {
        paper,
        executedStage: current,
        summary: `发表准备阶段已完成，论文「${paper.title}」交付就绪（如需投稿请另行授权）。`,
      }
    }
    throw new Error(`阶段记录异常：找不到「${STAGE_LABELS[current]}」的阶段记录`)
  }

  if (currentRecord && currentRecord.status === 'pending') {
    currentRecord.status = 'in_progress'
    currentRecord.startedAt = currentRecord.startedAt ?? now
  }

  let summary = ''
  let blockedReason: string | undefined

  // 执行当前阶段的计算工作
  if (current === 'integrity') {
    const report = await checkPaperIntegrity({ paperId: paper.id, text: paper.content })
    writeArtifact(paper.id, 'integrity', report)
    if (currentRecord) {
      currentRecord.artifactRefs = [
        ...new Set([...currentRecord.artifactRefs, `integrity:${paper.id}`]),
      ]
    }
    summary = `完整性检查完成：总体评分 ${report.overallScore}，引用问题 ${report.citations.length} 项，数据问题 ${report.dataIssues.length} 项，逻辑缺口 ${report.logicGaps.length} 项。`
    if (!report.isSubmittable) {
      blockedReason = '完整性检查未通过，稿件不满足投稿条件，请先修复引用、数据与逻辑问题。'
    }
  } else if (current === 'review') {
    const report = simulatePeerReview(toPaperContent(paper))
    writeArtifact(paper.id, 'peer-review', report)
    if (currentRecord) {
      currentRecord.artifactRefs = [
        ...new Set([...currentRecord.artifactRefs, `peer-review:${paper.id}`]),
      ]
    }
    summary = `同行评审模拟完成：总体评分 ${report.overallScore}，决定 ${report.decision}，评审意见 ${report.comments.length} 条。`
    if (report.decision === 'reject') {
      blockedReason = '评审结论为拒稿，建议修订后重新提交评审。'
    }
  } else if (current === 'revise') {
    const reviewReport = readArtifact<PeerReviewReport>(paper.id, 'peer-review')
    // 把评审意见登记进修订追踪器，供后续逐条处理
    const inputComments: ReviewCommentInput[] = (reviewReport?.comments ?? []).map((c) => ({
      id: c.id,
      reviewerName: c.reviewerName,
      content: c.content,
      suggestion: c.suggestion,
      severity: c.severity,
      category: c.category,
      targetSection: c.section,
    }))
    const tracker = createRevisionTracker(paper.id, inputComments, paper.revisionRound + 1)
    const tracking = tracker.getTracking()
    writeArtifact(paper.id, 'revision', tracking)
    if (currentRecord) {
      currentRecord.artifactRefs = [
        ...new Set([...currentRecord.artifactRefs, `revision:${paper.id}`]),
      ]
    }
    paper.revisionRound += 1
    summary = `已启动第 ${paper.revisionRound} 轮修订，待处理意见 ${tracking.progress.total} 条。`
  } else if (current === 'research') {
    summary = '选题研究阶段已完成，可以进入论文撰写。'
  } else if (current === 'write') {
    if (!paper.content.trim()) {
      blockedReason = '论文正文为空，请先撰写内容再进入完整性检查。'
    } else {
      summary = `论文撰写阶段已完成，正文 ${paper.content.length} 字，准备进入完整性检查。`
    }
  } else if (current === 'finalize') {
    summary = '发表准备阶段已完成。'
  }

  if (blockedReason) {
    if (currentRecord) {
      currentRecord.status = 'blocked'
      currentRecord.blockedReason = blockedReason
    }
    paper.updatedAt = new Date().toISOString()
    writePapersFile(data)
    return { paper, executedStage: current, summary, blockedReason }
  }

  // 当前阶段完成，推进指针
  if (currentRecord) {
    currentRecord.status = 'completed'
    currentRecord.completedAt = now
    delete currentRecord.blockedReason
  }

  const nextRecord = paper.stages.find((s) => s.stage === next)
  if (nextRecord) {
    nextRecord.status = 'pending'
  }
  paper.currentStage = next
  paper.updatedAt = new Date().toISOString()
  writePapersFile(data)

  return { paper, executedStage: current, summary }
}

/**
 * 回退到指定阶段。
 *
 * 只允许回退到已有记录且顺序在当前的阶段；回退时清空中间阶段的
 * 完成状态，避免留下「未来阶段已完成」的假象。已完成阶段的产出物
 * 保留在 artifacts 目录，便于对比历史。
 */
export function rewindStage(id: string, target: AcademicStage): AcademicPaper {
  const data = readPapersFile()
  const paper = findPaper(data.papers, id)

  const currentIdx = STAGE_ORDER.indexOf(paper.currentStage)
  const targetIdx = STAGE_ORDER.indexOf(target)
  if (targetIdx < 0) throw new Error(`未知阶段: ${target}`)
  if (targetIdx >= currentIdx) throw new Error('只能回退到当前阶段之前的阶段')

  for (const record of paper.stages) {
    const idx = STAGE_ORDER.indexOf(record.stage)
    if (idx > targetIdx) {
      record.status = 'pending'
      record.startedAt = undefined
      record.completedAt = undefined
      record.blockedReason = undefined
    } else if (idx === targetIdx) {
      record.status = 'in_progress'
      record.completedAt = undefined
      record.blockedReason = undefined
    }
  }

  paper.currentStage = target
  paper.updatedAt = new Date().toISOString()
  writePapersFile(data)
  return paper
}

/**
 * 保存工具生成的完整性报告。
 *
 * 旧版工具生成报告后只“读取”不写入，导致报告从未落盘。
 * 现在由服务层统一写入当前文件与版本化副本，并登记到阶段引用。
 */
export function recordIntegrityReport(
  paperId: string,
  report: IntegrityReport & { id?: string },
): IntegrityReport & { id?: string } {
  // 先确认论文存在，防止对不存在项目写入孤立文件
  const data = readPapersFile()
  const paper = findPaper(data.papers, paperId)
  writeArtifact(paperId, 'integrity', report)
  const record = paper.stages.find((s) => s.stage === 'integrity')
  if (record) {
    const ref = `integrity:${report.id ?? paperId}`
    record.artifactRefs = [...new Set([...record.artifactRefs, ref])]
  }
  paper.updatedAt = new Date().toISOString()
  writePapersFile(data)
  return report
}

// ===== 阶段产出物读取 =====

export function getIntegrityReport(paperId: string): IntegrityReport | null {
  return readArtifact<IntegrityReport>(paperId, 'integrity')
}

export function getPeerReviewReport(paperId: string): PeerReviewReport | null {
  return readArtifact<PeerReviewReport>(paperId, 'peer-review')
}

export function getRevisionTracking(paperId: string): RevisionTracking | null {
  return readArtifact<RevisionTracking>(paperId, 'revision')
}

export { STAGE_ORDER, SKIPPABLE_STAGES }

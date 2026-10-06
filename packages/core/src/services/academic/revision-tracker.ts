/**
 * 修改追踪服务 — Stage 4 审稿意见管理与逐点回复
 *
 * 功能：
 * - 导入/解析审稿意见
 * - 分类整理（按严重程度/类别/状态）
 * - 逐点回复草稿生成
 * - 修改状态追踪（pending → in_progress → resolved）
 * - 进度统计
 */

import type {
  ReviewerCommentRecord,
  RevisionTracking,
  ResponseToReviewersDraft,
  CommentStatus,
} from '@gravitas/shared'

/** 审稿意见输入 */
export interface ReviewCommentInput {
  id?: string
  reviewerName: string
  content: string
  suggestion?: string
  severity: 'major' | 'minor' | 'suggestion'
  category?: string
  targetSection?: string
}

/** 回复生成配置 */
export interface ResponseDraftConfig {
  /** 回复语气：正式/友好/简洁 */
  tone: 'formal' | 'friendly' | 'concise'
  /** 是否包含修改摘要 */
  includeChangeSummary: boolean
  /** 是否感谢所有意见 */
  includeThanks: boolean
}

const DEFAULT_RESPONSE_CONFIG: ResponseDraftConfig = {
  tone: 'formal',
  includeChangeSummary: true,
  includeThanks: true,
}

// ============================================
// 修改追踪服务
// ============================================

export class RevisionTracker {
  private comments: ReviewerCommentRecord[] = []
  private paperId: string
  private round: number

  constructor(paperId: string, round = 1) {
    this.paperId = paperId
    this.round = round
  }

  /**
   * 导入审稿意见
   */
  importComments(inputs: ReviewCommentInput[]): ReviewerCommentRecord[] {
    const records: ReviewerCommentRecord[] = inputs.map((input) => ({
      id: input.id ?? `comment-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
      reviewerName: input.reviewerName,
      content: input.content,
      suggestion: input.suggestion ?? '',
      severity: input.severity,
      category: input.category ?? 'general',
      status: 'pending',
      targetSection: input.targetSection,
      recordedAt: Date.now(),
    }))

    this.comments.push(...records)
    return records
  }

  /**
   * 更新意见状态
   */
  updateStatus(commentId: string, status: CommentStatus, response?: string): boolean {
    const comment = this.comments.find((c) => c.id === commentId)
    if (!comment) return false

    comment.status = status
    if (response !== undefined) {
      comment.response = response
    }
    if (status === 'resolved') {
      comment.resolvedAt = Date.now()
    }

    return true
  }

  /**
   * 添加修改快照（diff）
   */
  addDiffSnapshot(commentId: string, diffSnapshot: string): boolean {
    const comment = this.comments.find((c) => c.id === commentId)
    if (!comment) return false

    comment.diffSnapshot = diffSnapshot
    return true
  }

  /**
   * 获取修改追踪报告
   */
  getTracking(): RevisionTracking {
    const total = this.comments.length
    const resolved = this.comments.filter((c) => c.status === 'resolved').length
    const inProgress = this.comments.filter((c) => c.status === 'in_progress').length
    const pending = this.comments.filter((c) => c.status === 'pending').length

    return {
      paperId: this.paperId,
      round: this.round,
      comments: this.comments,
      progress: {
        total,
        resolved,
        inProgress,
        pending,
      },
      updatedAt: Date.now(),
    }
  }

  /**
   * 按状态筛选意见
   */
  getCommentsByStatus(status: CommentStatus): ReviewerCommentRecord[] {
    return this.comments.filter((c) => c.status === status)
  }

  /**
   * 按严重程度筛选
   */
  getCommentsBySeverity(severity: 'major' | 'minor' | 'suggestion'): ReviewerCommentRecord[] {
    return this.comments.filter((c) => c.severity === severity)
  }

  /**
   * 按评审人筛选
   */
  getCommentsByReviewer(reviewerName: string): ReviewerCommentRecord[] {
    return this.comments.filter((c) => c.reviewerName === reviewerName)
  }

  /**
   * 按目标章节筛选
   */
  getCommentsBySection(section: string): ReviewerCommentRecord[] {
    return this.comments.filter((c) => c.targetSection === section)
  }

  /**
   * 获取优先级排序的意见列表（major → minor → suggestion）
   */
  getPrioritizedComments(): ReviewerCommentRecord[] {
    const severityOrder = { major: 0, minor: 1, suggestion: 2 }
    return [...this.comments].sort((a, b) => {
      // 先按严重程度排序
      const severityDiff = severityOrder[a.severity] - severityOrder[b.severity]
      if (severityDiff !== 0) return severityDiff
      // 再按状态排序（pending → in_progress → resolved）
      const statusOrder = { pending: 0, in_progress: 1, resolved: 2, disputed: 3, wontfix: 4 }
      return statusOrder[a.status] - statusOrder[b.status]
    })
  }

  /**
   * 批量更新状态
   */
  batchUpdateStatus(updates: Array<{ commentId: string; status: CommentStatus; response?: string }>): number {
    let count = 0
    for (const update of updates) {
      if (this.updateStatus(update.commentId, update.status, update.response)) {
        count++
      }
    }
    return count
  }

  /**
   * 标记所有 major 为 in_progress（开始修改时）
   */
  startRevision(): number {
    let count = 0
    for (const comment of this.comments) {
      if (comment.status === 'pending' && comment.severity === 'major') {
        comment.status = 'in_progress'
        count++
      }
    }
    return count
  }

  /**
   * 完成率百分比
   */
  getCompletionRate(): number {
    if (this.comments.length === 0) return 100
    const resolved = this.comments.filter((c) => c.status === 'resolved' || c.status === 'wontfix').length
    return Math.round((resolved / this.comments.length) * 100)
  }

  // ============================================
  // 逐点回复生成
  // ============================================

  /**
   * 生成 Response to Reviewers 草稿
   */
  generateResponseDraft(config?: Partial<ResponseDraftConfig>): ResponseToReviewersDraft {
    const mergedConfig = { ...DEFAULT_RESPONSE_CONFIG, ...config }
    const prioritized = this.getPrioritizedComments()

    const responses = prioritized.map((comment) => {
      const isAddressed = comment.status === 'resolved'
      const responseText = comment.response ?? this.generateDefaultResponse(comment, mergedConfig)

      return {
        commentId: comment.id,
        reviewerName: comment.reviewerName,
        originalComment: comment.content,
        responseText,
        isAddressed,
        changesMade: isAddressed && mergedConfig.includeChangeSummary
          ? this.generateChangeSummary(comment)
          : undefined,
      }
    })

    const completionPercentage = this.getCompletionRate()

    return {
      paperId: this.paperId,
      responses,
      completionPercentage,
    }
  }

  /**
   * 生成默认回复文本
   */
  private generateDefaultResponse(
    comment: ReviewerCommentRecord,
    config: ResponseDraftConfig
  ): string {
    const thanks = config.includeThanks ? '感谢您的宝贵意见。' : ''

    switch (comment.status) {
      case 'resolved':
        return `${thanks}我们已根据您的建议进行了修改。${comment.suggestion ? `具体而言，我们${comment.suggestion}。` : ''}`
      case 'in_progress':
        return `${thanks}我们正在处理此问题，将在修订稿中体现。`
      case 'disputed':
        return `${thanks}我们仔细考虑了您的意见，但基于以下原因保留了原文：${comment.response ?? '我们认为现有表述已足够准确。'}`
      case 'wontfix':
        return `${thanks}感谢您的建议。经过讨论，我们认为当前版本已能充分表达研究内容，暂不做修改。`
      default:
        return `${thanks}待处理。`
    }
  }

  /**
   * 生成修改摘要
   */
  private generateChangeSummary(comment: ReviewerCommentRecord): string {
    if (comment.diffSnapshot) {
      return `已修改：${comment.diffSnapshot.slice(0, 100)}`
    }
    if (comment.targetSection) {
      return `已在 ${comment.targetSection} 部分进行了相应修改。`
    }
    return '已根据意见进行了修改。'
  }

  /**
   * 导出为 Markdown 格式
   */
  exportToMarkdown(): string {
    const tracking = this.getTracking()
    const lines: string[] = [
      `# Response to Reviewers — Round ${tracking.round}`,
      '',
      `**进度**: ${tracking.progress.resolved}/${tracking.progress.total} 已解决 (${this.getCompletionRate()}%)`,
      '',
      '---',
      '',
    ]

    // 按评审人分组
    const byReviewer = new Map<string, ReviewerCommentRecord[]>()
    for (const comment of this.getPrioritizedComments()) {
      const group = byReviewer.get(comment.reviewerName) ?? []
      group.push(comment)
      byReviewer.set(comment.reviewerName, group)
    }

    for (const [reviewer, comments] of byReviewer) {
      lines.push(`## ${reviewer}`, '')

      for (let i = 0; i < comments.length; i++) {
        const c = comments[i]!
        const statusEmoji = this.statusToEmoji(c.status)
        lines.push(`### ${statusEmoji} 意见 ${i + 1} [${c.severity}]`, '')
        lines.push(`**原文**: ${c.content}`, '')
        if (c.suggestion) {
          lines.push(`**建议**: ${c.suggestion}`, '')
        }
        lines.push(`**回复**: ${c.response ?? '(待回复)'}`, '')
        if (c.diffSnapshot) {
          lines.push(`**修改**: ${c.diffSnapshot}`, '')
        }
        lines.push('')
      }
    }

    return lines.join('\n')
  }

  private statusToEmoji(status: CommentStatus): string {
    const map: Record<CommentStatus, string> = {
      pending: '⏳',
      in_progress: '🔄',
      resolved: '✅',
      disputed: '⚠️',
      wontfix: '❌',
    }
    return map[status] ?? '⏳'
  }
}

/**
 * 便捷函数：从评审报告创建修改追踪
 */
export function createRevisionTracker(
  paperId: string,
  comments: ReviewCommentInput[],
  round = 1
): RevisionTracker {
  const tracker = new RevisionTracker(paperId, round)
  tracker.importComments(comments)
  return tracker
}

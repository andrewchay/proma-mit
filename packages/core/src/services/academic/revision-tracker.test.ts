/**
 * 修改追踪服务测试
 */

import { describe, it, expect, beforeEach } from 'bun:test'
import { RevisionTracker, createRevisionTracker } from './revision-tracker'
import type { ReviewCommentInput } from './revision-tracker'

describe('RevisionTracker', () => {
  let tracker: RevisionTracker

  beforeEach(() => {
    tracker = new RevisionTracker('paper-1', 1)
  })

  // ============================================
  // 导入与基础操作
  // ============================================

  it('should import comments', () => {
    const inputs: ReviewCommentInput[] = [
      { reviewerName: 'Reviewer A', content: 'Major issue 1', severity: 'major' },
      { reviewerName: 'Reviewer B', content: 'Minor issue 1', severity: 'minor' },
    ]

    const records = tracker.importComments(inputs)
    expect(records.length).toBe(2)
    expect(records[0]!.status).toBe('pending')
    expect(records[0]!.severity).toBe('major')
  })

  it('should generate unique IDs for comments', () => {
    const inputs: ReviewCommentInput[] = [
      { reviewerName: 'R1', content: 'c1', severity: 'major' },
      { reviewerName: 'R1', content: 'c2', severity: 'minor' },
    ]

    const records = tracker.importComments(inputs)
    expect(records[0]!.id).not.toBe(records[1]!.id)
  })

  // ============================================
  // 状态更新
  // ============================================

  it('should update comment status', () => {
    const records = tracker.importComments([
      { reviewerName: 'R1', content: 'issue', severity: 'major' },
    ])
    const commentId = records[0]!.id

    const updated = tracker.updateStatus(commentId, 'in_progress', 'Working on it')
    expect(updated).toBe(true)

    const tracking = tracker.getTracking()
    expect(tracking.comments[0]!.status).toBe('in_progress')
    expect(tracking.comments[0]!.response).toBe('Working on it')
  })

  it('should set resolvedAt when marking resolved', () => {
    const records = tracker.importComments([
      { reviewerName: 'R1', content: 'issue', severity: 'major' },
    ])
    const commentId = records[0]!.id

    tracker.updateStatus(commentId, 'resolved', 'Fixed')
    const tracking = tracker.getTracking()
    expect(tracking.comments[0]!.resolvedAt).toBeDefined()
  })

  it('should return false for non-existent comment', () => {
    const result = tracker.updateStatus('non-existent', 'resolved')
    expect(result).toBe(false)
  })

  // ============================================
  // 筛选与查询
  // ============================================

  it('should filter comments by status', () => {
    tracker.importComments([
      { reviewerName: 'R1', content: 'c1', severity: 'major' },
      { reviewerName: 'R1', content: 'c2', severity: 'minor' },
    ])

    tracker.updateStatus(tracker.getTracking().comments[0]!.id, 'resolved')

    const resolved = tracker.getCommentsByStatus('resolved')
    const pending = tracker.getCommentsByStatus('pending')

    expect(resolved.length).toBe(1)
    expect(pending.length).toBe(1)
  })

  it('should filter comments by severity', () => {
    tracker.importComments([
      { reviewerName: 'R1', content: 'major issue', severity: 'major' },
      { reviewerName: 'R1', content: 'minor issue', severity: 'minor' },
      { reviewerName: 'R1', content: 'suggestion', severity: 'suggestion' },
    ])

    expect(tracker.getCommentsBySeverity('major').length).toBe(1)
    expect(tracker.getCommentsBySeverity('minor').length).toBe(1)
    expect(tracker.getCommentsBySeverity('suggestion').length).toBe(1)
  })

  it('should filter comments by reviewer', () => {
    tracker.importComments([
      { reviewerName: 'Alice', content: 'c1', severity: 'major' },
      { reviewerName: 'Bob', content: 'c2', severity: 'minor' },
    ])

    expect(tracker.getCommentsByReviewer('Alice').length).toBe(1)
    expect(tracker.getCommentsByReviewer('Bob').length).toBe(1)
  })

  it('should filter comments by section', () => {
    tracker.importComments([
      { reviewerName: 'R1', content: 'c1', severity: 'major', targetSection: 'method' },
      { reviewerName: 'R1', content: 'c2', severity: 'minor', targetSection: 'results' },
    ])

    expect(tracker.getCommentsBySection('method').length).toBe(1)
    expect(tracker.getCommentsBySection('results').length).toBe(1)
  })

  // ============================================
  // 优先级排序
  // ============================================

  it('should sort by severity then status', () => {
    tracker.importComments([
      { reviewerName: 'R1', content: 'suggestion', severity: 'suggestion' },
      { reviewerName: 'R1', content: 'minor pending', severity: 'minor' },
      { reviewerName: 'R1', content: 'major pending', severity: 'major' },
    ])

    const sorted = tracker.getPrioritizedComments()
    expect(sorted[0]!.severity).toBe('major')
    expect(sorted[1]!.severity).toBe('minor')
    expect(sorted[2]!.severity).toBe('suggestion')
  })

  // ============================================
  // 批量操作
  // ============================================

  it('should batch update status', () => {
    const records = tracker.importComments([
      { reviewerName: 'R1', content: 'c1', severity: 'major' },
      { reviewerName: 'R1', content: 'c2', severity: 'minor' },
    ])

    const count = tracker.batchUpdateStatus([
      { commentId: records[0]!.id, status: 'resolved' },
      { commentId: records[1]!.id, status: 'in_progress' },
    ])

    expect(count).toBe(2)
    expect(tracker.getCommentsByStatus('resolved').length).toBe(1)
    expect(tracker.getCommentsByStatus('in_progress').length).toBe(1)
  })

  it('should start revision on major comments', () => {
    tracker.importComments([
      { reviewerName: 'R1', content: 'major1', severity: 'major' },
      { reviewerName: 'R1', content: 'major2', severity: 'major' },
      { reviewerName: 'R1', content: 'minor1', severity: 'minor' },
    ])

    const count = tracker.startRevision()
    expect(count).toBe(2)
    expect(tracker.getCommentsByStatus('in_progress').length).toBe(2)
    expect(tracker.getCommentsByStatus('pending').length).toBe(1)
  })

  // ============================================
  // 进度统计
  // ============================================

  it('should calculate completion rate', () => {
    tracker.importComments([
      { reviewerName: 'R1', content: 'c1', severity: 'major' },
      { reviewerName: 'R1', content: 'c2', severity: 'minor' },
      { reviewerName: 'R1', content: 'c3', severity: 'suggestion' },
    ])

    expect(tracker.getCompletionRate()).toBe(0)

    tracker.updateStatus(tracker.getTracking().comments[0]!.id, 'resolved')
    expect(tracker.getCompletionRate()).toBe(33)

    tracker.updateStatus(tracker.getTracking().comments[1]!.id, 'wontfix')
    expect(tracker.getCompletionRate()).toBe(67)
  })

  it('should return 100% for empty tracker', () => {
    expect(tracker.getCompletionRate()).toBe(100)
  })

  // ============================================
  // 修改追踪报告
  // ============================================

  it('should generate tracking report', () => {
    tracker.importComments([
      { reviewerName: 'R1', content: 'c1', severity: 'major' },
      { reviewerName: 'R1', content: 'c2', severity: 'minor' },
    ])

    tracker.updateStatus(tracker.getTracking().comments[0]!.id, 'resolved')

    const tracking = tracker.getTracking()
    expect(tracking.paperId).toBe('paper-1')
    expect(tracking.round).toBe(1)
    expect(tracking.progress.total).toBe(2)
    expect(tracking.progress.resolved).toBe(1)
    expect(tracking.progress.pending).toBe(1)
    expect(tracking.updatedAt).toBeGreaterThan(0)
  })

  // ============================================
  // 回复草稿生成
  // ============================================

  it('should generate response draft', () => {
    tracker.importComments([
      { reviewerName: 'R1', content: 'Please add more details.', severity: 'minor', suggestion: 'add details' },
    ])

    tracker.updateStatus(tracker.getTracking().comments[0]!.id, 'resolved', 'Added details.')

    const draft = tracker.generateResponseDraft()
    expect(draft.paperId).toBe('paper-1')
    expect(draft.responses.length).toBe(1)
    expect(draft.responses[0]!.isAddressed).toBe(true)
    expect(draft.responses[0]!.responseText).toContain('Added details')
    expect(draft.completionPercentage).toBe(100)
  })

  it('should generate default response for pending comments', () => {
    tracker.importComments([
      { reviewerName: 'R1', content: 'Issue here.', severity: 'major' },
    ])

    const draft = tracker.generateResponseDraft({ includeThanks: false })
    expect(draft.responses[0]!.responseText).toContain('待处理')
  })

  it('should generate disputed response', () => {
    tracker.importComments([
      { reviewerName: 'R1', content: 'I disagree with X.', severity: 'minor' },
    ])

    tracker.updateStatus(tracker.getTracking().comments[0]!.id, 'disputed', 'We believe X is correct.')

    const draft = tracker.generateResponseDraft()
    expect(draft.responses[0]!.responseText).toBe('We believe X is correct.')
  })

  it('should include change summary when configured', () => {
    tracker.importComments([
      { reviewerName: 'R1', content: 'Fix typo.', severity: 'suggestion', targetSection: 'abstract' },
    ])

    tracker.updateStatus(tracker.getTracking().comments[0]!.id, 'resolved')

    const draft = tracker.generateResponseDraft({ includeChangeSummary: true })
    expect(draft.responses[0]!.changesMade).toContain('abstract')
  })

  // ============================================
  // Markdown 导出
  // ============================================

  it('should export to markdown', () => {
    tracker.importComments([
      { reviewerName: 'Alice', content: 'Major issue.', severity: 'major' },
      { reviewerName: 'Bob', content: 'Minor issue.', severity: 'minor' },
    ])

    const md = tracker.exportToMarkdown()
    expect(md).toContain('Response to Reviewers')
    expect(md).toContain('Alice')
    expect(md).toContain('Bob')
    expect(md).toContain('Major issue')
    expect(md).toContain('Minor issue')
  })

  // ============================================
  // 便捷函数
  // ============================================

  it('should work with createRevisionTracker helper', () => {
    const t = createRevisionTracker('paper-2', [
      { reviewerName: 'R1', content: 'issue', severity: 'major' },
    ], 2)

    const tracking = t.getTracking()
    expect(tracking.paperId).toBe('paper-2')
    expect(tracking.round).toBe(2)
    expect(tracking.comments.length).toBe(1)
  })

  // ============================================
  // Diff 快照
  // ============================================

  it('should add diff snapshot', () => {
    const records = tracker.importComments([
      { reviewerName: 'R1', content: 'issue', severity: 'major' },
    ])

    const result = tracker.addDiffSnapshot(records[0]!.id, '- old\n+ new')
    expect(result).toBe(true)

    const tracking = tracker.getTracking()
    expect(tracking.comments[0]!.diffSnapshot).toBe('- old\n+ new')
  })

  it('should return false for non-existent diff snapshot', () => {
    const result = tracker.addDiffSnapshot('non-existent', 'diff')
    expect(result).toBe(false)
  })
})

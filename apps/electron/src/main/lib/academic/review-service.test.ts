import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * 审查与修订回复测试（M7.3）：
 * - 规则检查可标 error；模型建议强制降级且必须记录模型与理由
 * - 回复「已处理」必须指出修改体现在哪个稿件版本（否则无从核对）
 * - 回复状态是作者声明，草稿明确声明不代表审稿人认可
 */

let tempDir: string
const originalEnv = { ...process.env }

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'review-service-'))
  process.env.PROMA_TEST_CONFIG_DIR = tempDir
})

afterEach(() => {
  process.env = { ...originalEnv }
  rmSync(tempDir, { recursive: true, force: true })
})

async function loadAll() {
  return {
    review: await import(`./review-service?t=${Math.random()}`),
    project: await import(`./research-service?t=${Math.random()}`),
    claim: await import(`./claim-service?t=${Math.random()}`),
  }
}

async function setup() {
  const { review, project, claim } = await loadAll()
  const p = await project.createResearchProject({
    title: '审查测试项目', domain: 'audiology', methodPath: 'quantitative',
  })
  return { review, claim, projectId: p.id }
}

describe('审查发现来源区分', () => {
  test('规则检查可标 error；模型建议被降级', async () => {
    const { review, projectId } = await setup()

    const rule = await review.recordRuleFinding(projectId, {
      message: '引用 [3] 的 DOI 无法解析',
      rule: 'citation-doi-resolvable',
      measured: 'unresolved',
      severity: 'error',
    })
    const llm = await review.recordLlmFinding(projectId, {
      message: '建议补充样本量论证',
      model: 'gpt-x',
      rationale: '与同类研究相比缺少功效分析说明',
      severity: 'error',
    })

    expect(rule.kind).toBe('rule-lint')
    expect(rule.severity).toBe('error')
    expect(llm.kind).toBe('llm-suggestion')
    expect(llm.severity).toBe('warning')

    const { summary, findings } = await review.listReviewFindings(projectId)
    expect(findings).toHaveLength(2)
    expect(summary.ruleLint.error).toBe(1)
    expect(summary.llmSuggestions).toBe(1)
  })

  test('模型建议缺模型或理由时拒绝落库', async () => {
    const { review, projectId } = await setup()
    await expect(
      review.recordLlmFinding(projectId, { message: 'x', model: '', rationale: 'r' }),
    ).rejects.toThrow('模型标识')
    await expect(
      review.recordLlmFinding(projectId, { message: 'x', model: 'm', rationale: ' ' }),
    ).rejects.toThrow('理由')
  })

  test('规则检查缺规则名或实测值时拒绝', async () => {
    const { review, projectId } = await setup()
    await expect(
      review.recordRuleFinding(projectId, { message: 'x', rule: '', measured: '1' }),
    ).rejects.toThrow('规则名与实测值')
  })
})

describe('审稿意见与修订回复', () => {
  test('登记审稿意见必须标明来源与内容', async () => {
    const { review, projectId } = await setup()
    await expect(
      review.recordReviewerComment(projectId, { reviewerName: '', content: 'x', severity: 'major' }),
    ).rejects.toThrow('审稿人')
    await expect(
      review.recordReviewerComment(projectId, { reviewerName: 'R1', content: ' ', severity: 'major' }),
    ).rejects.toThrow('内容不能为空')
  })

  test('回复「已处理」必须指出稿件版本，且版本需真实存在', async () => {
    const { review, claim, projectId } = await setup()
    const comment = await review.recordReviewerComment(projectId, {
      reviewerName: 'Reviewer 1', content: '方法部分缺乏样本量论证', severity: 'major', targetSection: '方法',
    })

    await expect(
      review.respondToReviewerComment(projectId, {
        commentId: comment.id, status: 'addressed', response: '已补充功效分析',
      }),
    ).rejects.toThrow('必须指出修改体现在哪个稿件版本')

    await expect(
      review.respondToReviewerComment(projectId, {
        commentId: comment.id, status: 'addressed', response: '已补充', manuscriptVersionId: 'ghost',
      }),
    ).rejects.toThrow('稿件版本不存在')

    // 建立真实稿件版本后可回复
    const ms = await claim.createManuscriptVersion(projectId, {
      title: '修订稿', sections: [{ heading: '方法', content: '补充了功效分析…' }],
    })
    const response = await review.respondToReviewerComment(projectId, {
      commentId: comment.id, status: 'addressed', response: '已补充功效分析', manuscriptVersionId: ms.id,
    })
    expect(response.status).toBe('addressed')
    expect(response.respondedBy.id).toBe('local-user')
  })

  test('「未采纳」不需要稿件版本，但必须给理由', async () => {
    const { review, projectId } = await setup()
    const comment = await review.recordReviewerComment(projectId, {
      reviewerName: 'Reviewer 2', content: '建议换用另一种统计方法', severity: 'minor',
    })

    const rejected = await review.respondToReviewerComment(projectId, {
      commentId: comment.id, status: 'rejected',
      response: '原方法更适合本研究的重复测量设计，理由见引言第 3 段',
    })
    expect(rejected.status).toBe('rejected')

    await expect(
      review.respondToReviewerComment(projectId, {
        commentId: comment.id, status: 'pending', response: '  ',
      }),
    ).rejects.toThrow('回复内容不能为空')
  })

  test('不存在的审稿意见拒绝回复', async () => {
    const { review, projectId } = await setup()
    await expect(
      review.respondToReviewerComment(projectId, {
        commentId: 'ghost', status: 'rejected', response: 'x',
      }),
    ).rejects.toThrow('审稿意见不存在')
  })
})

describe('response-to-reviewers 草稿', () => {
  test('逐条对应；未回复的明确标出，并声明状态含义', async () => {
    const { review, claim, projectId } = await setup()
    const c1 = await review.recordReviewerComment(projectId, {
      reviewerName: 'R1', content: '意见一', severity: 'major',
    })
    const c2 = await review.recordReviewerComment(projectId, {
      reviewerName: 'R2', content: '意见二', severity: 'minor',
    })
    const ms = await claim.createManuscriptVersion(projectId, {
      title: '修订稿', sections: [{ heading: '引言', content: 'x' }],
    })
    await review.respondToReviewerComment(projectId, {
      commentId: c1.id, status: 'addressed', response: '已改', manuscriptVersionId: ms.id,
    })

    const draft = (await review.buildResponseToReviewersDraft(projectId)) as {
      items: Array<{ commentId: string; status: string }>
      pendingCount: number
      disclaimer: string
    }
    expect(draft.items).toHaveLength(2)
    expect(draft.items.find((i) => i.commentId === c1.id)?.status).toBe('addressed')
    // 未回复的不能被隐藏
    expect(draft.items.find((i) => i.commentId === c2.id)?.status).toBe('no-response')
    expect(draft.pendingCount).toBe(1)
    expect(draft.disclaimer).toContain('不代表审稿人认可')
  })
})

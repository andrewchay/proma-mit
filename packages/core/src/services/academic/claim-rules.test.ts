import { describe, expect, test } from 'bun:test'

/**
 * 主张规则测试（M5.1）：
 * - 状态机、证据关联必须指向真实对象
 * - 无支持证据不得确认；有反对证据应标 contested
 * - 失效传播与导出预检
 */

const {
  ResearchError,
  assertClaimTransition,
  assertClaimVerifiable,
  claimsAffectedByChange,
  exportPreflight,
  suggestedClaimStatus,
  summarizeLinks,
  validateClaimInput,
  validateEvidenceLink,
} = await import('@gravitas/core/services/academic')

describe('主张输入与状态机', () => {
  test('空陈述与未知类型拒绝', () => {
    expect(() => validateClaimInput({ text: ' ', type: 'empirical' })).toThrow('不能为空')
    expect(() => validateClaimInput({ text: 'x'.repeat(2001), type: 'empirical' })).toThrow('过长')
    expect(() => validateClaimInput({ text: 'x', type: 'vibes' as never })).toThrow('未知主张类型')
  })

  test('合法迁移与非法迁移', () => {
    expect(() => assertClaimTransition('draft', 'needs_review')).not.toThrow()
    expect(() => assertClaimTransition('needs_review', 'researcher_verified')).not.toThrow()
    expect(() => assertClaimTransition('researcher_verified', 'contested')).not.toThrow()
    expect(() => assertClaimTransition('unsupported', 'researcher_verified')).toThrow('非法主张状态迁移')
    expect(() => assertClaimTransition('stale', 'researcher_verified')).toThrow('非法主张状态迁移')
  })
})

describe('证据关联', () => {
  test('必须指向真实对象', () => {
    expect(() => validateEvidenceLink({ relation: 'supports' })).toThrow('必须指向真实对象')
    expect(() => validateEvidenceLink({ relation: 'supports', evidenceId: 'ev-1' })).not.toThrow()
    expect(() => validateEvidenceLink({ relation: 'supports', runId: 'run-1' })).not.toThrow()
    expect(() => validateEvidenceLink({ relation: 'maybe' as never, evidenceId: 'e' })).toThrow('未知证据关系')
  })

  test('汇总与建议状态', () => {
    expect(summarizeLinks([{ relation: 'supports' }])).toEqual({ supports: 1, opposes: 0, qualifies: 0, canBeVerified: true })
    expect(suggestedClaimStatus([{ relation: 'supports' }, { relation: 'opposes' }])).toBe('contested')
    expect(suggestedClaimStatus([{ relation: 'qualifies' }])).toBe('unsupported')
    expect(suggestedClaimStatus([{ relation: 'supports' }])).toBe('needs_review')
  })

  test('无支持证据不得确认；有反对证据应标 contested', () => {
    expect(() => assertClaimVerifiable([])).toThrow('没有任何支持证据')
    expect(() => assertClaimVerifiable([{ relation: 'qualifies' }])).toThrow('没有任何支持证据')
    expect(() =>
      assertClaimVerifiable([{ relation: 'supports' }, { relation: 'opposes' }]),
    ).toThrow('contested')
    expect(() => assertClaimVerifiable([{ relation: 'supports' }])).not.toThrow()
  })
})

describe('失效传播', () => {
  const claims = [
    { id: 'c1', status: 'researcher_verified' },
    { id: 'c2', status: 'needs_review' },
    { id: 'c3', status: 'stale' },
    { id: 'c4', status: 'draft' },
  ] as never
  const links = [
    { claimId: 'c1', relation: 'supports', evidenceId: 'ev-1' },
    { claimId: 'c2', relation: 'supports', runId: 'run-9' },
    { claimId: 'c3', relation: 'supports', evidenceId: 'ev-1' },
    { claimId: 'c4', relation: 'qualifies', artifactId: 'art-1' },
  ] as never

  test('证据撤回 → 依赖它的主张需复核（已是 stale 的不重复）', () => {
    const affected = claimsAffectedByChange(claims, links, { evidenceIds: ['ev-1'] })
    expect(affected.sort()).toEqual(['c1'])
  })

  test('运行/产物变化命中对应主张', () => {
    expect(claimsAffectedByChange(claims, links, { runIds: ['run-9'] })).toEqual(['c2'])
    expect(claimsAffectedByChange(claims, links, { artifactIds: ['art-1'] })).toEqual(['c4'])
  })

  test('无关联变化时不影响任何主张', () => {
    expect(claimsAffectedByChange(claims, links, { evidenceIds: ['ev-404'] })).toEqual([])
  })
})

describe('导出预检', () => {
  const claims = [
    { id: 'c1', text: '已确认结论', status: 'researcher_verified' },
    { id: 'c2', text: '未确认结论', status: 'needs_review' },
    { id: 'c3', text: '无证据断言', status: 'unsupported' },
    { id: 'c4', text: '有争议', status: 'contested' },
    { id: 'c5', text: '已失效', status: 'stale' },
  ] as never
  const links = [
    { claimId: 'c1', relation: 'supports', evidenceId: 'e1' },
    { claimId: 'c2', relation: 'supports', evidenceId: 'e2' },
    { claimId: 'c4', relation: 'supports', evidenceId: 'e4' },
    { claimId: 'c4', relation: 'opposes', evidenceId: 'e5' },
    { claimId: 'c5', relation: 'supports', evidenceId: 'e6' },
  ] as never

  test('逐条列出问题，不合并成一个总分', () => {
    const result = exportPreflight(claims, links)
    expect(result.ok).toBe(false)
    const byId = Object.fromEntries(result.items.map((i) => [i.claimId, i.issue]))
    expect(byId.c1).toBeUndefined()
    expect(byId.c2).toContain('尚未经研究者确认')
    expect(byId.c3).toContain('没有支持证据')
    expect(byId.c4).toContain('反对证据')
    expect(byId.c5).toContain('已失效')
  })

  test('全部确认且各有支持证据时通过', () => {
    const ok = exportPreflight(
      [{ id: 'c1', text: 't', status: 'researcher_verified' }] as never,
      [{ claimId: 'c1', relation: 'supports', evidenceId: 'e1' }] as never,
    )
    expect(ok.ok).toBe(true)
  })

  test('错误类型为领域错误', () => {
    try {
      validateClaimInput({ text: '', type: 'empirical' })
    } catch (err) {
      expect(err).toBeInstanceOf(ResearchError)
    }
  })
})

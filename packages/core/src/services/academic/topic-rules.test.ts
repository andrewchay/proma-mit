import { describe, expect, test } from 'bun:test'

/**
 * 选题规则测试（M3.2）：
 * - gap 类型必须具体，不接受笼统新颖性
 * - 查新范围必须完整（词/库/时间/局限）
 * - 支持与反证证据必须存在于台账
 * - 如实记录检查不参与打分，只提示待补项
 */

const {
  GAP_TYPES,
  assertTopicSelectable,
  topicAdvisoryNotes,
  topicRecordednessGaps,
  validateTopicProposal,
} = await import('@gravitas/core/services/academic')

const baseDraft = {
  title: '降噪策略对聆听负荷的剂量效应',
  question: '在 0–15 dB SNR 区间，降噪增益与聆听负荷是否呈非线性关系？',
  gapType: 'unstudied-comparison' as const,
  gapRationale: '既有研究只比较开/关，未系统扫描 SNR 区间，剂量关系未知。',
  supportingEvidenceIds: ['ev-1'],
  contradictingEvidenceIds: [],
  counterarguments: [],
  noveltyCheck: {
    queries: ['noise reduction listening effort dose'],
    databases: ['pubmed'],
    checkedAt: '2026-09-16T10:00:00.000Z',
    closestSourceIds: [],
    limitations: [],
  },
}

describe('选题草稿校验', () => {
  test('合法草稿通过（允许空反证与空反例）', () => {
    expect(() => validateTopicProposal(baseDraft, ['ev-1'])).not.toThrow()
  })

  test('gap 类型必须是已知类型', () => {
    expect(() =>
      validateTopicProposal({ ...baseDraft, gapType: 'very-novel' as never }, ['ev-1']),
    ).toThrow('未知 gap 类型')
    expect(GAP_TYPES.length).toBe(6)
  })

  test('缺 gap 论证或研究问题时拒绝', () => {
    expect(() => validateTopicProposal({ ...baseDraft, gapRationale: ' ' }, ['ev-1'])).toThrow('gap 论证')
    expect(() => validateTopicProposal({ ...baseDraft, question: '' }, ['ev-1'])).toThrow('研究问题')
  })

  test('查新范围必须完整（词/库/时间）', () => {
    expect(() =>
      validateTopicProposal(
        { ...baseDraft, noveltyCheck: { ...baseDraft.noveltyCheck, queries: [' '] } },
        ['ev-1'],
      ),
    ).toThrow('检索词')
    expect(() =>
      validateTopicProposal(
        { ...baseDraft, noveltyCheck: { ...baseDraft.noveltyCheck, databases: [] } },
        ['ev-1'],
      ),
    ).toThrow('数据库')
    expect(() =>
      validateTopicProposal(
        { ...baseDraft, noveltyCheck: { ...baseDraft.noveltyCheck, checkedAt: '' } },
        ['ev-1'],
      ),
    ).toThrow('检索时间')
  })

  test('支持/反证证据必须存在于台账', () => {
    expect(() =>
      validateTopicProposal({ ...baseDraft, supportingEvidenceIds: ['ghost'] }, ['ev-1']),
    ).toThrow('支持证据不存在')
    expect(() =>
      validateTopicProposal({ ...baseDraft, contradictingEvidenceIds: ['ghost'] }, ['ev-1']),
    ).toThrow('反证证据不存在')
  })
})

describe('如实记录检查（不参与打分）', () => {
  test('硬缺口只含「证据/最接近工作/局限」三类', () => {
    const gaps = topicRecordednessGaps({
      supportingEvidenceIds: [],
      contradictingEvidenceIds: [],
      counterarguments: [],
      noveltyCheck: { queries: ['q'], databases: ['pubmed'], checkedAt: 'x', closestSourceIds: [], limitations: [] },
    } as never)
    expect(gaps).toHaveLength(3)
    expect(gaps.join(' ')).toContain('支持证据')
    expect(gaps.join(' ')).toContain('最接近的既有工作')
    expect(gaps.join(' ')).toContain('检索局限')
    // 反证不属于硬缺口（检索后确无为合法结果，强制非空会诱导编造）
    expect(gaps.join(' ')).not.toContain('未记录反证')
  })

  test('反证与反例作为非阻断提示返回', () => {
    const notes = topicAdvisoryNotes({ contradictingEvidenceIds: [], counterarguments: [] })
    expect(notes).toHaveLength(2)
    expect(notes.join(' ')).toContain('反证')
    expect(notes.join(' ')).toContain('反例')

    expect(
      topicAdvisoryNotes({ contradictingEvidenceIds: ['ev-2'], counterarguments: ['替代解释'] }),
    ).toEqual([])
  })

  test('记录完整时无硬缺口', () => {
    const gaps = topicRecordednessGaps({
      supportingEvidenceIds: ['ev-1'],
      contradictingEvidenceIds: [],
      counterarguments: [],
      noveltyCheck: {
        queries: ['q'], databases: ['pubmed'], checkedAt: 'x',
        closestSourceIds: ['src-1'], limitations: ['未覆盖非英文文献'],
      },
    } as never)
    expect(gaps).toEqual([])
  })
})

describe('选题选择状态', () => {
  test('已选定/已否决不能重复选定', () => {
    expect(() => assertTopicSelectable('candidate')).not.toThrow()
    expect(() => assertTopicSelectable('selected')).toThrow('已被选定')
    expect(() => assertTopicSelectable('rejected')).toThrow('已被否决')
  })
})

import { describe, expect, test } from 'bun:test'

/**
 * 协议规则测试（M3）：
 * - 方法路径必须匹配领域
 * - 批准门禁：必填字段 + 检查项确认 + 伦理依据
 * - 修订需理由，草稿不走修订
 */

const {
  ResearchError,
  evaluateApproval,
  nextProtocolVersion,
  validateProtocolDraft,
  validateProtocolRevision,
} = await import('@gravitas/core/services/academic')

describe('协议草稿校验', () => {
  test('方法路径不匹配领域时拒绝', () => {
    expect(() =>
      validateProtocolDraft('statistics', { methodPath: 'qualitative', fields: {} }),
    ).toThrow('不支持方法路径')
  })

  test('返回缺失的必填字段', () => {
    const result = validateProtocolDraft('statistics', {
      methodPath: 'quantitative',
      fields: { estimand: '均值差' },
    })
    expect(result.missingRequiredFields).toContain('samplingUnit')
    expect(result.missingRequiredFields).toContain('replicates')
    expect(result.missingRequiredFields).not.toContain('estimand')
  })
})

describe('批准门禁', () => {
  const audiologyFields = {
    population: '成人感音神经性听损',
    intervention: '降噪算法 A',
    comparator: '降噪算法 B',
    outcomes: '语音识别阈值',
    acousticCalibration: '校准于 65 dB SPL，2026-08 记录',
    estimand: '组间差值',
    samplingUnit: '受试者（双耳为重复测量）',
    sampleSizeRationale: '功效分析 0.8',
  }

  test('字段齐全但检查项未确认 → 阻断并列出缺失检查项', () => {
    const result = evaluateApproval('audiology', {
      methodPath: 'quantitative',
      fields: audiologyFields,
      acknowledgedChecks: [],
    })
    expect(result.ok).toBe(false)
    expect(result.blockers.join(' ')).toContain('检查项尚未确认')
    expect(result.checkIds).toContain('ears-not-independent')
  })

  test('字段齐全 + 检查项确认 → 可批准', () => {
    const result = evaluateApproval('audiology', {
      methodPath: 'quantitative',
      fields: audiologyFields,
      acknowledgedChecks: ['ears-not-independent', 'unit-consistency', 'calibration-evidence', 'ceiling-floor'],
    })
    expect(result.ok).toBe(true)
    expect(result.blockers).toEqual([])
  })

  test('缺必填字段时批准被阻断（多问题全列）', () => {
    const result = evaluateApproval('audiology', {
      methodPath: 'quantitative',
      fields: { population: '成人' },
      acknowledgedChecks: [],
    })
    expect(result.ok).toBe(false)
    expect(result.blockers.length).toBeGreaterThan(1)
  })

  test('质性研究缺伦理依据 → 明确阻断', () => {
    const result = evaluateApproval('medical-humanities', {
      methodPath: 'qualitative',
      fields: {
        positionality: '临床背景',
        materialSelection: '招募 15 名听损成人',
        codingStrategy: '主题分析',
      },
      acknowledgedChecks: ['no-fabricated-quotes', 'identity-separation', 'positionality-stated'],
    })
    expect(result.ok).toBe(false)
    expect(result.blockers.join(' ')).toContain('伦理依据')
  })

  test('质性研究提供伦理依据后可批准（不要求假设/seed）', () => {
    const result = evaluateApproval('medical-humanities', {
      methodPath: 'qualitative',
      fields: {
        positionality: '临床背景',
        materialSelection: '招募 15 名听损成人',
        codingStrategy: '主题分析',
        ethicsBasis: '伦理批件 2026-ETH-01',
        dataRetention: '加密保存 5 年',
      },
      acknowledgedChecks: ['no-fabricated-quotes', 'identity-separation', 'positionality-stated'],
    })
    expect(result.ok).toBe(true)
  })

  test('定量研究不强制伦理依据', () => {
    const result = evaluateApproval('statistics', {
      methodPath: 'quantitative',
      fields: {
        estimand: '偏差',
        samplingUnit: '模拟数据集',
        sampleSizeRationale: '1000 次重复',
        replicates: '1000',
        dataGeneratingMechanism: 'MCAR 20%',
      },
      acknowledgedChecks: ['mc-error', 'seed-not-stability', 'prespecify-primary'],
    })
    expect(result.ok).toBe(true)
  })
})

describe('协议修订', () => {
  test('无理由修订拒绝；草稿不走修订', () => {
    expect(() =>
      validateProtocolRevision('audiology', { version: 1, status: 'approved' }, {
        changeReason: ' ',
        methodPath: 'quantitative',
        fields: {},
      }),
    ).toThrow('变更理由')

    expect(() =>
      validateProtocolRevision('audiology', { version: 1, status: 'draft' }, {
        changeReason: '改主结局',
        methodPath: 'quantitative',
        fields: {},
      }),
    ).toThrow('草稿应直接修改')
  })

  test('已批准版本可修订且方法路径仍受领域约束', () => {
    expect(() =>
      validateProtocolRevision('audiology', { version: 1, status: 'approved' }, {
        changeReason: '更换主要结局测量工具',
        methodPath: 'quantitative',
        fields: {},
      }),
    ).not.toThrow()

    expect(() =>
      validateProtocolRevision('audiology', { version: 1, status: 'approved' }, {
        changeReason: 'x',
        methodPath: 'formal',
        fields: {},
      }),
    ).toThrow('不支持方法路径')
  })

  test('条件必填：医学人文的伦理/保存字段仅对涉及人类的方法路径必填', () => {
    const { requiredFieldsFor } = require('@gravitas/core/services/academic') as typeof import('@gravitas/core/services/academic')
    const qual = requiredFieldsFor('medical-humanities', 'qualitative').map((f) => f.key)
    expect(qual).toContain('ethicsBasis')
    expect(qual).toContain('dataRetention')

    // 定量路径下这两个字段不再是必填，但质性核心字段仍必填
    const quant = requiredFieldsFor('medical-humanities', 'quantitative').map((f) => f.key)
    expect(quant).not.toContain('ethicsBasis')
    expect(quant).toContain('positionality')
  })

  test('版本号单调递增', () => {
    expect(nextProtocolVersion([])).toBe(1)
    expect(nextProtocolVersion([{ version: 1 }, { version: 3 }])).toBe(4)
  })

  test('错误类型为领域错误', () => {
    try {
      validateProtocolRevision('ai', { version: 1, status: 'draft' }, {
        changeReason: 'x', methodPath: 'quantitative', fields: {},
      })
    } catch (err) {
      expect(err).toBeInstanceOf(ResearchError)
    }
  })
})

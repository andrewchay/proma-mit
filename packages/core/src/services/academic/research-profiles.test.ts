import { describe, expect, test } from 'bun:test'

/**
 * 领域方法 profile 测试（G1）：
 * - 七领域都有 profile 且默认方法路径在允许集合内
 * - 方法路径不匹配时拒绝（如统计不做质性）
 * - 质性/形式领域不强制假设与随机种子
 * - 检查项按方法路径过滤
 */

const {
  DOMAIN_PROFILES,
  ResearchError,
  assertMethodPathAllowed,
  checksFor,
  getDomainProfile,
  listDomainProfiles,
  requiredFieldsFor,
} = await import('@gravitas/core/services/academic')

describe('领域 profile 完整性', () => {
  test('七个领域都有 profile 且默认方法路径合法', () => {
    const domains = [
      'audiology', 'medical-humanities', 'statistics', 'ai',
      'ontology', 'enterprise-ai', 'data-science',
    ] as const
    expect(listDomainProfiles()).toHaveLength(7)
    for (const domain of domains) {
      const profile = getDomainProfile(domain)
      expect(profile.domain).toBe(domain)
      expect(profile.allowedMethodPaths).toContain(profile.defaultMethodPath)
      expect(profile.protocolFields.length).toBeGreaterThan(0)
      expect(profile.checks.length).toBeGreaterThan(0)
    }
  })

  test('未知领域抛领域错误', () => {
    expect(() => getDomainProfile('astrology' as never)).toThrow(ResearchError)
  })
})

describe('方法路径约束', () => {
  test('统计领域允许定量/形式，拒绝质性', () => {
    expect(() => assertMethodPathAllowed('statistics', 'quantitative')).not.toThrow()
    expect(() => assertMethodPathAllowed('statistics', 'formal')).not.toThrow()
    expect(() => assertMethodPathAllowed('statistics', 'qualitative')).toThrow('不支持方法路径')
  })

  test('医学人文允许质性，听力学允许定量与质性', () => {
    expect(() => assertMethodPathAllowed('medical-humanities', 'qualitative')).not.toThrow()
    expect(() => assertMethodPathAllowed('audiology', 'qualitative')).not.toThrow()
    expect(() => assertMethodPathAllowed('audiology', 'formal')).toThrow('不支持方法路径')
  })
})

describe('协议字段与检查项', () => {
  test('听力学必填含声学校准依据', () => {
    const required = requiredFieldsFor('audiology').map((f) => f.key)
    expect(required).toContain('acousticCalibration')
    expect(required).toContain('samplingUnit')
  })

  test('质性领域不强制假设与随机种子（方案 §4.1）', () => {
    const required = requiredFieldsFor('medical-humanities').map((f) => f.key)
    expect(required).not.toContain('hypothesis')
    expect(required).not.toContain('seed')
    expect(required).toContain('positionality')
  })

  test('本体必填含能力问题与验证方案', () => {
    const required = requiredFieldsFor('ontology').map((f) => f.key)
    expect(required).toContain('competencyQuestions')
    expect(required).toContain('validationPlan')
  })

  test('检查项按方法路径过滤', () => {
    const quant = checksFor('audiology', 'quantitative').map((c) => c.id)
    expect(quant).toContain('ears-not-independent')
    // 无 appliesTo 的检查在任何路径下都启用
    const qual = checksFor('medical-humanities', 'qualitative').map((c) => c.id)
    expect(qual).toContain('no-fabricated-quotes')
  })

  test('每个领域的建议数据源非空且用 adapter 已知 id', () => {
    for (const profile of listDomainProfiles()) {
      expect(profile.suggestedDatabases.length).toBeGreaterThan(0)
      for (const db of profile.suggestedDatabases) {
        expect(['openalex', 'arxiv', 'pubmed', 'europepmc', 'zotero']).toContain(db)
      }
    }
  })

  test('DOMAIN_PROFILES 键与 domain 字段一致', () => {
    for (const [key, profile] of Object.entries(DOMAIN_PROFILES)) {
      expect((profile as { domain: string }).domain).toBe(key)
    }
  })
})

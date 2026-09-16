import { describe, expect, test } from 'bun:test'

/**
 * 研究规则层测试（纯函数，无 IO）。
 *
 * 覆盖：创建输入校验、状态机迁移、质性研究不强制假设等
 * 方案 v1 §13.1 场景 5 的领域基础。
 */

const {
  RESEARCH_ERROR_CODES,
  ResearchError,
  assertStatusTransition,
  nextStatusesOf,
  validateCreateResearchProject,
} = await import('@gravitas/core/services/academic')

const validInput = {
  title: '降噪策略对语音识别的影响',
  domain: 'audiology' as const,
  methodPath: 'quantitative' as const,
}

describe('研究项目创建校验', () => {
  test('合法输入通过', () => {
    expect(() => validateCreateResearchProject(validInput)).not.toThrow()
  })

  test('空标题拒绝', () => {
    try {
      validateCreateResearchProject({ ...validInput, title: '  ' })
      throw new Error("不应到达此处")
    } catch (err) {
      expect(err).toBeInstanceOf(ResearchError)
      expect((err as InstanceType<typeof ResearchError>).code).toBe(RESEARCH_ERROR_CODES.INVALID_INPUT)
    }
  })

  test('未知领域与方法路径拒绝', () => {
    expect(() =>
      validateCreateResearchProject({ ...validInput, domain: 'astrology' as never }),
    ).toThrow('未知研究领域')
    expect(() =>
      validateCreateResearchProject({ ...validInput, methodPath: 'magic' as never }),
    ).toThrow('未知方法路径')
  })

  test('Brief 缺研究问题拒绝', () => {
    expect(() =>
      validateCreateResearchProject({
        ...validInput,
        brief: { question: '', goals: 'g', scope: 's' },
      }),
    ).toThrow('研究问题')
  })
})

describe('研究状态机', () => {
  test('defining → literature → designing → executing 合法', () => {
    expect(() => assertStatusTransition('defining', 'literature')).not.toThrow()
    expect(() => assertStatusTransition('literature', 'designing')).not.toThrow()
    expect(() => assertStatusTransition('designing', 'executing')).not.toThrow()
  })

  test('跳阶段（defining → executing）拒绝', () => {
    try {
      assertStatusTransition('defining', 'executing')
      throw new Error("不应到达此处")
    } catch (err) {
      expect((err as InstanceType<typeof ResearchError>).code).toBe(RESEARCH_ERROR_CODES.INVALID_TRANSITION)
    }
  })

  test('completed 只能归档；archived 是终态', () => {
    expect(() => assertStatusTransition('completed', 'writing')).toThrow('非法研究状态迁移')
    expect(() => assertStatusTransition('archived', 'defining')).toThrow('非法研究状态迁移')
    expect(nextStatusesOf('archived')).toHaveLength(0)
  })

  test('回流：executing → designing 允许（方案 §4 回路）', () => {
    expect(() => assertStatusTransition('executing', 'designing')).not.toThrow()
  })
})

import { expect, test } from 'bun:test'
import { parseOwnerTechnicalReviewResponse } from './project-owner-technical-review'

const criteria = ['接口保持兼容', '回归测试通过']

function response(verdict: string, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schemaVersion: 1,
    verdict,
    summary: '按冻结标准完成独立技术评审。',
    criteria: [
      { criterion: criteria[0], status: 'met', evidence: '接口测试通过' },
      { criterion: criteria[1], status: verdict === 'approved' ? 'met' : 'not_met', evidence: '回归测试结果' },
    ],
    findings: verdict === 'changes_requested'
      ? [{ severity: 'medium', description: '缺少回归断言。', requestedChange: '补充覆盖失败输入的测试。' }]
      : [],
    blockerReason: null,
    ...overrides,
  })
}

test('Given严格匹配全部冻结标准的评审输出 When解析 Then产生技术通过建议而非业务验收', () => {
  expect(parseOwnerTechnicalReviewResponse(response('approved'), criteria)).toMatchObject({
    schemaVersion: 1,
    verdict: 'approved',
    criteria: criteria.map(criterion => ({ criterion, status: 'met' })),
  })
})

test('Given评审发现标准未满足 When解析 Then必须附带可执行 finding', () => {
  expect(parseOwnerTechnicalReviewResponse(response('changes_requested'), criteria)).toMatchObject({ verdict: 'changes_requested' })
  expect(() => parseOwnerTechnicalReviewResponse(response('changes_requested', { findings: [] }), criteria)).toThrow()
})

test('Given标准未逐项覆盖或存在未验证项 When输出approved Then拒绝通过建议', () => {
  expect(() => parseOwnerTechnicalReviewResponse(response('approved', { criteria: [] }), criteria)).toThrow()
  expect(() => parseOwnerTechnicalReviewResponse(response('approved', {
    criteria: [
      { criterion: criteria[0], status: 'met', evidence: 'ok' },
      { criterion: criteria[1], status: 'not_verified', evidence: '未运行' },
    ],
  }), criteria)).toThrow()
})

test('Given非法/多余字段、无效 verdict 或超长响应 When解析 Then fail-closed', () => {
  expect(() => parseOwnerTechnicalReviewResponse('{"schemaVersion":1,"verdict":"pass"}', criteria)).toThrow()
  expect(() => parseOwnerTechnicalReviewResponse(response('approved', { injected: true }), criteria)).toThrow()
  expect(() => parseOwnerTechnicalReviewResponse('x'.repeat(100_001), criteria)).toThrow()
})

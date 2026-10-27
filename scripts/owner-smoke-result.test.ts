import { expect, test } from 'bun:test'
import { assertOwnerSmokeResult } from './owner-smoke-result'
import { OWNER_2048_SMOKE_CHECKS } from '../apps/electron/src/main/lib/owner-2048-smoke-contract'

test('Given平台与员工均completed但正式验证失败或评审未落库 When判定 Then业务冒烟失败', () => {
  expect(() => assertOwnerSmokeResult({ status: 'completed', reviewer: { status: 'completed', recorded: false }, validations: [{ status: 'failed' }] }, 'development')).toThrow('业务冒烟未通过')
  expect(() => assertOwnerSmokeResult({ status: 'completed', reviewer: { recorded: true, verdict: 'approved' }, validations: [] }, 'development')).toThrow('正式研发验证')
})

test('Given2048运行检查通过但Owner未验收或未交付 When判定完整项目 Then不能沿用分段绿灯', () => {
  const report = { status: 'completed', reviewer: { recorded: true, verdict: 'approved' }, validations: [{ status: 'passed' }],
    ownerPlan: { confirmed: true, generatedByOwner: true }, ownerAssignment: { reviewerChosen: true },
    checks: OWNER_2048_SMOKE_CHECKS.map(id => ({ id, status: 'passed' })), ownerQualityState: 'accepted', deliveryState: 'delivered' }
  expect(() => assertOwnerSmokeResult(report, 'project-2048')).not.toThrow()
  expect(() => assertOwnerSmokeResult({ ...report, ownerQualityState: 'not_checked' }, 'project-2048')).toThrow('真实质量验收')
  expect(() => assertOwnerSmokeResult({ ...report, deliveryState: 'not_checked' }, 'project-2048')).toThrow('交付')
  expect(() => assertOwnerSmokeResult({ ...report, checks: report.checks.slice(0, -1) }, 'project-2048')).toThrow('七项')
  expect(() => assertOwnerSmokeResult({ ...report, checks: [...report.checks.slice(1), report.checks[1]] }, 'project-2048')).toThrow('七项')
})

test('Given正式验证通过且准确评审已保存 When判定 Then只放行当前分段冒烟', () => {
  expect(() => assertOwnerSmokeResult({ status: 'completed', reviewer: { recorded: true, verdict: 'approved' }, validations: [{ status: 'passed' }], ownerQualityState: 'not_checked', deliveryState: 'not_checked' }, 'development')).not.toThrow()
})

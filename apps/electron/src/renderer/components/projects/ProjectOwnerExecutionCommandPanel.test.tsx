import { expect, test } from 'bun:test'
import { getOwnerExecutionNextActionLabel } from './ProjectOwnerExecutionCommandPanel'

test('Given Owner Scheduler 的各类下一步状态 When生成UI文案 Then区分后台动作、有限返工与人工业务验收', () => {
  expect(getOwnerExecutionNextActionLabel('execute')).toBe('安排执行')
  expect(getOwnerExecutionNextActionLabel('review')).toBe('安排技术评审')
  expect(getOwnerExecutionNextActionLabel('rework')).toBe('授权范围内有限返工')
  expect(getOwnerExecutionNextActionLabel('await_business_acceptance')).toBe('等待人工业务验收')
  expect(getOwnerExecutionNextActionLabel('human_decision')).toBe('等待人工决策/处理')
})

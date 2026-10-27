import { expect, test } from 'bun:test'
import { assertOwnerPlanningRequestEnvelope, OWNER_PLANNING_V6_MAX_REQUEST_BYTES } from './project-owner-planning-envelope'

test('Given GLM v6请求接近包络 When发送准入 Then按UTF8字节拒绝超限且不截断', () => {
  expect(() => assertOwnerPlanningRequestEnvelope('a'.repeat(OWNER_PLANNING_V6_MAX_REQUEST_BYTES), 'glm-5.3-flash', 'zhipu')).not.toThrow()
  expect(() => assertOwnerPlanningRequestEnvelope('a'.repeat(OWNER_PLANNING_V6_MAX_REQUEST_BYTES + 1), 'glm-5.3-flash', 'zhipu')).toThrow('64KiB')
  expect(() => assertOwnerPlanningRequestEnvelope('中'.repeat(50_000), 'glm-5.3', 'zhipu')).toThrow('64KiB')
  expect(() => assertOwnerPlanningRequestEnvelope('中'.repeat(50_000), 'deepseek-flash', 'deepseek')).not.toThrow()
})

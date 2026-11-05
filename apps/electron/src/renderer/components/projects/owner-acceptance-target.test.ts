import { expect, test } from 'bun:test'
import type { OwnerExecutionAutonomousScheduleStatus, OwnerExecutionCommandView, ProjectChain, ProjectDeliverable } from '@gravitas/shared'
import { findOwnerAcceptanceTarget } from './owner-acceptance-target'

test('Given 待验收任务 When 精确执行和交付版本唯一匹配 Then 返回该交付，否则不推断', () => {
  const schedule = { projectId: 'p', grantId: 'g', taskId: 't', reworkOrdinal: 1, state: 'waiting', nextAction: 'await_business_acceptance' } as OwnerExecutionAutonomousScheduleStatus
  const command = { grantId: 'g', taskId: 't', reworkOrdinal: 1, role: 'executor', state: 'settled', executionStatus: 'completed', executionId: 'run' } as OwnerExecutionCommandView
  const draft = { id: 'delivery', taskId: 't', executionId: 'run', status: 'submitted' } as ProjectDeliverable
  const chain = { drafts: [draft] } as ProjectChain
  expect(findOwnerAcceptanceTarget(chain, schedule, [command])).toBe(draft)
  expect(findOwnerAcceptanceTarget(chain, schedule, [{ ...command, grantId: 'other' }])).toBeUndefined()
  expect(findOwnerAcceptanceTarget(chain, schedule, [{ ...command, executionStatus: 'running' }])).toBeUndefined()
  expect(findOwnerAcceptanceTarget(chain, schedule, [{ ...command, reworkOrdinal: 0 }])).toBeUndefined()
  expect(findOwnerAcceptanceTarget({ ...chain, drafts: [draft, { ...draft, id: 'another' }] }, schedule, [command])).toBeUndefined()
  expect(findOwnerAcceptanceTarget(chain, { ...schedule, nextAction: 'human_decision' }, [command])).toBeUndefined()
})

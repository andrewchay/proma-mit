import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, rmSync } from 'node:fs'
import type { WorkflowDefinition } from '@gravitas/shared'
import { getWorkflowIdentityDirectory, resolveWorkflowApprovalAssignees, saveWorkflowIdentityDirectory } from './workflow-identity-service'

const TEST_DIR = '/tmp/paa-workflow-identity-test'
const definition = { publication: { version: '1.0.0', publishedAt: 1, publishedBy: 'owner' } } as WorkflowDefinition

describe('Workflow 审批身份目录', () => {
  beforeAll(() => { process.env.PROMA_TEST_CONFIG_DIR = TEST_DIR; rmSync(TEST_DIR, { recursive: true, force: true }); mkdirSync(TEST_DIR, { recursive: true }) })
  beforeEach(() => { rmSync(TEST_DIR, { recursive: true, force: true }); mkdirSync(TEST_DIR, { recursive: true }) })
  afterAll(() => { rmSync(TEST_DIR, { recursive: true, force: true }); delete process.env.PROMA_TEST_CONFIG_DIR })

  test('Given no configured directory When read Then it provides a safe local principal', () => {
    expect(getWorkflowIdentityDirectory().users).toEqual([{ id: 'local-user', displayName: '本地用户', roleIds: [], enabled: true }])
  })

  test('Given named users and role When resolving approval Then it freezes enabled members only', () => {
    saveWorkflowIdentityDirectory({
      users: [{ id: 'owner', displayName: 'Owner', roleIds: [], enabled: true }, { id: 'reviewer', displayName: 'Reviewer', roleIds: ['finance'], enabled: true }, { id: 'disabled', displayName: 'Disabled', roleIds: ['finance'], enabled: false }],
      roles: [{ id: 'finance', name: '财务', memberIds: ['reviewer', 'disabled'] }],
    })
    expect(resolveWorkflowApprovalAssignees(definition, { assigneePolicy: 'workflow_owner', onTimeout: 'fail' })).toEqual(['owner'])
    expect(resolveWorkflowApprovalAssignees(definition, { assigneePolicy: 'named_users', assigneeIds: ['reviewer', 'disabled'], onTimeout: 'fail' })).toEqual(['reviewer'])
    expect(resolveWorkflowApprovalAssignees(definition, { assigneePolicy: 'role', roleId: 'finance', onTimeout: 'fail' })).toEqual(['reviewer'])
  })
})

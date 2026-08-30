import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAgentWorkspace, createApprovedWorkspaceSkill } from './agent-workspace-manager'
import { getWorkspaceSkillsDir } from './config-paths'
import { approveApproval, createSkillApproval, setApprovedChangeExecutor } from './approval-service'
import { executeApprovedChange } from './proactive-approved-change-executor'

const previousConfigDir = process.env.PROMA_TEST_CONFIG_DIR
const configDir = await mkdtemp(join(tmpdir(), 'gravitas-proactive-approved-skill-'))
process.env.PROMA_TEST_CONFIG_DIR = configDir

afterAll(async () => {
  if (previousConfigDir === undefined) delete process.env.PROMA_TEST_CONFIG_DIR
  else process.env.PROMA_TEST_CONFIG_DIR = previousConfigDir
  await rm(configDir, { recursive: true, force: true })
})

beforeEach(async () => {
  await rm(configDir, { recursive: true, force: true })
  setApprovedChangeExecutor((approval) => executeApprovedChange(approval, { createSchedule: () => {} }))
})

describe('Proactive approved Skill creation', () => {
  test('given an approved workspace target when a Skill is created then it is atomically installed only under that workspace', async () => {
    const workspace = createAgentWorkspace('审批目标')
    const created = createApprovedWorkspaceSkill(workspace.id, '发布检查', '# 发布检查\n\n确认 CI 后发布。')
    const content = await readFile(join(getWorkspaceSkillsDir(workspace.slug), created.slug, 'SKILL.md'), 'utf-8')

    expect(created.enabled).toBeTrue()
    expect(content).toContain('generated_by: proactive-approval')
    expect(content).toContain('确认 CI 后发布。')
    expect(() => createApprovedWorkspaceSkill(workspace.id, '发布检查', '重复内容')).toThrow('已存在同名 Skill')
  })

  test('given a missing workspace when a Skill approval executes then it fails without creating a filesystem target', () => {
    expect(() => createApprovedWorkspaceSkill('missing-workspace', 'safe-skill', '内容')).toThrow('目标工作区不存在')
  })

  test('given a confirmed Skill approval when it executes then the workspace install and approval outcome are both persisted', async () => {
    const workspace = createAgentWorkspace('审批闭环')
    const approval = createSkillApproval(undefined, workspace.id, 'release-check', '# 发布检查\n\n确认 CI 后发布。')

    const resolved = await approveApproval(approval.id)

    expect(resolved).toEqual(expect.objectContaining({ status: 'approved', executionStatus: 'succeeded' }))
    expect(await readFile(join(getWorkspaceSkillsDir(workspace.slug), 'release-check', 'SKILL.md'), 'utf-8')).toContain('确认 CI 后发布。')
  })
})

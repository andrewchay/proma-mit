import { afterAll, beforeAll, expect, mock, test } from 'bun:test'
import * as fs from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
const directory = fs.mkdtempSync(join(tmpdir(), 'owner-preparation-file-fault-'))
const previous = process.env.PROMA_TEST_CONFIG_DIR
process.env.PROMA_TEST_CONFIG_DIR = directory
const realRename = fs.renameSync
let failPolicyReplace = false
mock.module('node:fs', () => ({
  ...fs,
  renameSync: (from: fs.PathLike, to: fs.PathLike) => {
    if (failPolicyReplace && String(to) === join(directory, 'project-pilot-policies.json'))
      throw new Error('injected JSON replace failure')
    return realRename(from, to)
  },
}))
const store = await import('./project-sqlite-store')
const policy = await import('./project-pilot-policy')
const { assertNoOwnerExecutionPreparation } = await import(
  './project-owner-execution-preparation-evidence'
)
beforeAll(async () => {
  await store.initProjectDb()
})
afterAll(() => {
  store.closeProjectDb()
  if (previous === undefined) delete process.env.PROMA_TEST_CONFIG_DIR
  else process.env.PROMA_TEST_CONFIG_DIR = previous
  fs.rmSync(directory, { recursive: true, force: true })
})
test('Given 证据先提交 When JSON原子替换失败 Then 孤立证据保留、零grant、不能回退legacy', () => {
  const project = store.createProject({ title: '故障隔离fixture', description: '' })
  const input = {
    workspaceId: 'fixture',
    employeeIds: ['executor', 'reviewer'],
    executorEmployeeId: 'executor',
    reviewerEmployeeId: 'reviewer',
    channelId: 'fake',
    modelId: 'fake',
    maxCostMicros: 1,
    maxRuns: 1,
    maxRework: 0,
    expiresAt: Date.now() + 100000,
  }
  failPolicyReplace = true
  try {
    expect(() =>
      policy.saveOwnerPreparationPolicy(project.id, null, () => {
        // 只验证跨存储故障窗口的本地fixture，不假称正式业务准备或授权。
        store
          .getProjectDb()
          .prepare(
            'INSERT INTO project_owner_execution_preparations (id,project_id,revision,request_id,payload,integrity_hash) VALUES (?,?,1,?,?,?)',
          )
          .run('fault-evidence', project.id, 'fault-request', '{}', 'a'.repeat(64))
        return {
          input,
          reference: {
            schemaVersion: 1,
            purpose: 'owner_business_execution_preparation',
            id: 'fault-evidence',
            revision: 1,
            integrityHash: 'a'.repeat(64),
            stage: 'pending_task_links',
          },
        }
      }),
    ).toThrow('injected JSON replace failure')
    expect(policy.getPilotPolicy(project.id)).toBeNull()
    expect(
      store
        .getProjectDb()
        .prepare('SELECT id FROM project_owner_execution_preparations WHERE project_id=?')
        .get(project.id),
    ).toEqual({ id: 'fault-evidence' })
    expect(() => assertNoOwnerExecutionPreparation(project.id)).toThrow('Owner')
    expect(() => policy.savePilotPolicyDraft(project.id, input, null)).toThrow('Owner')
    expect(
      store.getProjectDb().prepare('SELECT COUNT(*) AS c FROM pilot_runtime_grants').get(),
    ).toEqual({ c: 0 })
  } finally {
    failPolicyReplace = false
  }
})

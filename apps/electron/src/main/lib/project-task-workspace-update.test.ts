import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeProjectDb, confirmTaskDraft, createProject, createTask, createTaskDraft, getTask, initProjectDb, updateTask } from './project-sqlite-store'
import { onTaskChange, updateTask as updateTaskFromService, type TaskChangedFields } from './project-service'

const dir = mkdtempSync(join(tmpdir(), 'pilot-task-workspace-'))
const previous = process.env.PROMA_TEST_CONFIG_DIR
beforeAll(async () => { process.env.PROMA_TEST_CONFIG_DIR = dir; await initProjectDb() })
afterAll(() => {
  closeProjectDb()
  if (previous === undefined) delete process.env.PROMA_TEST_CONFIG_DIR
  else process.env.PROMA_TEST_CONFIG_DIR = previous
  rmSync(dir, { recursive: true, force: true })
})

test('Given 已绑定工作区的任务 When 修改、重开并清空绑定 Then 权威任务保持一致', async () => {
  const project = createProject({ title: '任务工作区更新', description: '' })
  const task = createTask(project.id, { title: '研发任务', description: '', workspaceId: 'workspace-a' })
  expect(updateTask(task.id, { workspaceId: 'workspace-b' })?.workspaceId).toBe('workspace-b')
  expect(getTask(task.id)?.workspaceId).toBe('workspace-b')
  closeProjectDb(); await initProjectDb()
  expect(getTask(task.id)?.workspaceId).toBe('workspace-b')
  expect(updateTask(task.id, { title: '不修改工作区' })?.workspaceId).toBe('workspace-b')
  const fields: Array<TaskChangedFields | undefined> = []
  const unsubscribe = onTaskChange((changed, action, context) => {
    if (action === 'updated' && changed?.id === task.id) fields.push(context?.changedFields)
  })
  try {
    expect((await updateTaskFromService(task.id, { workspaceId: undefined }))?.workspaceId).toBeUndefined()
    expect(fields).toEqual([{ workspaceId: true }])
  } finally {
    unsubscribe()
  }
  expect(getTask(task.id)?.workspaceId).toBeUndefined()
  closeProjectDb(); await initProjectDb()
  expect(getTask(task.id)?.workspaceId).toBeUndefined()
  expect(updateTask(task.id, { workspaceId: 'workspace-c' })?.workspaceId).toBe('workspace-c')
  expect(getTask(task.id)?.workspaceId).toBe('workspace-c')
  const draft = createTaskDraft(project.id, { title: '草稿任务', description: '', workspaceId: 'workspace-d' })
  expect(draft.workspaceId).toBe('workspace-d')
  expect(confirmTaskDraft(draft.id)?.workspaceId).toBe('workspace-d')
})

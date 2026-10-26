import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Provider, createStore } from 'jotai'
import { taskOwnerGoalSubjectAtom } from '../../atoms/task-owner-goal-entry-atoms'
import { ownerGoalApiAtom } from '../../atoms/project-owner-goal-atoms'
import { TaskOwnerGoalEntry } from './TaskOwnerGoalEntry'

const originalConfig = process.env.PROMA_TEST_CONFIG_DIR
const directory = mkdtempSync(join(tmpdir(), 'task-owner-goal-entry-'))
beforeAll(() => { process.env.PROMA_TEST_CONFIG_DIR = directory })
afterAll(() => {
  if (originalConfig === undefined) delete process.env.PROMA_TEST_CONFIG_DIR
  else process.env.PROMA_TEST_CONFIG_DIR = originalConfig
  rmSync(directory, { recursive: true, force: true })
})

test('Given 普通无配置任务 When 渲染入口 Then 可打开目标且不读取或保存草案', () => {
  let reads = 0
  let writes = 0
  const store = createStore()
  store.set(ownerGoalApiAtom, {
    getOwnerGoalDraft: async () => { reads++; return { ok: true, value: null } },
    saveOwnerGoalDraft: async () => { writes++; throw new Error('禁止自动保存') },
  })
  const html = renderToStaticMarkup(createElement(Provider, { store },
    createElement(TaskOwnerGoalEntry, { projectId: 'p', taskId: 'normal', taskTitle: '普通任务' })))
  expect(html).toContain('目标草案')
  expect(html).toContain('aria-haspopup="dialog"')
  expect(html).not.toContain('textarea')
  expect(reads).toBe(0)
  expect(writes).toBe(0)
})

test('Given 项目/任务身份 When 切换选择 Then Jotai 只保存单一当前主体', () => {
  const store = createStore()
  expect(store.get(taskOwnerGoalSubjectAtom)).toBeNull()
  store.set(taskOwnerGoalSubjectAtom, { projectId: 'p', taskId: 'a' })
  store.set(taskOwnerGoalSubjectAtom, { projectId: 'q', taskId: 'b' })
  expect(store.get(taskOwnerGoalSubjectAtom)).toEqual({ projectId: 'q', taskId: 'b' })
  store.set(taskOwnerGoalSubjectAtom, null)
  expect(store.get(taskOwnerGoalSubjectAtom)).toBeNull()
})

test('Given 真实 TaskItem When 接入目标入口 Then 不受员工或工作区条件限制且保持已有操作', () => {
  const source = readFileSync(new URL('./ProjectView.tsx', import.meta.url), 'utf8')
  const item = source.slice(source.indexOf('function TaskItem('))
  expect(item).toContain('<TaskOwnerGoalEntry projectId={task.projectId} taskId={task.id} taskTitle={task.title} />')
  expect(item).toContain('onClick={handleAssessRisk}')
  expect(item).toContain('handleStopAgentExecution()')
  expect(item).toContain('setShowEditModal(true)')
})

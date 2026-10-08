import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  closeProjectDb, createProject, createTask, deleteProject, deleteTask,
  getProject, getProjectDb, initProjectDb, listTasks,
} from './project-sqlite-store'
import { onTaskChange } from './project-service'
import { onProjectChainChange } from './project-chain-service'
import {
  getProjectOwnerGoalDraft, listProjectOwnerGoalHistory, saveProjectOwnerGoalDraft,
} from './project-owner-goal-service'

const directory = mkdtempSync(join(tmpdir(), 'gravitas-owner-goal-'))
const previous = process.env.PROMA_TEST_CONFIG_DIR
beforeAll(async () => { process.env.PROMA_TEST_CONFIG_DIR = directory; await initProjectDb() })
afterAll(() => {
  closeProjectDb()
  if (previous === undefined) delete process.env.PROMA_TEST_CONFIG_DIR
  else process.env.PROMA_TEST_CONFIG_DIR = previous
  rmSync(directory, { recursive: true, force: true })
})
const objective = { objective: '形成一份可评审的定位方案' }
function project() { return createProject({ title: 'Owner 草案夹具', description: '原说明不变' }) }
function count(table: string): number {
  return (getProjectDb().prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c
}

test('Given 仅目标 When 读取及首次保存 Then 不要求仓库/员工且版本由服务生成', () => {
  const p = project()
  expect(getProjectOwnerGoalDraft(p.id)).toBeNull()
  expect(listProjectOwnerGoalHistory(p.id)).toEqual([])
  const before = count('project_owner_revisions')
  const draft = saveProjectOwnerGoalDraft(p.id, 0, objective)
  expect(draft).toMatchObject({ schemaVersion: 1, revision: 1, state: 'draft', actor: 'local-user', goal: { projectId: p.id, goalVersion: 1, ...objective, constraints: [], acceptanceCriteria: [] } })
  expect(count('project_owner_revisions')).toBe(before + 1)
  expect(draft).not.toHaveProperty('grantId')
})

test('Given 同项目的项目/两个任务目标 When 保存 Then 版本和内容各自隔离', () => {
  const p = project(); const first = createTask(p.id, { title: 'A', description: '' }); const second = createTask(p.id, { title: 'B', description: '' })
  saveProjectOwnerGoalDraft(p.id, 0, objective)
  const taskDraft = saveProjectOwnerGoalDraft(p.id, 0, { objective: '完成任务 A 的成果' }, first.id)
  saveProjectOwnerGoalDraft(p.id, 0, { objective: '完成任务 B 的成果' }, second.id)
  expect(taskDraft.goal.taskId).toBe(first.id)
  expect(getProjectOwnerGoalDraft(p.id)?.goal.taskId).toBeUndefined()
  expect(getProjectOwnerGoalDraft(p.id, second.id)?.goal.objective).toBe('完成任务 B 的成果')
  expect(listProjectOwnerGoalHistory(p.id, first.id)).toHaveLength(1)
})

test('Given 不存在或跨项目的任务 When 读写 Then 拒绝而不静默降级到项目目标', () => {
  const p = project(); const other = project(); const task = createTask(other.id, { title: '其他项目任务', description: '' })
  for (const id of ['missing-task', task.id, ' ']) {
    expect(() => saveProjectOwnerGoalDraft(p.id, 0, objective, id)).toThrow()
    expect(() => getProjectOwnerGoalDraft(p.id, id)).toThrow()
    expect(() => listProjectOwnerGoalHistory(p.id, id)).toThrow()
  }
  expect(() => saveProjectOwnerGoalDraft('missing-project', 0, objective)).toThrow('项目')
  expect(getProjectOwnerGoalDraft(p.id)).toBeNull()
})

test('Given 草案已保存 When 两个旧版本写入 Then 只允许当前版本推进且历史不覆盖', () => {
  const p = project(); saveProjectOwnerGoalDraft(p.id, 0, objective)
  const next = saveProjectOwnerGoalDraft(p.id, 1, { objective: '修订目标' })
  expect(next.revision).toBe(2); expect(next.goal.goalVersion).toBe(2)
  expect(() => saveProjectOwnerGoalDraft(p.id, 1, { objective: '覆盖新目标' })).toThrow('已更新')
  expect(listProjectOwnerGoalHistory(p.id).map((item) => item.goal.objective)).toEqual(['形成一份可评审的定位方案', '修订目标'])
})

test('Given 内容相同 When 当前版本重复保存 Then 不制造新版本；旧版本仍拒绝', () => {
  const p = project(); const first = saveProjectOwnerGoalDraft(p.id, 0, objective)
  const again = saveProjectOwnerGoalDraft(p.id, 1, { objective: `  ${objective.objective}  `, constraints: [], acceptanceCriteria: [] })
  expect(again).toEqual(first)
  expect(listProjectOwnerGoalHistory(p.id)).toHaveLength(1)
  expect(() => saveProjectOwnerGoalDraft(p.id, 0, objective)).toThrow('已更新')
})

test('Given 目标正文未变 When 约束或标准改变 Then 也产生新的目标版本', () => {
  const p = project(); saveProjectOwnerGoalDraft(p.id, 0, objective)
  const second = saveProjectOwnerGoalDraft(p.id, 1, { ...objective, constraints: ['不发布'] })
  const third = saveProjectOwnerGoalDraft(p.id, 2, { ...objective, constraints: ['不发布'], acceptanceCriteria: ['有备选'] })
  expect(second.goal.goalVersion).toBe(2); expect(third.goal.goalVersion).toBe(3)
  expect(listProjectOwnerGoalHistory(p.id)).toHaveLength(3)
})

test('Given 非法输入/版本/客户端身份或授权 When 保存 Then 拒绝且不留下历史', () => {
  const p = project()
  for (const input of [null, [], { objective: ' ' }, { ...objective, goalVersion: 100 }, { ...objective, projectId: p.id }, { ...objective, taskId: 'fake' }, { ...objective, actor: 'system' }, { ...objective, grantId: 'fake' }, { ...objective, constraints: null }]) {
    expect(() => saveProjectOwnerGoalDraft(p.id, 0, input)).toThrow()
  }
  for (const version of [-1, 1.5, NaN, Number.MAX_SAFE_INTEGER + 1]) {
    expect(() => saveProjectOwnerGoalDraft(p.id, version, objective)).toThrow()
  }
  expect(listProjectOwnerGoalHistory(p.id)).toEqual([])
})

test('Given 草案返回副本 When 调用方修改数组 Then 不改已保存历史', () => {
  const p = project(); const saved = saveProjectOwnerGoalDraft(p.id, 0, objective)
  saved.goal.constraints.push('伪造约束')
  const history = listProjectOwnerGoalHistory(p.id); history[0]!.goal.acceptanceCriteria.push('伪造标准')
  expect(getProjectOwnerGoalDraft(p.id)?.goal.constraints).toEqual([])
  expect(getProjectOwnerGoalDraft(p.id)?.goal.acceptanceCriteria).toEqual([])
})

test('Given 草案保存 When 外层事务回滚 Then 不留下历史或半版本', () => {
  const p = project()
  expect(() => getProjectDb().transaction(() => {
    saveProjectOwnerGoalDraft(p.id, 0, objective)
    throw new Error('外层回滚')
  })()).toThrow('外层回滚')
  expect(getProjectOwnerGoalDraft(p.id)).toBeNull()
  expect(saveProjectOwnerGoalDraft(p.id, 0, objective).revision).toBe(1)
})

test('Given 已有任务 When 保存草案 Then 不产生候选/执行/授权/项目链或派发事件', async () => {
  const p = project(); createTask(p.id, { title: '原任务', description: '' })
  const tables = ['tasks', 'agent_executions', 'pilot_intents', 'pilot_commands', 'pilot_runtime_grants', 'project_chain_revisions']
  const before = tables.map(count)
  const events: string[] = []
  const stopTasks = onTaskChange(() => events.push('task'))
  const stopChain = onProjectChainChange(() => events.push('chain'))
  try {
    saveProjectOwnerGoalDraft(p.id, 0, objective)
    await Promise.resolve()
    expect(tables.map(count)).toEqual(before); expect(events).toEqual([])
    expect(listTasks(p.id)).toHaveLength(1); expect(getProject(p.id)?.description).toBe('原说明不变')
  } finally { stopTasks(); stopChain() }
})

test('Given 保存过的草案 When 关闭重开数据库 Then 当前版本及历史仍在', async () => {
  const p = project(); saveProjectOwnerGoalDraft(p.id, 0, objective)
  saveProjectOwnerGoalDraft(p.id, 1, { ...objective, constraints: ['只用授权资料'] })
  closeProjectDb(); await initProjectDb()
  expect(getProjectOwnerGoalDraft(p.id)?.revision).toBe(2)
  expect(listProjectOwnerGoalHistory(p.id)).toHaveLength(2)
})

test('Given 删除任务/项目 When 访问草案 Then 保留历史但拒绝对失效主体继续读写', () => {
  const p = project(); const task = createTask(p.id, { title: '待删除夹具', description: '' })
  saveProjectOwnerGoalDraft(p.id, 0, objective, task.id)
  saveProjectOwnerGoalDraft(p.id, 0, objective)
  deleteTask(task.id)
  expect(() => getProjectOwnerGoalDraft(p.id, task.id)).toThrow()
  expect(() => saveProjectOwnerGoalDraft(p.id, 1, objective, task.id)).toThrow()
  deleteProject(p.id)
  expect(() => getProjectOwnerGoalDraft(p.id)).toThrow()
  const rows = getProjectDb().prepare('SELECT revision FROM project_owner_revisions WHERE project_id = ?').all(p.id)
  expect(rows).toHaveLength(2)
})

test('Given 草案记录损坏或冒充其他主体 When 读取 Then 拒绝且不静默补造草案', () => {
  const p = project(); const saved = saveProjectOwnerGoalDraft(p.id, 0, objective)
  getProjectDb().prepare('UPDATE project_owner_revisions SET payload = ? WHERE project_id = ?')
    .run(JSON.stringify({ ...saved, goal: { ...saved.goal, projectId: 'other-project' } }), p.id)
  expect(() => getProjectOwnerGoalDraft(p.id)).toThrow('身份不匹配')
  expect(() => saveProjectOwnerGoalDraft(p.id, 1, objective)).toThrow()
  getProjectDb().prepare('UPDATE project_owner_revisions SET payload = ? WHERE project_id = ?')
    .run(JSON.stringify({ ...saved, state: 'active' }), p.id)
  expect(() => getProjectOwnerGoalDraft(p.id)).toThrow('记录格式无效')
  expect(getProjectDb().prepare('SELECT revision FROM project_owner_revisions WHERE project_id = ?').all(p.id)).toHaveLength(1)
})

test('Given 相同项目主体版本 When 底层重复追加 Then 数据库主键拒绝覆盖', () => {
  const p = project(); const saved = saveProjectOwnerGoalDraft(p.id, 0, objective)
  expect(() => getProjectDb().prepare('INSERT INTO project_owner_revisions (project_id, subject_key, revision, payload) VALUES (?, ?, ?, ?)')
    .run(p.id, 'project', 1, JSON.stringify(saved))).toThrow()
  expect(listProjectOwnerGoalHistory(p.id)).toHaveLength(1)
})

test('Given 老库缺新表 When 初始化迁移 Then 原项目任务保留且新草案可保存', async () => {
  const p = project(); const task = createTask(p.id, { title: '原任务迁移夹具', description: '' })
  getProjectDb().exec('DROP TABLE project_owner_revisions')
  closeProjectDb(); await initProjectDb()
  expect(getProject(p.id)?.title).toBe('Owner 草案夹具')
  expect(listTasks(p.id).map((item) => item.id)).toContain(task.id)
  expect(getProjectOwnerGoalDraft(p.id)).toBeNull()
  expect(saveProjectOwnerGoalDraft(p.id, 0, objective).revision).toBe(1)
})

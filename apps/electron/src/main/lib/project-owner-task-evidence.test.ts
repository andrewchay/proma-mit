import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const directory = mkdtempSync(join(tmpdir(), 'owner-business-evidence-'))
const previous = process.env.PROMA_TEST_CONFIG_DIR
process.env.PROMA_TEST_CONFIG_DIR = directory
const store = await import('./project-sqlite-store')
let evidence: typeof import('./project-owner-task-evidence')
beforeAll(async () => {
  await store.initProjectDb()
  evidence = await import('./project-owner-task-evidence')
})
afterAll(() => {
  store.closeProjectDb()
  if (previous === undefined) delete process.env.PROMA_TEST_CONFIG_DIR
  else process.env.PROMA_TEST_CONFIG_DIR = previous
  rmSync(directory, { recursive: true, force: true })
})

test('Given 同项目无关任务 When Owner任务存在 Then 不以项目membership扩大限制', () => {
  const project = store.createProject({ title: '用途隔离fixture', description: '' })
  const owner = store.createTask(project.id, { title: '业务步骤', description: '' })
  const ordinary = store.createTask(project.id, { title: '无关普通任务', description: '' })
  store.getProjectDb().prepare("UPDATE tasks SET owner_step_link_id='broken-marker' WHERE id=?").run(owner.id)
  expect(evidence.hasOwnerBusinessTaskEvidence(owner.id)).toBe(true)
  expect(evidence.hasOwnerBusinessTaskEvidence(ordinary.id)).toBe(false)
  expect(() => evidence.assertNoOwnerBusinessTask(owner.id)).toThrow('Owner')
  expect(() => evidence.assertNoOwnerBusinessTask(ordinary.id)).not.toThrow()
})

test('Given 空字符串残余marker When 判断 Then 非NULL用途不降为legacy', () => {
  const project = store.createProject({ title: '坏目的fixture', description: '' })
  const task = store.createTask(project.id, { title: '残余目的', description: '' })
  store.getProjectDb().prepare("UPDATE tasks SET owner_step_link_id='' WHERE id=?").run(task.id)
  expect(evidence.hasOwnerBusinessTaskEvidence(task.id)).toBe(true)
  expect(() => evidence.assertNoOwnerBusinessTask(task.id)).toThrow('Owner')
})

test('Given 只有indexed link且payload损坏 When 判断 Then 不降级legacy', () => {
  const project = store.createProject({ title: '关联残余fixture', description: '' })
  const task = store.createTask(project.id, { title: '有关联的任务', description: '' })
  store.getProjectDb().prepare(`INSERT INTO project_owner_task_step_links
    (id,materialization_id,project_id,subject_key,plan_fingerprint,step_key,task_id,payload,integrity_hash)
    VALUES (?,?,?,'project',?,'a',?,'broken','broken')`).run(crypto.randomUUID(), 'missing-batch', project.id, 'a'.repeat(64), task.id)
  expect(evidence.hasOwnerBusinessTaskEvidence(task.id)).toBe(true)
  expect(() => evidence.assertNoOwnerBusinessTask(task.id)).toThrow('Owner')
})

test('Given session先legacy后Owner关联 When 判断 Then 检查全部execution而非LIMIT1', () => {
  const project = store.createProject({ title: '会话复用fixture', description: '' })
  const first = store.createTask(project.id, { title: '普通任务', description: '' })
  const second = store.createTask(project.id, { title: '后来受限任务', description: '' })
  const sessionId = crypto.randomUUID()
  for (const task of [first, second]) store.createAgentExecution({ id: crypto.randomUUID(), projectId: project.id, entityType: 'task', entityId: task.id, agentId: 'fake-employee', sessionId, executor: 'headless', prompt: '只模拟已有账本，不调用Runner', status: 'running', startedAt: Date.now() })
  store.getProjectDb().prepare("UPDATE tasks SET owner_step_link_id='owner-purpose' WHERE id=?").run(second.id)
  expect(evidence.hasOwnerBusinessSessionEvidence(sessionId)).toBe(true)
  expect(() => evidence.assertNoOwnerBusinessSession(sessionId)).toThrow('Owner')
})

test('Given Owner业务残余 When 普通修改规格/状态/派工/删除 Then 不改变权威Task', () => {
  const project = store.createProject({ title: '任务边界fixture', description: '' })
  const task = store.createTask(project.id, { title: '暂停范围', description: '' })
  store.getProjectDb().prepare("UPDATE tasks SET owner_step_link_id='',status='paused' WHERE id=?").run(task.id)
  expect(() => store.updateTask(task.id, { status: 'pending' })).toThrow('Owner')
  expect(() => store.updateTask(task.id, { title: '变更计划投影' })).toThrow('Owner')
  expect(() => store.createAgentExecution({ id: crypto.randomUUID(), projectId: project.id, entityType: 'task', entityId: task.id, agentId: 'fake', sessionId: crypto.randomUUID(), executor: 'headless', prompt: '绝不启动' })).toThrow('Owner')
  expect(() => store.deleteTask(task.id)).toThrow('Owner')
  expect(() => store.updateTask(task.id, { status: 'cancelled' })).not.toThrow()
  expect(evidence.hasOwnerBusinessTaskEvidence(task.id)).toBe(true)
})

test('Given 两端之一Owner When 普通改依赖 Then 不能更换冻结闭包', () => {
  const project = store.createProject({ title: '依赖边界fixture', description: '' })
  const task = store.createTask(project.id, { title: '业务范围', description: '' })
  const ordinary = store.createTask(project.id, { title: '普通上游', description: '' })
  const edge = store.createTaskDependency(task.id, ordinary.id)
  store.getProjectDb().prepare("UPDATE tasks SET owner_step_link_id='broken' WHERE id=?").run(task.id)
  expect(() => store.createTaskDependency(ordinary.id, task.id)).toThrow('Owner')
  expect(() => store.deleteTaskDependency(edge.id)).toThrow('Owner')
})

test('Given 已观察Owner session When execution关系被部分清除 Then 保留负向用途', () => {
  const project = store.createProject({ title: '会话保全fixture', description: '' })
  const task = store.createTask(project.id, { title: '受限任务', description: '' })
  const sessionId = crypto.randomUUID(), executionId = crypto.randomUUID()
  store.createAgentExecution({ id: executionId, projectId: project.id, entityType: 'task', entityId: task.id, agentId: 'fake', sessionId, executor: 'headless', prompt: '既有异常账本fixture' })
  store.getProjectDb().prepare("UPDATE tasks SET owner_step_link_id='' WHERE id=?").run(task.id)
  expect(() => evidence.assertNoOwnerBusinessSession(sessionId)).toThrow('Owner')
  store.getProjectDb().prepare('UPDATE agent_executions SET session_id=? WHERE id=?').run('lost-session-reference', executionId)
  expect(evidence.hasOwnerBusinessSessionEvidence(sessionId)).toBe(true)
})

test('Given Owner parent When 普通reparent或draft Then 拒绝并禁止已有异常child继承旧入口', () => {
  const project = store.createProject({title:'父用途fixture',description:''}), parent = store.createTask(project.id,{title:'Owner',description:''}), child = store.createTask(project.id,{title:'普通',description:''})
  store.getProjectDb().prepare("UPDATE tasks SET owner_step_link_id='' WHERE id=?").run(parent.id)
  expect(() => store.updateTask(child.id,{parentId:parent.id})).toThrow('Owner')
  expect(() => store.createTaskDraft(project.id,{title:'draft',description:'',parentId:parent.id})).toThrow('Owner')
  store.getProjectDb().prepare('UPDATE tasks SET parent_id=? WHERE id=?').run(parent.id,child.id)
  expect(evidence.hasOwnerBusinessTaskEvidence(child.id)).toBe(true)
})
test('Given session限制原件 When Task直接关联损坏 Then Task/Execution仍限制，不能换session', () => {
  const project = store.createProject({title:'限制反向fixture',description:''}), task = store.createTask(project.id,{title:'任务',description:''}), sessionId = crypto.randomUUID(), id = crypto.randomUUID()
  store.createAgentExecution({id,projectId:project.id,entityType:'task',entityId:task.id,agentId:'fake',sessionId,prompt:'fixture',executor:'headless'})
  store.getProjectDb().prepare("UPDATE tasks SET owner_step_link_id='' WHERE id=?").run(task.id)
  expect(() => evidence.assertNoOwnerBusinessSession(sessionId)).toThrow('Owner')
  store.getProjectDb().prepare('UPDATE tasks SET owner_step_link_id=NULL WHERE id=?').run(task.id)
  expect(evidence.hasOwnerBusinessTaskEvidence(task.id)).toBe(true)
  expect(evidence.hasOwnerBusinessExecutionEvidence(id)).toBe(true)
  expect(() => store.updateAgentExecution(id,{sessionId:crypto.randomUUID(),status:'queued'})).toThrow('Owner')
})
test('Given draft/独立subTask的Owner残余 When confirm或重写spec Then 拒绝可执行状态', () => {
  const project = store.createProject({title:'草稿残余fixture',description:''}), task = store.createTaskDraft(project.id,{title:'draft',description:''})
  const normal = store.createTask(project.id,{title:'normal',description:''}), sub = store.createExecutionSubTask(normal.id,{title:'sub'})!
  store.getProjectDb().prepare("UPDATE tasks SET owner_step_link_id='' WHERE id IN (?,?)").run(task.id,normal.id)
  expect(() => store.confirmTaskDraft(task.id)).toThrow('Owner')
  expect(() => store.updateExecutionSubTask(sub.id,{status:'completed'})).toThrow('Owner')
})

test('Given 受限旧queue的空session When 同/跨项目普通queue Then 不把占位当共享身份', () => {
  const project = store.createProject({title:'空占位fixture',description:''}), owner = store.createTask(project.id,{title:'受限',description:''})
  const input = (task: ReturnType<typeof store.createTask>) => ({id:crypto.randomUUID(),projectId:task.projectId,entityType:'task' as const,entityId:task.id,agentId:'fake',sessionId:'',executor:'headless' as const,prompt:'queuedfixture'})
  const old = store.createAgentExecution(input(owner))
  store.getProjectDb().prepare("UPDATE tasks SET owner_step_link_id='' WHERE id=?").run(owner.id)
  const same = store.createTask(project.id,{title:'同项目无关',description:''}), otherProject = store.createProject({title:'跨项目',description:''}), other = store.createTask(otherProject.id,{title:'无关',description:''})
  expect(store.createAgentExecution(input(same)).status).toBe('queued')
  expect(store.createAgentExecution(input(other)).status).toBe('queued')
  expect(evidence.hasOwnerBusinessExecutionEvidence(old.id)).toBe(true)
  expect(() => evidence.assertNoOwnerBusinessExecution(old.id)).toThrow('Owner')
})

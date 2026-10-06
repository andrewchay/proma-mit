/** 项目内 Owner 目标草案。只追加规划记录，不触发模型/任务/项目链/授权事件。 */
import { prepareProjectOwnerGoalBrief, type ProjectOwnerGoalBrief } from './project-owner-planning'
import { getProject, getProjectDb, getTask } from './project-sqlite-store'

export interface ProjectOwnerGoalDraft {
  schemaVersion: 1
  revision: number
  state: 'draft'
  actor: 'local-user'
  savedAt: number
  goal: ProjectOwnerGoalBrief
}

interface GoalSubject {
  projectId: string
  taskId?: string
  subjectKey: string
}

interface GoalRow {
  revision: number
  payload: string
}

function assertSubject(projectId: string, taskId?: string): GoalSubject {
  if (typeof projectId !== 'string' || !projectId.trim() || !getProject(projectId)) {
    throw new Error('目标所属项目不存在')
  }
  if (taskId !== undefined) {
    if (typeof taskId !== 'string' || !taskId.trim()) throw new Error('目标任务身份无效')
    const task = getTask(taskId)
    if (!task || task.projectId !== projectId) throw new Error('目标任务不存在或不属于当前项目')
  }
  return { projectId, ...(taskId === undefined ? {} : { taskId }), subjectKey: taskId === undefined ? 'project' : `task:${taskId}` }
}

function parseRow(row: GoalRow, subject: GoalSubject): ProjectOwnerGoalDraft {
  const value = JSON.parse(row.payload) as Partial<ProjectOwnerGoalDraft>
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.schemaVersion !== 1 || value.state !== 'draft' || value.actor !== 'local-user'
    || value.revision !== row.revision || !Number.isSafeInteger(row.revision) || row.revision < 1
    || typeof value.savedAt !== 'number' || !Number.isSafeInteger(value.savedAt) || value.savedAt < 1
    || Object.keys(value).some((key) => !['schemaVersion', 'revision', 'state', 'actor', 'savedAt', 'goal'].includes(key))) {
    throw new Error('Owner 目标草案记录格式无效，请保留数据库并核查')
  }
  const goal = prepareProjectOwnerGoalBrief(value.goal)
  if (goal.projectId !== subject.projectId || goal.taskId !== subject.taskId) {
    throw new Error('Owner 目标草案记录与项目/任务身份不匹配')
  }
  return { schemaVersion: 1, revision: row.revision, state: 'draft', actor: 'local-user', savedAt: value.savedAt, goal }
}

function readCurrent(subject: GoalSubject): ProjectOwnerGoalDraft | null {
  const row = getProjectDb().prepare(`SELECT revision, payload FROM project_owner_revisions
    WHERE project_id = ? AND subject_key = ? ORDER BY revision DESC LIMIT 1`)
    .get(subject.projectId, subject.subjectKey) as GoalRow | undefined
  return row ? parseRow(row, subject) : null
}

/** 只读；没有草案返回 null，不隐式建记录，也不按内容推定执行状态。 */
export function getProjectOwnerGoalDraft(projectId: string, taskId?: string): ProjectOwnerGoalDraft | null {
  return readCurrent(assertSubject(projectId, taskId))
}

/** 返回独立快照，按修订升序；失效主体历史保留在数据库，不作为正常可操作入口。 */
export function listProjectOwnerGoalHistory(projectId: string, taskId?: string): ProjectOwnerGoalDraft[] {
  const subject = assertSubject(projectId, taskId)
  const rows = getProjectDb().prepare(`SELECT revision, payload FROM project_owner_revisions
    WHERE project_id = ? AND subject_key = ? ORDER BY revision ASC`)
    .all(subject.projectId, subject.subjectKey) as GoalRow[]
  return rows.map((row) => parseRow(row, subject))
}

function parseGoalInput(input: unknown, subject: GoalSubject, goalVersion: number): ProjectOwnerGoalBrief {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null)) {
    throw new Error('目标草案输入必须是 JSON 对象')
  }
  for (const key of Object.keys(input)) {
    if (!['objective', 'constraints', 'acceptanceCriteria'].includes(key)) throw new Error(`目标草案存在未知字段：${key}`)
  }
  return prepareProjectOwnerGoalBrief({
    ...input,
    projectId: subject.projectId,
    ...(subject.taskId === undefined ? {} : { taskId: subject.taskId }),
    goalVersion,
  })
}

function sameGoalContent(first: ProjectOwnerGoalBrief, second: ProjectOwnerGoalBrief): boolean {
  return first.objective === second.objective
    && JSON.stringify(first.constraints) === JSON.stringify(second.constraints)
    && JSON.stringify(first.acceptanceCriteria) === JSON.stringify(second.acceptanceCriteria)
}

/**
 * expectedRevision=0 仅用于首次保存。版本/actor 由服务确定，输入不得传入。
 * 同内容当前版本重试为 no-op；仍先拒绝旧版本，避免掩盖并发变更。
 */
export function saveProjectOwnerGoalDraft(
  projectId: string,
  expectedRevision: number,
  input: unknown,
  taskId?: string,
): ProjectOwnerGoalDraft {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new Error('草案版本参数无效')
  let result: ProjectOwnerGoalDraft | undefined
  getProjectDb().transaction(() => {
    const subject = assertSubject(projectId, taskId)
    const current = readCurrent(subject)
    if ((current?.revision ?? 0) !== expectedRevision) throw new Error('目标草案已更新，请刷新后重试')
    const goalVersion = (current?.goal.goalVersion ?? 0) + 1
    if (!Number.isSafeInteger(goalVersion) || !Number.isSafeInteger(expectedRevision + 1)) throw new Error('草案版本超出安全整数范围')
    const goal = parseGoalInput(input, subject, goalVersion)
    if (current && sameGoalContent(current.goal, goal)) {
      result = current
      return
    }
    result = {
      schemaVersion: 1,
      revision: expectedRevision + 1,
      state: 'draft',
      actor: 'local-user',
      savedAt: Date.now(),
      goal,
    }
    getProjectDb().prepare(`INSERT INTO project_owner_revisions (project_id, subject_key, revision, payload)
      VALUES (?, ?, ?, ?)`).run(projectId, subject.subjectKey, result.revision, JSON.stringify(result))
  })()
  if (!result) throw new Error('目标草案保存失败')
  return result
}

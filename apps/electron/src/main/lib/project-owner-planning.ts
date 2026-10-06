/**
 * AI Owner 规划输入边界：只产生简报/计划建议，不创建权威任务或执行授权。
 * 本模块无持久化与 Runtime 依赖；角色可用性须由调用方从权威目录提供。
 */
export interface ProjectOwnerGoalBrief {
  projectId: string
  /** 存在时表示单任务目标；缺省为项目目标，不自动创建任务。 */
  taskId?: string
  goalVersion: number
  objective: string
  constraints: string[]
  acceptanceCriteria: string[]
}

export interface ProjectOwnerPlanStep {
  /** 仅在本计划内标识依赖，不是权威任务 ID。 */
  key: string
  title: string
  outcome: string
  acceptanceCriteria: string[]
  dependencies: string[]
  /** 能力角色建议，不是已派发员工身份。 */
  roleKey: string
}

export interface ProjectOwnerPlanProposal {
  projectId: string
  taskId?: string
  goalVersion: number
  mode: 'proposal_only'
  summary: string
  assumptions: string[]
  risks: string[]
  steps: ProjectOwnerPlanStep[]
}

function record(input: unknown, fields: readonly string[], label: string): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null)) {
    throw new Error(`${label} 必须是 JSON 对象`)
  }
  for (const key of Object.keys(input)) {
    if (!fields.includes(key)) throw new Error(`${label} 存在未知字段：${key}`)
  }
  return input as Record<string, unknown>
}

function text(input: unknown, label: string, maxLength = 2000): string {
  if (typeof input !== 'string' || !input.trim() || input.length > maxLength) {
    throw new Error(`${label} 必须是非空文本，长度不超过 ${maxLength}`)
  }
  return input.trim()
}

function version(input: unknown): number {
  if (typeof input !== 'number' || !Number.isSafeInteger(input) || input < 1) {
    throw new Error('goalVersion 必须是正整数版本')
  }
  return input
}

function texts(input: unknown, label: string, minItems = 0, maxItems = 32): string[] {
  if (!Array.isArray(input) || input.length < minItems || input.length > maxItems) {
    throw new Error(`${label} 必须是数组，条数在 ${minItems}～${maxItems} 之间`)
  }
  const values = input.map((item) => text(item, label))
  if (new Set(values).size !== values.length) throw new Error(`${label} 不允许重复条目`)
  return values
}

/** 目标可以缺少标准/约束，留给 Owner 澄清或建议；不要求仓库和文件。 */
export function prepareProjectOwnerGoalBrief(input: unknown): ProjectOwnerGoalBrief {
  const value = record(input, ['projectId', 'taskId', 'goalVersion', 'objective', 'constraints', 'acceptanceCriteria'], '目标简报')
  return {
    projectId: text(value.projectId, 'projectId', 200),
    ...(value.taskId === undefined ? {} : { taskId: text(value.taskId, 'taskId', 200) }),
    goalVersion: version(value.goalVersion),
    objective: text(value.objective, 'objective', 12000),
    constraints: texts(value.constraints === undefined ? [] : value.constraints, 'constraints'),
    acceptanceCriteria: texts(value.acceptanceCriteria === undefined ? [] : value.acceptanceCriteria, 'acceptanceCriteria'),
  }
}

function parseStep(input: unknown, roles: ReadonlySet<string>): ProjectOwnerPlanStep {
  const value = record(input, ['key', 'title', 'outcome', 'acceptanceCriteria', 'dependencies', 'roleKey'], '计划步骤')
  const roleKey = text(value.roleKey, 'roleKey', 200)
  if (!roles.has(roleKey)) throw new Error(`计划使用了不可用角色：${roleKey}`)
  return {
    key: text(value.key, 'key', 200),
    title: text(value.title, 'title', 300),
    outcome: text(value.outcome, 'outcome'),
    acceptanceCriteria: texts(value.acceptanceCriteria, 'acceptanceCriteria', 1),
    dependencies: texts(value.dependencies, 'dependencies'),
    roleKey,
  }
}

function validateDependencies(steps: ProjectOwnerPlanStep[]): void {
  const byKey = new Map(steps.map((step) => [step.key, step]))
  if (byKey.size !== steps.length) throw new Error('计划存在重复任务 key')
  for (const step of steps) {
    for (const dependency of step.dependencies) {
      if (!byKey.has(dependency)) throw new Error(`依赖任务不存在：${dependency}`)
      if (dependency === step.key) throw new Error(`任务不能依赖自身：${step.key}`)
    }
  }
  const visiting = new Set<string>()
  const visited = new Set<string>()
  function visit(key: string): void {
    if (visiting.has(key)) throw new Error('计划存在循环依赖')
    if (visited.has(key)) return
    visiting.add(key)
    for (const dependency of byKey.get(key)!.dependencies) visit(dependency)
    visiting.delete(key)
    visited.add(key)
  }
  for (const step of steps) visit(step.key)
}

/**
 * 模型输出必须绑定当前简报；即使通过结构校验，仍不得据此派发。
 * 项目存在性、最新版本、角色/权限/预算均须在后续权威服务中重新校验。
 */
export function parseProjectOwnerPlanProposal(
  input: unknown,
  goal: ProjectOwnerGoalBrief,
  availableRoleKeys: readonly string[],
): ProjectOwnerPlanProposal {
  const value = record(input, ['projectId', 'taskId', 'goalVersion', 'summary', 'assumptions', 'risks', 'steps'], '计划提案')
  const projectId = text(value.projectId, 'projectId', 200)
  const taskId = value.taskId === undefined ? undefined : text(value.taskId, 'taskId', 200)
  const goalVersion = version(value.goalVersion)
  if (projectId !== goal.projectId) throw new Error('计划不属于当前项目')
  if (taskId !== goal.taskId) throw new Error('计划不属于当前任务目标')
  if (goalVersion !== goal.goalVersion) throw new Error('目标版本已变化，请重新规划')
  if (!Array.isArray(value.steps) || value.steps.length < 1 || value.steps.length > 32) {
    throw new Error('steps 必须包含 1～32 个步骤')
  }
  const roles = new Set(availableRoleKeys)
  const steps = value.steps.map((step) => parseStep(step, roles))
  validateDependencies(steps)
  return {
    projectId,
    ...(taskId === undefined ? {} : { taskId }),
    goalVersion,
    mode: 'proposal_only',
    summary: text(value.summary, 'summary'),
    assumptions: texts(value.assumptions, 'assumptions'),
    risks: texts(value.risks, 'risks'),
    steps,
  }
}

/**
 * AI Owner 规划输入边界：只产生简报/计划建议，不创建权威任务或执行授权。
 * 本模块无持久化与 Runtime 依赖；角色可用性须由调用方从权威目录提供。
 */
import type { OwnerPlanningConversationContext, ProjectOwnerCodeFileMatch, ProjectOwnerDeliveryContext, ProjectOwnerDeliveryChangeAssessment, ProjectOwnerDeliveryFeedbackAssessment, ProjectOwnerGoalBrief, ProjectOwnerPlanProposal, ProjectOwnerPlanStep } from '@gravitas/shared'
export type { ProjectOwnerDeliveryFeedbackAssessment, ProjectOwnerGoalBrief, ProjectOwnerPlanProposal, ProjectOwnerPlanStep } from '@gravitas/shared'

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
  const value = record(input, ['projectId', 'taskId', 'goalVersion', 'objective', 'constraints', 'acceptanceCriteria', 'codeSourceAccess'], '目标简报')
  const codeSourceAccess = value.codeSourceAccess === undefined ? 'none' : value.codeSourceAccess
  if (codeSourceAccess !== 'none' && codeSourceAccess !== 'bound_workspace') throw new Error('代码资料授权选项无效')
  if (value.taskId === undefined && codeSourceAccess !== 'none') throw new Error('项目目标不能启用任务仓库源码读取')
  return {
    projectId: text(value.projectId, 'projectId', 200),
    ...(value.taskId === undefined ? {} : { taskId: text(value.taskId, 'taskId', 200) }),
    goalVersion: version(value.goalVersion),
    objective: text(value.objective, 'objective', 12000),
    constraints: texts(value.constraints === undefined ? [] : value.constraints, 'constraints'),
    acceptanceCriteria: texts(value.acceptanceCriteria === undefined ? [] : value.acceptanceCriteria, 'acceptanceCriteria'),
    codeSourceAccess,
  }
}

function parseStep(input: unknown, roles: ReadonlySet<string>, codeFiles: readonly ProjectOwnerCodeFileMatch[]): ProjectOwnerPlanStep {
  const value = record(input, ['key', 'title', 'outcome', 'acceptanceCriteria', 'dependencies', 'roleKey', 'sourceReferences'], '计划步骤')
  const roleKey = text(value.roleKey, 'roleKey', 200)
  if (!roles.has(roleKey)) throw new Error(`计划使用了不可用角色：${roleKey}`)
  let sourceReferences: ProjectOwnerPlanStep['sourceReferences']
  if (value.sourceReferences !== undefined) {
    if (!Array.isArray(value.sourceReferences) || value.sourceReferences.length > 8) throw new Error('计划源码引用无效')
    sourceReferences = value.sourceReferences.map(inputReference => {
      const reference = record(inputReference, ['path', 'line', 'sha256'], '计划源码引用')
      const path = text(reference.path, '源码路径', 1000), line = reference.line
      const sha256 = text(reference.sha256, '源码摘要', 64)
      const file = codeFiles.find(item => item.path === path && item.sha256 === sha256)
      if (!file || !Number.isSafeInteger(line) || !file.excerpts.some(item => item.line === line)) throw new Error('计划源码引用不属于本次冻结检索结果')
      return { path, line: line as number, sha256 }
    })
  }
  return {
    key: text(value.key, 'key', 200),
    title: text(value.title, 'title', 300),
    outcome: text(value.outcome, 'outcome'),
    acceptanceCriteria: texts(value.acceptanceCriteria, 'acceptanceCriteria', 1),
    dependencies: texts(value.dependencies, 'dependencies'),
    roleKey,
    ...(sourceReferences === undefined ? {} : { sourceReferences }),
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
  codeFiles: readonly ProjectOwnerCodeFileMatch[] = [],
  requireCodeReferences = false,
  deliverySources: readonly ProjectOwnerDeliveryContext[] = [],
  expectedDeliveryFeedback?: OwnerPlanningConversationContext['deliveryFeedback'],
): ProjectOwnerPlanProposal {
  const value = record(input, ['projectId', 'taskId', 'goalVersion', 'summary', 'assumptions', 'risks', 'steps', 'deliveryChangeAssessment', 'deliveryFeedbackAssessment'], '计划提案')
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
  if (requireCodeReferences && goal.codeSourceAccess === 'bound_workspace' && !codeFiles.length) throw new Error('未检索到代码候选，必须请求澄清，不能提交代码计划')
  const steps = value.steps.map((step) => parseStep(step, roles, codeFiles))
  if (requireCodeReferences && codeFiles.length && !steps.some(step => (step.sourceReferences?.length ?? 0) > 0)) throw new Error('代码规划提案必须引用本次检索到的文件和行号')
  validateDependencies(steps)
  let deliveryChangeAssessment: ProjectOwnerDeliveryChangeAssessment | undefined
  if (deliverySources.length) {
    const assessment = record(value.deliveryChangeAssessment, ['summary', 'commands'], '交付差异评估')
    if (!Array.isArray(assessment.commands) || assessment.commands.length !== deliverySources.length) throw new Error('交付差异评估必须逐条覆盖反馈命令')
    const expected = new Map(deliverySources.map(source => [source.commandId, source]))
    const commands = assessment.commands.map((raw) => {
      const command = record(raw, ['commandId', 'changes', 'authorizationImpact', 'authorizationRationale'], '命令差异')
      const commandId = text(command.commandId, '差异命令ID', 128)
      const source = expected.get(commandId)
      if (!source || !Array.isArray(command.changes) || command.changes.length !== source.acceptanceCriteria.length) throw new Error('交付差异命令或冻结标准覆盖不匹配')
      const changes = command.changes.map((rawChange) => {
        const change = record(rawChange, ['criterion', 'disposition', 'proposedChange'], '标准差异')
        if (change.disposition !== 'addressed' && change.disposition !== 'still_open' && change.disposition !== 'not_applicable') throw new Error('交付标准差异状态无效')
        return { criterion: text(change.criterion, '冻结标准', 2000), disposition: change.disposition as 'addressed' | 'still_open' | 'not_applicable', proposedChange: text(change.proposedChange, '拟议改动') }
      })
      if (changes.some((change, index) => change.criterion !== source.acceptanceCriteria[index])) throw new Error('交付差异必须逐字逐项复写冻结标准')
      if (command.authorizationImpact !== 'unchanged' && command.authorizationImpact !== 'additional_confirmation'
        && command.authorizationImpact !== 'new_grant_required' && command.authorizationImpact !== 'cannot_determine') throw new Error('授权影响类型无效')
      return { commandId, changes, authorizationImpact: command.authorizationImpact as ProjectOwnerDeliveryChangeAssessment['commands'][number]['authorizationImpact'], authorizationRationale: text(command.authorizationRationale, '授权影响说明') }
    })
    if (new Set(commands.map(command => command.commandId)).size !== expected.size) throw new Error('交付差异命令重复或遗漏')
    deliveryChangeAssessment = { summary: text(assessment.summary, '交付差异摘要'), commands }
  } else if (value.deliveryChangeAssessment !== undefined) {
    throw new Error('没有命令绑定交付反馈时不得夹带交付差异评估')
  }
  let deliveryFeedbackAssessment: ProjectOwnerDeliveryFeedbackAssessment | undefined
  if (expectedDeliveryFeedback || value.deliveryFeedbackAssessment !== undefined) {
    const assessment = record(value.deliveryFeedbackAssessment, ['messageId', 'artifactHash', 'stepKey', 'summary', 'changes', 'authorizationImpact', 'authorizationRationale'], '成果反馈影响评估')
    if (!Array.isArray(assessment.changes) || assessment.changes.length < 1 || assessment.changes.length > 64
      || (assessment.authorizationImpact !== 'within_confirmed_boundary' && assessment.authorizationImpact !== 'additional_confirmation' && assessment.authorizationImpact !== 'cannot_determine')) throw new Error('成果反馈影响评估字段无效')
    const changes = assessment.changes.map((rawChange) => {
      const change = record(rawChange, ['criterion', 'disposition', 'proposedChange'], '成果标准差异')
      if (change.disposition !== 'addressed' && change.disposition !== 'still_open' && change.disposition !== 'not_applicable') throw new Error('成果标准差异状态无效')
      return { criterion: text(change.criterion, '原成果标准', 2000), disposition: change.disposition as ProjectOwnerDeliveryFeedbackAssessment['changes'][number]['disposition'], proposedChange: text(change.proposedChange, '拟议改动') }
    })
    if (typeof assessment.messageId !== 'string' || !/^[a-f0-9]{64}$/.test(assessment.messageId) || typeof assessment.artifactHash !== 'string' || !/^[a-f0-9]{64}$/.test(assessment.artifactHash)) throw new Error('成果反馈影响评估缺少准确版本身份')
    if (assessment.stepKey !== undefined && (typeof assessment.stepKey !== 'string' || !assessment.stepKey.trim() || assessment.stepKey.length > 100)) throw new Error('成果反馈步骤身份无效')
    if (expectedDeliveryFeedback && (assessment.messageId !== expectedDeliveryFeedback.messageId || assessment.artifactHash !== expectedDeliveryFeedback.artifactHash
      || assessment.stepKey !== expectedDeliveryFeedback.stepKey
      || changes.length !== expectedDeliveryFeedback.acceptanceCriteria.length || changes.some((change, index) => change.criterion !== expectedDeliveryFeedback.acceptanceCriteria[index]))) throw new Error('成果反馈评估与准确成果版本或原完成标准不匹配')
    if (expectedDeliveryFeedback && assessment.authorizationImpact === 'cannot_determine') throw new Error('成果反馈影响无法判定，必须先向用户澄清而不能直接提交方案')
    deliveryFeedbackAssessment = { messageId: assessment.messageId, artifactHash: assessment.artifactHash, ...(typeof assessment.stepKey === 'string' ? { stepKey: assessment.stepKey } : {}), summary: text(assessment.summary, '成果反馈改动摘要'), changes,
      authorizationImpact: assessment.authorizationImpact, authorizationRationale: text(assessment.authorizationRationale, '授权影响说明') }
  }
  return {
    projectId,
    ...(taskId === undefined ? {} : { taskId }),
    goalVersion,
    mode: 'proposal_only',
    summary: text(value.summary, 'summary'),
    assumptions: texts(value.assumptions, 'assumptions'),
    risks: texts(value.risks, 'risks'),
    steps,
    ...(deliveryChangeAssessment ? { deliveryChangeAssessment } : {}),
    ...(deliveryFeedbackAssessment ? { deliveryFeedbackAssessment } : {}),
  }
}

import type { OwnerExecutionPreparationView, ProjectOwnerPlanDraft } from '@gravitas/shared'
import type { OwnerExecutionEdit, OwnerExecutionEditor } from './project-owner-execution-atoms'

/** 使用十进制字符串换算，避免浮点舍入或隐式人民币汇率。 */
export function ownerDollarsToMicros(value: string): string {
  if (!/^(0|[1-9]\d*)(\.\d{1,6})?$/.test(value)) return ''
  const [whole, fraction = ''] = value.split('.')
  const micros = BigInt(whole!) * 1000000n + BigInt(fraction.padEnd(6, '0'))
  return micros <= BigInt(Number.MAX_SAFE_INTEGER) ? String(micros) : ''
}
export function ownerMicrosToDollars(value: string): string {
  if (!/^\d+$/.test(value)) return ''
  const micros = BigInt(value)
  const fraction = String(micros % 1000000n).padStart(6, '0').replace(/0+$/, '')
  return `${micros / 1000000n}${fraction ? `.${fraction}` : ''}`
}

/** 只复用项目来源中的唯一模板匹配；不猜测 Reviewer 能力，不填预算或权限。 */
export function ownerExecutionSetupSuggestion(
  view: OwnerExecutionPreparationView,
  plan: ProjectOwnerPlanDraft,
  editor: OwnerExecutionEditor,
): OwnerExecutionEdit {
  const saved = view.status === 'current' && !editor.dirty && view.preparation?.source.planFingerprint === plan.planFingerprint ? view.preparation.input : null
  if (saved) {
    const date = new Date(saved.expiresAt)
    const pad = (value: number) => String(value).padStart(2, '0')
    return {
      workspaceId: saved.workspaceId, selectedStepKeys: [...saved.selectedStepKeys], executionKind: saved.executionKind,
      executorEmployeeId: saved.executorEmployeeId, reviewerEmployeeId: saved.reviewerEmployeeId,
      roleAssignments: Object.fromEntries(saved.roleAssignments?.map(assignment => [assignment.roleKey, assignment.employeeId]) ?? [...new Set(plan.proposal.steps.filter(step => saved.selectedStepKeys.includes(step.key)).map(step => step.roleKey))].map(role => [role, saved.executorEmployeeId])),
      knowledgeSourceIds: [...saved.knowledgeSourceIds], maxCostMicrosText: String(saved.maxCostMicros),
      maxRunsText: String(saved.maxRuns), maxReworkText: String(saved.maxRework), changeReason: saved.changeReason,
      expiresAtText: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`,
      targetPathsText: saved.developmentScope?.targetPaths.join('\n') ?? '', allowedPathsText: saved.developmentScope?.allowedPaths.join('\n') ?? '',
      verificationCommandsText: saved.developmentScope?.verificationCommands?.join('\n') ?? '',
      roleBudgetCapsEnabled: Boolean(saved.roleBudgetCaps?.length), roleBudgetCapTexts: Object.fromEntries(saved.roleBudgetCaps?.map(cap => [cap.roleKey, String(cap.maxCostMicros)]) ?? []),
    }
  }
  const workspaceId = editor.workspaceId || view.workspaceRecommendation.workspaceId || ''
  const selectedStepKeys = editor.selectedStepKeys.length ? editor.selectedStepKeys : plan.proposal.steps.map(step => step.key)
  const roleAssignments = { ...editor.roleAssignments }
  const roles = [...new Set(plan.proposal.steps.filter(step => selectedStepKeys.includes(step.key)).map(step => step.roleKey))]
  if (roles.length === 1 && !roleAssignments[roles[0]!] && editor.executorEmployeeId) roleAssignments[roles[0]!] = editor.executorEmployeeId
  const configuration = view.executionConfigurationRecommendation
  for (const roleKey of new Set(plan.proposal.steps.filter(step => selectedStepKeys.includes(step.key)).map(step => step.roleKey))) {
    if (roleAssignments[roleKey]) continue
    const candidates = view.choices.employees.filter(employee => !employee.isOwnerCarrier
      && employee.id !== editor.reviewerEmployeeId && employee.executionProfile === editor.executionKind
      && employee.workspaceIds.includes(workspaceId) && employee.roleTemplateId === roleKey
      && (!configuration || employee.channelId === configuration.channelId && employee.modelId === configuration.modelId && employee.runtime === configuration.runtime))
    if (candidates.length === 1) roleAssignments[roleKey] = candidates[0]!.id
  }
  return { workspaceId, selectedStepKeys, roleAssignments }
}

/** 当前输入是否足以进入预算问答；最终写入仍必须通过原始预览与服务端校验。 */
export function ownerExecutionPeopleReady(editor: OwnerExecutionEditor, plan: ProjectOwnerPlanDraft): boolean {
  const view = editor.view
  if (!view || !editor.loaded || editor.requiresReview || view.executionConfigurationRecommendationState === 'stale') return false
  const workspaceId = editor.workspaceId || view.workspaceRecommendation.workspaceId || ''
  if (!view.choices.workspaces.some(workspace => workspace.id === workspaceId)) return false
  const steps = plan.proposal.steps.filter(step => editor.selectedStepKeys.includes(step.key))
  if (!steps.length || steps.length !== editor.selectedStepKeys.length || steps.some(step => step.dependencies.some(key => !editor.selectedStepKeys.includes(key)))) return false
  const roles = [...new Set(steps.map(step => step.roleKey))]
  const employees = roles.map(role => view.choices.employees.find(employee => employee.id === (editor.roleAssignments[role] || (roles.length === 1 ? editor.executorEmployeeId : ''))))
  const reviewer = view.choices.employees.find(employee => employee.id === editor.reviewerEmployeeId)
  if (!reviewer || employees.some(employee => !employee || employee.id === reviewer.id)) return false
  const all = [...employees, reviewer]
  if (all.some(employee => !employee || !employee.modelId || employee.executionProfile !== editor.executionKind || !employee.workspaceIds.includes(workspaceId)
    || employee.channelId !== reviewer.channelId || employee.modelId !== reviewer.modelId || employee.runtime !== reviewer.runtime)) return false
  const config = view.executionConfigurationRecommendation
  if (config && (reviewer.channelId !== config.channelId || reviewer.modelId !== config.modelId || reviewer.runtime !== config.runtime) && !editor.acknowledgeOwnerConfigurationOverride) return false
  return !(view.workspaceRecommendation.source === 'owner_binding' && workspaceId !== view.workspaceRecommendation.workspaceId && !editor.acknowledgeOwnerWorkspaceOverride)
}

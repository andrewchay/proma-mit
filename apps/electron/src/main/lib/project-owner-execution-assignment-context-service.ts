import type { OwnerExecutionAssignmentInput, ProjectOwnerGoalSubject } from '@gravitas/shared'
import { getOwnerExecutionPreparation } from './project-owner-execution-preparation'
import { getOwnerCarrierFacts, getOwnerRuntimeBinding, ownerCarrierBindingMatches } from './project-owner-runtime-binding'
import { getProjectOwnerPlanDraft, getProjectOwnerPlanningContext } from './project-owner-plan-service'
import { createOwnerExecutionAssignmentContext } from './project-owner-execution-assignment-context'

export interface CurrentOwnerExecutionAssignmentContext {
  context: ReturnType<typeof createOwnerExecutionAssignmentContext>
  binding: NonNullable<ReturnType<typeof getOwnerRuntimeBinding>>
  planningContext: ReturnType<typeof getProjectOwnerPlanningContext>
  plan: NonNullable<ReturnType<typeof getProjectOwnerPlanDraft>>
  view: ReturnType<typeof getOwnerExecutionPreparation>
}
export function getCurrentOwnerExecutionAssignmentContext(subject: ProjectOwnerGoalSubject, input: OwnerExecutionAssignmentInput, teamContractVersion: 1 | 2 | 3 = 3): CurrentOwnerExecutionAssignmentContext {
  const binding = getOwnerRuntimeBinding(subject.projectId)
  if (!binding || binding.revision !== input.expectedBindingRevision) throw new Error('Owner安排绑定已变化，请重新读取来源')
  const facts = getOwnerCarrierFacts(subject.projectId, binding.carrierId, binding.workspaceId)
  if (!ownerCarrierBindingMatches(binding, facts)) throw new Error('Owner安排载体配置已变化，请重新读取来源')
  const planningContext = getProjectOwnerPlanningContext(subject.projectId, subject.taskId)
  const plan = getProjectOwnerPlanDraft(subject.projectId, subject.taskId)
  if (!plan || !['proposed', 'confirmed'].includes(plan.state) || plan.revision !== input.expectedPlanRevision || plan.planFingerprint !== input.expectedPlanFingerprint
    || planningContext.goal.revision !== input.expectedGoalRevision || planningContext.fingerprint !== input.expectedContextFingerprint) throw new Error('Owner目标、计划或来源已变化，请重新预检安排')
  const view = getOwnerExecutionPreparation(subject)
  const workspaces = view.choices.workspaces.map(workspace => {
    const capabilities = view.choices.workspaceCapabilities.find(item => item.workspaceId === workspace.id)
    return {
      ...workspace,
      capabilities: [
        ...(capabilities?.mcpServers.map(server => `MCP:${server.name}:${server.type}`) ?? []),
        ...(capabilities?.skills.map(skill => `Skill:${skill.slug}:${skill.name}`) ?? []),
      ],
    }
  })
  const context = createOwnerExecutionAssignmentContext({
    context: planningContext,
    plan,
    projectTitle: planningContext.sources.project.title,
    projectDescription: planningContext.sources.project.description,
    workspaces,
    ownerCarrierId: binding.carrierId,
    ownerName: binding.ownerName,
    bindingRevision: binding.revision,
    ownerDefaults: { workspaceId: binding.workspaceId, channelId: binding.channelId, modelId: binding.modelId, runtime: binding.runtime },
    candidates: view.choices.employees,
    teamContractVersion,
    ...(input.feedback ? { feedback: input.feedback } : {}),
  })
  return { context, binding, planningContext, plan, view }
}

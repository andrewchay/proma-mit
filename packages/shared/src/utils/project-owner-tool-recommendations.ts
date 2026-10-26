import type { ProjectOwnerPlanStep } from '../types/project-owner'

export interface OwnerWorkspaceCapabilitySet {
  workspaceId: string
  mcpServers: Array<{ name: string; type: string }>
  skills: Array<{ slug: string; name: string; description?: string }>
}

export interface OwnerStepToolRecommendation {
  stepKey: string
  candidates: Array<{ id: string; label: string; kind: 'skill' | 'mcp'; reason: string }>
}

function terms(value: string): Set<string> {
  const normalized = value.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ')
  const found = new Set(normalized.split(/\s+/u).filter((part) => part.length > 1))
  const chinese = normalized.replace(/\s+/gu, '').match(/[\u3400-\u9fff]{2,}/gu) ?? []
  for (const sequence of chinese)
    for (let index = 0; index < sequence.length - 1; index++) found.add(sequence.slice(index, index + 2))
  return found
}

function matchReason(step: ProjectOwnerPlanStep, description: string): string | undefined {
  const stepTerms = terms(`${step.title} ${step.outcome} ${step.acceptanceCriteria.join(' ')}`)
  const shared = [...terms(description)].filter((term) => stepTerms.has(term))
  if (shared.length < 2) return undefined
  return `步骤与能力说明共有关键词：${shared.slice(0, 4).join('、')}`
}

/** 只用步骤文本与显式能力元数据做词面匹配；结果仅供人核对，不启用工具或授权。 */
export function recommendOwnerStepTools(
  steps: readonly ProjectOwnerPlanStep[],
  workspaceId: string,
  capabilitySets: readonly OwnerWorkspaceCapabilitySet[],
): OwnerStepToolRecommendation[] {
  const capabilities = capabilitySets.find((item) => item.workspaceId === workspaceId)
  return steps.map((step) => {
    if (!capabilities) return { stepKey: step.key, candidates: [] }
    const candidates: OwnerStepToolRecommendation['candidates'] = []
    for (const skill of capabilities.skills) {
      const reason = matchReason(step, `${skill.name} ${skill.slug} ${skill.description ?? ''}`)
      if (reason) candidates.push({ id: `skill:${skill.slug}`, label: skill.name, kind: 'skill', reason })
    }
    for (const server of capabilities.mcpServers) {
      const reason = matchReason(step, `${server.name} ${server.type}`)
      if (reason) candidates.push({ id: `mcp:${server.name}`, label: server.name, kind: 'mcp', reason })
    }
    return { stepKey: step.key, candidates }
  })
}

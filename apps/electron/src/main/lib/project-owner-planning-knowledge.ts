import type { ProjectOwnerPlanSources } from '@gravitas/shared'

/** 只接收冻结的资料身份与名称；本地路径和正文不能混入规划元信息。 */
export function parseOwnerPlanningKnowledgeSources(input: unknown): ProjectOwnerPlanSources['knowledgeSources'] {
  if (input === undefined) return undefined
  if (!Array.isArray(input) || input.length < 1 || input.length > 64) throw new Error('Owner规划知识来源数量无效')
  const sources = input.map((source: unknown) => {
    if (!source || typeof source !== 'object' || Array.isArray(source)) throw new Error('Owner规划知识来源无效')
    const value = source as Record<string, unknown>
    if (Object.keys(value).some(key => !['id', 'name'].includes(key))
      || typeof value.id !== 'string' || !value.id.trim() || value.id.length > 128
      || typeof value.name !== 'string' || !value.name.trim() || value.name.length > 500) throw new Error('Owner规划知识来源身份或名称无效')
    return { id: value.id, name: value.name }
  })
  if (new Set(sources.map(source => source.id)).size !== sources.length) throw new Error('Owner规划知识来源重复')
  return sources
}

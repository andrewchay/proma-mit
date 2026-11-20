/**
 * 混合批次接替：已验收步骤的复用判定。
 *
 * 恢复一批「A 已验收、B 失败」的工作时，新方案往往仍会列出 A→B。
 * 若只按 `selectedStepKeys` 材料化，A 会被重新建成可派发任务并再次计费——
 * 这正是接替记录里 `retainedTaskIds` 必须被消费的地方。
 *
 * 复用不能只认同名 stepKey：新方案可能收紧了 A 的交付要求，此时必须重做。
 * 因此这里逐字段比对**规格指纹**，只有完全一致才复用；任何差异都退回重新执行，
 * 宁可多花一次钱，也不接受「拿旧成果冒充新要求」。
 */

/** 一个可复用的已验收步骤：新旧规格必须逐字段一致。 */
export interface RetainedStepCandidate {
  /** 旧批次里该步骤对应的任务。 */
  taskId: string
  stepKey: string
  /** 旧批次冻结的投影；用于与新方案逐字段比对。 */
  projection: RetainedStepProjection
}

/** 参与复用比对的字段子集；时间戳、排序与负责人身份不构成交付要求。 */
export interface RetainedStepProjection {
  title: string
  outcome: string
  acceptanceCriteria: readonly string[]
  roleKey: string
  deliveryKind?: 'text' | 'development'
}

/** 新方案里的一个步骤；与 `RetainedStepProjection` 同构。 */
export interface IncomingStep extends RetainedStepProjection {
  key: string
}

export interface RetainedStepReuse {
  /** 可以复用旧验收成果、不需要新建派发命令的步骤。 */
  reuse: Array<{ stepKey: string; taskId: string }>
  /** 同名但规格已变化、必须重新执行的步骤。 */
  changed: Array<{ stepKey: string; reason: string }>
}

/**
 * 计算哪些步骤可以复用旧验收成果。
 *
 * 只处理「新方案明确选中」的步骤；未选中的旧任务与本次无关。
 */
export function resolveRetainedStepReuse(
  incoming: readonly IncomingStep[],
  retained: readonly RetainedStepCandidate[],
): RetainedStepReuse {
  const byStepKey = new Map(retained.map((candidate) => [candidate.stepKey, candidate]))
  const reuse: RetainedStepReuse['reuse'] = []
  const changed: RetainedStepReuse['changed'] = []
  for (const step of incoming) {
    const candidate = byStepKey.get(step.key)
    if (!candidate) continue
    const reason = describeSpecificationDrift(candidate.projection, step)
    if (reason) changed.push({ stepKey: step.key, reason })
    else reuse.push({ stepKey: step.key, taskId: candidate.taskId })
  }
  return { reuse, changed }
}

/**
 * 返回规格漂移的人类可读原因；完全一致时返回 null。
 *
 * 验收标准按集合比较：顺序不是要求，增删一项才是。
 */
export function describeSpecificationDrift(previous: RetainedStepProjection, next: RetainedStepProjection): string | null {
  if (previous.roleKey !== next.roleKey) return `岗位由 ${previous.roleKey} 变为 ${next.roleKey}`
  if (previous.deliveryKind !== next.deliveryKind) return '交付类型已变化'
  if (previous.title !== next.title) return '标题已变化'
  if (previous.outcome !== next.outcome) return '目标成果已变化'
  const previousCriteria = [...previous.acceptanceCriteria].sort()
  const nextCriteria = [...next.acceptanceCriteria].sort()
  if (previousCriteria.length !== nextCriteria.length
    || previousCriteria.some((item, index) => item !== nextCriteria[index])) return '验收标准已变化'
  return null
}

/** 新批次的范围：只保留确实需要重做的步骤。 */
export interface NarrowedStepScope<T> {
  /** 新批次真正要派发的步骤；依赖里已剔除被复用的步骤。 */
  steps: T[]
  /** 被剔除的已验收步骤，及其已验收成果的任务与步骤关联。 */
  reused: Array<{ stepKey: string; taskId: string }>
}

/**
 * 把已验收步骤从新批次范围里剔除，并断开指向它们的依赖。
 *
 * 为什么剔除而不是复用任务行：旧材料化记录的完整性校验要求
 * `task.ownerStepLinkId === 旧link.id`，把任务重新指向新 link 会让旧记录不可读。
 * 剔除后任务与旧记录原样保留，新批次只负责失败步骤。
 *
 * 被剔除步骤的依赖已经满足（成果已验收），因此也必须从下游步骤的 `dependencies`
 * 里移除，否则材料化会因「依赖不在本次闭包」拒绝。
 */
export function narrowStepScope<T extends { key: string; dependencies: readonly string[] }>(
  incoming: readonly T[],
  reuse: ReadonlyArray<{ stepKey: string; taskId: string }>,
): NarrowedStepScope<T> {
  const reusedKeys = new Set(reuse.map((item) => item.stepKey))
  return {
    steps: incoming
      .filter((step) => !reusedKeys.has(step.key))
      .map((step) => ({ ...step, dependencies: step.dependencies.filter((key) => !reusedKeys.has(key)) })),
    reused: [...reuse],
  }
}

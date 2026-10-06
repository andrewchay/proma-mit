import { getActiveAgentEmployeeCapabilityVersions, getAgentEmployee } from '../../project-sqlite-store'
import type { EvalTarget, SelfEvolveChange } from './types'
import type { UnifiedStateGuard } from './eval-target-state'

interface EmployeeCapabilityMemoryState {
  content: string
  version: number
}

function readProductionContent(target: EvalTarget): EmployeeCapabilityMemoryState {
  if (target.type !== 'employee_capability' || !target.scope) throw new Error('员工能力评测目标缺少 scope')
  if (target.scope === 'workspace' && !target.workspaceId) throw new Error('工作区能力评测目标缺少 workspaceId')
  const employee = getAgentEmployee(target.id)
  if (!employee?.enabled) throw new Error('目标 AI 员工不存在或已停用')
  const version = getActiveAgentEmployeeCapabilityVersions(target.id, target.workspaceId)
    .find((item) => item.scope === target.scope && item.workspaceId === target.workspaceId)
  return { content: version?.content ?? '', version: version?.versionNumber ?? 0 }
}

/**
 * 员工能力候选仅保存在此闭包内。snapshot/apply/restore 都不写 SQLite，
 * 因此评测成功、失败或中止均不能直接改变生产 active 版本。
 */
export function buildEmployeeCapabilityStateGuard(target: EvalTarget): UnifiedStateGuard {
  const production = readProductionContent(target)
  let current = { ...production }
  let snapshot: EmployeeCapabilityMemoryState | undefined
  return {
    async snapshot() { snapshot = { ...current } },
    async apply(change: SelfEvolveChange) {
      const value = change.afterState
      const content = typeof value === 'string' ? value : value && typeof value === 'object' && typeof (value as { prompt?: unknown }).prompt === 'string' ? (value as { prompt: string }).prompt : undefined
      if (!content?.trim()) throw new Error('员工能力候选内容为空')
      current = { content: content.trim(), version: current.version + 1 }
    },
    async restore() {
      if (!snapshot) throw new Error('员工能力评测缺少可恢复快照')
      current = snapshot
      snapshot = undefined
    },
    version: () => current.version,
    currentContent: () => current.content,
  }
}

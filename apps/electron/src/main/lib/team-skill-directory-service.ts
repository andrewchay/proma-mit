/**
 * 团队 Skills 目录服务 — Team Skill Directory Service（PH2-A）
 *
 * 轻量团队协作共享：
 * - 在既有「跨工作区 Skill 导入/同步」能力(importSkillFromWorkspace/updateSkillFromSource)之上，
 *   做一个聚合视图 + 一键同步。
 * - 不引入团队实体；把「所有工作区里从别处导入的 Skill」汇总为目录，
 *   显示来源、版本、是否过期(hasUpdate)，并支持一键把过期的都更新到源。
 */

import {
  listAgentWorkspaces,
  getAllWorkspaceSkills,
  updateSkillFromSource,
} from './agent-workspace-manager'

export interface TeamSkillUpstream {
  workspaceSlug: string
  workspaceName: string
  /** 该工作区从别处导入的 Skill（带来源/过期标记） */
  imported: ImportedSkillEntry[]
}

export interface ImportedSkillEntry {
  slug: string
  name: string
  version?: string
  enabled: boolean
  importSource: {
    sourceWorkspaceName: string
    importedAt: string
    sourceVersion?: string
  }
  /** 源有更新但本地未同步 */
  hasUpdate: boolean
}

/** 汇总所有工作区「从别处导入的 Skill」，构成团队 Skill 上游目录。 */
export function listTeamSkillUpstreams(): TeamSkillUpstream[] {
  const result: TeamSkillUpstream[] = []
  for (const workspace of listAgentWorkspaces()) {
    const skills = getAllWorkspaceSkills(workspace.slug)
    const imported: ImportedSkillEntry[] = []
    for (const skill of skills) {
      const src = skill.importSource
      if (!src) continue
      imported.push({
        slug: skill.slug,
        name: skill.name,
        version: skill.version,
        enabled: skill.enabled,
        importSource: {
          sourceWorkspaceName: src.sourceWorkspaceName ?? src.sourceWorkspaceSlug,
          importedAt: src.importedAt,
          sourceVersion: src.sourceVersion,
        },
        hasUpdate: skill.hasUpdate ?? false,
      })
    }
    if (imported.length > 0) {
      result.push({ workspaceSlug: workspace.slug, workspaceName: workspace.name, imported })
    }
  }
  return result
}

/** 汇总所有需要同步的过期 Skill（用于展示待同步数）。 */
export function countTeamSkillUpdates(): number {
  return listTeamSkillUpstreams().reduce(
    (acc, group) => acc + group.imported.filter((s) => s.hasUpdate).length,
    0,
  )
}

/**
 * 一键同步所有过期的导入 Skill。
 * 逐条调 updateSkillFromSource；返回 { updated, failed, errors }。
 */
export function syncAllTeamSkillUpdates(): {
  updated: string[]
  failed: string[]
  errors: string[]
} {
  const updated: string[] = []
  const failed: string[] = []
  const errors: string[] = []

  for (const group of listTeamSkillUpstreams()) {
    for (const skill of group.imported) {
      if (!skill.hasUpdate) continue
      try {
        updateSkillFromSource(group.workspaceSlug, skill.slug)
        updated.push(`${group.workspaceName}/${skill.slug}`)
      } catch (err) {
        failed.push(`${group.workspaceName}/${skill.slug}`)
        errors.push(err instanceof Error ? err.message : String(err))
      }
    }
  }
  return { updated, failed, errors }
}

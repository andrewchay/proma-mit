/**
 * 学术研究 atoms（M1）
 *
 * 状态按研究项目隔离；数据一律经 preload 桥读写主进程服务，
 * 不在 renderer 侧维护第二份权威数据。
 */

import { atom } from 'jotai'
import type {
  CreateResearchProjectInput,
  MigrationDryRunReport,
  ResearchBrief,
  ResearchProject,
  ResearchProjectStatus,
} from '@gravitas/shared'

export const researchProjectsAtom = atom<ResearchProject[]>([])
export const researchProjectsLoadingAtom = atom<boolean>(false)
export const researchProjectsErrorAtom = atom<string | null>(null)

/** 当前查看的研究项目 */
export const currentResearchProjectAtom = atom<ResearchProject | null>(null)

/** 创建表单开关与迁移报告 */
export const researchCreateDialogOpenAtom = atom<boolean>(false)
export const migrationReportAtom = atom<MigrationDryRunReport | null>(null)

/** 异步 action：加载项目列表 */
export const loadResearchProjectsAtom = atom(null, async (get, set) => {
  set(researchProjectsLoadingAtom, true)
  set(researchProjectsErrorAtom, null)
  try {
    const projects = await window.electronAPI.academicResearch.listProjects()
    set(researchProjectsAtom, projects)
  } catch (err) {
    set(researchProjectsErrorAtom, err instanceof Error ? err.message : String(err))
  } finally {
    set(researchProjectsLoadingAtom, false)
  }
})

/** 异步 action：创建研究项目 */
export const createResearchProjectAtom = atom(
  null,
  async (_get, set, input: CreateResearchProjectInput) => {
    const project = await window.electronAPI.academicResearch.createProject(input)
    set(researchProjectsAtom, (prev) => [project, ...prev])
    return project
  },
)

/** 异步 action：更新 Brief */
export const updateResearchBriefAtom = atom(
  null,
  async (_get, set, { id, brief, changeReason }: { id: string; brief: ResearchBrief; changeReason: string }) => {
    const updated = await window.electronAPI.academicResearch.updateBrief(id, brief, changeReason)
    set(currentResearchProjectAtom, updated)
    set(researchProjectsAtom, (prev) => prev.map((p) => (p.id === id ? updated : p)))
    return updated
  },
)

/** 异步 action：状态迁移 */
export const changeResearchStatusAtom = atom(
  null,
  async (_get, set, { id, to, reason }: { id: string; to: ResearchProjectStatus; reason?: string }) => {
    const updated = await window.electronAPI.academicResearch.changeStatus(id, to, reason)
    set(currentResearchProjectAtom, updated)
    set(researchProjectsAtom, (prev) => prev.map((p) => (p.id === id ? updated : p)))
    return updated
  },
)

/** 异步 action：归档 */
export const archiveResearchProjectAtom = atom(null, async (_get, set, { id, reason }: { id: string; reason?: string }) => {
  const updated = await window.electronAPI.academicResearch.archiveProject(id, reason)
  set(currentResearchProjectAtom, updated)
  set(researchProjectsAtom, (prev) => prev.map((p) => (p.id === id ? updated : p)))
  return updated
})

/** 异步 action：旧数据迁移 dry-run */
export const runMigrationDryRunAtom = atom(null, async (_get, set) => {
  const report = await window.electronAPI.academicResearch.migrationDryRun()
  set(migrationReportAtom, report)
  return report
})

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

// ===== M2 第二批：文献与证据 =====

export const researchSourcesAtom = atom<import('@gravitas/shared').Source[]>([])
export const researchSearchRunsAtom = atom<import('@gravitas/shared').SearchRunRecord[]>([])
export const researchDedupCandidatesAtom = atom<
  { kind: string; versionIds: string[]; sourceIds: string[]; detail: string }[]
>([])
export const researchScreeningAtom = atom<import('@gravitas/shared').ScreeningDecision[]>([])
export const researchEvidenceAtom = atom<import('@gravitas/shared').EvidenceExcerpt[]>([])
export const sourceLibraryLoadingAtom = atom<boolean>(false)

/** 选中项目后加载文献/证据数据 */
export const loadSourceLibraryAtom = atom(null, async (_get, set, projectId: string) => {
  set(sourceLibraryLoadingAtom, true)
  try {
    const api = window.electronAPI.academicResearch
    set(researchSourcesAtom, await api.listSources(projectId))
    set(researchSearchRunsAtom, await api.listSearchRuns(projectId))
    set(researchDedupCandidatesAtom, await api.dedupCandidates(projectId))
    set(researchScreeningAtom, await api.listScreening(projectId))
    set(researchEvidenceAtom, await api.listEvidence(projectId))
  } finally {
    set(sourceLibraryLoadingAtom, false)
  }
})

/** 跨库检索 */
export const searchExternalSourcesAtom = atom(
  null,
  async (
    _get,
    set,
    { projectId, query, databases, limit }: { projectId: string; query: string; databases: string[]; limit: number },
  ) => {
    const run = await window.electronAPI.academicResearch.searchSources(projectId, query, databases, { limit })
    set(researchSearchRunsAtom, (prev) => [run, ...prev])
    set(researchSourcesAtom, await window.electronAPI.academicResearch.listSources(projectId))
    set(researchDedupCandidatesAtom, await window.electronAPI.academicResearch.dedupCandidates(projectId))
    return run
  },
)

/** 导入 RIS/BibTeX */
export const importBibliographyAtom = atom(
  null,
  async (_get, set, { projectId, format, text }: { projectId: string; format: 'ris' | 'bibtex'; text: string }) => {
    const sources = await window.electronAPI.academicResearch.importBibliography(projectId, format, text)
    set(researchSourcesAtom, (prev) => [...sources, ...prev])
    return sources
  },
)

/** 记录筛选决定 */
export const recordScreeningAtom = atom(
  null,
  async (
    _get,
    set,
    input: { projectId: string; sourceId: string; round: 'title-abstract' | 'full-text'; decision: 'include' | 'exclude' | 'maybe'; reason: string },
  ) => {
    const decision = await window.electronAPI.academicResearch.recordScreening(
      input.projectId,
      { sourceId: input.sourceId, round: input.round, decision: input.decision, reason: input.reason },
    )
    set(researchScreeningAtom, (prev) => [...prev, decision])
    return decision
  },
)

/** 抽取证据 */
export const extractEvidenceAtom = atom(
  null,
  async (_get, set, input: { projectId: string; sourceId: string; sourceVersionId: string; text: string; locator: import('@gravitas/shared').EvidenceLocator; note?: string }) => {
    const evidence = await window.electronAPI.academicResearch.extractEvidence(input.projectId, input)
    set(researchEvidenceAtom, (prev) => [evidence, ...prev])
    return evidence
  },
)

// ===== M2.6：Zotero 配置与导入 =====

export interface ZoteroConfigView {
  baseUrl: string
  libraryId: string
  libraryType: 'users' | 'groups'
  collectionKey?: string
  local: boolean
}

export const zoteroConfigAtom = atom<ZoteroConfigView | null>(null)

export const loadZoteroConfigAtom = atom(null, async (_get, set) => {
  const config = await window.electronAPI.academicResearch.getZoteroConfig()
  set(zoteroConfigAtom, config)
  return config
})

export const saveZoteroConfigAtom = atom(null, async (_get, set, input: { baseUrl?: string; libraryId: string; libraryType?: 'users' | 'groups'; collectionKey?: string; local?: boolean }) => {
  const config = await window.electronAPI.academicResearch.saveZoteroConfig(input)
  set(zoteroConfigAtom, config)
  return config
})

export const importFromZoteroAtom = atom(
  null,
  async (_get, set, { projectId, apiKey, limit }: { projectId: string; apiKey?: string; limit?: number }) => {
    const result = await window.electronAPI.academicResearch.importFromZotero(projectId, { apiKey, limit })
    set(researchSourcesAtom, await window.electronAPI.academicResearch.listSources(projectId))
    set(researchDedupCandidatesAtom, await window.electronAPI.academicResearch.dedupCandidates(projectId))
    return result
  },
)

// ===== G1：领域 profile（渲染层只读选项）=====

/** 各领域允许的方法路径（与服务层 profile 同源语义；此处仅用于表单过滤） */
export const DOMAIN_ALLOWED_METHOD_PATHS: Record<string, string[]> = {
  audiology: ['quantitative', 'qualitative', 'mixed-practice'],
  'medical-humanities': ['qualitative', 'mixed-practice', 'quantitative'],
  statistics: ['quantitative', 'formal'],
  ai: ['quantitative', 'formal'],
  ontology: ['formal', 'qualitative'],
  'enterprise-ai': ['mixed-practice', 'qualitative', 'quantitative'],
  'data-science': ['quantitative', 'mixed-practice'],
}

// ===== M3：研究协议 =====

export interface ProfileFieldView {
  key: string
  label: string
  type: 'text' | 'longtext' | 'number' | 'list' | 'select'
  required: boolean
  hint?: string
  options?: string[]
}

export interface ProfileCheckView {
  id: string
  description: string
}

export const protocolsAtom = atom<import('@gravitas/shared').ResearchProtocol[]>([])
export const protocolFieldsAtom = atom<ProfileFieldView[]>([])
export const protocolChecksAtom = atom<ProfileCheckView[]>([])

export const loadProtocolsAtom = atom(
  null,
  async (
    _get,
    set,
    { projectId, domain }: { projectId: string; domain: string; methodPath: string },
  ) => {
    const api = window.electronAPI.academicResearch
    set(protocolsAtom, await api.listProtocols(projectId))
    const { profiles } = await api.getDomainProfile()
    const profile = profiles.find((p) => p.domain === domain)
    set(protocolFieldsAtom, (profile?.protocolFields ?? []) as ProfileFieldView[])
    set(protocolChecksAtom, (profile?.checks ?? []) as ProfileCheckView[])
  },
)

export const createProtocolAtom = atom(
  null,
  async (_get, set, { projectId, methodPath, fields }: { projectId: string; methodPath: import('@gravitas/shared').ResearchMethodPath; fields: Record<string, string> }) => {
    const protocol = await window.electronAPI.academicResearch.createProtocol(projectId, { methodPath, fields })
    set(protocolsAtom, (prev) => [...prev, protocol])
    return protocol
  },
)

export const approveProtocolAtom = atom(
  null,
  async (_get, set, { projectId, version, input }: { projectId: string; version: number; input: { acknowledgedChecks: string[]; note?: string } }) => {
    const approved = await window.electronAPI.academicResearch.approveProtocol(projectId, version, input)
    set(protocolsAtom, (prev) => prev.map((p) => (p.version === version ? approved : p)))
    return approved
  },
)

export const reviseProtocolAtom = atom(
  null,
  async (_get, set, { projectId, changeReason, methodPath, fields }: { projectId: string; changeReason: string; methodPath: import('@gravitas/shared').ResearchMethodPath; fields: Record<string, string> }) => {
    const revised = await window.electronAPI.academicResearch.reviseProtocol(projectId, { changeReason, methodPath, fields })
    set(protocolsAtom, (prev) => [...prev.map((p) => ({ ...p, status: 'superseded' as const })), revised])
    return revised
  },
)

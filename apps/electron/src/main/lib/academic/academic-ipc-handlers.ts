/**
 * 学术研究项目 IPC handlers（M1 第二批）
 *
 * 独立文件避免继续膨胀 ipc.ts；由 ipc.ts 统一注册。
 * 分层与 academic 一致：handlers 无条件注册，能力门禁由插件工具
 * 过滤与渲染层控制——研究领域服务的写操作授权在后续里程碑随
 * 权限模型一起补齐（方案 §3.2 问题 7）。
 */

import { ipcMain } from 'electron'
import { ACADEMIC_RESEARCH_IPC_CHANNELS } from '@gravitas/shared'
import {
  archiveResearchProject,
  changeResearchStatus,
  createResearchProject,
  getResearchProject,
  listResearchProjects,
  updateResearchBrief,
} from './research-service'
import { dryRunLegacyPapersMigration } from './migration'
import { listDomainProfiles, topicAdvisoryNotes } from '@gravitas/core/services/academic'

export function registerAcademicResearchIpcHandlers(): void {
  ipcMain.handle(ACADEMIC_RESEARCH_IPC_CHANNELS.LIST_PROJECTS, async () => listResearchProjects())
  ipcMain.handle(ACADEMIC_RESEARCH_IPC_CHANNELS.GET_PROJECT, async (_event, id: string) =>
    getResearchProject(id),
  )
  ipcMain.handle(ACADEMIC_RESEARCH_IPC_CHANNELS.CREATE_PROJECT, async (_event, input) =>
    createResearchProject(input),
  )
  ipcMain.handle(ACADEMIC_RESEARCH_IPC_CHANNELS.UPDATE_BRIEF, async (_event, id: string, brief, changeReason: string) =>
    updateResearchBrief(id, brief, changeReason),
  )
  ipcMain.handle(ACADEMIC_RESEARCH_IPC_CHANNELS.CHANGE_STATUS, async (_event, id: string, to, reason?: string) =>
    changeResearchStatus(id, to, reason),
  )
  ipcMain.handle(ACADEMIC_RESEARCH_IPC_CHANNELS.ARCHIVE_PROJECT, async (_event, id: string, reason?: string) =>
    archiveResearchProject(id, reason),
  )
  ipcMain.handle(ACADEMIC_RESEARCH_IPC_CHANNELS.MIGRATION_DRY_RUN, async () => dryRunLegacyPapersMigration())

  // ===== M2：文献与检索 =====
  const sourceSvc = require('./source-service') as typeof import('./source-service')
  ipcMain.handle(ACADEMIC_RESEARCH_IPC_CHANNELS.LIST_SOURCES, async (_e, projectId: string) =>
    sourceSvc.listSources(projectId),
  )
  ipcMain.handle(ACADEMIC_RESEARCH_IPC_CHANNELS.IMPORT_BIBLIOGRAPHY, async (_e, projectId: string, format: 'ris' | 'bibtex', text: string) =>
    sourceSvc.importBibliography(projectId, format, text),
  )
  ipcMain.handle(ACADEMIC_RESEARCH_IPC_CHANNELS.SEARCH_SOURCES, async (_e, projectId: string, query: string, databaseIds: string[], options) =>
    sourceSvc.searchExternalSources(projectId, query, databaseIds, options),
  )
  ipcMain.handle(ACADEMIC_RESEARCH_IPC_CHANNELS.LIST_SEARCH_RUNS, async (_e, projectId: string) =>
    sourceSvc.listSearchRuns(projectId),
  )
  ipcMain.handle(ACADEMIC_RESEARCH_IPC_CHANNELS.DEDUP_CANDIDATES, async (_e, projectId: string) =>
    sourceSvc.findProjectDedupCandidates(projectId),
  )
  ipcMain.handle(ACADEMIC_RESEARCH_IPC_CHANNELS.RECORD_SCREENING, async (_e, projectId: string, input) =>
    sourceSvc.recordScreening(projectId, input),
  )
  ipcMain.handle(ACADEMIC_RESEARCH_IPC_CHANNELS.LIST_SCREENING, async (_e, projectId: string) =>
    sourceSvc.listScreeningDecisions(projectId),
  )

  // ===== M2 第二批：证据抽取 =====
  const evidenceSvc = require('./evidence-service') as typeof import('./evidence-service')
  ipcMain.handle(ACADEMIC_RESEARCH_IPC_CHANNELS.LIST_EVIDENCE, async (_e, projectId: string) =>
    evidenceSvc.listEvidence(projectId),
  )
  ipcMain.handle(ACADEMIC_RESEARCH_IPC_CHANNELS.EXTRACT_EVIDENCE, async (_e, projectId: string, input) =>
    evidenceSvc.extractEvidence(projectId, input),
  )

  // ===== M2.6：Zotero 只读导入 =====
  const zoteroConfig = require('./zotero-config') as typeof import('./zotero-config')
  ipcMain.handle(ACADEMIC_RESEARCH_IPC_CHANNELS.GET_ZOTERO_CONFIG, async () => zoteroConfig.readZoteroConfig())
  ipcMain.handle(ACADEMIC_RESEARCH_IPC_CHANNELS.SAVE_ZOTERO_CONFIG, async (_e, input) =>
    zoteroConfig.saveZoteroConfig(input),
  )
  ipcMain.handle(ACADEMIC_RESEARCH_IPC_CHANNELS.IMPORT_FROM_ZOTERO, async (_e, projectId: string, options) =>
    sourceSvc.importFromZotero(projectId, options ?? {}),
  )

  // ===== M3：研究协议（版本化 + 批准门禁 + G3 访问守卫） =====
  const protocolSvc = require('./protocol-service') as typeof import('./protocol-service')
  ipcMain.handle(ACADEMIC_RESEARCH_IPC_CHANNELS.LIST_PROTOCOLS, async (_e, projectId: string) =>
    protocolSvc.listProtocols(projectId),
  )
  ipcMain.handle(ACADEMIC_RESEARCH_IPC_CHANNELS.CREATE_PROTOCOL, async (_e, projectId: string, input) =>
    protocolSvc.createProtocol(projectId, input),
  )
  ipcMain.handle(ACADEMIC_RESEARCH_IPC_CHANNELS.APPROVE_PROTOCOL, async (_e, projectId: string, version: number, input) =>
    protocolSvc.approveProtocol(projectId, version, input),
  )
  ipcMain.handle(ACADEMIC_RESEARCH_IPC_CHANNELS.REVISE_PROTOCOL, async (_e, projectId: string, input) =>
    protocolSvc.reviseProtocol(projectId, input),
  )
  // 领域方法 profile 只读暴露：渲染层据此渲染字段，避免规则两处维护
  ipcMain.handle(ACADEMIC_RESEARCH_IPC_CHANNELS.GET_DOMAIN_PROFILE, async () => ({
    profiles: listDomainProfiles(),
  }))

  // ===== M3.2：选题候选（选定 actor 由主进程确定） =====
  const proposalSvc = require('./proposal-service') as typeof import('./proposal-service')
  ipcMain.handle(ACADEMIC_RESEARCH_IPC_CHANNELS.LIST_TOPICS, async (_e, projectId: string) =>
    proposalSvc.listTopicProposals(projectId),
  )
  ipcMain.handle(ACADEMIC_RESEARCH_IPC_CHANNELS.CREATE_TOPIC, async (_e, projectId: string, draft) =>
    proposalSvc.createTopicProposal(projectId, draft),
  )
  ipcMain.handle(ACADEMIC_RESEARCH_IPC_CHANNELS.SELECT_TOPIC, async (_e, projectId: string, proposalId: string, input) =>
    proposalSvc.selectTopicProposal(projectId, proposalId, input ?? {}),
  )
  ipcMain.handle(ACADEMIC_RESEARCH_IPC_CHANNELS.REJECT_TOPIC, async (_e, projectId: string, proposalId: string, reason: string) =>
    proposalSvc.rejectTopicProposal(projectId, proposalId, reason),
  )

  // ===== M4：研究运行（受限本地执行） =====
  const runSvc = require('./run-service') as typeof import('./run-service')
  const runExecutor = require('./run-executor') as typeof import('./run-executor')
  ipcMain.handle(ACADEMIC_RESEARCH_IPC_CHANNELS.LIST_RUNS, async (_e, projectId: string) =>
    runSvc.listRuns(projectId),
  )
  ipcMain.handle(ACADEMIC_RESEARCH_IPC_CHANNELS.CREATE_RUN, async (_e, projectId: string, request) =>
    runSvc.createAndExecuteRun(projectId, request),
  )
  ipcMain.handle(ACADEMIC_RESEARCH_IPC_CHANNELS.CANCEL_RUN, async (_e, projectId: string, runId: string) =>
    runSvc.cancelRun(projectId, runId),
  )
  ipcMain.handle(ACADEMIC_RESEARCH_IPC_CHANNELS.RECORD_OBSERVATION, async (_e, projectId: string, input) =>
    runSvc.recordObservation(projectId, input),
  )
  ipcMain.handle(ACADEMIC_RESEARCH_IPC_CHANNELS.LIST_OBSERVATIONS, async (_e, projectId: string) =>
    runSvc.listObservations(projectId),
  )
  ipcMain.handle(ACADEMIC_RESEARCH_IPC_CHANNELS.LIST_ARTIFACTS, async (_e, projectId: string) =>
    runSvc.listArtifacts(projectId),
  )
  ipcMain.handle(ACADEMIC_RESEARCH_IPC_CHANNELS.GET_ALLOWED_INTERPRETERS, async () => ({
    interpreters: runExecutor.ALLOWED_INTERPRETER_LIST,
  }))
  ipcMain.handle(ACADEMIC_RESEARCH_IPC_CHANNELS.RECONCILE_RUNS, async (_e, projectId: string) =>
    runSvc.reconcileInterruptedRuns(projectId),
  )
  ipcMain.handle(ACADEMIC_RESEARCH_IPC_CHANNELS.READ_RUN_LOG, async (_e, projectId: string, runId: string, options) =>
    runSvc.readRunLog(projectId, runId, options ?? {}),
  )
  ipcMain.handle(ACADEMIC_RESEARCH_IPC_CHANNELS.RECORD_ARTIFACT, async (_e, projectId: string, input) =>
    runSvc.recordArtifact(projectId, input),
  )

  // ===== M6.2：外部运行导入与 DVC 指针 =====
  const orxAdapter = require('./adapters/openresearch-adapter') as typeof import('./adapters/openresearch-adapter')
  ipcMain.handle(ACADEMIC_RESEARCH_IPC_CHANNELS.IMPORT_EXTERNAL_RUNS, async (_e, projectId: string, input) =>
    runSvc.importExternalRuns(projectId, input),
  )
  ipcMain.handle(ACADEMIC_RESEARCH_IPC_CHANNELS.IMPORT_DVC_POINTER, async (_e, projectId: string, input) =>
    runSvc.registerDvcPointer(projectId, input),
  )
  ipcMain.handle('academic-research:fetch-external-runs', async (_e, orxProjectId: string) => {
    const adapter = orxAdapter.createOpenResearchAdapter()
    return { runs: await adapter.listRuns(orxProjectId) }
  })

  // ===== M5：主张、证据关联与稿件 =====
  const claimSvc = require('./claim-service') as typeof import('./claim-service')
  ipcMain.handle(ACADEMIC_RESEARCH_IPC_CHANNELS.LIST_CLAIMS, async (_e, projectId: string) =>
    claimSvc.listClaims(projectId),
  )
  ipcMain.handle(ACADEMIC_RESEARCH_IPC_CHANNELS.CREATE_CLAIM, async (_e, projectId: string, input) =>
    claimSvc.createClaim(projectId, input),
  )
  ipcMain.handle(ACADEMIC_RESEARCH_IPC_CHANNELS.LINK_EVIDENCE, async (_e, projectId: string, input) =>
    claimSvc.linkEvidence(projectId, input),
  )
  ipcMain.handle(ACADEMIC_RESEARCH_IPC_CHANNELS.SET_CLAIM_STATUS, async (_e, projectId: string, claimId: string, status, options) =>
    claimSvc.setClaimStatus(projectId, claimId, status, options ?? {}),
  )
  ipcMain.handle(ACADEMIC_RESEARCH_IPC_CHANNELS.PROPAGATE_INVALIDATION, async (_e, projectId: string, change) =>
    claimSvc.propagateInvalidation(projectId, change),
  )
  ipcMain.handle(ACADEMIC_RESEARCH_IPC_CHANNELS.LIST_MANUSCRIPTS, async (_e, projectId: string) =>
    claimSvc.listManuscripts(projectId),
  )
  ipcMain.handle(ACADEMIC_RESEARCH_IPC_CHANNELS.CREATE_MANUSCRIPT_VERSION, async (_e, projectId: string, draft) =>
    claimSvc.createManuscriptVersion(projectId, draft),
  )
  ipcMain.handle(ACADEMIC_RESEARCH_IPC_CHANNELS.EXPORT_PREFLIGHT, async (_e, projectId: string) =>
    claimSvc.runExportPreflight(projectId),
  )

  // ===== M6：外部工具集成（描述符 + 探测；不内置上游产物） =====
  const toolSvc = require('./external-tool-service') as typeof import('./external-tool-service')
  const toolRules = require('@gravitas/core/services/academic') as typeof import('@gravitas/core/services/academic')
  ipcMain.handle(ACADEMIC_RESEARCH_IPC_CHANNELS.PROBE_EXTERNAL_TOOLS, async () => toolSvc.probeAllTools())
  ipcMain.handle(ACADEMIC_RESEARCH_IPC_CHANNELS.LIST_EXTERNAL_TOOLS, async () => ({
    descriptors: toolSvc.listToolDescriptors(),
    configs: toolSvc.listToolConfigs(),
  }))
  ipcMain.handle(ACADEMIC_RESEARCH_IPC_CHANNELS.SET_EXTERNAL_TOOL, async (_e, input: { toolId: string; enabled: boolean; licenseAcknowledged?: boolean; pinnedVersion?: string }) => {
    const descriptor = toolSvc.getToolDescriptor(input.toolId)
    const existing = toolSvc.getToolConfig(input.toolId)
    const licenseAcknowledgedAt = input.licenseAcknowledged
      ? (existing.licenseAcknowledgedAt ?? new Date().toISOString())
      : undefined

    toolRules.validateToolEnableRequest({
      enabled: input.enabled,
      licenseAcknowledgedAt,
      pinnedVersion: input.pinnedVersion,
      descriptor,
    })

    return toolSvc.saveToolConfig({
      toolId: input.toolId,
      enabled: input.enabled,
      licenseAcknowledgedAt,
      pinnedVersion: input.pinnedVersion?.trim() || existing.pinnedVersion,
    })
  })
}

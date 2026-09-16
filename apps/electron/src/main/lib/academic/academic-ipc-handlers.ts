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
}

/**
 * 研究项目应用服务（M1）
 *
 * UI 与 Agent 工具共用的唯一入口。分层职责：
 * - 输入/状态校验：@gravitas/core/services/academic 的纯规则
 * - 持久化：research-store（事件 JSONL，权威记录）
 * - 本服务：编排 + 错误归一，不做权益判定（工具注入层负责，
 *   与 academic-service 现有分层一致；IPC 门禁在 M1 后续补齐）
 */

import { randomUUID } from 'node:crypto'
import {
  RESEARCH_ERROR_CODES,
  ResearchError,
  type CreateResearchProjectInput,
  type ResearchBrief,
  type ResearchProject,
  type ResearchProjectStatus,
} from '@gravitas/shared'
import {
  assertStatusTransition,
  validateCreateResearchProject,
  validateResearchBrief,
} from '@gravitas/core/services/academic'
import { appendEvent, listResearchProjectIds, loadProjectState } from './research-store'

/** 创建研究项目 */
export async function createResearchProject(
  input: CreateResearchProjectInput,
): Promise<ResearchProject> {
  validateCreateResearchProject(input)

  const now = new Date().toISOString()
  const project: ResearchProject = {
    id: randomUUID(),
    title: input.title.trim(),
    domain: input.domain,
    methodPath: input.methodPath,
    status: 'defining',
    brief: input.brief,
    workspaceId: input.workspaceId,
    sensitivity: input.sensitivity ?? 'internal',
    revision: 1,
    createdAt: now,
    updatedAt: now,
  }

  await appendEvent(project.id, {
    commandId: `create-${project.id}`,
    payload: { type: 'project_created', project },
  })
  return project
}

/** 读取单个研究项目；不存在返回 null */
export async function getResearchProject(id: string): Promise<ResearchProject | null> {
  const state = await loadProjectState(id)
  return state.project
}

/** 列出本机全部研究项目（按更新时间倒序） */
export async function listResearchProjects(): Promise<ResearchProject[]> {
  const ids = await listResearchProjectIds()
  const projects: ResearchProject[] = []
  for (const id of ids) {
    const state = await loadProjectState(id)
    if (state.project) projects.push(state.project)
  }
  return projects.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

/** 更新研究问题定义（Brief） */
export async function updateResearchBrief(
  id: string,
  brief: ResearchBrief,
  changeReason: string,
): Promise<ResearchProject> {
  validateResearchBrief(brief)
  if (!changeReason?.trim()) {
    throw new ResearchError(RESEARCH_ERROR_CODES.INVALID_INPUT, '修改 Brief 必须说明理由')
  }

  const state = await loadProjectState(id)
  if (!state.project) {
    throw new ResearchError(RESEARCH_ERROR_CODES.NOT_FOUND, `研究项目不存在: ${id}`)
  }

  await appendEvent(id, {
    commandId: `brief-${randomUUID()}`,
    expectedRevision: state.revision,
    payload: { type: 'brief_updated', brief, changeReason },
  })
  const updated = await loadProjectState(id)
  return updated.project!
}

/** 推进/回流研究项目状态 */
export async function changeResearchStatus(
  id: string,
  to: ResearchProjectStatus,
  reason?: string,
): Promise<ResearchProject> {
  const state = await loadProjectState(id)
  if (!state.project) {
    throw new ResearchError(RESEARCH_ERROR_CODES.NOT_FOUND, `研究项目不存在: ${id}`)
  }
  assertStatusTransition(state.project.status, to)

  await appendEvent(id, {
    commandId: `status-${randomUUID()}`,
    expectedRevision: state.revision,
    payload: { type: 'status_changed', from: state.project.status, to, reason },
  })
  const updated = await loadProjectState(id)
  return updated.project!
}

/** 归档研究项目 */
export async function archiveResearchProject(id: string, reason?: string): Promise<ResearchProject> {
  const state = await loadProjectState(id)
  if (!state.project) {
    throw new ResearchError(RESEARCH_ERROR_CODES.NOT_FOUND, `研究项目不存在: ${id}`)
  }
  assertStatusTransition(state.project.status, 'archived')

  await appendEvent(id, {
    commandId: `archive-${randomUUID()}`,
    expectedRevision: state.revision,
    payload: { type: 'project_archived', reason },
  })
  const updated = await loadProjectState(id)
  return updated.project!
}

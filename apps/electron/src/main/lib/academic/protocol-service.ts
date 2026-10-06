/**
 * 研究协议应用服务（M3）
 *
 * 版本化协议 + 人工批准门禁。所有写操作先过 access-guard（G3）：
 * actor 由主进程确定，projectId 必须可访问。
 */

import { randomUUID } from 'node:crypto'
import type {
  ResearchDomain,
  ResearchMethodPath,
  ResearchProtocol,
  ResearchProject,
} from '@gravitas/shared'
import { RESEARCH_ERROR_CODES, ResearchError } from '@gravitas/shared'
import {
  evaluateApproval,
  nextProtocolVersion,
  validateProtocolDraft,
  validateProtocolRevision,
} from '@gravitas/core/services/academic'
import { appendEvent, loadProjectState, readProjectEvents } from './research-store'
import { assertProjectAccess, currentActor } from './access-guard'

async function loadProject(id: string): Promise<ResearchProject | null> {
  const state = await loadProjectState(id)
  return state.project
}

/** 读取项目全部协议版本（按版本号升序） */
export async function listProtocols(projectId: string): Promise<ResearchProtocol[]> {
  await assertProjectAccess(projectId, loadProject)
  const events = await readProjectEvents(projectId)
  const protocols: ResearchProtocol[] = []
  for (const envelope of events) {
    const payload = envelope.payload
    if (payload.type === 'protocol_created') protocols.push(payload.protocol)
    if (payload.type === 'protocol_revised') protocols.push(payload.protocol)
    if (payload.type === 'protocol_approved') {
      const target = protocols.find((p) => p.id === payload.protocolId && p.version === payload.version)
      if (target) {
        target.status = 'approved'
        target.approval = {
          approvedBy: payload.approvedBy,
          approvedAt: envelope.at,
          note: payload.note,
        }
      }
    }
    if (payload.type === 'protocol_revised') {
      // 每个协议版本有独立 id，取代关系按「项目内版本号」确定
      const superseded = protocols.find((p) => p.version === payload.supersedesVersion)
      if (superseded) superseded.status = 'superseded'
    }
  }
  return protocols.sort((a, b) => a.version - b.version)
}

/** 当前生效（最新）协议版本 */
export async function getLatestProtocol(projectId: string): Promise<ResearchProtocol | null> {
  const all = await listProtocols(projectId)
  return all.length > 0 ? all[all.length - 1]! : null
}

export interface CreateProtocolInput {
  methodPath: ResearchMethodPath
  fields: Record<string, string>
}

/** 创建协议草稿（v1） */
export async function createProtocol(
  projectId: string,
  input: CreateProtocolInput,
): Promise<ResearchProtocol> {
  const project = await assertProjectAccess(projectId, loadProject)
  const domain = project.domain as ResearchDomain
  validateProtocolDraft(domain, { methodPath: input.methodPath, fields: input.fields })

  const existing = await listProtocols(projectId)
  if (existing.some((p) => p.status !== 'superseded')) {
    throw new ResearchError(
      RESEARCH_ERROR_CODES.INVALID_INPUT,
      '已存在未取代的协议版本；修改请使用「修订协议」以保留变更痕迹',
    )
  }

  const now = new Date().toISOString()
  const protocol: ResearchProtocol = {
    id: randomUUID(),
    projectId,
    version: nextProtocolVersion(existing),
    status: 'draft',
    methodPath: input.methodPath,
    fields: input.fields,
    acknowledgedChecks: [],
    createdAt: now,
    updatedAt: now,
  }

  await appendEvent(projectId, {
    commandId: `protocol-${randomUUID()}`,
    payload: { type: 'protocol_created', protocol },
  })
  return protocol
}

/**
 * 批准协议。
 *
 * 门禁：必填字段 + 全部启用检查项已确认 + 涉及人类参与者的伦理依据。
 * actor 由主进程确定，调用方无法指定（否则可自我批准）。
 */
export async function approveProtocol(
  projectId: string,
  protocolVersion: number,
  input: { acknowledgedChecks: string[]; note?: string },
): Promise<ResearchProtocol> {
  const project = await assertProjectAccess(projectId, loadProject)
  const domain = project.domain as ResearchDomain
  const protocols = await listProtocols(projectId)
  const target = protocols.find((p) => p.version === protocolVersion)
  if (!target) {
    throw new ResearchError(RESEARCH_ERROR_CODES.NOT_FOUND, `协议版本不存在: v${protocolVersion}`)
  }
  if (target.status === 'approved') {
    throw new ResearchError(RESEARCH_ERROR_CODES.INVALID_INPUT, `协议 v${protocolVersion} 已批准`)
  }
  if (target.status === 'superseded') {
    throw new ResearchError(
      RESEARCH_ERROR_CODES.INVALID_INPUT,
      `协议 v${protocolVersion} 已被新版本取代，不能批准`,
    )
  }

  // 以调用方提交的确认清单评估；评估结果才是门禁
  const candidate = { ...target, acknowledgedChecks: input.acknowledgedChecks ?? [] }
  const evaluation = evaluateApproval(domain, candidate)
  if (!evaluation.ok) {
    throw new ResearchError(
      RESEARCH_ERROR_CODES.INVALID_INPUT,
      `协议不满足批准条件：${evaluation.blockers.join('；')}`,
    )
  }

  const actor = currentActor()
  await appendEvent(projectId, {
    commandId: `protocol-approve-${randomUUID()}`,
    payload: {
      type: 'protocol_approved',
      protocolId: target.id,
      version: target.version,
      approvedBy: actor,
      checklist: evaluation.checkIds,
      note: input.note,
    },
  })

  const updated = (await listProtocols(projectId)).find((p) => p.version === protocolVersion)!
  return updated
}

/** 修订已批准协议：产生新版本，旧版本标记 superseded（旧批准不沿用） */
export async function reviseProtocol(
  projectId: string,
  input: { changeReason: string; methodPath: ResearchMethodPath; fields: Record<string, string> },
): Promise<ResearchProtocol> {
  const project = await assertProjectAccess(projectId, loadProject)
  const domain = project.domain as ResearchDomain
  const protocols = await listProtocols(projectId)
  const latest = protocols[protocols.length - 1]
  if (!latest) {
    throw new ResearchError(RESEARCH_ERROR_CODES.NOT_FOUND, '尚未创建协议，无法修订')
  }

  validateProtocolRevision(domain, { version: latest.version, status: latest.status }, input)
  // 新版本的字段完整性与方法路径同样受领域约束（必填缺失允许保存草稿，批准时再拦）
  validateProtocolDraft(domain, { methodPath: input.methodPath, fields: input.fields })

  const now = new Date().toISOString()
  const revised: ResearchProtocol = {
    id: randomUUID(),
    projectId,
    version: nextProtocolVersion(protocols),
    status: 'draft',
    methodPath: input.methodPath,
    fields: input.fields,
    acknowledgedChecks: [],
    createdAt: now,
    updatedAt: now,
    changeReason: input.changeReason.trim(),
  }

  await appendEvent(projectId, {
    commandId: `protocol-revise-${randomUUID()}`,
    payload: {
      type: 'protocol_revised',
      protocol: revised,
      supersedesVersion: latest.version,
      changeReason: input.changeReason.trim(),
    },
  })
  return revised
}

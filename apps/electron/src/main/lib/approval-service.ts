/**
 * ApprovalService - 审批流管理
 *
 * 管理所有需要用户确认的主动变更：
 * - memory write（记忆写入）
 * - skill（技能创建/修改）
 * - file（文件写入）
 * - command（命令执行）
 * - schedule（定时任务创建）
 * - monitor（监听任务创建）
 *
 * 状态：pending → approved / rejected / edited
 * 支持 diff 展示、来源追溯、审计记录
 */

import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { getProactiveConfigPath } from './config-paths'
import type { ProactiveApproval, ApprovalStatus, ApprovalSourceType } from '@gravitas/shared'

const APPROVALS_FILE = 'approvals.json'

/** 内存缓存 */
let approvalsCache: ProactiveApproval[] | null = null

function getApprovalsFilePath(): string {
  return join(getProactiveConfigPath(), APPROVALS_FILE)
}

function ensureDir(): void {
  const dir = getProactiveConfigPath()
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
}

function loadApprovals(): ProactiveApproval[] {
  if (approvalsCache) return approvalsCache
  const path = getApprovalsFilePath()
  if (!existsSync(path)) return []
  try {
    const data = JSON.parse(readFileSync(path, 'utf-8'))
    approvalsCache = Array.isArray(data) ? data : []
    return approvalsCache
  } catch {
    return []
  }
}

function saveApprovals(approvals: ProactiveApproval[]): void {
  ensureDir()
  writeFileSync(getApprovalsFilePath(), JSON.stringify(approvals, null, 2))
  approvalsCache = approvals
}

// ===== CRUD =====

export function listApprovals(): ProactiveApproval[] {
  return loadApprovals()
}

export function getPendingApprovals(): ProactiveApproval[] {
  return loadApprovals().filter((a) => a.status === 'pending')
}

export function getApproval(id: string): ProactiveApproval | undefined {
  return loadApprovals().find((a) => a.id === id)
}

export interface CreateApprovalInput {
  runId?: string
  sourceType: ApprovalSourceType
  title: string
  summary: string
  proposedChange: unknown
}

export function createApproval(input: CreateApprovalInput): ProactiveApproval {
  const approval: ProactiveApproval = {
    id: randomUUID(),
    runId: input.runId,
    sourceType: input.sourceType,
    title: input.title,
    summary: input.summary,
    proposedChange: input.proposedChange,
    status: 'pending',
    createdAt: Date.now(),
  }
  const approvals = loadApprovals()
  approvals.push(approval)
  saveApprovals(approvals)
  return approval
}

export function approveApproval(id: string): ProactiveApproval | null {
  const approvals = loadApprovals()
  const idx = approvals.findIndex((a) => a.id === id)
  if (idx === -1) return null
  const updated = { ...approvals[idx], status: 'approved' as const, resolvedAt: Date.now() }
  approvals[idx] = updated as ProactiveApproval
  saveApprovals(approvals)

  // TODO: 执行批准的变更
  // executeApprovedChange(approvals[idx])

  return approvals[idx]
}

export function rejectApproval(id: string): ProactiveApproval | null {
  const approvals = loadApprovals()
  const idx = approvals.findIndex((a) => a.id === id)
  if (idx === -1) return null
  const updated = { ...approvals[idx], status: 'rejected' as const, resolvedAt: Date.now() }
  approvals[idx] = updated as ProactiveApproval
  saveApprovals(approvals)
  return approvals[idx]
}

export function editApproval(id: string, editedChange: unknown): ProactiveApproval | null {
  const approvals = loadApprovals()
  const idx = approvals.findIndex((a) => a.id === id)
  if (idx === -1) return null
  const updated = {
    ...approvals[idx],
    proposedChange: editedChange,
    status: 'edited' as const,
    resolvedAt: Date.now(),
  }
  approvals[idx] = updated as ProactiveApproval
  saveApprovals(approvals)

  // TODO: 执行编辑后的变更
  // executeApprovedChange(approvals[idx])

  return approvals[idx]
}

export function deleteApproval(id: string): boolean {
  const approvals = loadApprovals()
  const filtered = approvals.filter((a) => a.id !== id)
  if (filtered.length === approvals.length) return false
  saveApprovals(filtered)
  return true
}

// ===== 批量操作 =====

export function approveAllPending(): number {
  const approvals = loadApprovals()
  let count = 0
  for (const approval of approvals) {
    if (approval.status === 'pending') {
      approval.status = 'approved'
      approval.resolvedAt = Date.now()
      count++
    }
  }
  if (count > 0) saveApprovals(approvals)
  return count
}

export function rejectAllPending(): number {
  const approvals = loadApprovals()
  let count = 0
  for (const approval of approvals) {
    if (approval.status === 'pending') {
      approval.status = 'rejected'
      approval.resolvedAt = Date.now()
      count++
    }
  }
  if (count > 0) saveApprovals(approvals)
  return count
}

// ===== 统计 =====

export function getApprovalStats(): {
  total: number
  pending: number
  approved: number
  rejected: number
  edited: number
} {
  const approvals = loadApprovals()
  return {
    total: approvals.length,
    pending: approvals.filter((a) => a.status === 'pending').length,
    approved: approvals.filter((a) => a.status === 'approved').length,
    rejected: approvals.filter((a) => a.status === 'rejected').length,
    edited: approvals.filter((a) => a.status === 'edited').length,
  }
}

// ===== 自动创建审批（供其他服务调用） =====

/**
 * 为记忆写入创建审批
 */
export function createMemoryApproval(runId: string | undefined, memoryTitle: string, proposedContent: string): ProactiveApproval {
  return createApproval({
    runId,
    sourceType: 'memory',
    title: `记忆写入: ${memoryTitle}`,
    summary: `建议将以下内容写入长期记忆`,
    proposedChange: { type: 'memory_write', title: memoryTitle, content: proposedContent },
  })
}

/**
 * 为 Skill 创建审批
 */
export function createSkillApproval(runId: string | undefined, skillName: string, skillContent: string): ProactiveApproval {
  return createApproval({
    runId,
    sourceType: 'skill',
    title: `创建 Skill: ${skillName}`,
    summary: `建议创建新 Skill`,
    proposedChange: { type: 'skill_create', name: skillName, content: skillContent },
  })
}

/**
 * 为文件写入创建审批
 */
export function createFileApproval(runId: string | undefined, filePath: string, proposedContent: string): ProactiveApproval {
  return createApproval({
    runId,
    sourceType: 'file',
    title: `文件写入: ${filePath}`,
    summary: `建议写入文件`,
    proposedChange: { type: 'file_write', path: filePath, content: proposedContent },
  })
}

/**
 * 为命令执行创建审批
 */
export function createCommandApproval(runId: string | undefined, command: string, reason: string): ProactiveApproval {
  return createApproval({
    runId,
    sourceType: 'command',
    title: `执行命令: ${command.slice(0, 50)}`,
    summary: reason,
    proposedChange: { type: 'command_execute', command },
  })
}

// ===== IPC 处理器注册 =====

export function registerApprovalIPCHandlers(): void {
  const { ipcMain } = require('electron')

  ipcMain.handle('proactive:listApprovals', () => listApprovals())
  ipcMain.handle('proactive:getPendingApprovals', () => getPendingApprovals())
  ipcMain.handle('proactive:getApproval', (_event: unknown, id: string) => getApproval(id))
  ipcMain.handle('proactive:createApproval', (_event: unknown, input: CreateApprovalInput) => createApproval(input))
  ipcMain.handle('proactive:approveApproval', (_event: unknown, id: string) => approveApproval(id))
  ipcMain.handle('proactive:rejectApproval', (_event: unknown, id: string) => rejectApproval(id))
  ipcMain.handle('proactive:editApproval', (_event: unknown, id: string, editedChange: unknown) => editApproval(id, editedChange))
  ipcMain.handle('proactive:deleteApproval', (_event: unknown, id: string) => deleteApproval(id))
  ipcMain.handle('proactive:approveAllPending', () => approveAllPending())
  ipcMain.handle('proactive:rejectAllPending', () => rejectAllPending())
  ipcMain.handle('proactive:getApprovalStats', () => getApprovalStats())
}

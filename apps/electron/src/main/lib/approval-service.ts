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

/**
 * 主进程在启动时注册实际变更执行器。ApprovalService 不自行执行文件、
 * 命令或 Agent 操作，避免审批数据绕过既有权限与工作区边界。
 */
export type ApprovedChangeExecutor = (approval: ProactiveApproval) => Promise<void>
let approvedChangeExecutor: ApprovedChangeExecutor | undefined

export function setApprovedChangeExecutor(executor: ApprovedChangeExecutor): void {
  approvedChangeExecutor = executor
}

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
  // 编辑后的提案必须再次回到待确认队列，不能因为已编辑而绕过审批。
  return loadApprovals().filter((a) => a.status === 'pending' || a.status === 'edited')
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

export async function approveApproval(id: string): Promise<ProactiveApproval | null> {
  const approvals = loadApprovals()
  const idx = approvals.findIndex((a) => a.id === id)
  if (idx === -1) return null
  const current = approvals[idx]!
  if (current.status !== 'pending' && current.status !== 'edited') return current

  const updated: ProactiveApproval = {
    ...current,
    status: 'approved',
    resolvedAt: Date.now(),
    executionStatus: 'pending',
    executionError: undefined,
    executedAt: undefined,
  }
  approvals[idx] = updated as ProactiveApproval
  saveApprovals(approvals)

  try {
    if (!approvedChangeExecutor) throw new Error('审批执行器未就绪')
    await approvedChangeExecutor(updated)
    return updateApprovalExecution(updated.id, 'succeeded')
  } catch (error) {
    const message = error instanceof Error ? error.message : '批准的变更执行失败'
    return updateApprovalExecution(updated.id, 'failed', message)
  }
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
    resolvedAt: undefined,
    executionStatus: undefined,
    executionError: undefined,
    executedAt: undefined,
  }
  approvals[idx] = updated as ProactiveApproval
  saveApprovals(approvals)

  return approvals[idx]
}

function updateApprovalExecution(
  id: string,
  executionStatus: 'succeeded' | 'failed',
  executionError?: string,
): ProactiveApproval | null {
  const approvals = loadApprovals()
  const idx = approvals.findIndex((approval) => approval.id === id)
  if (idx === -1) return null
  const updated: ProactiveApproval = {
    ...approvals[idx]!,
    executionStatus,
    executionError,
    executedAt: Date.now(),
  }
  approvals[idx] = updated
  saveApprovals(approvals)
  emitApprovalExecutionEvent(updated)
  return updated
}

function emitApprovalExecutionEvent(approval: ProactiveApproval): void {
  try {
    const { getRunStore } = require('./run-store') as { getRunStore: () => { record: (event: import('@gravitas/shared').AppEventEnvelope) => void } }
    getRunStore().record({
      id: `approval-${approval.id}-${approval.executionStatus}`,
      source: 'automation',
      taskId: approval.runId ?? approval.id,
      title: approval.title,
      timestamp: Date.now(),
      ...(approval.executionStatus === 'succeeded'
        ? { type: 'completed' as const, detail: '已批准并执行' }
        : { type: 'failed' as const, detail: approval.executionError ?? '批准后执行失败' }),
    })
  } catch {
    // 运行中心不可用时保留本地审批事实，不阻塞决策结果落盘。
  }
}

export function deleteApproval(id: string): boolean {
  const approvals = loadApprovals()
  const filtered = approvals.filter((a) => a.id !== id)
  if (filtered.length === approvals.length) return false
  saveApprovals(filtered)
  return true
}

// ===== 批量操作 =====

export async function approveAllPending(): Promise<number> {
  const pendingIds = getPendingApprovals().map((approval) => approval.id)
  for (const id of pendingIds) await approveApproval(id)
  return pendingIds.length
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
export function createMemoryApproval(
  runId: string | undefined,
  memoryTitle: string,
  proposedContent: string,
  metadata?: { kind?: string; tags?: string[]; confidence?: number; sourceSessionId?: string | null },
): ProactiveApproval {
  return createApproval({
    runId,
    sourceType: 'memory',
    title: `记忆写入: ${memoryTitle}`,
    summary: `建议将以下内容写入长期记忆`,
    proposedChange: { type: 'memory_write', title: memoryTitle, content: proposedContent, ...metadata },
  })
}

/**
 * 为 Skill 创建审批
 */
export function createSkillApproval(runId: string | undefined, workspaceId: string, skillName: string, skillContent: string): ProactiveApproval {
  return createApproval({
    runId,
    sourceType: 'skill',
    title: `创建 Skill: ${skillName}`,
    summary: `建议创建新 Skill`,
    proposedChange: { type: 'skill_create', workspaceId, name: skillName, content: skillContent },
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

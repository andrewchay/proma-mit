/**
 * Agent 互调协议服务 — Agent Invoke Service（PH2-F）
 *
 * 让一个 Agent/成员「把任务/请求发送给另一位成员（真人或 AI 员工）的 Agent」，
 * 对方在自己的 Mailbox 里看到并可以接受/回答/执行——即「他人可调用你的 Agent 做确认/小任务」。
 *
 * 实现：把 invoke-request 作为一条可流转、可指派到成员的事件，落 JSONL；
 * 通过 Team Mailbox（PH2-C）暴露给目标成员/其 Agent。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { getConfigDir } from './config-paths'

export type InvokeRequestStatus = 'open' | 'accepted' | 'done' | 'declined'

export interface AgentInvokeRequest {
  id: string
  fromMemberId: string
  toMemberId: string
  /** 请求任务（做什么/问什么/确认什么） */
  task: string
  status: InvokeRequestStatus
  /** 接受/完成的回复 */
  result?: string
  /** 调用方提供的幂等键；相同键的同一请求重试不会重复进入收件箱。 */
  idempotencyKey?: string
  createdAt: number
  updatedAt: number
}

const MAX_INVOKES = 2000
/** 单条请求 task / result 文本长度上限（防超长文本使 JSONL 膨胀 / 刷屏 Mailbox）。 */
const TASK_CHAR_LIMIT = 10_000
const RESULT_CHAR_LIMIT = 10_000
const IDEMPOTENCY_KEY_CHAR_LIMIT = 256
const INVOKE_STATUSES = new Set<InvokeRequestStatus>(['open', 'accepted', 'done', 'declined'])

function file(): string {
  const dir = join(getConfigDir(), 'agent-invokes')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return join(dir, 'invokes.jsonl')
}

function isAgentInvokeRequest(value: unknown): value is AgentInvokeRequest {
  if (!value || typeof value !== 'object') return false
  const request = value as Partial<AgentInvokeRequest>
  return typeof request.id === 'string'
    && typeof request.fromMemberId === 'string'
    && typeof request.toMemberId === 'string'
    && typeof request.task === 'string'
    && typeof request.status === 'string'
    && INVOKE_STATUSES.has(request.status as InvokeRequestStatus)
    && (request.result === undefined || typeof request.result === 'string')
    && (request.idempotencyKey === undefined || typeof request.idempotencyKey === 'string')
    && typeof request.createdAt === 'number'
    && Number.isFinite(request.createdAt)
    && typeof request.updatedAt === 'number'
    && Number.isFinite(request.updatedAt)
}

function readAll(): AgentInvokeRequest[] {
  const p = file()
  if (!existsSync(p)) return []

  return readFileSync(p, 'utf-8').split('\n').flatMap((line, index): AgentInvokeRequest[] => {
    if (!line.trim()) return []
    try {
      const parsed: unknown = JSON.parse(line)
      if (!isAgentInvokeRequest(parsed)) {
        throw new Error('记录字段不完整')
      }
      return [parsed]
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      throw new Error(`Agent 互调存储损坏（第 ${index + 1} 行）：${reason}`, { cause: error })
    }
  })
}

function writeAll(requests: AgentInvokeRequest[]): void {
  const p = file()
  const tempPath = `${p}.tmp-${process.pid}-${randomUUID()}`
  const content = requests.map((request) => JSON.stringify(request)).join('\n') + (requests.length ? '\n' : '')

  try {
    writeFileSync(tempPath, content, { encoding: 'utf-8', flag: 'wx' })
    renameSync(tempPath, p)
  } catch (error) {
    try {
      unlinkSync(tempPath)
    } catch {
      // 临时文件可能尚未创建，或已被 rename 移走。
    }
    throw error
  }
}

function normalizeIdempotencyKey(idempotencyKey: string | undefined): string | undefined {
  if (idempotencyKey === undefined) return undefined
  const normalized = idempotencyKey.trim()
  if (!normalized) throw new Error('Agent 互调幂等键不能为空')
  if (normalized.length > IDEMPOTENCY_KEY_CHAR_LIMIT) {
    throw new Error(`Agent 互调幂等键不能超过 ${IDEMPOTENCY_KEY_CHAR_LIMIT} 个字符`)
  }
  return normalized
}

/** 发送一个互调请求给某成员（真人 / AI 员工）。 */
export function sendAgentInvoke(
  fromMemberId: string,
  toMemberId: string,
  task: string,
  idempotencyKey?: string,
): AgentInvokeRequest {
  const normalizedTask = task.slice(0, TASK_CHAR_LIMIT)
  const normalizedIdempotencyKey = normalizeIdempotencyKey(idempotencyKey)
  const all = readAll()

  if (normalizedIdempotencyKey) {
    const existing = all.find((request) => request.idempotencyKey === normalizedIdempotencyKey)
    if (existing) {
      if (
        existing.fromMemberId !== fromMemberId
        || existing.toMemberId !== toMemberId
        || existing.task !== normalizedTask
      ) {
        throw new Error(`Agent 互调幂等键已用于不同请求：${normalizedIdempotencyKey}`)
      }
      return existing
    }
  }

  const now = Date.now()
  const req: AgentInvokeRequest = {
    id: `invoke-${now}-${Math.random().toString(36).slice(2, 6)}`,
    fromMemberId,
    toMemberId,
    task: normalizedTask,
    status: 'open',
    ...(normalizedIdempotencyKey ? { idempotencyKey: normalizedIdempotencyKey } : {}),
    createdAt: now,
    updatedAt: now,
  }
  all.unshift(req)
  writeAll(all.slice(0, MAX_INVOKES))
  console.log(`[Diag][agent-invoke] send ${req.fromMemberId} → ${req.toMemberId}: ${req.task.slice(0, 40)}`)
  return req
}

/** 列出某成员收到的互调请求（按时间倒序）。 */
export function listIncomingInvokes(toMemberId: string, status?: InvokeRequestStatus): AgentInvokeRequest[] {
  return readAll()
    .filter((request) => request.toMemberId === toMemberId && (!status || request.status === status))
    .sort((a, b) => b.createdAt - a.createdAt)
}

/** 更新互调请求状态（接受/完成/拒绝）并附结果。 */
export function respondToInvoke(id: string, status: InvokeRequestStatus, result?: string): AgentInvokeRequest | null {
  const all = readAll()
  const index = all.findIndex((request) => request.id === id)
  if (index === -1) return null
  const updated: AgentInvokeRequest = {
    ...all[index]!,
    status,
    ...(result ? { result: result.slice(0, RESULT_CHAR_LIMIT) } : {}),
    updatedAt: Date.now(),
  }
  all[index] = updated
  writeAll(all)
  console.log(`[Diag][agent-invoke] respond ${id} → ${status}`)
  return updated
}

/** 生成给目标成员/Agent 的可读摘要。 */
export function invokeToText(req: AgentInvokeRequest): string {
  return `【Agent 互调请求】来自 ${req.fromMemberId}\n${req.task}\n状态: ${req.status}${req.result ? `\n回复: ${req.result}` : ''}`
}

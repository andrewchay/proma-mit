/**
 * Agent 互调协议服务 — Agent Invoke Service（PH2-F）
 *
 * 让一个 Agent/成员「把任务/请求发送给另一位成员（真人或 AI 员工）的 Agent」，
 * 对方在自己的 Mailbox 里看到并可以接受/回答/执行——即「他人可调用你的 Agent 做确认/小任务」。
 *
 * 实现：把 invoke-request 作为一条可流转、可指派到成员的事件，落 JSONL；
 * 通过 Team Mailbox（PH2-C）暴露给目标成员/其 Agent。
 */

import { mkdirSync, readFileSync, existsSync, appendFileSync } from 'node:fs'
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
  createdAt: number
  updatedAt: number
}

const MAX_INVOKES = 2000

function file(): string {
  const dir = join(getConfigDir(), 'agent-invokes')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return join(dir, 'invokes.jsonl')
}

function readAll(): AgentInvokeRequest[] {
  try {
    const p = file()
    if (!existsSync(p)) return []
    return readFileSync(p, 'utf-8').split('\n').flatMap((line): AgentInvokeRequest[] => {
      if (!line.trim()) return []
      try {
        return [JSON.parse(line) as AgentInvokeRequest]
      } catch {
        return []
      }
    })
  } catch {
    return []
  }
}

function writeAll(requests: AgentInvokeRequest[]): void {
  try {
    const p = file()
    const dir = join(getConfigDir(), 'agent-invokes')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    // 用追加式：清空后重写全部（小规模可接受）
    require('node:fs').writeFileSync(p, requests.map((r) => JSON.stringify(r)).join('\n') + (requests.length ? '\n' : ''), 'utf-8')
  } catch {
    // 忽略
  }
}

/** 发送一个互调请求给某成员（真人 / AI 员工）。 */
export function sendAgentInvoke(fromMemberId: string, toMemberId: string, task: string): AgentInvokeRequest {
  const req: AgentInvokeRequest = {
    id: `invoke-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    fromMemberId,
    toMemberId,
    task,
    status: 'open',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
  const all = readAll()
  all.unshift(req)
  writeAll(all.slice(0, MAX_INVOKES))
  return req
}

/** 列出某成员收到的互调请求（按时间倒序）。 */
export function listIncomingInvokes(toMemberId: string, status?: InvokeRequestStatus): AgentInvokeRequest[] {
  return readAll()
    .filter((r) => r.toMemberId === toMemberId && (!status || r.status === status))
    .sort((a, b) => b.createdAt - a.createdAt)
}

/** 更新互调请求状态（接受/完成/拒绝）并附结果。 */
export function respondToInvoke(id: string, status: InvokeRequestStatus, result?: string): AgentInvokeRequest | null {
  const all = readAll()
  const idx = all.findIndex((r) => r.id === id)
  if (idx === -1) return null
  const updated: AgentInvokeRequest = { ...all[idx]!, status, ...(result ? { result } : {}), updatedAt: Date.now() }
  all[idx] = updated
  writeAll(all)
  return updated
}

/** 生成给目标成员/Agent 的可读摘要。 */
export function invokeToText(req: AgentInvokeRequest): string {
  return `【Agent 互调请求】来自 ${req.fromMemberId}\n${req.task}\n状态: ${req.status}${req.result ? `\n回复: ${req.result}` : ''}`
}

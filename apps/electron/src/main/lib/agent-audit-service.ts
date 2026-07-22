/** 本地操作审计的读取与导出；不上传、不使用数据库。 */

import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AgentAuditEvent, AgentAuditQuery } from '@proma/shared'
import { getConfigDir } from './config-paths'

const MAX_AUDIT_EVENTS = 1_000

export async function listAgentAuditEvents(query: AgentAuditQuery = {}): Promise<AgentAuditEvent[]> {
  const sources = query.source && query.source !== 'all'
    ? [query.source]
    : ['web-bridge', 'computer-use'] as const
  const events = (await Promise.all(sources.map(readAuditSource))).flat()
    .filter((event) => (!query.sessionId || event.sessionId === query.sessionId) && (!query.action || event.action === query.action))
    .sort((left, right) => right.at.localeCompare(left.at))
  return events.slice(0, clampLimit(query.limit))
}

export async function exportAgentAuditEvents(filePath: string, query: AgentAuditQuery = {}): Promise<number> {
  const events = await listAgentAuditEvents({ ...query, limit: MAX_AUDIT_EVENTS })
  await writeFile(filePath, events.map(({ source, ...event }) => JSON.stringify({ ...event, source })).join('\n') + (events.length ? '\n' : ''), 'utf8')
  return events.length
}

async function readAuditSource(source: AgentAuditEvent['source']): Promise<AgentAuditEvent[]> {
  const path = join(getConfigDir(), `${source}-audit`, 'events.jsonl')
  try {
    const raw = await readFile(path, 'utf8')
    return raw.split('\n').flatMap((line): AgentAuditEvent[] => {
      if (!line.trim()) return []
      try {
        const parsed: unknown = JSON.parse(line)
        if (!isAuditEvent(parsed)) return []
        return [{ ...parsed, source }]
      } catch {
        return []
      }
    })
  } catch (error) {
    if (isNotFound(error)) return []
    throw error
  }
}

function isAuditEvent(value: unknown): value is Omit<AgentAuditEvent, 'source'> {
  return typeof value === 'object' && value !== null
    && typeof (value as Record<string, unknown>).at === 'string'
    && typeof (value as Record<string, unknown>).sessionId === 'string'
    && typeof (value as Record<string, unknown>).action === 'string'
    && typeof (value as Record<string, unknown>).detail === 'object'
    && (value as Record<string, unknown>).detail !== null
}

function isNotFound(error: unknown): boolean { return typeof error === 'object' && error !== null && (error as { code?: string }).code === 'ENOENT' }
function clampLimit(limit: number | undefined): number { return Math.min(Math.max(limit ?? 300, 1), MAX_AUDIT_EVENTS) }

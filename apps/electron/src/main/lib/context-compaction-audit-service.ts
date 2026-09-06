import { appendFileSync, mkdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { getConfigDir } from './config-paths'

export interface ContextCompactionAuditInput {
  sessionId: string
  runtime: 'proma' | 'ai-sdk' | 'pi' | 'claude'
  trigger: 'automatic' | 'manual' | 'overflow_recovery' | 'native'
  packetVersion?: number
  estimatedTokensAfter?: number
}

export function appendContextCompactionAudit(input: ContextCompactionAuditInput): void {
  const directory = join(getConfigDir(), 'context-compaction-audit')
  mkdirSync(directory, { recursive: true })
  appendFileSync(join(directory, 'events.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), ...input })}\n`, 'utf8')
}


export interface ContextCompactionMetrics {
  total: number
  byRuntime: Array<{ key: ContextCompactionAuditInput["runtime"]; count: number }>
  byTrigger: Array<{ key: ContextCompactionAuditInput["trigger"]; count: number }>
  latestAt?: string
}

/** 只聚合本机压缩事件的元数据，绝不读取或返回压缩包正文。 */
export async function getContextCompactionMetrics(): Promise<ContextCompactionMetrics> {
  const events = await readContextCompactionEvents()
  const latestAt = events.reduce<string | undefined>((latest, event) => !latest || latest < event.at ? event.at : latest, undefined)
  return {
    total: events.length,
    byRuntime: countBy(events, (event) => event.runtime),
    byTrigger: countBy(events, (event) => event.trigger),
    ...(latestAt && { latestAt }),
  }
}

interface ContextCompactionAuditEvent extends ContextCompactionAuditInput { at: string }

async function readContextCompactionEvents(): Promise<ContextCompactionAuditEvent[]> {
  try {
    const raw = await readFile(join(getConfigDir(), "context-compaction-audit", "events.jsonl"), "utf8")
    return raw.split("\n").flatMap((line): ContextCompactionAuditEvent[] => {
      if (!line.trim()) return []
      try {
        const value: unknown = JSON.parse(line)
        return isContextCompactionAuditEvent(value) ? [value] : []
      } catch { return [] }
    })
  } catch (error) {
    if (isNotFound(error)) return []
    throw error
  }
}

function isContextCompactionAuditEvent(value: unknown): value is ContextCompactionAuditEvent {
  if (typeof value !== "object" || value === null) return false
  const event = value as Record<string, unknown>
  return typeof event.at === "string" && typeof event.sessionId === "string" && isRuntime(event.runtime) && isTrigger(event.trigger)
}

function isRuntime(value: unknown): value is ContextCompactionAuditInput["runtime"] {
  return value === "proma" || value === "ai-sdk" || value === "pi" || value === "claude"
}

function isTrigger(value: unknown): value is ContextCompactionAuditInput["trigger"] {
  return value === "automatic" || value === "manual" || value === "overflow_recovery" || value === "native"
}

function countBy<Key extends string>(events: ContextCompactionAuditEvent[], getKey: (event: ContextCompactionAuditEvent) => Key): Array<{ key: Key; count: number }> {
  const counts = new Map<Key, number>()
  for (const event of events) {
    const key = getKey(event)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return [...counts.entries()].map(([key, count]) => ({ key, count })).sort((left, right) => left.key.localeCompare(right.key))
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "ENOENT"
}

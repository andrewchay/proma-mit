/** 配置变更审计服务 —— 记录渠道、工作区、MCP、Skill、设置、用户档案等配置变更。 */

import { appendFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { ConfigAuditEvent } from '@gravitas/shared'
import { getConfigDir } from './config-paths'

const ACTOR_USER = 'user'

/** 追加一条配置变更审计记录 */
export async function appendConfigAudit(event: Omit<ConfigAuditEvent, 'at' | 'actor'>): Promise<void> {
  const fullEvent: ConfigAuditEvent = {
    at: new Date().toISOString(),
    actor: ACTOR_USER,
    ...event,
  }
  const directory = join(getConfigDir(), 'config-audit')
  await mkdir(directory, { recursive: true })
  await appendFile(join(directory, 'events.jsonl'), `${JSON.stringify(fullEvent)}\n`, 'utf8')
}

/** 脱敏敏感字段：将 apiKey / clientSecret 等替换为 [REDACTED] */
export function redactSensitive(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === 'string' && isSensitiveKey(key)) {
      result[key] = value ? '[REDACTED]' : ''
    } else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      result[key] = redactSensitive(value as Record<string, unknown>)
    } else {
      result[key] = value
    }
  }
  return result
}

function isSensitiveKey(key: string): boolean {
  const lower = key.toLowerCase()
  return lower.includes('apikey') || lower.includes('api_key') || lower.includes('secret') || lower.includes('token') || lower.includes('password') || lower.includes('credential')
}

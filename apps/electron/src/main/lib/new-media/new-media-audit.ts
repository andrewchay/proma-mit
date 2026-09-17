import { randomUUID } from 'node:crypto'
import { getNewMediaRecord, listNewMediaRecords, putNewMediaRecords } from './new-media-sqlite-store'

/**
 * 新媒体统一审计事件规范。
 *
 * 账号授权、受控外发、发布交接与互动使用同一审计信封：
 * domain + event 由本文件的字典约束，detail 与 metadata 在写入前脱敏，
 * 且必须与状态迁移放在同一次 SQLite 事务里（putNewMediaRecords）。
 */

export type NewMediaAuditDomain = 'account' | 'publication' | 'community' | 'governance' | 'handoff' | 'import'

export interface NewMediaAuditMetadataValue {
  value: string | number | boolean
}

export interface NewMediaAuditEntry {
  id: string
  domain: NewMediaAuditDomain
  event: string
  actor: string
  subjectId: string
  detail: string
  createdAt: number
  /** 单调序号：同一毫秒内的多次迁移也能稳定排序。 */
  ordinal: number
  metadata?: Record<string, string | number | boolean>
}

/** 统一审计存储 kind：一次迁移后不再新增 per-domain 审计表。 */
export const NEW_MEDIA_AUDIT_KIND = 'new-media-audit'

/** 事件字典：domain → 允许的事件名。新增事件必须在此登记。 */
export const NEW_MEDIA_AUDIT_EVENTS = {
  account: ['account_created', 'authorization_started', 'connected', 'validation_failed', 'disconnected', 'removed'],
  publication: ['publication_scheduled'],
  community: ['engagement_ingested', 'reply_draft_created'],
  governance: ['requested', 'approved', 'rejected', 'simulated'],
  handoff: ['prepared', 'exported', 'user_confirmed_published'],
  import: ['report_batch_imported'],
} as const satisfies Record<NewMediaAuditDomain, readonly string[]>

export type NewMediaAuditEventName = (typeof NEW_MEDIA_AUDIT_EVENTS)[NewMediaAuditDomain][number]

const SENSITIVE_KEY_PATTERN = /(token|secret|cookie|password|passwd|authorization|credential|apikey|api_key|signature|code)/i
const REDACTION_PATTERNS: Array<[RegExp, string]> = [
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [已脱敏]'],
  [/\b(?:access_token|refresh_token|client_secret|appsecret|app_secret)\s*[=:]\s*[^\s,;"']+/gi, '[已脱敏凭据]'],
  [/\b[A-Za-z0-9_-]{32,}\b/g, '[已脱敏长凭据]'],
]

const LIMITS = { actor: 120, detail: 500, subjectId: 160, metadataEntries: 12, metadataText: 120 }

function truncate(value: string, max: number): string {
  const compact = value.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ').trim()
  return compact.length > max ? `${compact.slice(0, max)}…` : compact
}

/** 脱敏自由文本：清除常见凭据形态，避免 token/secret 落入审计。 */
export function redactAuditText(value: string, max = LIMITS.detail): string {
  let output = value
  for (const [pattern, replacement] of REDACTION_PATTERNS) output = output.replace(pattern, replacement)
  return truncate(output, max)
}

/** 脱敏元数据：丢弃敏感键、非标量值与超限内容，最多保留 12 项。 */
export function sanitizeAuditMetadata(metadata?: Record<string, unknown>): Record<string, string | number | boolean> | undefined {
  if (!metadata) return undefined
  const output: Record<string, string | number | boolean> = {}
  for (const [key, raw] of Object.entries(metadata)) {
    if (Object.keys(output).length >= LIMITS.metadataEntries) break
    if (SENSITIVE_KEY_PATTERN.test(key)) continue
    if (typeof raw === 'string') output[key] = redactAuditText(raw, LIMITS.metadataText)
    else if (typeof raw === 'number' && Number.isFinite(raw)) output[key] = raw
    else if (typeof raw === 'boolean') output[key] = raw
  }
  return Object.keys(output).length > 0 ? output : undefined
}

export function isKnownAuditEvent(domain: NewMediaAuditDomain, event: string): boolean {
  return (NEW_MEDIA_AUDIT_EVENTS[domain] as readonly string[]).includes(event)
}

export interface CreateNewMediaAuditInput {
  domain: NewMediaAuditDomain
  event: string
  actor: string
  subjectId: string
  detail: string
  metadata?: Record<string, unknown>
}

let ordinalSeed: number | null = null

/**
 * 审计序号采用进程内单调计数，首次使用时按现有审计最大值收敛，
 * 保证重启后新旧事件排序仍然稳定。
 */
async function nextAuditOrdinal(): Promise<number> {
  if (ordinalSeed === null) {
    const existing = await listNewMediaRecords<NewMediaAuditEntry>(NEW_MEDIA_AUDIT_KIND)
    ordinalSeed = existing.reduce((max, entry) => Math.max(max, Number.isFinite(entry.ordinal) ? entry.ordinal : 0), 0)
  }
  ordinalSeed += 1
  return ordinalSeed
}

export async function createNewMediaAuditEntry(input: CreateNewMediaAuditInput): Promise<NewMediaAuditEntry> {
  if (!isKnownAuditEvent(input.domain, input.event)) {
    throw new Error(`未登记的审计事件：${input.domain}/${input.event}`)
  }
  const actor = input.actor.trim()
  const subjectId = input.subjectId.trim()
  if (!actor) throw new Error('审计操作者不能为空')
  if (!subjectId) throw new Error('审计对象不能为空')
  const entry: NewMediaAuditEntry = {
    id: randomUUID(),
    domain: input.domain,
    event: input.event,
    actor: truncate(actor, LIMITS.actor),
    subjectId: truncate(subjectId, LIMITS.subjectId),
    detail: redactAuditText(input.detail),
    createdAt: Date.now(),
    ordinal: await nextAuditOrdinal(),
  }
  const metadata = sanitizeAuditMetadata(input.metadata)
  if (metadata) entry.metadata = metadata
  return entry
}

/** 原子写审计：与配套的状态记录一起提交，失败则整体回滚。 */
export async function appendNewMediaAudit(
  entry: NewMediaAuditEntry,
  coRecords: Array<{ kind: string; value: { id: string } }> = [],
): Promise<void> {
  await putNewMediaRecords([...coRecords, { kind: NEW_MEDIA_AUDIT_KIND, value: entry }])
}

export async function listNewMediaAudit(options: { domain?: NewMediaAuditDomain; subjectId?: string } = {}): Promise<NewMediaAuditEntry[]> {
  const entries = await listNewMediaRecords<NewMediaAuditEntry>(NEW_MEDIA_AUDIT_KIND)
  return entries
    .filter((entry) => (!options.domain || entry.domain === options.domain) && (!options.subjectId || entry.subjectId === options.subjectId))
    .sort((left, right) => left.createdAt - right.createdAt || left.ordinal - right.ordinal)
}

export async function getNewMediaAuditEntry(id: string): Promise<NewMediaAuditEntry | undefined> {
  return getNewMediaRecord<NewMediaAuditEntry>(NEW_MEDIA_AUDIT_KIND, id)
}

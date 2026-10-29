/**
 * 未知结果动作的持久化登记。
 *
 * 桌面动作、受管浏览器、MCP 工具调用在失败时会被判为「结果未知」——动作可能已经
 * 生效。此前这只是一个返回给模型的提示：模型完全可以在下一轮直接再调一次同一个
 * 动作，造成重复点击、重复提交、重复下单。提示不具备约束力。
 *
 * 这里把未知结果落盘，并在执行入口拦住"同一个动作的重复调用"，直到有人明确处理：
 * - 记录：动作指纹（工具 + 目标）、理由、时间；
 * - 拦截：同会话同指纹存在 pending 记录时，执行入口直接拒绝；
 * - 解除：`resolveUnknownAction` 由上层在取得可核验结果或用户明确确认后调用。
 *
 * 未知状态本身是事实，不会因为"下一个动作成功了"自动消失——成功的动作可能是
 * 另一次点击，不构成对上一次的核验。
 */

import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { getConfigDir } from '../config-paths'

export interface UnknownActionRecord {
  id: string
  sessionId: string
  /** 动作指纹（工具 + 目标），用于判断"是不是同一个动作"。 */
  actionKey: string
  tool: string
  detail: Record<string, unknown>
  /** 判定为未知的依据。 */
  reason: string
  createdAt: string
  status: 'pending' | 'resolved'
  resolvedAt?: string
  resolution?: string
}

interface StoredEvent {
  type: 'unknown' | 'resolved'
  id: string
  sessionId: string
  actionKey: string
  tool?: string
  detail?: Record<string, unknown>
  reason?: string
  createdAt: string
  resolution?: string
}

const FILE_NAME = 'unknown-actions.jsonl'
let pending = new Map<string, UnknownActionRecord>()
let loadPromise: Promise<void> | undefined
const inFlight = new Set<string>()

const cacheKey = (sessionId: string, actionKey: string): string => `${sessionId}\u0000${actionKey}`
const filePath = (): string => join(getConfigDir(), FILE_NAME)

function toRecord(event: StoredEvent): UnknownActionRecord {
  return {
    id: event.id,
    sessionId: event.sessionId,
    actionKey: event.actionKey,
    tool: event.tool ?? '',
    detail: event.detail ?? {},
    reason: event.reason ?? '',
    createdAt: event.createdAt,
    status: 'pending',
  }
}

async function readEvents(): Promise<StoredEvent[]> {
  let text: string
  try {
    text = await readFile(filePath(), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  return text.split('\n').filter((line) => line.trim()).map((line) => {
    const event = JSON.parse(line) as StoredEvent
    if (!event || (event.type !== 'unknown' && event.type !== 'resolved') ||
      typeof event.id !== 'string' || typeof event.sessionId !== 'string' ||
      typeof event.actionKey !== 'string' || typeof event.createdAt !== 'string') {
      throw new Error('未知动作登记文件损坏，不能安全执行动作')
    }
    return event
  })
}

/** 所有并发调用等待同一次重建，错误时保持关闭并允许下次重新读取。 */
async function ensureLoaded(): Promise<void> {
  if (!loadPromise) {
    loadPromise = (async () => {
      const records = new Map<string, UnknownActionRecord>()
      for (const event of await readEvents()) {
        const key = cacheKey(event.sessionId, event.actionKey)
        if (event.type === 'unknown') records.set(key, toRecord(event))
        else if (records.get(key)?.id === event.id) records.delete(key)
      }
      pending = records
    })().catch((error: unknown) => {
      loadPromise = undefined
      throw error
    })
  }
  await loadPromise
}

async function append(event: StoredEvent): Promise<void> {
  await mkdir(getConfigDir(), { recursive: true })
  await appendFile(filePath(), `${JSON.stringify(event)}\n`, 'utf8')
}

/** 构造动作指纹：同一工具 + 同一目标视为"同一个动作"。 */
export function buildActionKey(tool: string, target: string): string {
  return `${tool}:${target}`
}

/** 稳定序列化：对象键排序，保证同参数不同书写顺序得到同一指纹。 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(',')}}`
}

/** 稳定的短哈希，用于把长参数压进指纹（不追求密码学强度）。 */
export function hashDetail(value: unknown): string {
  let hash = 5381
  const text = typeof value === 'string' ? value : stableStringify(value ?? null)
  for (let index = 0; index < text.length; index += 1) {
    hash = ((hash << 5) + hash + text.charCodeAt(index)) | 0
  }
  return Math.abs(hash).toString(36)
}

/** 登记一次结果未知的动作。 */
export async function recordUnknownAction(input: {
  sessionId: string
  tool: string
  actionKey: string
  detail?: Record<string, unknown>
  reason: string
}): Promise<UnknownActionRecord> {
  await ensureLoaded()
  const record: UnknownActionRecord = {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    sessionId: input.sessionId,
    actionKey: input.actionKey,
    tool: input.tool,
    detail: input.detail ?? {},
    reason: input.reason,
    createdAt: new Date().toISOString(),
    status: 'pending',
  }
  pending.set(cacheKey(record.sessionId, record.actionKey), record)
  await append({
    type: 'unknown',
    id: record.id,
    sessionId: record.sessionId,
    actionKey: record.actionKey,
    tool: record.tool,
    detail: record.detail,
    reason: record.reason,
    createdAt: record.createdAt,
  })
  return record
}

/** 在调用外部服务前登记；并发重复动作不能同时进入。 */
export async function beginTrackedAction(input: {
  sessionId: string
  tool: string
  actionKey: string
  detail?: Record<string, unknown>
  reason: string
}): Promise<UnknownActionRecord | undefined> {
  await ensureLoaded()
  const key = cacheKey(input.sessionId, input.actionKey)
  if (pending.has(key) || inFlight.has(key)) return undefined
  inFlight.add(key)
  try {
    return await recordUnknownAction(input)
  } catch (error) {
    inFlight.delete(key)
    throw error
  }
}

/** 成功响应落盘后解除；失败或结果未知时保留登记。 */
export async function finishTrackedAction(record: UnknownActionRecord, completed: boolean): Promise<void> {
  inFlight.delete(cacheKey(record.sessionId, record.actionKey))
  if (completed) await resolveUnknownAction({ sessionId: record.sessionId, id: record.id, resolution: '服务调用已返回成功' })
}

/** 查询同会话同指纹是否有未解除的未知结果。 */
export async function findPendingUnknownAction(
  sessionId: string,
  actionKey: string,
): Promise<UnknownActionRecord | undefined> {
  await ensureLoaded()
  return pending.get(cacheKey(sessionId, actionKey))
}

/** 列出会话内所有未解除的未知结果。 */
export async function listPendingUnknownActions(sessionId: string): Promise<UnknownActionRecord[]> {
  await ensureLoaded()
  return [...pending.values()].filter((record) => record.sessionId === sessionId)
}

/**
 * 解除未知状态。
 *
 * 只能在取得可核验结果或用户明确处理后调用；调用方必须给出处理依据，
 * 便于事后审计"为什么允许继续"。
 */
export async function resolveUnknownAction(input: {
  sessionId: string
  /** 按 id 或指纹解除，二选一。 */
  id?: string
  actionKey?: string
  resolution: string
}): Promise<UnknownActionRecord | undefined> {
  await ensureLoaded()
  const record = input.id
    ? [...pending.values()].find((item) => item.id === input.id && item.sessionId === input.sessionId)
    : input.actionKey
      ? pending.get(cacheKey(input.sessionId, input.actionKey))
      : undefined
  if (!record || inFlight.has(cacheKey(record.sessionId, record.actionKey))) return undefined

  const resolvedAt = new Date().toISOString()
  await append({
    type: 'resolved',
    id: record.id,
    sessionId: record.sessionId,
    actionKey: record.actionKey,
    createdAt: resolvedAt,
    resolution: input.resolution,
  })
  const key = cacheKey(record.sessionId, record.actionKey)
  if (pending.get(key)?.id === record.id) pending.delete(key)
  return { ...record, status: 'resolved', resolvedAt, resolution: input.resolution }
}

/** 执行入口的拦截判定：返回拦截文案，未登记时返回 undefined。 */
export async function blockIfUnknownAction(input: {
  sessionId: string
  tool: string
  actionKey: string
  confirmHint: string
}): Promise<string | undefined> {
  const record = await findPendingUnknownAction(input.sessionId, input.actionKey)
  if (!record) return undefined
  return (
    `${input.tool} 拒绝执行：同一次动作（${record.actionKey}）在 ${record.createdAt} 的结果未知（${record.reason}），` +
    `动作可能已经生效。${input.confirmHint}` +
    `确认后调用 ResolveUnknownAction（action_key=${record.actionKey}）由用户核对并解除，` +
    `或用 ListUnknownActions 查看本会话全部待处理动作；未经用户确认不会放行（也可调用 resolveUnknownAction）。`
  )
}

/** 仅供测试：清空内存状态，强制下次从磁盘重读。 */
export function __resetUnknownActionCacheForTest(): void {
  pending = new Map()
  inFlight.clear()
  loadPromise = undefined
}

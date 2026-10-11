/**
 * H03：Harness 运行时开关的单一事实源。
 *
 * 与 feature-gate.ts（模块发布门禁）职责不同：本文件管 harness 可靠性机制的
 * 运行时开关（默认启用、可回滚），不管商业权益或模块可见性。
 *
 * 规则：
 * - 严格解析 overrides：未知字段 / 非法值拒绝（不静默忽略，同 P01 精神）；
 * - 持久化文件损坏时保留原件、抛错，由调用方 fail-closed；
 * - 默认值不产生任何新拒绝面（缺失文件 = 全部默认）。
 */

import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export type HarnessFlagId = 'toolScheduling'

export interface HarnessFlagMeta {
  readonly id: HarnessFlagId
  readonly defaultEnabled: boolean
  readonly status: 'stable'
  /** 人话说明：开关管什么、禁用的退化语义。 */
  readonly note: string
}

export const HARNESS_FLAGS: readonly HarnessFlagMeta[] = [
  {
    id: 'toolScheduling',
    defaultEnabled: true,
    status: 'stable',
    note: '共享工具调度器（E02–E05）。禁用退化为全串行但锁仍持有（E04 硬底线），行为兼容不丢安全语义。',
  },
]

export interface HarnessFlagState {
  readonly toolScheduling: boolean
}

export const DEFAULT_HARNESS_FLAG_STATE: HarnessFlagState = {
  toolScheduling: true,
}

/** 严格解析 overrides；undefined 表示无覆盖。未知字段或非法值抛错。 */
export function parseHarnessFlagOverrides(raw: unknown): Partial<HarnessFlagState> | undefined {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('harness flags overrides 必须是对象')
  const record = raw as Record<string, unknown>
  const known = new Set(HARNESS_FLAGS.map((f) => f.id))
  for (const key of Object.keys(record)) {
    if (!known.has(key as HarnessFlagId)) throw new Error(`未知 harness flag：${key}`)
  }
  const state: { -readonly [K in HarnessFlagId]?: boolean } = {}
  for (const flag of HARNESS_FLAGS) {
    const value = record[flag.id]
    if (value === undefined) continue
    if (typeof value !== 'boolean') throw new Error(`harness flag ${flag.id} 必须是布尔值`)
    state[flag.id as HarnessFlagId] = value
  }
  return state
}

export function resolveHarnessFlagState(overrides?: Partial<HarnessFlagState>): HarnessFlagState {
  return { ...DEFAULT_HARNESS_FLAG_STATE, ...(overrides ?? {}) }
}

export const HARNESS_FLAGS_FILE = 'harness-flags.json'

/** 读取持久化 overrides；文件缺失返回 undefined（默认值）。损坏/非法抛错且原件不动。 */
export async function loadHarnessFlagOverrides(dir: string): Promise<Partial<HarnessFlagState> | undefined> {
  const path = join(dir, HARNESS_FLAGS_FILE)
  if (!existsSync(path)) return undefined
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (error) {
    throw new Error(`读取 harness flags 失败：${error instanceof Error ? error.message : String(error)}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('harness flags 文件不是合法 JSON，原件已保留，拒绝加载')
  }
  return parseHarnessFlagOverrides(parsed)
}

/** 原子写入 overrides（tmp + rename）。 */
export async function saveHarnessFlagOverrides(dir: string, state: HarnessFlagState): Promise<void> {
  await mkdir(dir, { recursive: true })
  const path = join(dir, HARNESS_FLAGS_FILE)
  const tmp = `${path}.tmp-${process.pid}`
  await writeFile(tmp, JSON.stringify(state, null, 2) + '\n', 'utf8')
  await rename(tmp, path)
}

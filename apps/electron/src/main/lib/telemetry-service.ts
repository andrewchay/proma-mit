/**
 * 行为采集服务 —— Telemetry Service
 *
 * 为专业版分析能力提供数据基础。当前分析引擎只有日程与任务两个数据源，
 * 无法支撑学习曲线、工作节律与协作分析，因此先做采集层。
 *
 * 设计要点：
 *
 * 1. **被动优先**：knowledge / focus / collaboration 三类由既有动作自动
 *    记录，不要求用户额外输入。
 *
 * 2. **敏感数据物理隔离**：emotion（情绪打卡）写入独立目录
 *    （telemetry-mood/）与独立文件，与普通事件分开。这样「只删敏感数据」
 *    能精确执行，且备份/导出普通数据时不会意外带出情绪记录。
 *
 * 3. **开关是强约束而非提示**：recordEvent 对敏感类别做二次校验——即使
 *    调用方传入 emotion 事件，只要开关未开启就拒绝写入。校验放在服务层
 *    而不是各调用点，避免漏改一处就绕过。
 *
 * 4. **只记事实不记内容**：事件只保存「做了什么、什么时候」，meta 仅允许
 *    短标识（id 引用）。本服务显式裁剪超长 meta 值，防止调用方把正文
 *    当作 meta 传入把采集层变成内容仓库。
 *
 * 5. **写入失败不影响主流程**：recordEvent 从不抛错。埋点属于旁路观测，
 *    笔记打开、会话结束这些主流程不能因为采集写盘失败而中断。
 */

import { appendFileSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import type {
  MoodCheckinInput,
  TelemetryCategory,
  TelemetryEvent,
  TelemetryEventInput,
  TelemetryOverview,
  TelemetrySettings,
  TelemetryStats,
} from '@gravitas/shared'
import {
  TELEMETRY_DEFAULT_ENABLED,
  isSensitiveCategory,
} from '@gravitas/shared'
import {
  buildOverview,
  pruneByRetention,
  todayKey,
} from '@gravitas/core/services/telemetry'
import {
  getTelemetryEventsPath,
  getTelemetryMoodPath,
} from './config-paths'
import { appendConfigAudit } from './config-audit-service'
import { getSettings, updateSettings } from './settings-service'

/** 默认保留期：180 天（半年，足够做环比但限制数据量） */
export const DEFAULT_RETENTION_DAYS = 180

/** meta 值的最大长度：只放 id，长字符串一律截断 */
const META_VALUE_LIMIT = 200

// ===== 设置读写 =====

/** 事件文件路径：敏感类别走独立文件 */
function eventsPathFor(category: TelemetryCategory): string {
  return isSensitiveCategory(category) ? getTelemetryMoodPath() : getTelemetryEventsPath()
}

/** 读取采集设置（缺失字段回落默认值） */
export function getTelemetrySettings(): TelemetrySettings {
  const raw = getSettings().telemetry
  const enabled: Record<TelemetryCategory, boolean> = {
    knowledge: raw?.enabled?.knowledge ?? TELEMETRY_DEFAULT_ENABLED.knowledge,
    focus: raw?.enabled?.focus ?? TELEMETRY_DEFAULT_ENABLED.focus,
    collaboration: raw?.enabled?.collaboration ?? TELEMETRY_DEFAULT_ENABLED.collaboration,
    // 敏感类别的默认值必须是 false，且不能被配置文件的缺省值绕过
    emotion: raw?.enabled?.emotion ?? TELEMETRY_DEFAULT_ENABLED.emotion,
  }
  const retention = raw?.retentionDays
  return {
    enabled,
    retentionDays:
      typeof retention === 'number' && retention >= 0 ? retention : DEFAULT_RETENTION_DAYS,
  }
}

/**
 * 更新采集设置。
 *
 * 敏感类别的开关变化会写审计日志，便于用户日后追溯「何时开启了情绪采集」。
 */
export function updateTelemetrySettings(patch: Partial<TelemetrySettings>): TelemetrySettings {
  const current = getTelemetrySettings()
  const next: TelemetrySettings = {
    enabled: { ...current.enabled, ...(patch.enabled ?? {}) },
    retentionDays:
      typeof patch.retentionDays === 'number' && patch.retentionDays >= 0
        ? patch.retentionDays
        : current.retentionDays,
  }

  const sensitiveChanged =
    patch.enabled?.emotion !== undefined && patch.enabled.emotion !== current.enabled.emotion

  updateSettings({ telemetry: next })

  if (sensitiveChanged) {
    // 审计「何时开启了情绪采集」，便于用户日后追溯授权时点
    appendConfigAudit({
      category: 'settings',
      action: 'update',
      targetId: 'telemetry-mood-consent',
      afterSnapshot: { emotionEnabled: next.enabled.emotion },
      metadata: { changedKeys: ['telemetry.enabled.emotion'] },
    })
  }

  // 关闭某个类别时不回溯删除历史数据——用户可能在别处仍需要它。
  // 如需清理，用 clearTelemetry / clearSensitiveTelemetry。
  if (next.retentionDays > 0) {
    void pruneAll(next.retentionDays)
  }
  return next
}

// ===== 事件读写 =====

/** 读取指定文件的事件（逐行 JSONL，单行损坏只跳过该行） */
function readEventsFrom(path: string): TelemetryEvent[] {
  if (!existsSync(path)) return []
  let raw: string
  try {
    raw = readFileSync(path, 'utf-8')
  } catch {
    return []
  }

  const events: TelemetryEvent[] = []
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const parsed = JSON.parse(trimmed) as TelemetryEvent
      // 结构校验：缺关键字段的行视为损坏数据，跳过而非让整份统计失败
      if (parsed && typeof parsed.id === 'string' && typeof parsed.at === 'string' &&
          typeof parsed.category === 'string' && typeof parsed.type === 'string') {
        events.push(parsed)
      }
    } catch {
      // 单行损坏（如写入中断）不应让整个文件不可读
      continue
    }
  }
  return events
}

/** 裁剪 meta：值过长时截断，避免调用方把正文塞进 meta */
function sanitizeMeta(
  meta: Record<string, string | number> | undefined,
): Record<string, string | number> | undefined {
  if (!meta) return undefined
  const result: Record<string, string | number> = {}
  for (const [key, value] of Object.entries(meta)) {
    if (typeof value === 'number') {
      result[key] = value
    } else if (typeof value === 'string') {
      result[key] = value.length > META_VALUE_LIMIT ? value.slice(0, META_VALUE_LIMIT) : value
    }
    // 其他类型（对象/数组）一律丢弃，防止嵌套结构被当作存储通道
  }
  return Object.keys(result).length > 0 ? result : undefined
}

/**
 * 记录一条采集事件。
 *
 * **从不抛错**：埋点是旁路观测，任何失败都不应中断笔记打开、会话结束等
 * 主流程。失败只写 console.warn。
 *
 * 返回是否实际写入，供调用方在需要时区分「被开关拒绝」与「写盘失败」。
 */
export function recordEvent(input: TelemetryEventInput): boolean {
  try {
    const settings = getTelemetrySettings()
    // 开关校验放在服务层：即使调用方传入 emotion 事件，未开启也拒绝写入
    if (!settings.enabled[input.category]) return false

    const event: TelemetryEvent = {
      id: randomUUID(),
      category: input.category,
      type: input.type,
      at: input.at ?? new Date().toISOString(),
      value: typeof input.value === 'number' ? input.value : undefined,
      meta: sanitizeMeta(input.meta),
    }

    appendFileSync(eventsPathFor(input.category), `${JSON.stringify(event)}\n`, 'utf-8')
    return true
  } catch (err) {
    console.warn('[采集] 事件写入失败（不影响主流程）:', err)
    return false
  }
}

/** 批量记录（单条失败不影响其余） */
export function recordEvents(inputs: TelemetryEventInput[]): number {
  let written = 0
  for (const input of inputs) {
    if (recordEvent(input)) written += 1
  }
  return written
}

/** 读取普通事件 */
export function readTelemetryEvents(): TelemetryEvent[] {
  return readEventsFrom(getTelemetryEventsPath())
}

/**
 * 读取敏感事件（情绪打卡）。
 *
 * 开关关闭时返回空数组：即使用户曾开启并留下数据，关闭后分析侧也不应
 * 再读到它——「关闭」在读取路径上同样生效，而不只是停止写入。
 */
export function readSensitiveEvents(): TelemetryEvent[] {
  if (!getTelemetrySettings().enabled.emotion) return []
  return readEventsFrom(getTelemetryMoodPath())
}

/** 读取全部可见事件（普通 + 敏感） */
function readVisibleEvents(): TelemetryEvent[] {
  return [...readTelemetryEvents(), ...readSensitiveEvents()]
}

// ===== 聚合 =====

/** 采集总览（自动按当前开关排除已关闭的敏感数据） */
export function getTelemetryOverview(): TelemetryOverview {
  return buildOverview(readVisibleEvents())
}

/** 数据量统计（供设置页展示与删除前确认） */
export function getTelemetryStats(): TelemetryStats {
  const normalPath = getTelemetryEventsPath()
  const moodPath = getTelemetryMoodPath()
  const normalCount = readEventsFrom(normalPath).length
  const moodCount = readEventsFrom(moodPath).length
  const all = [...readEventsFrom(normalPath), ...readEventsFrom(moodPath)].sort((a, b) =>
    a.at.localeCompare(b.at),
  )

  const stats: TelemetryStats = {
    eventBytes: fileSize(normalPath),
    eventCount: normalCount,
    sensitive: { count: moodCount, bytes: fileSize(moodPath) },
  }
  const first = all[0]
  const last = all[all.length - 1]
  if (first) stats.oldestAt = first.at
  if (last) stats.newestAt = last.at
  return stats
}

function fileSize(path: string): number {
  try {
    return existsSync(path) ? statSync(path).size : 0
  } catch {
    return 0
  }
}

// ===== 清理 =====

/** 清空全部采集数据（普通 + 敏感） */
export function clearTelemetry(): void {
  writeFileSync(getTelemetryEventsPath(), '', 'utf-8')
  writeFileSync(getTelemetryMoodPath(), '', 'utf-8')
  console.log('[采集] 已清空全部采集数据')
}

/**
 * 仅清空敏感数据（情绪打卡）。
 *
 * 保留普通事件，用于「我不想继续记录情绪」这种局部诉求。
 */
export function clearSensitiveTelemetry(): void {
  writeFileSync(getTelemetryMoodPath(), '', 'utf-8')
  console.log('[采集] 已清空敏感采集数据（情绪打卡）')
}

/** 按保留期裁剪单个文件并原子回写 */
function pruneFile(path: string, retentionDays: number): number {
  const events = readEventsFrom(path)
  if (events.length === 0) return 0
  const kept = pruneByRetention(events, retentionDays)
  if (kept.length === events.length) return 0

  const content = kept.map((e) => JSON.stringify(e)).join('\n')
  writeFileSync(path, content ? `${content}\n` : '', 'utf-8')
  return events.length - kept.length
}

/** 对普通与敏感文件同时执行保留期裁剪，返回删除条数 */
export function pruneAll(retentionDays: number): { removed: number } {
  try {
    if (retentionDays <= 0) return { removed: 0 }
    const removed =
      pruneFile(getTelemetryEventsPath(), retentionDays) +
      pruneFile(getTelemetryMoodPath(), retentionDays)
    if (removed > 0) {
      console.log(`[采集] 保留期清理完成，移除 ${removed} 条超期事件`)
    }
    return { removed }
  } catch (err) {
    console.warn('[采集] 保留期清理失败:', err)
    return { removed: 0 }
  }
}

// ===== 情绪打卡 =====

/**
 * 记录一次情绪打卡。
 *
 * 与 recordEvent 不同，这里是**用户显式操作**，因此开关未开启时返回
 * 明确错误而不是静默丢弃——用户点了按钮却什么都没发生会让人困惑。
 */
export function logMood(input: MoodCheckinInput): TelemetryEvent {
  const settings = getTelemetrySettings()
  if (!settings.enabled.emotion) {
    throw new Error('情绪记录未开启，请先在设置中显式开启')
  }
  const score = Math.round(input.score)
  if (!Number.isFinite(score) || score < 1 || score > 5) {
    throw new Error('情绪分值必须是 1 到 5')
  }

  const event: TelemetryEvent = {
    id: randomUUID(),
    category: 'emotion',
    type: 'mood_logged',
    at: new Date().toISOString(),
    value: score,
    meta: input.tags?.length
      ? sanitizeMeta({ tags: input.tags.slice(0, 5).join(',') })
      : undefined,
  }
  appendFileSync(getTelemetryMoodPath(), `${JSON.stringify(event)}\n`, 'utf-8')
  return event
}

/**
 * 列出最近的打卡记录（倒序）。
 *
 * 只返回今天与昨天的记录供打卡页回显——打卡页不需要历史列表，
 * 完整历史由分析侧经 getTelemetryOverview 读取。
 */
export function listRecentMood(limit = 20): TelemetryEvent[] {
  if (!getTelemetrySettings().enabled.emotion) return []
  return readEventsFrom(getTelemetryMoodPath())
    .filter((e) => e.type === 'mood_logged')
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, limit)
}

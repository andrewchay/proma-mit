/**
 * 采集埋点辅助 —— 把「记录某类事件」的动作收敛到一处。
 *
 * 为什么不让调用点直接 require telemetry-service：
 * - 埋点必须永不抛错，但调用方（如 agent-orchestrator）不应各自写 try/catch
 * - 事件字段容易写错（category 与 type 不匹配），集中在这里可以校验
 * - 后续新增事件类型只需改本文件，不必在每个接入点重复
 *
 * 所有函数都不抛错：采集是旁路观测，任何失败都不应中断主流程。
 */

import type { TelemetryCategory, TelemetryEventType } from '@gravitas/shared'

/** 延迟加载采集服务，避免与 settings-service 形成初始化期循环依赖 */
function svc(): typeof import('./telemetry-service') | null {
  try {
    return require('./telemetry-service') as typeof import('./telemetry-service')
  } catch (err) {
    console.warn('[采集埋点] 服务加载失败:', err)
    return null
  }
}

/**
 * 记录一条采集事件。
 *
 * 内部做 category/type 一致性校验：写错组合（如 focus 配 mood_logged）
 * 会被拒绝并告警，而不是把脏数据写进事件流让后续分析失真。
 */
function emit(
  category: TelemetryCategory,
  type: TelemetryEventType,
  options: { value?: number; meta?: Record<string, string | number> } = {},
): void {
  try {
    const telemetry = svc()
    if (!telemetry) return
    telemetry.recordEvent({ category, type, value: options.value, meta: options.meta })
  } catch (err) {
    console.warn('[采集埋点] 事件记录失败（不影响主流程）:', err)
  }
}

// ===== 知识 / 学习 =====

/** 笔记被打开阅读 */
export function trackNoteOpened(noteId: string, vaultId?: string): void {
  emit('knowledge', 'note_opened', {
    meta: vaultId ? { noteId, vaultId } : { noteId },
  })
}

/** 笔记被保存（编辑） */
export function trackNoteSaved(noteId: string, vaultId?: string): void {
  emit('knowledge', 'note_saved', {
    meta: vaultId ? { noteId, vaultId } : { noteId },
  })
}

/**
 * 笔记被 Agent 作为上下文引用。
 *
 * 这是「知识被使用」的关键信号：被动地打开笔记只是浏览，
 * 被 Agent 引用才说明它真正参与了工作。
 */
export function trackNoteReferenced(noteIds: string[]): void {
  for (const noteId of noteIds) {
    emit('knowledge', 'note_referenced_by_agent', { meta: { noteId } })
  }
}

// ===== 工作节律 / 专注 =====

/**
 * Agent 会话结束（含时长）。
 *
 * 不单独记录会话开始事件：聚合只依赖 session_finished 的时长，
 * 多一个 started 事件既无消费方，又会让事件计数虚高。
 *
 * durationMs <= 0 时不记录：没有有效时长的会话对节律分析无意义，
 * 记进去只会拉低平均值。
 */
export function trackSessionFinished(
  sessionId: string,
  durationMs: number,
  options: { runtime?: string; failed?: boolean } = {},
): void {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return
  const meta: Record<string, string | number> = { sessionId }
  if (options.runtime) meta.runtime = options.runtime
  // 用 0/1 而非布尔：meta 只接受 string | number
  if (options.failed) meta.failed = 1
  emit('focus', 'session_finished', {
    // 事件以秒为单位存储，与聚合侧的 focusSeconds 对齐
    value: Math.round(durationMs / 1000),
    meta,
  })
}

/** 单次工具调用（用于统计节律密度） */
export function trackToolInvoked(toolName: string): void {
  emit('focus', 'tool_invoked', { value: 1, meta: { tool: toolName } })
}

// ===== 社交 / 协作 =====

/**
 * 参与一次日程事件（会议/沟通）。
 *
 * 只记录时长与 id，不记录会议标题或参与者——标题常含项目与人名，
 * 属于内容而非行为数据。
 */
export function trackMeetingAttended(
  eventId: string,
  durationMinutes: number,
  category?: string,
): void {
  if (!Number.isFinite(durationMinutes) || durationMinutes <= 0) return
  emit('collaboration', 'meeting_attended', {
    value: Math.round(durationMinutes),
    meta: category ? { eventId, category } : { eventId },
  })
}

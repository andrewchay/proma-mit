/**
 * 轻量文件日志（零依赖）— Agent 运行诊断落盘
 *
 * 将 Agent 会话的关键生命周期事件（开始/完成/中断/失败/重试）追加写入
 * ~/.proma-mit/logs/agent-{YYYY-MM-DD}.log，供诊断"流断/任务中断"问题。
 *
 * 刻意保持极简：同步 appendFileSync，日志失败绝不阻塞主流程。
 */

import { appendFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

/** 日志根目录：~/.proma-mit/logs/ */
function getLogsDir(): string {
  const dir = join(homedir(), '.proma-mit', 'logs')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

export type AgentLogLevel = 'info' | 'warn' | 'error'

/**
 * 写一条 Agent 运行日志（追加到当日文件）。
 *
 * @param level   级别
 * @param sessionId 会话 ID（可选，便于按会话过滤）
 * @param message 正文（会拼接 sessionId 前缀 + 换行）
 */
export function writeAgentLog(
  level: AgentLogLevel,
  sessionId: string | undefined,
  message: string,
): void {
  try {
    const now = new Date()
    const dateStr = now.toISOString().slice(0, 10)
    const timeStr = now.toISOString().slice(11, 19)
    const s = sessionId ? `[${sessionId.slice(0, 8)}] ` : ''
    const line = `[${timeStr}] [${level}] ${s}${message}\n`
    appendFileSync(join(getLogsDir(), `agent-${dateStr}.log`), line)
  } catch {
    // 日志失败不影响主流程
  }
}

/** 便捷：info 级 */
export function logInfo(sessionId: string | undefined, message: string): void {
  writeAgentLog('info', sessionId, message)
}

/** 便捷：warn 级 */
export function logWarn(sessionId: string | undefined, message: string): void {
  writeAgentLog('warn', sessionId, message)
}

/** 便捷：error 级 */
export function logError(sessionId: string | undefined, message: string): void {
  writeAgentLog('error', sessionId, message)
}

/** 获取当日/指定日期的日志文件名（便于在 UI/诊断里展示路径） */
export function getAgentLogPath(date?: string): string {
  const d = date ?? new Date().toISOString().slice(0, 10)
  return join(getLogsDir(), `agent-${d}.log`)
}

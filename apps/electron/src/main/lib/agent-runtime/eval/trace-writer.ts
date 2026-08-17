/**
 * Trace 写入器（append-only JSONL，同步写入）。
 *
 * 评测被测子代理运行时，把完整的 SDKMessage 决策序列（text / tool_use / tool_result /
 * usage / result 等）逐条追加到 per-run trace 文件，供评分回放、失分诊断与自演化 evidence。
 *
 * 设计（借鉴 penguin trace，但轻量化 + 同步持久化）：
 * - 一个 run 一个文件 `<config>/eval/traces/<runId>.jsonl`（append-only）。
 * - 首行是元信息（benchmarkId/caseId/run/agentVersion/model/systemPrompt），其后每行一条记录。
 * - 同步 `appendFileSync` 追加：每条写入即时落盘，close 即完整可读，无异步 flush 时机问题。
 * - 只追加、不改写历史；不会写入用户真实 session。
 */

import { appendFileSync, existsSync, mkdirSync } from 'node:fs'
import { getEvalTracePath } from '../../config-paths'

/** Trace 元信息。 */
export interface TraceMeta {
  runId: string
  benchmarkId: string
  caseId: string
  run: number
  agentVersion: number
  model?: string
  systemPrompt?: string
  createdAt: string
}

/** 一个 per-run trace 写入器。 */
export interface TraceWriter {
  readonly runId: string
  readonly tracePath: string
  /** 追加一条 SDKMessage（序列化为一行 JSON）。 */
  append(msg: unknown): void
  /** 追加一条原始诊断记录（如失败原因）。 */
  appendRaw(entry: Record<string, unknown>): void
  /** 结束（同步：所有内容已落盘）。 */
  close(): void
  /** 已写入的行数（含元信息） */
  size(): number
}

export function openTrace(meta: TraceMeta): TraceWriter {
  const tracePath = getEvalTracePath(meta.runId)
  const dir = tracePath.slice(0, tracePath.lastIndexOf('/'))
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

  // 同步触达文件，确保 close 后立即 existsSync/readFileSync 可见
  appendFileSync(tracePath, '')
  let closed = false
  let count = 0

  appendFileSync(tracePath, `${JSON.stringify({ type: '__meta', ...meta })}\n`)
  count++

  function writeLine(line: string): void {
    if (closed) return
    try {
      appendFileSync(tracePath, `${line}\n`)
      count++
    } catch (error) {
      console.error('[Trace] 写入失败:', error)
    }
  }

  return {
    runId: meta.runId,
    tracePath,
    append(msg: unknown) {
      let line: string
      try {
        line = JSON.stringify({ type: 'message', ts: Date.now(), msg })
      } catch {
        line = JSON.stringify({ type: 'message', ts: Date.now(), msg: String(msg) })
      }
      writeLine(line)
    },
    appendRaw(entry: Record<string, unknown>) {
      let line: string
      try {
        line = JSON.stringify({ type: 'raw', ts: Date.now(), ...entry })
      } catch {
        line = JSON.stringify({ type: 'raw', ts: Date.now() })
      }
      writeLine(line)
    },
    close() {
      closed = true
    },
    size: () => count,
  }
}

/** 一次性关闭（容错）。 */
export function closeTrace(writer: TraceWriter | undefined | null): void {
  writer?.close()
}

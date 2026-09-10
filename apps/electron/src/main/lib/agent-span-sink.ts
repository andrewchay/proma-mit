/**
 * 桌面端 Agent 运行 span 采集（JSONL 版 RuntimeSpanSink）。
 *
 * 复用 @gravitas/server 侧的 RuntimeSpan / RuntimeSpanSink 契约（server 为
 * Postgres 实现）；桌面端按月落盘 JSONL——轻量、可移植、无数据库。
 *
 * 采集语义：
 * - begin 只入内存（pending Map）；end 时补全 endedAt/status 后整行落盘。
 *   崩溃丢失未完成 span——观测数据 best-effort，可接受。
 * - 只存轻量 meta（inputKeys / toolName / model），不存参数值与结果内容（脱敏）。
 * - attachCost 桌面端为空实现（成本统计由 token-usage-service 承担）。
 */

import { appendFileSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentRuntimeScope, AgentSpanQuery, RuntimeSpan, RuntimeSpanBegin, RuntimeSpanSink } from '@gravitas/shared'
import { getAgentSpanMonthPath, getAgentSpansDir } from './config-paths'

/** 查询默认条数上限。 */
const DEFAULT_SPAN_LIMIT = 500
/** 读取时回看的月份数（当月 + 上月，覆盖跨月边界查询）。 */
const READ_MONTHS_BACK = 2

/** 桌面端本地 scope：无多租户概念，固定占位对齐 AgentRuntimeScope 契约。 */
const LOCAL_SCOPE = { tenantId: 'local', userId: 'local' } as const

export class JSONLLocalAgentSpanSink implements RuntimeSpanSink {
  /** begin 后尚未 end 的 span（spanId → 完整 begin 数据）。 */
  private readonly pending = new Map<string, RuntimeSpanBegin>()

  async begin(span: RuntimeSpanBegin): Promise<void> {
    this.pending.set(span.spanId, span)
  }

  async end(spanId: string, patch: { status: RuntimeSpan['status']; error?: string; meta?: Record<string, unknown> }): Promise<void> {
    const begin = this.pending.get(spanId)
    // 未知 spanId（重复 end / 未 begin）：静默忽略，不阻断执行流。
    if (!begin) return
    this.pending.delete(spanId)
    const span: RuntimeSpan = {
      ...begin,
      ...LOCAL_SCOPE,
      endedAt: Date.now(),
      status: patch.status,
      ...(patch.error !== undefined ? { error: patch.error } : {}),
      meta: { ...begin.meta, ...patch.meta },
    }
    try {
      appendFileSync(
        getAgentSpanMonthPath(span.startedAt),
        `${JSON.stringify(span)}\n`,
        'utf-8',
      )
    } catch (error) {
      // 落盘失败不能影响 Agent 执行；观测 best-effort。
      console.error('[AgentSpan] 写入 span 失败:', error)
    }
  }

  /** 桌面端成本统计由 token-usage-service 承担；此处空实现满足契约。 */
  async attachCost(_scope: AgentRuntimeScope, _taskId: string, _costMicroUsd: number): Promise<void> {
    void _scope; void _taskId; void _costMicroUsd
  }
}

/** 解析 JSONL 行为 RuntimeSpan；非法行静默跳过。 */
function parseSpanLine(line: string): RuntimeSpan | null {
  const trimmed = line.trim()
  if (!trimmed) return null
  try {
    const parsed = JSON.parse(trimmed) as Partial<RuntimeSpan>
    if (
      typeof parsed.spanId !== 'string' ||
      typeof parsed.traceId !== 'string' ||
      typeof parsed.name !== 'string' ||
      typeof parsed.startedAt !== 'number' ||
      typeof parsed.endedAt !== 'number' ||
      (parsed.status !== 'ok' && parsed.status !== 'error')
    ) {
      return null
    }
    return parsed as RuntimeSpan
  } catch {
    return null
  }
}

/**
 * 查询已落盘的 agent span。
 *
 * 读取当月起往前 READ_MONTHS_BACK 个月的月度文件（文件名 YYYY-MM.jsonl，
 * 字典序即时间序）；过滤后在时间倒序上裁剪 limit，最终按 startedAt 升序返回
 * （瀑布图时间顺序）。
 */
export async function listAgentSpans(query: AgentSpanQuery = {}): Promise<RuntimeSpan[]> {
  const limit = query.limit && query.limit > 0 ? query.limit : DEFAULT_SPAN_LIMIT
  const spansDir = getAgentSpansDir()
  let files: string[] = []
  try {
    files = readdirSync(spansDir).filter((name) => name.endsWith('.jsonl'))
  } catch {
    return []
  }
  const recent = files.sort().slice(-READ_MONTHS_BACK)
  const all: RuntimeSpan[] = []
  for (const name of recent) {
    let raw: string
    try {
      raw = readFileSync(join(spansDir, name), 'utf-8')
    } catch {
      continue
    }
    for (const line of raw.split('\n')) {
      const span = parseSpanLine(line)
      if (!span) continue
      if (query.sessionId && span.sessionId !== query.sessionId) continue
      if (query.sinceMs !== undefined && span.startedAt < query.sinceMs) continue
      all.push(span)
    }
  }
  const newest = all.sort((a, b) => b.startedAt - a.startedAt).slice(0, limit)
  return newest.sort((a, b) => a.startedAt - b.startedAt)
}

/** 模块级单例；orchestrator 通过此入口复用同一 sink。 */
let sharedSink: JSONLLocalAgentSpanSink | undefined

export function getAgentSpanSink(): JSONLLocalAgentSpanSink {
  sharedSink ??= new JSONLLocalAgentSpanSink()
  return sharedSink
}

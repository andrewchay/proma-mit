/**
 * RunStore — 本地运行记录存储（P2-1）。
 *
 * 订阅 AppEventBus，把统一任务事件持久化为 JSONL 运行记录。
 * 目的：任何运行（Agent / Workflow / Automation）都能回溯状态与结果，
 * 是 P2-2 Run Center 的数据源，也是本地 Context Hub 的第一步。
 *
 * 存储：~/.proma-mit/runs/{YYYY-MM}.jsonl（按月分片，防单文件过大）。
 * 保留策略：最多保留最近 2000 条（自动裁剪）。
 */

import { appendFileSync, mkdirSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { getConfigDir } from './config-paths'
import type { AppEventEnvelope, RunRecord, RunRecordQuery } from '@gravitas/shared'

const MAX_RECORDS = 2000

function runsDir(): string {
  const dir = join(getConfigDir(), 'runs')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

function monthFile(ts: number): string {
  const d = new Date(ts)
  const month = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
  return join(runsDir(), `${month}.jsonl`)
}

/** 从 AppEventEnvelope 转运行记录 */
export function toRunRecord(event: AppEventEnvelope): RunRecord {
  return {
    id: event.id,
    runId: event.taskId,
    source: event.source,
    title: event.title,
    status: event.type,
    ...(event.type === 'waiting_action' ? { actionKind: event.actionKind } : {}),
    ...('detail' in event && event.detail ? { detail: event.detail } : {}),
    ...(event.sessionId ? { sessionId: event.sessionId } : {}),
    ...('goalId' in event && event.goalId ? { goalId: event.goalId } : {}),
    ...('memberId' in event && event.memberId ? { memberId: event.memberId } : {}),
    ...('workspaceId' in event && event.workspaceId ? { workspaceId: event.workspaceId } : {}),
    ...('evidence' in event && event.evidence ? { evidence: event.evidence } : {}),
    timestamp: event.timestamp,
  }
}

class RunStore {
  private unsubscribe: (() => void) | null = null
  private started = false
  private cache: RunRecord[] = []

  /** 记录一条运行事件（供 AppEventBus 订阅 / 测试直接调用） */
  record(event: AppEventEnvelope): void {
    try {
      const record = toRunRecord(event)
      appendFileSync(monthFile(event.timestamp), `${JSON.stringify(record)}\n`, 'utf-8')
      this.cache.unshift(record)
      if (this.cache.length > MAX_RECORDS) this.cache.length = MAX_RECORDS
    } catch (error) {
      console.error('[RunStore] 写入运行记录失败:', error)
    }
  }

  /** 查询运行记录（按时间倒序） */
  query(query: RunRecordQuery = {}): RunRecord[] {
    const { source, status, memberId, limit = 100, from } = query
    const results = this.cache.filter((r) => {
      if (source && r.source !== source) return false
      if (status && r.status !== status) return false
      if (memberId && r.memberId !== memberId) return false
      if (from && r.timestamp < from) return false
      return true
    })
    return results.slice(0, limit)
  }

  /** 清空运行记录 */
  clear(): void {
    this.cache = []
    const dir = runsDir()
    for (const file of readdirSync(dir)) {
      if (file.endsWith('.jsonl')) {
        try { rmSync(join(dir, file), { force: true }) } catch { /* ignore */ }
      }
    }
  }

  /** 导出查询结果到指定文件（JSONL），返回导出条数 */
  exportToFile(filePath: string, query: RunRecordQuery = {}): number {
    const records = this.query({ ...query, limit: MAX_RECORDS })
    const lines = records.map((r) => JSON.stringify(r)).join('\n')
    appendFileSync(filePath, lines ? lines + '\n' : '', 'utf-8')
    return records.length
  }

  /** 启动时加载最近记录到内存（从各月文件读尾部） */
  start(): void {
    if (this.started) return
    this.started = true
    this.cache = []
    try {
      const dir = runsDir()
      const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort().reverse()
      // 从最新文件往回读，凑够 MAX_RECORDS
      for (const file of files) {
        if (this.cache.length >= MAX_RECORDS) break
        const lines = readFileSync(join(dir, file), 'utf-8').trim().split('\n').filter(Boolean)
        for (const line of lines.reverse()) {
          try {
            this.cache.push(JSON.parse(line) as RunRecord)
          } catch { /* 跳过损坏行 */ }
          if (this.cache.length >= MAX_RECORDS) break
        }
      }
      this.cache.sort((a, b) => b.timestamp - a.timestamp)
    } catch (error) {
      console.warn('[RunStore] 加载历史运行记录失败:', error)
    }

    // 订阅统一事件总线
    const { getAppEventBus } = require('./app-event-bus') as { getAppEventBus: () => { on: (h: (e: AppEventEnvelope) => void) => () => void } }
    this.unsubscribe = getAppEventBus().on((event) => this.record(event))
  }

  stop(): void {
    this.unsubscribe?.()
    this.unsubscribe = null
    this.started = false
  }
}

/** 单例 */
let store: RunStore | null = null

export function getRunStore(): RunStore {
  store ??= new RunStore()
  return store
}

export function startRunStore(): void {
  getRunStore().start()
}

export function stopRunStore(): void {
  store?.stop()
  store = null
}

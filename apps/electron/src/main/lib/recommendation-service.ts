/**
 * RecommendationService - 智能推荐引擎
 *
 * 从本地使用信号中提取推荐，生成结构化 Recommendation，
 * 由用户确认后才转成持久主动任务。
 *
 * 第一阶段使用确定性规则（不依赖模型）：
 * - Memory candidates 出现且未开启 memory-daily → 推荐 Daily Memory
 * - release/tag/workflow/CI 信号达到阈值 → 推荐 Release Monitor
 * - SOP candidates 积累到阈值 → 推荐 Weekly SOP Review
 * - pending approvals 积压到阈值 → 推荐 Approval Digest
 *
 * 待实现：
 * - 会话摘要分析（第二阶段 Agent 分析器）
 * - 时间表达检测
 * - 纠正和偏好检测
 */

import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { getProactiveConfigPath } from './config-paths'
import type { ProactiveRecommendation, RecommendationKind, RecommendationSafetyLevel } from '@gravitas/shared'
import { ProactiveSchedulerStore } from './proactive-scheduler-store'
import { listMonitors } from './monitor-service'
import { getPendingApprovals } from './approval-service'
import { listMemoryItems } from './memory-plugin-service'

const RECOMMENDATIONS_FILE = 'recommendations.json'

/** 内存缓存 */
let recommendationsCache: ProactiveRecommendation[] | null = null

function getRecommendationsFilePath(): string {
  return join(getProactiveConfigPath(), RECOMMENDATIONS_FILE)
}

function ensureDir(): void {
  const dir = getProactiveConfigPath()
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
}

function loadRecommendations(): ProactiveRecommendation[] {
  if (recommendationsCache) return recommendationsCache
  const path = getRecommendationsFilePath()
  if (!existsSync(path)) return []
  try {
    const data = JSON.parse(readFileSync(path, 'utf-8'))
    recommendationsCache = Array.isArray(data) ? data : []
    return recommendationsCache
  } catch {
    return []
  }
}

function saveRecommendations(recommendations: ProactiveRecommendation[]): void {
  ensureDir()
  writeFileSync(getRecommendationsFilePath(), JSON.stringify(recommendations, null, 2))
  recommendationsCache = recommendations
}

// ===== CRUD =====

export function listRecommendations(): ProactiveRecommendation[] {
  return loadRecommendations()
}

export function getRecommendation(id: string): ProactiveRecommendation | undefined {
  return loadRecommendations().find((r) => r.id === id)
}

export function getPendingRecommendations(): ProactiveRecommendation[] {
  return loadRecommendations().filter((r) => r.status === 'suggested')
}

export interface CreateRecommendationInput {
  kind: RecommendationKind
  title: string
  reason: string
  scope: string
  confidence: number
  safetyLevel: RecommendationSafetyLevel
  duplicateKey: string
  evidence?: Array<{
    label: string
    detail: string
    sourceId?: string
    sourceKind?: 'run' | 'memory' | 'approval' | 'schedule' | 'monitor'
  }>
  action: unknown
}

export function createRecommendation(input: CreateRecommendationInput): ProactiveRecommendation | null {
  // 去重检查：如果已有相同 duplicateKey 的推荐，不创建新的
  const existing = loadRecommendations().find((r) => r.duplicateKey === input.duplicateKey)
  if (existing) return null

  const recommendation: ProactiveRecommendation = {
    id: randomUUID(),
    kind: input.kind,
    title: input.title,
    reason: input.reason,
    scope: input.scope,
    confidence: input.confidence,
    safetyLevel: input.safetyLevel,
    duplicateKey: input.duplicateKey,
    evidence: input.evidence ?? [],
    action: input.action,
    status: 'suggested',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
  const recommendations = loadRecommendations()
  recommendations.push(recommendation)
  saveRecommendations(recommendations)
  return recommendation
}

export function acceptRecommendation(id: string): ProactiveRecommendation | null {
  const recommendations = loadRecommendations()
  const idx = recommendations.findIndex((r) => r.id === id)
  if (idx === -1) return null
  const updated = { ...recommendations[idx], status: 'accepted' as const, updatedAt: Date.now() }
  recommendations[idx] = updated as ProactiveRecommendation
  saveRecommendations(recommendations)
  return recommendations[idx]
}

export function dismissRecommendation(id: string): ProactiveRecommendation | null {
  const recommendations = loadRecommendations()
  const idx = recommendations.findIndex((r) => r.id === id)
  if (idx === -1) return null
  const updated = { ...recommendations[idx], status: 'dismissed' as const, updatedAt: Date.now() }
  recommendations[idx] = updated as ProactiveRecommendation
  saveRecommendations(recommendations)
  return recommendations[idx]
}

export function deleteRecommendation(id: string): boolean {
  const recommendations = loadRecommendations()
  const filtered = recommendations.filter((r) => r.id !== id)
  if (filtered.length === recommendations.length) return false
  saveRecommendations(filtered)
  return true
}

/** 仅用于行为测试，清理模块级缓存。 */
export function resetRecommendationServiceForTests(): void {
  recommendationsCache = null
}

// ===== 规则引擎 =====

export interface SignalContext {
  /** 近期运行记录 */
  recentRuns: Array<{ routineId?: string; status: string; startedAt?: number }>
  /** 是否存在 memory-daily schedule */
  hasMemoryDailySchedule: boolean
  /** 是否存在 release monitor */
  hasReleaseMonitor: boolean
  /** pending approvals 数量 */
  pendingApprovalCount: number
  /** SOP candidates 数量 */
  sopCandidateCount: number
  /** 最近是否有 release/CI 相关运行 */
  recentReleaseRuns: number
}

/**
 * 运行规则引擎，生成推荐
 */
export function runRecommendationEngine(context: SignalContext): ProactiveRecommendation[] {
  const newRecommendations: ProactiveRecommendation[] = []

  // 规则 1：Memory candidates 存在且未开启 memory-daily
  if (!context.hasMemoryDailySchedule && context.recentRuns.length > 0) {
    const rec = createRecommendation({
      kind: 'schedule',
      title: '每日记忆整理',
      reason: '你近期有多次会话总结行为，建议开启每日自动整理',
      scope: 'memory',
      confidence: 0.7,
      safetyLevel: 'writes_memory',
      duplicateKey: 'memory-daily-suggestion',
      evidence: [
        { label: '近期运行', detail: `${context.recentRuns.length} 次运行记录` },
      ],
      action: {
        type: 'create_schedule',
        routineId: 'memory-daily',
        schedule: { type: 'cron', expression: '0 23 * * *', timezone: 'Asia/Shanghai' },
      },
    })
    if (rec) newRecommendations.push(rec)
  }

  // 规则 2：Release 相关运行频繁且未创建 monitor
  if (!context.hasReleaseMonitor && context.recentReleaseRuns >= 3) {
    const rec = createRecommendation({
      kind: 'monitor',
      title: 'Release 状态监控',
      reason: '你近期多次查询 release 状态，建议创建自动监控',
      scope: 'release',
      confidence: 0.8,
      safetyLevel: 'read_only',
      duplicateKey: 'release-monitor-suggestion',
      evidence: [
        { label: '查询次数', detail: `${context.recentReleaseRuns} 次 release 相关运行` },
      ],
      action: {
        type: 'create_monitor',
        trigger: { type: 'github', repo: '', events: ['release'] },
      },
    })
    if (rec) newRecommendations.push(rec)
  }

  // 规则 3：Pending approvals 积压
  if (context.pendingApprovalCount >= 5) {
    const rec = createRecommendation({
      kind: 'schedule',
      title: '审批摘要',
      reason: '有多个待审批事项积压，建议定期汇总',
      scope: 'approval',
      confidence: 0.6,
      safetyLevel: 'read_only',
      duplicateKey: 'approval-digest-suggestion',
      evidence: [
        { label: '待审批数', detail: `${context.pendingApprovalCount} 个待审批` },
      ],
      action: {
        type: 'create_schedule',
        routineId: 'approval-digest',
        schedule: { type: 'interval', intervalMs: 24 * 60 * 60 * 1000 },
      },
    })
    if (rec) newRecommendations.push(rec)
  }

  // 规则 4：SOP candidates 积累
  if (context.sopCandidateCount >= 3) {
    const rec = createRecommendation({
      kind: 'schedule',
      title: 'SOP 候选回顾',
      reason: '积累了多个 SOP 候选，建议定期回顾',
      scope: 'skill',
      confidence: 0.6,
      safetyLevel: 'writes_files',
      duplicateKey: 'sop-review-suggestion',
      evidence: [
        { label: '候选数', detail: `${context.sopCandidateCount} 个 SOP 候选` },
      ],
      action: {
        type: 'create_schedule',
        routineId: 'sop-review',
        schedule: { type: 'interval', intervalMs: 7 * 24 * 60 * 60 * 1000 },
      },
    })
    if (rec) newRecommendations.push(rec)
  }

  return newRecommendations
}

/**
 * 从本地事实源构建推荐信号。这里不读取模型文本，也不上传会话内容；
 * 仅使用本地运行、配置、审批和记忆条目的元数据。
 */
export function collectRecommendationSignals(): SignalContext {
  const store = new ProactiveSchedulerStore()
  const schedules = store.listSchedules()
  const runs = store.listRuns()
  const monitors = listMonitors()
  const hasMemoryDailySchedule = schedules.some((schedule) => {
    const text = `${schedule.title}\n${schedule.prompt}`.toLowerCase()
    return text.includes('memory') || text.includes('记忆')
  })
  const hasReleaseMonitor = monitors.some((monitor) =>
    monitor.trigger.type === 'github' || monitor.routineId.toLowerCase().includes('release')
  )
  const recentReleaseRuns = runs.filter((run) => {
    const text = `${run.outputSummary ?? ''}\n${run.error ?? ''}`.toLowerCase()
    return text.includes('release') || text.includes('发布') || text.includes('ci')
  }).length

  return {
    recentRuns: runs.slice(0, 50).map((run) => ({
      status: run.status,
      startedAt: run.startedAt,
    })),
    hasMemoryDailySchedule,
    hasReleaseMonitor,
    pendingApprovalCount: getPendingApprovals().length,
    sopCandidateCount: listMemoryItems('sop').length,
    recentReleaseRuns,
  }
}

/** 刷新本地推荐；duplicateKey 保证重复刷新不会制造卡片堆积。 */
export function refreshRecommendations(): ProactiveRecommendation[] {
  return runRecommendationEngine(collectRecommendationSignals())
}

// ===== IPC 处理器注册 =====

export function registerRecommendationIPCHandlers(): void {
  const { ipcMain } = require('electron')

  ipcMain.handle('proactive:listRecommendations', () => listRecommendations())
  ipcMain.handle('proactive:getPendingRecommendations', () => getPendingRecommendations())
  ipcMain.handle('proactive:acceptRecommendation', (_event: unknown, id: string) => acceptRecommendation(id))
  ipcMain.handle('proactive:dismissRecommendation', (_event: unknown, id: string) => dismissRecommendation(id))
  ipcMain.handle('proactive:deleteRecommendation', (_event: unknown, id: string) => deleteRecommendation(id))
  ipcMain.handle('proactive:runRecommendationEngine', (_event: unknown, context: SignalContext) => runRecommendationEngine(context))
  ipcMain.handle('proactive:refreshRecommendations', () => refreshRecommendations())
}

/**
 * Proma Memory Plugin - 长期记忆管理
 *
 * 管理用户长期记忆的存储、检索和整理。
 * 数据存储在 ~/.gravitas/plugins/proma-memory/data/
 *
 * 当前实现：
 * - 记忆目录结构管理
 * - 记忆条目 CRUD（含 archivedAt 软归档，可回滚）
 * - 从 Agent 输出解析 proma-memory-items
 * - 记忆搜索（按 效用×新近度 排序，默认排除已归档）
 * - 记忆治理（Select + Maintain，见 memory-governance.ts）：
 *   runMemoryMaintenance 执行相似合并（巩固）与低效用超期归档（遗忘）
 *
 * 待实现：
 * - 与 ApprovalService 集成（写入前审批，已有 memory_write 审批通路）
 * - 与 RecommendationService 集成（生成推荐）
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { getConfigDir } from './config-paths'
import { computeRetrievalScore, planConsolidation, type ConsolidationOptions } from './memory-governance'

// ===== 类型定义 =====

export type MemoryItemKind = 'preference' | 'correction' | 'sop' | 'diary' | 'fact' | 'unknown'

export interface MemoryItem {
  id: string
  title: string
  content: string
  kind: MemoryItemKind
  tags: string[]
  confidence: number
  sourceRunId: string | null
  sourceSessionId: string | null
  createdAt: number
  updatedAt: number
  /** 效用分（0..1，Select 维）：创建时以 confidence 为先验，使用反馈可更新 */
  utilityScore?: number
  /** 被检索/使用次数（Select 反馈信号） */
  useCount?: number
  /** 最近一次被使用时间戳 */
  lastUsedAt?: number | null
  /** 归档时间戳（Maintain 遗忘/合并的软删除标记）；null/缺省 = 活跃 */
  archivedAt?: number | null
  /** 若因合并被归档，指向幸存者条目 id */
  mergedInto?: string | null
  /** 本条目合并过的来源条目 id 列表 */
  mergedFrom?: string[]
}

export interface MemoryItemsBlock {
  items: Array<{
    title: string
    content: string
    kind?: string
    tags?: string[]
    confidence?: number
  }>
}

// ===== 路径管理 =====

const PLUGIN_DIR = 'plugins/proma-memory'
const DATA_DIR = 'data'
const PROFILE_FILE = 'profile.md'
const CORRECTIONS_DIR = 'corrections'
const SOP_DIR = 'sop-candidates'
const MEMORY_LOG_DIR = 'memory-log'
const DIARY_DIR = 'diary'

function getPluginDir(): string {
  const dir = join(getConfigDir(), PLUGIN_DIR)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  return dir
}

function getDataDir(): string {
  const dir = join(getPluginDir(), DATA_DIR)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  return dir
}

function ensureDataDirs(): void {
  const dataDir = getDataDir()
  for (const subdir of [CORRECTIONS_DIR, SOP_DIR, MEMORY_LOG_DIR, DIARY_DIR]) {
    const dir = join(dataDir, subdir)
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }
  }
}

// ===== 记忆条目管理 =====

const ITEMS_FILE = 'items.json'

let itemsCache: MemoryItem[] | null = null

function getItemsFilePath(): string {
  return join(getDataDir(), ITEMS_FILE)
}

function loadItems(): MemoryItem[] {
  if (itemsCache) return itemsCache
  const path = getItemsFilePath()
  if (!existsSync(path)) return []
  try {
    const data = JSON.parse(readFileSync(path, 'utf-8'))
    itemsCache = Array.isArray(data) ? data : []
    return itemsCache
  } catch {
    return []
  }
}

function saveItems(items: MemoryItem[]): void {
  ensureDataDirs()
  writeFileSync(getItemsFilePath(), JSON.stringify(items, null, 2))
  itemsCache = items
}

// ===== CRUD =====

/** 检索排序：效用 × 新近度（Select 维，纯函数在 memory-governance）。 */
function byRetrievalScoreDesc(now: number) {
  return (a: MemoryItem, b: MemoryItem) => computeRetrievalScore(b, now) - computeRetrievalScore(a, now)
}

export function listMemoryItems(kind?: MemoryItemKind, opts: { includeArchived?: boolean } = {}): MemoryItem[] {
  let items = loadItems()
  if (!opts.includeArchived) {
    items = items.filter((item) => !item.archivedAt)
  }
  if (kind) {
    items = items.filter((item) => item.kind === kind)
  }
  const now = Date.now()
  return [...items].sort(byRetrievalScoreDesc(now))
}

export function getMemoryItem(id: string): MemoryItem | undefined {
  return loadItems().find((item) => item.id === id)
}

export function searchMemoryItems(query: string, opts: { includeArchived?: boolean } = {}): MemoryItem[] {
  const lowerQuery = query.toLowerCase()
  const now = Date.now()
  return loadItems()
    .filter((item) => (opts.includeArchived ? true : !item.archivedAt))
    .filter(
      (item) =>
        item.title.toLowerCase().includes(lowerQuery) ||
        item.content.toLowerCase().includes(lowerQuery) ||
        item.tags.some((tag) => tag.toLowerCase().includes(lowerQuery))
    )
    .sort(byRetrievalScoreDesc(now))
}

export function createMemoryItem(item: Omit<MemoryItem, 'id' | 'createdAt' | 'updatedAt'>): MemoryItem {
  const newItem: MemoryItem = {
    ...item,
    id: generateId(),
    // Select：写入时以 confidence 为效用先验（审批通过本身即一次正向信号）
    utilityScore: item.utilityScore ?? Math.max(0, Math.min(1, item.confidence ?? 0.5)),
    useCount: item.useCount ?? 0,
    lastUsedAt: item.lastUsedAt ?? null,
    archivedAt: item.archivedAt ?? null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
  const items = loadItems()
  items.push(newItem)
  saveItems(items)
  return newItem
}

export function updateMemoryItem(id: string, updates: Partial<Omit<MemoryItem, 'id' | 'createdAt'>>): MemoryItem | null {
  const items = loadItems()
  const idx = items.findIndex((item) => item.id === id)
  if (idx === -1) return null
  const updated = { ...items[idx], ...updates, updatedAt: Date.now() }
  items[idx] = updated as MemoryItem
  saveItems(items)
  return items[idx]
}

export function deleteMemoryItem(id: string): boolean {
  const items = loadItems()
  const filtered = items.filter((item) => item.id !== id)
  if (filtered.length === items.length) return false
  saveItems(filtered)
  return true
}

// ===== 记忆治理（Select 反馈 + Maintain 巩固/遗忘） =====

/**
 * 记录一次记忆使用（Select 反馈信号）：useCount+1、lastUsedAt=now。
 * 检索侧（如 prompt 组装）命中条目后调用，使效用估计随真实使用更新。
 */
export function recordMemoryUsage(id: string, utilityFeedback?: number): MemoryItem | null {
  const items = loadItems()
  const idx = items.findIndex((item) => item.id === id)
  if (idx === -1) return null
  const item = items[idx]!
  const updates: Partial<MemoryItem> = {
    useCount: (item.useCount ?? 0) + 1,
    lastUsedAt: Date.now(),
  }
  // 可选的使用反馈（0..1）：指数滑动平均更新效用，避免单次反馈剧烈翻转
  if (typeof utilityFeedback === 'number' && utilityFeedback >= 0 && utilityFeedback <= 1) {
    const prev = item.utilityScore ?? item.confidence ?? 0.5
    updates.utilityScore = Math.round((prev * 0.7 + utilityFeedback * 0.3) * 1000) / 1000
  }
  const updated = { ...item, ...updates, updatedAt: item.updatedAt } // 使用不改变内容新鲜度
  items[idx] = updated
  saveItems(items)
  return updated
}

/** 恢复一条被归档的记忆（回滚 Maintain 的遗忘/合并）。 */
export function restoreMemoryItem(id: string): MemoryItem | null {
  const items = loadItems()
  const idx = items.findIndex((item) => item.id === id)
  if (idx === -1) return null
  const item = items[idx]!
  if (!item.archivedAt) return item
  const updated: MemoryItem = { ...item, archivedAt: null, mergedInto: null, updatedAt: Date.now() }
  items[idx] = updated
  saveItems(items)
  return updated
}

export interface MemoryMaintenanceReport {
  time: string
  mergedGroups: number
  mergedArchivedIds: string[]
  forgottenIds: string[]
  activeBefore: number
  activeAfter: number
}

/**
 * 执行一次记忆维护（Maintain 维）：
 * - 巩固：同 kind 相似条目合并——幸存者取组内最大 confidence/utility、tags 并集、
 *   记录 mergedFrom；被合并者归档并记 mergedInto（可回滚）。
 * - 遗忘：低效用 + 超期条目归档（diary 豁免），**不物理删除**。
 *
 * 每次执行写一份报告到 memory-log/maintenance-YYYY-MM-DD.json（同日覆盖），
 * 并返回报告供 routine/IPC 展示。所有归档均可经 restoreMemoryItem 回滚。
 */
export function runMemoryMaintenance(opts: ConsolidationOptions = {}): MemoryMaintenanceReport {
  const now = Date.now()
  const items = loadItems()
  const activeBefore = items.filter((i) => !i.archivedAt).length
  const plan = planConsolidation(items, now, opts)

  for (const merge of plan.merges) {
    const survivor = items.find((i) => i.id === merge.survivorId)
    if (survivor) {
      survivor.tags = merge.mergedTags
      survivor.confidence = merge.confidence
      survivor.utilityScore = merge.utilityScore
      survivor.mergedFrom = [...new Set([...(survivor.mergedFrom ?? []), ...merge.archivedIds])]
      survivor.updatedAt = now
    }
    for (const id of merge.archivedIds) {
      const loser = items.find((i) => i.id === id)
      if (loser) {
        loser.archivedAt = now
        loser.mergedInto = merge.survivorId
      }
    }
  }
  for (const id of plan.forgetArchiveIds) {
    const item = items.find((i) => i.id === id)
    if (item) item.archivedAt = now
  }

  if (plan.merges.length > 0 || plan.forgetArchiveIds.length > 0) {
    saveItems(items)
  }

  const report: MemoryMaintenanceReport = {
    time: new Date(now).toISOString(),
    mergedGroups: plan.merges.length,
    mergedArchivedIds: plan.merges.flatMap((m) => m.archivedIds),
    forgottenIds: plan.forgetArchiveIds,
    activeBefore,
    activeAfter: items.filter((i) => !i.archivedAt).length,
  }

  // 治理报告落盘（可审计）
  ensureDataDirs()
  const date = report.time.slice(0, 10)
  writeFileSync(
    join(getDataDir(), MEMORY_LOG_DIR, `maintenance-${date}.json`),
    JSON.stringify(report, null, 2),
  )
  return report
}

// ===== 从 Agent 输出解析 =====

/**
 * 解析模型输出为尚未写入的记忆候选。
 * 主动 Routine 只能使用这个函数，必须经 ApprovalService 才能持久化。
 */
export function extractMemoryCandidatesFromOutput(
  output: string,
  runId?: string,
  sessionId?: string,
): Array<Omit<MemoryItem, 'id' | 'createdAt' | 'updatedAt'>> {
  const regex = /```proma-memory-items\n([\s\S]*?)\n```/
  const match = output.match(regex)
  if (!match) return []

  try {
    const block: MemoryItemsBlock = JSON.parse(match[1]!)
    return block.items.map((item) => ({
        title: item.title,
        content: item.content,
        kind: normalizeKind(item.kind),
        tags: item.tags ?? [],
        confidence: item.confidence ?? 0.8,
        sourceRunId: runId ?? null,
        sourceSessionId: sessionId ?? null,
      }))
  } catch {
    return []
  }
}

function normalizeKind(kind: string | undefined): MemoryItemKind {
  const validKinds: MemoryItemKind[] = ['preference', 'correction', 'sop', 'diary', 'fact']
  if (kind && validKinds.includes(kind as MemoryItemKind)) {
    return kind as MemoryItemKind
  }
  return 'unknown'
}

function generateId(): string {
  return `mem_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
}

// ===== Profile 管理 =====

export function getProfile(): string {
  const path = join(getDataDir(), PROFILE_FILE)
  if (!existsSync(path)) return ''
  return readFileSync(path, 'utf-8')
}

export function updateProfile(content: string): void {
  ensureDataDirs()
  writeFileSync(join(getDataDir(), PROFILE_FILE), content)
}

// ===== Diary 管理 =====

export function getDiary(date: string): string {
  const path = join(getDataDir(), DIARY_DIR, `${date}.md`)
  if (!existsSync(path)) return ''
  return readFileSync(path, 'utf-8')
}

export function writeDiary(date: string, content: string): void {
  ensureDataDirs()
  writeFileSync(join(getDataDir(), DIARY_DIR, `${date}.md`), content)
}

export function listDiaryDates(): string[] {
  const dir = join(getDataDir(), DIARY_DIR)
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => f.slice(0, -3))
    .sort()
}

// ===== Memory Log 管理 =====

export function getMemoryLog(date: string): string {
  const path = join(getDataDir(), MEMORY_LOG_DIR, `${date}.md`)
  if (!existsSync(path)) return ''
  return readFileSync(path, 'utf-8')
}

export function writeMemoryLog(date: string, content: string): void {
  ensureDataDirs()
  writeFileSync(join(getDataDir(), MEMORY_LOG_DIR, `${date}.md`), content)
}

// ===== 统计 =====

export function getMemoryStats(): {
  totalItems: number
  archivedItems: number
  byKind: Record<MemoryItemKind, number>
  recentItems: MemoryItem[]
} {
  const items = loadItems()
  const active = items.filter((i) => !i.archivedAt)
  const byKind: Record<MemoryItemKind, number> = {
    preference: 0,
    correction: 0,
    sop: 0,
    diary: 0,
    fact: 0,
    unknown: 0,
  }
  for (const item of active) {
    byKind[item.kind] = (byKind[item.kind] || 0) + 1
  }
  return {
    totalItems: active.length,
    archivedItems: items.length - active.length,
    byKind,
    recentItems: [...active].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 10),
  }
}

// ===== 初始化 =====

export function initializeMemoryPlugin(): void {
  ensureDataDirs()
  // 创建默认 profile
  const profilePath = join(getDataDir(), PROFILE_FILE)
  if (!existsSync(profilePath)) {
    writeFileSync(
      profilePath,
      '# 用户档案\n\n> 由 Proma Memory Plugin 自动维护\n\n## 偏好\n\n## 纠正\n\n## 常用工作流\n'
    )
  }
}

// ===== IPC 处理器注册 =====

export function registerMemoryPluginIPCHandlers(): void {
  const { ipcMain } = require('electron')

  ipcMain.handle('memory:listItems', (_event: unknown, kind?: MemoryItemKind) => listMemoryItems(kind))
  ipcMain.handle('memory:getItem', (_event: unknown, id: string) => getMemoryItem(id))
  ipcMain.handle('memory:searchItems', (_event: unknown, query: string) => searchMemoryItems(query))
  ipcMain.handle('memory:createItem', (_event: unknown, item: Omit<MemoryItem, 'id' | 'createdAt' | 'updatedAt'>) => createMemoryItem(item))
  ipcMain.handle('memory:updateItem', (_event: unknown, id: string, updates: Partial<Omit<MemoryItem, 'id' | 'createdAt'>>) => updateMemoryItem(id, updates))
  ipcMain.handle('memory:deleteItem', (_event: unknown, id: string) => deleteMemoryItem(id))
  ipcMain.handle('memory:restoreItem', (_event: unknown, id: string) => restoreMemoryItem(id))
  ipcMain.handle('memory:recordUsage', (_event: unknown, id: string, utilityFeedback?: number) => recordMemoryUsage(id, utilityFeedback))
  ipcMain.handle('memory:runMaintenance', (_event: unknown, opts?: ConsolidationOptions) => runMemoryMaintenance(opts))
  ipcMain.handle('memory:getProfile', () => getProfile())
  ipcMain.handle('memory:updateProfile', (_event: unknown, content: string) => updateProfile(content))
  ipcMain.handle('memory:getDiary', (_event: unknown, date: string) => getDiary(date))
  ipcMain.handle('memory:writeDiary', (_event: unknown, date: string, content: string) => writeDiary(date, content))
  ipcMain.handle('memory:listDiaryDates', () => listDiaryDates())
  ipcMain.handle('memory:getStats', () => getMemoryStats())
  ipcMain.handle('memory:initialize', () => initializeMemoryPlugin())
}

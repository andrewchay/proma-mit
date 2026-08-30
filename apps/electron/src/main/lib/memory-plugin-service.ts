/**
 * Proma Memory Plugin - 长期记忆管理
 *
 * 管理用户长期记忆的存储、检索和整理。
 * 数据存储在 ~/.gravitas/plugins/proma-memory/data/
 *
 * 当前为骨架实现，支持：
 * - 记忆目录结构管理
 * - 记忆条目 CRUD
 * - 从 Agent 输出解析 proma-memory-items
 * - 记忆搜索
 *
 * 待实现：
 * - 与 ApprovalService 集成（写入前审批）
 * - 与 RecommendationService 集成（生成推荐）
 * - 记忆去重和合并
 * - 记忆过期清理
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { getConfigDir } from './config-paths'

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

export function listMemoryItems(kind?: MemoryItemKind): MemoryItem[] {
  const items = loadItems()
  if (kind) {
    return items.filter((item) => item.kind === kind)
  }
  return items
}

export function getMemoryItem(id: string): MemoryItem | undefined {
  return loadItems().find((item) => item.id === id)
}

export function searchMemoryItems(query: string): MemoryItem[] {
  const lowerQuery = query.toLowerCase()
  return loadItems().filter(
    (item) =>
      item.title.toLowerCase().includes(lowerQuery) ||
      item.content.toLowerCase().includes(lowerQuery) ||
      item.tags.some((tag) => tag.toLowerCase().includes(lowerQuery))
  )
}

export function createMemoryItem(item: Omit<MemoryItem, 'id' | 'createdAt' | 'updatedAt'>): MemoryItem {
  const newItem: MemoryItem = {
    ...item,
    id: generateId(),
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
  byKind: Record<MemoryItemKind, number>
  recentItems: MemoryItem[]
} {
  const items = loadItems()
  const byKind: Record<MemoryItemKind, number> = {
    preference: 0,
    correction: 0,
    sop: 0,
    diary: 0,
    fact: 0,
    unknown: 0,
  }
  for (const item of items) {
    byKind[item.kind] = (byKind[item.kind] || 0) + 1
  }
  return {
    totalItems: items.length,
    byKind,
    recentItems: items.slice(-10).reverse(),
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
  ipcMain.handle('memory:getProfile', () => getProfile())
  ipcMain.handle('memory:updateProfile', (_event: unknown, content: string) => updateProfile(content))
  ipcMain.handle('memory:getDiary', (_event: unknown, date: string) => getDiary(date))
  ipcMain.handle('memory:writeDiary', (_event: unknown, date: string, content: string) => writeDiary(date, content))
  ipcMain.handle('memory:listDiaryDates', () => listDiaryDates())
  ipcMain.handle('memory:getStats', () => getMemoryStats())
  ipcMain.handle('memory:initialize', () => initializeMemoryPlugin())
}

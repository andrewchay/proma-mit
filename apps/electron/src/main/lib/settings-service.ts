/**
 * 应用设置服务
 *
 * 管理应用设置（主题模式等）的读写。
 * 存储在 ~/.proma/settings.json
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { getSettingsPath } from './config-paths'
import { DEFAULT_THEME_MODE } from '../../types'
import { DEFAULT_AGENT_RUNTIME, normalizeAgentRuntime } from '@gravitas/shared'
import type { AppSettings } from '../../types'

/**
 * 获取应用设置
 *
 * 如果文件不存在，返回默认设置。
 */
export function getSettings(): AppSettings {
  const filePath = getSettingsPath()

  if (!existsSync(filePath)) {
    return {
      themeMode: DEFAULT_THEME_MODE,
      agentRuntime: DEFAULT_AGENT_RUNTIME,
      onboardingCompleted: false,
      environmentCheckSkipped: false,
      notificationsEnabled: true,
    }
  }

  try {
    const raw = readFileSync(filePath, 'utf-8')
    const data = JSON.parse(raw) as Partial<AppSettings>
    return {
      ...data,
      themeMode: data.themeMode || DEFAULT_THEME_MODE,
      agentRuntime: normalizeAgentRuntime(data.agentRuntime),
      onboardingCompleted: data.onboardingCompleted ?? false,
      environmentCheckSkipped: data.environmentCheckSkipped ?? false,
      notificationsEnabled: data.notificationsEnabled ?? true,
    }
  } catch (error) {
    console.error('[设置] 读取失败:', error)
    return {
      themeMode: DEFAULT_THEME_MODE,
      agentRuntime: DEFAULT_AGENT_RUNTIME,
      onboardingCompleted: false,
      environmentCheckSkipped: false,
      notificationsEnabled: true,
    }
  }
}

/**
 * 更新应用设置
 *
 * 浅合并顶层字段；对嵌套对象（如 computerUse）做深度合并，避免更新子字段时
 * 意外丢掉其余子字段。
 */
export function updateSettings(updates: Partial<AppSettings>): AppSettings {
  const current = getSettings()
  const updated: AppSettings = mergeNestedSettings(current, updates)

  const filePath = getSettingsPath()

  try {
    writeFileSync(filePath, JSON.stringify(updated, null, 2), 'utf-8')
    console.log('[设置] 已更新 keys:', Object.keys(updates).join(', '))
  } catch (error) {
    console.error('[设置] 写入失败:', error)
    throw new Error('写入应用设置失败')
  }

  notifySettingsChange(updated, updates)
  return updated
}

/** 需要深度合并的嵌套对象字段（更新子字段时保留其余子字段，避免整块替换丢失）。 */
export const NESTED_MERGE_FIELDS: ReadonlySet<keyof AppSettings> = new Set<keyof AppSettings>([
  'computerUse',
  'agentAllowlist',
  'feishuTodo',
  'dingtalkTodo',
  'briefCallback',
  'visionRelay',
  'voiceDictation',
  'mainWindowState',
  'shortcutOverrides',
])

/** 纯函数：对嵌套对象字段做深合并（其余字段浅合并）。导出便于单测。 */
export function mergeNestedSettings(current: AppSettings, updates: Partial<AppSettings>): AppSettings {
  const merged: Record<string, unknown> = { ...current as unknown as Record<string, unknown> }
  for (const [key, value] of Object.entries(updates)) {
    if (NESTED_MERGE_FIELDS.has(key as keyof AppSettings) && isPlainObject(value)) {
      const currentValue = merged[key]
      const next = { ...(isPlainObject(currentValue) ? currentValue : {}), ...value }
      merged[key] = next
      continue
    }
    merged[key] = value
  }
  return merged as unknown as AppSettings
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

type SettingsChangeListener = (settings: AppSettings, updates: Partial<AppSettings>) => void

const settingsChangeListeners: SettingsChangeListener[] = []

/** 注册设置变更监听器 */
export function onSettingsChange(listener: SettingsChangeListener): () => void {
  settingsChangeListeners.push(listener)
  return () => {
    const idx = settingsChangeListeners.indexOf(listener)
    if (idx !== -1) {
      settingsChangeListeners.splice(idx, 1)
    }
  }
}

/** 通知设置变更监听器 */
function notifySettingsChange(settings: AppSettings, updates: Partial<AppSettings>): void {
  for (const listener of settingsChangeListeners) {
    try {
      listener(settings, updates)
    } catch (error) {
      console.error('[设置] 变更监听器执行失败:', error)
    }
  }
}

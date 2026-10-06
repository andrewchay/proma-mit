/**
 * Zotero 库配置（M2.6）
 *
 * 只存非敏感连接信息（基址、库 ID、类型、collection）。
 * Web API key **不落盘到本文件**：需要 key 的库请在系统凭据/环境
 * 变量中提供，由调用方读取后传入 adapter（方案 §11 凭据不进代码）。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { RESEARCH_ERROR_CODES, ResearchError } from '@gravitas/shared'
import { getAcademicDir } from '../config-paths'
import type { ZoteroFetchConfig } from './adapters/zotero-adapter'

/** 落盘的配置（不含 apiKey） */
export interface ZoteroLibraryConfig {
  baseUrl: string
  libraryId: string
  libraryType: 'users' | 'groups'
  collectionKey?: string
  /** 是否本地桌面 API（默认 http://localhost:23119/api） */
  local: boolean
}

const DEFAULT_LOCAL_BASE = 'http://localhost:23119/api'
const DEFAULT_WEB_BASE = 'https://api.zotero.org'

function configPath(): string {
  const dir = getAcademicDir()
  const target = join(dir, 'zotero.json')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return target
}

export function readZoteroConfig(): ZoteroLibraryConfig | null {
  const path = configPath()
  if (!existsSync(path)) return null
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as ZoteroLibraryConfig
    if (!parsed.libraryId || !parsed.libraryType) return null
    return parsed
  } catch (err) {
    console.error('[学术助手] Zotero 配置解析失败，按未配置处理:', err)
    return null
  }
}

export function saveZoteroConfig(input: Partial<ZoteroLibraryConfig>): ZoteroLibraryConfig {
  const local = input.local ?? true
  const baseUrl = input.baseUrl?.trim() || (local ? DEFAULT_LOCAL_BASE : DEFAULT_WEB_BASE)
  const libraryId = input.libraryId?.trim()
  if (!libraryId) {
    throw new ResearchError(RESEARCH_ERROR_CODES.INVALID_INPUT, 'Zotero 库 ID 不能为空')
  }
  if (!/^https?:\/\//.test(baseUrl)) {
    throw new ResearchError(RESEARCH_ERROR_CODES.INVALID_INPUT, 'Zotero 基址必须是 http(s) URL')
  }
  const config: ZoteroLibraryConfig = {
    baseUrl,
    libraryId,
    libraryType: input.libraryType ?? 'users',
    collectionKey: input.collectionKey?.trim() || undefined,
    local,
  }
  writeFileSync(configPath(), JSON.stringify(config, null, 2), 'utf-8')
  return config
}

export function clearZoteroConfig(): void {
  const path = configPath()
  if (existsSync(path)) writeFileSync(path, JSON.stringify({ cleared: true }), 'utf-8')
}

/** 由配置构造 adapter 需要的参数；apiKey 由调用方另传 */
export function toFetchConfig(config: ZoteroLibraryConfig, apiKey?: string): ZoteroFetchConfig {
  return {
    baseUrl: config.baseUrl,
    libraryId: config.libraryId,
    libraryType: config.libraryType,
    collectionKey: config.collectionKey,
    apiKey,
  }
}

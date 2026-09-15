/**
 * 知识目录服务（K1-01）
 *
 * 管理 Source / KnowledgeBase / ProjectKnowledgeBinding 三类元数据，是
 * 「哪些资料可以被检索」的唯一权威来源。原件始终留在用户磁盘上，这里只
 * 记录指向关系。
 *
 * 三条硬约束：
 *
 * 1. **不删旧数据**。旧 vaults.json 保留用于回滚，迁移只新增目录文件。
 * 2. **乐观并发**。每次变更递增修订号，携带过期修订号的写入被拒绝而不是
 *    静默覆盖 —— 元数据丢失会让 Project 意外获得或失去知识范围。
 * 3. **失败关闭**。未知 schema 版本或损坏的目录文件直接抛错，不返回空
 *    目录：空目录会让 Agent 变得"看不到资料"，比报错更难排查。
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { writeFileAtomic } from '@gravitas/shared/utils/node'
import { getKnowledgeDir } from './config-paths'
import type {
  KnowledgeCatalog,
  KnowledgeBase,
  KnowledgeSource,
  KnowledgeSourceType,
  ProjectKnowledgeBinding,
} from '@gravitas/shared'

/** 当前目录 schema 版本。读取到更高版本说明是更新版应用写入的，必须失败关闭。 */
export const CATALOG_SCHEMA_VERSION = 1

/** 待写入目录的接口（测试与迁移共用） */
interface CatalogFile {
  schemaVersion: number
  revision: { revision: number; updatedAt: string }
  sources: KnowledgeSource[]
  knowledgeBases: KnowledgeBase[]
  bindings: ProjectKnowledgeBinding[]
}

function catalogPath(): string {
  return join(getKnowledgeDir(), 'catalog.json')
}

function legacyVaultsPath(): string {
  return join(getKnowledgeDir(), 'vaults.json')
}

function migrationMarkerPath(): string {
  return join(getKnowledgeDir(), 'catalog-migrated.json')
}

function emptyCatalog(): CatalogFile {
  return {
    schemaVersion: CATALOG_SCHEMA_VERSION,
    revision: { revision: 1, updatedAt: new Date().toISOString() },
    sources: [],
    knowledgeBases: [],
    bindings: [],
  }
}

/**
 * 读取目录。
 *
 * 文件不存在返回空目录（首次启动的正常状态）；文件存在但损坏或版本
 * 不支持则抛错，避免把"读失败"伪装成"没有资料"。
 */
export function readCatalog(): KnowledgeCatalog {
  const path = catalogPath()
  if (!existsSync(path)) return emptyCatalog()

  let parsed: CatalogFile
  try {
    parsed = JSON.parse(readFileSync(path, 'utf-8')) as CatalogFile
  } catch (err) {
    throw new Error(
      `知识目录文件损坏，无法解析: ${path}。请检查该文件或从备份恢复，不要直接删除。`,
      { cause: err },
    )
  }

  if (typeof parsed.schemaVersion !== 'number') {
    throw new Error(`知识目录缺少 schemaVersion: ${path}`)
  }
  if (parsed.schemaVersion > CATALOG_SCHEMA_VERSION) {
    throw new Error(
      `知识目录 schemaVersion ${parsed.schemaVersion} 不被当前版本支持（最高 ${CATALOG_SCHEMA_VERSION}）。请升级应用，不要用旧版本写入。`,
    )
  }

  return {
    schemaVersion: parsed.schemaVersion,
    revision: parsed.revision ?? { revision: 1, updatedAt: new Date().toISOString() },
    sources: parsed.sources ?? [],
    knowledgeBases: parsed.knowledgeBases ?? [],
    bindings: parsed.bindings ?? [],
  }
}

interface MutateOptions {
  /** 调用方观察到的修订号；不匹配说明期间有其他写入 */
  expectedRevision?: number
}

/**
 * 以读取-修改-写入方式更新目录，并递增修订号。
 *
 * mutate 拿到的始终是磁盘上的最新快照，因此调用方不需要自己拼接整份目录。
 */
function mutateCatalog<T>(
  mutate: (current: CatalogFile) => { next: CatalogFile; result: T },
  options: MutateOptions = {},
): T {
  const current = readCatalog() as CatalogFile

  if (options.expectedRevision !== undefined && options.expectedRevision !== current.revision.revision) {
    throw new Error(
      `知识目录已被其他操作修改（期望修订号 ${options.expectedRevision}，当前 ${current.revision.revision}）。请重新加载后再试。`,
    )
  }

  const { next, result } = mutate({
    schemaVersion: current.schemaVersion,
    revision: current.revision,
    sources: [...current.sources],
    knowledgeBases: [...current.knowledgeBases],
    bindings: [...current.bindings],
  })

  next.revision = { revision: current.revision.revision + 1, updatedAt: new Date().toISOString() }
  writeFileAtomic(catalogPath(), JSON.stringify(next, null, 2))
  return result
}

// ===== 来源 =====

export interface CreateSourceInput {
  type: KnowledgeSourceType
  name: string
  locator: string
  scopePath?: string
  excludePatterns?: string[]
  enabled?: boolean
  legacyVaultId?: string
}

/**
 * 注册来源。
 *
 * 同一 locator 重复注册直接拒绝：静默合并会让两个不同用途的知识库共享
 * 索引，且用户看不到合并发生。需要复用同一目录时，应该把它加入已有来源
 * 所属的知识库成员列表，而不是新建来源。
 */
export function createSource(input: CreateSourceInput, options?: MutateOptions): KnowledgeSource {
  const locator = input.locator.trim()
  if (!locator) throw new Error('来源路径不能为空')

  return mutateCatalog((current) => {
    const duplicate = current.sources.find(
      (s) => s.locator === locator && (s.scopePath ?? '') === (input.scopePath?.trim() ?? ''),
    )
    if (duplicate) {
      throw new Error(`该位置已注册为来源「${duplicate.name}」: ${locator}`)
    }

    const source: KnowledgeSource = {
      id: randomUUID(),
      type: input.type,
      name: input.name.trim() || locator,
      locator,
      scopePath: input.scopePath?.trim() || undefined,
      excludePatterns: input.excludePatterns?.length ? [...input.excludePatterns] : undefined,
      enabled: input.enabled ?? true,
      createdAt: new Date().toISOString(),
      legacyVaultId: input.legacyVaultId,
    }
    return { next: { ...current, sources: [...current.sources, source] }, result: source }
  }, options)
}

export function listSources(): KnowledgeSource[] {
  return readCatalog().sources
}

export function updateSource(
  id: string,
  patch: Partial<Omit<KnowledgeSource, 'id' | 'createdAt'>>,
  options?: MutateOptions,
): KnowledgeSource {
  return mutateCatalog((current) => {
    const index = current.sources.findIndex((s) => s.id === id)
    if (index === -1) throw new Error(`来源不存在: ${id}`)

    // locator 变更会让已有索引指向错误位置，这里允许但要求调用方显式处理
    const updated: KnowledgeSource = { ...current.sources[index]!, ...patch, id, createdAt: current.sources[index]!.createdAt }
    const sources = [...current.sources]
    sources[index] = updated
    return { next: { ...current, sources }, result: updated }
  }, options)
}

export function deleteSource(id: string, options?: MutateOptions): void {
  mutateCatalog((current) => {
    if (!current.sources.some((s) => s.id === id)) throw new Error(`来源不存在: ${id}`)
    return {
      next: {
        ...current,
        // 同时从知识库成员中摘除，避免留下悬空引用
        sources: current.sources.filter((s) => s.id !== id),
        knowledgeBases: current.knowledgeBases.map((kb) => ({
          ...kb,
          sourceIds: kb.sourceIds.filter((sid) => sid !== id),
        })),
      },
      result: undefined,
    }
  }, options)
}

// ===== 知识库 =====

export interface CreateKnowledgeBaseInput {
  name: string
  description?: string
  sourceIds?: string[]
  enabled?: boolean
}

export function createKnowledgeBase(
  input: CreateKnowledgeBaseInput,
  options?: MutateOptions,
): KnowledgeBase {
  const name = input.name.trim()
  if (!name) throw new Error('知识库名称不能为空')

  return mutateCatalog((current) => {
    const sourceIds = input.sourceIds ?? []
    for (const sid of sourceIds) {
      if (!current.sources.some((s) => s.id === sid)) throw new Error(`来源不存在: ${sid}`)
    }

    const now = new Date().toISOString()
    const kb: KnowledgeBase = {
      id: randomUUID(),
      name,
      description: input.description?.trim() || undefined,
      sourceIds: [...sourceIds],
      enabled: input.enabled ?? true,
      createdAt: now,
      updatedAt: now,
    }
    return { next: { ...current, knowledgeBases: [...current.knowledgeBases, kb] }, result: kb }
  }, options)
}

export function listKnowledgeBases(): KnowledgeBase[] {
  return readCatalog().knowledgeBases
}

export function updateKnowledgeBase(
  id: string,
  patch: Partial<Omit<KnowledgeBase, 'id' | 'createdAt'>>,
  options?: MutateOptions,
): KnowledgeBase {
  return mutateCatalog((current) => {
    const index = current.knowledgeBases.findIndex((kb) => kb.id === id)
    if (index === -1) throw new Error(`知识库不存在: ${id}`)

    const sourceIds = patch.sourceIds ?? current.knowledgeBases[index]!.sourceIds
    for (const sid of sourceIds) {
      if (!current.sources.some((s) => s.id === sid)) throw new Error(`来源不存在: ${sid}`)
    }

    const updated: KnowledgeBase = {
      ...current.knowledgeBases[index]!,
      ...patch,
      sourceIds: [...sourceIds],
      id,
      createdAt: current.knowledgeBases[index]!.createdAt,
      updatedAt: new Date().toISOString(),
    }
    const knowledgeBases = [...current.knowledgeBases]
    knowledgeBases[index] = updated
    return { next: { ...current, knowledgeBases }, result: updated }
  }, options)
}

/**
 * 删除知识库。
 *
 * 存在 Project 关联时默认拒绝：用户以为在清理无用知识库，实际会让某个
 * Project 静默失去知识范围。必须显式 force 才继续。
 */
export function deleteKnowledgeBase(
  id: string,
  options: MutateOptions & { force?: boolean } = {},
): void {
  mutateCatalog((current) => {
    if (!current.knowledgeBases.some((kb) => kb.id === id)) throw new Error(`知识库不存在: ${id}`)

    const bound = current.bindings.filter((b) => b.knowledgeBaseId === id)
    if (bound.length > 0 && !options.force) {
      throw new Error(
        `知识库已被 Project 关联（${bound.length} 个）。解除关联后才能删除，或确认强制删除。`,
      )
    }

    return {
      next: {
        ...current,
        knowledgeBases: current.knowledgeBases.filter((kb) => kb.id !== id),
        bindings: current.bindings.filter((b) => b.knowledgeBaseId !== id),
      },
      result: undefined,
    }
  }, options)
}

/**
 * 列出知识库中真正可检索的来源。
 *
 * 知识库或来源任一被停用即不可检索 —— 这是权限与范围校验的输入，
 * 不能只看成员列表长度。
 */
export function listRetrievableSources(knowledgeBaseId: string): KnowledgeSource[] {
  const catalog = readCatalog()
  const kb = catalog.knowledgeBases.find((k) => k.id === knowledgeBaseId)
  if (!kb || !kb.enabled) return []

  return kb.sourceIds
    .map((sid) => catalog.sources.find((s) => s.id === sid))
    .filter((s): s is KnowledgeSource => s !== undefined && s.enabled)
}

// ===== Project 关联 =====

export interface BindProjectInput {
  projectId: string
  knowledgeBaseId: string
}

/**
 * 关联知识库到 Project。
 *
 * 幂等：重复关联同一组不报错也不产生重复记录，因为 UI 可能重试。
 */
export function bindProject(input: BindProjectInput, options?: MutateOptions): ProjectKnowledgeBinding {
  const projectId = input.projectId.trim()
  if (!projectId) throw new Error('Project ID 不能为空')

  return mutateCatalog((current) => {
    if (!current.knowledgeBases.some((kb) => kb.id === input.knowledgeBaseId)) {
      throw new Error(`知识库不存在: ${input.knowledgeBaseId}`)
    }

    const existing = current.bindings.find(
      (b) => b.projectId === projectId && b.knowledgeBaseId === input.knowledgeBaseId,
    )
    if (existing) return { next: current, result: existing }

    const binding: ProjectKnowledgeBinding = {
      id: randomUUID(),
      projectId,
      knowledgeBaseId: input.knowledgeBaseId,
      createdAt: new Date().toISOString(),
    }
    return { next: { ...current, bindings: [...current.bindings, binding] }, result: binding }
  }, options)
}

/** 解除关联。只改绑定关系，不删除知识库与任何文件。 */
export function unbindProject(input: BindProjectInput, options?: MutateOptions): boolean {
  return mutateCatalog((current) => {
    const filtered = current.bindings.filter(
      (b) => !(b.projectId === input.projectId && b.knowledgeBaseId === input.knowledgeBaseId),
    )
    return { next: { ...current, bindings: filtered }, result: filtered.length !== current.bindings.length }
  }, options)
}

export function listProjectBindings(projectId: string): ProjectKnowledgeBinding[] {
  return readCatalog().bindings.filter((b) => b.projectId === projectId)
}

/** Project 关联的知识库（含停用项，供 UI 展示状态） */
export function listProjectKnowledgeBases(projectId: string): KnowledgeBase[] {
  const catalog = readCatalog()
  return listProjectBindings(projectId)
    .map((b) => catalog.knowledgeBases.find((kb) => kb.id === b.knowledgeBaseId))
    .filter((kb): kb is KnowledgeBase => kb !== undefined)
}

// ===== 旧 Vault 迁移 =====

interface LegacyVault {
  id: string
  name: string
  path: string
  type: string
  enabled: boolean
}

/**
 * 把旧 vaults.json 迁移为 Source + 默认 KnowledgeBase。
 *
 * 迁移是幂等的：以 legacyVaultId 判定是否已迁移，因此应用重启、崩溃重跑
 * 都不会产生重复条目。旧文件原样保留，回滚旧版本应用仍然可用。
 */
export function migrateLegacyVaults(): { migrated: number; skipped: number } {
  if (!existsSync(legacyVaultsPath())) return { migrated: 0, skipped: 0 }

  let legacy: LegacyVault[]
  try {
    legacy = JSON.parse(readFileSync(legacyVaultsPath(), 'utf-8')) as LegacyVault[]
  } catch (err) {
    throw new Error(`旧 vaults.json 无法解析，迁移中止（原文件未改动）: ${legacyVaultsPath()}`, { cause: err })
  }
  if (!Array.isArray(legacy)) return { migrated: 0, skipped: 0 }

  const existing = readCatalog()
  const migratedIds = new Set(
    existing.sources.map((s) => s.legacyVaultId).filter((v): v is string => Boolean(v)),
  )

  let migrated = 0
  let skipped = 0
  for (const vault of legacy) {
    if (!vault?.id || !vault?.path) continue
    if (migratedIds.has(vault.id)) {
      skipped += 1
      continue
    }

    const source = createSource({
      type: vault.type === 'obsidian' ? 'vault' : 'vault',
      name: vault.name || vault.path,
      locator: vault.path,
      enabled: vault.enabled !== false,
      legacyVaultId: vault.id,
    })
    createKnowledgeBase({
      name: vault.name || vault.path,
      description: `由旧 Vault 迁移：${vault.path}`,
      sourceIds: [source.id],
      enabled: vault.enabled !== false,
    })
    migrated += 1
  }

  writeFileAtomic(
    migrationMarkerPath(),
    JSON.stringify({ migratedAt: new Date().toISOString(), migrated, skipped }, null, 2),
  )
  return { migrated, skipped }
}

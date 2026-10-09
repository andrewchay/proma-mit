/**
 * Skill 安装器：把审计通过的 skill 写入 workspace skills/，并记录外部来源。
 *
 * 写入位置：active `skills/<name>`（默认启用）；来源元数据写入 `.external-source.json`。
 * 复用 workspace 的 skill 目录约定（getWorkspaceSkillsDir），使 agent runtime 能直接读到。
 */

import { cpSync, rmSync, existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import type { SkillExternalSource } from '@gravitas/shared'
import { getWorkspaceSkillsDir, getInactiveSkillsDir } from '../../config-paths'

const EXTERNAL_SOURCE_FILE = '.external-source.json'

export interface InstallSkillInput {
  workspaceSlug: string
  /** 待安装 skill 目录（已审计） */
  sourceSkillDir: string
  /** 目标名称（复用 frontmatter.name 或目录名） */
  name: string
  /** 外部来源元数据 */
  externalSource: SkillExternalSource
  /** 是否默认启用（写 active 目录）；false=写 inactive 目录 */
  enabled?: boolean
  /** 人工确认放行：允许覆盖本地已漂移（stale）的旧版本 */
  force?: boolean
}

export interface InstallSkillResult {
  workspaceSlug: string
  skillSlug: string
  path: string
  enabled: boolean
  /** 同 rev 且内容未漂移时幂等跳过，未重写磁盘 */
  skipped?: boolean
}

function hashSkillMd(dir: string): string | undefined {
  const file = join(dir, 'SKILL.md')
  if (!existsSync(file)) return undefined
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

/**
 * C04 stale 检测：已安装版本的 SKILL.md 与安装时记录的 contentHash 不一致 → 本地已漂移。
 * 返回 null 表示无漂移；返回字符串表示漂移原因。旧数据无 contentHash 时无法检测，返回 undefined。
 */
export function detectSkillDrift(skillDir: string): string | null | undefined {
  const source = readExternalSource(skillDir)
  if (!source?.contentHash) return undefined
  const current = hashSkillMd(skillDir)
  if (current === undefined) return 'SKILL.md 缺失，无法核验与来源的一致性'
  if (current !== source.contentHash) return '本地 SKILL.md 已在安装后被修改（stale），覆盖将丢失本地改动'
  return null
}

/** 安装 skill 到 workspace。同 rev 且未漂移时幂等跳过；漂移时拒绝（除非 force）。 */
export function installSkillToWorkspace(input: InstallSkillInput): InstallSkillResult {
  const skillSlug = sanitizeSlug(input.name || input.sourceSkillDir.split('/').filter(Boolean).pop()!)
  const activeDir = getWorkspaceSkillsDir(input.workspaceSlug)
  const enabled = input.enabled !== false
  const targetRoot = enabled ? activeDir : getInactiveSkillsDir(input.workspaceSlug)
  const targetDir = join(targetRoot, skillSlug)

  if (existsSync(targetDir)) {
    const drift = detectSkillDrift(targetDir)
    const existing = readExternalSource(targetDir)
    if (drift) {
      if (!input.force) throw new Error(`拒绝覆盖 ${skillSlug}：${drift}；确认后使用 force 重试`)
    } else if (drift === null && existing?.rev === input.externalSource.rev) {
      // 幂等：同 rev 同内容重复安装不重写磁盘（重复批准/重试安全）
      return { workspaceSlug: input.workspaceSlug, skillSlug, path: targetDir, enabled, skipped: true }
    }
  }

  mkdirSync(targetRoot, { recursive: true })
  // 原子替换：先复制到临时目录再 rename（与 updateSkillFromSource 一致）
  const tmp = join(targetRoot, `.${skillSlug}.porting`)
  rmSync(tmp, { recursive: true, force: true })
  cpSync(input.sourceSkillDir, tmp, { recursive: true })
  rmSync(targetDir, { recursive: true, force: true })
  const { renameSync } = require('node:fs') as typeof import('node:fs')
  renameSync(tmp, targetDir)

  // 记录外部来源 + SKILL.md 内容哈希（漂移检测基线）
  const sourceWithHash: SkillExternalSource = { ...input.externalSource, contentHash: hashSkillMd(targetDir) }
  writeFileSync(join(targetDir, EXTERNAL_SOURCE_FILE), JSON.stringify(sourceWithHash, null, 2), 'utf-8')

  return { workspaceSlug: input.workspaceSlug, skillSlug, path: targetDir, enabled }
}

/** slug 安全化：只允许小写字母/数字/中划线/下划线/点。 */
function sanitizeSlug(name: string): string {
  const s = name.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
  if (!s) throw new Error('skill 名称无法生成合法 slug')
  return s
}

/** 读取某 skill 的外部来源元数据（供更新检查）。 */
export function readExternalSource(skillDir: string): SkillExternalSource | undefined {
  const p = join(skillDir, EXTERNAL_SOURCE_FILE)
  if (!existsSync(p)) return undefined
  try {
    return JSON.parse(require('node:fs').readFileSync(p, 'utf-8')) as SkillExternalSource
  } catch {
    return undefined
  }
}

/**
 * Skill 安装器：把审计通过的 skill 写入 workspace skills/，并记录外部来源。
 *
 * 写入位置：active `skills/<name>`（默认启用）；来源元数据写入 `.external-source.json`。
 * 复用 workspace 的 skill 目录约定（getWorkspaceSkillsDir），使 agent runtime 能直接读到。
 */

import { cpSync, rmSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
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
}

export interface InstallSkillResult {
  workspaceSlug: string
  skillSlug: string
  path: string
  enabled: boolean
}

/** 安装 skill 到 workspace。覆盖同 slug 的旧版本。 */
export function installSkillToWorkspace(input: InstallSkillInput): InstallSkillResult {
  const skillSlug = sanitizeSlug(input.name || input.sourceSkillDir.split('/').filter(Boolean).pop()!)
  const activeDir = getWorkspaceSkillsDir(input.workspaceSlug)
  const enabled = input.enabled !== false
  const targetRoot = enabled ? activeDir : getInactiveSkillsDir(input.workspaceSlug)
  const targetDir = join(targetRoot, skillSlug)

  mkdirSync(targetRoot, { recursive: true })
  // 原子替换：先复制到临时目录再 rename（与 updateSkillFromSource 一致）
  const tmp = join(targetRoot, `.${skillSlug}.porting`)
  rmSync(tmp, { recursive: true, force: true })
  cpSync(input.sourceSkillDir, tmp, { recursive: true })
  rmSync(targetDir, { recursive: true, force: true })
  const { renameSync } = require('node:fs') as typeof import('node:fs')
  renameSync(tmp, targetDir)

  // 记录外部来源（复用 .source.json 的写法，用独立文件名避免冲突）
  writeFileSync(join(targetDir, EXTERNAL_SOURCE_FILE), JSON.stringify(input.externalSource, null, 2), 'utf-8')

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

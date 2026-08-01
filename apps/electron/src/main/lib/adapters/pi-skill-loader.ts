/**
 * Pi Skill 加载器（借鉴上游 Proma：白名单过滤 + 按需展开）
 *
 * 职责：
 * - 让 Pi SDK 的 Skill 加载只保留 Proma 工作区 skills 目录内的条目（白名单过滤，防路径逃逸）
 * - 在 prompt 进入 session.prompt 之前，按需展开被请求的 Skill 全文
 *
 * 关键设计：
 * - `noSkills: true` 关闭 SDK 全盘扫描；`skillsOverride` 白名单过滤（realpath 防 symlink 逃逸）
 * - 只有被请求的 Skill（/skill:xxx 或 skillMentions）才展开全文，避免把所有 SKILL.md 塞进上下文
 */

import { readFileSync, lstatSync, realpathSync } from 'node:fs'
import { relative, resolve, dirname, basename } from 'node:path'
import type { ResourceLoader, Skill } from '@earendil-works/pi-coding-agent'

/** 用户在 prompt 中显式请求 Skill 的命令模式：/skill:xxx */
const SKILL_COMMAND_PATTERN = /\/skill:([A-Za-z0-9][A-Za-z0-9._-]*)/g

/** 判断 path 是否位于 root 内（解析 symlink 后，防止路径逃逸） */
function isPathWithinRoot(path: string, root: string): boolean {
  if (path === root) return true
  const rel = relative(root, path)
  return !!rel && !rel.startsWith('..') && !isAbsolutePath(rel)
}

function isAbsolutePath(path: string): boolean {
  return path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path)
}

function realpathIfExists(path: string): string | undefined {
  try {
    return realpathSync.native(path)
  } catch {
    return undefined
  }
}

function findNearestExistingPath(path: string): string | undefined {
  let current = path
  while (true) {
    try {
      lstatSync(current)
      return current
    } catch {
      const parent = dirname(current)
      if (parent === current) return undefined
      current = parent
    }
  }
}

/** 解析为真实路径（symlink 感知）；路径不存在时回退到最近存在的父目录 + 剩余尾部 */
function resolveGuardedRealPath(path: string): string {
  const resolved = resolve(path)
  const exact = realpathIfExists(resolved)
  if (exact) return exact

  const nearestExisting = findNearestExistingPath(resolved)
  if (!nearestExisting) return resolved

  const nearestReal = realpathIfExists(nearestExisting)
  if (!nearestReal) return resolved

  const tail = relative(nearestExisting, resolved)
  return tail ? resolve(nearestReal, tail) : nearestReal
}

/** 构建允许加载 Skill 的根目录列表（Proma 工作区 skills 目录，去重） */
export function buildAllowedSkillRoots(additionalSkillPaths: string[] | undefined): string[] {
  return (additionalSkillPaths ?? [])
    .map((path) => resolveGuardedRealPath(path))
    .filter((path, index, arr) => arr.indexOf(path) === index)
}

/** 判断 Skill 文件/目录是否位于允许的根目录内 */
export function isPromaSkillPath(path: string | undefined, allowedRoots: string[]): boolean {
  if (!path || allowedRoots.length === 0) return false
  const guardedPath = resolveGuardedRealPath(path)
  return allowedRoots.some((root) => isPathWithinRoot(guardedPath, root))
}

/** 让 Pi SDK 的 Skill 加载只保留 Proma 工作区 skills 目录内的条目（白名单过滤） */
export function createPromaSkillsOverride(additionalSkillPaths: string[] | undefined): (base: ReturnType<ResourceLoader['getSkills']>) => ReturnType<ResourceLoader['getSkills']> {
  const allowedRoots = buildAllowedSkillRoots(additionalSkillPaths)
  return (base) => ({
    skills: base.skills.filter((skill) =>
      isPromaSkillPath(skill.filePath, allowedRoots) || isPromaSkillPath(skill.baseDir, allowedRoots)),
    diagnostics: base.diagnostics.filter((diagnostic) => isPromaSkillPath(diagnostic.path, allowedRoots)),
  })
}

/** 剥离 SKILL.md frontmatter，仅保留正文 */
export function stripSkillFrontmatter(content: string): string {
  const normalized = content.replace(/^\uFEFF/, '')
  const frontmatter = normalized.match(/^---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)\s*(?:\r?\n|$)/)
  return frontmatter ? normalized.slice(frontmatter[0].length) : content
}

function escapeXmlAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/** Skill 的别名列表：skill 名 / 目录名 / 文件名（去重） */
export function skillCommandAliases(skill: Skill): string[] {
  const aliases = [skill.name, basename(skill.baseDir), basename(dirname(skill.filePath))]
  return aliases.filter((alias, index, arr) => Boolean(alias) && arr.indexOf(alias) === index)
}

/** 从 prompt 中提取 /skill:xxx 命令名 */
export function extractSkillCommandNames(prompt: string): string[] {
  const names: string[] = []
  const seen = new Set<string>()
  for (const match of prompt.matchAll(SKILL_COMMAND_PATTERN)) {
    const name = match[1]?.trim()
    if (!name || seen.has(name)) continue
    seen.add(name)
    names.push(name)
  }
  return names
}

/** 建立 Skill 别名查找表 */
export function buildSkillLookup(skills: Skill[]): Map<string, Skill> {
  const lookup = new Map<string, Skill>()
  for (const skill of skills) {
    for (const alias of skillCommandAliases(skill)) {
      if (!lookup.has(alias)) lookup.set(alias, skill)
    }
  }
  return lookup
}

/** 读取 SKILL.md 全文并包成 XML 块（供按需注入 prompt） */
export function formatSkillForPrompt(skill: Skill): string | undefined {
  try {
    const body = stripSkillFrontmatter(readFileSync(skill.filePath, 'utf-8')).trim()
    return `<skill name="${escapeXmlAttribute(skill.name)}" location="${escapeXmlAttribute(skill.filePath)}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>`
  } catch (error) {
    console.warn(`[Pi SDK] Skill 展开失败: ${skill.filePath}`, error)
    return undefined
  }
}

/**
 * 在 prompt 进入 session.prompt 之前，按需展开被请求的 Skill 全文。
 *
 * 优先使用显式 mentions（用户通过命令菜单/引用面板选择）；否则从 prompt 中
 * 正则提取 /skill:xxx。只有被请求的 Skill 才展开，避免把所有 SKILL.md 塞进上下文。
 */
export async function preparePromptWithPromaSkills(
  resourceLoader: ResourceLoader,
  prompt: string,
  explicitSkillNames?: string[],
): Promise<string> {
  await resourceLoader.reload()

  const requestedNames = explicitSkillNames?.length ? explicitSkillNames : extractSkillCommandNames(prompt)
  if (requestedNames.length === 0) return prompt

  const skillLookup = buildSkillLookup(resourceLoader.getSkills().skills)
  const blocks: string[] = []
  const injectedSkillNames = new Set<string>()

  for (const requestedName of requestedNames) {
    const skill = skillLookup.get(requestedName)
    if (!skill || injectedSkillNames.has(skill.name)) continue
    const block = formatSkillForPrompt(skill)
    if (!block) continue
    injectedSkillNames.add(skill.name)
    blocks.push(block)
  }

  if (blocks.length === 0) return prompt
  return `${blocks.join('\n\n')}\n\n${prompt}`
}

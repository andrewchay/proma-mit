/**
 * Skill 目录扫描与 frontmatter 校验。
 *
 * 在抓取解压的目录树里定位「含 SKILL.md 的 skill 目录」，并解析 frontmatter
 * （name/description/version）。frontmatter 规则：SKILL.md 首行 `---` 到下一个 `---`。
 */

import { readdirSync, readFileSync, existsSync, statSync, type Dirent } from 'node:fs'
import { join } from 'node:path'

export interface ParsedFrontmatter {
  name?: string
  description?: string
  version?: string
}

export interface LocatedSkill {
  /** skill 目录绝对路径（含 SKILL.md） */
  dir: string
  /** 目录名（作为 skill 身份候选） */
  slug: string
  frontmatter: ParsedFrontmatter
}

/** 递归扫描目录，返回所有含 SKILL.md 的 skill 目录（含根目录自身）。 */
export function findSkillDirs(root: string, maxDepth = 3): Promise<string[]> {
  const out: string[] = []
  if (existsSync(join(root, 'SKILL.md'))) out.push(root)
  const walk = (dir: string, depth: number): void => {
    if (depth > maxDepth) return
    let entries: Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue
      const sub = join(dir, e.name)
      if (existsSync(join(sub, 'SKILL.md'))) {
        out.push(sub)
      }
      walk(sub, depth + 1)
    }
  }
  walk(root, 1)
  return Promise.resolve(out)
}

/** 解析 SKILL.md 的 frontmatter（minimal，兼容 name/description/version 单行）。 */
export function parseSkillFrontmatter(content: string): ParsedFrontmatter {
  const fm = content.match(/^---\s*\n([\s\S]*?)\n---/)
  if (!fm?.[1]) return {}
  const out: ParsedFrontmatter = {}
  for (const line of fm[1].split('\n')) {
    const idx = line.indexOf(':')
    if (idx === -1) continue
    const key = line.slice(0, idx).trim()
    if (key !== 'name' && key !== 'description' && key !== 'version') continue
    out[key as keyof ParsedFrontmatter] = line.slice(idx + 1).trim().replace(/^['"]|['"]$/g, '')
  }
  return out
}

/** 把 skill 目录转换成 LocatedSkill。 */
export function locateSkill(dir: string): LocatedSkill {
  const content = readFileSync(join(dir, 'SKILL.md'), 'utf-8')
  return {
    dir,
    slug: dir.split('/').filter(Boolean).pop()!,
    frontmatter: parseSkillFrontmatter(content),
  }
}

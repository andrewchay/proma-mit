import { describe, expect, it } from 'bun:test'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { findSkillDirs, parseSkillFrontmatter, locateSkill } from './skill-scanner'

function makeTree(): string {
  const dir = join(tmpdir(), `scanner-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  mkdirSync(join(dir, 'repo', 'skills', 'web-search'), { recursive: true })
  writeFileSync(join(dir, 'repo', 'skills', 'web-search', 'SKILL.md'), '---\nname: web-search\ndescription: 搜索\ndescriptionv: 1\n---\n内容', 'utf-8')
  writeFileSync(join(dir, 'repo', 'SKILL.md'), '---\nname: root-skill\n---', 'utf-8')
  return dir
}

describe('skill-scanner', () => {
  it('递归扫描找到所有含 SKILL.md 的目录', async () => {
    const dir = makeTree()
    const found = await findSkillDirs(join(dir, 'repo'))
    expect(found.length).toBeGreaterThanOrEqual(2)
    expect(found.some((p) => p.endsWith('skills/web-search'))).toBe(true)
    expect(found.some((p) => p.endsWith('repo'))).toBe(true)
    rmSync(dir, { recursive: true, force: true })
  })

  it('parseSkillFrontmatter 解析 name/description/version', () => {
    const fm = parseSkillFrontmatter('---\nname: web-search\ndescription: "搜索工具"\nversion: 1.2.0\n---\nbody')
    expect(fm.name).toBe('web-search')
    expect(fm.description).toBe('搜索工具')
    expect(fm.version).toBe('1.2.0')
  })

  it('parseSkillFrontmatter 无 frontmatter 返回空对象', () => {
    expect(parseSkillFrontmatter('plain text')).toEqual({})
  })

  it('locateSkill 返回 slug + frontmatter', () => {
    const dir = makeTree()
    const located = locateSkill(join(dir, 'repo', 'skills', 'web-search'))
    expect(located.slug).toBe('web-search')
    expect(located.frontmatter.name).toBe('web-search')
    rmSync(dir, { recursive: true, force: true })
  })
})

import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { installSkillToWorkspace } from './skill-installer'
import { getWorkspaceSkillsDir, getInactiveSkillsDir } from '../../config-paths'

const testDir = join(tmpdir(), `gravitas-skill-install-${Date.now()}`)

beforeAll(() => {
  process.env.PROMA_TEST_CONFIG_DIR = testDir
  mkdirSync(join(testDir, 'agent-workspaces', 'ws1'), { recursive: true })
})

afterAll(() => {
  delete process.env.PROMA_TEST_CONFIG_DIR
  try {
    rmSync(testDir, { recursive: true, force: true })
  } catch {
    // 忽略
  }
})

function makeSourceSkill(name: string): string {
  const dir = join(testDir, `src-${name}`)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\n---\nbody`, 'utf-8')
  return dir
}

describe('skill-installer', () => {
  it('安装到 active skills/ 并写 .external-source.json', () => {
    const src = makeSourceSkill('web-scraper')
    const external = {
      kind: 'github' as const,
      repo: 'acme/web-tools',
      subdir: 'skills/web-scraper',
      rev: 'abc123',
      originalSpec: 'acme/web-tools@abc123',
      importedAt: '2026-08-17T00:00:00Z',
    }
    const result = installSkillToWorkspace({
      workspaceSlug: 'ws1',
      sourceSkillDir: src,
      name: 'web-scraper',
      externalSource: external,
      enabled: true,
    })
    expect(result.skillSlug).toBe('web-scraper')
    const targetDir = join(getWorkspaceSkillsDir('ws1'), 'web-scraper')
    expect(existsSync(targetDir)).toBe(true)
    expect(existsSync(join(targetDir, 'SKILL.md'))).toBe(true)
    const meta = JSON.parse(readFileSync(join(targetDir, '.external-source.json'), 'utf-8'))
    expect(meta.repo).toBe('acme/web-tools')
    expect(meta.rev).toBe('abc123')
    expect(meta.kind).toBe('github')
    rmSync(src, { recursive: true, force: true })
  })

  it('enabled=false 安装到 inactive', () => {
    const src = makeSourceSkill('inactive-skill')
    const result = installSkillToWorkspace({
      workspaceSlug: 'ws1',
      sourceSkillDir: src,
      name: 'inactive-skill',
      externalSource: { kind: 'raw', rev: 'HEAD', originalSpec: 'x', importedAt: '' },
      enabled: false,
    })
    expect(result.enabled).toBe(false)
    expect(existsSync(join(getInactiveSkillsDir('ws1'), 'inactive-skill', 'SKILL.md'))).toBe(true)
    rmSync(src, { recursive: true, force: true })
  })

  it('同 slug 覆盖旧版本（原子替换）', () => {
    const src1 = makeSourceSkill('dup-skill')
    installSkillToWorkspace({ workspaceSlug: 'ws1', sourceSkillDir: src1, name: 'dup-skill', externalSource: { kind: 'github', rev: 'v1', originalSpec: 'a', importedAt: '' } })
    const src2 = makeSourceSkill('dup-skill') // 同名不同内容
    writeFileSync(join(src2, 'SKILL.md'), 'updated', 'utf-8')
    installSkillToWorkspace({ workspaceSlug: 'ws1', sourceSkillDir: src2, name: 'dup-skill', externalSource: { kind: 'github', rev: 'v2', originalSpec: 'b', importedAt: '' } })
    expect(readFileSync(join(getWorkspaceSkillsDir('ws1'), 'dup-skill', 'SKILL.md'), 'utf-8')).toBe('updated')
    rmSync(src1, { recursive: true, force: true })
    rmSync(src2, { recursive: true, force: true })
  })
})

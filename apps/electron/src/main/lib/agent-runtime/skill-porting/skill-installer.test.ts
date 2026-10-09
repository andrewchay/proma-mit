import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs'
import { installSkillToWorkspace, detectSkillDrift } from './skill-installer'
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

  describe('C04 版本/来源/恢复', () => {
    const external = (rev: string) => ({
      kind: 'github' as const,
      repo: 'acme/tools',
      rev,
      originalSpec: `acme/tools@${rev}`,
      importedAt: '2026-10-09T00:00:00Z',
    })

    it('安装时记录 SKILL.md contentHash；同 rev 未漂移重复安装幂等跳过', () => {
      const src = makeSourceSkill('hash-skill')
      const first = installSkillToWorkspace({ workspaceSlug: 'ws1', sourceSkillDir: src, name: 'hash-skill', externalSource: external('r1') })
      expect(first.skipped).toBeUndefined()
      const meta = JSON.parse(readFileSync(join(getWorkspaceSkillsDir('ws1'), 'hash-skill', '.external-source.json'), 'utf-8'))
      expect(typeof meta.contentHash).toBe('string')
      expect(meta.contentHash).toHaveLength(64)
      const before = readFileSync(join(getWorkspaceSkillsDir('ws1'), 'hash-skill', '.external-source.json'), 'utf-8')
      const second = installSkillToWorkspace({ workspaceSlug: 'ws1', sourceSkillDir: src, name: 'hash-skill', externalSource: external('r1') })
      expect(second.skipped).toBe(true)
      expect(readFileSync(join(getWorkspaceSkillsDir('ws1'), 'hash-skill', '.external-source.json'), 'utf-8')).toBe(before)
    })

    it('本地漂移（stale）拒绝覆盖；force 放行并刷新基线', () => {
      const src = makeSourceSkill('drift-skill')
      installSkillToWorkspace({ workspaceSlug: 'ws1', sourceSkillDir: src, name: 'drift-skill', externalSource: external('r1') })
      const target = join(getWorkspaceSkillsDir('ws1'), 'drift-skill')
      writeFileSync(join(target, 'SKILL.md'), '---\nname: drift-skill\n---\n本地改动', 'utf-8')
      expect(detectSkillDrift(target)).toContain('stale')
      const src2 = makeSourceSkill('drift-skill-2')
      expect(() => installSkillToWorkspace({ workspaceSlug: 'ws1', sourceSkillDir: src2, name: 'drift-skill', externalSource: external('r2') })).toThrow(/拒绝覆盖/)
      expect(readFileSync(join(target, 'SKILL.md'), 'utf-8')).toContain('本地改动')
      const forced = installSkillToWorkspace({ workspaceSlug: 'ws1', sourceSkillDir: src2, name: 'drift-skill', externalSource: external('r2'), force: true })
      expect(forced.skipped).toBeUndefined()
      expect(detectSkillDrift(target)).toBeNull()
    })

    it('旧数据无 contentHash 时 drift 检测返回 undefined（无法检测，不阻止更新）', () => {
      const src = makeSourceSkill('legacy-skill')
      installSkillToWorkspace({ workspaceSlug: 'ws1', sourceSkillDir: src, name: 'legacy-skill', externalSource: external('r1') })
      const target = join(getWorkspaceSkillsDir('ws1'), 'legacy-skill')
      const metaPath = join(target, '.external-source.json')
      const meta = JSON.parse(readFileSync(metaPath, 'utf-8'))
      delete meta.contentHash
      writeFileSync(metaPath, JSON.stringify(meta), 'utf-8')
      expect(detectSkillDrift(target)).toBeUndefined()
    })

    it('slug 拒绝路径穿越；安装只写 skills 目录', () => {
      const src = makeSourceSkill('evil')
      expect(() => installSkillToWorkspace({ workspaceSlug: 'ws1', sourceSkillDir: src, name: '../../escape', externalSource: external('r1') })).not.toThrow()
      // sanitizeSlug 会把 ../ 规整为合法 slug，绝不逃逸出 skills 目录
      const skillsRoot = getWorkspaceSkillsDir('ws1')
      expect(existsSync(join(testDir, 'escape'))).toBe(false)
      expect(readdirSync(skillsRoot).some((name) => name.includes('escape'))).toBe(true)
    })
  })
})

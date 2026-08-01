import { describe, expect, test, afterAll } from 'bun:test'
import { mkdirSync, writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { ResourceLoader, Skill } from '@earendil-works/pi-coding-agent'
import {
  buildAllowedSkillRoots,
  buildSkillLookup,
  createPromaSkillsOverride,
  extractSkillCommandNames,
  formatSkillForPrompt,
  isPromaSkillPath,
  preparePromptWithPromaSkills,
  skillCommandAliases,
  stripSkillFrontmatter,
} from './pi-skill-loader'

function makeSkill(overrides: Partial<Skill> = {}): Skill {
  return {
    name: 'test-skill',
    description: '测试 Skill',
    filePath: '/ws/skills/test-skill/SKILL.md',
    baseDir: '/ws/skills/test-skill',
    sourceInfo: { path: '/ws/skills/test-skill/SKILL.md', source: 'test', scope: 'temporary', origin: 'top-level' },
    disableModelInvocation: false,
    ...overrides,
  }
}

describe('stripSkillFrontmatter', () => {
  test('given frontmatter then removes it', () => {
    const content = '---\nname: test\ndescription: hello\n---\n\n# 正文\n内容'
    expect(stripSkillFrontmatter(content)).toBe('# 正文\n内容')
  })

  test('given content without frontmatter then returns unchanged', () => {
    const content = '# 纯正文'
    expect(stripSkillFrontmatter(content)).toBe(content)
  })

  test('given BOM + frontmatter then strips BOM and frontmatter', () => {
    const content = '\uFEFF---\nname: test\n---\n\n正文'
    expect(stripSkillFrontmatter(content)).toBe('正文')
  })
})

describe('extractSkillCommandNames', () => {
  test('given /skill:xxx patterns then extracts unique names', () => {
    expect(extractSkillCommandNames('调用 /skill:code-review 然后 /skill:bug-hunt'))
      .toEqual(['code-review', 'bug-hunt'])
  })

  test('given duplicate names then dedupes', () => {
    expect(extractSkillCommandNames('/skill:same /skill:same')).toEqual(['same'])
  })

  test('given no skill patterns then returns empty', () => {
    expect(extractSkillCommandNames('普通消息')).toEqual([])
  })

  test('given invalid names then ignores', () => {
    expect(extractSkillCommandNames('/skill:')).toEqual([])
  })
})

describe('skillCommandAliases', () => {
  test('given skill then returns name, baseDir, filePath dir aliases deduped', () => {
    const skill = makeSkill({
      name: 'my-skill',
      baseDir: '/ws/skills/my-skill',
      filePath: '/ws/skills/my-skill/SKILL.md',
    })
    expect(skillCommandAliases(skill)).toContain('my-skill')
    // baseDir 和 dirname(filePath) 相同 → 去重后只出现一次
    expect(skillCommandAliases(skill).filter((a) => a === 'my-skill')).toHaveLength(1)
  })
})

describe('buildSkillLookup', () => {
  test('given skills then maps by aliases', () => {
    const skill = makeSkill({ name: 'alpha', baseDir: '/ws/skills/alpha', filePath: '/ws/skills/alpha/SKILL.md' })
    const lookup = buildSkillLookup([skill])
    expect(lookup.get('alpha')).toBe(skill)
  })
})

describe('isPromaSkillPath / buildAllowedSkillRoots / createPromaSkillsOverride', () => {
  const wsSkillsDir = join(tmpdir(), 'proma-skill-test-ws')
  mkdirSync(wsSkillsDir, { recursive: true })

  test('given path inside allowed root then returns true', () => {
    const roots = buildAllowedSkillRoots([wsSkillsDir])
    expect(isPromaSkillPath(join(wsSkillsDir, 'foo/SKILL.md'), roots)).toBe(true)
  })

  test('given path outside allowed root then returns false', () => {
    const roots = buildAllowedSkillRoots([wsSkillsDir])
    expect(isPromaSkillPath('/tmp/other/SKILL.md', roots)).toBe(false)
  })

  test('given no allowed roots then always false', () => {
    expect(isPromaSkillPath('/ws/skills/foo/SKILL.md', [])).toBe(false)
  })

  test('override filters skills and diagnostics to allowed roots only', () => {
    const inside = makeSkill({
      name: 'inside',
      filePath: join(wsSkillsDir, 'inside/SKILL.md'),
      baseDir: join(wsSkillsDir, 'inside'),
    })
    const outside = makeSkill({
      name: 'outside',
      filePath: '/tmp/outside/SKILL.md',
      baseDir: '/tmp/outside',
    })
    const override = createPromaSkillsOverride([wsSkillsDir])
    const result = override({
      skills: [inside, outside],
      diagnostics: [
        { path: join(wsSkillsDir, 'inside/SKILL.md'), message: 'ok', type: 'warning' },
        { path: '/tmp/outside/SKILL.md', message: 'bad', type: 'error' },
      ],
    })
    expect(result.skills.map((s) => s.name)).toEqual(['inside'])
    expect(result.diagnostics.map((d) => d.path)).toEqual([join(wsSkillsDir, 'inside/SKILL.md')])
  })

  afterAll(() => {
    if (existsSync(wsSkillsDir)) rmSync(wsSkillsDir, { recursive: true, force: true })
  })
})

describe('formatSkillForPrompt', () => {
  const projectDir = mkdtempSync(join(tmpdir(), 'proma-skill-fmt-'))
  afterAll(() => {
    if (existsSync(projectDir)) rmSync(projectDir, { recursive: true, force: true })
  })

  test('given skill file then wraps body in XML with frontmatter stripped', () => {
    const skillDir = join(projectDir, 'demo-skill')
    mkdirSync(skillDir, { recursive: true })
    const skillPath = join(skillDir, 'SKILL.md')
    writeFileSync(skillPath, '---\nname: demo-skill\n---\n\n# Demo\n方法说明', 'utf-8')
    const skill = makeSkill({
      name: 'demo-skill',
      filePath: skillPath,
      baseDir: skillDir,
    })
    const block = formatSkillForPrompt(skill)
    expect(block).toContain('<skill name="demo-skill"')
    expect(block).toContain('# Demo')
    expect(block).toContain('方法说明')
    expect(block).not.toContain('---\nname: demo-skill')
  })

  test('given missing file then returns undefined', () => {
    const skill = makeSkill({ filePath: '/nonexistent/SKILL.md', baseDir: '/nonexistent' })
    expect(formatSkillForPrompt(skill)).toBeUndefined()
  })
})

describe('preparePromptWithPromaSkills', () => {
  const projectDir = mkdtempSync(join(tmpdir(), 'proma-skill-prep-'))
  afterAll(() => {
    if (existsSync(projectDir)) rmSync(projectDir, { recursive: true, force: true })
  })

  function makeLoader(skills: Skill[]): ResourceLoader {
    return {
      getSkills: () => ({ skills, diagnostics: [] }),
      reload: async () => {},
    } as unknown as ResourceLoader
  }

  function makeSkillFile(name: string, body: string): Skill {
    const skillDir = join(projectDir, name)
    mkdirSync(skillDir, { recursive: true })
    const skillPath = join(skillDir, 'SKILL.md')
    writeFileSync(skillPath, `---\nname: ${name}\n---\n\n${body}`, 'utf-8')
    return makeSkill({ name, filePath: skillPath, baseDir: skillDir })
  }

  test('given explicit skillMentions then injects only those skills', async () => {
    const skillA = makeSkillFile('skill-a', '方法 A 内容')
    const skillB = makeSkillFile('skill-b', '方法 B 内容')
    const loader = makeLoader([skillA, skillB])

    const result = await preparePromptWithPromaSkills(loader, '帮我完成任务', ['skill-a'])
    expect(result).toContain('方法 A 内容')
    expect(result).not.toContain('方法 B 内容')
    expect(result).toContain('帮我完成任务')
  })

  test('given no mentions and no /skill: pattern then returns prompt unchanged', async () => {
    const skill = makeSkillFile('skill-c', '内容')
    const loader = makeLoader([skill])
    const result = await preparePromptWithPromaSkills(loader, '普通消息')
    expect(result).toBe('普通消息')
  })

  test('given /skill:xxx in prompt then expands from regex', async () => {
    const skill = makeSkillFile('skill-d', '正则命中内容')
    const loader = makeLoader([skill])
    const result = await preparePromptWithPromaSkills(loader, '请调用 /skill:skill-d 处理')
    expect(result).toContain('正则命中内容')
  })

  test('given unknown skill mention then returns prompt unchanged', async () => {
    const loader = makeLoader([])
    const result = await preparePromptWithPromaSkills(loader, '处理一下', ['unknown-skill'])
    expect(result).toBe('处理一下')
  })
})

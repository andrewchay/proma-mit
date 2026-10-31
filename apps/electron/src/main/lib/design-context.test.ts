/**
 * OpenDesign 设计上下文注入（design-context）单元测试
 *
 * 验证 od: frontmatter 解析、craft 节加载、激活设计系统探测与组合输出，
 * 以及 ReadSkill 工具的注入接线。
 * 使用 PROMA_TEST_CONFIG_DIR 隔离配置目录，避免写入真实配置。
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdirSync, writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  parseOdRequirements,
  loadCraftSections,
  resolveActiveDesignSystem,
  composeOdDesignContext,
  resolveDesignCraftDir,
} from './design-context'
import { getWorkspaceSkillsDir, getDefaultSkillsDir } from './config-paths'
import { executeSkillTool } from './agent-runtime/tool-impls/skill-tool'
import { bindTestToolContext } from './testing/bound-tool-context'

// 测试经 getWorkspaceSkillsDir 闭包注入工作区 skills 目录（见 resolveDesignCraftDir 调用处）

// ===== 测试隔离（遵守工作区硬规则：测试禁止写入 ~/.gravitas/）=====

const tempHomeDir = mkdtempSync(join(tmpdir(), 'proma-design-context-test-'))
process.env.PROMA_TEST_CONFIG_DIR = join(tempHomeDir, '.proma-mit')
process.env.PROMA_DEV = '1'

const WORKSPACE_SLUG = 'design-ws'
const skillsDir = join(process.env.PROMA_TEST_CONFIG_DIR, 'agent-workspaces', WORKSPACE_SLUG, 'skills')

function setupWorkspace(): void {
  // 工作区内的 design-craft 副本（最高优先级来源）
  const refs = join(skillsDir, 'design-craft', 'references')
  mkdirSync(refs, { recursive: true })
  writeFileSync(join(refs, 'typography.md'), '# Typography rules\n\nALL CAPS needs >= 0.06em tracking.\n', 'utf-8')
  writeFileSync(join(refs, 'color.md'), '# Color rules\n\nAccent used on <= 10% of surface.\n', 'utf-8')
  writeFileSync(join(refs, 'anti-ai-slop.md'), '# Anti-slop\n\nNo default Tailwind indigo #6366f1.\n', 'utf-8')

  // 声明 od: 的 Skill（内联数组 + design_system.requires: true）
  mkdirSync(join(skillsDir, 'frontend-design'), { recursive: true })
  writeFileSync(
    join(skillsDir, 'frontend-design', 'SKILL.md'),
    [
      '---',
      'name: frontend-design',
      'version: 1.0.0',
      'description: |',
      '  Create distinctive production-grade frontend interfaces.',
      'od:',
      '  mode: prototype',
      '  craft:',
      '    requires: [typography, color, anti-ai-slop, motion]',
      '  design_system:',
      '    requires: true',
      '---',
      '',
      '# frontend-design body',
      '',
      'Build production-grade UI.',
      '',
    ].join('\n'),
    'utf-8',
  )

  // 无 od: 声明的普通 Skill
  mkdirSync(join(skillsDir, 'plain-skill'), { recursive: true })
  writeFileSync(join(skillsDir, 'plain-skill', 'SKILL.md'), '---\nname: plain-skill\nversion: 1.0.0\ndescription: 普通技能\n---\n\n正文\n', 'utf-8')
}

setupWorkspace()

beforeAll(async () => { await (await import('./project-sqlite-store')).initProjectDb() })

afterAll(async () => {
  (await import('./project-sqlite-store')).closeProjectDb()
  if (existsSync(tempHomeDir)) rmSync(tempHomeDir, { recursive: true, force: true })
  delete process.env.PROMA_TEST_CONFIG_DIR
})

describe('parseOdRequirements', () => {
  test('Given 内联数组 requires When 解析 Then 提取去重的 craft 节与 design_system 布尔', () => {
    const md = [
      '---',
      'name: x',
      'od:',
      '  mode: prototype',
      '  craft:',
      '    requires: [typography, color, typography, motion]',
      '  design_system:',
      '    requires: true',
      '---',
      'body',
    ].join('\n')
    const req = parseOdRequirements(md)
    expect(req.craftRequires).toEqual(['typography', 'color', 'motion'])
    expect(req.designSystemRequires).toBe(true)
  })

  test('Given 列表形式 requires When 解析 Then 同样提取', () => {
    const md = [
      '---',
      'name: x',
      'od:',
      '  craft:',
      '    requires:',
      '      - typography',
      '      - anti-ai-slop',
      '---',
      'body',
    ].join('\n')
    const req = parseOdRequirements(md)
    expect(req.craftRequires).toEqual(['typography', 'anti-ai-slop'])
    expect(req.designSystemRequires).toBe(false)
  })

  test('Given 无 od: 块或空 frontmatter When 解析 Then 降级为空声明', () => {
    expect(parseOdRequirements('---\nname: x\ndescription: y\n---\nbody').craftRequires).toEqual([])
    expect(parseOdRequirements('---\nname: x\nod:\n  mode: prototype\n---\nbody').designSystemRequires).toBe(false)
    expect(parseOdRequirements('没有 frontmatter').craftRequires).toEqual([])
  })

  test('Given od: 后还有其他顶层键 When 解析 Then 只采集 od: 块内内容', () => {
    const md = ['---', 'name: x', 'od:', '  craft:', '    requires: [color]', 'license: MIT', '---', 'body'].join('\n')
    expect(parseOdRequirements(md).craftRequires).toEqual(['color'])
  })
})

describe('loadCraftSections', () => {
  test('Given craft 目录与请求节 When 加载 Then 输出 ### 标头与 --- 分隔', () => {
    const refs = join(skillsDir, 'design-craft', 'references')
    const { body, sections } = loadCraftSections(refs, ['typography', 'color'])
    expect(sections).toEqual(['typography', 'color'])
    expect(body).toContain('### typography')
    expect(body).toContain('### color')
    expect(body).toContain('---\n\n### color')
    expect(body).toContain('ALL CAPS needs >= 0.06em tracking.')
  })

  test('Given 前向引用不存在的节 When 加载 Then 静默跳过不报错', () => {
    const refs = join(skillsDir, 'design-craft', 'references')
    const { body, sections } = loadCraftSections(refs, ['typography', 'not-yet-shipped'])
    expect(sections).toEqual(['typography'])
    expect(body).not.toContain('not-yet-shipped')
  })

  test('Given 目录缺失 When 加载 Then 返回空且不抛错', () => {
    const { body, sections } = loadCraftSections('/nonexistent/craft', ['typography'])
    expect(body).toBe('')
    expect(sections).toEqual([])
  })
})

describe('resolveActiveDesignSystem', () => {
  test('Given cwd 存在 DESIGN.md 与 tokens.css When 解析 Then 返回标题、正文与令牌', () => {
    const cwd = join(tempHomeDir, 'ds-project')
    mkdirSync(cwd, { recursive: true })
    writeFileSync(join(cwd, 'DESIGN.md'), '# Design System Inspired by Stripe\n\nWeight 300 headlines.\n', 'utf-8')
    writeFileSync(join(cwd, 'tokens.css'), ':root { --accent: #533afd; }\n', 'utf-8')

    const ds = resolveActiveDesignSystem(cwd)
    expect(ds?.title).toBe('Design System Inspired by Stripe')
    expect(ds?.body).toContain('Weight 300 headlines.')
    expect(ds?.tokensCss).toContain('--accent: #533afd')
  })

  test('Given 无 DESIGN.md When 解析 Then 返回 undefined（零开销降级）', () => {
    expect(resolveActiveDesignSystem(join(tempHomeDir, 'no-ds'))).toBeUndefined()
    expect(resolveActiveDesignSystem(undefined)).toBeUndefined()
  })

  test('Given 只有 DESIGN.md 无 tokens.css When 解析 Then 正文可用且 tokens 为空', () => {
    const cwd = join(tempHomeDir, 'ds-only')
    mkdirSync(cwd, { recursive: true })
    writeFileSync(join(cwd, 'DESIGN.md'), '# Plain\n\nBody.\n', 'utf-8')
    const ds = resolveActiveDesignSystem(cwd)
    expect(ds?.body).toContain('Body.')
    expect(ds?.tokensCss).toBeUndefined()
  })
})

describe('resolveDesignCraftDir', () => {
  test('Given 工作区副本存在 When 解析 Then 优先工作区目录', () => {
    const dir = resolveDesignCraftDir({
      workspaceSlug: WORKSPACE_SLUG,
      getWorkspaceSkillsDir: () => skillsDir,
      getDefaultSkillsDir: () => join(tempHomeDir, 'empty-default-skills'),
    })
    expect(dir).toBe(join(skillsDir, 'design-craft', 'references'))
  })

  test('Given 工作区无副本、用户 default-skills 有 When 解析 Then 回退用户目录', () => {
    const userDir = join(tempHomeDir, 'user-default-skills')
    mkdirSync(join(userDir, 'design-craft', 'references'), { recursive: true })
    writeFileSync(join(userDir, 'design-craft', 'references', 'typography.md'), '# fallback\n', 'utf-8')
    const dir = resolveDesignCraftDir({
      getWorkspaceSkillsDir: () => join(tempHomeDir, 'missing-ws-skills'),
      getDefaultSkillsDir: () => userDir,
    })
    expect(dir).toBe(join(userDir, 'design-craft', 'references'))
  })
})

describe('composeOdDesignContext', () => {
  test('Given craft + design_system 需求且 cwd 有激活设计系统 When 组合 Then 按序输出两个块', () => {
    const cwd = join(tempHomeDir, 'ds-compose')
    mkdirSync(cwd, { recursive: true })
    writeFileSync(join(cwd, 'DESIGN.md'), '# Stripe style\n\nNavy headings.\n', 'utf-8')
    writeFileSync(join(cwd, 'tokens.css'), ':root { --accent: #533afd; }\n', 'utf-8')
    const refs = join(skillsDir, 'design-craft', 'references')

    const out = composeOdDesignContext({
      requirements: { craftRequires: ['color'], designSystemRequires: true },
      craftDir: refs,
      cwd,
    })

    const dsIdx = out.indexOf('<od_design_system')
    const craftIdx = out.indexOf('<od_craft')
    expect(dsIdx).toBeGreaterThanOrEqual(0)
    expect(craftIdx).toBeGreaterThan(dsIdx)
    expect(out).toContain('Navy headings.')
    expect(out).toContain('```css')
    expect(out).toContain('--accent: #533afd')
    expect(out).toContain('### color')
    expect(out).toContain('the brand wins for token values')
    expect(out).not.toContain('<od_missing_resource type="craft"')
  })

  test('Given 无 od: 声明 When 组合 Then 返回空字符串', () => {
    const out = composeOdDesignContext({ requirements: { craftRequires: [], designSystemRequires: false }, cwd: tempHomeDir })
    expect(out).toBe('')
  })

  test('Given design_system 需求但 cwd 无 DESIGN.md When 组合 Then 设计系统块缺席、其余照常', () => {
    const refs = join(skillsDir, 'design-craft', 'references')
    const out = composeOdDesignContext({
      requirements: { craftRequires: ['color'], designSystemRequires: true },
      craftDir: refs,
      cwd: join(tempHomeDir, 'no-ds-here'),
    })
    expect(out).not.toContain('<od_design_system')
    expect(out).toContain('<od_craft')
    expect(out).toContain('缺少可用的 DESIGN.md')
  })

  test('Given craft 目录缺失 When 组合 Then 显示所需工艺资料缺项', () => {
    const out = composeOdDesignContext({
      requirements: { craftRequires: ['typography'], designSystemRequires: false },
      craftDir: undefined,
    })
    expect(out).toContain('<od_missing_resource type="craft"')
    expect(out).toContain('typography')
  })

  test('Given 部分工艺资料缺失 When 组合 Then 保留已有内容并指出缺少的节', () => {
    const refs = join(skillsDir, 'design-craft', 'references')
    const out = composeOdDesignContext({ requirements: { craftRequires: ['color', 'motion'], designSystemRequires: false }, craftDir: refs })
    expect(out).toContain('### color')
    expect(out).toContain('<od_missing_resource type="craft"')
    expect(out).toContain('motion')
  })
})

describe('ReadSkill 工具接线', () => {
  const skillCtx = (cwd: string, sessionId: string) => bindTestToolContext({ cwd, sessionId, workspaceSlug: WORKSPACE_SLUG })

  test('Given 同一会话切换设计系统 When 再次读取 Skill Then 使用当前品牌与令牌', async () => {
    const cwd = join(tempHomeDir, 'brand-refresh')
    mkdirSync(cwd, { recursive: true })
    writeFileSync(join(cwd, 'DESIGN.md'), '# Brand A\nOld brand')
    writeFileSync(join(cwd, 'tokens.css'), ':root { --brand: red; }')
    const ctx = skillCtx(cwd, 'same-session')
    expect((await executeSkillTool({ skill_slug: 'frontend-design' }, ctx)).content).toContain('Brand A')
    writeFileSync(join(cwd, 'DESIGN.md'), '# Brand B\nNew brand')
    writeFileSync(join(cwd, 'tokens.css'), ':root { --brand: blue; }')
    const updated = await executeSkillTool({ skill_slug: 'frontend-design' }, ctx)
    expect(updated.content).toContain('Brand B')
    expect(updated.content).toContain('--brand: blue')
    expect(updated.content).not.toContain('Brand A')
  })

  test('Given Skill 要求设计系统而工作区缺少 DESIGN.md When 读取 Then 明确提示缺项', async () => {
    const cwd = join(tempHomeDir, 'brand-missing')
    mkdirSync(cwd, { recursive: true })
    const result = await executeSkillTool({ skill_slug: 'frontend-design' }, skillCtx(cwd, 'missing'))
    expect(result.content).toContain('缺少可用的 DESIGN.md')
  })
  test('Given 声明 od: 的 Skill When 读取 SKILL.md Then 工具结果附带注入上下文', async () => {
    const cwd = join(tempHomeDir, 'ds-tool')
    mkdirSync(cwd, { recursive: true })
    writeFileSync(join(cwd, 'DESIGN.md'), '# Tool DS\n\nTokens here.\n', 'utf-8')

    const result = await executeSkillTool(
      { skill_slug: 'frontend-design' },
      skillCtx(cwd, 's1'),
    )
    expect(result.isError).toBeFalsy()
    expect(result.content).toContain('# frontend-design body')
    expect(result.content).toContain('<od_design_system')
    expect(result.content).toContain('### typography')
    expect(result.content).toContain('### anti-ai-slop')
    expect(result.content).toContain('<od_missing_resource type="craft"')
    expect(result.content).toContain('motion')
  })

  test('Given 读取子文件 When 读取 Then 不重复注入 od: 上下文', async () => {
    const subPath = join(skillsDir, 'frontend-design', 'guide.md')
    writeFileSync(subPath, '# guide\nsub content', 'utf-8')
    const result = await executeSkillTool(
      { skill_slug: 'frontend-design', file_path: 'guide.md' },
      skillCtx(tempHomeDir, 's1'),
    )
    expect(result.isError).toBeFalsy()
    expect(result.content).toContain('sub content')
    expect(result.content).not.toContain('<od_design_system')
  })

  test('Given 无 od: 声明的 Skill When 读取 Then 结果与正文一致', async () => {
    const result = await executeSkillTool(
      { skill_slug: 'plain-skill' },
      skillCtx(tempHomeDir, 's1'),
    )
    expect(result.isError).toBeFalsy()
    expect(result.content).not.toContain('<od_design_system')
    expect(result.content).not.toContain('<od_craft')
  })
})

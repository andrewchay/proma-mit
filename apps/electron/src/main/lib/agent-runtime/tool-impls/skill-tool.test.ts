/**
 * ReadSkill 工具单元测试
 *
 * 验证 skill 读取、路径越界拒绝、无工作区会话拒绝、缺失文件报错。
 * 使用 PROMA_TEST_CONFIG_DIR 隔离配置目录，避免污染本机与其他测试的 HOME mock。
 */

import { describe, test, expect, afterAll } from 'bun:test'
import { mkdirSync, writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { executeSkillTool, createSkillToolDefinition, READ_SKILL_TOOL_NAME } from './skill-tool'

// 使用独立测试配置目录，与 getConfigDir 的 PROMA_TEST_CONFIG_DIR 约定对齐
const tempHomeDir = mkdtempSync(join(tmpdir(), 'proma-skill-tool-test-'))
process.env.PROMA_TEST_CONFIG_DIR = join(tempHomeDir, '.proma-mit')
process.env.PROMA_DEV = '1'

const WORKSPACE_SLUG = 'test-workspace'
const skillsDir = join(process.env.PROMA_TEST_CONFIG_DIR, 'agent-workspaces', WORKSPACE_SLUG, 'skills')
const skillDir = join(skillsDir, 'code-review')

function setupSkillFiles(): void {
  mkdirSync(skillDir, { recursive: true })
  writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: code-review\ndescription: 代码审查\n---\n\n# 代码审查流程\n1. 读取 diff\n2. 检查边界\n', 'utf-8')
  writeFileSync(join(skillDir, 'template.md'), '# 审查模板\n模板内容', 'utf-8')
  // 越界文件：Skill 目录外，ReadSkill 应拒绝
  writeFileSync(join(skillsDir, '..', 'outside-secret.txt'), 'secret', 'utf-8')
}

setupSkillFiles()

afterAll(() => {
  if (existsSync(tempHomeDir)) rmSync(tempHomeDir, { recursive: true, force: true })
  delete process.env.PROMA_TEST_CONFIG_DIR
})

describe('ReadSkill 工具', () => {
  test('definition exposes skill_slug and file_path params', () => {
    const def = createSkillToolDefinition()
    expect(def.name).toBe(READ_SKILL_TOOL_NAME)
    expect(def.parameters.properties.skill_slug).toBeDefined()
    expect(def.parameters.required).toContain('skill_slug')
  })

  test('读取 SKILL.md 全文（默认路径）', async () => {
    const result = await executeSkillTool(
      { skill_slug: 'code-review' },
      { cwd: tempHomeDir, sessionId: 's1', workspaceSlug: WORKSPACE_SLUG },
    )
    expect(result.isError).toBeFalsy()
    expect(result.content).toContain('# 代码审查流程')
    expect(result.content).toContain('2. 检查边界')
  })

  test('读取 Skill 子文件（file_path）', async () => {
    const result = await executeSkillTool(
      { skill_slug: 'code-review', file_path: 'template.md' },
      { cwd: tempHomeDir, sessionId: 's1', workspaceSlug: WORKSPACE_SLUG },
    )
    expect(result.isError).toBeFalsy()
    expect(result.content).toContain('模板内容')
  })

  test('无工作区时返回错误', async () => {
    const result = await executeSkillTool(
      { skill_slug: 'code-review' },
      { cwd: tempHomeDir, sessionId: 's1' },
    )
    expect(result.isError).toBe(true)
    expect(result.content).toContain('没有绑定工作区')
  })

  test('skill_slug 为空时返回错误', async () => {
    const result = await executeSkillTool(
      { skill_slug: '' },
      { cwd: tempHomeDir, sessionId: 's1', workspaceSlug: WORKSPACE_SLUG },
    )
    expect(result.isError).toBe(true)
    expect(result.content).toContain('skill_slug 不能为空')
  })

  test('不存在的 Skill 返回错误', async () => {
    const result = await executeSkillTool(
      { skill_slug: 'no-such-skill' },
      { cwd: tempHomeDir, sessionId: 's1', workspaceSlug: WORKSPACE_SLUG },
    )
    expect(result.isError).toBe(true)
    expect(result.content).toContain('读取 Skill 失败')
  })

  test('路径越界（../）被拒绝', async () => {
    const result = await executeSkillTool(
      { skill_slug: 'code-review', file_path: '../outside-secret.txt' },
      { cwd: tempHomeDir, sessionId: 's1', workspaceSlug: WORKSPACE_SLUG },
    )
    expect(result.isError).toBe(true)
    expect(result.content).toContain('读取 Skill 失败')
  })
})

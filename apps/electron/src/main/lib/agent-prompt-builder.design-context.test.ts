import { afterAll, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getAgentWorkspacePath, getWorkspaceSkillsDir } from './config-paths'
import { installOpenDesignFiles } from './opendesign-install-store'

const previousConfigDir = process.env.PROMA_TEST_CONFIG_DIR
const configDir = mkdtempSync(join(tmpdir(), 'gravitas-claude-opendesign-'))
process.env.PROMA_TEST_CONFIG_DIR = configDir
const { buildSystemPrompt } = await import('./agent-prompt-builder')

afterAll(() => {
  if (previousConfigDir === undefined) delete process.env.PROMA_TEST_CONFIG_DIR
  else process.env.PROMA_TEST_CONFIG_DIR = previousConfigDir
  rmSync(configDir, { recursive: true, force: true })
})

test('Given Owner 工作区安装 OpenDesign 且 Skill 声明 design_system When 构建 Claude 系统提示词 Then 注入规范、来源版本和令牌', () => {
  const workspaceSlug = 'claude-design-owner'
  const workspaceRoot = getAgentWorkspacePath(workspaceSlug)
  const filesDir = join(workspaceRoot, 'workspace-files')
  const skillsDir = getWorkspaceSkillsDir(workspaceSlug)
  const cwd = join(workspaceRoot, 'owner-session')
  const design = '# Stripe Design System\n\nClaude owner-approved reference.\n'
  const tokens = ':root { --brand: #635bff; }\n'
  const digest = (value: string) => createHash('sha256').update(value).digest('hex')
  mkdirSync(filesDir, { recursive: true })
  mkdirSync(cwd, { recursive: true })
  const skillDir = join(skillsDir, 'installed-design')
  mkdirSync(skillDir, { recursive: true })
  writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: installed-design\ndescription: Test installed design injection\nod:\n  design_system:\n    requires: true\n---\n\n# Design task\n')
  installOpenDesignFiles(filesDir, {
    schemaVersion: 1,
    source: 'OpenDesign',
    license: 'Apache-2.0',
    projectId: 'claude-project',
    workspaceId: 'claude-workspace',
    workspaceSlug,
    brandId: 'stripe',
    brandName: 'Stripe',
    referenceRevision: 'claude-r1',
    installedAt: 1,
    actor: 'local-user',
    files: { 'DESIGN.md': digest(design), 'tokens.css': digest(tokens) },
  }, design, tokens)

  const prompt = buildSystemPrompt({
    workspaceName: 'Claude Owner test',
    workspaceSlug,
    agentCwd: cwd,
    sessionId: 'claude-owner-session',
    permissionMode: 'safe',
    memoryEnabled: false,
  })

  expect(prompt).toContain('origin="OpenDesign stripe claude-r1"')
  expect(prompt).toContain('Claude owner-approved reference.')
  expect(prompt).toContain('--brand: #635bff')
})

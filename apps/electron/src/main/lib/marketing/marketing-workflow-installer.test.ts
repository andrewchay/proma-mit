/**
 * 营销工作流安装器测试
 *
 * 验证订阅后自动安装营销 Campaign 工作流到工作区的核心逻辑：
 * - 模板不存在时返回失败
 * - 未安装时导入为 Draft 并尝试发布
 * - 已安装且已发布时幂等跳过
 * - 已安装但为 Draft 时尝试发布
 * - 发布失败（能力预检不通过）时保留 Draft
 */

import { test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// =====================================================================
// 测试隔离：重定向配置目录到临时目录
// =====================================================================

let tempDir: string

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'marketing-workflow-test-'))
  process.env.PROMA_TEST_CONFIG_DIR = tempDir
})

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true })
  delete process.env.PROMA_TEST_CONFIG_DIR
})

// =====================================================================
// 辅助函数
// =====================================================================

/** 创建最小可用的 Workflow Definition（通过 DSL 校验） */
function createMinimalDefinition(id: string, workspaceId: string): Record<string, unknown> {
  return {
    format: 'paa.workflow',
    formatVersion: '1.0',
    id,
    workspaceId,
    teamId: 'personal',
    name: '营销 Campaign 全流程',
    description: '测试用营销工作流',
    status: 'published' as const,
    version: '1.0.0',
    trigger: { kind: 'manual' as const },
    nodes: [
      { id: 'start', kind: 'start' as const, title: '开始' },
      { id: 'end', kind: 'end' as const, title: '结束' },
    ],
    edges: [{ id: 'e1', from: 'start', to: 'end' }],
    layout: { nodes: { start: { x: 0, y: 0 }, end: { x: 200, y: 0 } } },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
}

/** 创建模板文件到临时配置目录 */
function seedTemplate(templateId: string, version: string, definition: unknown): void {
  const templatesDir = join(tempDir, 'workflows', 'templates')
  mkdirSync(templatesDir, { recursive: true })
  const template = { id: templateId, version, definition }
  writeFileSync(join(templatesDir, `${templateId}.json`), JSON.stringify(template, null, 2), 'utf-8')
}

/** 创建最小工作区索引，使 getAgentWorkspace 能找到工作区 */
function seedWorkspaceIndex(workspaceId: string): void {
  const indexPath = join(tempDir, 'agent-workspaces.json')
  const index = {
    version: 2,
    workspaces: [
      {
        id: workspaceId,
        slug: workspaceId,
        name: workspaceId,
        teamId: 'personal',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    ],
  }
  writeFileSync(indexPath, JSON.stringify(index, null, 2), 'utf-8')

  // 创建工作区目录结构
  const wsDir = join(tempDir, 'agent-workspaces', workspaceId)
  mkdirSync(join(wsDir, 'skills'), { recursive: true })
}

// =====================================================================
// 测试用例
// =====================================================================

test('模板不存在时返回失败', async () => {
  const { ensureMarketingWorkflowForWorkspace } = await import('./marketing-workflow-installer')
  const result = ensureMarketingWorkflowForWorkspace('test-workspace')
  expect(result.installed).toBe(false)
  expect(result.message).toContain('模板不存在')
})

test('未安装时导入为 Draft 并尝试发布', async () => {
  const definition = createMinimalDefinition('marketing-campaign-template', 'template')
  seedTemplate('marketing-campaign', '1.0.0', definition)
  seedWorkspaceIndex('test-workspace')

  const { ensureMarketingWorkflowForWorkspace } = await import('./marketing-workflow-installer')
  const result = ensureMarketingWorkflowForWorkspace('test-workspace')

  expect(result.installed).toBe(true)
  expect(result.workflowId).toBe('marketing-campaign-workflow')
  // 最小定义无能力引用，发布应成功
  expect(result.published).toBe(true)
  expect(result.message).toContain('已安装并发布')
})

test('已安装且已发布时幂等跳过', async () => {
  const definition = createMinimalDefinition('marketing-campaign-template', 'template')
  seedTemplate('marketing-campaign', '1.0.0', definition)
  seedWorkspaceIndex('test-workspace')

  const { ensureMarketingWorkflowForWorkspace } = await import('./marketing-workflow-installer')

  // 第一次安装
  const first = ensureMarketingWorkflowForWorkspace('test-workspace')
  expect(first.published).toBe(true)

  // 第二次应幂等跳过
  const second = ensureMarketingWorkflowForWorkspace('test-workspace')
  expect(second.installed).toBe(true)
  expect(second.published).toBe(true)
  expect(second.message).toContain('跳过')
})

test('已安装但为 Draft 时尝试发布', async () => {
  const definition = createMinimalDefinition('marketing-campaign-template', 'template')
  seedTemplate('marketing-campaign', '1.0.0', definition)
  seedWorkspaceIndex('test-workspace')

  const { ensureMarketingWorkflowForWorkspace } = await import('./marketing-workflow-installer')
  const { getWorkflowDefinition, saveWorkflowDefinition } = await import('../workflow-service')
  const { importWorkflowDefinition } = await import('@gravitas/shared/workflow')

  // 先手动安装为 Draft
  const exportFile = {
    format: 'paa.workflow.export' as const,
    formatVersion: '1.0' as const,
    exportedAt: Date.now(),
    definition,
  }
  const draft = importWorkflowDefinition(exportFile, {
    workspaceId: 'test-workspace',
    workflowId: 'marketing-campaign-workflow',
  })
  saveWorkflowDefinition(draft)

  // 确认是 Draft
  const before = getWorkflowDefinition('marketing-campaign-workflow')
  expect(before?.status).toBe('draft')

  // 再次调用应尝试发布
  const result = ensureMarketingWorkflowForWorkspace('test-workspace')
  expect(result.installed).toBe(true)
  expect(result.published).toBe(true)

  const after = getWorkflowDefinition('marketing-campaign-workflow')
  expect(after?.status).toBe('published')
})

test('工作流文件确实被创建', async () => {
  const definition = createMinimalDefinition('marketing-campaign-template', 'template')
  seedTemplate('marketing-campaign', '1.0.0', definition)
  seedWorkspaceIndex('test-workspace')

  const { ensureMarketingWorkflowForWorkspace } = await import('./marketing-workflow-installer')
  ensureMarketingWorkflowForWorkspace('test-workspace')

  const workflowPath = join(tempDir, 'workflows', 'marketing-campaign-workflow', 'definition.json')
  expect(existsSync(workflowPath)).toBe(true)
})

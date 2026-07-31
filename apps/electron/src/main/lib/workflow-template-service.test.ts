import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createAgentWorkspace, saveWorkspaceMcpConfig } from './agent-workspace-manager'
import { getWorkspaceSkillsDir } from './config-paths'
import { publishWorkflowDefinition, saveWorkflowDefinition } from './workflow-service'
import { installWorkflowTemplate, installWorkflowTemplateBatch, previewWorkflowTemplateUpgrade, publishWorkflowTemplate, rollbackWorkflowTemplate, upgradeWorkflowTemplate } from './workflow-template-service'
import { WORKFLOW_FORMAT, type WorkflowDefinition } from '@proma/shared'

const TEST_DIR = '/tmp/paa-workflow-template-test'

function published(workspaceId: string): WorkflowDefinition {
  const now = Date.now()
  const definition: WorkflowDefinition = {
    format: WORKFLOW_FORMAT, formatVersion: '1.0', id: 'template-source', workspaceId, name: '风险周报 v1', status: 'draft', version: '0.1.0', trigger: { kind: 'manual' },
    nodes: [{ id: 'start', kind: 'start', title: '开始' }, { id: 'agent', kind: 'agent', title: '汇总', config: { prompt: '汇总风险' }, capabilityPolicy: { skills: [{ slug: 'project-review', version: '1.0.0' }] } }, { id: 'end', kind: 'end', title: '结束' }],
    edges: [{ id: 'start-agent', from: 'start', to: 'agent' }, { id: 'agent-end', from: 'agent', to: 'end' }], layout: { nodes: { start: { x: 0, y: 0 }, agent: { x: 100, y: 0 }, end: { x: 200, y: 0 } } }, createdAt: now, updatedAt: now,
  }
  saveWorkflowDefinition(definition)
  return publishWorkflowDefinition(definition.id, { version: '1.0.0' })
}

describe('Workflow Template 服务', () => {
  beforeAll(() => { process.env.PROMA_TEST_CONFIG_DIR = TEST_DIR; rmSync(TEST_DIR, { recursive: true, force: true }); mkdirSync(TEST_DIR, { recursive: true }) })
  beforeEach(() => { rmSync(TEST_DIR, { recursive: true, force: true }); mkdirSync(TEST_DIR, { recursive: true }) })
  afterAll(() => { rmSync(TEST_DIR, { recursive: true, force: true }); delete process.env.PROMA_TEST_CONFIG_DIR })

  test('发布、安装、升级和回滚不会共享源工作区或发布权限', () => {
    const sourceWorkspace = createAgentWorkspace('源工作区')
    const skillDir = join(getWorkspaceSkillsDir(sourceWorkspace.slug), 'project-review')
    mkdirSync(skillDir, { recursive: true }); writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: project-review\nversion: 1.0.0\n---\n')
    saveWorkspaceMcpConfig(sourceWorkspace.slug, { servers: {} })
    const source = published(sourceWorkspace.id)
    publishWorkflowTemplate(source.id, { templateId: 'risk-template', name: '风险模板', version: '1.0.0' })
    const target = createAgentWorkspace('目标工作区')
    const installed = installWorkflowTemplate('risk-template', target.id, 'target-risk')
    expect(installed.workspaceId).toBe(target.id)
    expect(installed.status).toBe('draft')
    expect(installed.publication).toBeUndefined()

    saveWorkflowDefinition({ ...source, name: '风险周报 v2' })
    publishWorkflowTemplate(source.id, { templateId: 'risk-template', name: '风险模板', version: '2.0.0' })
    expect(previewWorkflowTemplateUpgrade(installed.id).diff.changedNodeIds).toEqual([])
    expect(upgradeWorkflowTemplate(installed.id).name).toBe('风险周报 v2')
    expect(rollbackWorkflowTemplate(installed.id).name).toBe('风险周报 v1')
  })

  test('批量安装隔离每个工作区的失败并返回可观测状态', () => {
    const source = createAgentWorkspace('源'); const skillDir = join(getWorkspaceSkillsDir(source.slug), 'project-review')
    mkdirSync(skillDir, { recursive: true }); writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: project-review\nversion: 1.0.0\n---\n'); saveWorkspaceMcpConfig(source.slug, { servers: {} })
    const flow = published(source.id); publishWorkflowTemplate(flow.id, { templateId: 'batch-template', name: '批量模板', version: '1.0.0' })
    const target = createAgentWorkspace('目标')
    const result = installWorkflowTemplateBatch('batch-template', [target.id, 'missing-workspace', target.id])
    expect(result.results).toHaveLength(2)
    expect(result.results.map((item) => item.status)).toEqual(['installed', 'failed'])
  })
})

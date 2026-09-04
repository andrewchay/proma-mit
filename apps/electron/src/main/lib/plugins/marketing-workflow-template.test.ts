import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { validateWorkflowDefinition } from '@gravitas/shared/workflow'

const marketingPackageDir = join(import.meta.dir, '../../../../default-tools/marketing')
const templatePath = join(marketingPackageDir, 'workflows/marketing-campaign.json')
const manifestPath = join(marketingPackageDir, 'manifest.json')

interface MarketingWorkflowTemplateAsset {
  id: string
  version: string
  definition: unknown
}

function readTemplate(): MarketingWorkflowTemplateAsset {
  return JSON.parse(readFileSync(templatePath, 'utf-8')) as MarketingWorkflowTemplateAsset
}

describe('营销领域能力包 Campaign 模板', () => {
  test('Given 内置营销包 When 读取模板 Then 模板是可安装的有效 Workflow DSL', () => {
    const template = readTemplate()
    const result = validateWorkflowDefinition(template.definition)

    expect(template.id).toBe('marketing-campaign')
    expect(template.version).toBe('1.0.0')
    expect(result.success).toBe(true)
  })

  test('Given Campaign 模板 When 检查迁移步骤 Then 保留源端的 15 步业务闭环与审批边界', () => {
    const template = readTemplate()
    const definition = template.definition as { nodes: Array<{ id: string; kind: string }> }
    const ids = definition.nodes.map((node) => node.id)

    expect(ids).toEqual([
      'start', 'market-analysis', 'competitor-analysis', 'audience-insight',
      'brand-dna', 'brand-fact-check', 'brand-house', 'goal-setting',
      'big-idea', 'platform-matrix', 'kol-strategy', 'candidate-selection',
      'strategy-approval', 'briefs', 'content-audit', 'ab-test', 'ugc-plan',
      'execution-plan', 'end',
    ])
    expect(definition.nodes.find((node) => node.id === 'strategy-approval')?.kind).toBe('approval')
  })

  test('Given 营销领域包 When 检查随包资产 Then 迁移 Skills 和模板入口都可被发现', () => {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as {
      version: string
      workflowTemplates?: string[]
      skills?: string[]
    }

    expect(manifest.version).toBe('1.1.0')
    expect(manifest.workflowTemplates).toEqual(['workflows/marketing-campaign.json'])
    expect(manifest.skills).toContain('ma-brand-dna')
    expect(manifest.skills).toContain('ma-campaign-tester')
    expect(existsSync(join(import.meta.dir, '../../../../default-skills/ma-brand-dna/SKILL.md'))).toBe(true)
    expect(existsSync(join(import.meta.dir, '../../../../default-skills/ma-ugc-campaign/SKILL.md'))).toBe(true)
  })
})

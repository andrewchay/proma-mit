import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { exportWorkflowDefinition } from '@gravitas/shared/workflow'
import { DOMAIN_WORKFLOW_BINDINGS } from './domain-workflow-installer'

/** 领域包根目录（default-tools/<pkg>） */
function bundledPackageDir(pkgDirName: string): string {
  return join(import.meta.dir, '../../../default-tools', pkgDirName)
}

describe('领域包随包工作流模板', () => {
  test('Given 声明表 When 逐条校验 Then 模板文件存在且 id 一致', () => {
    expect(DOMAIN_WORKFLOW_BINDINGS.length).toBeGreaterThan(0)
    for (const binding of DOMAIN_WORKFLOW_BINDINGS) {
      const path = join(bundledPackageDir(binding.capabilityId), 'workflows', `${binding.templateId}.json`)
      const template = JSON.parse(readFileSync(path, 'utf-8')) as { id: string; definition: { nodes: Array<{ kind: string }> } }
      expect(() => exportWorkflowDefinition(template.definition)).not.toThrow()
      expect(template.id).toBe(binding.templateId)
      const kinds = template.definition.nodes.map((n) => n.kind)
      expect(kinds[0]).toBe('start')
      expect(kinds[kinds.length - 1]).toBe('end')
      expect(kinds).toContain('approval')
    }
  })

  test('Given sourcing 模板 When 检查阶段 Then 覆盖计划/检索/评分/审批/外联五阶段', () => {
    const path = join(bundledPackageDir('outbound-sourcing'), 'workflows', 'outbound-sourcing-pipeline.json')
    const template = JSON.parse(readFileSync(path, 'utf-8')) as { definition: { nodes: Array<{ id: string }> } }
    const ids = template.definition.nodes.map((n) => n.id)
    for (const expected of ['keyword-plan', 'buyer-search', 'lead-scoring', 'lead-approval', 'outreach-draft']) {
      expect(ids).toContain(expected)
    }
  })
})

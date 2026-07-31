/** 本地 Workflow 模板库。
 * 模板与安装副本均只保存 DSL Definition，凭证继续由目标工作区的渠道/MCP 配置托管。
 */
import { randomUUID } from 'node:crypto'
import {
  type WorkflowDefinition,
  type WorkflowTemplate,
  type WorkflowTemplateInstallation,
  type WorkflowTemplatePublishInput,
} from '@proma/shared'
import { exportWorkflowDefinition, importWorkflowDefinition } from '@proma/shared/workflow'
import { getAgentWorkspace } from './agent-workspace-manager'
import { getWorkflowTemplateInstallationPath, getWorkflowTemplatePath, getWorkflowTemplatesDir } from './config-paths'
import { readJsonFileSafe, writeJsonFileAtomic } from './safe-file'
import { getWorkflowDefinition, saveWorkflowDefinition } from './workflow-service'
import { readdirSync } from 'node:fs'

function templateId(input?: string): string {
  const value = input?.trim() || `template-${randomUUID()}`
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) throw new Error('Template ID 非法')
  return value
}

function getTemplate(templateId: string): WorkflowTemplate {
  const template = readJsonFileSafe<WorkflowTemplate>(getWorkflowTemplatePath(templateId))
  if (!template) throw new Error(`Workflow Template 不存在: ${templateId}`)
  // 每次读取也重新走 DSL 校验，阻断磁盘损坏或手工写入凭证的模板。
  exportWorkflowDefinition(template.definition)
  const normalized = { ...template, teamId: template.teamId ?? template.definition.teamId ?? 'personal', revisions: template.revisions?.length ? template.revisions : [{ version: template.version, definition: template.definition, publishedAt: template.updatedAt }] }
  if (!template.teamId || !template.revisions?.length) writeJsonFileAtomic(getWorkflowTemplatePath(templateId), normalized)
  return normalized
}

export function listWorkflowTemplates(): WorkflowTemplate[] {
  return readdirSync(getWorkflowTemplatesDir(), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .flatMap((entry) => {
      try { return [getTemplate(entry.name.slice(0, -5))] } catch (error) { console.error(`[Workflow] 跳过无法读取的 Template: ${entry.name}`, error); return [] }
    })
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

/** 从已发布流程发布或更新一个本地模板。 */
export function publishWorkflowTemplate(workflowId: string, input: WorkflowTemplatePublishInput): WorkflowTemplate {
  const definition = getWorkflowDefinition(workflowId)
  if (!definition) throw new Error(`Workflow 不存在: ${workflowId}`)
  if (definition.status !== 'published') throw new Error('只有已发布的 Workflow 可以发布为 Template')
  if (!input.name.trim() || !input.version.trim()) throw new Error('Template 名称和版本不能为空')
  const id = templateId(input.templateId)
  const existing = readJsonFileSafe<WorkflowTemplate>(getWorkflowTemplatePath(id))
  if (existing && existing.version === input.version) throw new Error('Template 版本未变化，拒绝覆盖')
  const now = Date.now()
  const revision = { version: input.version.trim(), definition: exportWorkflowDefinition(definition).definition, publishedAt: now }
  const history = existing ? getTemplate(id).revisions : []
  if (history.some((item) => item.version === revision.version)) throw new Error('Template 版本不可覆盖')
  const template: WorkflowTemplate = {
    id, teamId: definition.teamId ?? 'personal', name: input.name.trim(), description: input.description?.trim(), version: input.version.trim(),
    definition: revision.definition, revisions: [...history, revision],
    createdAt: existing?.createdAt ?? now, updatedAt: now,
  }
  writeJsonFileAtomic(getWorkflowTemplatePath(id), template)
  return template
}

export function previewWorkflowTemplateUpgrade(workflowId: string): NonNullable<WorkflowTemplateInstallation['pendingUpgrade']> {
  const record = installation(workflowId); const current = getWorkflowDefinition(workflowId); const template = getTemplate(record.templateId)
  if (!current || template.version === record.templateVersion) throw new Error('没有可用 Template 升级')
  const before = new Map(current.nodes.map((node) => [node.id, JSON.stringify(node)])); const after = new Map(template.definition.nodes.map((node) => [node.id, JSON.stringify(node)]))
  const diff = { addedNodeIds: [...after.keys()].filter((id) => !before.has(id)), removedNodeIds: [...before.keys()].filter((id) => !after.has(id)), changedNodeIds: [...after.keys()].filter((id) => before.has(id) && before.get(id) !== after.get(id)) }
  const pending = { targetVersion: template.version, diff, requestedAt: Date.now() }; record.pendingUpgrade = pending; record.updatedAt = Date.now(); saveInstallation(record); return pending
}

function saveInstallation(installation: WorkflowTemplateInstallation): void {
  writeJsonFileAtomic(getWorkflowTemplateInstallationPath(installation.workflowId), installation)
}

function installation(workflowId: string): WorkflowTemplateInstallation {
  const record = readJsonFileSafe<WorkflowTemplateInstallation>(getWorkflowTemplateInstallationPath(workflowId))
  if (!record) throw new Error('该 Workflow 不是 Template 安装副本')
  return record
}

/** 安装模板为目标工作区的新 Draft，等待目标工作区的能力预检和发布。 */
export function installWorkflowTemplate(templateId: string, workspaceId: string, workflowId?: string): WorkflowDefinition {
  if (!getAgentWorkspace(workspaceId)) throw new Error(`Workflow 所属工作区不存在: ${workspaceId}`)
  const template = getTemplate(templateId)
  const id = workflowId?.trim() || `workflow-${randomUUID()}`
  if (getWorkflowDefinition(id)) throw new Error(`Workflow 已存在: ${id}`)
  const definition = { ...importWorkflowDefinition(exportWorkflowDefinition(template.definition), { workspaceId, workflowId: id }), teamId: getAgentWorkspace(workspaceId)?.teamId ?? 'personal' }
  const saved = saveWorkflowDefinition(definition)
  saveInstallation({ templateId, templateVersion: template.version, workflowId: id, workspaceId, history: [], installedAt: Date.now(), updatedAt: Date.now() })
  return saved
}

/** 批量安装对每个工作区独立提交，返回完整状态而非遇错整体回滚。 */
export function installWorkflowTemplateBatch(templateId: string, workspaceIds: string[]): import('@proma/shared').WorkflowTemplateBatchInstallResult {
  const template = getTemplate(templateId)
  const uniqueWorkspaceIds = [...new Set(workspaceIds)]
  const results = uniqueWorkspaceIds.map((workspaceId) => {
    try {
      const definition = installWorkflowTemplate(templateId, workspaceId)
      return { workspaceId, status: 'installed' as const, workflowId: definition.id }
    } catch (error) {
      return { workspaceId, status: 'failed' as const, error: error instanceof Error ? error.message : '模板安装失败' }
    }
  })
  return { templateId, templateVersion: template.version, results, completedAt: Date.now() }
}

/** 升级安装副本，并先保存可回滚的旧 Definition；运行快照不受影响。 */
export function upgradeWorkflowTemplate(workflowId: string): WorkflowDefinition {
  const record = installation(workflowId)
  const current = getWorkflowDefinition(workflowId)
  if (!current) throw new Error(`Workflow 不存在: ${workflowId}`)
  const template = getTemplate(record.templateId)
  if (!record.pendingUpgrade || record.pendingUpgrade.targetVersion !== template.version) throw new Error('请先预览并确认 Template 升级差异')
  const next = importWorkflowDefinition(exportWorkflowDefinition(template.definition), { workspaceId: record.workspaceId, workflowId })
  const saved = saveWorkflowDefinition(next)
  record.history.push({ templateVersion: record.templateVersion, definition: current, recordedAt: Date.now() })
  record.templateVersion = template.version
  record.pendingUpgrade = undefined
  record.updatedAt = Date.now()
  saveInstallation(record)
  return saved
}

/** 回滚到该安装副本最近一次升级前的 Definition。 */
export function rollbackWorkflowTemplate(workflowId: string): WorkflowDefinition {
  const record = installation(workflowId)
  const snapshot = record.history.pop()
  if (!snapshot) throw new Error('没有可回滚的 Template 版本')
  const restored = saveWorkflowDefinition({ ...snapshot.definition, id: workflowId, workspaceId: record.workspaceId, updatedAt: Date.now() })
  record.templateVersion = snapshot.templateVersion
  record.updatedAt = Date.now()
  saveInstallation(record)
  return restored
}

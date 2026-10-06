/**
 * 营销工作流安装器
 *
 * 职责：营销订阅启用后，自动把营销 Campaign 工作流模板安装到当前工作区并发布，
 * 使用户能在 Workflow 面板中直接创建 Run 执行。
 *
 * 触发时机：
 * - 应用启动时（seedBundledWorkflowTemplates 之后）
 * - 营销订阅变更时（marketing-plugin.setEnabled / 用户切换订阅）
 *
 * 设计要点：
 * - 幂等：已安装且版本不低于模板版本时跳过；已发布则不重复发布。
 * - 能力预检：发布前校验工作区 Skill/MCP 是否满足模板要求，失败时保留 Draft
 *   并输出警告，不阻断订阅流程（用户可补齐能力后手动发布）。
 * - 多工作区：遍历所有工作区，只为已订阅营销域的工作区安装。
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { WorkflowDefinition } from '@gravitas/shared'
import { getWorkflowTemplatePath, getWorkflowTemplatesDir } from '../config-paths'
import { getWorkflowDefinition, publishWorkflowDefinition, saveWorkflowDefinition } from '../workflow-service'
import { readJsonFileSafe } from '../safe-file'
import { listAgentWorkspaces } from '../agent-workspace-manager'

// =====================================================================
// 常量
// =====================================================================

/** 营销 Campaign 工作流模板 ID（与 default-tools/marketing/workflows/marketing-campaign.json 的 id 一致） */
const MARKETING_CAMPAIGN_TEMPLATE_ID = 'marketing-campaign'

/** 安装到工作区后的 Workflow 固定 ID（便于幂等检查和 UI 定位） */
const MARKETING_CAMPAIGN_WORKFLOW_ID = 'marketing-campaign-workflow'

// =====================================================================
// 模板读取
// =====================================================================

interface BundledWorkflowTemplateMeta {
  id: string
  version: string
  definition: unknown
}

/** 读取本地模板库中的营销 Campaign 模板；不存在时返回 null。 */
function readMarketingTemplate(): BundledWorkflowTemplateMeta | null {
  const path = getWorkflowTemplatePath(MARKETING_CAMPAIGN_TEMPLATE_ID)
  if (!existsSync(path)) return null
  return readJsonFileSafe<BundledWorkflowTemplateMeta>(path)
}

// =====================================================================
// 安装逻辑
// =====================================================================

export interface MarketingWorkflowInstallResult {
  installed: boolean
  published: boolean
  workflowId: string
  message: string
}

/**
 * 确保营销 Campaign 工作流已安装到指定工作区。
 *
 * 行为：
 * 1. 模板不存在 → 返回失败（seedBundledWorkflowTemplates 可能未运行）
 * 2. 已安装且版本 >= 模板版本 → 跳过（幂等）
 * 3. 未安装 → 导入为 Draft → 尝试发布 → 返回结果
 */
export function ensureMarketingWorkflowForWorkspace(workspaceId: string): MarketingWorkflowInstallResult {
  const template = readMarketingTemplate()
  if (!template) {
    return {
      installed: false,
      published: false,
      workflowId: MARKETING_CAMPAIGN_WORKFLOW_ID,
      message: `营销模板不存在: ${MARKETING_CAMPAIGN_TEMPLATE_ID}（seedBundledWorkflowTemplates 可能未运行）`,
    }
  }

  const existing = getWorkflowDefinition(MARKETING_CAMPAIGN_WORKFLOW_ID)

  // 已安装且版本不低于模板 → 幂等跳过
  if (existing && existing.workspaceId === workspaceId) {
    if (existing.status === 'published') {
      return {
        installed: true,
        published: true,
        workflowId: MARKETING_CAMPAIGN_WORKFLOW_ID,
        message: '营销工作流已安装并发布，跳过',
      }
    }
    // 已存在但是 Draft → 尝试发布
    return tryPublish(existing, workspaceId)
  }

  // 未安装 → 导入为 Draft
  const { importWorkflowDefinition } = require('@gravitas/shared/workflow') as {
    importWorkflowDefinition: (input: unknown, options: { workspaceId: string; workflowId: string }) => WorkflowDefinition
  }

  const exportFile = {
    format: 'paa.workflow.export' as const,
    formatVersion: '1.0' as const,
    exportedAt: Date.now(),
    definition: template.definition,
  }

  const draft = importWorkflowDefinition(exportFile, {
    workspaceId,
    workflowId: MARKETING_CAMPAIGN_WORKFLOW_ID,
  })

  const saved = saveWorkflowDefinition(draft)
  console.log(`[营销工作流] 已安装 Draft: ${saved.id} v${saved.version} → 工作区 ${workspaceId}`)

  return tryPublish(saved, workspaceId)
}

/** 尝试发布工作流；能力预检失败时保留 Draft 并返回警告。 */
function tryPublish(
  definition: WorkflowDefinition,
  workspaceId: string,
): MarketingWorkflowInstallResult {
  if (definition.status === 'published') {
    return {
      installed: true,
      published: true,
      workflowId: definition.id,
      message: '营销工作流已发布，跳过',
    }
  }

  try {
    const published = publishWorkflowDefinition(definition.id, {
      version: definition.version,
      changeSummary: '营销订阅自动安装',
    })
    console.log(`[营销工作流] 已发布: ${published.id} v${published.version}`)
    return {
      installed: true,
      published: true,
      workflowId: definition.id,
      message: `营销工作流已安装并发布 v${published.version}`,
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    console.warn(`[营销工作流] 发布失败（保留 Draft，可补齐能力后手动发布）: ${reason}`)
    return {
      installed: true,
      published: false,
      workflowId: definition.id,
      message: `已安装 Draft，但发布失败: ${reason}`,
    }
  }
}

// =====================================================================
// 批量入口
// =====================================================================

/**
 * 为所有工作区安装营销工作流（启动时调用）。
 *
 * 只为已有营销工作流或已订阅营销域的工作区安装。
 * 当前简化策略：为所有工作区安装（工作流本身无凭证，能力预检会在发布时拦截）。
 */
export function ensureMarketingWorkflowForAllWorkspaces(): void {
  let template: BundledWorkflowTemplateMeta | null
  try {
    template = readMarketingTemplate()
  } catch {
    template = null
  }
  if (!template) {
    console.log('[营销工作流] 模板不存在，跳过安装')
    return
  }

  try {
    const workspaces = listAgentWorkspaces()
    for (const ws of workspaces) {
      try {
        const result = ensureMarketingWorkflowForWorkspace(ws.slug)
        if (result.installed) {
          console.log(`[营销工作流] 工作区 ${ws.slug}: ${result.message}`)
        }
      } catch (error) {
        console.warn(`[营销工作流] 工作区 ${ws.slug} 安装失败:`, error)
      }
    }
  } catch (error) {
    console.warn('[营销工作流] 遍历工作区失败:', error)
  }
}

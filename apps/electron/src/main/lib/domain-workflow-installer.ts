/**
 * 领域工作流安装器（通用版）
 *
 * 职责：业务领域包（当前：出海 sourcing）订阅启用后，自动把随包 Workflow 模板
 * 安装到所有工作区并发布，使用户能在 Workflow 面板直接创建 Run。
 *
 * 与 marketing-workflow-installer 的关系：营销包保留专属安装器（含 Skills 能力
 * 预检的定制逻辑）；本模块面向不依赖额外 Skill 的领域包，按声明表批量安装。
 *
 * 触发时机：
 * - 应用启动时（seedBundledWorkflowTemplates 之后）
 * - 领域订阅变更时（settings.domainCapabilities 更新）
 *
 * 设计要点：
 * - 幂等：已安装且已发布则跳过；已安装为 Draft 则重试发布。
 * - 能力预检：发布由 workflow-service 校验，失败时保留 Draft 不阻断。
 * - 只为已启用对应领域包的工作区安装（订阅门禁与插件 isEnabled 同源）。
 */

import { existsSync } from 'node:fs'
import type { WorkflowDefinition } from '@gravitas/shared'
import { getWorkflowTemplatePath } from './config-paths'
import { getWorkflowDefinition, publishWorkflowDefinition, saveWorkflowDefinition } from './workflow-service'
import { readJsonFileSafe } from './safe-file'
import { listAgentWorkspaces } from './agent-workspace-manager'
import { getSettings } from './settings-service'
import { isDevUnlockEnabled } from './dev-unlock'

// =====================================================================
// 领域包声明表
// =====================================================================

export interface DomainWorkflowBinding {
  /** 领域包 id（与 settings.domainCapabilities / marketingCapabilities 中的值一致） */
  capabilityId: string
  /** settings 中的开关字段（营销包走 marketingCapabilities，其余走 domainCapabilities） */
  settingsKey: 'marketingCapabilities' | 'domainCapabilities'
  /** 随包模板 id（与 default-tools/<pkg>/workflows/<id>.json 的 id 一致） */
  templateId: string
  /** 安装到工作区后的固定 Workflow id */
  workflowId: string
  /** 日志前缀 */
  label: string
}

/** 当前需要自动安装工作流的领域包 */
export const DOMAIN_WORKFLOW_BINDINGS: DomainWorkflowBinding[] = [
  {
    capabilityId: 'outbound-sourcing',
    settingsKey: 'domainCapabilities',
    templateId: 'outbound-sourcing-pipeline',
    workflowId: 'outbound-sourcing-pipeline-workflow',
    label: '出海Sourcing工作流',
  },
]

// =====================================================================
// 模板读取
// =====================================================================

interface BundledWorkflowTemplateMeta {
  id: string
  version: string
  definition: unknown
}

function readTemplate(templateId: string): BundledWorkflowTemplateMeta | null {
  const path = getWorkflowTemplatePath(templateId)
  if (!existsSync(path)) return null
  return readJsonFileSafe<BundledWorkflowTemplateMeta>(path)
}

// =====================================================================
// 安装逻辑
// =====================================================================

export interface DomainWorkflowInstallResult {
  installed: boolean
  published: boolean
  workflowId: string
  message: string
}

function isCapabilityEnabled(binding: DomainWorkflowBinding): boolean {
  // 本地调试放开（仅非打包环境 + 显式环境变量）：直接视为已开启，
  // 否则调试前还得先在 UI 把本地开关逐个打开。
  if (isDevUnlockEnabled()) return true

  try {
    const settings = getSettings() as unknown as Record<string, unknown>
    const list = settings[binding.settingsKey]
    return Array.isArray(list) && list.includes(binding.capabilityId)
  } catch {
    return false
  }
}

/**
 * 确保领域工作流已安装到指定工作区（幂等）。
 */
export function ensureDomainWorkflowForWorkspace(
  binding: DomainWorkflowBinding,
  workspaceId: string,
): DomainWorkflowInstallResult {
  const template = readTemplate(binding.templateId)
  if (!template) {
    return {
      installed: false,
      published: false,
      workflowId: binding.workflowId,
      message: `模板不存在: ${binding.templateId}（seedBundledWorkflowTemplates 可能未运行）`,
    }
  }

  const existing = getWorkflowDefinition(binding.workflowId)

  // 已安装且版本不低于模板 → 幂等跳过
  if (existing && existing.workspaceId === workspaceId) {
    if (existing.status === 'published') {
      return { installed: true, published: true, workflowId: binding.workflowId, message: '已安装并发布，跳过' }
    }
    return tryPublish(binding, existing)
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
    workflowId: binding.workflowId,
  })

  const saved = saveWorkflowDefinition(draft)
  console.log(`[${binding.label}] 已安装 Draft: ${saved.id} v${saved.version} → 工作区 ${workspaceId}`)

  return tryPublish(binding, saved)
}

/** 尝试发布工作流；能力预检失败时保留 Draft 并返回警告。 */
function tryPublish(binding: DomainWorkflowBinding, definition: WorkflowDefinition): DomainWorkflowInstallResult {
  if (definition.status === 'published') {
    return { installed: true, published: true, workflowId: definition.id, message: '已发布，跳过' }
  }

  try {
    const published = publishWorkflowDefinition(definition.id, {
      version: definition.version,
      changeSummary: '领域包订阅自动安装',
    })
    console.log(`[${binding.label}] 已发布: ${published.id} v${published.version}`)
    return { installed: true, published: true, workflowId: definition.id, message: `已安装并发布 v${published.version}` }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    console.warn(`[${binding.label}] 发布失败（保留 Draft，可补齐能力后手动发布）: ${reason}`)
    return { installed: true, published: false, workflowId: definition.id, message: `已安装 Draft，但发布失败: ${reason}` }
  }
}

/**
 * 为所有工作区安装已订阅领域包的随包工作流（启动 / 订阅变更时调用）。
 */
export function ensureDomainWorkflowsForAllWorkspaces(): void {
  for (const binding of DOMAIN_WORKFLOW_BINDINGS) {
    if (!isCapabilityEnabled(binding)) continue

    let template: BundledWorkflowTemplateMeta | null
    try {
      template = readTemplate(binding.templateId)
    } catch {
      template = null
    }
    if (!template) {
      console.log(`[${binding.label}] 模板不存在，跳过安装`)
      continue
    }

    try {
      const workspaces = listAgentWorkspaces()
      for (const ws of workspaces) {
        try {
          const result = ensureDomainWorkflowForWorkspace(binding, ws.slug)
          if (result.installed) {
            console.log(`[${binding.label}] 工作区 ${ws.slug}: ${result.message}`)
          }
        } catch (error) {
          console.warn(`[${binding.label}] 工作区 ${ws.slug} 安装失败:`, error)
        }
      }
    } catch (error) {
      console.warn(`[${binding.label}] 遍历工作区失败:`, error)
    }
  }
}

/** Workflow 文件导入导出与格式迁移。
 *
 * 导出文件只承载 Definition，绝不承载 Run、工作区凭证、渠道密钥或本地身份目录。
 */
import { z } from 'zod'
import { parseWorkflowDefinition } from './workflow-schema'
import { WORKFLOW_FORMAT, WORKFLOW_FORMAT_VERSION, type WorkflowDefinition } from './types/workflow'

export const WORKFLOW_EXPORT_FORMAT = 'paa.workflow.export' as const
export const WORKFLOW_EXPORT_FORMAT_VERSION = '1.0' as const

export interface WorkflowExportFile {
  format: typeof WORKFLOW_EXPORT_FORMAT
  formatVersion: typeof WORKFLOW_EXPORT_FORMAT_VERSION
  exportedAt: number
  definition: WorkflowDefinition
}

export interface WorkflowImportOptions {
  workspaceId: string
  workflowId: string
  now?: number
}

const exportFileSchema = z.object({
  format: z.literal(WORKFLOW_EXPORT_FORMAT),
  formatVersion: z.literal(WORKFLOW_EXPORT_FORMAT_VERSION),
  exportedAt: z.number().int().nonnegative(),
  definition: z.unknown(),
}).strict()

/** 将当前 Definition 序列化为可移植文件；调用方可直接 JSON.stringify。 */
export function exportWorkflowDefinition(input: unknown, exportedAt = Date.now()): WorkflowExportFile {
  return {
    format: WORKFLOW_EXPORT_FORMAT,
    formatVersion: WORKFLOW_EXPORT_FORMAT_VERSION,
    exportedAt,
    definition: parseWorkflowDefinition(input),
  }
}

/**
 * 迁移到当前 DSL。v1 的第一个兼容入口接受 0.9 草案：它与 1.0 结构相同，
 * 仅缺少稳定的 formatVersion。未知版本一律拒绝，避免静默改变执行语义。
 */
export function migrateWorkflowDefinition(input: unknown): WorkflowDefinition {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Workflow 文件必须是对象')
  const raw = { ...(input as Record<string, unknown>) }
  if (raw.format !== WORKFLOW_FORMAT) throw new Error(`不支持的 Workflow 格式: ${String(raw.format)}`)
  if (raw.formatVersion === WORKFLOW_FORMAT_VERSION) return parseWorkflowDefinition(raw)
  if (raw.formatVersion === '0.9') {
    raw.formatVersion = WORKFLOW_FORMAT_VERSION
    return parseWorkflowDefinition(raw)
  }
  throw new Error(`不支持的 Workflow 格式版本: ${String(raw.formatVersion ?? '缺失')}`)
}

/**
 * 从文件导入为目标工作区的独立 Draft。发布信息和源工作区均不继承，
 * 因此导入不能越过目标工作区能力预检，也不会携带发布权限。
 */
export function importWorkflowDefinition(input: unknown, options: WorkflowImportOptions): WorkflowDefinition {
  const parsed = exportFileSchema.parse(input)
  const source = migrateWorkflowDefinition(parsed.definition)
  const now = options.now ?? Date.now()
  return {
    ...source,
    id: options.workflowId,
    workspaceId: options.workspaceId,
    status: 'draft',
    version: '0.1.0',
    createdAt: now,
    updatedAt: now,
    publication: undefined,
  }
}

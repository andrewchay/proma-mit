/**
 * Workflow 运行时工具入口。
 *
 * 这些函数依赖 zod 等运行时库；不放在 shared 顶层，避免 preload（sandbox 环境）
 * 因顶层 export * 把整棵依赖树打包进去。主进程与渲染层通过 '@gravitas/shared/workflow' 子路径引用。
 */

export { applyWorkflowPatches } from './workflow-patch'
export { WorkflowPatchSchema } from './workflow-patch'
export { exportWorkflowDefinition, importWorkflowDefinition, migrateWorkflowDefinition } from './workflow-file'
export { parseWorkflowDefinition, validateWorkflowDefinition } from './workflow-schema'
export type { WorkflowExportFile, WorkflowImportOptions } from './workflow-file'
export type { WorkflowCapabilityViolation } from './workflow-capabilities'
export { validateWorkflowOutput } from './workflow-output-schema'
export type { WorkflowPatchProposal } from './types/workflow'

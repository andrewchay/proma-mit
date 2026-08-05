/**
 * @gravitas/shared - Shared types, configs and utilities
 */

export * from './types/index'
export * from './config/index'
export * from './utils/index'
export * from './constants/permission-rules'
// 注意：workflow-schema / workflow-file / workflow-patch 依赖 zod，
// 不在此处 re-export 运行时值（会拖入 preload sandbox）；
// 运行时函数请从 '@gravitas/shared/workflow' 子路径导入。
// 这里仅 re-export 类型，供 preload 等仅需类型的场景使用。
export type { WorkflowExportFile, WorkflowImportOptions } from './workflow-file'
export * from './workflow-capabilities'
export * from './workflow-output-schema'
export * from './workflow-runtime-policy'

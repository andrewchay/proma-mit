/**
 * 学术助手纯算法模块
 *
 * 从 PAA 的 @paa/core/services/academic 迁移，无 Electron/Node 依赖。
 * 覆盖五阶段 pipeline 中的选题研究、完整性检查、同行评审模拟、
 * 修订追踪与发表准备。
 *
 * 类型契约来自 @gravitas/shared（见 types/academic.ts）。
 */
export * from './citation-verifier'
export * from './data-consistency-checker'
export * from './logic-scanner'
export * from './integrity-checker'
export * from './peer-review-simulator'
export * from './revision-tracker'
export * from './publication-preparer'
export * from './topic-researcher'
export * from './research-rules'
export * from './research-rules'
export * from './source-identity'
export * from './bibliography-import'
export * from './evidence-policy'
export * from './research-profiles'
export * from './protocol-rules'
export * from './topic-rules'
export * from './run-rules'

/**
 * Electron 应用内部类型导出
 *
 * 仅在 Electron 进程间使用的类型定义（主进程 / preload / 渲染进程）。
 */

export * from './settings'
export * from './user-profile'
export { SUBSCRIPTION_IPC_CHANNELS, OUTBOUND_MAIL_IPC_CHANNELS, KNOWLEDGE_IPC_CHANNELS, ANALYSIS_IPC_CHANNELS, ACADEMIC_IPC_CHANNELS } from '@gravitas/shared'

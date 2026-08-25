/**
 * 配置版本化类型定义
 *
 * 工作区配置快照与回滚系统。
 */

import type { WorkspaceMcpConfig } from './agent'

/** 工作区配置快照 */
export interface WorkspaceConfigSnapshot {
  /** 快照唯一标识 */
  id: string
  /** 所属工作区 slug */
  workspaceSlug: string
  /** 创建时间戳 */
  timestamp: number
  /** 用户备注描述 */
  description: string
  /** 触发方式 */
  triggeredBy: 'manual' | 'auto' | 'pre-update'
  /** 快照配置内容 */
  config: WorkspaceSnapshotConfig
}

/** 工作区快照配置内容 */
export interface WorkspaceSnapshotConfig {
  /** MCP 服务器配置 */
  mcpServers: WorkspaceMcpConfig
  /** 附加目录列表 */
  attachedDirectories: string[]
  /** 附加文件列表 */
  attachedFiles: string[]
}

/** 创建快照输入 */
export interface CreateWorkspaceSnapshotInput {
  /** 用户备注 */
  description?: string
  /** 触发方式 */
  triggeredBy?: 'manual' | 'auto' | 'pre-update'
}

/** 恢复快照结果 */
export interface RestoreSnapshotResult {
  /** 是否成功 */
  success: boolean
  /** 恢复的快照 ID */
  snapshotId: string
  /** 错误信息 */
  error?: string
}

/**
 * 配置版本化 IPC 通道常量
 */
export const CONFIG_VERSION_IPC_CHANNELS = {
  /** 创建工作区配置快照 */
  CREATE_SNAPSHOT: 'config-version:create-snapshot',
  /** 列出工作区配置快照 */
  LIST_SNAPSHOTS: 'config-version:list-snapshots',
  /** 获取指定快照 */
  GET_SNAPSHOT: 'config-version:get-snapshot',
  /** 恢复快照 */
  RESTORE_SNAPSHOT: 'config-version:restore-snapshot',
  /** 删除快照 */
  DELETE_SNAPSHOT: 'config-version:delete-snapshot',
} as const

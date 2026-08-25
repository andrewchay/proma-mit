/**
 * 工作区配置版本化服务
 *
 * 负责工作区配置的快照、列出、恢复和删除。
 * 快照存储在 ~/.gravitas/agent-workspaces/{slug}/snapshots/ 下。
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, unlinkSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import {
  getWorkspaceSnapshotPath,
  getWorkspaceSnapshotsDir,
  getWorkspaceMcpPath,
} from './config-paths'
import {
  getWorkspaceMcpConfig,
  getWorkspaceAttachedDirectories,
  getWorkspaceAttachedFiles,
} from './agent-workspace-manager'
import type {
  WorkspaceConfigSnapshot,
  WorkspaceSnapshotConfig,
  CreateWorkspaceSnapshotInput,
  RestoreSnapshotResult,
} from '@gravitas/shared'

/** 单个工作区最大快照数量 */
const MAX_SNAPSHOTS_PER_WORKSPACE = 50

/**
 * 创建配置快照
 *
 * 自动读取当前工作区的 MCP 配置、附加目录和附加文件，保存为快照。
 */
export function createWorkspaceSnapshot(
  workspaceSlug: string,
  input: CreateWorkspaceSnapshotInput = {},
): WorkspaceConfigSnapshot {
  const mcpConfig = getWorkspaceMcpConfig(workspaceSlug)
  const attachedDirectories = getWorkspaceAttachedDirectories(workspaceSlug)
  const attachedFiles = getWorkspaceAttachedFiles(workspaceSlug)

  const config: WorkspaceSnapshotConfig = {
    mcpServers: mcpConfig,
    attachedDirectories,
    attachedFiles,
  }

  const snapshot: WorkspaceConfigSnapshot = {
    id: randomUUID(),
    workspaceSlug,
    timestamp: Date.now(),
    description: input.description ?? '',
    triggeredBy: input.triggeredBy ?? 'manual',
    config,
  }

  const path = getWorkspaceSnapshotPath(workspaceSlug, snapshot.id)
  writeFileSync(path, JSON.stringify(snapshot, null, 2), 'utf-8')

  // 清理旧快照，保留最近 MAX_SNAPSHOTS_PER_WORKSPACE 个
  cleanupOldSnapshots(workspaceSlug)

  console.log(`[配置版本化] 已创建工作区快照: ${workspaceSlug}/${snapshot.id}`)
  return snapshot
}

/**
 * 在配置更新前自动创建快照
 *
 * 用于在关键操作（保存 MCP、添加目录等）前自动备份当前配置。
 */
export function autoSnapshotBeforeUpdate(
  workspaceSlug: string,
  actionDescription: string,
): WorkspaceConfigSnapshot {
  return createWorkspaceSnapshot(workspaceSlug, {
    description: `自动快照: ${actionDescription}`,
    triggeredBy: 'pre-update',
  })
}

/**
 * 列出工作区的所有快照
 *
 * 按时间戳降序排列（最新的在前）。
 */
export function listWorkspaceSnapshots(workspaceSlug: string): WorkspaceConfigSnapshot[] {
  const dir = getWorkspaceSnapshotsDir(workspaceSlug)

  try {
    const entries = readdirSync(dir, { withFileTypes: true })
    const snapshots: WorkspaceConfigSnapshot[] = []

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue

      try {
        const raw = readFileSync(`${dir}/${entry.name}`, 'utf-8')
        const parsed = JSON.parse(raw) as WorkspaceConfigSnapshot
        // 基本校验
        if (parsed.id && parsed.workspaceSlug === workspaceSlug && parsed.timestamp) {
          snapshots.push(parsed)
        }
      } catch {
        // 跳过损坏的快照文件
      }
    }

    return snapshots.sort((a, b) => b.timestamp - a.timestamp)
  } catch {
    return []
  }
}

/**
 * 获取指定快照
 */
export function getWorkspaceSnapshot(
  workspaceSlug: string,
  snapshotId: string,
): WorkspaceConfigSnapshot | null {
  const path = getWorkspaceSnapshotPath(workspaceSlug, snapshotId)

  if (!existsSync(path)) {
    return null
  }

  try {
    const raw = readFileSync(path, 'utf-8')
    return JSON.parse(raw) as WorkspaceConfigSnapshot
  } catch {
    return null
  }
}

/**
 * 恢复快照
 *
 * 将工作区配置恢复到指定快照的状态。
 * 恢复前会自动创建当前配置的备份快照。
 */
export function restoreWorkspaceSnapshot(
  workspaceSlug: string,
  snapshotId: string,
): RestoreSnapshotResult {
  // 1. 先备份当前配置
  const backup = autoSnapshotBeforeUpdate(workspaceSlug, `恢复前备份 (目标: ${snapshotId})`)

  // 2. 读取目标快照
  const snapshot = getWorkspaceSnapshot(workspaceSlug, snapshotId)
  if (!snapshot) {
    return {
      success: false,
      snapshotId,
      error: `快照不存在: ${snapshotId}`,
    }
  }

  try {
    // 3. 恢复 MCP 配置
    const { saveWorkspaceMcpConfig } = require('./agent-workspace-manager')
    saveWorkspaceMcpConfig(workspaceSlug, snapshot.config.mcpServers)

    // 4. 恢复附加目录和文件（通过写 config.json）
    const configPath = `${getWorkspaceSnapshotsDir(workspaceSlug).replace('/snapshots', '')}/config.json`
    const config = {
      attachedDirectories: snapshot.config.attachedDirectories,
      attachedFiles: snapshot.config.attachedFiles,
    }
    writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8')

    console.log(`[配置版本化] 已恢复工作区快照: ${workspaceSlug} → ${snapshotId} (备份: ${backup.id})`)
    return {
      success: true,
      snapshotId,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : '未知错误'
    console.error(`[配置版本化] 恢复快照失败: ${workspaceSlug}/${snapshotId}`, error)
    return {
      success: false,
      snapshotId,
      error: message,
    }
  }
}

/**
 * 删除快照
 */
export function deleteWorkspaceSnapshot(workspaceSlug: string, snapshotId: string): boolean {
  const path = getWorkspaceSnapshotPath(workspaceSlug, snapshotId)

  if (!existsSync(path)) {
    return false
  }

  try {
    unlinkSync(path)
    console.log(`[配置版本化] 已删除工作区快照: ${workspaceSlug}/${snapshotId}`)
    return true
  } catch (error) {
    console.error(`[配置版本化] 删除快照失败: ${workspaceSlug}/${snapshotId}`, error)
    return false
  }
}

/**
 * 清理旧快照
 *
 * 当快照数量超过 MAX_SNAPSHOTS_PER_WORKSPACE 时，删除最旧的快照。
 * 保留所有手动创建的快照，只删除自动快照。
 */
function cleanupOldSnapshots(workspaceSlug: string): void {
  const snapshots = listWorkspaceSnapshots(workspaceSlug)

  if (snapshots.length <= MAX_SNAPSHOTS_PER_WORKSPACE) {
    return
  }

  // 只删除超出限制的最旧的 auto 快照
  const autoSnapshots = snapshots.filter((s) => s.triggeredBy === 'auto')
  const toDelete = autoSnapshots.slice(MAX_SNAPSHOTS_PER_WORKSPACE - snapshots.length)

  for (const snapshot of toDelete) {
    deleteWorkspaceSnapshot(workspaceSlug, snapshot.id)
  }
}

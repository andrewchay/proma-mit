/**
 * 工作区配置快照设置页面
 *
 * 显示工作区配置版本历史，支持创建快照、恢复和删除。
 */

import * as React from 'react'
import { toast } from 'sonner'
import {
  Camera,
  RotateCcw,
  Trash2,
  Clock,
  User,
  Zap,
  ChevronDown,
  ChevronUp,
  Server,
  FolderOpen,
  FileText,
} from 'lucide-react'
import type { WorkspaceConfigSnapshot, RestoreSnapshotResult } from '@gravitas/shared'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { SettingsCard, SettingsSection } from './primitives'

interface WorkspaceSnapshotSettingsProps {
  workspaceSlug: string
}

export function WorkspaceSnapshotSettings({ workspaceSlug }: WorkspaceSnapshotSettingsProps): React.ReactElement {
  const [snapshots, setSnapshots] = React.useState<WorkspaceConfigSnapshot[]>([])
  const [loading, setLoading] = React.useState(false)
  const [description, setDescription] = React.useState('')
  const [creating, setCreating] = React.useState(false)
  const [expandedIds, setExpandedIds] = React.useState<Set<string>>(new Set())
  const [restoreTarget, setRestoreTarget] = React.useState<WorkspaceConfigSnapshot | null>(null)
  const [deleteTarget, setDeleteTarget] = React.useState<WorkspaceConfigSnapshot | null>(null)

  const loadSnapshots = React.useCallback(async () => {
    setLoading(true)
    try {
      const data = await window.electronAPI.listWorkspaceSnapshots(workspaceSlug)
      setSnapshots(data)
    } catch (error) {
      console.error('[配置快照] 读取失败:', error)
      toast.error('读取配置快照失败')
    } finally {
      setLoading(false)
    }
  }, [workspaceSlug])

  React.useEffect(() => { void loadSnapshots() }, [loadSnapshots])

  const createSnapshot = async (): Promise<void> => {
    setCreating(true)
    try {
      const snapshot = await window.electronAPI.createWorkspaceSnapshot(workspaceSlug, {
        description: description.trim() || undefined,
        triggeredBy: 'manual',
      })
      toast.success('配置快照已创建')
      setDescription('')
      setSnapshots((prev) => [snapshot, ...prev])
    } catch (error) {
      console.error('[配置快照] 创建失败:', error)
      toast.error('创建配置快照失败')
    } finally {
      setCreating(false)
    }
  }

  const restoreSnapshot = async (snapshot: WorkspaceConfigSnapshot): Promise<void> => {
    try {
      const result: RestoreSnapshotResult = await window.electronAPI.restoreWorkspaceSnapshot(workspaceSlug, snapshot.id)
      if (result.success) {
        toast.success('配置已恢复到选定快照')
        void loadSnapshots()
      } else {
        toast.error(result.error || '恢复失败')
      }
    } catch (error) {
      console.error('[配置快照] 恢复失败:', error)
      toast.error('恢复配置快照失败')
    } finally {
      setRestoreTarget(null)
    }
  }

  const deleteSnapshot = async (snapshot: WorkspaceConfigSnapshot): Promise<void> => {
    try {
      const success = await window.electronAPI.deleteWorkspaceSnapshot(workspaceSlug, snapshot.id)
      if (success) {
        toast.success('快照已删除')
        setSnapshots((prev) => prev.filter((s) => s.id !== snapshot.id))
      } else {
        toast.error('删除失败')
      }
    } catch (error) {
      console.error('[配置快照] 删除失败:', error)
      toast.error('删除快照失败')
    } finally {
      setDeleteTarget(null)
    }
  }

  const toggleExpand = (id: string): void => {
    setExpandedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  return (
    <div className="space-y-5">
      <SettingsSection
        title="配置快照"
        description="为当前工作区创建配置快照，可在需要时恢复到之前的状态。快照包含 MCP 服务器配置、附加目录和文件列表。"
      >
        <SettingsCard className="space-y-4">
          <div className="flex flex-wrap items-end gap-3">
            <label className="grid gap-1.5 text-sm text-muted-foreground flex-1 min-w-[200px]">
              快照备注（可选）
              <Input
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="描述此次快照的用途..."
              />
            </label>
            <Button onClick={() => void createSnapshot()} disabled={creating}>
              <Camera className="mr-2 size-4" />
              {creating ? '创建中…' : '创建快照'}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            自动快照会在保存 MCP 配置或更新工作区前自动创建。每个工作区最多保留 50 个快照。
          </p>
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title="快照历史">
        {loading && snapshots.length === 0 ? (
          <SettingsCard className="py-10 text-center text-sm text-muted-foreground">加载中…</SettingsCard>
        ) : snapshots.length === 0 ? (
          <SettingsCard className="py-10 text-center text-sm text-muted-foreground">
            暂无配置快照。创建第一个快照以开始版本管理。
          </SettingsCard>
        ) : (
          <div className="space-y-2">
            {snapshots.map((snapshot) => (
              <SnapshotCard
                key={snapshot.id}
                snapshot={snapshot}
                expanded={expandedIds.has(snapshot.id)}
                onToggle={() => toggleExpand(snapshot.id)}
                onRestore={() => setRestoreTarget(snapshot)}
                onDelete={() => setDeleteTarget(snapshot)}
              />
            ))}
          </div>
        )}
      </SettingsSection>

      {/* 恢复确认对话框 */}
      <AlertDialog open={restoreTarget !== null} onOpenChange={(open) => { if (!open) setRestoreTarget(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>恢复配置快照？</AlertDialogTitle>
            <AlertDialogDescription>
              这将把当前工作区配置恢复到 {restoreTarget ? formatTimestamp(restoreTarget.timestamp) : ''} 的状态。
              恢复前会自动创建当前配置的备份快照。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setRestoreTarget(null)}>取消</AlertDialogCancel>
            <AlertDialogAction onClick={() => restoreTarget && void restoreSnapshot(restoreTarget)}>
              确认恢复
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* 删除确认对话框 */}
      <AlertDialog open={deleteTarget !== null} onOpenChange={(open) => { if (!open) setDeleteTarget(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除配置快照？</AlertDialogTitle>
            <AlertDialogDescription>
              此操作不可撤销。快照 {deleteTarget?.id.slice(0, 8)}… 将被永久删除。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setDeleteTarget(null)}>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteTarget && void deleteSnapshot(deleteTarget)}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function SnapshotCard({
  snapshot,
  expanded,
  onToggle,
  onRestore,
  onDelete,
}: {
  snapshot: WorkspaceConfigSnapshot
  expanded: boolean
  onToggle: () => void
  onRestore: () => void
  onDelete: () => void
}): React.ReactElement {
  const isAuto = snapshot.triggeredBy === 'auto' || snapshot.triggeredBy === 'pre-update'

  return (
    <SettingsCard className="space-y-2">
      <button
        onClick={onToggle}
        className="w-full flex items-center justify-between text-left"
      >
        <div className="flex items-center gap-2 text-sm">
          {isAuto ? <Zap className="size-4 text-amber-500" /> : <Camera className="size-4 text-blue-500" />}
          <span className="font-medium">{snapshot.description || '未命名快照'}</span>
          <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground">
            {snapshot.id.slice(0, 8)}…
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">{formatTimestamp(snapshot.timestamp)}</span>
          {expanded ? <ChevronUp className="size-4 text-muted-foreground" /> : <ChevronDown className="size-4 text-muted-foreground" />}
        </div>
      </button>

      {expanded && (
        <div className="pt-2 space-y-3 border-t">
          <div className="grid grid-cols-2 gap-2 text-xs text-muted-foreground">
            <div className="flex items-center gap-1.5">
              <Clock className="size-3.5" />
              <span>触发方式: {TRIGGER_LABEL[snapshot.triggeredBy]}</span>
            </div>
            <div className="flex items-center gap-1.5">
              <Server className="size-3.5" />
              <span>MCP 服务器: {Object.keys(snapshot.config.mcpServers.servers ?? {}).length} 个</span>
            </div>
            <div className="flex items-center gap-1.5">
              <FolderOpen className="size-3.5" />
              <span>附加目录: {snapshot.config.attachedDirectories.length} 个</span>
            </div>
            <div className="flex items-center gap-1.5">
              <FileText className="size-3.5" />
              <span>附加文件: {snapshot.config.attachedFiles.length} 个</span>
            </div>
          </div>

          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={onRestore}>
              <RotateCcw className="mr-1.5 size-3.5" />
              恢复到此版本
            </Button>
            <Button variant="outline" size="sm" className="text-destructive hover:bg-destructive/10" onClick={onDelete}>
              <Trash2 className="mr-1.5 size-3.5" />
              删除
            </Button>
          </div>
        </div>
      )}
    </SettingsCard>
  )
}

const TRIGGER_LABEL: Record<string, string> = {
  manual: '手动',
  auto: '自动',
  'pre-update': '更新前自动',
}

function formatTimestamp(ts: number): string {
  return new Date(ts).toLocaleString('zh-CN')
}

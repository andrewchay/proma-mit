/**
 * TeamSkillDirectoryPanel — 团队 Skills 目录（PH2-A）
 *
 * 轻量团队协作共享：把「所有工作区从别处导入的 Skill」汇总为目录，
 * 显示来源工作区、版本、是否过期(待同步)，并支持一键同步所有过期导入。
 * 复用既有 importSkillFromWorkspace/updateSkillFromSource 能力。
 */

import * as React from 'react'
import { SettingsSection, SettingsCard } from './primitives'
import { Button } from '@/components/ui/button'
import { toast } from 'sonner'
import { RefreshCw, CheckCircle2 } from 'lucide-react'
import type { TeamSkillUpstream } from '@gravitas/shared'

export function TeamSkillDirectoryPanel(): React.ReactElement {
  const [groups, setGroups] = React.useState<TeamSkillUpstream[]>([])
  const [pending, setPending] = React.useState(0)
  const [loading, setLoading] = React.useState(true)
  const [syncing, setSyncing] = React.useState(false)

  const load = React.useCallback(async (): Promise<void> => {
    try {
      const res = await window.electronAPI.listTeamSkillUpstreams()
      setGroups(res.groups)
      setPending(res.pending)
    } catch (err) {
      console.error('[团队 Skills] 加载失败:', err)
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => { void load() }, [load])

  const handleSyncAll = async (): Promise<void> => {
    if (syncing || pending === 0) return
    setSyncing(true)
    try {
      const res = await window.electronAPI.syncTeamSkillUpdates()
      toast.success(`已同步 ${res.updated.length} 个 Skill${res.failed.length ? `，${res.failed.length} 个失败` : ''}`)
      await load()
    } catch (err) {
      toast.error('同步失败')
      console.error(err)
    } finally {
      setSyncing(false)
    }
  }

  const totalImported = groups.reduce((acc, g) => acc + g.imported.length, 0)

  return (
    <SettingsSection
      title="团队 Skills 目录"
      description={`汇总各工作区从别处导入的 Skill（${totalImported} 个导入 · ${pending} 个待同步）`}
      action={
        <Button variant="outline" size="sm" onClick={() => void handleSyncAll()} disabled={syncing || pending === 0}>
          <RefreshCw size={14} className={syncing ? 'animate-spin' : ''} />
          同步全部待更新
        </Button>
      }
    >
      <SettingsCard divided>
        {loading ? (
          <div className="p-6 text-center text-sm text-muted-foreground">加载中…</div>
        ) : groups.length === 0 ? (
          <div className="p-6 text-center text-sm text-muted-foreground">
            暂无跨工作区导入的 Skill。在「Skills」里从其他工作区导入后，会在此展示并支持一键同步。
          </div>
        ) : (
          groups.map((group) => (
            <div key={group.workspaceSlug} className="p-3 border-b border-border/30 last:border-b-0">
              <div className="text-xs font-medium text-muted-foreground mb-2">{group.workspaceName}</div>
              <div className="space-y-1.5">
                {group.imported.map((skill) => (
                  <div key={skill.slug} className="flex items-center gap-2 text-[12px]">
                    <span className={`px-1.5 py-0.5 rounded text-[10px] ${skill.enabled ? 'bg-emerald-500/10 text-emerald-600' : 'bg-muted text-muted-foreground'}`}>
                      {skill.enabled ? '启用' : '停用'}
                    </span>
                    <span className="truncate flex-1">{skill.name}</span>
                    <span className="shrink-0 text-muted-foreground">← {skill.importSource.sourceWorkspaceName}</span>
                    {skill.version && <span className="shrink-0 text-muted-foreground">v{skill.version}</span>}
                    {skill.hasUpdate ? (
                      <span className="shrink-0 flex items-center gap-1 px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-600 text-[10px]">
                        <RefreshCw size={10} /> 待同步
                      </span>
                    ) : (
                      <span className="shrink-0 flex items-center gap-1 px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-600 text-[10px]">
                        <CheckCircle2 size={10} /> 已最新
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ))
        )}
      </SettingsCard>
    </SettingsSection>
  )
}

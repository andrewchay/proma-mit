/**
 * AgentAllowlistPanel — 跨会话持久化「始终允许」白名单管理
 *
 * 用户对某工具/命令族/Web Bridge 站点点「始终允许」后，会写入 settings.json 的
 * agentAllowlist（跨会话沿用）。此面板用于查看与移除这些记录。
 *
 * 安全说明：本项目只有经过安全守卫（危险命令拦截 / Computer Use / Web Bridge
 * 上传下载逐次确认）的工具/命令族/站点才会落库；高危操作永不出现于此。
 */

import * as React from 'react'
import { X } from 'lucide-react'
import { SettingsSection, SettingsCard } from './primitives'
import { Button } from '@/components/ui/button'

type Allowlist = {
  allowedTools: string[]
  allowedBashCommands: string[]
  trustedWebBridgeHosts: string[]
}

/** 分组标签：把三类记录平铺成带类型标识的可移除行 */
type Row = { kind: 'tool' | 'command' | 'host'; label: string; value: string }

export function AgentAllowlistPanel(): React.ReactElement | null {
  const [allowlist, setAllowlist] = React.useState<Allowlist | null>(null)
  const [loaded, setLoaded] = React.useState(false)
  const [busy, setBusy] = React.useState<string | null>(null)

  const refresh = React.useCallback(async () => {
    try {
      const data = await window.electronAPI.getAgentAllowlist()
      setAllowlist(data)
    } catch (error) {
      console.error('[AgentAllowlistPanel] 读取失败:', error)
    } finally {
      setLoaded(true)
    }
  }, [])

  React.useEffect(() => {
    void refresh()
  }, [refresh])

  const rows: Row[] = React.useMemo(() => {
    if (!allowlist) return []
    const list: Row[] = []
    for (const t of allowlist.allowedTools ?? []) list.push({ kind: 'tool', label: '工具', value: t })
    for (const c of allowlist.allowedBashCommands ?? []) list.push({ kind: 'command', label: '命令', value: c })
    for (const h of allowlist.trustedWebBridgeHosts ?? []) list.push({ kind: 'host', label: '站点', value: h })
    return list
  }, [allowlist])

  const remove = async (value: string): Promise<void> => {
    if (busy) return
    setBusy(value)
    try {
      const next = await window.electronAPI.removeAgentAllowlistEntry(value)
      setAllowlist(next)
    } catch (error) {
      console.error('[AgentAllowlistPanel] 移除失败:', error)
    } finally {
      setBusy(null)
    }
  }

  // 空列表：整个面板不渲染（保持设置页干净）
  if (loaded && rows.length === 0) return null
  if (!allowlist) return null

  const kindBadge: Record<Row['kind'], string> = {
    tool: 'bg-primary/10 text-primary',
    command: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
    host: 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
  }

  return (
    <SettingsSection
      title="始终允许（跨会话）"
      description="你在权限弹窗中选择「始终允许」的工具、命令或站点，会在此跨会话保留，后续不再询问。危险操作（rm/sudo、Computer Use、Web Bridge 上传下载）始终逐次确认，不会出现在这里。"
    >
      <SettingsCard divided>
        {rows.map((row) => (
          <div key={`${row.kind}:${row.value}`} className="flex items-center justify-between gap-3 p-3">
            <div className="flex items-center gap-2.5 min-w-0">
              <span className={`shrink-0 text-[10px] px-1.5 py-0.5 rounded-full font-medium ${kindBadge[row.kind]}`}>
                {row.label}
              </span>
              <span className="text-sm font-mono truncate text-foreground/90">{row.value}</span>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void remove(row.value)}
              disabled={busy === row.value}
              className="h-7 px-2 text-muted-foreground hover:text-destructive"
            >
              <X className="size-3.5" />
              <span className="ml-1 text-xs">移除</span>
            </Button>
          </div>
        ))}
      </SettingsCard>
    </SettingsSection>
  )
}

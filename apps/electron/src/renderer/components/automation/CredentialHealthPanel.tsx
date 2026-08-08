/**
 * CredentialHealthPanel — 凭据统一体检（PH2-D）
 *
 * 一处查看所有凭据（渠道/飞书/钉钉/MCP secret）的登记与加密状态、风险项，
 * 实现凭据统一治理的可见性。
 */

import * as React from 'react'
import { KeyRound, RefreshCw, TriangleAlert, ShieldCheck } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { CredentialEntry } from '@gravitas/shared'

const KIND_LABEL: Record<string, string> = {
  channel: '渠道',
  feishu_bot: '飞书 Bot',
  dingtalk_bot: '钉钉 Bot',
  mcp_client_secret: 'MCP Secret',
}

export function CredentialHealthPanel(): React.ReactElement {
  const [entries, setEntries] = React.useState<CredentialEntry[]>([])
  const [risks, setRisks] = React.useState<string[]>([])
  const [loading, setLoading] = React.useState(true)

  const load = React.useCallback(async (): Promise<void> => {
    try {
      const res = await window.electronAPI.listCredentialRegistry()
      setEntries(res.registry.entries)
      setRisks(res.registry.risks)
    } catch {
      setEntries([])
      setRisks([])
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => { void load() }, [load])

  return (
    <div className="rounded-lg border border-border/50 bg-foreground/[0.02] p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <KeyRound size={16} className="text-muted-foreground" />
          <div>
            <h3 className="text-sm font-medium">凭据统一体检</h3>
            <p className="text-xs text-muted-foreground mt-0.5">
              渠道 / 飞书 / 钉钉 / MCP Secret（{entries.length} 项登记）
            </p>
          </div>
        </div>
        <Button variant="outline" size="sm" onClick={() => { setLoading(true); void load() }} disabled={loading}>
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} /> 刷新
        </Button>
      </div>

      {risks.length > 0 && (
        <div className="rounded-md bg-amber-500/10 text-amber-600 px-3 py-2 text-xs space-y-0.5">
          <div className="flex items-center gap-1.5 font-medium"><TriangleAlert size={13} /> 风险 {risks.length} 项</div>
          {risks.map((r, i) => <div key={i}>· {r}</div>)}
        </div>
      )}
      {risks.length === 0 && !loading && (
        <div className="rounded-md bg-emerald-500/10 text-emerald-600 px-3 py-2 text-xs flex items-center gap-1.5">
          <ShieldCheck size={13} /> 凭据均已配置，无风险
        </div>
      )}

      {loading ? (
        <div className="py-4 text-center text-sm text-muted-foreground">加载中…</div>
      ) : (
        <div className="max-h-48 overflow-auto space-y-1">
          {entries.map((e) => (
            <div key={`${e.kind}-${e.id}`} className="flex items-center gap-2 text-xs py-1">
              <span className="px-1.5 py-0.5 rounded bg-foreground/[0.06] text-foreground/60 text-[10px]">{KIND_LABEL[e.kind] ?? e.kind}</span>
              <span className="truncate flex-1 text-foreground/80">{e.label}</span>
              <span className={`shrink-0 px-1.5 py-0.5 rounded text-[10px] ${e.hasSecret ? 'bg-emerald-500/10 text-emerald-600' : 'bg-amber-500/10 text-amber-600'}`}>
                {e.hasSecret ? '已配置' : '缺密钥'}
              </span>
              <span className={`shrink-0 px-1.5 py-0.5 rounded text-[10px] ${e.encrypted ? 'bg-foreground/[0.06] text-foreground/60' : 'bg-amber-500/10 text-amber-600'}`}>
                {e.encrypted ? '加密' : '明文'}
              </span>
            </div>
          ))}
          {entries.length === 0 && !loading && <div className="py-4 text-center text-sm text-muted-foreground">暂无已登记凭据</div>}
        </div>
      )}
    </div>
  )
}

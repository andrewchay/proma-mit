/**
 * CredentialHealthPanel — 凭据统一体检（PH2-D）
 *
 * 一处查看所有凭据（渠道/飞书/钉钉/MCP secret）的登记与加密状态、风险项，
 * 实现凭据统一治理的可见性。
 */

import * as React from 'react'
import { KeyRound, RefreshCw, TriangleAlert, ShieldCheck, ShieldAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { CredentialEntry } from '@gravitas/shared'

const KIND_LABEL: Record<string, string> = {
  channel: '渠道',
  feishu_bot: '飞书 Bot',
  dingtalk_bot: '钉钉 Bot',
  mcp_client_secret: 'MCP Secret',
  new_media_account: '新媒体账号',
}

export function CredentialHealthPanel(): React.ReactElement {
  const [entries, setEntries] = React.useState<CredentialEntry[]>([])
  const [risks, setRisks] = React.useState<string[]>([])
  const [sourceErrors, setSourceErrors] = React.useState<string[]>([])
  const [checkedAt, setCheckedAt] = React.useState<number | null>(null)
  const [loadError, setLoadError] = React.useState('')
  const [loading, setLoading] = React.useState(true)

  const load = React.useCallback(async (): Promise<void> => {
    setLoadError('')
    try {
      const res = await window.electronAPI.listCredentialRegistry()
      // 读取失败绝不能伪装成「无风险」：保留错误列表，且不下发「已通过」结论。
      setEntries(res.registry.entries)
      setRisks(res.registry.risks)
      setSourceErrors(res.registry.sourceErrors ?? [])
      setCheckedAt(res.registry.checkedAt ?? null)
    } catch (error) {
      // 整体调用失败时：清空数据避免展示过期结论，并明确标记体检不可用。
      setEntries([])
      setRisks([])
      setSourceErrors([])
      setCheckedAt(null)
      setLoadError(error instanceof Error ? error.message : '凭据体检调用失败')
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
              渠道 / 飞书 / 钉钉 / MCP Secret / 新媒体账号（{entries.length} 项登记{checkedAt ? ` · 检查于 ${new Date(checkedAt).toLocaleString()}` : ''}）
            </p>
          </div>
        </div>
        <Button variant="outline" size="sm" onClick={() => { setLoading(true); void load() }} disabled={loading}>
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} /> 刷新
        </Button>
      </div>

      {loadError && (
        <div className="rounded-md bg-destructive/10 text-destructive px-3 py-2 text-xs flex items-center gap-1.5">
          <ShieldAlert size={13} /> 体检不可用：{loadError}。以下为最近一次成功检查的结果（如有）。
        </div>
      )}
      {sourceErrors.length > 0 && (
        <div className="rounded-md bg-amber-500/10 text-amber-600 px-3 py-2 text-xs space-y-0.5">
          <div className="flex items-center gap-1.5 font-medium"><TriangleAlert size={13} /> 来源检查失败 {sourceErrors.length} 项（结果不完整）</div>
          {sourceErrors.map((message, i) => <div key={i}>· {message}</div>)}
        </div>
      )}
      {risks.length > 0 && (
        <div className="rounded-md bg-amber-500/10 text-amber-600 px-3 py-2 text-xs space-y-0.5">
          <div className="flex items-center gap-1.5 font-medium"><TriangleAlert size={13} /> 风险 {risks.length} 项</div>
          {risks.map((r, i) => <div key={i}>· {r}</div>)}
        </div>
      )}
      {risks.length === 0 && sourceErrors.length === 0 && !loadError && !loading && (
        <div className="rounded-md bg-emerald-500/10 text-emerald-600 px-3 py-2 text-xs flex items-center gap-1.5">
          <ShieldCheck size={13} /> 凭据均已配置，未发现风险
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

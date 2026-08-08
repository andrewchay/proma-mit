/**
 * CostAuditPanel — 费用审计（PH2-C）
 *
 * 手动/定时运行费用审计，展示总费用、token、环比、Top 模型/会话、异常告警。
 * 也供 Agent 的 RunCostAudit 工具底层复用。
 */

import * as React from 'react'
import { Wallet, RefreshCw, TriangleAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { CostAuditReport } from '@gravitas/shared'

export function CostAuditPanel(): React.ReactElement {
  const [report, setReport] = React.useState<CostAuditReport | null>(null)
  const [running, setRunning] = React.useState(false)
  const [error, setError] = React.useState('')

  const run = async (): Promise<void> => {
    setRunning(true)
    setError('')
    try {
      const res = await window.electronAPI.runCostAudit({})
      setReport(res.report)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setRunning(false)
    }
  }

  React.useEffect(() => { void run() }, [])

  return (
    <div className="rounded-lg border border-border/50 bg-foreground/[0.02] p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Wallet size={16} className="text-muted-foreground" />
          <div>
            <h3 className="text-sm font-medium">费用审计</h3>
            <p className="text-xs text-muted-foreground mt-0.5">近 7 天 Token/费用审计与异常告警</p>
          </div>
        </div>
        <Button variant="outline" size="sm" onClick={() => void run()} disabled={running}>
          <RefreshCw size={14} className={running ? 'animate-spin' : ''} /> 运行审计
        </Button>
      </div>

      {error && <div className="rounded-md bg-destructive/10 text-destructive px-3 py-2 text-xs">{error}</div>}
      {!report && !error && <div className="py-4 text-center text-sm text-muted-foreground">生成报告中…</div>}
      {report && (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
            <div className="rounded-md bg-foreground/[0.04] px-3 py-2">
              <div className="text-muted-foreground">总费用</div>
              <div className="font-medium">${report.totalCost.toFixed(3)}</div>
            </div>
            <div className="rounded-md bg-foreground/[0.04] px-3 py-2">
              <div className="text-muted-foreground">总 Token</div>
              <div className="font-medium">{report.totalTokens}</div>
            </div>
            <div className="rounded-md bg-foreground/[0.04] px-3 py-2">
              <div className="text-muted-foreground">上窗口</div>
              <div className="font-medium">${report.previousTotalCost.toFixed(3)}</div>
            </div>
            <div className="rounded-md bg-foreground/[0.04] px-3 py-2">
              <div className="text-muted-foreground">环比</div>
              <div className="font-medium">{report.costChangeRatio ? `${(report.costChangeRatio * 100).toFixed(0)}%` : '—'}</div>
            </div>
          </div>

          {report.byModel.length > 0 && (
            <div className="text-xs">
              <div className="text-muted-foreground mb-1">按模型</div>
              <div className="flex flex-wrap gap-1.5">
                {report.byModel.slice(0, 4).map((m) => (
                  <span key={m.modelId} className="px-1.5 py-0.5 rounded bg-foreground/[0.06] text-foreground/70">{m.modelId} · ${m.costTotal.toFixed(3)}</span>
                ))}
              </div>
            </div>
          )}

          {report.topSessions.length > 0 && (
            <div className="text-xs">
              <div className="text-muted-foreground mb-1">Top 消耗会话</div>
              <div className="space-y-1">
                {report.topSessions.slice(0, 5).map((s) => (
                  <div key={s.sessionId} className="flex justify-between py-0.5">
                    <span className="truncate text-foreground/70">{s.sessionId.slice(0, 24)}…</span>
                    <span className="shrink-0 text-foreground/60">${s.costTotal.toFixed(3)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {report.hasAlerts ? (
            <div className="rounded-md bg-amber-500/10 text-amber-600 px-3 py-2 text-xs space-y-0.5">
              <div className="flex items-center gap-1.5 font-medium"><TriangleAlert size={13} /> 异常告警</div>
              {report.alerts.map((a, i) => <div key={i}>· {a}</div>)}
            </div>
          ) : (
            <div className="rounded-md bg-emerald-500/10 text-emerald-600 px-3 py-2 text-xs">✓ 费用处于正常区间</div>
          )}
        </>
      )}
    </div>
  )
}

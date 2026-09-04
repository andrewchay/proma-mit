/**
 * Runs Tab - 运行历史
 */

import * as React from 'react'
import { useAtom } from 'jotai'
import { History, RefreshCw, LoaderCircle, CheckCircle, XCircle, Pause } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { proactiveRunsAtom, proactiveLoadingAtom } from '@/atoms/proactive-data'
import type { ProactiveTaskRun } from '@gravitas/shared'

export function RunsTab({ onRefresh }: { onRefresh: () => Promise<void> }): React.ReactElement {
  const [runs] = useAtom(proactiveRunsAtom)
  const [loading] = useAtom(proactiveLoadingAtom)

  const statusIcon = (status: ProactiveTaskRun['status']): React.ReactElement => {
    switch (status) {
      case 'running':
        return <LoaderCircle size={14} className="text-blue-500 animate-spin" />
      case 'success':
        return <CheckCircle size={14} className="text-emerald-500" />
      case 'failed':
        return <XCircle size={14} className="text-destructive" />
      case 'cancelled':
        return <Pause size={14} className="text-amber-500" />
      default:
        return <History size={14} className="text-muted-foreground" />
    }
  }

  return (
    <div className="p-4 space-y-4 max-w-4xl mx-auto">
      <div className="rounded-xl border border-border/50 bg-background shadow-sm">
        <div className="px-4 py-3 border-b border-border/50 flex items-center justify-between">
          <h3 className="text-sm font-medium flex items-center gap-2">
            <History size={14} className="text-primary" />
            运行历史
          </h3>
          <Button variant="outline" size="sm" disabled={loading} onClick={() => void onRefresh()}>
            <RefreshCw className={loading ? 'mr-2 size-4 animate-spin' : 'mr-2 size-4'} />
            刷新
          </Button>
        </div>
        <div className="p-4">
          {runs.length === 0 ? (
            <p className="text-center text-sm text-muted-foreground py-12">暂无运行记录。</p>
          ) : (
            <div className="space-y-2">
              {runs.map((run) => (
                <div key={run.id} className="flex items-center gap-3 p-3 rounded-lg bg-foreground/[0.02] border border-border/40">
                  {statusIcon(run.status)}
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium">{run.sourceTitle ?? (run.sourceType === 'schedule' ? '定时任务' : run.sourceType === 'monitor' ? '监听任务' : run.sourceType === 'routine' ? 'Routine' : '手动运行')} · {run.status}</p>
                    <p className="text-xs text-muted-foreground">
                      {run.trigger} · {run.startedAt ? new Date(run.startedAt).toLocaleString() : '—'}
                      {run.endedAt && ` → ${new Date(run.endedAt).toLocaleTimeString()}`}
                    </p>
                  </div>
                  {run.outputSummary && (
                    <span className="text-xs text-muted-foreground truncate max-w-[200px]">{run.outputSummary}</span>
                  )}
                  {run.error && (
                    <span className="text-xs text-destructive truncate max-w-[200px]">{run.error}</span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

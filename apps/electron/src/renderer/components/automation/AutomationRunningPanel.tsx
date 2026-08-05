/**
 * AutomationRunningPanel — 自动化模块「运行中」子视图
 *
 * 从运行记录（RunRecord）中展示进行中的自动任务（运行中 / 等待确认 + 最近完成/失败）。
 * 由 AutomationModuleView 复用，代替原 AutomationCenterView 的独立顶栏形态。
 */

import * as React from 'react'
import { Zap, Play, Clock3, AlertCircle, CheckCircle2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { RunRecord } from '@gravitas/shared'

const REFRESH_INTERVAL = 3000

const SOURCE_LABEL: Record<string, string> = {
  agent: 'Agent',
  workflow: 'Workflow',
  automation: '定时任务',
  bridge: '外部',
  external: '外部',
}

function statusBadge(record: RunRecord): { label: string; icon: React.ReactNode; className: string } {
  switch (record.status) {
    case 'started':
    case 'progress':
      return {
        label: '运行中',
        icon: <Play size={12} className="text-blue-500" />,
        className: 'bg-blue-500/10 text-blue-500',
      }
    case 'waiting_action':
      return {
        label: '等待确认',
        icon: <AlertCircle size={12} className="text-orange-500" />,
        className: 'bg-orange-500/10 text-orange-500',
      }
    case 'completed':
      return {
        label: '已完成',
        icon: <CheckCircle2 size={12} className="text-emerald-500" />,
        className: 'bg-emerald-500/10 text-emerald-500',
      }
    case 'failed':
      return {
        label: '失败',
        icon: <AlertCircle size={12} className="text-red-500" />,
        className: 'bg-red-500/10 text-red-500',
      }
    default:
      return {
        label: record.status,
        icon: <Clock3 size={12} />,
        className: 'bg-foreground/10 text-foreground/70',
      }
  }
}

export function AutomationRunningPanel(): React.ReactElement {
  const [records, setRecords] = React.useState<RunRecord[]>([])
  const [loading, setLoading] = React.useState(true)

  const loadRecords = React.useCallback((): void => {
    window.electronAPI
      .listRunRecords({ limit: 100 })
      .then((all) => {
        // 运行中心按时间倒序，优先展示活跃任务，再展示最近完成/失败
        const active = all.filter((r) => r.status === 'started' || r.status === 'progress' || r.status === 'waiting_action')
        const recent = all.filter((r) => r.status === 'completed' || r.status === 'failed').slice(0, 20)
        setRecords([...active, ...recent])
        setLoading(false)
      })
      .catch((err) => {
        console.error(err)
        setLoading(false)
      })
  }, [])

  React.useEffect(() => {
    loadRecords()
    const timer = setInterval(loadRecords, REFRESH_INTERVAL)
    return () => clearInterval(timer)
  }, [loadRecords])

  return (
    <div className="p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="text-[12px] font-medium text-foreground/50">
          {loading ? '加载中...' : `共 ${records.length} 条运行记录`}
        </div>
      </div>

      {records.length === 0 && !loading ? (
        <div className="flex flex-col items-center justify-center gap-2 py-16 text-foreground/30">
          <Zap size={28} className="text-foreground/20" />
          <span className="text-[13px]">暂无运行中的自动任务</span>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {records.map((record) => {
            const badge = statusBadge(record)
            return (
              <div
                key={record.id}
                className="group flex items-start gap-3 p-3 rounded-xl border border-border/40 bg-foreground/[0.02] hover:bg-foreground/[0.04] transition-colors"
              >
                <div className="mt-0.5">{badge.icon}</div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-0.5">
                    <span className="shrink-0 px-1.5 py-[1px] rounded-full bg-foreground/[0.06] text-[10px] text-foreground/50">
                      {SOURCE_LABEL[record.source] ?? record.source}
                    </span>
                    <span className="text-[13px] font-medium text-foreground/85 truncate">{record.title}</span>
                    <span className={cn('px-1.5 py-[1px] rounded-full text-[10px] font-medium', badge.className)}>
                      {badge.label}
                    </span>
                  </div>
                  {record.detail && (
                    <p className="text-[11px] text-foreground/45 truncate">{record.detail}</p>
                  )}
                  <p className="text-[10px] text-foreground/35 mt-1">
                    {new Date(record.timestamp).toLocaleString('zh-CN')}
                  </p>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

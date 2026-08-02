/**
 * AutomationCenterView - 自动任务 / 运行中心主视图
 *
 * 从运行记录（RunRecord）中展示进行中的自动任务，
 * 作为「工作模块」中「自动任务」入口的主内容区。
 */

import * as React from 'react'
import { useAtom } from 'jotai'
import { Zap, ArrowLeft, Clock3, Settings, Play, AlertCircle, CheckCircle2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { activeViewAtom } from '@/atoms/active-view'
import { settingsTabAtom, settingsOpenAtom } from '@/atoms/settings-tab'
import type { RunRecord } from '@proma/shared'

const REFRESH_INTERVAL = 3000

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

export function AutomationCenterView(): React.ReactElement {
  const [, setActiveView] = useAtom(activeViewAtom)
  const [, setSettingsTab] = useAtom(settingsTabAtom)
  const [, setSettingsOpen] = useAtom(settingsOpenAtom)
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

  const handleBack = (): void => {
    setActiveView('conversations')
  }

  const openRunCenterSettings = (): void => {
    setSettingsTab('run-center')
    setSettingsOpen(true)
  }

  return (
    <div className="h-full flex flex-col">
      {/* 顶栏 */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-border/50">
        <button
          onClick={handleBack}
          className="flex items-center gap-1.5 px-2 py-1.5 rounded-lg text-[13px] text-foreground/55 hover:bg-foreground/[0.06] hover:text-foreground/85 transition-colors"
        >
          <ArrowLeft size={15} />
          返回对话
        </button>
        <div className="flex-1" />
        <div className="flex items-center gap-2 text-[13px] font-medium text-foreground/75">
          <Zap size={16} className="text-foreground/45" />
          自动任务
        </div>
      </div>

      {/* 主体 */}
      <div className="flex-1 overflow-y-auto p-4">
        <div className="flex items-center justify-between mb-3">
          <div className="text-[12px] font-medium text-foreground/50">
            {loading ? '加载中...' : `共 ${records.length} 条运行记录`}
          </div>
          <button
            onClick={openRunCenterSettings}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[12px] text-foreground/55 hover:bg-foreground/[0.06] hover:text-foreground/85 transition-colors"
          >
            <Settings size={13} />
            运行中心设置
          </button>
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
    </div>
  )
}

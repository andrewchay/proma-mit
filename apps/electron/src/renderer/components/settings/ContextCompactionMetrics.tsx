/** 上下文压缩本机可观测性；只显示聚合元数据。 */

import * as React from 'react'
import { Activity, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import type { ContextCompactionMetrics as Metrics } from '@gravitas/shared'
import { Button } from '@/components/ui/button'
import { SettingsCard, SettingsSection } from './primitives'

export function ContextCompactionMetrics(): React.ReactElement {
  const [metrics, setMetrics] = React.useState<Metrics | null>(null)
  const [loading, setLoading] = React.useState(true)

  const loadMetrics = React.useCallback(async () => {
    setLoading(true)
    try {
      setMetrics(await window.electronAPI.getContextCompactionMetrics())
    } catch (error) {
      console.error('[上下文压缩] 读取指标失败:', error)
      toast.error('读取本机上下文压缩指标失败')
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => { void loadMetrics() }, [loadMetrics])

  return (
    <SettingsSection title="上下文压缩" description="仅统计本机压缩次数、运行路径和触发原因；不读取、不显示也不上传会话正文或压缩摘要。">
      <SettingsCard className="space-y-4">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2 text-sm font-medium"><Activity className="size-4 text-violet-500" />本机压缩指标</div>
          <Button className="ml-auto" variant="outline" size="sm" onClick={() => void loadMetrics()} disabled={loading}>
            <RefreshCw className={loading ? 'mr-2 size-4 animate-spin' : 'mr-2 size-4'} />刷新
          </Button>
        </div>
        {metrics && <>
          <div className="text-3xl font-semibold tabular-nums">{metrics.total}<span className="ml-2 text-sm font-normal text-muted-foreground">次压缩</span></div>
          <MetricRows label="运行路径" values={metrics.byRuntime} />
          <MetricRows label="触发原因" values={metrics.byTrigger} />
          <p className="text-xs text-muted-foreground">{metrics.latestAt ? `最近一次：${formatTimestamp(metrics.latestAt)}` : '尚无本机压缩记录。'}</p>
        </>}
      </SettingsCard>
    </SettingsSection>
  )
}

function MetricRows({ label, values }: { label: string; values: Array<{ key: string; count: number }> }): React.ReactElement {
  return <div className="grid gap-1 text-sm sm:grid-cols-[5rem_1fr]">
    <span className="text-muted-foreground">{label}</span>
    <span>{values.length ? values.map(({ key, count }) => `${labelFor(key)} ${count}`).join(' · ') : '暂无'}</span>
  </div>
}

function labelFor(value: string): string {
  return ({ proma: 'Proma', 'ai-sdk': 'AI SDK', pi: 'Pi', claude: 'Claude', automatic: '自动', manual: '手动', overflow_recovery: '溢出恢复', native: '原生' } as Record<string, string>)[value] ?? value
}

function formatTimestamp(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}

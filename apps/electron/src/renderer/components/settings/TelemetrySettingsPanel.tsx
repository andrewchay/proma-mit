/**
 * TelemetrySettingsPanel — 行为采集设置
 *
 * 采集层为专业版分析能力提供数据基础（学习曲线、工作节律、协作分析）。
 * 本面板让用户明确知道「采集了什么、存在哪、怎么删」。
 *
 * 设计原则：
 * - 被动采集默认开启，但要如实说明采了什么、没采什么（不记笔记正文、
 *   不记会议标题），让用户能判断风险。
 * - 主动打卡（情绪）默认关闭，开启前给出明确说明：这是敏感数据，
 *   存在独立目录，可单独删除。
 * - 提供「仅删敏感数据」与「清空全部」两个粒度，而不是只给一个全清按钮。
 */
import * as React from 'react'
import { Brain, Heart, RefreshCw, ShieldCheck, Trash2, Users } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Input } from '@/components/ui/input'
import type {
  TelemetryCategory,
  TelemetryOverview,
  TelemetrySettings,
  TelemetryStats,
} from '@gravitas/shared'

/** 各类别的展示信息 */
const CATEGORY_META: Record<
  TelemetryCategory,
  { label: string; description: string; icon: typeof Brain; sensitive: boolean }
> = {
  knowledge: {
    label: '知识与学习',
    description: '记录笔记的打开、保存与被 Agent 引用。不记录笔记正文。',
    icon: Brain,
    sensitive: false,
  },
  focus: {
    label: '工作节律',
    description: '记录 Agent 会话时长与工具调用次数，用于分析专注时段。',
    icon: RefreshCw,
    sensitive: false,
  },
  collaboration: {
    label: '协作',
    description: '记录日程中工作与社交类事件的时长。不记录会议标题与参与人。',
    icon: Users,
    sensitive: false,
  },
  emotion: {
    label: '情绪打卡',
    description:
      '需要你主动记录。属于敏感数据，单独存放于 telemetry-mood 目录，可随时单独删除。',
    icon: Heart,
    sensitive: true,
  },
}

/** 字节数转可读文本 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function formatDate(iso?: string): string {
  if (!iso) return '—'
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('zh-CN')
}

export function TelemetrySettingsPanel(): React.ReactElement {
  const api = window.electronAPI?.telemetry
  const [settings, setSettings] = React.useState<TelemetrySettings | null>(null)
  const [stats, setStats] = React.useState<TelemetryStats | null>(null)
  const [overview, setOverview] = React.useState<TelemetryOverview | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [retentionInput, setRetentionInput] = React.useState('180')

  const refresh = React.useCallback(async () => {
    if (!api) return
    try {
      const [nextSettings, nextStats, nextOverview] = await Promise.all([
        api.getSettings(),
        api.getStats(),
        api.getOverview(),
      ])
      setSettings(nextSettings)
      setStats(nextStats)
      setOverview(nextOverview)
      setRetentionInput(String(nextSettings.retentionDays))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '读取采集设置失败')
    }
  }, [api])

  React.useEffect(() => {
    void refresh()
  }, [refresh])

  /** 切换某个类别的采集开关 */
  const toggleCategory = async (category: TelemetryCategory, enabled: boolean): Promise<void> => {
    if (!api || !settings) return
    setBusy(true)
    try {
      const next = await api.updateSettings({
        enabled: { ...settings.enabled, [category]: enabled },
      })
      setSettings(next)
      // 开启敏感采集时明确告知数据存放位置与删除方式
      if (category === 'emotion' && enabled) {
        toast.success('已开启情绪打卡', {
          description: '数据单独存放，可随时在此页单独删除。',
        })
      } else {
        toast.success(enabled ? '已开启采集' : '已关闭采集', {
          description: enabled ? undefined : '已记录的历史数据不会被删除，可手动清理。',
        })
      }
      await refresh()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '更新失败')
    } finally {
      setBusy(false)
    }
  }

  /** 保存保留期 */
  const saveRetention = async (): Promise<void> => {
    if (!api) return
    const days = Number(retentionInput)
    if (!Number.isFinite(days) || days < 0) {
      toast.error('保留天数必须是不小于 0 的数字')
      return
    }
    setBusy(true)
    try {
      const next = await api.updateSettings({ retentionDays: Math.round(days) })
      setSettings(next)
      toast.success(days === 0 ? '已关闭自动清理' : `已设置保留 ${days} 天`)
      await refresh()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '保存失败')
    } finally {
      setBusy(false)
    }
  }

  /** 清空敏感数据（情绪打卡） */
  const clearSensitive = async (): Promise<void> => {
    if (!api || !stats) return
    const confirmed = window.confirm(
      `确定删除全部情绪打卡记录（${stats.sensitive.count} 条）？\n\n此操作不可撤销，其他采集数据不受影响。`,
    )
    if (!confirmed) return
    setBusy(true)
    try {
      await api.clearSensitive()
      toast.success('已删除情绪打卡记录')
      await refresh()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '删除失败')
    } finally {
      setBusy(false)
    }
  }

  /** 清空全部采集数据 */
  const clearAll = async (): Promise<void> => {
    if (!api || !stats) return
    const confirmed = window.confirm(
      `确定清空全部采集数据（${stats.eventCount + stats.sensitive.count} 条）？\n\n此操作不可撤销，清空后分析能力需要重新积累数据。`,
    )
    if (!confirmed) return
    setBusy(true)
    try {
      await api.clearAll()
      toast.success('已清空全部采集数据')
      await refresh()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '清空失败')
    } finally {
      setBusy(false)
    }
  }

  if (!api) {
    return (
      <div className="text-[13px] text-muted-foreground">采集 API 不可用（仅桌面端支持）。</div>
    )
  }

  return (
    <div className="space-y-6">
      {/* 说明 */}
      <div className="rounded-xl bg-card border border-border/40 p-4 shadow-sm">
        <div className="flex items-start gap-2.5">
          <ShieldCheck size={16} className="text-primary mt-0.5 flex-shrink-0" />
          <div className="space-y-1.5">
            <div className="text-[13px] font-medium text-foreground/85">
              这些数据用于什么
            </div>
            <p className="text-[12px] text-foreground/60 leading-relaxed">
              为专业版分析能力提供数据基础（学习曲线、工作节律、协作分析）。
              全部数据保存在本机，不会上传。采集只记录「做了什么、什么时候」，
              不记录笔记正文、会话内容与会议标题。
            </p>
          </div>
        </div>
      </div>

      {/* 采集开关 */}
      <div className="space-y-2">
        <div className="text-[13px] font-medium text-foreground/85">采集类别</div>
        <div className="space-y-2">
          {(Object.keys(CATEGORY_META) as TelemetryCategory[]).map((category) => {
            const meta = CATEGORY_META[category]
            const Icon = meta.icon
            const enabled = settings?.enabled[category] ?? false
            const count = overview?.categoryTotals[category] ?? 0

            return (
              <div
                key={category}
                className="rounded-xl bg-card border border-border/40 p-4 shadow-sm flex items-start gap-3"
              >
                <Icon
                  size={16}
                  className={`mt-0.5 flex-shrink-0 ${meta.sensitive ? 'text-rose-500' : 'text-foreground/45'}`}
                />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-[13px] font-medium text-foreground/85">
                      {meta.label}
                    </span>
                    {meta.sensitive && (
                      <span className="px-1.5 py-px rounded bg-rose-500/10 text-rose-500 text-[10px]">
                        敏感
                      </span>
                    )}
                    {enabled && count > 0 && (
                      <span className="text-[11px] text-foreground/40">已记录 {count} 条</span>
                    )}
                  </div>
                  <p className="mt-1 text-[12px] text-foreground/60 leading-relaxed">
                    {meta.description}
                  </p>
                </div>
                <Switch
                  checked={enabled}
                  disabled={busy}
                  onCheckedChange={(value) => void toggleCategory(category, value)}
                />
              </div>
            )
          })}
        </div>
      </div>

      {/* 保留期 */}
      <div className="space-y-2">
        <div className="text-[13px] font-medium text-foreground/85">数据保留</div>
        <div className="rounded-xl bg-card border border-border/40 p-4 shadow-sm">
          <div className="flex items-center gap-3">
            <span className="text-[12px] text-foreground/60">保留天数</span>
            <Input
              value={retentionInput}
              onChange={(e) => setRetentionInput(e.target.value)}
              className="w-24 h-8 text-[13px]"
              inputMode="numeric"
            />
            <Button size="sm" variant="outline" onClick={saveRetention} disabled={busy}>
              保存
            </Button>
          </div>
          <p className="mt-2 text-[11px] text-foreground/45 leading-relaxed">
            超过该天数的事件会被自动清理；填 0 表示不自动清理。默认 180 天。
          </p>
        </div>
      </div>

      {/* 数据量与清理 */}
      <div className="space-y-2">
        <div className="text-[13px] font-medium text-foreground/85">数据与清理</div>
        <div className="rounded-xl bg-card border border-border/40 p-4 shadow-sm space-y-3">
          <div className="grid grid-cols-2 gap-x-6 gap-y-2">
            <Stat label="普通事件" value={`${stats?.eventCount ?? 0} 条`} />
            <Stat label="占用空间" value={formatBytes(stats?.eventBytes ?? 0)} />
            <Stat label="情绪打卡" value={`${stats?.sensitive.count ?? 0} 条`} />
            <Stat label="敏感数据占用" value={formatBytes(stats?.sensitive.bytes ?? 0)} />
            <Stat label="最早记录" value={formatDate(stats?.oldestAt)} />
            <Stat label="最新记录" value={formatDate(stats?.newestAt)} />
          </div>

          {overview && overview.currentStreak > 0 && (
            <div className="text-[12px] text-foreground/60 border-t border-border/40 pt-2.5">
              连续记录 <span className="text-foreground/85">{overview.currentStreak}</span> 天
              {overview.range && (
                <span className="text-foreground/40">
                  　覆盖 {overview.range.start} ~ {overview.range.end}
                </span>
              )}
            </div>
          )}

          <div className="flex flex-wrap gap-2 border-t border-border/40 pt-3">
            <Button
              size="sm"
              variant="outline"
              onClick={refresh}
              disabled={busy}
            >
              <RefreshCw size={13} />
              刷新
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={clearSensitive}
              disabled={busy || (stats?.sensitive.count ?? 0) === 0}
            >
              <Trash2 size={13} />
              仅删除情绪打卡
            </Button>
            <Button
              size="sm"
              variant="destructive"
              onClick={clearAll}
              disabled={busy || ((stats?.eventCount ?? 0) + (stats?.sensitive.count ?? 0)) === 0}
            >
              <Trash2 size={13} />
              清空全部
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }): React.ReactElement {
  return (
    <div className="flex items-baseline justify-between border-b border-border/40 pb-1.5">
      <span className="text-[12px] text-foreground/55">{label}</span>
      <span className="text-[12px] text-foreground/85 tabular-nums">{value}</span>
    </div>
  )
}

export default TelemetrySettingsPanel

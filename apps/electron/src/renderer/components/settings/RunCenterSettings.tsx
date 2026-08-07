/**
 * RunCenterSettings — 统一 Run Center（P2-2）。
 *
 * 一处查看 Agent / Workflow / Automation 的所有运行记录，
 * 支持按来源/状态筛选、点击导航到对应会话、清空。
 */

import * as React from 'react'
import { useStore } from 'jotai'
import { SettingsSection } from './primitives/SettingsSection'
import { SettingsCard } from './primitives/SettingsCard'
import { Button } from '@/components/ui/button'
import { toast } from 'sonner'
import { useOpenSession } from '@/hooks/useOpenSession'
import { settingsOpenAtom } from '@/atoms/settings-tab'
import type { RunRecord } from '@gravitas/shared'

const SOURCE_LABEL: Record<string, string> = {
  agent: 'Agent',
  workflow: 'Workflow',
  automation: '定时任务',
  bridge: '外部',
  external: '外部',
}

const STATUS_META: Record<string, { label: string; className: string }> = {
  started: { label: '开始', className: 'bg-foreground/[0.06] text-foreground/60' },
  progress: { label: '进行中', className: 'bg-blue-500/10 text-blue-500' },
  waiting_action: { label: '待处理', className: 'bg-amber-500/10 text-amber-600' },
  completed: { label: '已完成', className: 'bg-green-500/10 text-green-600' },
  failed: { label: '失败', className: 'bg-red-500/10 text-red-600' },
}

export function RunCenterSettings(): React.ReactElement {
  const store = useStore()
  const { openSession } = useOpenSession()
  const [records, setRecords] = React.useState<RunRecord[]>([])
  const [sourceFilter, setSourceFilter] = React.useState<string>('all')
  const [memberFilter, setMemberFilter] = React.useState('')
  const [loading, setLoading] = React.useState(true)

  const visibleRecords = React.useMemo(() => {
    const kw = memberFilter.trim().toLowerCase()
    if (!kw) return records
    return records.filter((r) => (r.memberId ?? '').toLowerCase().includes(kw))
  }, [records, memberFilter])

  const load = React.useCallback(async (): Promise<void> => {
    try {
      const result = await window.electronAPI.listRunRecords({
        ...(sourceFilter !== 'all' ? { source: sourceFilter as RunRecord['source'] } : {}),
        limit: 100,
      })
      setRecords(result)
    } catch (err) {
      console.error('[运行记录] 读取失败:', err)
    } finally {
      setLoading(false)
    }
  }, [sourceFilter])

  React.useEffect(() => {
    void load()
  }, [load])

  const handleClear = async (): Promise<void> => {
    try {
      await window.electronAPI.clearRunRecords()
      setRecords([])
      toast.success('运行记录已清空')
    } catch (err) {
      toast.error('清空失败')
      console.error(err)
    }
  }

  const handleNavigate = (record: RunRecord): void => {
    if (!record.sessionId) return
    // 关闭设置面板并打开对应会话（切回主界面）
    store.set(settingsOpenAtom, false)
    openSession('agent', record.sessionId, record.title)
  }

  const formatTime = (ts: number): string => {
    const d = new Date(ts)
    return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  }

  // 把 memberId 前缀转成友好显示（agent-<id> → 🤖 <id>；paa-<name> → <name>；bot:* → <platform>）
  const renderMember = (memberId: string): string => {
    if (memberId.startsWith('agent-')) return `🤖 ${memberId.slice('agent-'.length).slice(0, 12)}`
    if (memberId.startsWith('paa-')) return memberId.slice('paa-'.length)
    if (memberId.startsWith('bot:')) return '🤖 机器人'
    return memberId
  }

  return (
    <SettingsSection
      title="运行记录"
      description="统一查看 Agent / Workflow / 定时任务的运行历史（本地存储，最近 2000 条）"
      action={
        <Button variant="outline" size="sm" onClick={() => void handleClear()} disabled={records.length === 0}>
          清空
        </Button>
      }
    >
      <SettingsCard>
        {/* 来源筛选 + 成员归属过滤（PH2-B） */}
        <div className="flex flex-col gap-2 px-4 pt-3 pb-2">
          <div className="flex items-center gap-1.5">
            {['all', 'agent', 'workflow', 'automation', 'bridge'].map((key) => (
              <button
                key={key}
                type="button"
                onClick={() => { setSourceFilter(key); setLoading(true) }}
                className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${
                  sourceFilter === key
                    ? 'bg-primary/10 text-primary'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {key === 'all' ? '全部' : SOURCE_LABEL[key]}
              </button>
            ))}
          </div>
          <input
            value={memberFilter}
            onChange={(e) => setMemberFilter(e.target.value)}
            placeholder="按成员过滤（memberId：agent-… / paa-姓名）"
            className="w-full px-2.5 py-1.5 rounded-md border bg-background text-xs placeholder:text-foreground/40"
          />
        </div>

        {loading ? (
          <div className="px-4 py-8 text-center text-sm text-muted-foreground">加载中…</div>
        ) : visibleRecords.length === 0 ? (
          <div className="px-4 py-8 text-center text-sm text-muted-foreground">暂无运行记录</div>
        ) : (
          <div className="flex flex-col">
            {visibleRecords.slice(0, 50).map((record) => {
              const meta = STATUS_META[record.status] ?? { label: record.status, className: 'bg-foreground/[0.06] text-foreground/60' }
              return (
                <div
                  key={record.id}
                  className="flex items-center gap-2.5 px-4 py-2 text-[12px] border-b border-border/30 last:border-b-0"
                >
                  <span className="shrink-0 text-foreground/40 tabular-nums w-[86px]">{formatTime(record.timestamp)}</span>
                  <span className="shrink-0 px-1.5 py-0.5 rounded bg-foreground/[0.06] text-foreground/50">
                    {SOURCE_LABEL[record.source] ?? record.source}
                  </span>
                  <span className={`shrink-0 px-1.5 py-0.5 rounded ${meta.className}`}>{meta.label}</span>
                  <span className="shrink-0 truncate max-w-[120px] px-1.5 py-0.5 rounded bg-indigo-500/10 text-indigo-500" title={record.memberId ?? ''}>
                    {record.memberId ? renderMember(record.memberId) : '—'}
                  </span>
                  <span className="truncate flex-1 text-foreground/80">{record.title}</span>
                  {record.detail && (
                    <span className="shrink-0 max-w-[220px] truncate text-foreground/40">{record.detail}</span>
                  )}
                  {record.sessionId && (
                    <button
                      type="button"
                      onClick={() => handleNavigate(record)}
                      className="shrink-0 text-[11px] text-primary/70 hover:text-primary"
                    >
                      打开会话
                    </button>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </SettingsCard>
    </SettingsSection>
  )
}

/**
 * TokenUsageSettings — Token 消耗统计后台
 *
 * 展示 Agent 会话按轮次、工具、Skill、MCP、模型维度的用量统计。
 */

import * as React from 'react'
import { BarChart3, RefreshCw, Trash2, ChevronRight, ChevronDown } from 'lucide-react'
import { useStore } from 'jotai'
import { toast } from 'sonner'
import { SettingsSection } from './primitives/SettingsSection'
import { SettingsCard } from './primitives/SettingsCard'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { settingsOpenAtom } from '@/atoms/settings-tab'
import { useOpenSession } from '@/hooks/useOpenSession'
import type {
  TokenUsageAggregate,
  TokenUsageDimensionItem,
  TokenUsageDayItem,
  TokenUsageRecord,
  TokenUsageSessionSummary,
} from '@gravitas/shared'

interface UsageOverviewCardProps {
  label: string
  value: string
  sub?: string
}

function UsageOverviewCard({ label, value, sub }: UsageOverviewCardProps): React.ReactElement {
  return (
    <div className="rounded-xl bg-card border border-border/40 p-4 shadow-sm">
      <div className="text-xs text-muted-foreground mb-1">{label}</div>
      <div className="text-2xl font-semibold tabular-nums tracking-tight">{value}</div>
      {sub && <div className="text-[11px] text-muted-foreground mt-1">{sub}</div>}
    </div>
  )
}

function formatNumber(n: number): string {
  return Math.round(n).toLocaleString()
}

function formatCost(n: number): string {
  if (n === 0) return '$0.0000'
  if (n < 0.0001) return '<$0.0001'
  return `$${n.toFixed(4)}`
}

function formatTime(ts: number): string {
  const d = new Date(ts)
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

interface DimensionTableProps {
  items: TokenUsageDimensionItem[]
  emptyText?: string
}

function DimensionTable({ items, emptyText = '暂无数据' }: DimensionTableProps): React.ReactElement {
  if (items.length === 0) {
    return <div className="px-4 py-8 text-center text-sm text-muted-foreground">{emptyText}</div>
  }
  return (
    <div className="flex flex-col">
      <div className="grid grid-cols-12 gap-2 px-4 py-2 text-[11px] font-medium text-muted-foreground border-b border-border/30">
        <div className="col-span-4 truncate">名称</div>
        <div className="col-span-2 text-right">轮次</div>
        <div className="col-span-2 text-right">Input</div>
        <div className="col-span-2 text-right">Output</div>
        <div className="col-span-2 text-right">Total</div>
      </div>
      {items.map((item) => (
        <div
          key={item.name}
          className="grid grid-cols-12 gap-2 px-4 py-2 text-[12px] border-b border-border/30 last:border-b-0 items-center"
        >
          <div className="col-span-4 truncate font-medium text-foreground/90" title={item.name}>
            {item.name}
          </div>
          <div className="col-span-2 text-right tabular-nums text-muted-foreground">{item.count}</div>
          <div className="col-span-2 text-right tabular-nums">{formatNumber(item.inputTokens)}</div>
          <div className="col-span-2 text-right tabular-nums">{formatNumber(item.outputTokens)}</div>
          <div className="col-span-2 text-right tabular-nums font-medium">{formatNumber(item.totalTokens)}</div>
        </div>
      ))}
    </div>
  )
}

interface DayTableProps {
  items: TokenUsageDayItem[]
}

function DayTable({ items }: DayTableProps): React.ReactElement {
  if (items.length === 0) {
    return <div className="px-4 py-8 text-center text-sm text-muted-foreground">暂无数据</div>
  }
  return (
    <div className="flex flex-col">
      <div className="grid grid-cols-12 gap-2 px-4 py-2 text-[11px] font-medium text-muted-foreground border-b border-border/30">
        <div className="col-span-3">日期</div>
        <div className="col-span-2 text-right">轮次</div>
        <div className="col-span-2 text-right">Input</div>
        <div className="col-span-2 text-right">Output</div>
        <div className="col-span-3 text-right">Total</div>
      </div>
      {items.map((item) => (
        <div
          key={item.date}
          className="grid grid-cols-12 gap-2 px-4 py-2 text-[12px] border-b border-border/30 last:border-b-0 items-center"
        >
          <div className="col-span-3 tabular-nums text-foreground/90">{item.date}</div>
          <div className="col-span-2 text-right tabular-nums text-muted-foreground">{item.count}</div>
          <div className="col-span-2 text-right tabular-nums">{formatNumber(item.inputTokens)}</div>
          <div className="col-span-2 text-right tabular-nums">{formatNumber(item.outputTokens)}</div>
          <div className="col-span-3 text-right tabular-nums font-medium">{formatNumber(item.totalTokens)}</div>
        </div>
      ))}
    </div>
  )
}

interface SessionTableProps {
  sessions: TokenUsageSessionSummary[]
  onSelect: (session: TokenUsageSessionSummary) => void
  selectedSessionId?: string
}

function SessionTable({ sessions, onSelect, selectedSessionId }: SessionTableProps): React.ReactElement {
  const store = useStore()
  const { openSession } = useOpenSession()

  if (sessions.length === 0) {
    return <div className="px-4 py-8 text-center text-sm text-muted-foreground">暂无会话数据</div>
  }

  return (
    <div className="flex flex-col">
      <div className="grid grid-cols-12 gap-2 px-4 py-2 text-[11px] font-medium text-muted-foreground border-b border-border/30">
        <div className="col-span-4">会话</div>
        <div className="col-span-1 text-right">轮次</div>
        <div className="col-span-2 text-right">Input</div>
        <div className="col-span-2 text-right">Output</div>
        <div className="col-span-2 text-right">Total</div>
        <div className="col-span-1" />
      </div>
      {sessions.map((session) => {
        const isSelected = selectedSessionId === session.sessionId
        return (
          <div
            key={session.sessionId}
            className={`grid grid-cols-12 gap-2 px-4 py-2 text-[12px] border-b border-border/30 last:border-b-0 items-center transition-colors ${
              isSelected ? 'bg-primary/5' : 'hover:bg-foreground/[0.02]'
            }`}
          >
            <div className="col-span-4 truncate" title={session.title}>
              <div className="font-medium text-foreground/90 truncate">{session.title || session.sessionId}</div>
              {session.workspaceId && (
                <div className="text-[10px] text-muted-foreground truncate">{session.workspaceId}</div>
              )}
            </div>
            <div className="col-span-1 text-right tabular-nums text-muted-foreground">{session.turns}</div>
            <div className="col-span-2 text-right tabular-nums">{formatNumber(session.inputTokens)}</div>
            <div className="col-span-2 text-right tabular-nums">{formatNumber(session.outputTokens)}</div>
            <div className="col-span-2 text-right tabular-nums font-medium">{formatNumber(session.totalTokens)}</div>
            <div className="col-span-1 flex items-center justify-end gap-1">
              <button
                type="button"
                onClick={() => onSelect(session)}
                className="p-1 rounded hover:bg-foreground/10 text-muted-foreground"
                title="查看轮次明细"
              >
                {isSelected ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              </button>
              <button
                type="button"
                onClick={() => {
                  store.set(settingsOpenAtom, false)
                  openSession('agent', session.sessionId, session.title)
                }}
                className="text-[11px] text-primary/70 hover:text-primary"
              >
                打开
              </button>
            </div>
          </div>
        )
      })}
    </div>
  )
}

interface TurnTableProps {
  records: TokenUsageRecord[]
}

function TurnTable({ records }: TurnTableProps): React.ReactElement {
  if (records.length === 0) {
    return <div className="px-4 py-8 text-center text-sm text-muted-foreground">暂无轮次数据</div>
  }

  return (
    <div className="flex flex-col">
      <div className="grid grid-cols-12 gap-2 px-4 py-2 text-[11px] font-medium text-muted-foreground border-b border-border/30">
        <div className="col-span-1">轮次</div>
        <div className="col-span-3">工具 / Skill / MCP</div>
        <div className="col-span-2">模型</div>
        <div className="col-span-2 text-right">Input</div>
        <div className="col-span-2 text-right">Output</div>
        <div className="col-span-2 text-right">Total</div>
      </div>
      {records.map((record) => (
        <div
          key={record.id}
          className="grid grid-cols-12 gap-2 px-4 py-2 text-[12px] border-b border-border/30 last:border-b-0 items-start"
        >
          <div className="col-span-1 tabular-nums text-muted-foreground">#{record.turnIndex}</div>
          <div className="col-span-3 flex flex-col gap-0.5 min-w-0">
            {record.toolNames.slice(0, 3).map((name) => (
              <span key={name} className="truncate text-foreground/80" title={name}>
                {name}
              </span>
            ))}
            {record.toolNames.length > 3 && (
              <span className="text-muted-foreground">+{record.toolNames.length - 3} 个工具</span>
            )}
            {(record.skillIds.length > 0 || record.mcpServers.length > 0) && (
              <div className="flex flex-wrap gap-1 mt-0.5">
                {record.skillIds.map((id) => (
                  <span key={id} className="px-1 py-0.5 rounded bg-primary/10 text-primary text-[10px]">
                    {id}
                  </span>
                ))}
                {record.mcpServers.map((server) => (
                  <span key={server} className="px-1 py-0.5 rounded bg-amber-500/10 text-amber-600 text-[10px]">
                    MCP:{server}
                  </span>
                ))}
              </div>
            )}
          </div>
          <div className="col-span-2 truncate text-muted-foreground" title={record.modelId}>
            {record.modelId || 'unknown'}
          </div>
          <div className="col-span-2 text-right tabular-nums">{formatNumber(record.inputTokens)}</div>
          <div className="col-span-2 text-right tabular-nums">{formatNumber(record.outputTokens)}</div>
          <div className="col-span-2 text-right tabular-nums font-medium">{formatNumber(record.totalTokens)}</div>
        </div>
      ))}
    </div>
  )
}

export function TokenUsageSettings(): React.ReactElement {
  const [aggregate, setAggregate] = React.useState<TokenUsageAggregate | null>(null)
  const [sessions, setSessions] = React.useState<TokenUsageSessionSummary[]>([])
  const [selectedSession, setSelectedSession] = React.useState<TokenUsageSessionSummary | null>(null)
  const [turnRecords, setTurnRecords] = React.useState<TokenUsageRecord[]>([])
  const [loading, setLoading] = React.useState(true)

  const load = React.useCallback(async (): Promise<void> => {
    setLoading(true)
    try {
      const [agg, sess] = await Promise.all([
        window.electronAPI.aggregateTokenUsage({}),
        window.electronAPI.listTokenUsageSessions(),
      ])
      setAggregate(agg)
      setSessions(sess)
    } catch (err) {
      console.error('[Token 统计] 加载失败:', err)
      toast.error('加载 Token 统计数据失败')
    } finally {
      setLoading(false)
    }
  }, [])

  const loadTurns = React.useCallback(async (sessionId: string): Promise<void> => {
    try {
      const records = await window.electronAPI.listTokenUsageRecords({ sessionId, limit: 500 })
      setTurnRecords(records.sort((a, b) => a.turnIndex - b.turnIndex))
    } catch (err) {
      console.error('[Token 统计] 加载轮次明细失败:', err)
      toast.error('加载轮次明细失败')
    }
  }, [])

  React.useEffect(() => {
    void load()
  }, [load])

  React.useEffect(() => {
    if (selectedSession) {
      void loadTurns(selectedSession.sessionId)
    } else {
      setTurnRecords([])
    }
  }, [selectedSession, loadTurns])

  const handleClear = async (): Promise<void> => {
    try {
      await window.electronAPI.clearTokenUsageRecords()
      setAggregate(null)
      setSessions([])
      setSelectedSession(null)
      setTurnRecords([])
      toast.success('Token 统计记录已清空')
    } catch (err) {
      console.error('[Token 统计] 清空失败:', err)
      toast.error('清空失败')
    }
  }

  return (
    <SettingsSection
      title="Token 统计"
      description="按会话、轮次、工具、Skill、MCP 维度统计 Agent 的 token 消耗（本地存储，增量统计）"
      action={
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
            <RefreshCw size={14} className={`mr-1.5 ${loading ? 'animate-spin' : ''}`} />
            刷新
          </Button>
          <Button variant="outline" size="sm" onClick={() => void handleClear()} disabled={sessions.length === 0}>
            <Trash2 size={14} className="mr-1.5" />
            清空
          </Button>
        </div>
      }
    >
      {/* 总览卡片 */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-2">
        <UsageOverviewCard
          label="总 Token"
          value={formatNumber(aggregate?.totalTokens ?? 0)}
          sub={`${formatNumber(aggregate?.totalInputTokens ?? 0)} in / ${formatNumber(aggregate?.totalOutputTokens ?? 0)} out`}
        />
        <UsageOverviewCard
          label="总费用"
          value={formatCost(aggregate?.totalCost ?? 0)}
          sub="Provider 返回成本"
        />
        <UsageOverviewCard
          label="缓存读取"
          value={formatNumber(aggregate?.totalCacheReadTokens ?? 0)}
          sub="Cache hit"
        />
        <UsageOverviewCard
          label="缓存创建"
          value={formatNumber(aggregate?.totalCacheCreationTokens ?? 0)}
          sub="Cache write"
        />
      </div>

      {/* 聚合排行 */}
      <SettingsCard className="mt-4">
        <Tabs defaultValue="tool">
          <div className="px-4 pt-3 pb-2 border-b border-border/30">
            <TabsList className="grid w-full grid-cols-5">
              <TabsTrigger value="tool">工具</TabsTrigger>
              <TabsTrigger value="skill">Skill</TabsTrigger>
              <TabsTrigger value="mcp">MCP</TabsTrigger>
              <TabsTrigger value="model">模型</TabsTrigger>
              <TabsTrigger value="day">日期</TabsTrigger>
            </TabsList>
          </div>
          <TabsContent value="tool" className="mt-0">
            <DimensionTable items={aggregate?.byTool ?? []} emptyText="暂无工具数据" />
          </TabsContent>
          <TabsContent value="skill" className="mt-0">
            <DimensionTable items={aggregate?.bySkill ?? []} emptyText="暂无 Skill 数据" />
          </TabsContent>
          <TabsContent value="mcp" className="mt-0">
            <DimensionTable items={aggregate?.byMcpServer ?? []} emptyText="暂无 MCP 数据" />
          </TabsContent>
          <TabsContent value="model" className="mt-0">
            <DimensionTable items={aggregate?.byModel ?? []} emptyText="暂无模型数据" />
          </TabsContent>
          <TabsContent value="day" className="mt-0">
            <DayTable items={aggregate?.byDay ?? []} />
          </TabsContent>
        </Tabs>
      </SettingsCard>

      {/* 会话列表 */}
      <SettingsCard className="mt-4">
        <div className="px-4 py-2 text-sm font-medium text-foreground/80 border-b border-border/30">会话列表</div>
        {loading ? (
          <div className="px-4 py-8 text-center text-sm text-muted-foreground">加载中…</div>
        ) : (
          <SessionTable
            sessions={sessions}
            selectedSessionId={selectedSession?.sessionId}
            onSelect={(session) => {
              setSelectedSession((prev) =>
                prev?.sessionId === session.sessionId ? null : session,
              )
            }}
          />
        )}
      </SettingsCard>

      {/* 轮次明细 */}
      {selectedSession && (
        <SettingsCard className="mt-4">
          <div className="px-4 py-2 text-sm font-medium text-foreground/80 border-b border-border/30 flex items-center justify-between">
            <span>轮次明细 — {selectedSession.title || selectedSession.sessionId}</span>
            <span className="text-[11px] text-muted-foreground">{formatTime(selectedSession.lastTimestamp)}</span>
          </div>
          <TurnTable records={turnRecords} />
        </SettingsCard>
      )}
    </SettingsSection>
  )
}

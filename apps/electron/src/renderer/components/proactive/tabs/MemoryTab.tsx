import * as React from 'react'
import { Brain, FilePlus2, RefreshCw, Search } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import type { AgentWorkspace } from '@gravitas/shared'

interface MemoryItemView {
  id: string
  title: string
  content: string
  kind: string
  tags: string[]
  confidence: number
  updatedAt: number
}

interface MemoryStatsView {
  totalItems: number
  byKind: Record<string, number>
}

export function MemoryTab(): React.ReactElement {
  const [items, setItems] = React.useState<MemoryItemView[]>([])
  const [stats, setStats] = React.useState<MemoryStatsView | null>(null)
  const [query, setQuery] = React.useState('')
  const [loading, setLoading] = React.useState(false)
  const [workspaces, setWorkspaces] = React.useState<AgentWorkspace[]>([])
  const [workspaceId, setWorkspaceId] = React.useState('')

  const refresh = React.useCallback(async (): Promise<void> => {
    setLoading(true)
    try {
      const [nextItems, nextStats, nextWorkspaces] = await Promise.all([
        window.electronAPI.proactive?.listMemoryItems?.() ?? Promise.resolve([]),
        window.electronAPI.proactive?.getMemoryStats?.() ?? Promise.resolve(null),
        window.electronAPI.listAgentWorkspaces(),
      ])
      setItems(nextItems.filter(isMemoryItemView))
      setStats(isMemoryStatsView(nextStats) ? nextStats : null)
      setWorkspaces(nextWorkspaces)
      setWorkspaceId((current) => nextWorkspaces.some((workspace) => workspace.id === current) ? current : nextWorkspaces[0]?.id ?? '')
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => { void refresh() }, [refresh])
  const visibleItems = items.filter((item) => `${item.title}\n${item.content}\n${item.tags.join(' ')}`.toLowerCase().includes(query.toLowerCase()))
  const submitSOP = async (item: MemoryItemView): Promise<void> => {
    if (!workspaceId) { toast.error('请先选择 Skill 的目标工作区'); return }
    const result = await window.electronAPI.proactive?.submitSOPCandidate?.({
      id: item.id,
      title: item.title,
      description: item.content,
      steps: extractSOPSteps(item.content),
      createdAt: item.updatedAt,
    }, workspaceId)
    if (!result) { toast.error('SOP 内容缺少可执行步骤，未创建审批'); return }
    toast.success('已创建 Skill 审批；请在 Approvals 中确认')
  }

  return (
    <div className="p-4 space-y-4 max-w-4xl mx-auto">
      <section className="rounded-xl border border-border/50 bg-background shadow-sm p-4 flex items-center gap-4">
        <div className="p-2 rounded-lg bg-primary/10 text-primary"><Brain className="size-5" /></div>
        <div className="flex-1"><p className="text-sm font-medium">Proma Memory</p><p className="text-xs text-muted-foreground">本地长期记忆；写入由主动任务审批后生效。</p></div>
        <div className="text-right"><p className="text-lg font-semibold">{stats?.totalItems ?? 0}</p><p className="text-[11px] text-muted-foreground">记忆条目</p></div>
      </section>
      <div className="flex gap-2"><div className="relative flex-1"><Search className="absolute left-3 top-2.5 size-4 text-muted-foreground" /><Input className="pl-9" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索标题、内容或标签" /></div><Button variant="outline" size="icon" onClick={() => void refresh()} disabled={loading} aria-label="刷新记忆"><RefreshCw className={loading ? 'size-4 animate-spin' : 'size-4'} /></Button></div>
      <section className="rounded-xl border border-border/50 bg-background shadow-sm p-4"><label className="grid gap-1.5 text-sm text-muted-foreground">SOP 生成 Skill 的目标工作区<Select value={workspaceId} onValueChange={setWorkspaceId}><SelectTrigger><SelectValue placeholder="选择工作区" /></SelectTrigger><SelectContent>{workspaces.map((workspace) => <SelectItem key={workspace.id} value={workspace.id}>{workspace.name}</SelectItem>)}</SelectContent></Select></label><p className="mt-2 text-xs text-muted-foreground">提交只会生成审批；通过后才会在所选工作区的 Skills 目录原子创建。</p></section>
      <section className="rounded-xl border border-border/50 bg-background shadow-sm"><div className="px-4 py-3 border-b border-border/50 flex items-center justify-between"><h3 className="text-sm font-medium">记忆条目</h3>{stats && <span className="text-xs text-muted-foreground">{Object.entries(stats.byKind).filter(([, count]) => count > 0).map(([kind, count]) => `${kind} ${count}`).join(' · ')}</span>}</div><div className="p-4 space-y-2">{visibleItems.length === 0 ? <p className="py-10 text-center text-sm text-muted-foreground">暂无匹配的记忆条目。</p> : visibleItems.map((item) => <article key={item.id} className="p-3 rounded-lg bg-foreground/[0.02] border border-border/40"><div className="flex items-center gap-2"><p className="text-sm font-medium">{item.title}</p><span className="text-[11px] text-muted-foreground">{item.kind} · {Math.round(item.confidence * 100)}%</span></div><p className="text-xs text-muted-foreground mt-1 whitespace-pre-wrap">{item.content}</p>{item.tags.length > 0 && <p className="text-[11px] text-primary mt-2">{item.tags.map((tag) => `#${tag}`).join(' ')}</p>}{item.kind === 'sop' && <Button className="mt-3" size="sm" variant="outline" disabled={!workspaceId} onClick={() => void submitSOP(item)}><FilePlus2 className="size-3.5 mr-1" />提交为 Skill 审批</Button>}</article>)}</div></section>
    </div>
  )
}

function extractSOPSteps(content: string): string[] {
  const numbered = content.split('\n').map((line) => line.match(/^\s*\d+[.、)]\s+(.+)$/)?.[1]?.trim()).filter((step): step is string => Boolean(step))
  return numbered.length > 0 ? numbered : content.split('\n').map((line) => line.replace(/^\s*[-*]\s+/, '').trim()).filter(Boolean)
}

function isMemoryItemView(value: unknown): value is MemoryItemView {
  if (typeof value !== 'object' || value === null) return false
  const item = value as Record<string, unknown>
  return typeof item.id === 'string' && typeof item.title === 'string' && typeof item.content === 'string' && typeof item.kind === 'string' && Array.isArray(item.tags) && typeof item.confidence === 'number' && typeof item.updatedAt === 'number'
}

function isMemoryStatsView(value: unknown): value is MemoryStatsView {
  if (typeof value !== 'object' || value === null) return false
  const stats = value as Record<string, unknown>
  return typeof stats.totalItems === 'number' && typeof stats.byKind === 'object' && stats.byKind !== null
}

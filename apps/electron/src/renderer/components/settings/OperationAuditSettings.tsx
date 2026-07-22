/** 本地 Web Bridge / Computer Use 操作审计查看器。 */

import * as React from 'react'
import { Download, RefreshCw, ShieldCheck } from 'lucide-react'
import { toast } from 'sonner'
import type { AgentAuditEvent, AgentAuditQuery } from '@proma/shared'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { SettingsCard, SettingsSection } from './primitives'

type SourceFilter = 'all' | AgentAuditEvent['source']

const SOURCE_LABEL: Record<AgentAuditEvent['source'], string> = {
  'web-bridge': 'Web Bridge',
  'computer-use': 'Computer Use',
}

export function OperationAuditSettings(): React.ReactElement {
  const [source, setSource] = React.useState<SourceFilter>('all')
  const [sessionId, setSessionId] = React.useState('')
  const [action, setAction] = React.useState('')
  const [events, setEvents] = React.useState<AgentAuditEvent[]>([])
  const [loading, setLoading] = React.useState(true)
  const [exporting, setExporting] = React.useState(false)

  const query = React.useMemo<AgentAuditQuery>(() => ({
    source,
    ...(sessionId.trim() && { sessionId: sessionId.trim() }),
    ...(action.trim() && { action: action.trim() }),
    limit: 300,
  }), [source, sessionId, action])

  const loadEvents = React.useCallback(async () => {
    setLoading(true)
    try {
      setEvents(await window.electronAPI.listAgentAuditEvents(query))
    } catch (error) {
      console.error('[操作审计] 读取失败:', error)
      toast.error('读取本地操作审计失败')
    } finally {
      setLoading(false)
    }
  }, [query])

  React.useEffect(() => { void loadEvents() }, [loadEvents])

  const exportEvents = async (): Promise<void> => {
    setExporting(true)
    try {
      const result = await window.electronAPI.exportAgentAuditEvents(query)
      if (!result.canceled) toast.success(`已导出 ${result.count} 条审计记录`)
    } catch (error) {
      console.error('[操作审计] 导出失败:', error)
      toast.error('导出操作审计失败')
    } finally {
      setExporting(false)
    }
  }

  return (
    <div className="space-y-5">
      <SettingsSection title="操作审计" description="仅显示保存在本机 JSONL 的 Web Bridge 与 Computer Use 操作摘要；不会上传，也不含截图、页面正文、敏感输入或本地绝对路径。">
        <SettingsCard className="space-y-4">
          <div className="flex flex-wrap items-end gap-3">
            <label className="grid gap-1.5 text-sm text-muted-foreground">
              来源
              <Select value={source} onValueChange={(value: SourceFilter) => setSource(value)}>
                <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">全部</SelectItem>
                  <SelectItem value="web-bridge">Web Bridge</SelectItem>
                  <SelectItem value="computer-use">Computer Use</SelectItem>
                </SelectContent>
              </Select>
            </label>
            <label className="grid gap-1.5 text-sm text-muted-foreground">
              会话 ID
              <Input value={sessionId} onChange={(event) => setSessionId(event.target.value)} placeholder="精确匹配，可留空" className="w-52" />
            </label>
            <label className="grid gap-1.5 text-sm text-muted-foreground">
              操作类型
              <Input value={action} onChange={(event) => setAction(event.target.value)} placeholder="如 upload、click" className="w-44" />
            </label>
            <Button variant="outline" onClick={() => void loadEvents()} disabled={loading}><RefreshCw className={loading ? 'mr-2 size-4 animate-spin' : 'mr-2 size-4'} />刷新</Button>
            <Button onClick={() => void exportEvents()} disabled={exporting}><Download className="mr-2 size-4" />{exporting ? '导出中…' : '导出筛选结果'}</Button>
          </div>
          <p className="text-xs text-muted-foreground">显示最新 {events.length} 条，最多 300 条；导出同一筛选条件下最多 1,000 条 JSONL 记录。</p>
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title="审计记录">
        <div className="space-y-2">
          {!loading && events.length === 0 && <SettingsCard className="py-10 text-center text-sm text-muted-foreground">暂无匹配的本地审计记录。</SettingsCard>}
          {events.map((event, index) => <AuditEventCard key={`${event.source}-${event.at}-${event.sessionId}-${event.action}-${index}`} event={event} />)}
        </div>
      </SettingsSection>
    </div>
  )
}

function AuditEventCard({ event }: { event: AgentAuditEvent }): React.ReactElement {
  return <SettingsCard className="space-y-2">
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <ShieldCheck className="size-4 text-emerald-500" />
      <span className="font-medium">{SOURCE_LABEL[event.source]}</span>
      <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{event.action}</span>
      <span className="ml-auto text-xs text-muted-foreground">{formatTimestamp(event.at)}</span>
    </div>
    <div className="text-xs text-muted-foreground">会话：<span className="font-mono text-foreground/80">{event.sessionId}</span></div>
    <pre className="max-h-40 overflow-auto rounded-md bg-muted/60 p-3 text-xs leading-5 text-foreground/85">{JSON.stringify(event.detail, null, 2)}</pre>
  </SettingsCard>
}

function formatTimestamp(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}

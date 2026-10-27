import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import { useCallback, useEffect, useRef } from 'react'
import { ownerTodoScanAtom, ownerTodoScanRequestAtom, type OwnerTodoScanItem } from '@/atoms/project-atoms'

interface OwnerTodoScanPanelProps {
  onOpenTask?: (projectId: string, taskId: string) => void
}

const SCAN_INTERVAL_MS = 30 * 60 * 1000

async function callProjectAPI<T>(method: string, ...args: unknown[]): Promise<T> {
  const api = (window as unknown as { electronAPI?: { paa?: { project?: Record<string, (...args: unknown[]) => Promise<unknown>> } } }).electronAPI?.paa?.project
  const fn = api?.[method]
  if (!fn) throw new Error('项目待办服务未初始化')
  return fn(...args) as Promise<T>
}

function formatChanges(item: OwnerTodoScanItem): string[] {
  const changes: string[] = []
  if (item.suggestedAssignee) changes.push(`负责人：${item.suggestedAssignee.displayName}${item.assigneeReason ? `（${item.assigneeReason}）` : ''}`)
  if (item.suggestedDueDate !== undefined) changes.push(`截止日期：${new Date(item.suggestedDueDate).toLocaleDateString()}${item.dueDateReason ? `（${item.dueDateReason}）` : ''}`)
  if (item.suggestedStatus) changes.push(`状态：${item.suggestedStatus.name}${item.statusReason ? `（${item.statusReason}）` : ''}`)
  return changes
}

export function OwnerTodoScanPanel({ onOpenTask }: OwnerTodoScanPanelProps): React.ReactElement {
  const [scan] = useAtom(ownerTodoScanAtom)
  const requestScan = useSetAtom(ownerTodoScanRequestAtom)

  const applySuggestion = async (item: OwnerTodoScanItem) => {
    const changes: Record<string, unknown> = {}
    if (item.suggestedAssignee) {
      changes.assignee = item.suggestedAssignee
      if (item.suggestedAssigneeMemberId) changes.assigneeMemberId = item.suggestedAssigneeMemberId
    }
    if (item.suggestedDueDate !== undefined) changes.dueDate = item.suggestedDueDate
    if (item.suggestedStatus) changes.status = item.suggestedStatus.id
    const summary = formatChanges(item).map((line) => `• ${line}`).join('\n')
    if (!summary || !window.confirm(`确认应用这条待办建议？\n\n${item.projectTitle} · ${item.taskTitle}\n${summary}\n\n应用前会再次核对任务版本；本次不会启动员工。`)) return
    try {
      await callProjectAPI('applyTaskArrangementSuggestion', {
        suggestionId: item.id,
        taskId: item.taskId,
        expectedUpdatedAt: item.taskUpdatedAt,
        changes,
      })
      requestScan(Date.now())
    } catch (cause) {
      window.alert(cause instanceof Error ? cause.message : '建议应用失败')
      requestScan(Date.now())
    }
  }

  return <section className="mb-5 rounded-xl bg-card p-4 shadow-sm" aria-label="Owner 跨项目待办扫描">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h2 className="text-sm font-semibold">Owner 待办梳理</h2>
        <p className="mt-1 text-xs text-muted-foreground">主窗口运行期间每 30 分钟扫描全部项目（含归档）；展示优先级、依赖和阻塞，并给出负责人、日期或状态建议。依据本地项目事实生成，不调用模型；信息不足会标为待确认。</p>
      </div>
      <button type="button" onClick={() => requestScan(Date.now())} disabled={scan.isScanning} className="rounded-md border px-3 py-1.5 text-xs hover:bg-muted disabled:opacity-50">
        {scan.isScanning ? '扫描中…' : '立即扫描'}
      </button>
    </div>
    {scan.error && <p role="alert" className="mt-3 text-xs text-destructive">扫描失败：{scan.error}</p>}
    {scan.scannedAt && <p className="mt-2 text-xs text-muted-foreground">上次扫描：{new Date(scan.scannedAt).toLocaleString()}</p>}
    {scan.items.length === 0 ? <p className="mt-3 rounded-lg bg-muted/40 p-4 text-center text-sm text-muted-foreground">{scan.isScanning ? '正在扫描项目待办…' : '当前没有待安排任务'}</p> : <div className="mt-3 max-h-[36rem] space-y-2 overflow-auto pr-1">
      {scan.items.map((item) => {
        const changes = formatChanges(item)
        return <article key={`${item.projectId}:${item.taskId}`} className="rounded-lg bg-muted/40 p-3">
          <button type="button" disabled={!onOpenTask} onClick={() => onOpenTask?.(item.projectId, item.taskId)} className="block w-full text-left disabled:cursor-default">
            <span className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground"><span>{item.projectTitle}</span>{item.projectArchivedAt && <span className="rounded bg-amber-500/10 px-1.5 py-0.5 text-amber-700">归档项目</span>}<span>优先级：{item.priority}</span><span>状态：{item.taskStatusName}</span></span>
            <span className="mt-1 block text-sm font-medium">{item.taskTitle}</span>
            <span className="mt-1 block text-xs text-muted-foreground">当前负责人：{item.currentAssignee?.displayName ?? '未指定'}{item.currentDueDate ? ` · 当前截止：${new Date(item.currentDueDate).toLocaleDateString()}` : ' · 未设置截止日期'}</span>
            {item.dependencies.length > 0 && <span className="mt-1 block text-xs text-muted-foreground">依赖：{item.dependencies.join('、')}</span>}
            {item.blockers.length > 0 && <span className="mt-1 block text-xs text-destructive">阻塞：{item.blockers.join('；')}</span>}
          </button>
          {item.suggestedAssignee && <p className="mt-2 text-xs text-muted-foreground">建议负责人：{item.suggestedAssignee.displayName}。{item.assigneeReason}</p>}
          {item.suggestedDueDate !== undefined && <p className="mt-1 text-xs text-muted-foreground">建议日期：{new Date(item.suggestedDueDate).toLocaleDateString()}。{item.dueDateReason}</p>}
          {item.suggestedStatus && <p className="mt-1 text-xs text-muted-foreground">建议状态：{item.suggestedStatus.name}。{item.statusReason}</p>}
          {item.reviewReasons.length > 0 && <div className="mt-2 rounded bg-amber-500/10 px-2 py-1.5 text-xs text-amber-800"><strong>待确认：</strong>{item.reviewReasons.join('；')}</div>}
          {changes.length > 0 && <button type="button" onClick={() => void applySuggestion(item)} className="mt-2 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90">确认并应用建议</button>}
        </article>
      })}
    </div>}
  </section>
}

/** 主窗口常驻巡检器；切换到其他工作模块时继续按半小时周期读取任务事实。 */
export function OwnerTodoScanController(): null {
  const setScan = useSetAtom(ownerTodoScanAtom)
  const requestedAt = useAtomValue(ownerTodoScanRequestAtom)
  const busy = useRef(false)
  const lastRequest = useRef<number | null>(null)

  const runScan = useCallback(async () => {
    if (busy.current) return
    busy.current = true
    setScan((current) => ({ ...current, isScanning: true, error: undefined }))
    try {
      const now = Date.now()
      const items = await callProjectAPI<OwnerTodoScanItem[]>('listTaskArrangementSuggestions')
      const fingerprint = JSON.stringify(items)
      setScan((current) => current.fingerprint === fingerprint
        ? { ...current, scannedAt: now, isScanning: false, error: undefined }
        : { items, scannedAt: now, fingerprint, isScanning: false })
    } catch (cause) {
      setScan((current) => ({ ...current, isScanning: false, error: cause instanceof Error ? cause.message : '待办扫描失败' }))
    } finally {
      busy.current = false
    }
  }, [setScan])

  useEffect(() => {
    void runScan()
    const timer = setInterval(() => void runScan(), SCAN_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [runScan])

  useEffect(() => {
    if (requestedAt === null || requestedAt === lastRequest.current) return
    lastRequest.current = requestedAt
    void runScan()
  }, [requestedAt, runScan])

  return null
}

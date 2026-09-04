import * as React from 'react'
import { useAtom } from 'jotai'
import { AlertCircle, CheckCircle, CircleAlert, LoaderCircle, Plus, RefreshCw, XCircle } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { proactiveApprovalsAtom } from '@/atoms/proactive-data'
import type { ProactiveApproval } from '@gravitas/shared'

export function ApprovalsTab({ onRefresh }: { onRefresh: () => Promise<void> }): React.ReactElement {
  const [approvals, setApprovals] = useAtom(proactiveApprovalsAtom)
  const [resolvingId, setResolvingId] = React.useState<string | null>(null)
  const pendingApprovals = approvals.filter((approval) => approval.status === 'pending' || approval.status === 'edited')

  const replaceApproval = (updated: ProactiveApproval | null): void => {
    if (!updated) return
    setApprovals((current) => current.map((approval) => approval.id === updated.id ? updated : approval))
  }

  const approve = async (id: string): Promise<void> => {
    setResolvingId(id)
    try {
      const updated = await window.electronAPI.proactive?.approveApproval?.(id)
      replaceApproval(updated ?? null)
      if (updated?.executionStatus === 'failed') toast.error(updated.executionError ?? '批准后的变更执行失败')
      else toast.success('已批准并执行')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '批准失败')
    } finally {
      setResolvingId(null)
    }
  }

  const reject = async (id: string): Promise<void> => {
    setResolvingId(id)
    try {
      const updated = await window.electronAPI.proactive?.rejectApproval?.(id)
      replaceApproval(updated ?? null)
      toast.success('已拒绝该变更')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '拒绝失败')
    } finally {
      setResolvingId(null)
    }
  }

  const createTestApproval = async (): Promise<void> => {
    try {
      const approval = await window.electronAPI.proactive?.createTestMemoryApproval?.()
      if (!approval) return
      setApprovals((current) => [approval, ...current])
      toast.success('已创建测试记忆审批；同意前不会写入记忆')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '创建测试审批失败')
    }
  }

  return (
    <div className="p-4 space-y-4 max-w-4xl mx-auto">
      <section className="rounded-xl border border-border/50 bg-background shadow-sm">
        <div className="px-4 py-3 border-b border-border/50 flex items-center justify-between"><h3 className="text-sm font-medium flex items-center gap-2"><AlertCircle size={14} className="text-orange-500" />待审批 ({pendingApprovals.length})</h3><div className="flex gap-2"><Button variant="outline" size="sm" onClick={() => void onRefresh()}><RefreshCw className="mr-1 size-3.5" />刷新</Button><Button variant="outline" size="sm" onClick={() => void createTestApproval()}><Plus className="mr-1 size-3.5" />创建测试审批</Button></div></div>
        <div className="p-4 space-y-2">
          {pendingApprovals.length === 0 ? <p className="py-10 text-center text-sm text-muted-foreground">没有等待确认的主动变更。</p> : pendingApprovals.map((approval) => {
            const resolving = resolvingId === approval.id
            return <div key={approval.id} className="flex items-start gap-3 p-3 rounded-lg bg-foreground/[0.02] border border-border/40">
              <AlertCircle size={16} className="text-orange-500 mt-0.5 flex-shrink-0" />
              <div className="flex-1 min-w-0"><p className="text-sm font-medium">{approval.title}</p><p className="text-xs text-muted-foreground mt-0.5">{approval.summary}</p><p className="text-[11px] text-muted-foreground mt-1">来源：{approval.sourceType}{approval.status === 'edited' ? ' · 已编辑，需再次确认' : ''}</p></div>
              <div className="flex items-center gap-1.5"><Button variant="outline" size="sm" disabled={resolving} onClick={() => void approve(approval.id)}>{resolving ? <LoaderCircle className="mr-1 size-3.5 animate-spin" /> : <CheckCircle className="mr-1 size-3.5" />}同意</Button><Button variant="ghost" size="sm" disabled={resolving} onClick={() => void reject(approval.id)}><XCircle className="mr-1 size-3.5" />拒绝</Button></div>
            </div>
          })}
        </div>
      </section>
      {approvals.some((approval) => approval.status === 'approved' && approval.executionStatus === 'failed') && <section className="rounded-xl border border-destructive/30 bg-destructive/5 p-4"><p className="flex items-center gap-2 text-sm font-medium text-destructive"><CircleAlert size={15} />存在批准后执行失败的变更</p><p className="mt-1 text-xs text-muted-foreground">失败结果已保留在审批记录与运行审计中；请修订后重新确认。</p></section>}
    </div>
  )
}

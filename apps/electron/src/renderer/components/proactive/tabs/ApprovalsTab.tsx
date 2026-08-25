/**
 * Approvals Tab - 待审批列表
 */

import * as React from 'react'
import { useAtom } from 'jotai'
import { AlertCircle, CheckCircle, XCircle, Construction } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { proactiveApprovalsAtom } from '@/atoms/proactive-data'

export function ApprovalsTab(): React.ReactElement {
  const [approvals] = useAtom(proactiveApprovalsAtom)

  const pendingApprovals = approvals.filter((a) => a.status === 'pending')

  return (
    <div className="p-4 space-y-4 max-w-4xl mx-auto">
      {/* 占位提示 */}
      <div className="rounded-xl border border-dashed border-amber-200/50 dark:border-amber-800/30 bg-amber-50/30 dark:bg-amber-950/10">
        <div className="flex flex-col items-center justify-center py-16">
          <Construction className="size-10 text-amber-500 mb-3" />
          <p className="text-sm font-medium text-amber-700 dark:text-amber-300">Approval 功能即将推出</p>
          <p className="text-xs text-amber-600/70 dark:text-amber-400/70 mt-1">自动审批流正在开发中</p>
        </div>
      </div>

      {pendingApprovals.length > 0 && (
        <div className="rounded-xl border border-border/50 bg-background shadow-sm">
          <div className="px-4 py-3 border-b border-border/50">
            <h3 className="text-sm font-medium flex items-center gap-2">
              <AlertCircle size={14} className="text-orange-500" />
              待审批 ({pendingApprovals.length})
            </h3>
          </div>
          <div className="p-4 space-y-2">
            {pendingApprovals.map((approval) => (
              <div key={approval.id} className="flex items-center gap-3 p-3 rounded-lg bg-foreground/[0.02] border border-border/40">
                <AlertCircle size={16} className="text-orange-500 flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium">{approval.title}</p>
                  <p className="text-xs text-muted-foreground">{approval.summary}</p>
                </div>
                <div className="flex items-center gap-1.5">
                  <Button variant="outline" size="sm"><CheckCircle className="mr-1 size-3.5" />同意</Button>
                  <Button variant="ghost" size="sm"><XCircle className="mr-1 size-3.5" />拒绝</Button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

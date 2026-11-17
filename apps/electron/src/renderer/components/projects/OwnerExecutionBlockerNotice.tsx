import type { OwnerExecutionAttention } from './project-owner-execution-attention'

/** 执行阻塞的统一提示；对话区与执行区共用同一份文案与入口，避免两处状态不一致。 */
export function OwnerExecutionBlockerNotice({ attention, onOpenEvidence, onRecheckWorkspace }: {
  attention: OwnerExecutionAttention
  onOpenEvidence?: () => void
  onRecheckWorkspace?: () => void
}): React.ReactElement {
  return <section role="alert" aria-label="执行阻塞" className="space-y-2 rounded-xl bg-amber-500/10 p-3 text-sm">
    <p className="font-medium">{attention.title}</p>
    <p className="leading-6">{attention.detail}</p>
    <ul className="list-disc pl-5 text-xs text-muted-foreground">{attention.actions.map(action => <li key={action}>{action}</li>)}</ul>
    <div className="flex flex-wrap gap-3">
      {onOpenEvidence && <button type="button" className="text-primary underline" onClick={onOpenEvidence}>查看失败证据与工作区</button>}
      {onRecheckWorkspace && attention.recheckExecutionId && <button type="button" className="text-primary underline" onClick={onRecheckWorkspace}>重新核对工作区</button>}
    </div>
  </section>
}

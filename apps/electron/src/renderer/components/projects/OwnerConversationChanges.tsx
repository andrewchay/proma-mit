import { useMemo } from 'react'
import { atom, useAtomValue, useSetAtom } from 'jotai'
import type { OwnerConversationChangeView, ProjectOwnerGoalSubject } from '@gravitas/shared'
import { getOwnerManagementEditor, ownerManagementEditorsAtom } from '../../atoms/project-owner-management-atoms'
import { decideOwnerConversationChangeAtom, getOwnerConversationChangeEditor, ownerConversationChangeEditorsAtom } from '../../atoms/owner-conversation-change-atoms'

function ChangeCard({ subject, change }: { subject: ProjectOwnerGoalSubject; change: OwnerConversationChangeView }): React.ReactElement {
  const state = useMemo(() => atom(get => getOwnerConversationChangeEditor(get(ownerConversationChangeEditorsAtom), subject.projectId, change.id)), [subject.projectId, change.id])
  const editor = useAtomValue(state), decide = useSetAtom(decideOwnerConversationChangeAtom)
  const proposal = change.change
  const removedConstraints = proposal.kind === 'goal_revision' ? change.currentGoal.constraints.filter(item => !proposal.goal.constraints.includes(item)) : []
  const removedCriteria = proposal.kind === 'goal_revision' ? change.currentGoal.acceptanceCriteria.filter(item => !proposal.goal.acceptanceCriteria.includes(item)) : []
  return <section className="space-y-3 rounded-2xl bg-primary/5 p-4 text-sm shadow-sm" aria-label="Owner理解待确认">
    <h3 className="font-medium">我这样理解，是否准确？</h3><p className="whitespace-pre-wrap leading-6">{change.summary}</p>
    {change.change.kind === 'clarification_answers' ? <dl className="space-y-3">{change.questions.map(item => <div key={item.key}><dt className="text-muted-foreground">{item.question}</dt><dd className="mt-1 whitespace-pre-wrap">{change.change.kind === 'clarification_answers' ? change.change.answers[item.key] : ''}</dd></div>)}</dl> : <div className="space-y-2">
      <p className="font-medium">更新后的目标</p><p className="whitespace-pre-wrap">{change.change.goal.objective}</p>
      <p>约束：{change.change.goal.constraints.join('；') || '无额外约束'}</p><p>完成标准：{change.change.goal.acceptanceCriteria.join('；') || '待共同明确'}</p>
      {removedConstraints.length > 0 && <p className="rounded-lg bg-amber-500/10 p-2">将移除的原约束：{removedConstraints.join('；')}</p>}
      {removedCriteria.length > 0 && <p className="rounded-lg bg-amber-500/10 p-2">将移除的原完成标准：{removedCriteria.join('；')}</p>}
      <details><summary className="cursor-pointer text-xs text-muted-foreground">查看原目标</summary><p className="mt-2 whitespace-pre-wrap">{change.currentGoal.objective}</p></details>
      <p className="text-xs leading-5 text-muted-foreground">更新后，旧方案和执行范围需重新核对，旧管理委托不再使用；新范围和预算再与你确认。已发送请求的状态与费用保留。</p>
    </div>}
    {editor.error && <p role="alert" className="text-destructive">{editor.error}</p>}
    <div className="flex flex-wrap gap-3">{(['apply', 'dismiss'] as const).map(action => <button key={action} type="button" className={action === 'apply' ? 'rounded-xl bg-primary px-4 py-2 text-primary-foreground disabled:opacity-50' : 'rounded-xl bg-background px-4 py-2 shadow-sm disabled:opacity-50'} disabled={editor.busy || Boolean(editor.pending && editor.pending.action !== action)} onClick={() => void decide({ subject, changeId: change.id, action })}>{editor.busy && editor.pending?.action === action ? '正在确认…' : editor.pending?.action === action ? '重新核对上次确认' : action === 'dismiss' ? '理解有误，暂不采用' : change.change.kind === 'clarification_answers' ? '确认答复，继续规划' : '确认更新目标'}</button>)}</div>
    {change.change.kind === 'clarification_answers' && <p className="text-xs text-muted-foreground">确认后按这些答复补充目标，并在有效管理额度内继续规划；不代表开始业务执行。</p>}
  </section>
}
export function OwnerConversationChanges({ projectId, taskId }: ProjectOwnerGoalSubject): React.ReactElement | null {
  const subject = useMemo(() => ({ projectId, ...(taskId ? { taskId } : {}) }), [projectId, taskId])
  const view = useMemo(() => atom(get => getOwnerManagementEditor(get(ownerManagementEditorsAtom), projectId).view?.changes?.filter(item => item.taskId === taskId) ?? []), [projectId, taskId])
  const changes = useAtomValue(view), editors = useAtomValue(ownerConversationChangeEditorsAtom)
  const needsDecision = (item: OwnerConversationChangeView) => item.state === 'pending' || Boolean(getOwnerConversationChangeEditor(editors, projectId, item.id).pending)
  if (!changes.length) return null
  return <div className="space-y-3">
    {changes.filter(needsDecision).map(item => <ChangeCard key={item.id} subject={subject} change={item} />)}
    {changes.some(item => !needsDecision(item)) && <details className="rounded-xl bg-muted/30 p-3 text-xs text-muted-foreground"><summary className="cursor-pointer">此前内容确认</summary>{changes.filter(item => !needsDecision(item)).map(item => <p key={item.id} className="mt-2 whitespace-pre-wrap">{item.state === 'applied' ? '已采用' : item.state === 'dismissed' ? '未采用' : '来源或后续表达已变化，未应用'}：{item.summary}</p>)}</details>}
  </div>
}

import { useMemo } from 'react'
import { atom, useAtom, useAtomValue, useSetAtom } from 'jotai'
import type { OwnerManagementDeliveryItem, OwnerManagementDeliveryReference, ProjectOwnerGoalSubject } from '@gravitas/shared'
import { ownerDeliveryDecisionKey, ownerDeliveryDecisionStatesAtom, reloadOwnerDeliveryDecisionAtom, submitOwnerDeliveryDecisionAtom } from '@/atoms/owner-delivery-decision-atoms'

/** 对已交付的准确版本记录用户选择；不会把审阅当成项目交付链的正式验收。 */
export function OwnerDeliveredDecisionCard({ subject, item, reference, onOpen, acceptanceBlocker }: { subject: ProjectOwnerGoalSubject; item: OwnerManagementDeliveryItem; reference: OwnerManagementDeliveryReference; onOpen: () => void; acceptanceBlocker?: string | null }): React.ReactElement {
  const choiceAtom = useMemo(() => atom<{ choice: '' | 'accepted' | 'changes_requested' | 'later'; note: string }>({ choice: '', note: '' }), [reference.messageId, reference.stepKey, reference.artifactHash])
  const [draft, setDraft] = useAtom(choiceAtom)
  const state = useAtomValue(ownerDeliveryDecisionStatesAtom).get(ownerDeliveryDecisionKey(subject, reference))
  const submit = useSetAtom(submitOwnerDeliveryDecisionAtom)
  const reload = useSetAtom(reloadOwnerDeliveryDecisionAtom)
  const locked = Boolean(state?.busy || state?.pending || state?.confirmed)
  const canSubmit = !state?.busy && !state?.confirmed && Boolean(state?.pending || draft.choice === 'later' || draft.choice === 'accepted' && !acceptanceBlocker || draft.choice === 'changes_requested' && draft.note.trim())
  const handleSubmit = (): void => {
    const decision = state?.pending?.deliveryReviewDecision ?? (draft.choice === 'later' ? 'deferred' : draft.choice || undefined)
    if (decision) void submit({ subject, reference, decision, note: draft.note }).then(saved => { if (saved && decision === 'deferred') setDraft({ choice: '', note: '' }) })
  }
  return <section className="space-y-4" aria-label="成果版本审阅决定">
    <div><span className="rounded bg-primary/10 px-2 py-1 text-xs text-primary">需要你验收</span><h5 className="mt-3 text-lg font-semibold">{item.title}，这一版可以交付了吗？</h5><button type="button" className="mt-1 text-xs text-primary underline underline-offset-4" onClick={onOpen}>查看产物 / 点选反馈 ↗</button></div>
    <div className="border-t border-border/50 pt-3"><p className="text-sm font-medium">审阅依据</p><p className="mt-1 text-xs text-muted-foreground">独立检查：{item.reviewerSummary || '未附检查摘要'}</p>{item.acceptanceCriteria.length > 0 && <ul className="mt-2 space-y-1 text-xs text-muted-foreground">{item.acceptanceCriteria.map((criterion, index) => <li key={`${index}-${criterion}`}>✓ {criterion}</li>)}</ul>}</div>
    {acceptanceBlocker && <p role="alert" className="rounded-lg bg-amber-500/10 p-3 text-sm">{acceptanceBlocker} <button type="button" className="text-primary underline" onClick={onOpen}>查看证据</button></p>}
    <fieldset disabled={locked} className="grid gap-2 sm:grid-cols-3">{([{ value: 'accepted', label: '通过这一版', detail: '认可当前成果' }, { value: 'changes_requested', label: '需要修改', detail: '说明需要调整的内容' }, { value: 'later', label: '稍后决定', detail: '保持待审阅' }] as const).map(option => <label key={option.value} className="flex cursor-pointer gap-2 rounded-lg bg-background p-3 ring-1 ring-border has-[:checked]:bg-primary/10 has-[:checked]:ring-primary"><input type="radio" disabled={option.value === 'accepted' && Boolean(acceptanceBlocker)} name={`owner-review-${reference.messageId}-${reference.stepKey}`} checked={draft.choice === option.value} onChange={() => setDraft(current => ({ ...current, choice: option.value }))} /><span><span className="block text-sm font-medium">{option.label}</span><span className="block text-xs text-muted-foreground">{option.detail}</span></span></label>)}</fieldset>
    {draft.choice === 'changes_requested' && <label className="block text-xs">修改意见<textarea className="mt-1 w-full rounded-lg bg-background p-3 text-sm ring-1 ring-border" rows={2} maxLength={3900} value={draft.note} disabled={locked} onChange={event => setDraft(current => ({ ...current, note: event.target.value }))} /></label>}
    {state?.error && <p role="alert" className="text-sm text-destructive">{state.error}{state.pending && '；请重试同一决定。'}{state.confirmed && <button type="button" className="ml-2 underline" onClick={() => void reload({ subject, reference })}>重新读取</button>}</p>}
    {state?.confirmed && <p role="status" className="text-sm text-primary">决定已保存，正在更新对话记录。</p>}
    <div className="flex items-center justify-between gap-3 border-t border-border/50 pt-3"><span className="text-xs text-muted-foreground">决定记录在 Owner 对话中，不自动修改任务或批准发布。</span><button type="button" className="rounded-lg bg-primary px-4 py-2 text-sm text-primary-foreground disabled:opacity-50" disabled={!canSubmit} onClick={handleSubmit}>{state?.busy ? '正在保存…' : state?.confirmed ? '已保存' : state?.pending ? '重试保存' : '提交决定'}</button></div>
  </section>
}

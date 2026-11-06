import { useEffect, useMemo } from 'react'
import { atom, useAtom, useSetAtom } from 'jotai'
import type { OwnerExecutionAutonomousScheduleStatus, OwnerExecutionCommandView, ProjectChain, ProjectDeliverable, ProjectJudgmentReasonCode } from '@gravitas/shared'
import { findOwnerAcceptanceTarget } from './owner-acceptance-target'
import { JUDGMENT_REASON_LABELS } from './JudgmentReasonSelect'
import { OwnerDeliveredArtifact } from './OwnerDeliveredArtifact'
import { ownerAcceptancePendingAtom, rememberOwnerAcceptanceChainAtom } from '@/atoms/owner-acceptance-chain-atoms'

interface AcceptanceState {
  chain: ProjectChain | null
  loading: boolean
  busy: boolean
  error: string
  choice: 'accept' | 'reject' | 'later' | ''
  evidence: string
  reason: ProjectJudgmentReasonCode | ''
  checked: string[]
  showArtifact: boolean
}

/** 卡片只操作与当前授权、任务和执行精确关联的项目交付版本。 */
export function OwnerAcceptanceCard({ projectId, schedule, commands, onChanged, onDiscuss, feedbackDisabled, feedbackCapacity }: {
  projectId: string
  schedule: OwnerExecutionAutonomousScheduleStatus
  commands: readonly OwnerExecutionCommandView[]
  onChanged: () => void
  onDiscuss?: (delivery: ProjectDeliverable, excerpt?: string, intent?: 'question' | 'change') => void
  feedbackDisabled?: boolean
  feedbackCapacity?: number
}): React.ReactElement {
  const stateAtom = useMemo(() => atom<AcceptanceState>({ chain: null, loading: true, busy: false, error: '', choice: '', evidence: '', reason: '', checked: [], showArtifact: false }), [projectId, schedule.grantId, schedule.taskId])
  const [state, setState] = useAtom(stateAtom)
  const [pending, setPending] = useAtom(ownerAcceptancePendingAtom)
  const pendingKey = JSON.stringify([projectId, schedule.grantId, schedule.taskId, schedule.reworkOrdinal])
  const pendingRequest = pending.get(pendingKey)
  const rememberChain = useSetAtom(rememberOwnerAcceptanceChainAtom)
  useEffect(() => {
    let active = true
    void window.electronAPI.paa.project.getChain(projectId).then(chain => {
      if (active) setState(current => ({ ...current, chain, loading: false }))
    }).catch(error => { if (active) setState(current => ({ ...current, loading: false, error: error instanceof Error ? error.message : '读取交付失败' })) })
    return () => { active = false }
  }, [projectId, setState])
  const delivery = state.chain && findOwnerAcceptanceTarget(state.chain, schedule, commands)
  const reviewer = delivery?.responsibilities?.reviewerId
  const canDecide = reviewer === 'local-user'
  const criteriaConfirmed = Boolean(delivery && delivery.definitionOfDone.every(item => state.checked.includes(item)))
  const hasRequiredInput = state.choice === 'later' || Boolean(state.evidence.trim() && (state.choice !== 'reject' || state.reason) && (state.choice !== 'accept' || criteriaConfirmed))
  const ready = Boolean(!state.busy && (pendingRequest || delivery && canDecide && state.choice && hasRequiredInput))
  const reload = async (): Promise<void> => {
    setState(current => ({ ...current, loading: true, error: '', choice: '', evidence: '', reason: '', checked: [] }))
    try {
      const chain = await window.electronAPI.paa.project.getChain(projectId)
      rememberChain({ projectId, chain })
      setState(current => ({ ...current, chain, loading: false }))
      onChanged()
    } catch (error) { setState(current => ({ ...current, loading: false, error: error instanceof Error ? error.message : '读取交付失败' })) }
  }
  const submit = async (): Promise<void> => {
    if (!ready || (!pendingRequest && (!delivery || !state.chain || !schedule.grantId || !schedule.taskId || schedule.reworkOrdinal === undefined || !state.choice))) return
    setState(current => ({ ...current, busy: true, error: '' }))
    try {
      const api = window.electronAPI.paa.project
      const request = pendingRequest ?? { projectId, requestId: crypto.randomUUID(), grantId: schedule.grantId!, taskId: schedule.taskId!, reworkOrdinal: schedule.reworkOrdinal!, revision: state.chain!.revision, draftId: delivery!.id, version: delivery!.version, choice: state.choice as 'accept' | 'reject' | 'later', comment: state.evidence.trim(), completedCriteria: state.checked, ...(state.choice === 'reject' ? { reasonCode: state.reason as ProjectJudgmentReasonCode } : {}) }
      setPending(current => new Map(current).set(pendingKey, request))
      const response = await api.decideOwnerChainDelivery(request)
      if (!response.ok) {
        setPending(current => { const next = new Map(current); next.delete(pendingKey); return next })
        throw new Error(response.error.message)
      }
      const updated = response.value
      setPending(current => { const next = new Map(current); next.delete(pendingKey); return next })
      rememberChain({ projectId, chain: updated })
      setState(currentState => ({ ...currentState, chain: updated, busy: false, choice: '', evidence: '', checked: [] }))
      onChanged()
    } catch (error) { setState(current => ({ ...current, busy: false, error: error instanceof Error ? error.message : '保存验收决定失败' })) }
  }
  return <section className="space-y-4" aria-label="成果验收决定">
    <div><span className="rounded bg-primary/10 px-2 py-1 text-xs text-primary">需要你验收</span><h5 className="mt-3 text-lg font-semibold">{delivery ? `${delivery.title}，可以交付了吗？` : '成果等待验收'}</h5>{delivery && <button type="button" className="mt-1 text-xs text-primary underline underline-offset-4" onClick={() => setState(current => ({ ...current, showArtifact: !current.showArtifact }))}>{state.showArtifact ? '收起产物' : '查看产物 / 点选反馈 ↗'}</button>}</div>
    {state.loading ? <p className="text-sm text-muted-foreground">正在核对交付版本…</p> : !delivery ? pendingRequest ? <div className="space-y-2"><p role="alert" className="text-sm text-muted-foreground">上次决定的保存回执尚未确认，请重试原请求。</p><button type="button" disabled={state.busy} className="rounded-lg bg-primary px-4 py-2 text-sm text-primary-foreground disabled:opacity-50" onClick={() => void submit()}>{state.busy ? '正在保存…' : '重试保存'}</button></div> : <p role="alert" className="text-sm text-muted-foreground">未找到与当前执行唯一对应的已提交交付版本，请先核对项目交付记录。 <button type="button" className="text-primary underline" onClick={() => void reload()}>重新核对</button></p> : <>
      {state.showArtifact && <OwnerDeliveredArtifact source="chain" item={{ stepKey: delivery.id, title: delivery.title, artifactHash: `${delivery.id}:${delivery.version}`, content: delivery.content, acceptanceCriteria: delivery.definitionOfDone, ownerDecision: '', reviewerSummary: '' }} feedbackDisabled={feedbackDisabled} feedbackCapacity={feedbackCapacity} onRequestChanges={onDiscuss ? (excerpt, intent) => onDiscuss(delivery, excerpt, intent) : undefined} />}
      <div className="border-t border-border/50 pt-3 text-sm"><p className="font-medium">验收依据 · 版本 {delivery.version}</p><p className="mt-1 text-xs text-muted-foreground">{delivery.criteria}</p>{delivery.definitionOfDone.map(item => <label key={item} className="mt-2 flex items-start gap-2 text-xs"><input type="checkbox" disabled={state.busy || Boolean(pendingRequest)} checked={state.checked.includes(item)} onChange={event => setState(current => ({ ...current, checked: event.target.checked ? [...current.checked, item] : current.checked.filter(value => value !== item) }))} />{item}</label>)}</div>
      {!canDecide && <p role="alert" className="text-sm text-destructive">当前交付的验收人不是本机用户，不能代为决定。</p>}
      <fieldset disabled={state.busy || Boolean(pendingRequest) || !canDecide} className="grid gap-2 sm:grid-cols-3">{([{ value: 'accept', label: '通过这一版', detail: '符合完成标准' }, { value: 'reject', label: '需要修改', detail: '记录原因并退回' }, { value: 'later', label: '稍后决定', detail: '保持待验收' }] as const).map(option => <label key={option.value} className="flex cursor-pointer gap-2 rounded-lg bg-background p-3 ring-1 ring-border has-[:checked]:bg-primary/10 has-[:checked]:ring-primary"><input type="radio" name="owner-acceptance" checked={state.choice === option.value} onChange={() => setState(current => ({ ...current, choice: option.value }))} /><span><span className="block text-sm font-medium">{option.label}</span><span className="block text-xs text-muted-foreground">{option.detail}</span></span></label>)}</fieldset>
      {(state.choice === 'accept' || state.choice === 'reject') && <div className="space-y-2"><label className="block text-xs">{state.choice === 'accept' ? '验收依据' : '修改原因'}<textarea disabled={state.busy || Boolean(pendingRequest)} className="mt-1 w-full rounded-lg bg-background p-3 text-sm ring-1 ring-border" value={state.evidence} onChange={event => setState(current => ({ ...current, evidence: event.target.value }))} rows={2} /></label>{state.choice === 'reject' && <select disabled={state.busy || Boolean(pendingRequest)} aria-label="退回原因分类" className="rounded-lg bg-background p-2 text-sm ring-1 ring-border" value={state.reason} onChange={event => setState(current => ({ ...current, reason: event.target.value as ProjectJudgmentReasonCode | '' }))}><option value="">选择原因分类</option>{Object.entries(JUDGMENT_REASON_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>}</div>}
      <div className="flex items-center justify-between border-t border-border/50 pt-3"><span className="text-xs text-muted-foreground">决定记录在 Owner 对话中，仅针对此交付版本，不含发布授权。</span><button type="button" disabled={!ready} onClick={() => void submit()} className="rounded-lg bg-primary px-4 py-2 text-sm text-primary-foreground disabled:opacity-50">{state.busy ? '正在保存…' : pendingRequest ? '重试保存' : '提交决定'}</button></div>
    </>}
    {state.error && <p role="alert" className="text-sm text-destructive">{state.error} <button type="button" className="underline" disabled={state.loading || state.busy} onClick={() => void reload()}>重新核对</button></p>}
  </section>
}

import { useEffect, useMemo, useState } from 'react'
import { atom, useAtomValue, useSetAtom } from 'jotai'
import type { OwnerManagementAttentionCheck, OwnerManagementDelegationInput } from '@gravitas/shared'
import { actOwnerDelegationAtom, editOwnerDelegationAtom, getOwnerDelegationEditor, loadOwnerDelegationAtom, ownerDelegationEditorsAtom } from '../../atoms/owner-management-delegation-atoms'
const usd = (micros: number): string => `$${(micros / 1000000).toFixed(2)}`
const attentionReason: Record<OwnerManagementAttentionCheck['reason'], string> = {
  missing_execution: '找不到对应的执行记录', missing_outcome: '原请求没有保存可验证的处理结论',
  non_continueable_outcome: '原请求结论不是可继续的回应/澄清/提案', missing_receipt: '缺少原请求运行回执',
  missing_usage: '运行回执没有可验证的模型用量', invalid_usage: '运行回执中的模型用量不完整或格式无效', output_limit: '模型输出达到本次请求上限，未形成完整结果',
}
const executionLabel: Record<OwnerManagementAttentionCheck['executionStatus'], string> = {
  queued: '排队中', running: '运行中', completed: '已结束', failed: '失败', cancelled: '已取消', stale: '状态过期', missing: '记录缺失',
}
const outcomeLabel: Record<OwnerManagementAttentionCheck['outcomeState'], string> = {
  proposed: '已生成提案', needs_clarification: '等待澄清', replied: '已回应', stale: '来源过期', failed: '处理失败', unknown: '结果未知', stopped: '已停止', missing: '结论缺失',
}
/** 当前许可卡仅管理推理；执行许可与项目敏感审批继续沿用权威链。 */
export function OwnerManagementDelegationCard({ projectId, taskId }: { projectId: string; taskId?: string }): React.ReactElement | null {
  const subject = useMemo(() => ({ projectId, ...(taskId ? { taskId } : {}) }), [projectId, taskId])
  const subjectKey = JSON.stringify([projectId, taskId ?? null])
  const view = useMemo(() => atom(get => getOwnerDelegationEditor(get(ownerDelegationEditorsAtom), subject)), [subject])
  const editor = useAtomValue(view), load = useSetAtom(loadOwnerDelegationAtom), edit = useSetAtom(editOwnerDelegationAtom), act = useSetAtom(actOwnerDelegationAtom)
  const [runCheck, setRunCheck] = useState<{ subjectKey: string; status: 'checking' | 'done' } | null>(null)
  const checkingRun = runCheck?.subjectKey === subjectKey && runCheck.status === 'checking'
  const runCheckDone = runCheck?.subjectKey === subjectKey && runCheck.status === 'done'
  useEffect(() => {
    void load(subject)
    const refresh = () => { void load(subject) }
    window.addEventListener('focus', refresh)
    const off = window.electronAPI?.paa?.project?.onOwnerManagementChanged?.(change => { if (change.projectId === projectId) refresh() })
    return () => { window.removeEventListener('focus', refresh); off?.() }
  }, [load, subject, projectId])
  const current = editor.view?.delegation
  const scope = taskId ? '本任务范围' : '本项目范围'
  const needsRunReconciliation = editor.view?.state === 'attention'
  const stale = editor.view?.state === 'stale'
  const attention = editor.view?.attentionCheck
  const canOffer = !current || editor.view?.state === 'revoked' || editor.view?.state === 'expired' || stale
  const active = Boolean(current && editor.view?.state === 'active')
  const title = needsRunReconciliation ? 'Owner 已暂停：需要核对上次请求' : stale ? 'Owner 已暂停：授权范围需要重新确认' : '让 Owner 在对话中持续推进'
  const description = needsRunReconciliation
    ? '上一条模型请求尚未核对完成，Owner 已暂停并保留你的新消息。重新确认授权范围不会解除这次暂停，也不会重发请求；请先核对下方的原请求证据。'
    : stale
      ? '确认时使用的项目配置、资料范围或费用依据已有变化，因此 Owner 暂停后续模型请求，不会沿用旧授权。请重新核对当前预算和期限，再确认新范围；确认后 Owner 会从当前进度继续。'
      : '确认后，Owner会在项目总预算、目标和资料范围内自行规划、安排并启动团队，跟进进度、独立检查成果和组织返工。只有需要业务决定、扩大范围或触及外部敏感动作时才会回来商量；发布和外发不包含在内。'
  useEffect(() => {
    if (!editor.view || !canOffer || editor.preview || editor.busy || editor.error) return
    const timer = window.setTimeout(() => { void act({ subject, action: 'preview' }) }, 250)
    return () => window.clearTimeout(timer)
  }, [act, canOffer, editor.busy, editor.error, editor.preview, editor.view, subject])
  if (typeof window === 'undefined' || !window.electronAPI?.paa?.project?.previewOwnerManagementDelegation) return null
  if (active && current) return <p role="status" className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
    <span>项目管理授权有效。实际进度及需要处理的事项见下方。</span><span>Owner模型：{current.modelId}</span>
    <button type="button" className="underline underline-offset-2" disabled={editor.busy} onClick={() => void act({ subject, action: 'revoke' })}>撤销授权</button>
  </p>
  return <section aria-label="Owner管理委托" className="space-y-3 rounded-2xl bg-primary/5 p-4 shadow-sm">
    <div><h3 className="text-sm font-medium">{title}</h3><p role={stale ? 'alert' : undefined} className="mt-1 text-xs leading-5 text-muted-foreground">{description}</p></div>
    {editor.error && <p role="alert" className="text-sm text-destructive">{editor.error}</p>}
    {current && <div className="space-y-2 rounded-xl bg-background/70 p-3 text-sm">
      <p>{editor.view?.detail}</p>
      {(editor.view?.ownerModelBudget ?? null) && <p className="text-xs text-muted-foreground">Owner模型开销已用 {usd(editor.view!.ownerModelBudget!.settledMicros)}、在途预留 {usd(editor.view!.ownerModelBudget!.inFlightMicros)}，合计不超过项目预算的 {Math.round(editor.view!.ownerModelBudget!.ratio * 100)}%（上限 {usd(editor.view!.ownerModelBudget!.limitMicros)}）。超出需你重新授权，不会自动放宽。</p>}
      <p className="text-xs text-muted-foreground">模型 {current.modelId} · 预算上限 {usd(current.maxCostMicros)} · 已预留 {usd(editor.view?.reservedCostMicros ?? 0)} · 有效至 {new Date(current.expiresAt).toLocaleString()}</p>
      <p className="text-xs text-muted-foreground">预留金额按保守上界计算，不是实际账单；预算用尽或请求/费用状态不明时会暂停核对，不自动重试。</p>
      {stale && <button type="button" className="rounded-lg bg-background px-3 py-2 text-sm shadow-sm" disabled={editor.busy} onClick={() => void act({ subject, action: 'preview' })}>重新核对当前授权</button>}
      {needsRunReconciliation && <div className="space-y-3 rounded-lg bg-amber-500/10 p-3" role="alert"><p className="text-sm">当前不会处理新消息或重发模型请求。请先核对原请求是否已产生用量；刷新只读取本地最新状态，不会发送请求、释放预留或更改授权。</p>{attention && <div className="space-y-1 rounded-md bg-background/70 p-3 text-xs"><p className="font-medium">原请求核对信息</p><p>暂停原因：{attentionReason[attention.reason]}</p><p>本地执行：{executionLabel[attention.executionStatus]} · Owner结论：{outcomeLabel[attention.outcomeState]}</p>{attention.outcomeDetail && <p>处理详情：{attention.outcomeDetail}</p>}<p>请求时间：{attention.requestStartedAt ? new Date(attention.requestStartedAt).toLocaleString() : '未知'}{attention.receiptCapturedAt ? ` · 回执时间：${new Date(attention.receiptCapturedAt).toLocaleString()}` : ''}</p>{attention.modelId && <p>模型：{attention.modelId}</p>}<p>模型用量：{attention.inputTokens !== null && attention.outputTokens !== null ? `输入 ${attention.inputTokens} / 输出 ${attention.outputTokens} tokens` : '未知或未报告'}</p><p>费用证据：{attention.costSource === 'runtime_reported' && attention.costUsd !== null ? `Runtime报告 ${usd(Math.round(attention.costUsd * 1000000))}（不是服务商账单核验）` : attention.costSource === 'unknown' ? '未知，尚无可信成本回执' : '没有成本回执'}</p><p>服务商请求编号：{attention.providerRequestId ?? '本地没有保存服务商请求编号'}{attention.providerResponseId ? ` · 响应编号：${attention.providerResponseId}` : ''}</p><p>这些是应用本地保存的证据，不代表已确认账单。若要核对实际用量，可在服务商账单中按请求编号（如有）、模型与时间查找；当前界面没有将外部账单核对结果写回并恢复授权的操作。</p></div>}<button type="button" className="rounded-lg bg-background px-3 py-2 text-sm shadow-sm" disabled={editor.busy || checkingRun} onClick={() => { setRunCheck({ subjectKey, status: 'checking' }); void load(subject).finally(() => setRunCheck({ subjectKey, status: 'done' })) }}>{checkingRun ? '正在读取本地状态…' : '重新读取上次请求状态'}</button>{checkingRun && <p role="status" aria-live="polite" className="text-xs">正在读取已保存的请求记录；不会联系模型或服务商。</p>}{runCheckDone && !checkingRun && !editor.error && <p role="status" aria-live="polite" className="text-xs">已重新读取本地状态；以上为当前保存的原请求证据，不会查询账单或解除暂停。</p>}</div>}
      {(!current.conversationEnabled || !current.qualityDecisionEnabled || !current.fullDeliveryReviewEnabled || !current.executionFollowupEnabled) && <p className="text-xs">当前委托不包含所有持续对话、完整成果检查和主动跟进能力；启用缺少的范围需要重新确认。</p>}
      {editor.view?.state !== 'revoked' && <button type="button" className="text-xs underline" disabled={editor.busy} onClick={() => void act({ subject, action: 'revoke' })}>撤销后续管理授权</button>}
    </div>}
    {canOffer && <fieldset disabled={editor.busy} className="space-y-3 rounded-xl bg-background/70 p-3">
      <legend className="px-1 text-xs font-medium">项目总预算与管理范围</legend>
      <p className="text-xs leading-5 text-muted-foreground">这是{scope}Owner与团队共用的项目总模型费用上限，覆盖规划、员工执行、独立检查和后续跟进。确认一次后，Owner会在该额度内自主推进，不会逐步要求你批准普通计划或员工启动。</p>
      <div className="grid gap-3 sm:grid-cols-2">{([{ key: 'budgetUsd', label: '项目总模型费用上限（美元）', min: 0.01, max: 100, step: 0.01 }, { key: 'hours', label: '授权有效时间（小时）', min: 1, max: 168, step: 1 }] as const).map(item => <label key={item.key} className="block text-xs">{item.label}<input aria-label={item.label} className="mt-1 w-full rounded-lg bg-muted/50 p-2 text-sm" type="number" min={item.min} max={item.max} step={item.step} value={editor[item.key]} onChange={event => edit({ subject, patch: { [item.key]: event.target.value } })} /></label>)}</div>
      {!editor.preview && editor.error && <button type="button" className="rounded-xl bg-background px-4 py-2 text-sm shadow-sm" disabled={editor.busy} onClick={() => void act({ subject, action: 'preview' })}>重新核对授权范围</button>}
      {editor.preview && <div className="space-y-3 rounded-xl bg-background p-3 text-sm">
        <p className="text-xs text-muted-foreground">本次Owner模型：{editor.preview.modelId}</p>
        <p>你授权 Owner 在{scope}内按目标规划、组织团队、跟进进度并检查成果。项目总模型费用上限为 {usd(editor.preview.maxCostMicros)}，有效至 {new Date(editor.preview.expiresAt).toLocaleString()}。授权内的计划、派工、执行、独立检查和返工由 Owner 自主决定。</p>
        <p className="text-sm">该总额同时覆盖Owner规划、员工执行和独立检查；系统会持续核算已预留金额与可用余额。确认此授权后，Owner会自动继续，不需要你再批准普通方案或逐项启动员工。</p>
        <details className="rounded-lg bg-muted/30 p-3 text-xs leading-5">
          <summary className="cursor-pointer">查看数据与费用范围</summary>
          <div className="mt-2 space-y-2">
            <p>为完成规划和跟进，Owner会读取{taskId ? '本任务及关联项目' : '本项目'}目标、约束、任务、对话、团队候选及员工进展/完整成果，并据此作质量判断。只有你已授权的资料与源码才会用于模型分析。</p>
            <p>Owner会读取本项目已授权上下文并组织现有员工。员工执行、验收和授权内返工由Owner自主组织；本授权不包含发布或外发。扩大资料范围或作重大业务决定前，Owner会暂停受影响部分并征求你的意见。</p>
            <p>系统在项目总额下按单次费用上界做内部预留；每次管理请求最多预留 {usd(editor.preview.perRequestCeilingMicros)}。预留不是实际账单。额度用尽、余额不足或请求/费用状态不明时会暂停核对，不自动重试；只有确实需要扩大额度或资料范围时才回来询问。</p>
          </div>
        </details>
        <button type="button" className="rounded-xl bg-primary px-4 py-2 text-sm text-primary-foreground" onClick={() => void act({ subject, action: 'confirm' })}>确认范围，让 Owner 自主推进</button>
      </div>}
    </fieldset>}
    {editor.busy && <p role="status" className="text-xs">正在核对授权范围…</p>}
  </section>
}

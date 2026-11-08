import { useState } from 'react'
import type { OwnerExecutionGrant, OwnerExecutionGrantRenewalPreview } from '@gravitas/shared'

const field = 'mt-2 w-full min-w-0 rounded-lg bg-background p-3 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
const button = 'rounded-lg bg-primary px-4 py-2 text-sm text-primary-foreground disabled:opacity-50'
const usd = (micros: number): string => `$${(micros / 1000000).toFixed(2)}`

function toLocalInputValue(ms: number): string {
  const date = new Date(ms)
  date.setMinutes(date.getMinutes() - date.getTimezoneOffset())
  return date.toISOString().slice(0, 16)
}

/** 执行授权到期续期卡：两阶段确认；续期只顺延期限，原任务、命令、费用与运行次数证据保持不变。 */
export function OwnerExecutionGrantRenewalCard({ projectId, taskId, grant, onRenewed }: { projectId: string; taskId?: string; grant: OwnerExecutionGrant; onRenewed: () => void }): React.ReactElement | null {
  const api = typeof window === 'undefined' ? undefined : window.electronAPI?.paa?.project
  const [expiresAtText, setExpiresAtText] = useState(() => toLocalInputValue(Math.min(grant.budget.expiresAt + 24 * 3600_000, Date.now() + 7 * 86400000)))
  const [preview, setPreview] = useState<OwnerExecutionGrantRenewalPreview | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [error, setError] = useState('')
  if (!api || typeof api.previewOwnerExecutionGrantRenewal !== 'function' || typeof api.confirmOwnerExecutionGrantRenewal !== 'function') return null
  const busy = previewing || confirming
  const requestPreview = async () => {
    const expiresAt = new Date(expiresAtText).getTime()
    if (!Number.isFinite(expiresAt)) { setError('请选择有效的续期期限。'); return }
    setPreviewing(true)
    setError('')
    setPreview(null)
    try {
      const result = await api.previewOwnerExecutionGrantRenewal({ projectId, ...(taskId === undefined ? {} : { taskId }), input: { requestId: crypto.randomUUID(), expiresAt } })
      if (!result.ok) { setError(result.error.message); return }
      setPreview(result.value)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '续期预览失败')
    } finally {
      setPreviewing(false)
    }
  }
  const confirmRenewal = async () => {
    if (!preview) return
    setConfirming(true)
    setError('')
    try {
      const result = await api.confirmOwnerExecutionGrantRenewal({ projectId, ...(taskId === undefined ? {} : { taskId }), input: { requestId: crypto.randomUUID(), expiresAt: preview.expiresAt }, preview, confirmedFingerprint: preview.renewalFingerprint })
      if (!result.ok) { setError(result.error.message); setPreview(null); return }
      setPreview(null)
      onRenewed()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '续期确认失败')
      setPreview(null)
    } finally {
      setConfirming(false)
    }
  }
  return <section aria-label="执行授权续期" className="space-y-3 rounded-xl bg-card p-4 text-sm shadow-sm">
    <h4 className="font-medium">续期执行授权</h4>
    <p className="text-xs leading-5 text-muted-foreground">续期只会顺延授权期限，不会重置已累计的费用与运行次数，也不会重复执行已完成的工作；Owner 会按原进度继续。若运行次数或费用额度已耗尽，仅续期不能恢复派发，需要撤权后重新确认执行安排。</p>
    <label className="block text-xs">新的授权期限<input aria-label="新的授权期限" className={field} type="datetime-local" value={expiresAtText} onChange={event => { setExpiresAtText(event.target.value); setPreview(null) }} /></label>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {!preview && <button type="button" className={button} disabled={busy} onClick={() => void requestPreview()}>{previewing ? '正在核对续期条件…' : '核对续期条件'}</button>}
    {preview && <div className="space-y-2 rounded-lg bg-primary/5 p-3">
      <p>授权期限：{new Date(preview.previousExpiresAt).toLocaleString()} → <span className="font-medium">{new Date(preview.expiresAt).toLocaleString()}</span></p>
      <p>费用上限 {usd(preview.budget.maxCostMicros)}、最多 {preview.budget.maxRuns} 次运行、{preview.budget.maxRework} 次返工：保持不变。</p>
      <p className="text-xs text-muted-foreground">已结算费用 {usd(preview.usage.committedCostMicros)}、已计运行 {preview.usage.runReservations} 次：续期后沿用它，不清零。</p>
      <div className="flex flex-wrap gap-2 pt-1">
        <button type="button" className={button} disabled={busy} onClick={() => void confirmRenewal()}>{confirming ? '正在确认续期…' : '确认续期，Owner 继续推进'}</button>
        <button type="button" className="rounded-lg bg-background px-4 py-2 text-sm shadow-sm disabled:opacity-50" disabled={busy} onClick={() => setPreview(null)}>返回修改</button>
      </div>
    </div>}
  </section>
}

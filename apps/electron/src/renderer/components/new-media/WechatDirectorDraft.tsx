import * as React from 'react'
import type { NewMediaConnectedAccount } from '@gravitas/shared'

/** 让用户核对封面并选择公众号；同步只创建平台草稿，不触发发布。 */
export function WechatDirectorDraft({ draftId }: { draftId: string }): React.ReactElement {
  const [preview, setPreview] = React.useState<{ assetId: string; dataUrl: string } | null>(null)
  const [accounts, setAccounts] = React.useState<NewMediaConnectedAccount[]>([])
  const [accountId, setAccountId] = React.useState('')
  const [loading, setLoading] = React.useState(true)
  const [busy, setBusy] = React.useState(false)
  const [notice, setNotice] = React.useState('')
  const [status, setStatus] = React.useState<'uploading' | 'creating' | 'upload_failed' | 'not_created' | 'synced' | null>(null)
  const [checking, setChecking] = React.useState(false)
  const [statusFailed, setStatusFailed] = React.useState(false)
  const [verifiedAbsent, setVerifiedAbsent] = React.useState(false)
  React.useEffect(() => {
    let active = true
    void Promise.all([window.electronAPI.paa.newMedia.content.getDirectorDesignPreview(draftId), window.electronAPI.paa.newMedia.accounts.list()])
      .then(([image, all]) => { if (active) { setPreview(image); setAccounts(all.filter(account => account.platform === 'wechat-official-account' && account.status === 'connected' && account.credentialProtection === 'encrypted')) } })
      .catch(() => { if (active) setNotice('无法读取封面或账号，请刷新后重试。') })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [draftId])
  React.useEffect(() => {
    let active = true
    setStatus(null)
    setStatusFailed(false)
    setVerifiedAbsent(false)
    if (!accountId) return () => { active = false }
    setChecking(true)
    void window.electronAPI.paa.newMedia.content.getWechatSyncStatus({ draftId, accountId })
      .then(value => { if (active) setStatus(value) })
      .catch(() => { if (active) { setStatusFailed(true); setNotice('同步状态读取失败，请刷新后重试。') } })
      .finally(() => { if (active) setChecking(false) })
    return () => { active = false }
  }, [accountId, draftId])
  const confirmAbsent = async (): Promise<void> => {
    if (!verifiedAbsent || !accountId) return
    setBusy(true)
    try {
      await window.electronAPI.paa.newMedia.content.confirmWechatNotCreated({ draftId, accountId, confirmed: true })
      setStatus('not_created')
      setVerifiedAbsent(false)
      setNotice('已记录核对结果，可以重新同步。')
    } catch { setNotice('未能记录核对结果，请刷新后重试。') }
    finally { setBusy(false) }
  }
  const sync = async (): Promise<void> => {
    if (!preview || !accountId) return
    setBusy(true)
    setNotice('')
    try {
      const record = await window.electronAPI.paa.newMedia.content.syncWechatDraft({ draftId, accountId, assetId: preview.assetId })
      setStatus(record.status === 'synced' && record.platformMediaId ? 'synced' : 'creating')
      setNotice(record.status === 'synced' && record.platformMediaId ? '已同步到公众号草稿箱，尚未发布。请在公众号后台检查后确认发布。' : '同步结果未确认，请前往公众号草稿箱核对。')
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '同步结果未确认，请先到公众号草稿箱核对。')
      try { setStatus(await window.electronAPI.paa.newMedia.content.getWechatSyncStatus({ draftId, accountId })) } catch { setStatusFailed(true) }
    }
    finally { setBusy(false) }
  }
  return <div className="mt-3 space-y-2">
    {preview && <img src={preview.dataUrl} alt="待审核的公众号封面" className="max-h-56 rounded-lg object-contain" />}
    {!loading && !preview && <p className="text-xs text-amber-700 dark:text-amber-300">尚无封面，请先让总监制作并保存封面。</p>}
    <label className="block text-xs">选择公众号账号 <select disabled={busy} value={accountId} onChange={event => setAccountId(event.target.value)} className="ml-2 rounded bg-muted px-2 py-1"><option value="">请选择</option>{accounts.map(account => <option key={account.id} value={account.id}>{account.displayName}</option>)}</select></label>
    {!loading && accounts.length === 0 && <p className="text-xs text-foreground/60">请先在「账号」中安全连接公众号。</p>}
    {status === 'creating' && <div className="rounded-lg bg-amber-500/10 p-2 text-xs text-amber-700 dark:text-amber-300">
      <p>上次草稿提交结果不明。请先在公众号草稿箱检查，避免重复创建。</p>
      <label><input type="checkbox" checked={verifiedAbsent} onChange={event => setVerifiedAbsent(event.target.checked)} /> 我已核对，确认没有创建该草稿</label>
      <button disabled={!verifiedAbsent || busy} onClick={() => void confirmAbsent()} className="ml-2 text-primary disabled:opacity-50">记录核对并允许重试</button>
    </div>}
    {status === 'synced' && <p className="text-xs text-foreground/65">已同步到公众号草稿箱，尚未发布。</p>}
    <button disabled={loading || checking || statusFailed || busy || status === 'creating' || status === 'synced' || !preview || !accountId} onClick={() => void sync()} className="text-xs text-primary hover:underline disabled:opacity-50">{busy ? '正在同步…' : '核对后同步到公众号草稿箱'}</button>
    {notice && <p role="status" className="text-xs text-foreground/65">{notice}</p>}
  </div>
}

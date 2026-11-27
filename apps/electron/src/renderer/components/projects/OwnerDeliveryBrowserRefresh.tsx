import { useState } from 'react'
import type { OwnerDeliveryValidationRecord, ProjectOwnerGoalSubject } from '@gravitas/shared'

export function OwnerDeliveryBrowserRefresh({ subject, record, onChanged }: {
  subject: ProjectOwnerGoalSubject
  record?: OwnerDeliveryValidationRecord
  onChanged: () => Promise<unknown>
}): React.ReactElement | null {
  const [busy, setBusy] = useState(false)
  const [detail, setDetail] = useState('')
  const offer = record?.browserRefresh
  const refresh = window.electronAPI?.paa?.project?.refreshOwnerDeliveryBrowser
  if (!record || (!offer && !record.browserRefreshBlocked && !detail)) return null
  return <div className="space-y-1">
    {offer && refresh && <button type="button" disabled={busy} className="text-primary underline disabled:opacity-50" onClick={() => {
      setBusy(true)
      setDetail('')
      void refresh({ ...subject, messageId: record.messageId, stepKey: record.stepKey,
        artifactHash: record.artifactHash, ...offer }).then(result => {
        if (!result.ok) setDetail(result.error.message)
        else if (result.value.status === 'passed') setDetail('浏览器补验通过，可以继续审阅这一版。')
      }).catch(() => setDetail('补验结果未能读取，请查看当前成果记录。'))
        .finally(async () => { try { await onChanged() } finally { setBusy(false) } })
    }}>{busy ? '正在检查原成果…' : offer.failedValidationId ? '确认重试浏览器检查' : '重新验证原成果'}</button>}
    {(detail || record.browserRefreshBlocked) && <p role="status">{detail || record.browserRefreshBlocked}</p>}
  </div>
}

import { useState } from 'react'
import type { ProjectOwnerGoalSubject } from '@gravitas/shared'
import type { OwnerExecutionAttention } from './project-owner-execution-attention'

/** 执行阻塞的统一提示；对话区与执行区共用同一份文案与入口，避免两处状态不一致。 */
export function OwnerExecutionBlockerNotice({ attention, subject, onOpenEvidence, onWorkspaceCleared }: {
  attention: OwnerExecutionAttention
  subject: ProjectOwnerGoalSubject
  onOpenEvidence?: () => void
  onWorkspaceCleared: () => void
}): React.ReactElement {
  const [checking, setChecking] = useState(false)
  const [checkMessage, setCheckMessage] = useState('')
  const recheckWorkspace = async () => {
    const executionId = attention.recheckExecutionId
    if (!executionId) return
    setChecking(true)
    try {
      const result = await window.electronAPI.paa.project.recheckOwnerDevelopmentWorkspace({ ...subject, executionId })
      if (!result.ok) { setCheckMessage(result.error.message); return }
      if (result.value.state === 'blocked') {
        const { detail, remedy } = result.value.blocker
        setCheckMessage(`${detail}。${remedy}`)
        return
      }
      setCheckMessage('工作区已通过核对。')
      onWorkspaceCleared()
    } catch {
      setCheckMessage('这次未能核对工作区，请重试。')
    } finally {
      setChecking(false)
    }
  }
  return <section role="alert" aria-label="执行阻塞" className="space-y-2 rounded-xl bg-amber-500/10 p-3 text-sm">
    <p className="font-medium">{attention.title}</p>
    <p className="leading-6">{attention.detail}</p>
    <ul className="list-disc pl-5 text-xs text-muted-foreground">{attention.actions.map(action => <li key={action}>{action}</li>)}</ul>
    <div className="flex flex-wrap gap-3">
      {onOpenEvidence && <button type="button" className="text-primary underline" onClick={onOpenEvidence}>查看失败证据与工作区</button>}
      {attention.recheckExecutionId && <button type="button" className="text-primary underline disabled:opacity-50" disabled={checking} onClick={() => void recheckWorkspace()}>
        {checking ? '正在核对工作区…' : '重新核对工作区'}
      </button>}
    </div>
    {checkMessage && <p role="status" className="leading-6">{checkMessage}</p>}
  </section>
}

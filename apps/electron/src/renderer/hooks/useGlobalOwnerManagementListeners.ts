import { useEffect } from 'react'
import { useStore } from 'jotai'
import { toast } from 'sonner'
import { activeViewAtom } from '../atoms/active-view'
import { notificationsEnabledAtom, sendDesktopNotification } from '../atoms/notifications'
import { getOwnerManagementEditor, loadOwnerManagementAtom, ownerConversationNavigationAtom, ownerConversationNoticesAtom, ownerManagementEditorsAtom } from '../atoms/project-owner-management-atoms'
import type { OwnerManagementMessage } from '@gravitas/shared'

const ownerNotices: Partial<Record<OwnerManagementMessage['kind'], { title: string; description: string }>> = {
  attention: { title: '项目 Owner 发现需要留意的事项', description: 'Owner 已保留原因和下一步建议，请在项目对话中查看。' },
  clarification: { title: '项目 Owner 有问题需要你确认', description: '问题和建议已保存在项目对话中。' },
  configuration_required: { title: '项目 Owner 需要确认必要设置', description: '打开项目对话查看需要补充的设置。' },
  execution_arranged: { title: '项目方案已准备好', description: '请在项目对话中确认执行范围和必要边界。' },
  plan_proposal: { title: '项目方案待你审阅', description: 'Owner 已整理方案，请在项目对话中查看并确认或修改。' },
  planning_confirmation: { title: '项目 Owner 等待必要确认', description: '打开项目对话查看本次需要确认的内容。' },
  reply: { title: '项目 Owner 更新了处理结果', description: '打开项目对话查看判断依据和后续安排。' },
  delivery: { title: '项目成果已交付', description: 'Owner 已完成约定的质量检查，成果已保存在项目对话中。' },
}

function ownerNotice(message: OwnerManagementMessage): { title: string; description: string } | undefined {
  const notice = ownerNotices[message.kind]
  if (notice || message.kind !== 'management_progress') return notice
  if (!/已按你确认的结果与边界开始组织执行|上次启动核对已经完成|员工.{0,40}(?:已完成|失败|停滞|被阻塞)|阶段成果已准备好/.test(message.content)) return undefined
  return { title: '项目进度有更新', description: message.content.slice(0, 140) }
}

/** 项目页关闭时仍接收Owner的实质进展和待决定消息；内部观察事件不打断用户。 */
export function useGlobalOwnerManagementListeners(): void {
  const store = useStore()
  useEffect(() => {
    const api = window.electronAPI?.paa?.project
    if (!api?.onOwnerManagementChanged) return
    let stopped = false
    const seen = new Set<string>()
    const notify = (projectId: string, key: string, title: string, description: string, taskId?: string): void => {
      if (seen.has(key)) return
      seen.add(key)
      if (seen.size > 200) seen.delete(seen.values().next().value!)
      const navigate = () => {
        store.set(ownerConversationNavigationAtom, { projectId, ...(taskId ? { taskId } : {}), at: Date.now() })
        store.set(activeViewAtom, 'projects')
      }
      // 即使系统通知被关闭，应用内提示和入口记录也必须在，用户才能顺着红点回到对话。
      store.set(ownerConversationNoticesAtom, previous => { const next = new Map(previous); next.set(projectId, { messageId: key, title, createdAt: Date.now(), ...(taskId ? { taskId } : {}) }); return next })
      toast(title, { description, action: { label: '打开对话', onClick: navigate }, duration: 10000 })
      if (store.get(notificationsEnabledAtom)) sendDesktopNotification(title, description, true, { onNavigate: navigate })
    }
    const receive = async (projectId: string, messageId?: string, taskId?: string): Promise<void> => {
      await store.set(loadOwnerManagementAtom, projectId)
      if (stopped) return
      const view = getOwnerManagementEditor(store.get(ownerManagementEditorsAtom), projectId).view
      // 恢复最近可见更新的入口，但不把历史进展重新发成系统通知。
      const latestNotice = view?.messages.filter(item => item.role === 'assistant' && ownerNotice(item)).at(-1)
      if (latestNotice) {
        store.set(ownerConversationNoticesAtom, previous => {
          const current = previous.get(projectId)
          if (current?.messageId === latestNotice.id || (current && current.createdAt > latestNotice.createdAt)) return previous
          const next = new Map(previous)
          next.set(projectId, { messageId: latestNotice.id, title: ownerNotice(latestNotice)!.title, createdAt: latestNotice.createdAt, ...(latestNotice.taskId ? { taskId: latestNotice.taskId } : {}) })
          return next
        })
      }
      // 找不到准确消息时不再静默丢弃：至少把用户带回该项目对话，否则红点亮着却无处可去。
      const message = messageId ? view?.messages.find(item => item.id === messageId && item.role === 'assistant') : undefined
      if (messageId && !message) { notify(projectId, `unresolved:${messageId}`, '项目 Owner 有新的进展', '点击回到项目对话查看最新内容和下一步。', taskId); return }
      if (message?.kind === 'execution_observation') return
      const notice = message ? ownerNotice(message) : undefined
      if (messageId && !message?.questionId && !notice) return
      for (const question of view?.questions ?? []) {
        if (question.state !== 'open' || (message && question.id !== message.questionId)) continue
        notify(projectId, question.id, '项目 Owner 有问题需要你确认', '问题和建议已保存在项目对话中。', question.taskId)
      }
      if (message && notice && !message.questionId && !seen.has(message.id)) {
        notify(projectId, message.id, notice.title, notice.description, message.taskId)
      }
    }
    const report = (cause: unknown) => console.warn('[Owner对话] 读取主动消息失败', cause)
    const off = api.onOwnerManagementChanged(change => {
      if (change?.projectId) void receive(change.projectId, change.messageId).catch(report)
    })
    // 恢复启动前已落库的问题，弥补窗口尚未创建时错过的主进程推送。
    if (api.listProjects) void api.listProjects().then(async projects => {
      for (const project of projects) {
        if (stopped) break
        if (project && typeof project === 'object' && 'id' in project && typeof project.id === 'string') await receive(project.id).catch(report)
      }
    }).catch(report)
    return () => { stopped = true; off() }
  }, [store])
}

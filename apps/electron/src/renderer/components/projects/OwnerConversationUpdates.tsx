import { useAtomValue } from 'jotai'
import { ownerConversationNoticesAtom } from '../../atoms/project-owner-management-atoms'

/** 持久对话的最近更新入口；不是未读数，也不展示成果正文。 */
export function OwnerConversationUpdates({ projects, onOpen }: {
  projects: ReadonlyArray<{ id: string; title: string }>
  onOpen: (projectId: string, taskId?: string) => void
}): React.ReactElement | null {
  const notices = useAtomValue(ownerConversationNoticesAtom)
  const updates = projects.flatMap(project => {
    const notice = notices.get(project.id)
    return notice ? [{ project, notice }] : []
  }).sort((a, b) => b.notice.createdAt - a.notice.createdAt)
  if (!updates.length) return null
  return <section aria-label="Owner 对话更新" className="mb-6 space-y-2">
    <h2 className="text-sm font-medium">Owner 对话更新</h2>
    {updates.map(({ project, notice }) => <button key={project.id} type="button"
      onClick={() => onOpen(project.id, notice.taskId)}
      className="flex w-full items-center gap-3 rounded-xl bg-muted/50 px-4 py-3 text-left shadow-sm transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
      <span className="h-2 w-2 shrink-0 rounded-full bg-primary" aria-hidden="true" />
      <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{project.title}</span><span className="block text-xs text-muted-foreground">{notice.title}</span></span>
      <span className="shrink-0 text-xs text-primary">打开对话</span>
    </button>)}
  </section>
}

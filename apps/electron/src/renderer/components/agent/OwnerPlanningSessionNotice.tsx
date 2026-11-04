import { useSetAtom } from 'jotai'
import { activeViewAtom } from '@/atoms/active-view'
import { ownerConversationNavigationAtom } from '@/atoms/project-owner-management-atoms'
import { Button } from '@/components/ui/button'

export function OwnerPlanningSessionNotice({ projectId }: { projectId: string }): React.ReactElement {
  const navigateToOwner = useSetAtom(ownerConversationNavigationAtom)
  const setActiveView = useSetAtom(activeViewAtom)
  return (
    <section className="m-4 space-y-3 rounded-xl bg-muted/40 p-5" aria-label="Owner 项目记录">
      <h2 className="font-semibold">在项目对话中查看 Owner 回复</h2>
      <p className="text-sm text-muted-foreground">这条记录用于后台处理。Owner 的回复、团队安排和当前状态都在项目对话中。</p>
      <Button onClick={() => {
        navigateToOwner({ projectId, at: Date.now() })
        setActiveView('projects')
      }}>打开 Owner 项目对话</Button>
    </section>
  )
}

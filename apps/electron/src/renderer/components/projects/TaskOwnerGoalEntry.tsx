import { useEffect } from 'react'
import { useAtom } from 'jotai'
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger,
} from '@/components/ui/dialog'
import { taskOwnerGoalSubjectAtom } from '../../atoms/task-owner-goal-entry-atoms'
import { ProjectOwnerGoalPanel } from './ProjectOwnerGoalPanel'

interface TaskOwnerGoalEntryProps {
  projectId: string
  taskId: string
  taskTitle: string
}

/** 所有真实任务都可记录目标；只有打开弹窗时才挂载并加载目标面板。 */
export function TaskOwnerGoalEntry({ projectId, taskId, taskTitle }: TaskOwnerGoalEntryProps): React.ReactElement {
  const [subject, setSubject] = useAtom(taskOwnerGoalSubjectAtom)
  const open = subject?.projectId === projectId && subject.taskId === taskId
  useEffect(() => () => {
    setSubject((current) => current?.projectId === projectId && current.taskId === taskId ? null : current)
  }, [projectId, taskId, setSubject])
  return (
    <Dialog open={open} onOpenChange={(nextOpen) => {
      if (nextOpen) setSubject({ projectId, taskId })
      else setSubject((current) => current?.projectId === projectId && current.taskId === taskId ? null : current)
    }}>
      <DialogTrigger asChild>
        <button type="button" className="shrink-0 rounded-md bg-muted px-2 py-1 text-xs hover:bg-muted/70 transition-colors"
          title="保存任务目标草案，不修改任务或启动执行">目标草案</button>
      </DialogTrigger>
      {open && <DialogContent className="flex min-w-0 w-[calc(100vw-2rem)] max-w-3xl max-h-[calc(100dvh-2rem)] flex-col overflow-hidden p-4 sm:p-6">
        <DialogHeader className="min-w-0 shrink-0 pr-6">
          <DialogTitle>任务目标草案</DialogTitle>
          <p className="min-w-0 line-clamp-2 text-sm font-medium [overflow-wrap:anywhere]" title={taskTitle}>{taskTitle}</p>
          <DialogDescription>只保存目标，不修改任务、调用模型、产生模型费用或派发执行。</DialogDescription>
        </DialogHeader>
        <div className="min-h-0 min-w-0 overflow-y-auto overscroll-contain [overflow-wrap:anywhere]">
          <ProjectOwnerGoalPanel key={JSON.stringify([projectId, taskId])} projectId={projectId} taskId={taskId} />
        </div>
      </DialogContent>}
    </Dialog>
  )
}

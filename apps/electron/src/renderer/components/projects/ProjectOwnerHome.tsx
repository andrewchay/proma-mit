import { ProjectOwnerConversation } from './ProjectOwnerConversation'

/** 项目管理模式的默认页面只呈现与独立 Owner 的持续对话。 */
export function ProjectOwnerHome({ projectId, taskId }: { projectId: string; taskId?: string }): React.ReactElement {
  return <section className="mx-auto w-full max-w-7xl" aria-label="Owner 项目对话" data-project-id={projectId}>
    <ProjectOwnerConversation projectId={projectId} taskId={taskId} />
  </section>
}

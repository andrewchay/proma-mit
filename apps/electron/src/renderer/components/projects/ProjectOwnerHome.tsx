import { ProjectOwnerConversation } from './ProjectOwnerConversation'

/** 项目管理模式的默认页面只呈现与独立 Owner 的持续对话。 */
export function ProjectOwnerHome({ projectId, taskId, showProjectDetails, projectDetailsKind, onProjectDetailsHost, onShowOwner }: { projectId: string; taskId?: string; showProjectDetails?: boolean; projectDetailsKind?: 'tasks' | 'chain' | 'knowledge' | 'pilot'; onProjectDetailsHost?: React.RefCallback<HTMLDivElement>; onShowOwner?: () => void }): React.ReactElement {
  return <section className="mx-auto w-full max-w-7xl" aria-label="Owner 项目对话" data-project-id={projectId}>
    <ProjectOwnerConversation projectId={projectId} taskId={taskId} showProjectDetails={showProjectDetails} projectDetailsKind={projectDetailsKind} onProjectDetailsHost={onProjectDetailsHost} onShowOwner={onShowOwner} />
  </section>
}

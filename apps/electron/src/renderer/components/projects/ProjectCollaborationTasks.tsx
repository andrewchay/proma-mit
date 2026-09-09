import { TaskExecutionEvidence } from './TaskExecutionEvidence'

export interface CollaborationTask {
  id: string
  title: string
  status: string
  assignee?: { userId: string; displayName: string }
}
export interface CollaborationDependency {
  id: string
  taskId: string
  dependsOnTaskId: string
  type: string
}
export interface CollaborationBlocker {
  taskId: string
  dependsOnTaskId: string
  reason: string
}
interface Props {
  tasks: CollaborationTask[]
  dependencies: CollaborationDependency[]
  blockers: CollaborationBlocker[]
}
const taskLabels: Record<string, string> = {
  draft: '待确认',
  pending: '待开始',
  in_progress: '进行中',
  paused: '已暂停',
  completed: '任务已完成',
}
const dependencyLabels: Record<string, string> = {
  finish_to_start: '完成后开始',
  start_to_start: '开始后开始',
  finish_to_finish: '完成后完成',
  start_to_finish: '开始后完成',
}

/** 复用项目权威依赖与阻塞记录；关系不从名称、会话标题或文本推断。 */
export function ProjectCollaborationTasks({ tasks, dependencies, blockers }: Props): React.ReactElement {
  const blockedIds = new Set(blockers.map((blocker) => blocker.taskId))
  return (
    <section className="rounded-xl bg-card p-5 shadow-sm">
      <h3 className="font-medium">协作任务与责任</h3>
      <p className="mt-1 text-sm text-muted-foreground">
        {tasks.length} 个任务 · {blockedIds.size} 个阻塞 · {tasks.filter((task) => !task.assignee).length}{' '}
        个未指定负责人。任务完成状态与交付验收分别记录。
      </p>
      {!tasks.length && (
        <p className="mt-3 text-sm text-muted-foreground">请先在任务页创建任务并指定负责人。</p>
      )}
      <div className="mt-3 space-y-2">
        {tasks.map((task) => {
          const upstream = dependencies.filter((dependency) => dependency.taskId === task.id)
          const downstream = dependencies.filter((dependency) => dependency.dependsOnTaskId === task.id)
          const taskBlockers = blockers.filter((blocker) => blocker.taskId === task.id)
          return (
            <details
              key={task.id}
              className={`rounded-lg p-3 ${taskBlockers.length ? 'bg-amber-500/10' : 'bg-muted/40'}`}
            >
              <summary className="text-sm">
                {task.title} · {task.assignee?.displayName ?? '未指定负责人'} ·{' '}
                {taskLabels[task.status] ?? task.status}
                {taskBlockers.length ? ' · 被阻塞' : ''}
              </summary>
              <div className="mt-2 space-y-2 text-sm">
                <p>
                  前置依赖：
                  {upstream.length
                    ? upstream
                        .map(
                          (dependency) =>
                            `${tasks.find((item) => item.id === dependency.dependsOnTaskId)?.title ?? '任务缺失'}（${dependencyLabels[dependency.type] ?? dependency.type}）`,
                        )
                        .join('、')
                    : '无'}
                </p>
                <p>
                  影响下游：
                  {downstream.length
                    ? downstream
                        .map(
                          (dependency) =>
                            tasks.find((item) => item.id === dependency.taskId)?.title ?? '任务缺失',
                        )
                        .join('、')
                    : '无'}
                </p>
                {taskBlockers.map((blocker, index) => (
                  <p
                    key={`${blocker.dependsOnTaskId}-${index}`}
                    className="text-amber-700 dark:text-amber-400"
                  >
                    阻塞原因：{blocker.reason}
                  </p>
                ))}
                <TaskExecutionEvidence key={task.id} taskId={task.id} />
              </div>
            </details>
          )
        })}
      </div>
    </section>
  )
}

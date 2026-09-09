import type { ProjectChain } from '@gravitas/shared'
import type { CollaborationTask } from './ProjectCollaborationTasks'

interface Props {
  chain: ProjectChain
  tasks: CollaborationTask[]
}

const arrow = (
  <span aria-hidden="true" className="text-muted-foreground">
    →
  </span>
)
const nodeClass = 'min-w-36 rounded-lg bg-muted/50 px-3 py-2 shadow-sm'

/** 只展示显式 ID 关系；不从标题或正文推断决策与协作链路。 */
export function ProjectChainOverview({ chain, tasks }: Props): React.ReactElement {
  return (
    <section className="rounded-xl bg-card p-5 shadow-sm">
      <h3 className="font-medium">双链总览</h3>
      <p className="mt-1 text-sm text-muted-foreground">
        所有连线来自已保存的任务、决策版本、Run 和交接 ID。
      </p>
      <div className="mt-4 space-y-4 text-sm">
        <div>
          <h4 className="font-medium">决策链</h4>
          <div className="mt-2 space-y-2 overflow-x-auto">
            {chain.decisions.map((decision) => {
              const affected = decision.impactTaskIds.map(
                (id) => tasks.find((task) => task.id === id)?.title ?? id,
              )
              const deliverables = chain.drafts.filter((draft) =>
                draft.decisions.some((ref) => ref.id === decision.id),
              )
              return (
                <div key={decision.id} className="flex min-w-max items-stretch gap-2">
                  <div className={nodeClass}>
                    问题／候选
                    <br />
                    {decision.title} · v{decision.version}
                  </div>
                  {arrow}
                  <div className={nodeClass}>
                    证据与假设
                    <br />
                    {decision.sourceRefs.length} 个来源 · {decision.assumptions.length} 项假设
                  </div>
                  {arrow}
                  <div className={nodeClass}>
                    决策／审批
                    <br />
                    {decision.status === 'candidate'
                      ? `待 ${decision.daci?.approverId ?? '拍板人'}`
                      : decision.status === 'decided'
                        ? '已决定'
                        : '已替代'}
                  </div>
                  {arrow}
                  <div className={nodeClass}>
                    影响范围
                    <br />
                    {affected.join('、') || '未关联任务'}
                  </div>
                  {arrow}
                  <div className={nodeClass}>
                    执行与验证
                    <br />
                    {deliverables.length
                      ? deliverables.map((item) => `${item.title}：${item.status}`).join('；')
                      : '尚无交付'}
                  </div>
                  {decision.supersedes && (
                    <>
                      {arrow}
                      <div className={nodeClass}>
                        替代
                        <br />
                        {decision.supersedes.id} v{decision.supersedes.version}
                      </div>
                    </>
                  )}
                </div>
              )
            })}
            {!chain.decisions.length && <p className="text-muted-foreground">尚无决策。</p>}
          </div>
        </div>
        <div>
          <h4 className="font-medium">协作链</h4>
          <div className="mt-2 space-y-2 overflow-x-auto">
            {chain.drafts.map((draft) => {
              const task = tasks.find((item) => item.id === draft.taskId)
              return (
                <div key={draft.id} className="flex min-w-max items-stretch gap-2">
                  <div className={nodeClass}>项目</div>
                  {arrow}
                  <div className={nodeClass}>
                    Task
                    <br />
                    {task?.title ?? draft.taskId}
                  </div>
                  {arrow}
                  <div className={nodeClass}>
                    执行责任
                    <br />
                    {draft.responsibilities?.ownerId ?? '待补齐'}
                  </div>
                  {arrow}
                  <div className={nodeClass}>
                    Session／Run
                    <br />
                    {draft.execution
                      ? `${draft.execution.agentId} · ${draft.execution.sessionId} · ${draft.execution.id}`
                      : '人工执行或未关联 Run'}
                  </div>
                  {arrow}
                  <div className={nodeClass}>
                    交付物
                    <br />
                    {draft.title} · v{draft.version}
                  </div>
                  {arrow}
                  <div className={nodeClass}>
                    验收／交接
                    <br />
                    {draft.status}
                  </div>
                </div>
              )
            })}
            {!chain.drafts.length && <p className="text-muted-foreground">尚无交付物。</p>}
          </div>
        </div>
      </div>
    </section>
  )
}

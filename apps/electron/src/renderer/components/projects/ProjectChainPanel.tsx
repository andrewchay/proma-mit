import { useEffect, useMemo } from 'react'
import { atom, useAtom } from 'jotai'
import type { ProjectChain, ProjectChainCommand, ProjectDeliverable } from '@gravitas/shared'
import { TaskExecutionEvidence } from './TaskExecutionEvidence'
import { ProjectCollaborationTasks } from './ProjectCollaborationTasks'
import type {
  CollaborationTask,
  CollaborationDependency,
  CollaborationBlocker,
} from './ProjectCollaborationTasks'

interface ChainPanelState {
  chain?: ProjectChain
  busy: boolean
  error: string
  decisionId?: string
  draftId?: string
  decisionFormVersion?: number
  draftFormVersion?: number
}
interface Props {
  projectId: string
  tasks: CollaborationTask[]
  dependencies: CollaborationDependency[]
  blockers: CollaborationBlocker[]
  refreshTasks: () => Promise<void>
}
const statusLabels: Record<ProjectDeliverable['status'], string> = {
  draft: '准备中',
  submitted: '待验收',
  accepted: '待交接',
  handoff_pending: '待接收确认',
  handed_off: '已确认接收',
  needs_review: '决策变更 · 待复核',
  changes_requested: '需修改',
}
const actionLabels: Record<ProjectChainCommand['kind'], string> = {
  decision: '确认决策',
  approve_decision: 'DACI 拍板确认',
  set_project_dod: '更新项目 DoD',
  set_task_dod: '更新任务 DoD',
  define_dependency_handoff: '定义依赖交接',
  offer_dependency_handoff: '发起依赖交接',
  accept_dependency_handoff: '接收依赖交接',
  return_dependency_handoff: '退回依赖交接',
  draft: '保存交付物版本',
  submit: '提交验收',
  accept: '验收通过',
  reject: '退回修改',
  request_handoff: '发起交接',
  handoff: '确认接收',
  reject_handoff: '退回交接',
}
const fieldClass = 'w-full rounded-md bg-background px-3 py-2 text-sm shadow-sm ring-1 ring-border'
const buttonClass = 'rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-50'
const text = (data: FormData, key: string): string => String(data.get(key) ?? '')
const lines = (value: string): string[] =>
  value
    .split('\n')
    .map((item) => item.trim())
    .filter(Boolean)

export function ProjectChainPanel({
  projectId,
  tasks,
  dependencies,
  blockers,
  refreshTasks,
}: Props): React.ReactElement {
  const stateAtom = useMemo(() => atom<ChainPanelState>({ busy: false, error: '' }), [])
  const [state, setState] = useAtom(stateAtom)
  const { chain, busy } = state
  const api = window.electronAPI.paa.project
  useEffect(() => {
    let active = true
    api
      .getChain(projectId)
      .then((value) => {
        if (active) setState((current) => ({ ...current, chain: value }))
      })
      .catch((error: unknown) => {
        if (active) setState((current) => ({ ...current, error: String(error) }))
      })
    return () => {
      active = false
    }
  }, [projectId, api, setState])

  async function refresh(): Promise<void> {
    try {
      const [value] = await Promise.all([api.getChain(projectId), refreshTasks()])
      setState((current) => ({ ...current, chain: value, error: '' }))
    } catch (error) {
      setState((current) => ({ ...current, error: String(error) }))
    }
  }
  async function execute(command: ProjectChainCommand): Promise<void> {
    if (!chain || busy) return
    setState((current) => ({ ...current, busy: true, error: '' }))
    try {
      const value = await api.updateChain(projectId, chain.revision, command)
      setState((current) => ({
        ...current,
        chain: value,
        busy: false,
        error: '',
        ...(command.kind === 'decision'
          ? { decisionId: undefined, decisionFormVersion: (current.decisionFormVersion ?? 0) + 1 }
          : {}),
        ...(command.kind === 'draft'
          ? { draftId: undefined, draftFormVersion: (current.draftFormVersion ?? 0) + 1 }
          : {}),
      }))
    } catch (error) {
      setState((current) => ({ ...current, busy: false, error: String(error) }))
    }
  }
  const decision = chain?.decisions.find((item) => item.id === state.decisionId)
  const draft = chain?.drafts.find((item) => item.id === state.draftId)
  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">决策与协作链路</h2>
          <p className="text-sm text-muted-foreground">
            决策依据 → 任务与责任 → 执行与交付 → 验收 → 协作交接
          </p>
        </div>
        <button className={buttonClass} disabled={busy} onClick={() => void refresh()}>
          刷新
        </button>
      </div>
      {state.error && (
        <p role="alert" className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
          {state.error}
        </p>
      )}
      {!chain ? (
        <p>正在加载链路…</p>
      ) : (
        <>
          <div className="grid grid-cols-3 gap-3">
            {(['needs_review', 'submitted', 'accepted'] as const).map((status) => (
              <a key={status} href="#project-chain-drafts" className="rounded-xl bg-primary/10 p-4 shadow-sm">
                <div className="text-2xl font-semibold">
                  {chain.drafts.filter((item) => item.status === status).length}
                </div>
                <div className="text-sm">{statusLabels[status]}</div>
              </a>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">
            当前操作人：local-user。负责人取自任务；验收人和接收人须填写身份目录中已启用的用户 ID。
            本机不能代其他身份确认，不会发送交接消息。验收与接收是独立步骤；退回或变更后必须保存新版本重新验收。
          </p>
          <section className="rounded-xl bg-card p-5 shadow-sm">
            <h3 className="font-medium">Definition of Done（完成门禁）</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              项目 DoD 会冻结到后续交付版本；任务标记完成前必须有逐项验收通过的交付物。
            </p>
            <form
              className="mt-3 grid gap-2 md:grid-cols-2"
              onSubmit={(event) => {
                event.preventDefault()
                const data = new FormData(event.currentTarget)
                void execute({ kind: 'set_project_dod', criteria: lines(text(data, 'projectDoD')) })
              }}
            >
              <textarea
                aria-label="项目 DoD"
                name="projectDoD"
                defaultValue={chain.projectDefinitionOfDone.join('\n')}
                placeholder="项目通用 DoD，每行一项"
                className={fieldClass}
              />
              <button disabled={busy} className={buttonClass}>
                保存项目 DoD
              </button>
            </form>
            <form
              className="mt-3 grid gap-2 md:grid-cols-3"
              onSubmit={(event) => {
                event.preventDefault()
                const data = new FormData(event.currentTarget)
                void execute({
                  kind: 'set_task_dod',
                  taskId: text(data, 'taskId'),
                  criteria: lines(text(data, 'taskDoD')),
                })
              }}
            >
              <select aria-label="任务 DoD 关联任务" name="taskId" required className={fieldClass}>
                <option value="">选择任务</option>
                {tasks.map((task) => (
                  <option key={task.id} value={task.id}>
                    {task.title}
                  </option>
                ))}
              </select>
              <textarea
                aria-label="任务 DoD"
                name="taskDoD"
                placeholder="任务特定 DoD，每行一项"
                className={fieldClass}
              />
              <button disabled={busy} className={buttonClass}>
                保存任务 DoD
              </button>
            </form>
          </section>
          <div className="grid gap-5 xl:grid-cols-2">
            <div className="xl:col-span-2">
              <ProjectCollaborationTasks tasks={tasks} dependencies={dependencies} blockers={blockers} />
            </div>
            <section className="rounded-xl bg-card p-5 shadow-sm">
              <h3 className="mb-3 font-medium">
                {decision ? `更新决策 · v${decision.version + 1}` : '记录决策（关键决策使用 DACI）'}
              </h3>
              <form
                key={`decision-${state.decisionId}-${state.decisionFormVersion ?? 0}`}
                className="space-y-3"
                onSubmit={(event) => {
                  event.preventDefault()
                  const data = new FormData(event.currentTarget)
                  const keyDecision = data.get('keyDecision') === 'on'
                  const deadlineAt = new Date(text(data, 'deadlineAt')).getTime()
                  void execute({
                    kind: 'decision',
                    decisionId: decision?.id,
                    title: text(data, 'title'),
                    rationale: text(data, 'rationale'),
                    evidence: text(data, 'evidence'),
                    changeReason: text(data, 'changeReason'),
                    ...(keyDecision
                      ? {
                          daci: {
                            driverId: text(data, 'driverId'),
                            approverId: text(data, 'approverId'),
                            contributorIds: lines(text(data, 'contributorIds')),
                            informedIds: lines(text(data, 'informedIds')),
                          },
                          deadlineAt,
                          impactTaskIds: data.getAll('impactTaskIds').map(String),
                          alternatives: lines(text(data, 'alternatives')).map((item, index) => {
                            const [title = '', tradeoffs = ''] = item.split('|')
                            return {
                              id: `option-${index + 1}`,
                              title: title.trim(),
                              tradeoffs: tradeoffs.trim(),
                            }
                          }),
                        }
                      : {}),
                  })
                }}
              >
                <input
                  aria-label="决策标题"
                  name="title"
                  required
                  defaultValue={decision?.title}
                  placeholder="决策标题"
                  className={fieldClass}
                />
                <textarea
                  aria-label="决定与理由"
                  name="rationale"
                  required
                  defaultValue={decision?.rationale}
                  placeholder="决定、理由与取舍"
                  className={fieldClass}
                />
                {!decision && (
                  <label className="block text-sm">
                    <input type="checkbox" name="keyDecision" /> 关键决策：启用 DACI 拍板
                  </label>
                )}
                {!decision && (
                  <div className="grid gap-2 md:grid-cols-2">
                    <input
                      aria-label="DACI 推进人"
                      name="driverId"
                      defaultValue="local-user"
                      placeholder="推进人 ID"
                      className={fieldClass}
                    />
                    <input
                      aria-label="DACI 拍板人"
                      name="approverId"
                      defaultValue="local-user"
                      placeholder="拍板人 ID"
                      className={fieldClass}
                    />
                    <input
                      aria-label="最迟决定时间"
                      type="datetime-local"
                      name="deadlineAt"
                      className={fieldClass}
                    />
                    <textarea
                      aria-label="候选方案"
                      name="alternatives"
                      placeholder="候选方案，每行：方案 | 取舍"
                      className={fieldClass}
                    />
                    <textarea
                      aria-label="DACI 贡献者"
                      name="contributorIds"
                      placeholder="贡献者 ID，每行一个"
                      className={fieldClass}
                    />
                    <textarea
                      aria-label="DACI 知会者"
                      name="informedIds"
                      placeholder="知会者 ID，每行一个"
                      className={fieldClass}
                    />
                  </div>
                )}
                {!decision && (
                  <fieldset className="text-sm">
                    <legend>影响任务</legend>
                    {tasks.map((task) => (
                      <label key={task.id} className="mr-3">
                        <input type="checkbox" name="impactTaskIds" value={task.id} /> {task.title}
                      </label>
                    ))}
                  </fieldset>
                )}
                <textarea
                  aria-label="证据来源"
                  name="evidence"
                  required
                  defaultValue={decision?.evidence}
                  placeholder="证据来源及定位，例如会议日期、文档章节"
                  className={fieldClass}
                />
                {decision && (
                  <textarea
                    aria-label="决策变更原因"
                    name="changeReason"
                    required
                    placeholder="变更原因与影响范围"
                    className={fieldClass}
                  />
                )}
                <button disabled={busy} className={buttonClass}>
                  {decision ? '确认新版本并标记关联交付物复核' : '确认并记录决策'}
                </button>
                {decision && (
                  <button
                    type="button"
                    className="ml-2 text-sm"
                    onClick={() => setState((current) => ({ ...current, decisionId: undefined }))}
                  >
                    取消编辑
                  </button>
                )}
              </form>
              <div className="mt-4 space-y-3">
                {chain.decisions.map((item) => (
                  <details key={item.id} className="rounded-lg bg-muted/50 p-3 text-sm">
                    <summary>
                      {item.title} · v{item.version}
                    </summary>
                    <p className="mt-2 whitespace-pre-wrap">{item.rationale}</p>
                    <p className="mt-2 whitespace-pre-wrap text-muted-foreground">依据：{item.evidence}</p>
                    <p className="mt-2">
                      状态：
                      {item.status === 'candidate'
                        ? '待 DACI 拍板'
                        : item.status === 'decided'
                          ? '已决定'
                          : '已替代'}
                      {item.daci && ` · 推进 ${item.daci.driverId} · 拍板 ${item.daci.approverId}`}
                    </p>
                    {item.deadlineAt && <p>最迟决定：{new Date(item.deadlineAt).toLocaleString()}</p>}
                    {item.impactTaskIds.length > 0 && (
                      <p>
                        影响任务：
                        {item.impactTaskIds
                          .map((id) => tasks.find((task) => task.id === id)?.title ?? id)
                          .join('、')}
                      </p>
                    )}
                    {item.alternatives.length > 0 && (
                      <p>
                        候选：
                        {item.alternatives
                          .map((option) => `${option.title}（${option.tradeoffs}）`)
                          .join('；')}
                      </p>
                    )}
                    {item.status === 'candidate' && item.daci?.approverId === 'local-user' && (
                      <button
                        disabled={busy}
                        className={`${buttonClass} mt-2`}
                        onClick={() =>
                          void execute({
                            kind: 'approve_decision',
                            decisionId: item.id,
                            comment: '已审阅并确认',
                          })
                        }
                      >
                        DACI 拍板确认
                      </button>
                    )}
                    <details className="mt-2">
                      <summary>决策版本历史</summary>
                      {chain.decisionHistory
                        .filter((entry) => entry.id === item.id)
                        .map((entry) => (
                          <div key={entry.version} className="mt-2">
                            <p>
                              v{entry.version} · {new Date(entry.at).toLocaleString()} · {entry.actor}
                            </p>
                            <p className="whitespace-pre-wrap">{entry.rationale}</p>
                            <p className="whitespace-pre-wrap text-muted-foreground">
                              依据：{entry.evidence}
                            </p>
                          </div>
                        ))}
                    </details>
                    <button
                      disabled={busy}
                      className="mt-2 text-primary"
                      onClick={() => setState((current) => ({ ...current, decisionId: item.id }))}
                    >
                      更新决策
                    </button>
                  </details>
                ))}
              </div>
            </section>
            <section className="rounded-xl bg-card p-5 shadow-sm">
              <h3 className="mb-3 font-medium">
                {draft ? `复核 / 修改交付物 · v${draft.version + 1}` : '创建关联交付物'}
              </h3>
              {tasks.length === 0 && (
                <p className="mb-3 text-sm text-muted-foreground">请先在任务页创建协作任务。</p>
              )}
              <form
                key={`draft-${state.draftId}-${state.draftFormVersion ?? 0}`}
                className="space-y-3"
                onSubmit={(event) => {
                  event.preventDefault()
                  const data = new FormData(event.currentTarget)
                  void execute({
                    kind: 'draft',
                    draftId: draft?.id,
                    title: text(data, 'title'),
                    taskId: text(data, 'taskId'),
                    content: text(data, 'content'),
                    artifactRef: text(data, 'artifactRef'),
                    executionId: text(data, 'executionId') || undefined,
                    criteria: text(data, 'criteria'),
                    recipient: text(data, 'recipient'),
                    responsibilities: {
                      ownerId: tasks.find((task) => task.id === text(data, 'taskId'))?.assignee?.userId ?? '',
                      reviewerId: text(data, 'reviewerId').trim(),
                      recipientId: text(data, 'recipientId').trim(),
                    },
                    changeReason: text(data, 'changeReason'),
                    decisionIds: data.getAll('decisionIds').map(String),
                  })
                }}
              >
                <input
                  aria-label="交付物标题"
                  name="title"
                  required
                  defaultValue={draft?.title}
                  placeholder="交付物标题"
                  className={fieldClass}
                />
                <select
                  aria-label="关联任务"
                  name="taskId"
                  required
                  defaultValue={draft?.taskId ?? ''}
                  className={fieldClass}
                >
                  <option value="">选择关联任务</option>
                  {tasks.map((task) => (
                    <option key={task.id} value={task.id}>
                      {task.title} · 负责人 {task.assignee?.userId ?? '未指定'}
                    </option>
                  ))}
                </select>
                <fieldset className="space-y-1 text-sm">
                  <legend>指导本次交付的决策（保存时绑定当前版本）</legend>
                  {chain.decisions.map((item) => (
                    <label key={item.id} className="block">
                      <input
                        type="checkbox"
                        name="decisionIds"
                        value={item.id}
                        defaultChecked={draft?.decisions.some((ref) => ref.id === item.id)}
                      />{' '}
                      {item.title} · v{item.version}
                    </label>
                  ))}
                </fieldset>
                <textarea
                  aria-label="交付说明"
                  name="content"
                  required
                  defaultValue={draft?.content}
                  placeholder="完成了什么、交付范围及尚存问题"
                  rows={4}
                  className={fieldClass}
                />
                <input
                  aria-label="成果引用"
                  name="artifactRef"
                  defaultValue={draft?.artifactRef}
                  placeholder="成果引用（可选）：提交号、文件位置、报告或工单链接"
                  className={fieldClass}
                />
                <input
                  aria-label="关联执行记录 ID"
                  name="executionId"
                  defaultValue={draft?.executionId}
                  placeholder="Agent 执行记录 ID（Agent 负责任务必填）"
                  className={fieldClass}
                />
                <textarea
                  aria-label="验收标准"
                  name="criteria"
                  required
                  defaultValue={draft?.criteria}
                  placeholder="验收标准"
                  className={fieldClass}
                />
                <input
                  aria-label="约定接收人"
                  name="recipient"
                  required
                  defaultValue={draft?.recipient}
                  placeholder="约定接收人"
                  className={fieldClass}
                />
                <input
                  aria-label="验收人 ID"
                  name="reviewerId"
                  required
                  defaultValue={draft?.responsibilities?.reviewerId}
                  placeholder="验收人用户 ID（本地用户为 local-user）"
                  className={fieldClass}
                />
                <input
                  aria-label="接收人 ID"
                  name="recipientId"
                  required
                  defaultValue={draft?.responsibilities?.recipientId}
                  placeholder="接收人用户 ID"
                  className={fieldClass}
                />
                {draft && (
                  <textarea
                    aria-label="交付变更原因"
                    name="changeReason"
                    required
                    placeholder="变更原因、影响范围及复核结论"
                    className={fieldClass}
                  />
                )}
                <button disabled={busy || !tasks.length || !chain.decisions.length} className={buttonClass}>
                  {draft ? '确认已复核并保存新版本' : '保存交付物'}
                </button>
                {draft && (
                  <button
                    type="button"
                    className="ml-2 text-sm"
                    onClick={() => setState((current) => ({ ...current, draftId: undefined }))}
                  >
                    取消编辑
                  </button>
                )}
              </form>
            </section>
          </div>
          <section className="rounded-xl bg-card p-5 shadow-sm">
            <h3 className="font-medium">关键依赖交接契约</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              明确下游需要什么、谁提供、何时提供和何时算接收成功；这不会替代原有任务依赖。
            </p>
            <form
              className="mt-3 grid gap-2 md:grid-cols-2"
              onSubmit={(event) => {
                event.preventDefault()
                const data = new FormData(event.currentTarget)
                const dependency = dependencies.find((item) => item.id === text(data, 'dependencyId'))
                if (!dependency) return
                const upstream = tasks.find((task) => task.id === dependency.dependsOnTaskId)
                const downstream = tasks.find((task) => task.id === dependency.taskId)
                void execute({
                  kind: 'define_dependency_handoff',
                  dependencyId: dependency.id,
                  upstreamTaskId: dependency.dependsOnTaskId,
                  downstreamTaskId: dependency.taskId,
                  need: text(data, 'need'),
                  providerId: upstream?.assignee?.userId ?? '',
                  consumerId: downstream?.assignee?.userId ?? '',
                  dueAt: new Date(text(data, 'dueAt')).getTime(),
                  criteria: lines(text(data, 'criteria')),
                })
              }}
            >
              <select aria-label="依赖交接关联依赖" name="dependencyId" required className={fieldClass}>
                <option value="">选择依赖</option>
                {dependencies.map((dependency) => (
                  <option key={dependency.id} value={dependency.id}>
                    {tasks.find((task) => task.id === dependency.dependsOnTaskId)?.title ??
                      dependency.dependsOnTaskId}{' '}
                    → {tasks.find((task) => task.id === dependency.taskId)?.title ?? dependency.taskId}
                  </option>
                ))}
              </select>
              <input
                aria-label="依赖需要内容"
                name="need"
                required
                placeholder="下游需要什么"
                className={fieldClass}
              />
              <input
                aria-label="依赖承诺时间"
                type="datetime-local"
                name="dueAt"
                required
                className={fieldClass}
              />
              <textarea
                aria-label="依赖接收标准"
                name="criteria"
                required
                placeholder="接收成功标准，每行一项"
                className={fieldClass}
              />
              <button disabled={busy || !dependencies.length} className={buttonClass}>
                定义交接契约
              </button>
            </form>
            <div className="mt-3 space-y-2 text-sm">
              {chain.dependencyHandoffs.map((handoff) => (
                <article key={handoff.dependencyId} className="rounded-lg bg-muted/50 p-3">
                  <p>
                    {tasks.find((task) => task.id === handoff.upstreamTaskId)?.title ??
                      handoff.upstreamTaskId}{' '}
                    →{' '}
                    {tasks.find((task) => task.id === handoff.downstreamTaskId)?.title ??
                      handoff.downstreamTaskId}{' '}
                    · {handoff.status}
                  </p>
                  <p>
                    需要：{handoff.need}；提供：{handoff.providerId}；接收：{handoff.consumerId}；承诺：
                    {new Date(handoff.dueAt).toLocaleString()}
                  </p>
                  <p>接收标准：{handoff.criteria.join('、')}</p>
                  {(handoff.status === 'planned' || handoff.status === 'returned') && (
                    <button
                      disabled={busy || handoff.providerId !== 'local-user'}
                      className={`${buttonClass} mt-2`}
                      onClick={() =>
                        void execute({
                          kind: 'offer_dependency_handoff',
                          dependencyId: handoff.dependencyId,
                          comment: '上游已交付，请下游核对',
                        })
                      }
                    >
                      发起交接
                    </button>
                  )}
                  {handoff.status === 'offered' && (
                    <span className="inline-flex gap-2">
                      <button
                        disabled={busy || handoff.consumerId !== 'local-user'}
                        className={`${buttonClass} mt-2`}
                        onClick={() =>
                          void execute({
                            kind: 'accept_dependency_handoff',
                            dependencyId: handoff.dependencyId,
                            comment: '已核对并接收',
                          })
                        }
                      >
                        确认接收
                      </button>
                      <button
                        disabled={busy || handoff.consumerId !== 'local-user'}
                        className={`${buttonClass} mt-2`}
                        onClick={() =>
                          void execute({
                            kind: 'return_dependency_handoff',
                            dependencyId: handoff.dependencyId,
                            comment: '退回，请补齐接收标准',
                          })
                        }
                      >
                        退回
                      </button>
                    </span>
                  )}
                </article>
              ))}
            </div>
          </section>
          <section id="project-chain-drafts" className="space-y-3">
            <h3 className="font-medium">交付物与协作交接</h3>
            {!chain.drafts.length && (
              <p className="text-sm text-muted-foreground">记录决策后创建交付物，即可跟踪验收与交接。</p>
            )}
            {chain.drafts.map((item) => (
              <article key={item.id} className="rounded-xl bg-card p-5 shadow-sm">
                <div className="flex justify-between gap-3">
                  <h4 className="font-medium">
                    {item.title} · v{item.version}
                  </h4>
                  <span className="text-sm text-primary">
                    {item.responsibilities ? statusLabels[item.status] : '历史记录 · 待补齐责任'}
                  </span>
                </div>
                <p className="mt-2 text-sm">
                  任务：{tasks.find((task) => task.id === item.taskId)?.title ?? '关联任务已删除'} · 接收人：
                  {item.recipient}
                </p>
                <p className="mt-2 text-sm">
                  当前任务负责人：
                  {tasks.find((task) => task.id === item.taskId)?.assignee?.displayName ?? '未指定'}
                </p>
                <p className="mt-2 text-sm">
                  责任快照：负责人 {item.responsibilities?.ownerId ?? '待补齐'} · 验收人{' '}
                  {item.responsibilities?.reviewerId ?? '待补齐'} · 接收人{' '}
                  {item.responsibilities?.recipientId ?? '待补齐'}
                </p>
                {(!item.responsibilities ||
                  item.responsibilities.ownerId !==
                    tasks.find((task) => task.id === item.taskId)?.assignee?.userId) && (
                  <p className="mt-2 text-sm text-destructive">
                    责任缺失或任务已改派，原状态不能作为继续流转依据；请复核并保存新版本。
                  </p>
                )}
                {item.artifactRef && <p className="mt-2 break-all text-sm">成果引用：{item.artifactRef}</p>}
                {item.executionId && (
                  <p className="mt-2 break-all text-sm">关联 Agent 执行记录：{item.executionId}</p>
                )}
                <TaskExecutionEvidence key={item.taskId} taskId={item.taskId} />
                <p className="mt-2 text-sm">
                  决策：
                  {item.decisions
                    .map(
                      (ref) =>
                        `${chain.decisionHistory.find((entry) => entry.id === ref.id && entry.version === ref.version)?.title ?? ref.id} v${ref.version}`,
                    )
                    .join('、')}
                </p>
                <p className="mt-2 whitespace-pre-wrap text-sm">验收标准：{item.criteria}</p>
                {item.definitionOfDone.length > 0 && (
                  <p className="mt-2 text-sm">
                    冻结 DoD：{item.definitionOfDone.join('、')}
                    {item.acceptedCriteria && ` · 已确认：${item.acceptedCriteria.join('、')}`}
                  </p>
                )}
                <details className="mt-3 text-sm">
                  <summary>查看交付说明与版本历史</summary>
                  <pre className="my-3 whitespace-pre-wrap font-sans">{item.content}</pre>
                  {chain.draftHistory
                    .filter((entry) => entry.id === item.id)
                    .map((entry) => (
                      <details key={entry.version}>
                        <summary>
                          v{entry.version} · {new Date(entry.at).toLocaleString()}
                        </summary>
                        <pre className="whitespace-pre-wrap font-sans">{entry.content}</pre>
                        {entry.artifactRef && <p className="break-all">成果引用：{entry.artifactRef}</p>}
                        <p>验收标准：{entry.criteria}</p>
                      </details>
                    ))}
                </details>
                <div className="mt-3 flex gap-3 text-sm">
                  <button
                    disabled={busy}
                    className="text-primary"
                    onClick={() => setState((current) => ({ ...current, draftId: item.id }))}
                  >
                    复核 / 修改
                  </button>
                  {item.status === 'draft' && (
                    <button
                      disabled={busy || item.responsibilities?.ownerId !== 'local-user'}
                      className={buttonClass}
                      onClick={() => void execute({ kind: 'submit', draftId: item.id })}
                    >
                      提交验收
                    </button>
                  )}
                </div>
                {(item.status === 'submitted' ||
                  item.status === 'accepted' ||
                  item.status === 'handoff_pending') && (
                  <form
                    key={`${item.version}-${item.status}`}
                    className="mt-3 flex flex-wrap gap-2"
                    onSubmit={(event) => {
                      event.preventDefault()
                      const data = new FormData(event.currentTarget)
                      const submitter = (event.nativeEvent as SubmitEvent)
                        .submitter as HTMLButtonElement | null
                      const kind = submitter?.value
                      if (
                        kind === 'accept' ||
                        kind === 'reject' ||
                        kind === 'handoff' ||
                        kind === 'request_handoff' ||
                        kind === 'reject_handoff'
                      )
                        void execute({
                          kind,
                          draftId: item.id,
                          comment: text(data, 'comment'),
                          evidence: text(data, 'evidence'),
                          completedCriteria: data.getAll('completedCriteria').map(String),
                        })
                    }}
                  >
                    <input
                      aria-label={`${item.title}的验收意见或接收回执`}
                      name="comment"
                      required
                      placeholder={
                        item.status === 'accepted'
                          ? '交接范围、交付包及待办事项'
                          : item.status === 'handoff_pending'
                            ? '核对结果及接收或退回原因'
                            : '逐项验收结论或退回原因'
                      }
                      className={`${fieldClass} flex-1`}
                    />
                    {item.status === 'submitted' ? (
                      <>
                        <input
                          aria-label={`${item.title}的验收依据`}
                          name="evidence"
                          placeholder="验收依据：测试记录、检查记录或定位引用（通过时必填）"
                          className={fieldClass}
                        />
                        {item.definitionOfDone.map((criterion) => (
                          <label key={criterion} className="text-sm">
                            <input type="checkbox" name="completedCriteria" value={criterion} /> DoD：
                            {criterion}
                          </label>
                        ))}
                        <button
                          disabled={busy || item.responsibilities?.reviewerId !== 'local-user'}
                          value="accept"
                          className={buttonClass}
                        >
                          验收通过
                        </button>
                        <button
                          disabled={busy || item.responsibilities?.reviewerId !== 'local-user'}
                          value="reject"
                          className={buttonClass}
                        >
                          退回修改
                        </button>
                      </>
                    ) : item.status === 'accepted' ? (
                      <button
                        disabled={busy || item.responsibilities?.ownerId !== 'local-user'}
                        value="request_handoff"
                        className={buttonClass}
                      >
                        发起交接
                      </button>
                    ) : (
                      <>
                        <button
                          disabled={busy || item.responsibilities?.recipientId !== 'local-user'}
                          value="handoff"
                          className={buttonClass}
                        >
                          确认接收
                        </button>
                        <button
                          disabled={busy || item.responsibilities?.recipientId !== 'local-user'}
                          value="reject_handoff"
                          className={buttonClass}
                        >
                          退回交接
                        </button>
                      </>
                    )}
                  </form>
                )}
              </article>
            ))}
          </section>
          <details className="rounded-xl bg-card p-5 shadow-sm">
            <summary>链路历史 · {chain.events.length} 条</summary>
            <ol className="mt-3 space-y-2 text-sm">
              {[...chain.events].reverse().map((event) => (
                <li key={event.id}>
                  {new Date(event.at).toLocaleString()} ·{' '}
                  {event.action === 'handoff' &&
                  !chain.draftHistory.find(
                    (item) => item.id === event.entityId && item.version === event.version,
                  )?.responsibilities
                    ? '历史本机交接登记（未验证接收身份）'
                    : actionLabels[event.action]}{' '}
                  ·{' '}
                  {chain.decisionHistory.find(
                    (item) => item.id === event.entityId && item.version === event.version,
                  )?.title ??
                    chain.draftHistory.find(
                      (item) => item.id === event.entityId && item.version === event.version,
                    )?.title}{' '}
                  v{event.version} · {event.actor}
                  {event.evidence && <p className="whitespace-pre-wrap">依据：{event.evidence}</p>}
                  {event.changeReason && (
                    <p className="whitespace-pre-wrap">变更原因：{event.changeReason}</p>
                  )}
                  {event.comment && (
                    <p className="whitespace-pre-wrap text-muted-foreground">{event.comment}</p>
                  )}
                </li>
              ))}
            </ol>
          </details>
        </>
      )}
    </div>
  )
}

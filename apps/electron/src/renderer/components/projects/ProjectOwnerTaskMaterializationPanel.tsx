import { useEffect, useMemo } from 'react'
import { atom, useAtomValue, useSetAtom } from 'jotai'
import type {
  OwnerTaskMaterializationPreview,
  OwnerTaskMaterializationRecord,
  OwnerTaskProjection,
} from '@gravitas/shared'
import {
  getOwnerExecutionEditor,
  ownerExecutionEditorsAtom,
} from '../../atoms/project-owner-execution-atoms'
import {
  canMaterializeOwnerTasks,
  canPreviewOwnerTasks,
  compareOwnerTasksAtom,
  getOwnerTaskEditor,
  loadOwnerTaskHistoryAtom,
  loadOwnerTasksAtom,
  materializeOwnerTasksAtom,
  ownerTaskEditorsAtom,
  previewOwnerTasksAtom,
  refreshOwnerTaskListAtom,
} from '../../atoms/project-owner-task-atoms'
const button = 'rounded-md bg-muted px-3 py-2 text-sm disabled:opacity-50'
function TaskProjectionFacts({
  projection: p,
}: {
  projection: OwnerTaskProjection
}): React.ReactElement {
  return (
    <li className="min-w-0 rounded-lg bg-background/60 p-3">
      <p className="font-medium">
        步骤 {p.stepKey} · {p.title}
      </p>
      <p>Task：{p.targetTaskId ?? '确认时由服务端新建精确ID；不按标题复用'}</p>
      <p>说明：{p.description}</p>
      <p>
        成果：{p.outcome}；完成标准：{p.acceptanceCriteria.join('；')}
      </p>
      <p>岗位建议：{p.roleKey}（不是实际员工或能力许可）</p>
      <p>步骤依赖：{p.dependencies.join('、') || '无'}；仅本次所选闭包映射</p>
      {p.previous ? (
        <div className="mt-2 space-y-1 rounded-md bg-muted/50 p-2">
          <p>单任务显式影响：标题与说明保留；仅人员、工作区、状态、研发范围变更。</p>
          <p>
            变更前：{p.previous.status}；
            {p.previous.assignee
              ? `${p.previous.assignee.displayName}（${p.previous.assignee.userId}）`
              : '未分配'}
            ；工作区 {p.previous.workspaceId ?? '无'}
          </p>
          <p>
            变更后：paused；{p.assignee.displayName}（{p.assignee.userId}）；工作区 {p.workspaceId}
          </p>
          <p>成员目录旧键：{p.previous.assigneeMemberId ?? '无'}；{p.clearAssigneeMemberId ? '确认后清除，不沿用旧负责人身份' : '保持不变'}</p>
          <p className="whitespace-pre-wrap text-xs">
            研发范围变更前：{JSON.stringify(p.previous.developmentScope ?? null, null, 2)}
            <br />
            研发范围变更后：{JSON.stringify(p.developmentScope ?? null, null, 2)}
          </p>
          <p>原AO05完整目标hash可因合法变更自然stale；原计划、来源与准备记录不改写。</p>
        </div>
      ) : (
        <p>
          拟新建顶层paused Task；真实Executor {p.assignee.displayName}（{p.assignee.userId}
          ）；工作区 {p.workspaceId}
        </p>
      )}
      {!p.previous && p.developmentScope && (
        <p className="whitespace-pre-wrap text-xs">
          冻结研发范围（不是路径授权）：{JSON.stringify(p.developmentScope, null, 2)}
        </p>
      )}
    </li>
  )
}
function MaterializationFacts({
  preview: p,
}: {
  preview: OwnerTaskMaterializationPreview
}): React.ReactElement {
  const preparation = p.preparation
  const source = preparation.source
  return (
    <div className="min-w-0 space-y-2 whitespace-pre-wrap text-sm [overflow-wrap:anywhere]">
      <p>
        准备 {preparation.id} · revision {preparation.revision} · policy revision{' '}
        {preparation.policyRevision}
      </p>
      <p className="text-xs">
        准备版本hash：{preparation.integrityHash}
        <br />
        目标 revision {source.goalRevision} / v{source.goalVersion}；计划 revision{' '}
        {source.planRevision} / v{source.planVersion}
        <br />
        计划指纹：{source.planFingerprint}
        <br />
        来源指纹：{source.contextFingerprint}
      </p>
      <p>
        真实Executor：{source.executor.name}（{source.executor.id}）<br />
        技术Reviewer：{source.reviewer.name}（{source.reviewer.id}），不是业务验收人。
      </p>
      <p>
        冻结工作区：{source.workspaceName}（{source.workspaceId}）；人员与资料配置不转换为权限。
      </p>
      <p>
        资料仅冻结元数据：
        {source.knowledgeSources
          .map((s) => `${s.name}（${s.id}）· ${s.metadataHash} · contentHash 未知`)
          .join('；') || 'none（明确无可选来源）'}
      </p>
      {p.targetTaskHash && (
        <p className="text-xs">
          确认前目标Task版本hash：{p.targetTaskHash}
          <br />
          目标依赖hash：{p.targetDependenciesHash ?? '无'}
        </p>
      )}
      <ol className="space-y-2">
        {p.projections.map((projection) => (
          <TaskProjectionFacts key={projection.stepKey} projection={projection} />
        ))}
      </ol>
      <p className="text-xs">
        预览指纹：{p.previewFingerprint}；请求 {p.input.requestId}；全项目材料化 revision{' '}
        {p.input.expectedMaterializationRevision}
      </p>
      <p>
        授权 0 · 费用预留 0 · 执行 0。仅落地暂停任务与依赖，不会派工、读取资料、调用模型或外部同步。
      </p>
      <p>落地后需要重新验证；Task/步骤有关联不等于执行准备或运行许可。</p>
    </div>
  )
}
function RecordFacts({
  record: r,
}: {
  record: OwnerTaskMaterializationRecord
}): React.ReactElement {
  return (
    <details className="min-w-0 rounded-lg bg-muted/40 p-3">
      <summary className="cursor-pointer text-sm">
        材料化 revision {r.revision} · 暂停落地，需要重新验证
      </summary>
      <p className="mt-2 text-xs">
        {r.id} · {new Date(r.savedAt).toLocaleString()} · {r.actor}
        <br />
        {r.stage}
        <br />
        记录hash：{r.integrityHash}
      </p>
      <MaterializationFacts preview={r.preview} />
      <ul className="mt-2 space-y-2 whitespace-pre-wrap text-xs">
        {r.links.map((link) => (
          <li key={link.id} className="rounded-md bg-background/60 p-2">
            步骤 {link.stepKey} → Task {link.taskId}（{link.kind}）<br />
            link {link.id} · batch {link.materializationId}
            <br />
            冻结Task规格hash：{link.taskSpecificationHash}
            <br />
            关联hash：{link.integrityHash}
            <br />
            {link.dependencies.length
              ? link.dependencies.map((edge) => (
                  <p key={edge.id}>
                    edge {edge.id}：上游Task {edge.dependsOnTaskId} → 下游Task {edge.taskId}；
                    {edge.type}
                  </p>
                ))
              : '真实依赖edge：无'}
          </li>
        ))}
      </ul>
      <details className="mt-2">
        <summary className="cursor-pointer text-xs">完整材料化记录（只读）</summary>
        <pre className="max-h-72 overflow-auto whitespace-pre-wrap text-xs">
          {JSON.stringify(r, null, 2)}
        </pre>
      </details>
    </details>
  )
}
export function ProjectOwnerTaskMaterializationPanel({
  projectId,
  taskId,
}: {
  projectId: string
  taskId?: string
}): React.ReactElement {
  const subject = useMemo(
    () => ({ projectId, ...(taskId === undefined ? {} : { taskId }) }),
    [projectId, taskId],
  )
  const derived = useMemo(
    () =>
      atom((get) => ({
        editor: getOwnerTaskEditor(get(ownerTaskEditorsAtom), subject),
        preparation: getOwnerExecutionEditor(get(ownerExecutionEditorsAtom), subject).view
          ?.preparation,
        canPreview: canPreviewOwnerTasks(get, subject),
        canSave: canMaterializeOwnerTasks(get, subject),
      })),
    [subject],
  )
  const { editor: e, preparation, canPreview, canSave } = useAtomValue(derived)
  const load = useSetAtom(loadOwnerTasksAtom)
  const preview = useSetAtom(previewOwnerTasksAtom)
  const materialize = useSetAtom(materializeOwnerTasksAtom)
  const compare = useSetAtom(compareOwnerTasksAtom)
  const history = useSetAtom(loadOwnerTaskHistoryAtom)
  const refresh = useSetAtom(refreshOwnerTaskListAtom)
  useEffect(() => {
    void load(subject)
  }, [load, subject])
  const busy = e.loading || e.previewing || e.saving || e.refreshing
  return (
    <section
      className="mt-4 min-w-0 max-w-full rounded-xl bg-card p-3 shadow-sm [overflow-wrap:anywhere] sm:p-4"
      aria-label="Owner 暂停任务落地"
    >
      <h3 className="font-semibold">暂停任务落地（AO06）</h3>
      <p className="mt-2 text-xs text-muted-foreground">
        从已保存且当前有效的AO05准备落地。授权 0 · 费用预留 0 · 执行
        0；不会派工、发行许可、调用Provider或外部同步。技术Reviewer不是业务验收人，岗位建议不是实际人员。
      </p>
      <p className="mt-2 text-xs">
        {taskId
          ? '单任务首片仅支持无依赖的一步，显式核对before/after；不拆子任务、不接管旧Run。'
          : '项目目标每个所选步骤各建一个新的顶层暂停Task，依赖精确映射；不按标题复用旧任务。'}
      </p>
      <p role="status" className="mt-2 text-sm">
        {e.loading
          ? '正在读取暂停任务落地状态'
          : `当前材料化：${e.view?.status ?? '未加载'}；全项目材料化 revision ${e.view?.revision ?? '未知'}`}
      </p>
      {preparation && (
        <p className="mt-2 text-xs">
          当前AO05来源：{preparation.id} · revision {preparation.revision} · hash{' '}
          {preparation.integrityHash} · policy revision {preparation.policyRevision}
        </p>
      )}
      {!canPreview && !e.view?.materialization && (
        <p className="mt-2 text-sm">
          仅当前有效、无未保存编辑或冲突的confirmed计划与AO05准备可预览；来源变化即废旧预览。冲突需读取最新版本、比较，再重新预览。
        </p>
      )}
      {e.error && (
        <p role="alert" className="mt-2 text-sm text-destructive">
          {e.error}。上游输入保留，不自动重试。
        </p>
      )}
      {e.requiresReview && (
        <div className="mt-2 rounded-md bg-muted p-3 text-sm">
          <p>
            请比较最新材料化
            revision、准备ID/revision/hash、policy及源诊断。重新读取不覆盖AO05编辑；比较不会恢复旧预览。
          </p>
          <button
            type="button"
            className={`${button} mt-2`}
            disabled={!e.loaded || busy}
            onClick={() => compare(subject)}
          >
            已比较暂停任务来源，重新预览
          </button>
        </div>
      )}
      {e.view?.blockers.length ? (
        <ul className="mt-2 space-y-1 text-sm">
          {e.view.blockers.map((v, i) => (
            <li key={`${i}-${v}`}>{v}</li>
          ))}
        </ul>
      ) : null}
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          className={button}
          disabled={!canPreview}
          onClick={() => void preview(subject)}
        >
          {e.previewing ? '正在预览暂停任务落地…' : '只读预览暂停任务落地'}
        </button>
        <button
          type="button"
          className={button}
          disabled={!canSave}
          onClick={() => void materialize(subject)}
        >
          {e.saving ? '正在落为暂停任务…' : '落为暂停任务'}
        </button>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        确认仅保存暂停Task、step
        link与依赖；不表示执行。进行中不能重复提交。落地后必须重新验证，原准备不会自动升级。
      </p>
      {e.preview && (
        <section
          className="mt-3 max-h-[60vh] min-w-0 overflow-y-auto"
          aria-label="暂停任务精确预览"
        >
          <MaterializationFacts preview={e.preview} />
        </section>
      )}
      {e.view?.materialization && (
        <div className="mt-3">
          <p className="mb-2 text-xs">已保存快照（当前状态以诊断为准，不代表授权）：</p>
          <RecordFacts record={e.view.materialization} />
        </div>
      )}
      {e.refreshError && (
        <p role="alert" className="mt-2 text-sm text-destructive">
          {e.refreshError}
        </p>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" className={button} disabled={busy} onClick={() => void load(subject)}>
          重新读取暂停任务版本与诊断
        </button>
        <button
          type="button"
          className={button}
          disabled={busy || !e.view?.materialization}
          onClick={() => void refresh(subject)}
        >
          只读刷新权威任务列表
        </button>
        <button
          type="button"
          className={button}
          disabled={e.historyLoading}
          onClick={() => void history(subject)}
        >
          查看暂停任务落地历史
        </button>
      </div>
      {e.historyError && (
        <p role="alert" className="mt-2 text-sm text-destructive">
          材料化历史：{e.historyError}
        </p>
      )}
      {e.historyLoaded && (
        <section
          className="mt-3 max-h-[40vh] min-w-0 space-y-2 overflow-y-auto"
          aria-label="暂停任务落地历史"
        >
          <p className="text-xs">历史只读，不可恢复、不表示当前来源或许可有效。</p>
          {e.history.map((r) => (
            <RecordFacts key={r.id} record={r} />
          ))}
          {!e.history.length && <p className="text-sm">暂无材料化历史</p>}
        </section>
      )}
    </section>
  )
}

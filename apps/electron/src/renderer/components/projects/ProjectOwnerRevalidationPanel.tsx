/** 材料化后重新验证面板：唯一动作是"重新验证为v2"；不是执行许可，历史只读。 */
import { useEffect, useMemo } from 'react'
import { atom, useAtomValue, useSetAtom } from 'jotai'
import type {
  OwnerExecutionRevalidationInput,
  OwnerExecutionRevalidationRecord,
  OwnerExecutionRevalidationSource,
} from '@gravitas/shared'
import {
  canPreviewOwnerRevalidation,
  getOwnerRevalidationEditor,
  loadOwnerRevalidationAtom,
  editOwnerRevalidationAtom,
  loadOwnerRevalidationHistoryAtom,
  ownerRevalidationEditorsAtom,
  ownerRevalidationSourceStamp,
  revalidateOwnerExecutionAtom,
} from '../../atoms/project-owner-execution-revalidation-atoms'
import { getOwnerTaskEditor, ownerTaskEditorsAtom } from '../../atoms/project-owner-task-atoms'
const field = 'mt-1 w-full min-w-0 rounded-md border bg-background p-2 text-sm'
const button = 'rounded-md bg-muted px-3 py-2 text-sm disabled:opacity-50'
function UpstreamChain({ source }: { source: OwnerExecutionRevalidationSource }): React.ReactElement {
  return (
    <p className="text-xs">
      上游链（逐项精确反查）：
      <br />
      材料化 {source.materialization.id} · revision {source.materialization.revision} · hash{' '}
      {source.materialization.integrityHash}
      <br />
      原AO05准备 {source.originalPreparation.id} · revision {source.originalPreparation.revision} ·
      hash {source.originalPreparation.integrityHash} · policy revision{' '}
      {source.originalPreparation.policyRevision}
      <br />
      计划指纹 {source.planFingerprint}；来源指纹 {source.contextFingerprint}（与v1冻结值一致，不重算）
    </p>
  )
}
function RevalidationFacts({
  source,
  input,
}: {
  source: OwnerExecutionRevalidationSource
  input?: OwnerExecutionRevalidationInput
}): React.ReactElement {
  return (
    <div className="min-w-0 space-y-2 whitespace-pre-wrap text-sm [overflow-wrap:anywhere]">
      <UpstreamChain source={source} />
      <div>
        <p className="font-medium">真实暂停Task清单（权威任务，不是计划投影）：</p>
        <ol className="space-y-2">
          {source.tasks.map((t) => (
            <li key={t.linkId} className="min-w-0 rounded-md bg-background/60 p-2 text-xs">
              步骤 {t.stepKey} → Task {t.taskId}（{t.linkKind}）· {t.status}
              <br />
              link {t.linkId} · link hash {t.linkIntegrityHash} · 规格hash{' '}
              {t.taskSpecificationHash}
              <br />
              负责人：{t.assignee.displayName}（{t.assignee.userId}）· 工作区 {t.workspaceId}
              <br />
              依赖 edge：{t.dependencies.length} 条
              {t.dependencies.length
                ? `（${t.dependencies.map((d) => `${d.id}:${d.dependsOnTaskId}→${d.taskId}:${d.type}`).join('；')}）`
                : ''}
            </li>
          ))}
        </ol>
      </div>
      <p>
        冻结承诺（不可顺延）：预算 {source.budget.maxCostMicros} 微美元 · 最大次数{' '}
        {source.budget.maxRuns} · 最大返工 {source.budget.maxRework} · 期限{' '}
        {new Date(source.budget.expiresAt).toLocaleString()}。重新验证只重冻结事实，预算与期限原样携带，不重开授权窗口。
      </p>
      <p className="text-xs">
        人员：执行 {source.executor.name}（{source.executor.id}）；评审 {source.reviewer.name}（
        {source.reviewer.id}）。工作区 {source.workspaceName}（{source.workspaceId}）；渠道{' '}
        {source.channelId}；模型 {source.modelId}；Runtime {source.runtime}。资料{' '}
        {source.knowledgeSources.length
          ? source.knowledgeSources.map((k) => `${k.name}（${k.id}）`).join('、')
          : 'none'}
      </p>
      {input && <p className="text-xs">修订原因：{input.changeReason}；请求 {input.requestId}</p>}
      <div role="status">
        <p>v2阻塞项（全部保留，不减项）：</p>
        <ul>
          {source.blockers.map((v, i) => (
            <li key={`${i}-${v}`}>{v}</li>
          ))}
        </ul>
      </div>
    </div>
  )
}
function RecordFacts({ record }: { record: OwnerExecutionRevalidationRecord }): React.ReactElement {
  return (
    <details className="min-w-0 rounded-lg bg-muted/40 p-3">
      <summary className="cursor-pointer text-sm">
        重验证 revision {record.revision} · policy revision {record.policyRevision} · 暂停，仍非许可
      </summary>
      <p className="mt-2 text-xs">
        {record.id} · {new Date(record.savedAt).toLocaleString()} · {record.actor}
        <br />
        记录hash：{record.integrityHash}
        {record.previousIntegrityHash ? ` · 上一记录hash：${record.previousIntegrityHash}` : ''}
      </p>
      <RevalidationFacts source={record.source} input={record.input} />
      <details className="mt-2">
        <summary className="cursor-pointer text-xs">完整v2记录（只读）</summary>
        <pre className="max-h-72 overflow-auto whitespace-pre-wrap text-xs">
          {JSON.stringify(record, null, 2)}
        </pre>
      </details>
    </details>
  )
}
export function ProjectOwnerRevalidationPanel({
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
        editor: getOwnerRevalidationEditor(get(ownerRevalidationEditorsAtom), subject),
        materialization: getOwnerTaskEditor(get(ownerTaskEditorsAtom), subject).view,
        stamp: ownerRevalidationSourceStamp(get, subject),
        canRevalidate: canPreviewOwnerRevalidation(get, subject),
      })),
    [subject],
  )
  const { editor: e, materialization, stamp, canRevalidate } = useAtomValue(derived)
  const load = useSetAtom(loadOwnerRevalidationAtom)
  const history = useSetAtom(loadOwnerRevalidationHistoryAtom)
  const revalidate = useSetAtom(revalidateOwnerExecutionAtom)
  const edit = useSetAtom(editOwnerRevalidationAtom)
  // 上游来源版本戳变化时自动只读重读；无人工刷新按钮，唯一动作只有重新验证。
  // biome-ignore lint/correctness/useExhaustiveDependencies: stamp为触发重读的版本戳，effect体内不直接引用
  useEffect(() => {
    void load(subject)
  }, [load, subject, stamp])
  useEffect(() => {
    void history(subject)
  }, [history, subject])
  const busy = e.loading || e.previewing || e.saving
  const facts = e.preview?.source ?? e.view?.revalidation?.source ?? null
  const factsInput = e.preview?.input ?? e.view?.revalidation?.input
  return (
    <section
      className="mt-4 min-w-0 max-w-full rounded-xl bg-card p-3 shadow-sm [overflow-wrap:anywhere] sm:p-4"
      aria-label="Owner 材料化后重新验证"
    >
      <h3 className="font-semibold">材料化后重新验证（v2）</h3>
      <p className="mt-2 text-xs text-muted-foreground">
        把v1准备来源升级为按真实暂停Task、link与依赖重新冻结的v2来源。唯一动作是重新验证；这不是执行许可，不派工、不发行、不调用模型，预算与期限是不可顺延的冻结承诺。
      </p>
      <p role="status" className="mt-2 text-sm">
        {e.loading
          ? '正在读取重验证状态'
          : `当前v2状态：${e.view?.status ?? '未加载'}；v2 revision ${e.view?.revision ?? '未知'}；材料化状态：${materialization?.status ?? '未加载'}`}
      </p>
      {e.requiresReview && (
        <p className="mt-2 text-xs">
          材料化或v1准备已变化，旧v2预览已废弃；将按最新事实重新预览，保存仍受服务端CAS校验。
        </p>
      )}
      {e.error && (
        <p role="alert" className="mt-2 text-sm text-destructive">
          {e.error}。输入保留，不会自动重试。
        </p>
      )}
      {e.view?.blockers.length ? (
        <ul className="mt-2 space-y-1 text-sm">
          {e.view.blockers.map((v, i) => (
            <li key={`${i}-${v}`}>{v}</li>
          ))}
        </ul>
      ) : null}
      {facts && (
        <section
          className="mt-3 max-h-[60vh] min-w-0 overflow-y-auto rounded-lg bg-muted/40 p-3"
          aria-label="重验证冻结预览区域"
        >
          <p className="mb-2 font-medium">冻结事实核对（不是执行许可）</p>
          <RevalidationFacts source={facts} input={factsInput} />
          {e.preview && <p className="mt-2 text-xs">预览指纹：{e.preview.previewFingerprint}</p>}
        </section>
      )}
      <div className="mt-3">
        <label className="text-xs font-medium" htmlFor={`owner-revalidation-change-reason-${subject.projectId}`}>
          重验证修订原因（必填）
        </label>
        <textarea
          id={`owner-revalidation-change-reason-${subject.projectId}`}
          className={`${field} mt-1 min-h-[64px]`}
          value={e.changeReason}
          disabled={busy}
          onChange={(event) => edit({ subject, patch: { changeReason: event.target.value } })}
        />
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          className={button}
          disabled={busy || !canRevalidate}
          onClick={() =>
            void revalidate(subject).then(() => {
              // 保存完成后自动重读v2历史；失败不影响保存结果核查。
              void history(subject)
            })
          }
        >
          {e.previewing || e.saving ? '正在重新验证…' : '重新验证为v2'}
        </button>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        重新验证=先只读预览再原样保存，需填写修订原因。相同请求重试只回读原件与当前漂移，不补造；成功也不产生任何许可、派工或费用。
      </p>
      {!canRevalidate && !busy && (
        <p className="mt-2 text-sm">
          仅当材料化处于needs_revalidation、v1准备已登记且已填写修订原因时，才可重新验证。
        </p>
      )}
      {e.view?.revalidation && (
        <div className="mt-3">
          <p className="mb-2 text-xs">已保存v2快照（当前状态以诊断为准，不代表授权）：</p>
          <RecordFacts record={e.view.revalidation} />
        </div>
      )}
      {e.historyError && (
        <p role="alert" className="mt-2 text-sm text-destructive">
          历史：{e.historyError}
        </p>
      )}
      {e.historyLoaded && (
        <section
          className="mt-3 max-h-[40vh] min-w-0 space-y-2 overflow-y-auto"
          aria-label="重验证历史"
        >
          <p className="text-xs">历史只读，不可恢复、不表示当前来源或许可有效。</p>
          {e.history.map((r) => (
            <RecordFacts key={r.id} record={r} />
          ))}
          {!e.history.length && <p className="text-sm">暂无重验证历史</p>}
        </section>
      )}
    </section>
  )
}

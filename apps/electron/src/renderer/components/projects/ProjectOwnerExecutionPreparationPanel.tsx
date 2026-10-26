import { useEffect, useId, useMemo } from 'react'
import { atom, useAtomValue, useSetAtom } from 'jotai'
import type {
  OwnerExecutionPreparationPreview,
  OwnerExecutionPreparationRecord,
  OwnerExecutionPreparationSource,
} from '@gravitas/shared'
import { getOwnerPlanEditor, ownerPlanEditorsAtom } from '../../atoms/project-owner-plan-atoms'
import {
  canPreviewOwnerExecution,
  canSaveOwnerExecution,
  compareOwnerExecutionAtom,
  editOwnerExecutionAtom,
  getOwnerExecutionEditor,
  loadOwnerExecutionAtom,
  loadOwnerExecutionHistoryAtom,
  ownerExecutionEditorsAtom,
  ownerExecutionPlanReady,
  previewOwnerExecutionAtom,
  saveOwnerExecutionAtom,
  type OwnerExecutionEdit,
} from '../../atoms/project-owner-execution-atoms'
import { ProjectOwnerTaskMaterializationPanel } from './ProjectOwnerTaskMaterializationPanel'
import { ProjectOwnerRevalidationPanel } from './ProjectOwnerRevalidationPanel'
const field = 'mt-1 w-full min-w-0 rounded-md border bg-background p-2 text-sm'
const button = 'rounded-md bg-muted px-3 py-2 text-sm disabled:opacity-50'
/** 完整冻结事实；历史只读，没有恢复、发行或执行入口。 */
function PreparationFacts({
  source,
  input,
}: {
  source: OwnerExecutionPreparationSource
  input: OwnerExecutionPreparationRecord['input']
}): React.ReactElement {
  const steps = source.plan.proposal.steps.filter((s) => source.selectedStepKeys.includes(s.key))
  return (
    <div className="space-y-2 whitespace-pre-wrap text-sm [overflow-wrap:anywhere]">
      <p>阶段：pending_task_links · 暂停，尚无任务步骤关联</p>
      <p>
        目标 revision {source.goalRevision} / v{source.goalVersion}；计划 revision{' '}
        {source.planRevision} / v{source.planVersion}
      </p>
      <p className="text-xs">
        计划指纹：{source.planFingerprint}
        <br />
        来源指纹：{source.contextFingerprint}
      </p>
      <p>{source.plan.proposal.summary}</p>
      <ol className="space-y-2">
        {steps.map((s) => (
          <li key={s.key} className="rounded-md bg-background/60 p-2">
            <p>
              {s.key} · {s.title}
            </p>
            <p>成果：{s.outcome}</p>
            <p>完成标准：{s.acceptanceCriteria.join('；')}</p>
            <p>
              依赖：{s.dependencies.join('、') || '无'} · 岗位建议：{s.roleKey}（不是实际员工）
            </p>
          </li>
        ))}
      </ol>
      <p>
        规划载体来源（不是业务执行许可）：
        {source.ownerBindingProvenance?.state === 'bound'
          ? `绑定 revision ${source.ownerBindingProvenance.bindingRevision}；carrier ${source.ownerBindingProvenance.carrierId}；摘要 ${source.ownerBindingProvenance.bindingHash}`
          : source.ownerBindingProvenance?.state === 'none'
            ? '明确无Owner规划绑定（手工计划可准备）'
            : '来源未记录，旧准备需核查'}
      </p>
      <p>
        实际执行人员：{source.executor.name}（{source.executor.id}）<br />
        实际评审人员：{source.reviewer.name}（{source.reviewer.id}）
      </p>
      <p>
        模式：{input.executionKind}；工作区：{source.workspaceName}（{source.workspaceId}）<br />
        渠道：{source.channelId}；模型：{source.modelId}；Runtime：{source.runtime}
      </p>
      <p>
        知识资料：
        {source.knowledgeSources.length
          ? source.knowledgeSources
              .map(
                (s) =>
                  `${s.name}（${s.id}）· KB ${s.knowledgeBaseIds.join('、')} · metadata ${s.metadataHash} · contentHash 未知`,
              )
              .join('\n')
          : 'none（明确无可选知识来源）'}
      </p>
      {source.developmentScope && (
        <p>
          研发范围（不构成路径访问授权）：
          <br />
          目标路径：{source.developmentScope.targetPaths.join('、')}
          <br />
          允许路径：{source.developmentScope.allowedPaths.join('、')}
          <br />
          验证命令：{source.developmentScope.verificationCommands?.join('；') || '无'}
        </p>
      )}
      <p>
        拟议预算：{input.maxCostMicros} 微美元；次数：{input.maxRuns}；返工：{input.maxRework}
        <br />
        期限：{new Date(input.expiresAt).toLocaleString()}；修订原因：{input.changeReason}
      </p>
      <p>预算不是实际预留，不承诺费用绝对硬封顶；资料清单不是执行侧工具许可。</p>
      <div role="status">
        <p>后续发行阻塞：</p>
        <ul>
          {source.blockers.map((v, i) => (
            <li key={`${i}-${v}`}>{v}</li>
          ))}
        </ul>
      </div>
      <details>
        <summary className="cursor-pointer text-xs">完整来源与配置摘要（无密钥）</summary>
        <pre className="max-h-72 overflow-auto whitespace-pre-wrap text-xs">
          {JSON.stringify({ source, input }, null, 2)}
        </pre>
      </details>
    </div>
  )
}
function SavedFacts({ record }: { record: OwnerExecutionPreparationRecord }): React.ReactElement {
  return (
    <details className="rounded-lg bg-muted/40 p-3">
      <summary className="cursor-pointer text-sm">
        准备 revision {record.revision} · policy revision {record.policyRevision} · 暂停
      </summary>
      <p className="mt-2 text-xs">
        {record.id} · {new Date(record.savedAt).toLocaleString()} · {record.actor}
        <br />
        完整性摘要：{record.integrityHash}
      </p>
      <PreparationFacts source={record.source} input={record.input} />
    </details>
  )
}
function PreviewFacts({
  preview,
}: {
  preview: OwnerExecutionPreparationPreview
}): React.ReactElement {
  return (
    <div className="rounded-lg bg-muted/40 p-3" aria-label="暂停执行准备预览">
      <h3 className="mb-2 font-medium">保存前核对全部事实</h3>
      <PreparationFacts source={preview} input={preview.input} />
      <p className="mt-2 text-xs">预览指纹：{preview.previewFingerprint}</p>
    </div>
  )
}
export function ProjectOwnerExecutionPreparationPanel({
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
        editor: getOwnerExecutionEditor(get(ownerExecutionEditorsAtom), subject),
        plan: getOwnerPlanEditor(get(ownerPlanEditorsAtom), subject).snapshot,
        ready: ownerExecutionPlanReady(get, subject),
        canPreview: canPreviewOwnerExecution(get, subject),
        canSave: canSaveOwnerExecution(get, subject),
      })),
    [subject],
  )
  const { editor: e, plan, ready, canPreview, canSave } = useAtomValue(derived)
  const load = useSetAtom(loadOwnerExecutionAtom)
  const edit = useSetAtom(editOwnerExecutionAtom)
  const compare = useSetAtom(compareOwnerExecutionAtom)
  const preview = useSetAtom(previewOwnerExecutionAtom)
  const save = useSetAtom(saveOwnerExecutionAtom)
  const history = useSetAtom(loadOwnerExecutionHistoryAtom)
  useEffect(() => {
    void load(subject)
  }, [load, subject])
  const id = useId()
  const choices = e.view?.choices
  const busy = e.loading || e.previewing || e.saving
  const patch = (value: OwnerExecutionEdit) => edit({ subject, patch: value })
  const toggle = (values: string[], value: string, checked: boolean) =>
    checked ? [...values, value] : values.filter((v) => v !== value)
  const textFields = [
    ['maxCostMicrosText', '拟议预算（微美元，正整数；1美元 = 1000000微美元）'],
    ['maxRunsText', '最大次数（正整数）'],
    ['maxReworkText', '最大返工次数（非负整数）'],
    ['expiresAtText', '到期时间（本地时间，必须未来）'],
    ['changeReason', '执行准备修订原因（必填）'],
  ] as const
  return (
    <section
      className="mt-4 min-w-0 rounded-xl bg-card p-4 shadow-sm [overflow-wrap:anywhere]"
      aria-label="Owner 暂停执行准备"
    >
      <h2 className="text-lg font-semibold">暂停执行准备</h2>
      <p className="mt-2 text-xs text-muted-foreground">
        只冻结候选范围，不会调用模型、收费、创建任务、派工或发行许可。预算不是实际预留；规划载体不是自动执行人员，模型来自所选人员的现有配置，不自动选择或修改。
      </p>
      {!ready && (
        <p className="mt-3 text-sm">
          仅已保存且已确认、来源未过期的计划可以预览。目标或计划有未保存编辑、冲突时，预览和保存均禁用。
        </p>
      )}
      <p className="mt-2 text-xs" role="status">
        {e.loading
          ? '正在读取准备来源'
          : `当前准备：${e.view?.status ?? '未加载'}；全项目 preparation revision ${e.view?.revision ?? '未知'}；policy revision ${e.view?.policyRevision ?? '无'}`}
      </p>
      {e.error && (
        <p role="alert" className="mt-2 text-sm text-destructive">
          {e.error}。输入保留，不会自动重试。
        </p>
      )}
      {e.requiresReview && (
        <div className="mt-3 rounded-md bg-muted p-3">
          <p className="text-sm">
            来源或准备版本需要比较。重新加载最新来源，核对可选人员、知识清单、版本及诊断；新增知识来源不会自动勾选。
          </p>
          <button
            type="button"
            className={`${button} mt-2`}
            disabled={!e.loaded || busy}
            onClick={() => compare(subject)}
          >
            已比较最新来源，保留输入
          </button>
        </div>
      )}
      <details className="mt-3">
        <summary className="cursor-pointer text-sm">当前可选来源与读取诊断</summary>
        <pre className="max-h-60 overflow-auto whitespace-pre-wrap text-xs">
          {JSON.stringify(e.view, null, 2)}
        </pre>
      </details>
      <form
        className="mt-3 space-y-3"
        onSubmit={(event) => {
          event.preventDefault()
          void preview(subject)
        }}
      >
        <fieldset
          className="max-h-[60vh] min-w-0 space-y-3 overflow-y-auto overscroll-contain pr-1"
          aria-label="暂停准备范围编辑"
        >
          <legend className="text-sm font-medium">执行准备候选范围</legend>
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">显式选择计划步骤（必须包含全部依赖）</legend>
            {plan?.proposal.steps.map((s) => (
              <label key={s.key} className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  className="mt-1 shrink-0"
                  checked={e.selectedStepKeys.includes(s.key)}
                  onChange={(v) =>
                    patch({ selectedStepKeys: toggle(e.selectedStepKeys, s.key, v.target.checked) })
                  }
                />
                <span>
                  {s.key} · {s.title}
                  <br />
                  成果：{s.outcome}
                  <br />
                  完成标准：{s.acceptanceCriteria.join('；')}
                  <br />
                  依赖：{s.dependencies.join('、') || '无'}；岗位建议：{s.roleKey}
                </span>
              </label>
            ))}
          </fieldset>
          <label className="block text-sm" htmlFor={`${id}-kind`}>
            执行模式
            <select
              id={`${id}-kind`}
              className={field}
              value={e.executionKind}
              onChange={(v) =>
                patch({
                  executionKind: v.target.value === 'development' ? 'development' : 'controlled',
                })
              }
            >
              <option value="controlled">受控非研发（允许非Git工作区准备）</option>
              <option value="development">研发（后台须核验Git）</option>
            </select>
          </label>
          {(['executorEmployeeId', 'reviewerEmployeeId'] as const).map((k) => (
            <label className="block text-sm" key={k} htmlFor={`${id}-${k}`}>
              {k === 'executorEmployeeId' ? '实际执行人员' : '实际评审人员'}
              <select
                id={`${id}-${k}`}
                className={field}
                value={e[k]}
                onChange={(v) => patch({ [k]: v.target.value })}
              >
                <option value="">先选择，不继承规划载体</option>
                {e[k] && !choices?.employees.some((v) => v.id === e[k]) && (
                  <option value={e[k]}>{e[k]}（当前不可用）</option>
                )}
                {choices?.employees.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name} · {v.executionProfile} · {v.channelId}/{v.modelId ?? '无模型'} ·{' '}
                    {v.runtime}
                  </option>
                ))}
              </select>
            </label>
          ))}
          <p className="text-xs text-muted-foreground">
            执行与评审必须是不同人员；两人模式、工作区、渠道、模型与Runtime必须一致，不会自动改配。
          </p>
          <label className="block text-sm" htmlFor={`${id}-workspace`}>
            明确工作区
            <select
              id={`${id}-workspace`}
              className={field}
              value={e.workspaceId}
              onChange={(v) => patch({ workspaceId: v.target.value })}
            >
              <option value="">先选择工作区</option>
              {e.workspaceId && !choices?.workspaces.some((v) => v.id === e.workspaceId) && (
                <option value={e.workspaceId}>{e.workspaceId}（当前不可用）</option>
              )}
              {choices?.workspaces.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}（{v.id}）
                </option>
              ))}
            </select>
          </label>
          {e.executionKind === 'development' &&
            (['targetPathsText', 'allowedPathsText', 'verificationCommandsText'] as const).map(
              (k) => (
                <label className="block text-sm" key={k} htmlFor={`${id}-${k}`}>
                  {k === 'targetPathsText'
                    ? '目标路径（每行一条，仓库相对路径）'
                    : k === 'allowedPathsText'
                      ? '允许路径（每行一条，须覆盖目标）'
                      : '验证命令（每行一条，仅候选，不执行）'}
                  <textarea
                    id={`${id}-${k}`}
                    className={field}
                    value={e[k]}
                    rows={2}
                    onChange={(v) => patch({ [k]: v.target.value })}
                  />
                </label>
              ),
            )}
          <fieldset className="space-y-1">
            <legend className="text-sm font-medium">显式知识来源（可全部不选）</legend>
            <p className="text-xs">
              {e.knowledgeSourceIds.length
                ? `已选 ${e.knowledgeSourceIds.length} 项；contentHash 未知`
                : 'none：明确无可选知识资料'}
            </p>
            {choices?.knowledgeSources.map((v) => (
              <label key={v.id} className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={e.knowledgeSourceIds.includes(v.id)}
                  onChange={(event) =>
                    patch({
                      knowledgeSourceIds: toggle(e.knowledgeSourceIds, v.id, event.target.checked),
                    })
                  }
                />
                <span>
                  {v.name}（{v.id}）
                </span>
              </label>
            ))}
            {e.knowledgeSourceIds
              .filter((v) => !choices?.knowledgeSources.some((s) => s.id === v))
              .map((v) => (
                <label key={v} className="flex gap-2 text-sm text-destructive">
                  <input
                    type="checkbox"
                    checked
                    onChange={() =>
                      patch({ knowledgeSourceIds: e.knowledgeSourceIds.filter((s) => s !== v) })
                    }
                  />
                  {v}（已不可用，请比较并移除）
                </label>
              ))}
          </fieldset>
          {textFields.map(([k, label]) => (
            <label key={k} className="block text-sm" htmlFor={`${id}-${k}`}>
              {label}
              <input
                id={`${id}-${k}`}
                className={field}
                type={k === 'expiresAtText' ? 'datetime-local' : 'text'}
                inputMode={k.startsWith('max') ? 'numeric' : undefined}
                value={e[k]}
                onChange={(v) => patch({ [k]: v.target.value })}
              />
            </label>
          ))}
        </fieldset>
        <div className="flex flex-wrap gap-2">
          <button type="submit" className={button} disabled={!canPreview}>
            {e.previewing ? '正在只读预览…' : '只读预览执行准备'}
          </button>
          <button
            type="button"
            className={button}
            disabled={!canSave}
            onClick={() => void save(subject)}
          >
            {e.saving ? '正在保存暂停准备…' : '保存暂停执行准备'}
          </button>
        </div>
        <p className="text-xs text-muted-foreground">
          编辑后旧预览立即失效；保存只产生暂停准备。相同请求进行中不能重复提交，冲突必须重新加载、比较并预览。
        </p>
      </form>
      {e.preview && (
        <section className="mt-3 max-h-[60vh] overflow-y-auto" aria-label="执行准备冻结预览区域">
          <PreviewFacts preview={e.preview} />
          {!canSave && <p className="text-sm">当前来源或输入已变化，此预览不能保存。</p>}
        </section>
      )}
      {e.view?.preparation && (
        <div className="mt-3">
          <p className="mb-2 text-xs">已登记快照（以当前状态为准；不是许可）：</p>
          <SavedFacts record={e.view.preparation} />
        </div>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" className={button} disabled={busy} onClick={() => void load(subject)}>
          重新读取准备来源（保留输入）
        </button>
        <button
          type="button"
          className={button}
          disabled={e.historyLoading}
          onClick={() => void history(subject)}
        >
          查看暂停准备历史
        </button>
      </div>
      {e.historyError && (
        <p role="alert" className="mt-2 text-sm text-destructive">
          历史：{e.historyError}
        </p>
      )}
      {e.historyLoaded && (
        <section className="mt-3 max-h-[40vh] space-y-2 overflow-y-auto" aria-label="暂停准备历史">
          <p className="text-xs">历史只读，不可恢复，不代表当前来源有效。</p>
          {e.history.map((r) => (
            <SavedFacts key={r.id} record={r} />
          ))}
          {!e.history.length && <p className="text-sm">暂无历史</p>}
        </section>
      )}
      <ProjectOwnerTaskMaterializationPanel projectId={projectId} taskId={taskId} />
      <ProjectOwnerRevalidationPanel projectId={projectId} taskId={taskId} />
    </section>
  )
}

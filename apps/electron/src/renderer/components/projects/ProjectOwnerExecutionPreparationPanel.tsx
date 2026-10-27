import { ownerExecutionModelSummary } from '@gravitas/shared'
import { supportsOwnerExecutionKind } from '@gravitas/shared'
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
import { ProjectOwnerExecutionGrantPanel } from './ProjectOwnerExecutionGrantPanel'
import { recommendOwnerStepTools } from './project-owner-tool-recommendations'
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
            <p>工具/Skill候选：{source.toolRecommendations?.find((item) => item.stepKey === s.key)?.candidates.map((candidate) => `${candidate.label}（${candidate.reason}）`).join('；') || '无明确词面匹配'}</p>
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
        {source.roleAssignments?.length
          ? <>逐步执行人员：{source.roleAssignments.map((item) => `${item.roleKey} → ${item.employee.name}（${item.employee.id}）`).join('；')}</>
          : <>实际执行人员：{source.executor.name}（{source.executor.id}）</>}
        <br />实际评审人员：{source.reviewer.name}（{source.reviewer.id}）
      </p>
      <p>
        模式：{input.executionKind}；工作区：{source.workspaceName}（{source.workspaceId}）<br />
        渠道：{source.channelId}；模型：{ownerExecutionModelSummary(source)}；Runtime：{source.runtime}
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
        项目共享总额：{input.maxCostMicros} 微美元；次数：{input.maxRuns}；返工：{input.maxRework}
        <br />
        岗位上限：{input.roleBudgetCaps?.length ? input.roleBudgetCaps.map((cap) => `${cap.roleKey} ≤ ${cap.maxCostMicros} 微美元`).join('；') : '未配置，所有岗位仅受共享总额限制'}
        <br />
        期限：{new Date(input.expiresAt).toLocaleString()}；修订原因：{input.changeReason}
      </p>
      {input.roleBudgetCaps?.length ? <p className="text-xs text-muted-foreground">岗位上限按所属任务归集，Executor 与 Reviewer 费用都计入该任务岗位。任意岗位上限都不能扩大项目共享总额；unknown 仍按预留额占用。</p> : null}
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
export function SavedFacts({ record }: { record: OwnerExecutionPreparationRecord }): React.ReactElement {
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
export function PreviewFacts({
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
  showDownstream = true,
}: {
  projectId: string
  taskId?: string
  showDownstream?: boolean
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
  const selectedRoleKeys = [...new Set((plan?.proposal.steps ?? []).filter((step) => e.selectedStepKeys.includes(step.key)).map((step) => step.roleKey))].sort()
  const recommendedWorkspaceId = e.workspaceId || e.view?.workspaceRecommendation.workspaceId || ''
  const workspaceRecommendationSource = e.view?.workspaceRecommendation.source
  const workspaceSelectionPending = workspaceRecommendationSource === 'ambiguous' && !recommendedWorkspaceId
  const workspaceBindingUnavailable = workspaceRecommendationSource === 'owner_binding_unavailable'
  const noProjectWorkspace = workspaceRecommendationSource === 'none'
  const selectedExecutionEmployees = selectedRoleKeys.flatMap((roleKey) => {
    const employeeId = e.roleAssignments[roleKey] || (selectedRoleKeys.length === 1 ? e.executorEmployeeId : '')
    const employee = choices?.employees.find((candidate) => candidate.id === employeeId)
    return employee ? [{ roleKey, employee }] : []
  })
  const selectedReviewer = choices?.employees.find((employee) => employee.id === e.reviewerEmployeeId)
  const configuredEmployees = [
    ...selectedExecutionEmployees.map(({ roleKey, employee }) => ({ label: `roleKey ${roleKey} · ${employee.name}`, employee })),
    ...(selectedReviewer ? [{ label: `Reviewer · ${selectedReviewer.name}`, employee: selectedReviewer }] : []),
  ]
  const distinctConfigurationCount = new Set(configuredEmployees.map(({ employee }) =>
    JSON.stringify([employee.channelId, employee.modelId ?? '', employee.runtime]),
  )).size
  const hasConfigurationConflict = configuredEmployees.length > 1 && distinctConfigurationCount > 1
  const roleCandidates = () => choices?.employees.filter((employee) => supportsOwnerExecutionKind(employee, e.executionKind)
    && employee.workspaceIds.includes(recommendedWorkspaceId)
    && (!e.reviewerEmployeeId || employee.id !== e.reviewerEmployeeId)) ?? []
  const recommendedEmployee = (roleKey: string) => {
    const exactMatches = roleCandidates().filter((employee) => !employee.isOwnerCarrier && employee.roleTemplateId === roleKey)
    return exactMatches.length === 1 ? exactMatches[0] : undefined
  }
  const busy = e.loading || e.previewing || e.saving
  const toolRecommendations = recommendOwnerStepTools(
    plan?.proposal.steps ?? [],
    recommendedWorkspaceId,
    choices?.workspaceCapabilities ?? [],
  )
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
      {hasConfigurationConflict && (
        <div role="alert" className="mt-2 rounded-md bg-destructive/10 p-3 text-sm">
          <p>执行岗位与 Reviewer 的渠道、模型或 Runtime 来源冲突。请逐项选择配置一致的员工；系统不会从 Owner carrier、全局默认或最近使用值替你覆盖。</p>
          <ul className="mt-1 text-xs">
            {configuredEmployees.map(({ label, employee }) => (
              <li key={`${label}-${employee.id}`}>{label}：{employee.channelId} / {employee.modelId ?? '无模型'} / {employee.runtime}</li>
            ))}
          </ul>
        </div>
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
                  <br />
                  工具/Skill候选：{toolRecommendations.find((item) => item.stepKey === s.key)?.candidates.length
                    ? toolRecommendations.find((item) => item.stepKey === s.key)!.candidates.map((candidate) => `${candidate.label}（${candidate.reason}）`).join('；')
                    : '无明确词面匹配'}
                </span>
              </label>
            ))}
            <p className="text-xs text-muted-foreground">候选仅根据步骤文本与所选项目工作区的 Skill/MCP 名称、说明做词面匹配，可能不完整或不相关；无匹配时不猜测。展示候选不会启用工具、开放资料或形成执行授权，实际调用仍受现有逐请求权限门禁控制。</p>
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
          {selectedRoleKeys.map((roleKey) => {
            const candidates = roleCandidates()
            const recommendation = recommendedEmployee(roleKey)
            const value = e.roleAssignments[roleKey] || (selectedRoleKeys.length === 1 ? e.executorEmployeeId : recommendation?.id ?? '')
            const exactMatchCount = candidates.filter((employee) => !employee.isOwnerCarrier && employee.roleTemplateId === roleKey).length
            const carrierExactMatch = candidates.some((employee) => employee.isOwnerCarrier && employee.roleTemplateId === roleKey)
            return (
              <label className="block text-sm" key={roleKey} htmlFor={`${id}-role-${roleKey}`}>
                实际执行人员 · roleKey {roleKey}
                <select
                  id={`${id}-role-${roleKey}`}
                  className={field}
                  value={value}
                  onChange={(event) => patch({
                    roleAssignments: { ...e.roleAssignments, [roleKey]: event.target.value },
                    ...(roleKey === selectedRoleKeys[0] ? { executorEmployeeId: event.target.value } : {}),
                  })}
                >
                  <option value="">{workspaceSelectionPending ? '先在下方明确选择项目工作区' : workspaceBindingUnavailable ? 'Owner绑定失效；先修复绑定或明确核对工作区' : noProjectWorkspace ? '当前项目没有绑定工作区' : candidates.length === 0 ? '没有当前可执行的项目员工；检查渠道、模型与工作区配置' : exactMatchCount > 1 ? `有 ${exactMatchCount} 个精确模板匹配，必须明确选择` : carrierExactMatch ? '唯一精确匹配是 Owner 规划载体；请明确选择' : '没有唯一模板匹配，请明确选择'}</option>
                  {candidates.map((employee) => (
                    <option key={employee.id} value={employee.id}>
                      {employee.name} · {employee.executionProfile} · {employee.channelId}/{employee.modelId ?? '无模型'} · {employee.runtime}{employee.roleTemplateId === roleKey ? ' · 精确模板匹配' : ''}{employee.isOwnerCarrier ? ' · Owner规划载体（不自动推荐）' : ''}
                    </option>
                  ))}
                </select>
                <span className="text-xs text-muted-foreground">
                  {workspaceSelectionPending ? '当前项目有多个绑定工作区；先在下方明确选择，随后再筛选匹配员工。' : workspaceBindingUnavailable ? 'Owner绑定工作区或载体配置已失效；请先核查绑定，员工列表不会按其他工作区静默回退。' : noProjectWorkspace ? '当前项目没有可用绑定工作区，需先建立项目工作区绑定。' : candidates.length === 0 ? '当前项目没有配置有效且工作区匹配的员工。启用渠道、模型并修复员工工作区配置后，重新读取来源。' : recommendation ? `唯一精确模板匹配推荐：${recommendation.name}；你仍需核对并可更换。` : exactMatchCount > 1 ? '匹配冲突：不得自动挑选，请明确选择。' : carrierExactMatch ? '精确模板仅匹配 Owner 规划载体；不会自动推荐。你仍可显式选择并接受服务端配置核验，或选择其他员工。' : '没有稳定模板匹配；请显式选择员工，不按显示名猜测。'}
                </span>
              </label>
            )
          })}
          <label className="block text-sm" htmlFor={`${id}-reviewerEmployeeId`}>
            独立技术评审人员
            <select
              id={`${id}-reviewerEmployeeId`}
              className={field}
              value={e.reviewerEmployeeId}
              onChange={(event) => patch({ reviewerEmployeeId: event.target.value })}
            >
              <option value="">先选择评审员工</option>
              {choices?.employees.filter((employee) => supportsOwnerExecutionKind(employee, e.executionKind)
                && employee.workspaceIds.includes(recommendedWorkspaceId)
                && !Object.values(e.roleAssignments).includes(employee.id)).map((employee) => (
                  <option key={employee.id} value={employee.id}>
                    {employee.name} · {employee.executionProfile} · {employee.channelId}/{employee.modelId ?? '无模型'} · {employee.runtime}{employee.isOwnerCarrier ? ' · Owner规划载体（仅显式选择）' : ''}
                  </option>
                ))}
            </select>
          </label>
          <p className="text-xs text-muted-foreground">
            来源规则：Owner绑定的有效工作区优先作为显式核对建议；否则仅当当前项目唯一绑定时才推荐。手工编辑仅按唯一 roleTemplateId 预填；Owner自动安排会结合员工岗位、描述和技能提出分工。普通员工只有通过受控适配检查才会出现，本次调用收紧权限，不修改员工档案。Owner规划载体只作规划来源，不会自动推荐为执行员工；若你显式选择它，仍按其员工配置重新核验。全局默认与最近使用值不参与回退。渠道、模型和 Runtime 来自你选定的员工现有配置；与Owner绑定默认值冲突时必须确认覆盖，员工间不一致仍由服务端阻止。此处预填不修改员工配置，也不构成授权。
          </p>
          <label className="block text-sm" htmlFor={`${id}-workspace`}>
            明确工作区
            <select
              id={`${id}-workspace`}
              className={field}
              value={recommendedWorkspaceId}
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
          <p className="text-xs text-muted-foreground">
            {e.view?.workspaceRecommendation.source === 'owner_binding' ? '按有效Owner绑定工作区推荐；如改选其他项目工作区，需单独确认。'
              : e.view?.workspaceRecommendation.source === 'owner_binding_unavailable' ? 'Owner绑定工作区或载体配置已失效，须重新核查Owner绑定；不会静默改用其他工作区。'
                : e.view?.workspaceRecommendation.source === 'unique_project_workspace' ? '当前项目唯一显式绑定工作区推荐；仍须在预览中核对。'
                  : e.view?.workspaceRecommendation.source === 'ambiguous' ? '当前项目有多个绑定工作区，必须明确选择；不取全局默认或首项。'
                    : '当前项目没有可用绑定工作区，准备阻塞。'}
          </p>
          {e.view?.workspaceRecommendation.source === 'owner_binding' && recommendedWorkspaceId !== e.view.workspaceRecommendation.workspaceId && <label className="flex items-start gap-2 rounded-lg bg-amber-500/10 p-3 text-sm">
            <input type="checkbox" checked={e.acknowledgeOwnerWorkspaceOverride} onChange={(event) => patch({ acknowledgeOwnerWorkspaceOverride: event.target.checked })} />
            <span>我已核对手动选择的项目工作区与Owner绑定默认工作区不同，确认按此工作区继续准备。此确认会写入冻结预览与保存记录；改变工作区、岗位或计划步骤后需重新确认。</span>
          </label>}
          {e.view?.executionConfigurationRecommendation && <p className="text-xs text-muted-foreground">
            Owner绑定默认配置建议：{e.view.executionConfigurationRecommendation.channelId} / {e.view.executionConfigurationRecommendation.modelId} / {e.view.executionConfigurationRecommendation.runtime}。仅用于核对，不修改员工配置；所有执行人员与Reviewer最终仍须使用相同配置。
          </p>}
          {e.view?.executionConfigurationRecommendationState === 'stale' && <p className="text-xs text-destructive">
            Owner载体配置已不同于绑定时快照，已撤销默认配置建议。请重新核查并更新Owner绑定；绑定恢复有效前，准备服务会阻止预览。
          </p>}
          {e.view?.executionConfigurationRecommendation && (() => {
            const recommendation = e.view.executionConfigurationRecommendation!
            const selectedIds = [...new Set([...selectedRoleKeys.map((roleKey) => e.roleAssignments[roleKey]).filter(Boolean), e.reviewerEmployeeId])]
            const selectedEmployees = selectedIds.map((employeeId) => choices?.employees.find((employee) => employee.id === employeeId)).filter(Boolean)
            const conflict = selectedEmployees.some((employee) => employee!.channelId !== recommendation.channelId || employee!.modelId !== recommendation.modelId || employee!.runtime !== recommendation.runtime)
            return conflict ? <label className="flex items-start gap-2 rounded-lg bg-amber-500/10 p-3 text-sm">
              <input type="checkbox" checked={e.acknowledgeOwnerConfigurationOverride} onChange={(event) => patch({ acknowledgeOwnerConfigurationOverride: event.target.checked })} />
              <span>我已核对执行/评审配置与Owner绑定默认配置不同，确认按当前手动选择继续准备。此确认写入冻结预览与保存记录；修改人员、步骤或来源后需重新确认。</span>
            </label> : null
          })()}
          {e.executionKind === 'development' &&
            <details className="rounded-lg bg-muted/50 p-3">
              <summary className="cursor-pointer text-sm font-medium">代码范围与验证建议（Owner 已填写，可调整）</summary>
              <div className="mt-2 space-y-2">
                {([['targetPathsText', '本次目标路径（每行一条）'], ['allowedPathsText', '允许修改的路径（每行一条）'], ['verificationCommandsText', '建议验证命令（每行一条；尚未执行）']] as const).map(([k, label]) => (
                  <label className="block text-sm" key={k} htmlFor={`${id}-${k}`}>
                    {label}
                    <textarea id={`${id}-${k}`} className={field} value={e[k]} rows={2} onChange={(v) => patch({ [k]: v.target.value })} />
                  </label>
                ))}
              </div>
            </details>}
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
          <fieldset className="space-y-2 rounded-lg bg-background/60 p-3" aria-label="可选岗位预算上限">
            <legend className="text-sm font-medium">岗位费用上限（可选）</legend>
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" checked={e.roleBudgetCapsEnabled} onChange={(event) => patch({ roleBudgetCapsEnabled: event.target.checked })} />
              <span>启用按岗位设置上限</span>
            </label>
            {e.roleBudgetCapsEnabled && <>
              <p className="text-xs text-muted-foreground">每个上限都受项目共享总额约束。未填写的岗位只受共享总额限制；费用未知时仍保留该岗位的预留占额。</p>
              {selectedRoleKeys.map((roleKey) => <label className="block text-sm" key={roleKey} htmlFor={`${id}-role-budget-${roleKey}`}>
                {plan?.sources.roles.find((role) => role.key === roleKey)?.name ?? roleKey} · {roleKey} 上限（微美元，可留空）
                <input id={`${id}-role-budget-${roleKey}`} className={field} type="text" inputMode="numeric" value={e.roleBudgetCapTexts[roleKey] ?? ''}
                  onChange={(event) => patch({ roleBudgetCapTexts: { ...e.roleBudgetCapTexts, [roleKey]: event.target.value } })} />
              </label>)}
              <p className="text-xs text-muted-foreground">岗位上限覆盖该岗位任务的 Executor 与 Reviewer 两类调用；Reviewer 费用计入被评审任务的岗位。</p>
            </>}
          </fieldset>
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
      {showDownstream && <>
        <ProjectOwnerTaskMaterializationPanel projectId={projectId} taskId={taskId} />
        <ProjectOwnerRevalidationPanel projectId={projectId} taskId={taskId} />
        <ProjectOwnerExecutionGrantPanel projectId={projectId} taskId={taskId} />
      </>}
    </section>
  )
}

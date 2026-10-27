import { ownerExecutionModelSummary } from '@gravitas/shared'
/** Owner执行授权面板：对话模式由主进程原生范围确认承载实际授权；管理模式保留发行/撤权账本。
 * 硬约束：来源须由主进程重验，用户拒绝时不得发行授权或启动调度；active期间重验证被阻断属预期。 */
import { useEffect, useMemo } from 'react'
import { atom, useAtom, useAtomValue, useSetAtom } from 'jotai'
import type {
  OwnerExecutionGrant,
  OwnerExecutionGrantIssuePreview,
  OwnerExecutionGrantRevokePreview,
  OwnerExecutionDispatchMode,
} from '@gravitas/shared'
import {
  confirmOwnerGrantIssueAtom,
  getOwnerGrantEditor,
  loadOwnerGrantAtom,
  loadOwnerGrantHistoryAtom,
  ownerGrantEditorsAtom,
  previewOwnerGrantIssueAtom,
  previewOwnerGrantRevokeAtom,
  confirmOwnerGrantRevokeAtom,
  type OwnerGrantEditor,
  type OwnerGrantIssueInput,
} from '../../atoms/project-owner-execution-grant-atoms'
import {
  getOwnerRevalidationEditor,
  ownerRevalidationEditorsAtom,
} from '../../atoms/project-owner-execution-revalidation-atoms'
import {
  getOwnerExecutionEditor,
  ownerExecutionEditorsAtom,
} from '../../atoms/project-owner-execution-atoms'
import { ProjectOwnerExecutionCommandPanel } from './ProjectOwnerExecutionCommandPanel'
const button = 'rounded-md bg-muted px-3 py-2 text-sm disabled:opacity-50'
function GrantFacts({ grant }: { grant: OwnerExecutionGrant }): React.ReactElement {
  return (
    <div className="min-w-0 space-y-2 rounded-lg bg-muted/40 p-3 text-sm [overflow-wrap:anywhere]">
      <p className="font-medium">
        账本行 {grant.grantId} · 状态 {grant.state} · 派发模式 {grant.dispatchMode === 'autonomous' ? '自主调度' : '人工逐条确认'} · 发行于 {new Date(grant.issuedAt).toLocaleString()}
      </p>
      <p className="text-xs">
        上游双三元组（冻结引用，不回写）：
        <br />
        重验证 {grant.revalidationId} · revision {grant.revalidationRevision} · hash{' '}
        {grant.revalidationIntegrityHash}
        <br />
        材料化 {grant.materializationId} · revision {grant.materializationRevision} · hash{' '}
        {grant.materializationIntegrityHash}
      </p>
      <p>
        预算（期限原样冻结，不顺延）：{grant.budget.maxCostMicros} 微美元 · 最大次数{' '}
        {grant.budget.maxRuns} · 最大返工 {grant.budget.maxRework} · 期限{' '}
        {new Date(grant.budget.expiresAt).toLocaleString()}
      </p>
      <p className="text-xs">岗位上限：{grant.budget.roleBudgetCaps?.length ? grant.budget.roleBudgetCaps.map((cap) => `${cap.roleKey} ≤ ${cap.maxCostMicros} 微美元`).join('；') : '未配置（岗位费用仅受共享总额限制）'}。Executor 与 Reviewer 都计入任务所属岗位；unknown 按预留额占用。</p>
      {grant.roleAssignments?.length ? <p className="text-xs">按岗位执行：{grant.roleAssignments.map((item) => `${item.roleKey} → ${item.employeeName} (${item.employeeId})`).join('；')}</p> : null}
      <p className="text-xs">
        绑定：主要执行员工 {grant.executorEmployeeId} · 评审 {grant.reviewerEmployeeId} · 工作区{' '}
        {grant.workspaceId} · 渠道 {grant.channelId} · 模型 {ownerExecutionModelSummary(grant)} · Runtime{' '}
        {grant.runtime} · policy revision {grant.policyRevision}
      </p>
      <p className="text-xs">发行指纹：{grant.approvalFingerprint}</p>
    </div>
  )
}
function IssueFacts({ preview }: { preview: OwnerExecutionGrantIssuePreview }): React.ReactElement {
  return (
    <section
      className="mt-3 max-h-[60vh] min-w-0 overflow-y-auto rounded-lg bg-muted/40 p-3 [overflow-wrap:anywhere]"
      aria-label="发行影响面预览区域"
    >
      <p className="mb-2 font-medium">发行影响面核对（只读预览，未落库）</p>
      <p className="text-xs">
        上游双三元组：
        <br />
        重验证 {preview.revalidationId} · revision {preview.revalidationRevision} · hash{' '}
        {preview.revalidationIntegrityHash}
        <br />
        材料化 {preview.materializationId} · revision {preview.materializationRevision} · hash{' '}
        {preview.materializationIntegrityHash}
      </p>
      {preview.roleAssignments?.length ? <p className="text-xs">按岗位执行映射：{preview.roleAssignments.map((item) => `${item.roleKey} → ${item.employeeName} (${item.employeeId})`).join('；')}</p> : null}
      <p>
        预算（期限原样冻结，不顺延）：{preview.budget.maxCostMicros} 微美元 · 最大次数{' '}
        {preview.budget.maxRuns} · 最大返工 {preview.budget.maxRework} · 期限{' '}
        {new Date(preview.budget.expiresAt).toLocaleString()}
      </p>
      <p className="text-xs">岗位上限：{preview.budget.roleBudgetCaps?.length ? preview.budget.roleBudgetCaps.map((cap) => `${cap.roleKey} ≤ ${cap.maxCostMicros} 微美元`).join('；') : '未配置（岗位费用仅受共享总额限制）'}。岗位cap只收紧额度；Executor 与 Reviewer 都计入该任务的岗位。</p>
      <p>派发模式：{preview.dispatchMode === 'autonomous' ? '自主调度（主进程原生确认后，在冻结范围/额度内后台推进）' : '人工逐条确认'}</p>
      {preview.dispatchMode === 'autonomous' && <p className="text-xs">本地预算台账不是 Provider 端硬性费用上限；费用或停止状态未知时暂停并保留占额。</p>}
      <p className="text-xs">发行指纹：{preview.approvalFingerprint}</p>
      <div role="status">
        <p>发行blockers（空=可确认）：</p>
        {preview.blockers.length ? (
          <ul>
            {preview.blockers.map((v, i) => (
              <li key={`${i}-${v}`}>{v}</li>
            ))}
          </ul>
        ) : (
          <p className="text-xs">无（blockers为空才可确认发行）</p>
        )}
      </div>
    </section>
  )
}
function RevokeFacts({
  revokePreview,
}: {
  revokePreview: OwnerExecutionGrantRevokePreview
}): React.ReactElement {
  return (
    <section
      className="mt-3 min-w-0 rounded-lg bg-muted/40 p-3 [overflow-wrap:anywhere]"
      aria-label="撤权影响面预览区域"
    >
      <p className="mb-2 font-medium">撤权影响面核对（只读预览，未落库）</p>
      <p className="text-xs">
        授权 {revokePreview.grantId} · 影响面：命令 {revokePreview.impact.commandCount} 条 · 运行中{' '}
        {revokePreview.impact.runningCount} 条 · 未决请求占额 {revokePreview.impact.pendingRequestCount} 条
      </p>
      <p className="text-xs">撤权指纹：{revokePreview.fingerprint}</p>
      {revokePreview.blockers.length ? (
        <ul role="alert">
          {revokePreview.blockers.map((v, i) => (
            <li key={`${i}-${v}`}>{v}</li>
          ))}
        </ul>
      ) : null}
    </section>
  )
}
export function ProjectOwnerExecutionGrantPanel({
  projectId,
  taskId,
  conversational = false,
}: {
  projectId: string
  taskId?: string
  conversational?: boolean
}): React.ReactElement {
  const subject = useMemo(
    () => ({ projectId, ...(taskId === undefined ? {} : { taskId }) }),
    [projectId, taskId],
  )
  const derived = useMemo(
    () =>
      atom((get) => {
        const editor: OwnerGrantEditor = getOwnerGrantEditor(get(ownerGrantEditorsAtom), subject)
        const revalidation = getOwnerRevalidationEditor(get(ownerRevalidationEditorsAtom), subject)
        const preparation = getOwnerExecutionEditor(get(ownerExecutionEditorsAtom), subject)
        const activeGrant = editor.grant?.state === 'active' ? editor.grant : null
        const revalidationCurrent = Boolean(
          revalidation.loaded && !revalidation.loading && !revalidation.saving && !revalidation.requiresReview
            && preparation.loaded && !preparation.loading && !preparation.saving && !preparation.dirty &&
            revalidation.view?.status === 'current' &&
            revalidation.view.revalidation,
        )
        const policyRevision = preparation.view?.policyRevision ?? null
        const canPreviewIssue = Boolean(
          revalidationCurrent &&
            (!editor.grant || editor.grant.state === 'paused') &&
            policyRevision !== null &&
            revalidation.view?.revision !== null &&
            revalidation.view?.revision !== undefined &&
            !editor.previewing &&
            !editor.confirming &&
            !editor.revoking,
        )
        return {
          editor,
          activeGrant,
          canPreviewIssue,
          policyRevision,
          revalidationRevision: revalidation.view?.revision ?? null,
          revalidationRecord: revalidation.view?.status === 'current' || activeGrant && revalidation.view?.revalidation?.id === activeGrant.revalidationId
            && revalidation.view.revalidation.integrityHash === activeGrant.revalidationIntegrityHash
            ? revalidation.view?.revalidation ?? null : null,
        }
      }),
    [subject],
  )
  const { editor: e, activeGrant, canPreviewIssue, policyRevision, revalidationRevision, revalidationRecord } = useAtomValue(derived)
  const load = useSetAtom(loadOwnerGrantAtom)
  const history = useSetAtom(loadOwnerGrantHistoryAtom)
  const previewIssue = useSetAtom(previewOwnerGrantIssueAtom)
  const confirmIssue = useSetAtom(confirmOwnerGrantIssueAtom)
  const previewRevoke = useSetAtom(previewOwnerGrantRevokeAtom)
  const confirmRevoke = useSetAtom(confirmOwnerGrantRevokeAtom)
  // 发行输入随每次预览重新生成requestId；确认必须复用产生当前预览的同一输入。
  // biome-ignore lint/correctness/useExhaustiveDependencies: 主体或上游冻结版本变化时清除旧发行输入和选择。
  const fields = useMemo(() => ({ input: atom<OwnerGrantIssueInput | null>(null), mode: atom<OwnerExecutionDispatchMode>(conversational ? 'autonomous' : 'manual') }), [conversational, projectId, taskId, revalidationRecord?.id, policyRevision])
  const [issueInput, setIssueInput] = useAtom(fields.input)
  const [dispatchMode, setDispatchMode] = useAtom(fields.mode)
  const effectiveDispatchMode = conversational ? 'autonomous' : dispatchMode
  const busy = e.loading || e.previewing || e.confirming || e.revoking
  useEffect(() => {
    void load(subject)
    if (!conversational) void history(subject)
  }, [load, history, subject, conversational])
  useEffect(() => {
    if (!conversational && !e.historyLoaded && !e.historyLoading && !e.historyError && !e.confirming && !e.revoking)
      void history(subject)
  }, [conversational, e.historyLoaded, e.historyLoading, e.historyError, e.confirming, e.revoking, history, subject])
  const onPreviewIssue = () => {
    if (!canPreviewIssue || revalidationRevision === null || policyRevision === null) return
    const input: OwnerGrantIssueInput = {
      requestId: crypto.randomUUID(),
      expectedRevalidationRevision: revalidationRevision,
      expectedPolicyRevision: policyRevision,
      dispatchMode: effectiveDispatchMode,
    }
    setIssueInput(input)
    void previewIssue({ subject, input })
  }
  return (
    <section
      className="mt-4 min-w-0 max-w-full rounded-xl bg-card p-3 shadow-sm [overflow-wrap:anywhere] sm:p-4"
      aria-label={conversational ? 'Owner 项目进度' : 'Owner 执行授权账本'}
    >
      <h3 className="font-semibold">{conversational ? (activeGrant ? '项目进度' : '确认本次执行范围') : '执行授权账本（发行与撤权）'}</h3>
      <p className="mt-2 text-xs text-muted-foreground">
        {conversational ? '确认后，Owner 会在本次目标、资料权限和预算范围内组织团队、检查成果并继续推进；遇到超范围事项、业务取舍或状态未知时会停下与你商量。项目共享预算不是 Provider 最终账单的硬上限。' : '账本记录"允许按账本消费"的静态许可。人工模式仍逐条确认费用和启动；自主模式必须经过 Electron 主进程原生确认框，确认后在冻结任务/角色/预算范围内后台派发。授权不会自动重试或扩大范围；本地预算不是 Provider 端硬性费用上限。活动授权期间重验证被阻断属预期，退出路径是撤权。'}
      </p>
      <p role="status" className="mt-2 text-sm">
        {e.loading
          ? conversational ? '正在读取项目进度' : '正在读取授权账本'
          : conversational
            ? e.grant?.state === 'active' ? 'Owner 已开始按确认范围推进' : e.grant?.state === 'needs_reconcile' ? 'Owner 正在核对执行状态，确认安全后会继续' : e.grant?.state === 'archived' ? '本次执行授权已结束' : '等待最终执行确认'
            : `当前账本：${e.grant ? `${e.grant.state}（${e.grant.grantId}）` : '无授权行'}`}
      </p>
      {e.error && (
        <p role="alert" className="mt-2 text-sm text-destructive">
          {e.error}。不会自动重试，请核对后重试。
        </p>
      )}
      {e.grant && (conversational ? <div className="mt-3 space-y-2 rounded-xl bg-primary/10 p-4 text-sm"><p>{e.grant.state === 'active' ? 'Owner 会在本次确认的目标、资料权限和预算范围内自主组织团队、检查成果并推进授权内返工。' : `执行进度：${e.grant.state === 'needs_reconcile' ? '正在核对，暂不重试' : e.grant.state === 'archived' ? '已结束' : '已暂停'}`}</p><p>项目共享预算上限：{e.grant.budget.maxCostMicros / 1000000} 美元 · 有效期至 {new Date(e.grant.budget.expiresAt).toLocaleString()}</p></div> : <div className="mt-3 min-w-0"><GrantFacts grant={e.grant} /></div>)}
      {!conversational && e.grant && e.grant.state !== 'active' && e.grant.state !== 'paused' && <p role="status" className="mt-2 text-sm">当前授权{e.grant.state === 'needs_reconcile' ? '需要对账' : '已归档'}；不能发行新授权，请按运行处理建议核查。</p>}
      {activeGrant && !conversational && (
        <p className="mt-2 text-xs text-muted-foreground">
          活动授权存在：新发行被阻断（同源重放除外）、重验证被阻断均属预期；如需修订事实请先撤权。
        </p>
      )}
      {!conversational && <label className="mt-3 flex flex-wrap items-center gap-2 text-sm">
        派发模式
        <select className="rounded-md bg-background px-2 py-1" value={dispatchMode} disabled={busy || Boolean(e.preview)} onChange={(event) => setDispatchMode(event.target.value as OwnerExecutionDispatchMode)}>
          <option value="manual">人工逐条确认（默认）</option>
          <option value="autonomous">自主调度（需主进程原生确认）</option>
        </select>
      </label>}
      {effectiveDispatchMode === 'autonomous' && !conversational && <p className="mt-2 text-xs text-destructive">启用后会在额度和冻结范围内后台自动派发，不逐条等待点击；本地费用台账不保证 Provider 最终账单绝不超额。</p>}
      <div className="mt-3 flex flex-wrap gap-2">
        {(!conversational || !activeGrant) && <><button
          type="button"
          className={button}
          disabled={!canPreviewIssue}
          onClick={onPreviewIssue}
        >
          {e.previewing ? '正在核对授权范围…' : conversational ? '查看本次执行授权摘要' : '预览发行影响面'}
        </button>
        <button
          type="button"
          className={button}
          disabled={
            !canPreviewIssue || busy || !e.preview ||
            e.preview.blockers.length > 0 ||
            e.confirming ||
            !issueInput ||
            issueInput.expectedRevalidationRevision !== e.preview.revalidationRevision
          }
          onClick={() =>
            e.preview &&
            issueInput &&
            void confirmIssue({
              subject,
              input: issueInput,
              confirmedFingerprint: e.preview.approvalFingerprint,
            }).then(() => {
              void load(subject)
              void history(subject)
            })
          }
        >
        {e.confirming ? conversational ? '正在打开系统确认…' : '正在确认发行…' : effectiveDispatchMode === 'autonomous' ? conversational ? '继续到系统开始确认' : '请求原生确认并启用自主调度' : '确认发行'}
        </button>
        </>}
        {activeGrant && (
          <button
            type="button"
            className={button}
            disabled={busy}
            onClick={() =>
              void previewRevoke({ subject, grantId: activeGrant.grantId })
            }
          >
            {e.revoking ? '正在预览撤权影响面…' : '预览撤权影响面'}
          </button>
        )}
        {activeGrant && e.revokePreview && (
          <button
            type="button"
            className={button}
            disabled={e.revoking || e.revokePreview.fingerprint === '' || e.revokePreview.blockers.length > 0}
            onClick={() =>
              void confirmRevoke({
                subject,
                grantId: activeGrant.grantId,
                confirmedFingerprint: e.revokePreview!.fingerprint,
              }).then(() => {
                void load(subject)
                void history(subject)
              })
            }
          >
            {e.revoking ? '正在确认撤权…' : '确认撤权'}
          </button>
        )}
      </div>
      {!canPreviewIssue && !busy && !activeGrant && (
        <p className="mt-2 text-sm">
          仅当重验证来源为current且无活动授权时才可预览发行影响面；发行后源被冻结，修订事实须先撤权。
        </p>
      )}
      {e.preview && (conversational ? <div className="mt-3 space-y-3 rounded-xl bg-primary/10 p-4 text-sm" aria-label="本次执行授权摘要">
        <p className="font-medium">本次执行授权摘要</p>
        <p>共享上限：{e.preview.budget.maxCostMicros / 1000000} 美元 · 有效期至 {new Date(e.preview.budget.expiresAt).toLocaleString()}</p>
        {e.preview.blockers.length > 0 && <ul role="alert">{e.preview.blockers.map(item => <li key={item}>{item}</li>)}</ul>}
        <p className="text-xs">本地预算不等于 Provider 账单硬上限。继续后会显示包含预期成果和权限范围的系统确认；只有在系统确认中选择开始，Owner 才会启动员工。</p>
      </div> : <IssueFacts preview={e.preview} />)}
      {e.revokePreview && (conversational ? <section className="mt-3 rounded-lg bg-muted/40 p-3 text-sm" aria-label="撤销影响摘要">
        <p className="font-medium">撤销影响</p>
        <p>确认后将停止后续安排；已开始的工作和费用记录会保留，状态不明的部分仍需核对。</p>
        {e.revokePreview.blockers.length > 0 && <ul role="alert">{e.revokePreview.blockers.map((item, index) => <li key={`${index}-${item}`}>{item}</li>)}</ul>}
      </section> : <RevokeFacts revokePreview={e.revokePreview} />)}
      {!conversational && e.historyError && (
        <p role="alert" className="mt-2 text-sm text-destructive">
          历史：{e.historyError}
        </p>
      )}
      {!conversational && e.historyLoaded && (
        <section
          className="mt-3 max-h-[40vh] min-w-0 space-y-2 overflow-y-auto"
          aria-label="授权账本历史"
        >
          <p className="text-xs">
            历史只读：paused/撤权不删行、无复活路径；重新授权须走全新预览与确认。
          </p>
          {e.history.map((g) => (
            <GrantFacts key={g.grantId} grant={g} />
          ))}
          {!e.history.length && <p className="text-sm">暂无授权历史</p>}
        </section>
      )}
      {!conversational && <ProjectOwnerExecutionCommandPanel subject={subject} grant={activeGrant} revalidation={revalidationRecord} onGrantChanged={() => { void load(subject); void history(subject) }} />}
    </section>
  )
}

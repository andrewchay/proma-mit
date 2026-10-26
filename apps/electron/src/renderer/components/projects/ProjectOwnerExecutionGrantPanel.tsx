/** Owner执行授权账本面板：发行/撤权两阶段确认，展示账本行（active/paused）与只读历史。
 * 硬约束：发行≠派工启动；确认后无单次费用同意（第3确认在启动时另有）；active期间重验证被阻断属预期。 */
import { useEffect, useMemo, useState } from 'react'
import { atom, useAtomValue, useSetAtom } from 'jotai'
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
        {grant.workspaceId} · 渠道 {grant.channelId} · 模型 {grant.modelId} · Runtime{' '}
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
      atom((get) => {
        const editor: OwnerGrantEditor = getOwnerGrantEditor(get(ownerGrantEditorsAtom), subject)
        const revalidation = getOwnerRevalidationEditor(get(ownerRevalidationEditorsAtom), subject)
        const preparation = getOwnerExecutionEditor(get(ownerExecutionEditorsAtom), subject)
        const activeGrant = editor.grant?.state === 'active' ? editor.grant : null
        const revalidationCurrent = Boolean(
          revalidation.loaded &&
            revalidation.view?.status === 'current' &&
            revalidation.view.revalidation,
        )
        const policyRevision = preparation.view?.policyRevision ?? null
        const canPreviewIssue = Boolean(
          revalidationCurrent &&
            !activeGrant &&
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
          revalidationRecord: revalidation.view?.status === 'current' ? revalidation.view.revalidation : null,
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
  const [issueInput, setIssueInput] = useState<OwnerGrantIssueInput | null>(null)
  const [dispatchMode, setDispatchMode] = useState<OwnerExecutionDispatchMode>('manual')
  const busy = e.loading || e.previewing || e.confirming || e.revoking
  useEffect(() => {
    void load(subject)
    void history(subject)
  }, [load, history, subject])
  const onPreviewIssue = () => {
    if (revalidationRevision === null || policyRevision === null) return
    const input: OwnerGrantIssueInput = {
      requestId: crypto.randomUUID(),
      expectedRevalidationRevision: revalidationRevision,
      expectedPolicyRevision: policyRevision,
      dispatchMode,
    }
    setIssueInput(input)
    void previewIssue({ subject, input })
  }
  return (
    <section
      className="mt-4 min-w-0 max-w-full rounded-xl bg-card p-3 shadow-sm [overflow-wrap:anywhere] sm:p-4"
      aria-label="Owner 执行授权账本"
    >
      <h3 className="font-semibold">执行授权账本（发行与撤权）</h3>
      <p className="mt-2 text-xs text-muted-foreground">
        账本记录"允许按账本消费"的静态许可。人工模式仍逐条确认费用和启动；自主模式必须经过 Electron 主进程原生确认框，确认后在冻结任务/角色/预算范围内后台派发。授权不会自动重试或扩大范围；本地预算不是 Provider 端硬性费用上限。活动授权期间重验证被阻断属预期，退出路径是撤权。
      </p>
      <p role="status" className="mt-2 text-sm">
        {e.loading
          ? '正在读取授权账本'
          : `当前账本：${e.grant ? `${e.grant.state}（${e.grant.grantId}）` : '无授权行'}`}
      </p>
      {e.error && (
        <p role="alert" className="mt-2 text-sm text-destructive">
          {e.error}。不会自动重试，请核对后重试。
        </p>
      )}
      {e.grant && <div className="mt-3 min-w-0"><GrantFacts grant={e.grant} /></div>}
      {activeGrant && (
        <p className="mt-2 text-xs text-muted-foreground">
          活动授权存在：新发行被阻断（同源重放除外）、重验证被阻断均属预期；如需修订事实请先撤权。
        </p>
      )}
      <label className="mt-3 flex flex-wrap items-center gap-2 text-sm">
        派发模式
        <select className="rounded-md bg-background px-2 py-1" value={dispatchMode} disabled={busy || Boolean(e.preview)} onChange={(event) => setDispatchMode(event.target.value as OwnerExecutionDispatchMode)}>
          <option value="manual">人工逐条确认（默认）</option>
          <option value="autonomous">自主调度（需主进程原生确认）</option>
        </select>
      </label>
      {dispatchMode === 'autonomous' && <p className="mt-2 text-xs text-destructive">启用后会在额度和冻结范围内后台自动派发，不逐条等待点击；本地费用台账不保证 Provider 最终账单绝不超额。</p>}
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          className={button}
          disabled={!canPreviewIssue}
          onClick={onPreviewIssue}
        >
          {e.previewing ? '正在预览发行影响面…' : '预览发行影响面'}
        </button>
        <button
          type="button"
          className={button}
          disabled={
            !e.preview ||
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
          {e.confirming ? '正在确认发行…' : dispatchMode === 'autonomous' ? '请求原生确认并启用自主调度' : '确认发行'}
        </button>
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
      {e.preview && <IssueFacts preview={e.preview} />}
      {e.revokePreview && <RevokeFacts revokePreview={e.revokePreview} />}
      {e.historyError && (
        <p role="alert" className="mt-2 text-sm text-destructive">
          历史：{e.historyError}
        </p>
      )}
      {e.historyLoaded && (
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
      <ProjectOwnerExecutionCommandPanel subject={subject} grant={activeGrant} revalidation={revalidationRecord} onGrantChanged={() => { void load(subject); void history(subject) }} />
    </section>
  )
}

import { useEffect, useId, useMemo } from 'react'
import { atom, useAtomValue, useSetAtom } from 'jotai'
import { getOwnerGoalEditor, ownerGoalEditorsAtom } from '@/atoms/project-owner-goal-atoms'
import { getOwnerPlanEditor, loadOwnerPlanAtom, ownerPlanEditorsAtom, ownerPlanGoalReady } from '@/atoms/project-owner-plan-atoms'
import { editOwnerRuntimeAtom, getOwnerRuntimeEditor, loadOwnerRuntimeAtom, ownerRuntimeEditorsAtom, prepareOwnerRuntimeAtom, saveOwnerRuntimeAtom } from '@/atoms/project-owner-runtime-atoms'
import { ControlledTaskStartButton } from './ControlledTaskStartButton'
import { AgentExecutionStopButton } from './AgentExecutionStopButton'
const field = 'mt-1 w-full min-w-0 rounded-md border bg-background p-2 text-sm focus-visible:ring-2 focus-visible:ring-ring'
const button = 'rounded-md bg-muted px-3 py-2 text-sm disabled:opacity-50'
const states = { proposed: '已生成待审提案', needs_clarification: '需要人工澄清', stale: '来源变化，未覆盖计划', failed: '规划失败，未补发', unknown: '终态未知，未补发', stopped: '已请求停止，远端费用未保证结清' }
/** 保存职责配置、无费用准备和逐次模型确认分开；不会创建/启用员工或升级权限。 */
export function ProjectOwnerRuntimePanel({ projectId, taskId }: { projectId: string; taskId?: string }): React.ReactElement {
  const subject = useMemo(() => ({ projectId, ...(taskId === undefined ? {} : { taskId }) }), [projectId, taskId])
  const view = useMemo(() => atom(get => ({ editor: getOwnerRuntimeEditor(get(ownerRuntimeEditorsAtom), subject), goal: getOwnerGoalEditor(get(ownerGoalEditorsAtom), subject), plan: getOwnerPlanEditor(get(ownerPlanEditorsAtom), subject), goalReady: ownerPlanGoalReady(get, subject) })), [subject])
  const { editor, goal, plan, goalReady } = useAtomValue(view)
  const load = useSetAtom(loadOwnerRuntimeAtom), edit = useSetAtom(editOwnerRuntimeAtom), save = useSetAtom(saveOwnerRuntimeAtom), prepare = useSetAtom(prepareOwnerRuntimeAtom), loadPlan = useSetAtom(loadOwnerPlanAtom)
  const id = useId(), busy = editor.loading || editor.saving
  const revision = goal.snapshot?.revision
  // biome-ignore lint/correctness/useExhaustiveDependencies: 目标保存后必须重新获取冻结来源，不沿用上一目标的准备预检。
  useEffect(() => { void load(subject) }, [load, subject, revision])
  const carriers = editor.employees.filter(item => item.enabled && item.executionProfile === 'controlled' && item.runtime === 'ai-sdk')
  const carrier = carriers.find(item => item.id === editor.carrierId)
  const workspaces = editor.workspaces.filter(item => editor.boundWorkspaceIds.includes(item.id) && (carrier?.workspaceIds?.includes(item.id) || carrier?.workspaceId === item.id))
  const canPrepare = !busy && !editor.dirty && Boolean(editor.binding && editor.context && goalReady && plan.loaded && !plan.loading && !plan.saving && !plan.dirty && !plan.conflict && !plan.requiresReview && editor.context.goal.revision === revision)
  const changed = async () => { await Promise.all([load(subject), loadPlan(subject)]) }
  return <section className="mt-4 min-w-0 rounded-xl bg-card p-5 shadow-sm [overflow-wrap:anywhere]" aria-label="Owner受控模型规划">
    <div className="flex flex-wrap items-center justify-between gap-3"><h2 className="text-lg font-semibold">Owner 模型规划</h2><button type="button" className={button} disabled={busy} onClick={() => void changed()}>刷新配置、Run与提案</button></div>
    <p className="mt-2 text-xs leading-relaxed text-muted-foreground">Owner是项目治理职责，下面的既有AI员工只是模型调用载体，不会被改名、激活或升级权限。配置与准备均不收费；真正调用前另行确认本次模型费用。规划只生成待审内容或必要澄清，不自动派工或完成业务任务。</p>
    {editor.error && <p role="alert" className="mt-3 text-sm text-destructive">{editor.error}。未自动重试，请比较最新来源。</p>}
    <form className="mt-4 space-y-3" onSubmit={event => { event.preventDefault(); void save(subject) }}>
      <label className="block text-sm" htmlFor={`${id}-name`}>Owner职责名称<input id={`${id}-name`} className={field} required maxLength={200} value={editor.ownerName} disabled={busy} onChange={event => edit({ subject, patch: { ownerName: event.target.value } })} /></label>
      <label className="block text-sm" htmlFor={`${id}-carrier`}>实际规划载体（仅既有受控AI SDK员工）<select id={`${id}-carrier`} className={field} disabled={busy} value={editor.carrierId} onChange={event => edit({ subject, patch: { carrierId: event.target.value, workspaceId: '' } })}><option value="">请选择已有员工，不默认创建</option>{!carriers.some(item => item.id === editor.carrierId) && editor.carrierId && <option value={editor.carrierId}>原载体不可用（{editor.carrierId}）</option>}{carriers.map(item => <option key={item.id} value={item.id}>{item.name} · {item.role} · {item.modelId ?? '模型未明确'}</option>)}</select></label>
      {!carriers.length && !busy && <p className="text-xs text-muted-foreground">尚无已启用的受控AI SDK载体。请在团队中由用户配置合适员工；此处不会自动创建或启用。</p>}
      <label className="block text-sm" htmlFor={`${id}-workspace`}>双方明确授权的项目工作区<select id={`${id}-workspace`} className={field} disabled={busy} value={editor.workspaceId} onChange={event => edit({ subject, patch: { workspaceId: event.target.value } })}><option value="">请选择共同授权工作区，不回退主目录</option>{!workspaces.some(item => item.id === editor.workspaceId) && editor.workspaceId && <option value={editor.workspaceId}>原工作区不可用（{editor.workspaceId}）</option>}{workspaces.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      <label className="block text-sm" htmlFor={`${id}-reason`}>配置变更原因<input id={`${id}-reason`} className={field} required maxLength={2000} disabled={busy} value={editor.changeReason} onChange={event => edit({ subject, patch: { changeReason: event.target.value } })} /></label>
      <button type="submit" className={button} disabled={busy || !editor.dirty || !editor.ownerName.trim() || !carrier || !workspaces.some(item => item.id === editor.workspaceId) || !editor.changeReason.trim()}>保存Owner与载体绑定（不收费）</button>
      {editor.binding && <p className="text-xs text-muted-foreground">已保存配置 v{editor.binding.revision} · 载体 {editor.binding.carrierId} · 渠道 {editor.binding.channelId} · 模型 {editor.binding.modelId}。不代表本次调用费用已同意。</p>}
    </form>
    <div className="mt-4 space-y-2"><button type="button" className="rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-50" disabled={!canPrepare} onClick={() => void prepare(subject)}>准备一次目标规划（不收费）</button><p className="text-xs text-muted-foreground">请先保存目标、绑定配置并解决目标/计划冲突。准备会创建可见暂停承载任务，冻结当前目标和计划版本；不会发送模型请求。未保存计划编辑不作为AI输入。</p></div>
    <div className="mt-4 space-y-3" aria-label="Owner规划Run记录"><p className="text-xs text-muted-foreground">本主体最近最多50份准备。费用来自Runtime报告或保持未知；这些本机回执不宣称Provider请求ID或外部验收证明。</p>{!editor.runs.length && <p className="text-sm text-muted-foreground">尚无暂停准备或规划Run。</p>}{editor.runs.map(run => <article key={run.link.id} className="space-y-2 rounded-lg bg-muted/40 p-3 text-sm">
      <p className="font-medium">目标 v{run.link.goalVersion} · 目标修订 {run.link.goalRevision} · 计划修订 {run.link.planRevision} · 配置 v{run.link.bindingRevision}</p>
      <p className="text-xs text-muted-foreground">暂停承载任务：{run.link.planningTaskId}；用途 owner_planning，最多1请求/4096输出token。</p>
      {!run.executions.length && goalReady && !editor.dirty && !plan.dirty && run.link.goalRevision === revision && run.link.planRevision === (plan.snapshot?.revision ?? 0) && run.link.bindingRevision === editor.binding?.revision && <ControlledTaskStartButton taskId={run.link.planningTaskId} revision={JSON.stringify([run.link.goalRevision, run.link.planRevision, run.link.bindingRevision])} onChanged={changed} />}
      {run.executions.map(execution => <div key={execution.id} className="space-y-1"><p>Run {execution.id} · {execution.status}</p><p className="text-xs text-muted-foreground">{execution.summary ?? '尚无处理终态；排队不证明模型已发送。'}</p><AgentExecutionStopButton execution={{ id: execution.id, status: execution.status, entityType: 'task', entityId: run.link.planningTaskId }} onChanged={changed} /></div>)}
      {run.outcomes.map(outcome => <div key={outcome.executionId}><p>{states[outcome.state]}：{outcome.detail}</p>{outcome.clarification && <div className="mt-2 space-y-1"><p className="font-medium">请回答并修改上方目标，保存后重新准备；不会自动再次调用。</p>{outcome.clarification.questions.map(question => <p key={question.key}>{question.question}（{question.why}）{question.options.length ? ` 可选：${question.options.join(' / ')}` : ''}</p>)}</div>}</div>)}
      {run.receipts.map(receipt => <details key={receipt.id} className="text-xs"><summary className="cursor-pointer">Run原文与费用证据 · {receipt.cost.source === 'unknown' ? '费用未知（不是零元）' : `Runtime报告USD ${receipt.cost.usd}`} · {new Date(receipt.capturedAt).toLocaleString()}</summary><p className="mt-2">输入token {receipt.usage?.inputTokens ?? '未知'} / 输出token {receipt.usage?.outputTokens ?? '未知'}；终态 {receipt.validTerminal ? '完整stop（内容仍需协议校验/人工确认）' : '未证实完整stop'}；{receipt.stopped ? '停止不保证远端已终止。' : ''}</p><p>{receipt.error}</p><pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-words">{receipt.responseText || '没有收到可保存文本；不补发。'}</pre><p className="break-all">原文摘要 {receipt.responseHash}；回执 {receipt.id}</p></details>)}
    </article>)}</div>
  </section>
}

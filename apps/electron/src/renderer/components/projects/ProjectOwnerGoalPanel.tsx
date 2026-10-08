import { useEffect, useId, useMemo } from 'react'
import { atom, useAtomValue, useSetAtom } from 'jotai'
import {
  acknowledgeOwnerGoalComparisonAtom, canSaveOwnerGoal, editOwnerGoalAtom, getOwnerGoalEditor,
  loadOwnerGoalAtom, ownerGoalEditorsAtom, saveOwnerGoalAtom,
} from '../../atoms/project-owner-goal-atoms'

/** 本地目标保存入口；模型规划/授权/派发未接入，不能将草案展示为运行中。 */
export function ProjectOwnerGoalPanel({ projectId, taskId }: { projectId: string; taskId?: string }): React.ReactElement {
  const subject = useMemo(() => ({ projectId, ...(taskId === undefined ? {} : { taskId }) }), [projectId, taskId])
  const editorAtom = useMemo(() => atom((get) => getOwnerGoalEditor(get(ownerGoalEditorsAtom), subject)), [subject])
  const editor = useAtomValue(editorAtom)
  const load = useSetAtom(loadOwnerGoalAtom)
  const edit = useSetAtom(editOwnerGoalAtom)
  const save = useSetAtom(saveOwnerGoalAtom)
  const acknowledge = useSetAtom(acknowledgeOwnerGoalComparisonAtom)
  const id = useId()
  useEffect(() => { void load(subject) }, [load, subject])
  const status = editor.loading ? '正在加载'
    : editor.conflict ? '版本冲突'
    : editor.requiresReview ? '需比较最新版本'
    : !editor.loaded && editor.error ? '加载失败'
    : editor.dirty ? '有未保存更改'
    : editor.snapshot ? '已保存草案 · 未启动' : '尚未保存'
  const fields = [
    { key: 'constraintsText' as const, label: '必要约束', placeholder: '例如：仅使用已授权资料，不对外发布。每行一条。' },
    { key: 'criteriaText' as const, label: '完成标准', placeholder: '可以先留空，之后由 Owner 提出建议。每行一条。' },
  ]
  return (
    <section className="min-w-0 rounded-xl bg-card p-5 shadow-sm [overflow-wrap:anywhere]" aria-label={taskId ? '任务目标草案' : '项目目标草案'} data-project-id={projectId}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1 basis-48">
          <h2 className="text-lg font-semibold">{taskId ? '这项任务希望得到什么结果？' : '这个项目希望达到什么目标？'}</h2>
          <p className="mt-1 text-sm text-muted-foreground">先保存目标与必要约束，不需要先拆任务、选择员工或填写文件路径。</p>
        </div>
        <span className="shrink-0 rounded-md bg-muted px-2 py-1 text-xs" role="status">{status}</span>
      </div>
      <form className="mt-4 space-y-3" onSubmit={(event) => { event.preventDefault(); void save(subject) }}>
        <label className="block text-sm font-medium" htmlFor={`${id}-objective`}>目标</label>
        <textarea id={`${id}-objective`} required maxLength={12000} rows={3}
          className="w-full rounded-lg border bg-background p-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          value={editor.objective} onChange={(event) => edit({ subject, patch: { objective: event.target.value } })}
          placeholder="例如：梳理产品定位，形成可评审的方案，并解释推荐方向。" />
        <details className="rounded-lg bg-muted/40 p-3">
          <summary className="cursor-pointer text-sm text-muted-foreground">必要约束与完成标准（可选）</summary>
          <div className="mt-3 space-y-3">{fields.map((field) => <div key={field.key}>
            <label className="mb-1 block text-xs font-medium" htmlFor={`${id}-${field.key}`}>{field.label}</label>
            <textarea id={`${id}-${field.key}`} rows={2} className="w-full rounded-md border bg-background p-2 text-sm"
              value={editor[field.key]} onChange={(event) => edit({ subject, patch: { [field.key]: event.target.value } })}
              placeholder={field.placeholder} />
          </div>)}</div>
        </details>
        {editor.error && <p className="text-sm text-destructive" role="alert">{editor.error} 你的输入仍保留在当前窗口。</p>}
        {editor.conflict && <p className="text-sm text-muted-foreground">其他修改已更新服务器草案。请加载最新版本后比较，不会自动覆盖或重试保存。</p>}
        {editor.requiresReview && <div className="rounded-lg bg-muted p-3 text-sm" aria-label="草案版本比较">
          <p className="font-medium">保存前请先比较：服务器最新目标 v{editor.snapshot?.goal.goalVersion ?? 0}</p>
          <p className="mt-2 whitespace-pre-wrap">{editor.snapshot?.goal.objective ?? '服务器尚无目标草案'}</p>
          <p className="mt-2 whitespace-pre-wrap text-xs text-muted-foreground">约束：{editor.snapshot?.goal.constraints.join('；') || '未填写'}<br />
            标准：{editor.snapshot?.goal.acceptanceCriteria.join('；') || '未填写'}</p>
          <p className="mt-2 text-xs text-muted-foreground">上方仍是你的未保存输入。确认比较只允许你基于最新版本继续编辑，不会执行保存。</p>
          <button type="button" className="mt-3 rounded-md bg-background px-3 py-1.5 text-sm disabled:opacity-50"
            disabled={editor.loading || editor.saving} onClick={() => acknowledge(subject)}>已比较最新版本，保留我的输入继续编辑</button>
        </div>}
        <div className="flex flex-wrap items-center gap-3">
          <button type="submit" disabled={!canSaveOwnerGoal(editor)} className="rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-50">
            {editor.saving ? '正在保存…' : '保存目标草案'}
          </button>
          <button type="button" disabled={editor.loading || editor.saving} className="rounded-md bg-muted px-3 py-2 text-sm disabled:opacity-50"
            onClick={() => void load(subject)}>{editor.loading ? '正在加载…' : '加载最新版本（保留输入）'}</button>
          {editor.snapshot && <span className="text-xs text-muted-foreground">已保存目标 v{editor.snapshot.goal.goalVersion} · 当前输入{editor.dirty ? '尚未保存' : '已同步'}</span>}
        </div>
        <p className="text-xs leading-relaxed text-muted-foreground">仅本地保存，不会调用模型、扣费、创建执行授权或派发任务。AI 拆解与主动推进仍待接入；草案不等于已确认计划。</p>
        <p className="text-xs text-muted-foreground">未保存输入暂存在当前窗口；退出或重载窗口前请保存。标准与约束各最多 32 条，每条不超过 2000 字。</p>
      </form>
    </section>
  )
}

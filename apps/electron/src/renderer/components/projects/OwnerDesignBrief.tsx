import { useMemo } from 'react'
import { atom, useAtom } from 'jotai'

const kinds = ['网页', '报告', '幻灯片', '海报'] as const
interface DesignBrief { kind: typeof kinds[number]; goal: string; style: string; status: string }

/** 只生成用户可编辑的对话草稿，不读取或改写品牌文件。 */
export function OwnerDesignBrief({ disabled, onAdd }: { disabled: boolean; onAdd: (text: string) => boolean }): React.ReactElement {
  const draftAtom = useMemo(() => atom<DesignBrief>({ kind: '网页', goal: '', style: '', status: '' }), [])
  const [draft, setDraft] = useAtom(draftAtom)
  const add = (): void => {
    const goal = draft.goal.trim(), style = draft.style.trim()
    if (!goal) return
    const text = [`设计任务：制作${draft.kind}。`, `目标与要求：${goal}`, ...(style ? [`品牌或风格参考：${style}。请先核对相关设计规范和资源是否可用；缺失时明确说明，不要声称已经符合品牌规范。`] : [])].join('\n')
    if (!onAdd(text)) { setDraft({ ...draft, status: '对话草稿空间不足，请精简后再添加。' }); return }
    setDraft({ ...draft, status: '已加入对话草稿；检查后由你决定是否发送。' })
  }
  return <details className="rounded-xl bg-background/70 p-4 shadow-sm" aria-label="设计任务草稿">
    <summary className="cursor-pointer text-sm font-medium">创建设计任务草稿</summary>
    <div className="mt-3 grid gap-3 text-sm">
      <label className="grid gap-1">交付类型<select className="rounded-lg bg-muted/60 p-2" value={draft.kind} onChange={event => setDraft({ ...draft, kind: event.target.value as DesignBrief['kind'], status: '' })}>{kinds.map(kind => <option key={kind} value={kind}>{kind}</option>)}</select></label>
      <label className="grid gap-1">目标与要求<textarea className="min-h-20 rounded-lg bg-muted/60 p-2" value={draft.goal} maxLength={1200} onChange={event => setDraft({ ...draft, goal: event.target.value, status: '' })} placeholder="说明受众、用途和想交付的内容" /></label>
      <label className="grid gap-1">品牌或风格参考（可选）<input className="rounded-lg bg-muted/60 p-2" value={draft.style} maxLength={200} onChange={event => setDraft({ ...draft, style: event.target.value, status: '' })} placeholder="例如 Stripe 或简洁编辑风格" /></label>
      <p className="text-xs text-muted-foreground">这里只记录意图；具体品牌资源是否可用，需在执行时核对。</p>
      {draft.status && <p role="status" className="text-xs text-muted-foreground">{draft.status}</p>}
      <button type="button" disabled={disabled || !draft.goal.trim()} className="w-fit rounded-lg bg-primary px-3 py-2 text-primary-foreground disabled:opacity-50" onClick={add}>添加到对话草稿</button>
    </div>
  </details>
}

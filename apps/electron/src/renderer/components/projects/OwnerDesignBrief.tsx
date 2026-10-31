import { useEffect, useMemo, useRef } from 'react'
import { atom, useAtom } from 'jotai'
import catalog from '../../../../resources/opendesign-brand-catalog.json'

const kinds = ['网页', '报告', '幻灯片', '海报'] as const
interface DesignReference { design: string; tokens: string }
interface DesignBrief { kind: typeof kinds[number]; goal: string; brandId: string; style: string; quote: string; status: string; installPreview?: import('@gravitas/shared').ProjectOwnerDesignSystemInstallPreview }
const categories = [...new Set(catalog.entries.map(entry => entry.category))]
const referenceLoaders = [
  () => import('../../../../resources/opendesign-references-0.json'),
  () => import('../../../../resources/opendesign-references-1.json'),
  () => import('../../../../resources/opendesign-references-2.json'),
  () => import('../../../../resources/opendesign-references-3.json'),
]

/** 用户主动下载原文；不写入或激活工作区。 */
function downloadDesignReference(id: string, content: string, kind: 'design' | 'tokens'): void {
  const url = URL.createObjectURL(new Blob([content], { type: kind === 'design' ? 'text/markdown;charset=utf-8' : 'text/css;charset=utf-8' }))
  const link = document.createElement('a')
  link.href = url; link.download = `${id}-${kind === 'design' ? 'DESIGN.md' : 'tokens.css'}`
  document.body.appendChild(link); link.click(); link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** 只生成用户可编辑的对话草稿，不改写工作区文件。 */
export function OwnerDesignBrief({ projectId, disabled, onAdd }: { projectId: string; disabled: boolean; onAdd: (text: string) => boolean }): React.ReactElement {
  const draftAtom = useMemo(() => atom<DesignBrief>({ kind: '网页', goal: '', brandId: '', style: '', quote: '', status: '' }), [])
  const [draft, setDraft] = useAtom(draftAtom)
  const referenceAtom = useMemo(() => atom<{ id: string; value?: DesignReference; error?: string }>({ id: '' }), [])
  const [reference, setReference] = useAtom(referenceAtom)
  const pendingSelection = useRef<{ brandId: string; text: string; node: HTMLElement | null }>({ brandId: '', text: '', node: null })
  useEffect(() => {
    const id = draft.brandId
    if (!id) { setReference({ id: '' }); return }
    let active = true
    setReference({ id })
    const index = catalog.entries.findIndex(entry => entry.id === id)
    const load = referenceLoaders[Math.floor(index / 38)]
    if (!load) { setReference({ id, error: '参考内容不可用' }); return }
    void load().then(bundle => {
      if (!active) return
      const value = (bundle.entries as Record<string, DesignReference>)[id]
      setReference(value ? { id, value } : { id, error: '参考内容不可用' })
    }).catch(() => { if (active) setReference({ id, error: '参考内容加载失败' }) })
    return () => { active = false }
  }, [draft.brandId, setReference])
  const captureSelection = (container: HTMLElement): string => {
    const selection = window.getSelection()
    if (!selection?.anchorNode || !selection.focusNode || !container.contains(selection.anchorNode) || !container.contains(selection.focusNode)) return ''
    const text = selection.toString().trim()
    pendingSelection.current = { brandId: draft.brandId, text, node: container }
    return text
  }
  const quoteSelection = (container: HTMLElement): void => {
    const text = captureSelection(container) || (pendingSelection.current.brandId === draft.brandId && pendingSelection.current.node && container.contains(pendingSelection.current.node) ? pendingSelection.current.text : '')
    if (!text) { setDraft({ ...draft, status: '请先在设计参考中选中一段文字。' }); return }
    if (text.length > 1600) { setDraft({ ...draft, status: '引用最多 1600 字，请缩短选区。' }); return }
    setDraft({ ...draft, quote: text, status: '已选中参考片段；添加到草稿前可以继续修改。' })
  }
  const previewInstall = async (): Promise<void> => {
    try {
      const result = await window.electronAPI.paa.project.previewOwnerDesignSystemInstall({ projectId, brandId: draft.brandId })
      if (!result.ok) { setDraft({ ...draft, status: result.error.message }); return }
      setDraft({ ...draft, installPreview: result.value, status: '' })
    } catch (error) { setDraft({ ...draft, status: `读取安装目标失败：${error instanceof Error ? error.message : String(error)}` }) }
  }
  const confirmInstall = async (): Promise<void> => {
    const preview = draft.installPreview
    if (!preview?.canInstall || preview.brandId !== draft.brandId) return
    try {
      const result = await window.electronAPI.paa.project.installOwnerDesignSystem({ projectId, brandId: draft.brandId, expectedOwnerBindingRevision: preview.ownerBindingRevision, expectedWorkspaceId: preview.workspaceId, expectedReferenceRevision: preview.referenceRevision, confirmed: true })
      if (!result.ok) { setDraft({ ...draft, installPreview: undefined, status: result.error.message }); return }
      setDraft({ ...draft, installPreview: undefined, status: `已安装到 Owner 工作区“${result.value.workspaceName}”。新启动的设计任务会读取完整参考；不会覆盖现有文件。` })
    } catch (error) { setDraft({ ...draft, installPreview: undefined, status: `安装失败：${error instanceof Error ? error.message : String(error)}` }) }
  }
  const add = (): void => {
    const goal = draft.goal.trim(), style = draft.style.trim()
    const brand = catalog.entries.find(entry => entry.id === draft.brandId)
    if (!goal) return
    const text = [`设计任务：制作${draft.kind}。`, `目标与要求：${goal}`, ...(brand ? [`设计系统参考：${brand.name}（${brand.id}）。`] : []), ...(style ? [`风格补充：${style}。`] : []), ...(brand && draft.quote ? [`OpenDesign ${brand.id} 参考节选（版本 ${catalog.revision}，非完整规范）：\n${draft.quote}`] : []), ...(brand || style ? ['请先核对相关设计规范和资源是否可用；缺失时明确说明，不要声称已经符合品牌规范。'] : [])].join('\n')
    if (!onAdd(text)) { setDraft({ ...draft, status: '对话草稿空间不足，请精简后再添加。' }); return }
    setDraft({ ...draft, status: '已加入对话草稿；检查后由你决定是否发送。' })
  }
  return <details className="rounded-xl bg-background/70 p-4 shadow-sm" aria-label="设计任务草稿">
    <summary className="cursor-pointer text-sm font-medium">创建设计任务草稿</summary>
    <div className="mt-3 grid gap-3 text-sm">
      <label className="grid gap-1">交付类型<select className="rounded-lg bg-muted/60 p-2" value={draft.kind} onChange={event => setDraft({ ...draft, kind: event.target.value as DesignBrief['kind'], status: '' })}>{kinds.map(kind => <option key={kind} value={kind}>{kind}</option>)}</select></label>
      <label className="grid gap-1">目标与要求<textarea className="min-h-20 rounded-lg bg-muted/60 p-2" value={draft.goal} maxLength={1200} onChange={event => setDraft({ ...draft, goal: event.target.value, status: '' })} placeholder="说明受众、用途和想交付的内容" /></label>
      <label className="grid gap-1">设计系统参考（可选）<select className="rounded-lg bg-muted/60 p-2" value={draft.brandId} onChange={event => { pendingSelection.current = { brandId: '', text: '', node: null }; setDraft({ ...draft, brandId: event.target.value, quote: '', installPreview: undefined, status: '' }) }}><option value="">不选择设计系统</option>{categories.map(category => <optgroup key={category} label={category}>{catalog.entries.filter(entry => entry.category === category).map(entry => <option key={entry.id} value={entry.id}>{entry.name}</option>)}</optgroup>)}</select></label>
    {draft.brandId && <details className="rounded-lg bg-muted/40 p-3" aria-label="设计系统参考内容">
        <summary className="cursor-pointer font-medium">查看本地设计参考</summary>
        <p className="mt-2 text-xs text-muted-foreground">OpenDesign 整理的参考资料，并非品牌官方授权规范。版本 {catalog.revision.slice(0, 12)} · {catalog.license}。查看不会安装、激活或发送内容。</p>
        {reference.id === draft.brandId && reference.value ? <div className="mt-2 grid gap-2">
          <p className="text-xs text-muted-foreground">安装会把完整设计说明与令牌加入当前 Owner 执行工作区的共享 OpenDesign 上下文，仅影响声明需要设计系统的 Skill。若目标已有设计文件或安装记录，将拒绝覆盖。</p>
          <div className="flex flex-wrap gap-2"><button type="button" className="rounded-lg bg-muted px-3 py-2" onClick={() => downloadDesignReference(draft.brandId, reference.value!.design, 'design')}>下载设计说明</button><button type="button" className="rounded-lg bg-muted px-3 py-2" onClick={() => downloadDesignReference(draft.brandId, reference.value!.tokens, 'tokens')}>下载设计令牌</button></div>
          <div className="flex flex-wrap items-center gap-2"><button type="button" className="rounded-lg bg-primary px-3 py-2 text-primary-foreground disabled:opacity-50" disabled={disabled} onClick={() => void previewInstall()}>安装到 Owner 工作区</button></div>
          {draft.installPreview && draft.installPreview.brandId === draft.brandId && <div className="grid gap-2 rounded-lg bg-background/70 p-3" aria-label="确认 OpenDesign 安装">
            <p className="text-xs">目标：Owner 工作区“{draft.installPreview.workspaceName}” · OpenDesign {draft.installPreview.referenceRevision.slice(0, 12)}。将安装 DESIGN.md 和 tokens.css，并记录来源版本及文件摘要。</p>
            {!draft.installPreview.canInstall && <p role="status" className="text-xs text-destructive">目标存在冲突（{draft.installPreview.conflictNames.join('、')}），不会覆盖。请先由你处理现有文件后重新检查。</p>}
            {draft.installPreview.canInstall && <div className="flex gap-2"><button type="button" className="rounded-lg bg-primary px-3 py-2 text-primary-foreground" disabled={disabled} onClick={() => void confirmInstall()}>确认安装</button><button type="button" className="rounded-lg bg-muted px-3 py-2" onClick={() => setDraft({ ...draft, installPreview: undefined, status: '已取消安装。' })}>取消</button></div>}
          </div>}
          <details><summary className="cursor-pointer">设计说明</summary><div><pre onMouseUp={event => { captureSelection(event.currentTarget) }} onKeyUp={event => { captureSelection(event.currentTarget) }} className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-words text-xs">{reference.value.design}</pre><button type="button" className="mt-2 rounded-lg bg-muted px-3 py-2" onMouseDown={event => event.preventDefault()} onClick={event => quoteSelection(event.currentTarget.parentElement!)}>引用选中的设计说明</button></div></details>
          <details><summary className="cursor-pointer">设计令牌 CSS</summary><div><pre onMouseUp={event => { captureSelection(event.currentTarget) }} onKeyUp={event => { captureSelection(event.currentTarget) }} className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-words text-xs">{reference.value.tokens}</pre><button type="button" className="mt-2 rounded-lg bg-muted px-3 py-2" onMouseDown={event => event.preventDefault()} onClick={event => quoteSelection(event.currentTarget.parentElement!)}>引用选中的设计令牌</button></div></details>
        </div> : <p className="mt-2 text-xs">{reference.id === draft.brandId && reference.error ? reference.error : '正在加载参考内容…'}</p>}
      </details>}
      {draft.quote && <label className="grid gap-1">参考节选（可编辑）<textarea className="min-h-20 rounded-lg bg-muted/60 p-2" value={draft.quote} maxLength={1600} onChange={event => setDraft({ ...draft, quote: event.target.value, status: '' })} /></label>}
      <label className="grid gap-1">补充风格要求（可选）<input className="rounded-lg bg-muted/60 p-2" value={draft.style} maxLength={200} onChange={event => setDraft({ ...draft, style: event.target.value, status: '' })} placeholder="例如简洁编辑风格" /></label>
      <p className="text-xs text-muted-foreground">选择只记录参考意图；安装必须由你确认。安装不会证明品牌授权，也不代表真实模型已遵循规范。</p>
      {draft.status && <p role="status" className="text-xs text-muted-foreground">{draft.status}</p>}
      <button type="button" disabled={disabled || !draft.goal.trim()} className="w-fit rounded-lg bg-primary px-3 py-2 text-primary-foreground disabled:opacity-50" onClick={add}>添加到对话草稿</button>
    </div>
  </details>
}

import * as React from 'react'
import { CheckCircle2, Clipboard, Download, PackageOpen } from 'lucide-react'
import type { NewMediaContentDraft, XiaohongshuHandoff } from '@gravitas/shared'

const STATUS_LABEL: Record<XiaohongshuHandoff['status'], string> = {
  draft_ready: '草稿已准备',
  handed_off: '已交接，待用户发布',
  user_confirmed_published: '用户确认已发布',
}

interface Props {
  drafts: NewMediaContentDraft[]
  handoffs: XiaohongshuHandoff[]
  onRefresh: () => Promise<void>
}

export function XiaohongshuHandoffPanel({ drafts, handoffs, onRefresh }: Props): React.ReactElement {
  const [notice, setNotice] = React.useState('')
  const draftById = React.useMemo(() => new Map(drafts.map((draft) => [draft.id, draft])), [drafts])

  const copyContent = async (handoff: XiaohongshuHandoff): Promise<void> => {
    const copy = draftById.get(handoff.draftId)?.platformCopies.xiaohongshu
    if (!copy) return
    await navigator.clipboard.writeText([copy.title, '', copy.body, '', copy.hashtags.join(' ')].join('\n'))
    setNotice('标题、正文和标签已复制；未发生真实发布。')
  }

  const exportPackage = async (handoff: XiaohongshuHandoff): Promise<void> => {
    const result = await window.electronAPI.paa.newMedia.xiaohongshuHandoff.exportPackage(handoff.id)
    if (!result.canceled) setNotice(`已导出 ${result.fileName ?? '交付包'}；请在小红书官方发布页检查后手动发布。`)
    await onRefresh()
  }

  const confirmPublished = async (handoff: XiaohongshuHandoff): Promise<void> => {
    if (!window.confirm('请仅在你已通过小红书官方 App 或后台完成发布后确认。该状态不是平台 API 回执。')) return
    await window.electronAPI.paa.newMedia.xiaohongshuHandoff.confirmPublished(handoff.id, 'local-user')
    setNotice('已记录“用户确认已发布”，未伪造平台回执。')
    await onRefresh()
  }

  return <section className="rounded-2xl bg-background p-4 shadow-sm">
    <div className="flex items-center gap-2"><PackageOpen size={17} /><h2 className="font-medium">小红书发布交接</h2></div>
    <p className="mt-1 text-sm text-foreground/55">导出交付包或复制内容后，由用户前往小红书官方 App/后台完成发布。</p>
    {notice && <div className="mt-3 rounded-lg bg-emerald-500/10 p-3 text-sm text-emerald-700 dark:text-emerald-300">{notice}</div>}
    <div className="mt-4 space-y-3">
      {handoffs.map((handoff) => {
        const copy = draftById.get(handoff.draftId)?.platformCopies.xiaohongshu
        return <article key={handoff.id} className="rounded-xl bg-muted/45 p-3">
          <div className="flex items-start justify-between gap-3"><div><div className="font-medium">{copy?.title ?? handoff.packageFileName}</div><div className="mt-1 text-xs text-foreground/45">{STATUS_LABEL[handoff.status]}</div></div><span className="rounded-full bg-background px-2 py-1 text-[11px]">非 API 发布</span></div>
          {handoff.warnings.map((warning) => <div key={warning} className="mt-2 text-xs text-amber-700 dark:text-amber-300">{warning}</div>)}
          <div className="mt-3 flex flex-wrap justify-end gap-2">
            <button onClick={() => void copyContent(handoff)} className="inline-flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs hover:bg-background"><Clipboard size={13} />复制内容</button>
            {handoff.status !== 'user_confirmed_published' && <button onClick={() => void exportPackage(handoff)} className="inline-flex items-center gap-1 rounded-lg bg-primary/10 px-3 py-1.5 text-xs text-primary"><Download size={13} />导出交付包</button>}
            {handoff.status === 'handed_off' && <button onClick={() => void confirmPublished(handoff)} className="inline-flex items-center gap-1 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs text-white"><CheckCircle2 size={13} />确认已在官方端发布</button>}
          </div>
        </article>
      })}
      {handoffs.length === 0 && <div className="py-5 text-center text-sm text-foreground/45">尚未准备小红书发布交接</div>}
    </div>
  </section>
}

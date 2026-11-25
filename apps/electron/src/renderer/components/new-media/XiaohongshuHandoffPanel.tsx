import * as React from 'react'
import { CheckCircle2, Clipboard, Download, ExternalLink, PackageOpen } from 'lucide-react'
import { atom, useAtom } from 'jotai'
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
  const [browserBusy, setBrowserBusy] = useAtom(React.useMemo(() => atom(false), []))
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

  const useDraftBrowser = async (handoffId: string, action: 'open' | 'fill' | 'verify' | 'cover'): Promise<void> => {
    setBrowserBusy(true)
    try {
      const browser = window.electronAPI.paa.newMedia.xiaohongshuHandoff
      if (action === 'open') {
        await browser.openDraftBrowser(handoffId)
        setNotice('在创作窗口登录并上传封面，进入空白图文编辑器后，回到这里点击「填入文案」。')
      } else if (action === 'fill') {
        await browser.fillDraftBrowser(handoffId)
        setNotice('文案已填入编辑器。请检查封面和话题，点击「暂存离开」，重新打开草稿后回来核对。')
      } else if (action === 'verify') {
        await browser.verifyDraftBrowser(handoffId)
        await onRefresh()
        setNotice('小红书草稿页显示的标题和正文与交接文案一致。')
      } else if (await browser.exportCover(handoffId)) {
        setNotice('已保存封面 PNG。请在小红书图文创作页选择这张图片。')
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': Error: /, '') : '创作窗口操作失败，请检查页面后重试。')
    } finally {
      setBrowserBusy(false)
    }
  }

  return <section className="rounded-2xl bg-background p-4 shadow-sm">
    <div className="flex items-center gap-2"><PackageOpen size={17} /><h2 className="font-medium">小红书发布交接</h2></div>
    <p className="mt-1 text-sm text-foreground/55">总监方案可在官方创作窗口填入文案。暂存后重新打开同一篇草稿，即可核对文案。发布由你操作。</p>
    {notice && <div role="status" className="mt-3 rounded-lg bg-muted/60 p-3 text-sm text-foreground">{notice}</div>}
    <div className="mt-4 space-y-3">
      {handoffs.map((handoff) => {
        const draft = draftById.get(handoff.draftId)
        const copy = draft?.platformCopies.xiaohongshu
        const canUseBrowser = Boolean(draft?.directorPlanId && copy) && handoff.status !== 'user_confirmed_published'
        return <article key={handoff.id} className="rounded-xl bg-muted/45 p-3">
          <div className="flex items-start justify-between gap-3"><div><div className="font-medium">{copy?.title ?? handoff.packageFileName}</div><div className="mt-1 text-xs text-foreground/55">{handoff.draftReadbackAt && handoff.status !== 'user_confirmed_published' ? '已核对小红书草稿文案' : STATUS_LABEL[handoff.status]}</div></div></div>
          {handoff.warnings.map((warning) => <div key={warning} className="mt-2 text-xs text-amber-700 dark:text-amber-300">{warning}</div>)}
          <div className="mt-3 flex flex-wrap justify-end gap-2">
            {canUseBrowser && <>
              {handoff.designAssetId && <button disabled={browserBusy} onClick={() => void useDraftBrowser(handoff.id, 'cover')} className="rounded-lg px-3 py-1.5 text-xs hover:bg-background disabled:opacity-50">保存封面</button>}
              <button disabled={browserBusy} onClick={() => void useDraftBrowser(handoff.id, 'open')} className="inline-flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs hover:bg-background disabled:opacity-50"><ExternalLink size={13} />打开创作页</button>
              <button disabled={browserBusy} onClick={() => void useDraftBrowser(handoff.id, 'fill')} className="rounded-lg bg-primary/10 px-3 py-1.5 text-xs text-primary disabled:opacity-50">填入文案</button>
              <button disabled={browserBusy} onClick={() => void useDraftBrowser(handoff.id, 'verify')} className="rounded-lg px-3 py-1.5 text-xs hover:bg-background disabled:opacity-50">核对草稿文案</button>
            </>}
            <button onClick={() => void copyContent(handoff)} className="inline-flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs hover:bg-background"><Clipboard size={13} />复制内容</button>
            {handoff.status !== 'user_confirmed_published' && <button onClick={() => void exportPackage(handoff)} className="inline-flex items-center gap-1 rounded-lg bg-primary/10 px-3 py-1.5 text-xs text-primary"><Download size={13} />导出交付包</button>}
            {handoff.status !== 'user_confirmed_published' && (handoff.status === 'handed_off' || handoff.draftReadbackAt !== undefined) && <button onClick={() => void confirmPublished(handoff)} className="inline-flex items-center gap-1 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs text-white"><CheckCircle2 size={13} />确认已在官方端发布</button>}
          </div>
        </article>
      })}
      {handoffs.length === 0 && <div className="py-5 text-center text-sm text-foreground/45">尚未准备小红书发布交接</div>}
    </div>
  </section>
}

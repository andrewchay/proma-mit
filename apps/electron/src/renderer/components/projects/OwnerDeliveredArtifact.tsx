import { useMemo } from 'react'
import { atom, useAtom } from 'jotai'
import type { OwnerManagementDelivery } from '@gravitas/shared'

/** 只导出唯一、完整的HTML代码块；不执行正文，也不根据文件名猜测代码。 */
export function extractDeliveredHtml(content: string): string | null {
  const blocks = [...content.matchAll(/^```html[^\S\r\n]*\r?\n([\s\S]*?)^```[^\S\r\n]*$/gim)]
  if (blocks.length !== 1) return null
  const html = blocks[0]![1]!.trim()
  return /^<!doctype html\s*>/i.test(html) && /<html(?:\s|>)/i.test(html) && /<\/html\s*>$/i.test(html) ? html : null
}

function downloadArtifact(title: string, content: string, extension: 'md' | 'html'): void {
  const filename = `${title.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 100) || '成果'}.${extension}`
  const url = URL.createObjectURL(new Blob([content], { type: extension === 'html' ? 'text/html;charset=utf-8' : 'text/markdown;charset=utf-8' }))
  const link = document.createElement('a')
  link.href = url; link.download = filename
  document.body.appendChild(link); link.click(); link.remove()
  // 给浏览器处理下载的时间，随后释放本地对象URL。
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function OwnerDeliveredArtifact({ item }: { item: OwnerManagementDelivery['items'][number] }): React.ReactElement {
  const html = extractDeliveredHtml(item.content)
  const previewAtom = useMemo(() => atom<{ hash: string; visible: boolean; viewport: 'adaptive' | 'mobile' }>({ hash: '', visible: false, viewport: 'adaptive' }), [])
  const [preview, setPreview] = useAtom(previewAtom)
  const showPreview = preview.hash === item.artifactHash && preview.visible
  const previewHtml = html?.replace(/^<!doctype html\s*>/i, `$&<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; form-action 'none'; base-uri 'none'">`)
  return <section className="space-y-3 rounded-xl bg-background/70 p-4 shadow-sm" aria-label={`已交付：${item.title}`}>
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h4 className="font-medium">{item.title}</h4>
      <div className="flex gap-2">
        <button type="button" className="rounded-lg bg-primary/10 px-3 py-1.5 text-sm text-primary" onClick={() => downloadArtifact(item.title, item.content, 'md')}>下载原文</button>
        {html && <button type="button" className="rounded-lg bg-muted px-3 py-1.5 text-sm" onClick={() => setPreview({ hash: item.artifactHash, visible: !showPreview, viewport: preview.hash === item.artifactHash ? preview.viewport : 'adaptive' })}>{showPreview ? '关闭预览' : '静态预览'}</button>}
        {html && <button type="button" className="rounded-lg bg-primary px-3 py-1.5 text-sm text-primary-foreground" onClick={() => downloadArtifact(item.title, html, 'html')}>下载 HTML</button>}
      </div>
    </div>
    {html && <p className="text-sm text-muted-foreground">源码已保存在本对话中。下载 HTML 后可用浏览器打开；运行验证情况以本次验收记录为准。</p>}
    <div><p className="mb-2 text-xs font-medium text-muted-foreground">成果正文</p><pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted/50 p-3 font-sans text-sm">{item.content}</pre></div>
    {showPreview && previewHtml && <div className="overflow-hidden rounded-xl bg-muted/40 p-2">
      <p className="px-1 pb-2 text-xs text-muted-foreground">静态预览不运行脚本或加载外部资源；交互效果请在可信环境中验证。</p>
      <p className="break-all px-1 pb-2 font-mono text-xs text-muted-foreground" title="用于核对当前预览对应的交付内容">成果标识：{item.artifactHash}</p>
      <div className="mb-2 flex gap-2" aria-label="预览宽度">
        <button type="button" aria-pressed={preview.viewport === 'adaptive'} className="rounded-lg bg-background px-2 py-1 text-xs aria-pressed:bg-primary aria-pressed:text-primary-foreground" onClick={() => setPreview({ ...preview, viewport: 'adaptive' })}>自适应宽度</button>
        <button type="button" aria-pressed={preview.viewport === 'mobile'} className="rounded-lg bg-background px-2 py-1 text-xs aria-pressed:bg-primary aria-pressed:text-primary-foreground" onClick={() => setPreview({ ...preview, viewport: 'mobile' })}>手机宽度</button>
      </div>
      <iframe title={`${item.title} 静态预览`} sandbox="" srcDoc={previewHtml} style={{ width: preview.viewport === 'mobile' ? 'min(100%, 390px)' : '100%', display: 'block', margin: '0 auto', border: 0 }} className="h-[420px] rounded-lg bg-white shadow-sm" />
    </div>}
    <details><summary className="cursor-pointer text-sm text-muted-foreground">验收标准与评审记录</summary>
      <div className="mt-3 space-y-3">
        <ul className="list-disc pl-5">{item.acceptanceCriteria.map((criterion, index) => <li key={`${index}-${criterion}`}>{criterion}</li>)}</ul>
        <p><span className="font-medium">Owner验收：</span>{item.ownerDecision}</p>
        <p><span className="font-medium">独立评审：</span>{item.reviewerSummary}</p>
      </div>
    </details>
  </section>
}

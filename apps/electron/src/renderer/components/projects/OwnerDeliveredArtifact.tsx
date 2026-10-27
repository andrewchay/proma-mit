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
  return <section className="space-y-3 rounded-xl bg-background/70 p-4 shadow-sm" aria-label={`已交付：${item.title}`}>
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h4 className="font-medium">{item.title}</h4>
      <div className="flex gap-2">
        <button type="button" className="rounded-lg bg-primary/10 px-3 py-1.5 text-sm text-primary" onClick={() => downloadArtifact(item.title, item.content, 'md')}>下载原文</button>
        {html && <button type="button" className="rounded-lg bg-primary px-3 py-1.5 text-sm text-primary-foreground" onClick={() => downloadArtifact(item.title, html, 'html')}>下载 HTML</button>}
      </div>
    </div>
    {html && <p className="text-sm text-muted-foreground">源码已保存在本对话中。下载 HTML 后可用浏览器打开；运行验证情况以本次验收记录为准。</p>}
    <div><p className="mb-2 text-xs font-medium text-muted-foreground">成果正文</p><pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted/50 p-3 font-sans text-sm">{item.content}</pre></div>
    <details><summary className="cursor-pointer text-sm text-muted-foreground">验收标准与评审记录</summary>
      <div className="mt-3 space-y-3">
        <ul className="list-disc pl-5">{item.acceptanceCriteria.map((criterion, index) => <li key={`${index}-${criterion}`}>{criterion}</li>)}</ul>
        <p><span className="font-medium">Owner验收：</span>{item.ownerDecision}</p>
        <p><span className="font-medium">独立评审：</span>{item.reviewerSummary}</p>
      </div>
    </details>
  </section>
}

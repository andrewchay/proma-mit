import { useEffect, useMemo, useRef } from 'react'
import { atom, useAtom } from 'jotai'
import type { OwnerDeliveryValidationRecord, OwnerManagementDelivery } from '@gravitas/shared'
import { buildSelectableDesignPreview, parseDesignPreviewSelection } from './design-preview-selection'

/** 只导出唯一、完整的HTML代码块；不执行正文，也不根据文件名猜测代码。 */
export function extractDeliveredHtml(content: string): string | null {
  const blocks = [...content.matchAll(/^```html[^\S\r\n]*\r?\n([\s\S]*?)^```[^\S\r\n]*$/gim)]
  if (blocks.length !== 1) return null
  const html = blocks[0]![1]!.trim()
  return /^<!doctype html\s*>/i.test(html) && /<html(?:\s|>)/i.test(html) && /<\/html\s*>$/i.test(html) ? html : null
}

interface DeliveredCodeFile { path: string; changeType: 'add' | 'modify' | 'delete'; content: string | null }
/** 研发成果由主进程在写入对话时核验快照与文件摘要；这里仅解析已绑定版本的展示。 */
export function extractDeliveredCodeFiles(content: string, artifactHash: string): DeliveredCodeFile[] | null {
  try {
    const value: unknown = JSON.parse(content)
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const snapshot = value as { contentHash?: unknown; executionId?: unknown; workspaceId?: unknown; baseCommit?: unknown; files?: unknown }
    if (snapshot.contentHash !== artifactHash || !/^[a-f0-9]{64}$/.test(artifactHash) || typeof snapshot.executionId !== 'string' || !snapshot.executionId
      || typeof snapshot.workspaceId !== 'string' || !snapshot.workspaceId || typeof snapshot.baseCommit !== 'string' || !/^[a-f0-9]{40,64}$/.test(snapshot.baseCommit)
      || !Array.isArray(snapshot.files) || !snapshot.files.length || snapshot.files.length > 100) return null
    const files: DeliveredCodeFile[] = [], seen = new Set<string>()
    for (const raw of snapshot.files as unknown[]) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
      const entry = raw as { file?: unknown; newContent?: unknown }
      if (!entry.file || typeof entry.file !== 'object' || Array.isArray(entry.file)) return null
      const { path, changeType } = entry.file as { path?: unknown; changeType?: unknown }
      if (typeof path !== 'string' || !path || path.startsWith('/') || path.includes('\\') || path.includes('\0') || path.split('/').some(segment => !segment || segment === '.' || segment === '..') || seen.has(path)
        || (changeType !== 'add' && changeType !== 'modify' && changeType !== 'delete')
        || (changeType === 'delete' ? entry.newContent !== null : typeof entry.newContent !== 'string')) return null
      seen.add(path); files.push({ path, changeType, content: entry.newContent as string | null })
    }
    return files
  } catch { return null }
}

function downloadCodeFile(file: DeliveredCodeFile): void {
  if (file.content === null) return
  const filename = file.path.split('/').at(-1)!.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 200) || '成果文件'
  const url = URL.createObjectURL(new Blob([file.content], { type: 'text/plain;charset=utf-8' }))
  const link = document.createElement('a')
  link.href = url; link.download = filename
  document.body.appendChild(link); link.click(); link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
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

function ValidationRecords({ validation }: { validation: OwnerDeliveryValidationRecord }): React.ReactElement {
  const freshnessLabels = { fresh: '来源当前一致', stale: '来源已变化', legacy: '旧记录缺少来源绑定', unknown: '来源无法核对' }
  return <div aria-label="版本验证记录"><p className="font-medium">版本验证记录</p><ul className="mt-1 space-y-2">{validation.validations.map(record => <li key={`${record.command}-${record.outputSha256}`} className="break-words text-xs">
    <p>{record.method === 'browser_assertions' ? '浏览器断言' : record.method === 'command' ? '命令验证' : '验证方式未核对'}：{record.command}</p>
    <p>记录结果：{record.status === 'passed' ? '通过' : record.status} · {record.expired ? '核对时证据已过期' : record.finishedAt === undefined ? '证据时效未知' : '核对时证据未过期'} · {freshnessLabels[record.freshness]}{record.finishedAt === undefined ? '' : ` · ${new Date(record.finishedAt).toLocaleString('zh-CN')}`}</p>
    {record.checks && <ul className="mt-1 list-disc pl-5">{record.checks.map(check => <li key={check.id}>{check.title}：{check.status === 'passed' ? '通过' : check.status === 'failed' ? '失败' : '未执行'} · {check.detail}</li>)}</ul>}
    <p className="break-all font-mono text-muted-foreground">输出摘要：{record.outputSha256}</p>
  </li>)}</ul><p className="mt-2 text-xs text-muted-foreground">以上为绑定该版本的历史验证记录，上次核对：{new Date(validation.checkedAt).toLocaleString('zh-CN')}。</p></div>
}

export function OwnerDeliveredArtifact({ item, validation, onRequestChanges, feedbackDisabled = false, feedbackCapacity = 4000, source = 'conversation' }: { item: OwnerManagementDelivery['items'][number]; validation?: OwnerDeliveryValidationRecord; onRequestChanges?: (excerpt?: string, intent?: 'question' | 'change') => void; feedbackDisabled?: boolean; feedbackCapacity?: number; source?: 'conversation' | 'chain' }): React.ReactElement {
  const html = extractDeliveredHtml(item.content)
  const codeFiles = source === 'conversation' ? extractDeliveredCodeFiles(item.content, item.artifactHash) : null
  const previewAtom = useMemo(() => atom<{ hash: string; visible: boolean; viewport: 'adaptive' | 'mobile' }>({ hash: '', visible: false, viewport: 'adaptive' }), [])
  const [preview, setPreview] = useAtom(previewAtom)
  const selectionAtom = useMemo(() => atom<{ hash: string; text: string; tooLong: boolean }>({ hash: '', text: '', tooLong: false }), [])
  const [selection, setSelection] = useAtom(selectionAtom)
  const contentRef = useRef<HTMLPreElement>(null)
  const frameRef = useRef<HTMLIFrameElement>(null)
  // biome-ignore lint/correctness/useExhaustiveDependencies: 每个成果版本使用独立的预览令牌。
  const token = useMemo(() => crypto.randomUUID(), [item.artifactHash])
  useEffect(() => {
    const onMessage = (event: MessageEvent): void => {
      const value = parseDesignPreviewSelection(event, frameRef.current?.contentWindow ?? null, token)
      if (value) setSelection({ hash: item.artifactHash, text: value.text, tooLong: false })
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [item.artifactHash, setSelection, token])
  const captureSelection = (): void => {
    const selected = window.getSelection()
    const root = contentRef.current
    if (!root || !selected || selected.rangeCount !== 1 || !selected.anchorNode || !selected.focusNode || !root.contains(selected.anchorNode) || !root.contains(selected.focusNode)) return
    const text = selected.toString().trim()
    setSelection({ hash: item.artifactHash, text: text.length <= 300 ? text : '', tooLong: text.length > 300 })
  }
  const showPreview = preview.hash === item.artifactHash && preview.visible
  const previewHtml = useMemo(() => showPreview && html ? buildSelectableDesignPreview(html, token) : null, [showPreview, html, token])
  return <section className="space-y-3 rounded-xl bg-background/70 p-4 shadow-sm" aria-label={`已交付：${item.title}`}>
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h4 className="font-medium">{item.title}</h4>
      <div className="flex gap-2">
        <button type="button" className="rounded-lg bg-primary/10 px-3 py-1.5 text-sm text-primary" onClick={() => downloadArtifact(item.title, item.content, 'md')}>下载原文</button>
        {html && <button type="button" className="rounded-lg bg-muted px-3 py-1.5 text-sm" onClick={() => setPreview({ hash: item.artifactHash, visible: !showPreview, viewport: preview.hash === item.artifactHash ? preview.viewport : 'adaptive' })}>{showPreview ? '关闭预览' : '静态预览'}</button>}
        {onRequestChanges && source === 'conversation' && <button type="button" disabled={feedbackDisabled} className="rounded-lg bg-primary/10 px-3 py-1.5 text-sm text-primary disabled:opacity-50" onClick={() => onRequestChanges()}>针对这个版本提出修改</button>}
        {html && <button type="button" className="rounded-lg bg-primary px-3 py-1.5 text-sm text-primary-foreground" onClick={() => downloadArtifact(item.title, html, 'html')}>下载 HTML</button>}
      </div>
    </div>
    <section className="space-y-2 rounded-lg bg-muted/40 p-3 text-sm" aria-label="当前成果版本与审阅依据">
      <p className="break-all text-xs text-muted-foreground">成果版本：<span className="font-mono">{item.artifactHash}</span></p>
      <div><p className="font-medium">完成标准</p>{item.acceptanceCriteria.length ? <ul className="mt-1 list-disc pl-5">{item.acceptanceCriteria.map((criterion, index) => <li key={`${index}-${criterion}`}>{criterion}</li>)}</ul> : <p className="mt-1 text-muted-foreground">此版本未附带完成标准。</p>}</div>
      <p><span className="font-medium">独立评审：</span>{item.reviewerSummary || '未附带评审摘要'}</p>
      <p><span className="font-medium">Owner 内部审阅：</span>{item.ownerDecision || '未附带审阅摘要'}</p>
      {validation?.unavailable ? <p role="alert" className="text-xs text-destructive">当前研发成果的验证来源无法核对，不能据此认可通过。</p> : validation?.validations.length ? <ValidationRecords validation={validation} /> : <p className="text-xs text-muted-foreground">本卡片未展示独立的运行或浏览器验证记录；不能据此认定运行验证通过。</p>}
    </section>
    {codeFiles && <section aria-label="代码成果文件" className="space-y-2 rounded-lg bg-muted/40 p-3 text-sm"><p className="font-medium">代码成果文件</p><p className="text-xs text-muted-foreground">按路径分别下载；如文件相互引用，请保留显示的相对目录结构。删除项仅记录变化，不提供文件下载。</p><ul className="space-y-2">{codeFiles.map(file => <li key={file.path} className="flex flex-wrap items-center justify-between gap-2"><span className="break-all font-mono text-xs">{file.path} · {file.changeType === 'add' ? '新增' : file.changeType === 'modify' ? '修改' : '删除'}</span>{file.content !== null && <button type="button" className="rounded-lg bg-primary/10 px-3 py-1.5 text-xs text-primary" onClick={() => downloadCodeFile(file)}>下载文件</button>}</li>)}</ul></section>}
    {html && <p className="text-sm text-muted-foreground">源码已保存在{source === 'chain' ? '项目交付记录' : '本对话'}中。下载 HTML 后可用浏览器打开；运行验证情况以当前版本的验证记录为准。</p>}
    <div><p className="mb-2 text-xs font-medium text-muted-foreground">成果正文</p><pre ref={contentRef} onMouseUp={captureSelection} onKeyUp={captureSelection} className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted/50 p-3 font-sans text-sm">{item.content}</pre>{selection.hash === item.artifactHash && selection.tooLong && <p className="mt-2 text-xs text-destructive">选中片段超过 300 字，请缩小选区。</p>}{onRequestChanges && selection.hash === item.artifactHash && selection.text && <div className="mt-2 space-y-2 rounded-lg bg-primary/5 p-3"><p className="text-xs text-muted-foreground">已选中内容，可连同本成果版本提问或提交修改意见。</p><p className="break-words text-sm">{selection.text}</p><button type="button" disabled={feedbackDisabled || selection.text.length + 20 > feedbackCapacity} className="rounded-lg bg-primary/10 px-3 py-1.5 text-sm text-primary disabled:opacity-50" onClick={() => onRequestChanges(selection.text)}>针对选中内容提出修改</button><button type="button" disabled={feedbackDisabled || selection.text.length + 20 > feedbackCapacity} className="ml-2 rounded-lg bg-muted px-3 py-1.5 text-sm disabled:opacity-50" onClick={() => onRequestChanges(selection.text, 'question')}>针对选中内容提问</button>{selection.text.length + 20 > feedbackCapacity && <p className="text-xs text-destructive">当前草稿空间不足，请精简后再引用。</p>}</div>}</div>
    {showPreview && previewHtml && <div className="overflow-hidden rounded-xl bg-muted/40 p-2">
      <p className="px-1 pb-2 text-xs text-muted-foreground">静态预览不运行成果脚本或加载外部资源；点击画面文字可选择反馈片段。交互效果请在可信环境中验证。</p>
      <p className="break-all px-1 pb-2 font-mono text-xs text-muted-foreground" title="用于核对当前预览对应的交付内容">成果标识：{item.artifactHash}</p>
      <div className="mb-2 flex gap-2" aria-label="预览宽度">
        <button type="button" aria-pressed={preview.viewport === 'adaptive'} className="rounded-lg bg-background px-2 py-1 text-xs aria-pressed:bg-primary aria-pressed:text-primary-foreground" onClick={() => setPreview({ ...preview, viewport: 'adaptive' })}>自适应宽度</button>
        <button type="button" aria-pressed={preview.viewport === 'mobile'} className="rounded-lg bg-background px-2 py-1 text-xs aria-pressed:bg-primary aria-pressed:text-primary-foreground" onClick={() => setPreview({ ...preview, viewport: 'mobile' })}>手机宽度</button>
      </div>
      <iframe ref={frameRef} title={`${item.title} 静态预览`} sandbox="allow-scripts" srcDoc={previewHtml} style={{ width: preview.viewport === 'mobile' ? 'min(100%, 390px)' : '100%', display: 'block', margin: '0 auto', border: 0 }} className="h-[420px] rounded-lg bg-white shadow-sm" />
    </div>}
  </section>
}

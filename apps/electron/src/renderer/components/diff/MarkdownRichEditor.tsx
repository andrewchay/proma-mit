import * as React from 'react'
import { ChevronDown, ChevronUp, ListTree, Search, X } from 'lucide-react'
import type { FileAccessOptions } from '@gravitas/shared'
import {
  LiveMarkdownEditor,
  type LiveMarkdownEditorHandle,
} from '@/components/markdown/LiveMarkdownEditor'
import { extractLiveMarkdownHeadings } from '@/components/markdown/live-markdown-navigation'
import { cn } from '@/lib/utils'

interface MarkdownRichEditorProps {
  value: string
  editing: boolean
  onChange: (value: string) => void
  onSave: () => void
  onCancel: () => void
  onRequestEdit?: () => void
  disabled?: boolean
  fileAccess?: FileAccessOptions
  shikiTheme?: string
}

/** 文件预览的 LiveMarkdown 适配层；文件读写仍由 DiffTabContent 权限边界负责。 */
export function MarkdownRichEditor({
  value,
  editing,
  onChange,
  onSave,
  onCancel,
  onRequestEdit,
  disabled,
}: MarkdownRichEditorProps): React.ReactElement {
  const editorRef = React.useRef<LiveMarkdownEditorHandle>(null)
  const searchInputRef = React.useRef<HTMLInputElement>(null)
  const [searchOpen, setSearchOpen] = React.useState(false)
  const [tocOpen, setTocOpen] = React.useState(false)
  const [query, setQuery] = React.useState('')
  const [matchCount, setMatchCount] = React.useState(0)
  const [activeMatch, setActiveMatch] = React.useState(0)
  const readOnly = !editing || Boolean(disabled)
  const headings = React.useMemo(() => extractLiveMarkdownHeadings(value), [value])

  React.useEffect(() => {
    if (!readOnly) editorRef.current?.focus()
  }, [readOnly])

  // biome-ignore lint/correctness/useExhaustiveDependencies: value 变化时需重算当前文档的匹配计数（输入即刷新）
  React.useEffect(() => {
    const handle = editorRef.current
    if (!handle) return
    if (!searchOpen || !query) {
      handle.clearFindMatches()
      setMatchCount(0)
      return
    }
    const count = handle.setFindMatches(query, { caseSensitive: false, wholeWord: false, regex: false }, activeMatch)
    setMatchCount(count)
    if (count > 0 && activeMatch >= count) setActiveMatch(count - 1)
  }, [activeMatch, query, searchOpen, value])

  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f') {
        event.preventDefault()
        setSearchOpen(true)
        requestAnimationFrame(() => searchInputRef.current?.focus())
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  const moveMatch = (delta: number): void => {
    if (matchCount === 0) return
    const next = (activeMatch + delta + matchCount) % matchCount
    setActiveMatch(next)
    editorRef.current?.setActiveFindMatch(next)
  }

  return (
    <div
      className="relative h-full min-h-0 overflow-hidden bg-content-area"
      onDoubleClick={() => { if (readOnly && !disabled) onRequestEdit?.() }}
      data-live-markdown-mode={readOnly ? 'preview' : 'editing'}
    >
      <div className="absolute right-3 top-2 z-20 flex items-center gap-1 rounded-xl bg-background/85 p-1 shadow-lg ring-1 ring-border/40 backdrop-blur">
        <button type="button" onClick={() => setSearchOpen((open) => !open)} className={cn('live-markdown-tool', searchOpen && 'is-active')} title="查找（⌘F）">
          <Search className="size-3.5" />
        </button>
        <button type="button" onClick={() => setTocOpen((open) => !open)} className={cn('live-markdown-tool', tocOpen && 'is-active')} title="文档目录">
          <ListTree className="size-3.5" />
        </button>
      </div>

      {searchOpen && (
        <div className="absolute right-3 top-12 z-20 flex items-center gap-1 rounded-xl bg-background/95 p-1.5 shadow-xl ring-1 ring-border/50 backdrop-blur">
          <input
            ref={searchInputRef}
            value={query}
            onChange={(event) => { setQuery(event.target.value); setActiveMatch(0) }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') moveMatch(event.shiftKey ? -1 : 1)
              if (event.key === 'Escape') setSearchOpen(false)
            }}
            className="h-7 w-44 bg-transparent px-2 text-xs outline-none"
            placeholder="查找文档"
          />
          <span className="min-w-12 text-center text-[10px] tabular-nums text-muted-foreground">
            {matchCount ? `${activeMatch + 1}/${matchCount}` : '0/0'}
          </span>
          <button type="button" className="live-markdown-tool" onClick={() => moveMatch(-1)}><ChevronUp className="size-3.5" /></button>
          <button type="button" className="live-markdown-tool" onClick={() => moveMatch(1)}><ChevronDown className="size-3.5" /></button>
          <button type="button" className="live-markdown-tool" onClick={() => setSearchOpen(false)}><X className="size-3.5" /></button>
        </div>
      )}

      {tocOpen && (
        <aside className="absolute left-3 top-3 bottom-3 z-20 w-56 overflow-y-auto rounded-2xl bg-background/94 p-2 shadow-2xl ring-1 ring-border/50 backdrop-blur">
          <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">文档目录</div>
          {headings.length > 0 ? headings.map((heading) => (
            <button
              key={`${heading.position}:${heading.text}`}
              type="button"
              onClick={() => { editorRef.current?.scrollToPosition(heading.position); setTocOpen(false) }}
              className="block w-full truncate rounded-lg py-1.5 pr-2 text-left text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
              style={{ paddingLeft: `${8 + (heading.level - 1) * 10}px` }}
              title={heading.text}
            >
              {heading.text}
            </button>
          )) : <p className="px-2 py-4 text-xs text-muted-foreground">当前文档没有标题</p>}
        </aside>
      )}

      <LiveMarkdownEditor
        ref={editorRef}
        value={value}
        onChange={onChange}
        onSave={onSave}
        onCancel={onCancel}
        readOnly={readOnly}
        className="h-full"
      />
    </div>
  )
}

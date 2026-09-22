/**
 * NoteMarkdownView — 知识库笔记只读渲染
 *
 * 替代通用文件预览的 CodeMirror 渲染（那是为代码审阅设计的 live 编辑器，
 * 阅读排版与双链支持都弱），面向笔记阅读场景做三件事：
 *
 * 1. **[[双链]] 可点击**：正文中的 wikilink 渲染为 chip，点击跳转目标笔记；
 * 2. **内联 HTML 安全渲染**：Markdown 中的 HTML 经 rehype-raw + DOMPurify 净化；
 * 3. **.html 笔记直接渲染正文**：索引层已剔除 script/style，渲染层再净化一次。
 *
 * 排版统一走 @tailwindcss/typography 的 prose，与聊天消息同一视觉语言。
 */
import * as React from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeRaw from 'rehype-raw'
import DOMPurify from 'dompurify'
import { Link2 } from 'lucide-react'
import { CodeBlock } from '@gravitas/ui'
import type { KnowledgeNote } from '@gravitas/shared'

/** wikilink 前缀：避开真实 URL 空间，a 组件据此路由到笔记导航 */
const WIKILINK_PREFIX = '#wikilink/'

/** [[target]] / [[target|alias]] → markdown 链接（alias 缺省用 target） */
const WIKILINK_RE = /\[\[([^\][|]+?)(?:\|([^\][]+?))?\]\]/g

function wikilinkToMd(content: string): string {
  return content.replace(WIKILINK_RE, (_m, target: string, alias?: string) => {
    const t = target.trim()
    if (!t) return ''
    const label = (alias ?? target).trim()
    return `[${label}](${WIKILINK_PREFIX}${encodeURIComponent(t)})`
  })
}

interface NoteMarkdownViewProps {
  note: KnowledgeNote
  /** 点击正文双链时跳转（由父组件按标题解析目标笔记） */
  onOpenLinked: (title: string) => void
}

export function NoteMarkdownView({ note, onOpenLinked }: NoteMarkdownViewProps): React.ReactElement {
  const isHtml = note.filePath.toLowerCase().endsWith('.html')

  // HTML 笔记：索引层已剔除 script/style/head，这里经 DOMPurify 二次净化后渲染
  const sanitizedHtml = React.useMemo(
    () => (isHtml ? DOMPurify.sanitize(note.rawContent || note.content) : ''),
    [isHtml, note.rawContent, note.content],
  )

  // Markdown 笔记：双链转为内部链接协议，由自定义 a 组件渲染成 chip
  const mdContent = React.useMemo(
    () => (isHtml ? '' : wikilinkToMd(note.content)),
    [isHtml, note.content],
  )

  const mdComponents = React.useMemo(
    () => ({
      a: ({ href, children }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => {
        if (href?.startsWith(WIKILINK_PREFIX)) {
          const target = decodeURIComponent(href.slice(WIKILINK_PREFIX.length))
          return (
            <button
              type="button"
              onClick={() => onOpenLinked(target)}
              className="inline-flex items-center gap-1 px-1.5 py-px rounded bg-primary/10 text-primary text-[0.85em] align-baseline hover:bg-primary/20 transition-colors"
              title={`打开笔记「${target}」`}
            >
              <Link2 size={11} />
              {children}
            </button>
          )
        }
        return (
          <a
            href={href}
            onClick={(e) => {
              e.preventDefault()
              if (href && (href.startsWith('http://') || href.startsWith('https://'))) {
                void window.electronAPI.openExternal(href)
              }
            }}
            title={href}
          >
            {children}
          </a>
        )
      },
      pre: ({ children }: React.HTMLAttributes<HTMLPreElement>) => (
        <CodeBlock>{children}</CodeBlock>
      ),
    }),
    [onOpenLinked],
  )

  if (isHtml) {
    return (
      <div className="h-full min-h-0 overflow-y-auto px-6 py-5">
        <article
          className="prose prose-sm dark:prose-invert max-w-none prose-a:text-primary"
          // 内容已经过索引层剔除 + DOMPurify 净化，不含 script/事件属性
          dangerouslySetInnerHTML={{ __html: sanitizedHtml }}
        />
      </div>
    )
  }

  return (
    <div className="h-full min-h-0 overflow-y-auto px-6 py-5">
      <article className="prose prose-sm dark:prose-invert max-w-none prose-a:text-primary">
        <Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeRaw]} components={mdComponents}>
          {mdContent}
        </Markdown>
      </article>
    </div>
  )
}

export default NoteMarkdownView

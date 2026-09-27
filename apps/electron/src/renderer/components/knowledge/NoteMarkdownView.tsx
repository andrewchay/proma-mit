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
import Markdown, { defaultUrlTransform } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeRaw from 'rehype-raw'
import rehypeKatex from 'rehype-katex'
import DOMPurify from 'dompurify'
import { Link2 } from 'lucide-react'
import { CodeBlock } from '@gravitas/ui'
import type { KnowledgeNote } from '@gravitas/shared'
import type { NoteLinkKind } from './note-navigation'

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

/** 在代码围栏和行内代码以外转换 Obsidian 双链及常见 LaTeX 定界符。 */
export function prepareNoteMarkdown(content: string): string {
  const transformPlain = (text: string): string => wikilinkToMd(
    text
      .replace(/\\\[([\s\S]*?)\\\]/g, (_match, math: string) => `\n$$\n${math.trim()}\n$$\n`)
      .replace(/\\\(([^\n]*?)\\\)/g, (_match, math: string) => `$${math}$`),
  )

  const transformOutsideInlineCode = (text: string): string => {
    const codeSpan = /(`+)([\s\S]*?)\1/g
    let result = ''
    let lastIndex = 0
    for (const match of text.matchAll(codeSpan)) {
      result += transformPlain(text.slice(lastIndex, match.index)) + match[0]
      lastIndex = match.index + match[0].length
    }
    return result + transformPlain(text.slice(lastIndex))
  }

  let result = ''
  let plain = ''
  let fence: { marker: string; length: number } | null = null
  for (const line of content.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})/)
    if (!fence && marker) {
      result += transformOutsideInlineCode(plain) + line
      plain = ''
      fence = { marker: marker[1]![0]!, length: marker[1]!.length }
    } else if (fence) {
      result += line
      if (marker && marker[1]![0] === fence.marker && marker[1]!.length >= fence.length) {
        fence = null
      }
    } else {
      plain += line
    }
  }
  return result + transformOutsideInlineCode(plain)
}

interface NoteMarkdownViewProps {
  note: KnowledgeNote
  /** 点击正文双链时跳转（由父组件按标题解析目标笔记） */
  onOpenLinked: (target: string, kind: NoteLinkKind) => void
  fragmentTarget?: { noteId: string; fragment: string } | null
}

export function NoteMarkdownView({ note, onOpenLinked, fragmentTarget }: NoteMarkdownViewProps): React.ReactElement {
  const isHtml = note.filePath.toLowerCase().endsWith('.html')
  const contentRef = React.useRef<HTMLDivElement>(null)

  React.useEffect(() => {
    if (!fragmentTarget || fragmentTarget.noteId !== note.id) return
    const slug = (value: string): string => value.trim().toLowerCase().replace(/\s+/g, '-')
    const fragment = fragmentTarget.fragment.trim().toLowerCase()
    const target = Array.from(
      contentRef.current?.querySelectorAll<HTMLElement>('[id], h1, h2, h3, h4, h5, h6') ?? [],
    ).find((element) =>
      element.id.toLowerCase() === fragment || slug(element.textContent ?? '') === slug(fragment),
    )
    target?.scrollIntoView({ block: 'start' })
  }, [fragmentTarget, note.id])

  // HTML 笔记：索引层已剔除 script/style/head，这里经 DOMPurify 二次净化后渲染
  const sanitizedHtml = React.useMemo(
    () => (isHtml ? DOMPurify.sanitize(note.rawContent || note.content) : ''),
    [isHtml, note.rawContent, note.content],
  )

  // Markdown 笔记：双链转为内部链接协议，由自定义 a 组件渲染成 chip
  const mdContent = React.useMemo(
    () => (isHtml ? '' : prepareNoteMarkdown(note.content)),
    [isHtml, note.content],
  )

  const openHref = React.useCallback((href: string, kind: NoteLinkKind): void => {
    if (/^https?:\/\//i.test(href)) {
      void window.electronAPI.openExternal(href)
    } else if (!/^[a-z][a-z\d+.-]*:/i.test(href) && !href.startsWith('//')) {
      onOpenLinked(href, kind)
    }
  }, [onOpenLinked])

  const mdComponents = React.useMemo(
    () => ({
      a: ({ href, children }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => {
        if (href?.startsWith(WIKILINK_PREFIX)) {
          const target = decodeURIComponent(href.slice(WIKILINK_PREFIX.length))
          return (
            <button
              type="button"
              onClick={() => onOpenLinked(target, 'wiki')}
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
              if (href) openHref(href, 'markdown')
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
    [onOpenLinked, openHref],
  )

  if (isHtml) {
    return (
      <div ref={contentRef} className="h-full min-h-0 overflow-y-auto px-6 py-5">
        <article
          className="prose prose-sm dark:prose-invert max-w-none prose-a:text-primary"
          onClick={(event) => {
            const anchor = (event.target as HTMLElement).closest('a')
            const href = anchor?.getAttribute('href')
            if (!href) return
            event.preventDefault()
            openHref(href, 'markdown')
          }}
          // 内容已经过索引层剔除 + DOMPurify 净化，不含 script/事件属性
          dangerouslySetInnerHTML={{ __html: sanitizedHtml }}
        />
      </div>
    )
  }

  return (
    <div ref={contentRef} className="h-full min-h-0 overflow-y-auto px-6 py-5">
      <article className="prose prose-sm dark:prose-invert max-w-none prose-a:text-primary">
        <Markdown
          remarkPlugins={[remarkGfm, remarkMath]}
          rehypePlugins={[rehypeRaw, rehypeKatex]}
          components={mdComponents}
          // react-markdown v10 默认 urlTransform 只允许 http/https 等协议，
          // 会把 #wikilink/ 前缀的 href 清空导致双链点击失效；这里放行内部链接，
          // 其余链接仍走默认白名单净化
          urlTransform={(url) =>
            url.startsWith(WIKILINK_PREFIX) ? url : defaultUrlTransform(url)
          }
        >
          {mdContent}
        </Markdown>
      </article>
    </div>
  )
}

export default NoteMarkdownView

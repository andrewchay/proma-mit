/**
 * HTML 笔记解析（知识库 .html 文件支持）
 *
 * 免费版索引只读：把 .html 文件转成与 ParsedNote 对齐的结构，
 * 让搜索、图谱与阅读视图都能统一处理 Markdown 与 HTML 笔记。
 *
 * 实现约束：不引入 DOM 依赖（主进程无 DOM），用保守的正则剥离；
 * 净化责任在渲染层（DOMPurify），这里只剔除 script/style/注释与 head。
 */
import { extractWikilinks, extractTags, countWords } from './index'

/** 块级标签：转文本时替换为换行，保留基本段落结构 */
const BLOCK_TAG_RE = /<\/?(p|div|br|hr|h[1-6]|li|ul|ol|table|tr|section|article|header|footer|blockquote|pre|figure|figcaption|nav|aside|main)[^>]*>/gi

/** 行内脚本/事件属性：正文 HTML 展示前剔除，避免悬停即执行 */
const EVENT_HANDLER_RE = /\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi

export interface ParsedHtmlNote {
  /** <title> > 首个 <h1> > 文件名 */
  title: string
  /** 净化后的可读文本：用于全文搜索、Agent 上下文与字数统计 */
  text: string
  /** 正文 HTML（script/style/head/事件属性已剔除），渲染层仍须经 DOMPurify */
  bodyHtml: string
  /** 正文中的 [[wikilink]]（HTML 笔记同样支持双链） */
  links: string[]
  /** <meta name="keywords"> 与正文 #tag */
  tags: string[]
  wordCount: number
}

/** 剔除 script/style/注释/head，返回剩余的 body HTML */
function stripNonBody(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<head[\s\S]*?<\/head>/gi, '')
    .replace(EVENT_HANDLER_RE, '')
    .trim()
}

/** HTML → 纯文本：块级标签转换行、其余标签剔除、实体最小转义、空白折叠 */
export function htmlToText(html: string): string {
  const text = stripNonBody(html)
    .replace(BLOCK_TAG_RE, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
  return text
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
    .trim()
}

/** 从原始 HTML 提取标题：<title> > 首个 <h1> > 文件名 */
function extractHtmlTitle(html: string, fileName: string): string {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]
  if (title && title.trim()) return title.trim()
  const h1 = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html)?.[1]
  if (h1) {
    const plain = h1.replace(/<[^>]+>/g, '').trim()
    if (plain) return plain
  }
  return fileName
}

/** <meta name="keywords" content="a, b"> → 标签数组 */
function extractMetaKeywords(html: string): string[] {
  const content = /<meta[^>]+name=["']keywords["'][^>]+content=["']([^"']*)["']/i.exec(html)?.[1]
    ?? /<meta[^>]+content=["']([^"']*)["'][^>]+name=["']keywords["']/i.exec(html)?.[1]
  if (!content) return []
  return content
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

/** 解析 .html 文件内容为结构化笔记（与 parseNote 对齐） */
export function parseHtmlNote(rawHtml: string, fileName: string): ParsedHtmlNote {
  const text = htmlToText(rawHtml)
  const bodyHtml = (() => {
    const stripped = stripNonBody(rawHtml)
    const body = /<body[^>]*>([\s\S]*?)<\/body>/i.exec(stripped)?.[1]
    return (body ?? stripped).trim()
  })()

  return {
    title: extractHtmlTitle(rawHtml, fileName),
    text,
    bodyHtml,
    links: extractWikilinks(rawHtml),
    tags: [...new Set([...extractMetaKeywords(rawHtml), ...extractTags(text)])],
    wordCount: countWords(text),
  }
}

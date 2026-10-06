import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { KnowledgeNote } from '@gravitas/shared'
import { NoteMarkdownView, prepareNoteMarkdown } from './NoteMarkdownView'

function renderNote(content: string): string {
  const note: KnowledgeNote = {
    id: 'note', vaultId: 'vault', filePath: 'docs/笔记.md', title: '笔记',
    content, rawContent: content, tags: [], links: [], backlinks: [], frontmatter: {},
    wordCount: 0, createdAt: '', updatedAt: '', indexedAt: '',
  }
  return renderToStaticMarkup(<NoteMarkdownView note={note} onOpenLinked={() => {}} />)
}

describe('知识库 Markdown 阅读', () => {
  test('渲染美元符号与 LaTeX 括号定界的行内和块级公式', () => {
    const html = renderNote('行内 $x^2$ 与 \\(y^2\\)。\n\n\\[\\frac{a}{b}\\]')
    expect(html.match(/class="katex"/g)?.length).toBe(3)
    expect(html).toContain('katex-display')
  })

  test('代码中的双链和公式原样保留，正文双链仍可点击', () => {
    const content = '[[目标|别名]] 与 `\\(x\\)`\n\n```md\n[[代码]] \\[y\\]\n```'
    expect(prepareNoteMarkdown(content)).toContain('`\\(x\\)`')
    expect(prepareNoteMarkdown(content)).toContain('[[代码]] \\[y\\]')
    const html = renderNote(content)
    expect(html).toContain('打开笔记')
    expect(html).toContain('别名')
    expect(html).toContain('[[代码]]')
  })

  test('普通相对链接保留目标地址供阅读器导航', () => {
    const html = renderNote('[下一篇](../research/%E6%A1%88%E4%BE%8B.md#结论)')
    expect(html).toContain('href="../research/%E6%A1%88%E4%BE%8B.md#%E7%BB%93%E8%AE%BA"')
  })
})

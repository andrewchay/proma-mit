import { describe, expect, test } from 'bun:test'
import { COMPANION_MARKDOWN_JS, loadMarkdownRenderer } from './companion-markdown-js'

/**
 * Companion Markdown 渲染器测试（执行与页面注入完全相同的 JS 源码）
 * 重点：防 XSS（先转义后变换）、围栏代码块、白名单链接。
 */

const md = loadMarkdownRenderer()

describe('companion-markdown 注入安全', () => {
  test('源码不含 </script（保证可安全注入页面 <script> 标签）', () => {
    expect(COMPANION_MARKDOWN_JS.includes('</script')).toBe(false)
  })
})

describe('renderMarkdown 基础语法', () => {
  test('标题/粗体/行内码/列表', () => {
    const html = md('# 标题\n\n这是 **加粗** 和 `code` 内容\n\n- 第一项\n- 第二项\n\n1. 有序\n2. 第二条')
    expect(html).toContain('<h1>标题</h1>')
    expect(html).toContain('<strong>加粗</strong>')
    expect(html).toContain('<code>code</code>')
    expect(html).toContain('<ul><li>第一项</li><li>第二项</li></ul>')
    expect(html).toContain('<ol><li>有序</li><li>第二条</li></ol>')
  })

  test('围栏代码块整体转义并保留语言标记', () => {
    const html = md('看这段：\n\n```ts\nconst a = "<div>";\n```')
    expect(html).toContain('class="md-code"')
    expect(html).toContain('lang-ts')
  })

  test('未闭合围栏不吞掉后续内容', () => {
    const html = md('```js\nlet x = 1;\n')
    expect(html).toContain('let x = 1;')
    expect(html).toContain('<pre')
  })

  test('链接仅允许 http(s)，javascript: 不生成 <a>', () => {
    const ok = md('[官网](https://example.com)')
    expect(ok).toContain('<a href="https://example.com"')
    const evil = md('[点我](javascript:alert(1))')
    expect(evil).not.toContain('<a ')
    expect(evil).toContain('javascript:alert(1)')
  })

  test('HTML 注入被转义（先转义后变换的构造保证）', () => {
    const html = md('<img src=x onerror=alert(1)>')
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;img')
  })

  test('空输入返回空字符串', () => {
    expect(md('')).toBe('')
    expect(md(undefined as never)).toBe('')
  })
})

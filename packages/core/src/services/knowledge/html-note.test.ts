import { describe, expect, test } from 'bun:test'
import { parseHtmlNote, htmlToText } from './html-note.ts'

describe('htmlToText', () => {
  test('剔除 script/style/head/注释，块级标签保留段落结构', () => {
    const html = `<!DOCTYPE html>
<html>
<head><title>标题</title><style>body { color: red }</style></head>
<body>
<!-- 注释 -->
<script>alert('x')</script>
<h1>大标题</h1>
<p>第一段　文字</p>
<ul><li>甲</li><li>乙</li></ul>
</body>
</html>`
    const text = htmlToText(html)
    expect(text).not.toContain('alert')
    expect(text).not.toContain('color: red')
    expect(text).not.toContain('注释')
    expect(text).toContain('大标题')
    expect(text).toContain('第一段　文字')
    expect(text).toContain('甲')
    expect(text).toContain('乙')
  })

  test('解码常见实体', () => {
    expect(htmlToText('<p>a &amp; b &lt; c &nbsp;d</p>')).toBe('a & b < c d')
  })
})

describe('parseHtmlNote', () => {
  const html = `<!DOCTYPE html>
<html><head><title>季度复盘</title><meta name="keywords" content="复盘, 增长"></head>
<body><h1> ignored? no, title wins </h1><p>参考 [[增长策略]] 与 [[用户洞察|洞察]]</p><p>#项目 #紧急</p></body></html>`

  test('标题优先取 <title>，其次 <h1>，最后文件名', () => {
    expect(parseHtmlNote(html, 'fallback').title).toBe('季度复盘')
    expect(parseHtmlNote('<html><body><h1>只有 H1</h1></body></html>', 'fallback').title).toBe('只有 H1')
    expect(parseHtmlNote('<html><body><p>无标题</p></body></html>', 'fallback').title).toBe('fallback')
  })

  test('提取 wikilink（含别名形式）与 meta keywords / 正文 #tag', () => {
    const note = parseHtmlNote(html, 'x')
    expect(note.links).toContain('增长策略')
    expect(note.links).toContain('用户洞察')
    expect(note.tags).toContain('复盘')
    expect(note.tags).toContain('增长')
    expect(note.tags).toContain('项目')
    expect(note.tags).toContain('紧急')
  })

  test('正文 HTML 剔除 script 与事件属性，保留结构标签', () => {
    const note = parseHtmlNote(
      `<html><head><title>t</title></head><body><p onclick="x()">hi</p><script>bad()</script></body></html>`,
      'x',
    )
    expect(note.bodyHtml).toContain('<p>hi</p>')
    expect(note.bodyHtml).not.toContain('onclick')
    expect(note.bodyHtml).not.toContain('bad()')
  })

  test('字数与文本内容可用于搜索（正文不含 head，标题单独提供）', () => {
    const note = parseHtmlNote(html, 'x')
    expect(note.title).toBe('季度复盘')
    expect(note.text).toContain('参考 [[增长策略]]')
    expect(note.wordCount).toBeGreaterThan(0)
  })
})

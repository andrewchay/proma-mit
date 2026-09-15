import { describe, expect, test } from 'bun:test'
import { generateNoteContent, parseNote } from './index'

/**
 * 笔记序列化测试。
 *
 * 核心断言是**往返等价**：generateNoteContent 的输出必须能被 parseNote
 * 解析回等价结构。否则每次「读取 → 保存」都会让文件漂移 —— 用户会发现
 * 自己没改什么，文件却一直在变。
 */

describe('生成笔记内容', () => {
  test('无 frontmatter 时只输出标题与正文', () => {
    const out = generateNoteContent({ title: '测试笔记', content: '正文内容' })
    expect(out).toBe('# 测试笔记\n\n正文内容\n')
  })

  test('空正文时不留下多余空行', () => {
    const out = generateNoteContent({ title: '空笔记', content: '' })
    expect(out).toBe('# 空笔记\n')
  })

  test('含 frontmatter 时输出 YAML 块', () => {
    const out = generateNoteContent({
      title: '带元数据',
      content: '正文',
      frontmatter: { tags: ['a', 'b'], status: 'draft' },
    })
    expect(out).toContain('---')
    expect(out).toContain('tags: [a, b]')
    expect(out).toContain('status: draft')
    expect(out).toContain('# 带元数据')
  })

  test('含特殊字符的值被引号包裹', () => {
    const out = generateNoteContent({
      title: '特殊值',
      content: '',
      frontmatter: { note: '含: 冒号' },
    })
    expect(out).toContain('note: "含: 冒号"')
  })

  test('null 与 undefined 的 frontmatter 键被跳过', () => {
    const out = generateNoteContent({
      title: 't',
      content: '',
      frontmatter: { keep: 'yes', drop: undefined, alsoDrop: null },
    })
    expect(out).toContain('keep: yes')
    expect(out).not.toContain('drop')
  })

  test('输出以单个换行结尾（避免文件末尾空行累积）', () => {
    const out = generateNoteContent({ title: 't', content: 'body' })
    expect(out.endsWith('\n')).toBe(true)
    expect(out.endsWith('\n\n')).toBe(false)
  })

  test('正文末尾多余换行被归一化', () => {
    const out = generateNoteContent({ title: 't', content: 'body\n\n\n' })
    expect(out).toBe('# t\n\nbody\n')
  })
})

describe('序列化往返等价', () => {
  test('标题往返一致', () => {
    const out = generateNoteContent({ title: '我的笔记', content: '' })
    expect(parseNote(out, 'fallback').title).toBe('我的笔记')
  })

  test('正文往返一致（content 含一级标题）', () => {
    const content = '第一段\n\n第二段'
    const out = generateNoteContent({ title: 't', content })
    // parseNote 的 content 是整个 body（含一级标题行），这是既有约定
    const parsed = parseNote(out, 't')
    expect(parsed.content).toBe(`# t\n\n${content}`)
    // 关键：正文部分（剔除标题行后）与原输入一致
    expect(parsed.content.replace(/^#\s+.+\n\n/, '')).toBe(content)
  })

  test('frontmatter 往返一致', () => {
    const out = generateNoteContent({
      title: 't',
      content: '',
      frontmatter: { tags: ['x', 'y'], author: 'me' },
    })
    const parsed = parseNote(out, 't')
    expect(parsed.frontmatter.tags).toEqual(['x', 'y'])
    expect(parsed.frontmatter.author).toBe('me')
  })

  test('二次序列化不再改变内容（幂等）', () => {
    const first = generateNoteContent({
      title: '幂等测试',
      content: '内容 with [[链接]]',
      frontmatter: { tags: ['a'] },
    })
    const parsed = parseNote(first, '幂等测试')
    const second = generateNoteContent({
      title: parsed.title,
      content: parsed.content,
      frontmatter: parsed.frontmatter,
    })
    expect(second).toBe(first)
  })

  test('wikilink 在往返后仍可被解析', () => {
    const out = generateNoteContent({ title: 't', content: '参见 [[另一篇]] 的说明' })
    expect(parseNote(out, 't').links).toContain('另一篇')
  })

  test('标签在往返后仍可被解析', () => {
    const out = generateNoteContent({ title: 't', content: '正文 #项目 #紧急' })
    const tags = parseNote(out, 't').tags
    expect(tags).toContain('项目')
    expect(tags).toContain('紧急')
  })
})

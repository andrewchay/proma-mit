import { describe, expect, test } from 'bun:test'
import { extractLiveMarkdownHeadings } from './live-markdown-navigation'

describe('LiveMarkdown 文档目录', () => {
  test('只收集代码围栏外的标题并保留可导航位置', () => {
    const markdown = '# 总览\n正文\n```md\n## 不是标题\n```\n### 结论 ###'
    expect(extractLiveMarkdownHeadings(markdown)).toEqual([
      { level: 1, text: '总览', position: 0 },
      { level: 3, text: '结论', position: 26 },
    ])
  })
})

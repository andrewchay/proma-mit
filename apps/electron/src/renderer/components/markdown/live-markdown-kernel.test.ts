import { describe, expect, test } from 'bun:test'
import {
  nextLiveMarkdownTableCell,
  parseLiveMarkdownTable,
  serializeLiveMarkdownTable,
  updateLiveMarkdownTableCell,
} from './live-markdown-table'
import {
  shouldRebuildMarkdownHeadingDecorations,
  shouldRebuildMarkdownSyntaxDecorations,
} from './live-markdown-lifecycle'

describe('LiveMarkdown 编辑内核', () => {
  test('表格支持多行内容、转义管道和键盘式单元格导航', () => {
    const parsed = parseLiveMarkdownTable('| 指标 | 结论 |\n| :--- | ---: |\n| ARR | 增长 \\| 稳定 |')
    expect(parsed).not.toBeNull()
    expect(parsed?.rows[0]?.[1]).toBe('增长 | 稳定')
    const updated = updateLiveMarkdownTableCell(parsed!, 1, 1, '第一行\n第二行')
    const serialized = serializeLiveMarkdownTable(updated)
    expect(serialized).toContain('第一行<br>第二行')
    expect(nextLiveMarkdownTableCell(updated, { row: 1, column: 1 }, false)).toEqual({ row: 0, column: 0 })
  })

  test('文档、选区、焦点或语法树变化会触发必要装饰更新', () => {
    expect(shouldRebuildMarkdownHeadingDecorations({ documentChanged: false, syntaxTreeChanged: true })).toBe(true)
    expect(shouldRebuildMarkdownSyntaxDecorations({
      documentChanged: false,
      syntaxTreeChanged: false,
      selectionChanged: true,
      focusChanged: false,
    })).toBe(true)
  })
})
